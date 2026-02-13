import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { saveInventorySnapshot } from '@/lib/inventoryTracker';

export const revalidate = 300; // Cache for 5 minutes

// ✅ Helper function to check if inventory is viewable
async function canViewInventory(robloxUserId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://inventory.roblox.com/v1/users/${robloxUserId}/can-view-inventory`
    );
    
    if (!response.ok) {
      return false;
    }
    
    const data = await response.json();
    return data.canView === true;
  } catch (error) {
    console.error('Error checking inventory visibility:', error);
    return false;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userid: string }> }
) {
  try {
    const { userid } = await params;

    // Find user (try robloxUserId first, then id)
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { robloxUserId: userid },
          { id: userid }
        ]
      }
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Fetch avatar from Roblox API (server-side)
    let avatarUrl: string | null = null;
    try {
      const avatarResponse = await fetch(
        `https://thumbnails.roblox.com/v1/users/avatar?userIds=${user.robloxUserId}&size=420x420&format=Png&isCircular=false`
      );
      if (avatarResponse.ok) {
        const avatarData = await avatarResponse.json();
        avatarUrl = avatarData.data?.[0]?.imageUrl || null;
      }
    } catch (error) {
      console.warn('Failed to fetch avatar:', error);
    }

    // Check if snapshot exists
    const latestSnapshotCheck = await prisma.inventorySnapshot.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true }
    });

    if (!latestSnapshotCheck) {
      // ✅ CHECK if inventory is private BEFORE trying to create snapshot
      const canView = await canViewInventory(user.robloxUserId);
      
      if (!canView) {
        return NextResponse.json({
          user: {
            id: user.id,
            robloxUserId: user.robloxUserId,
            username: user.username,
            displayName: user.displayName,
            avatarUrl: avatarUrl || user.avatarUrl,
            description: user.description
          },
          inventory: [],
          stats: {
            totalRAP: 0,
            totalItems: 0,
            uniqueItems: 0,
            lastScanned: null
          },
          graphData: [],
          isPrivate: true
        });
      }

      // NO SNAPSHOT - Must scan NOW and WAIT for it (blocking)
      console.log(`📸 No snapshot exists for user ${user.username} - creating initial scan (BLOCKING)`);
      try {
        await saveInventorySnapshot(user.id, user.robloxUserId);
        console.log(`✅ Initial snapshot created successfully`);
      } catch (err) {
        console.error('❌ Initial scan failed:', err);
        return NextResponse.json({ 
          error: 'Failed to create initial inventory snapshot',
          details: String(err)
        }, { status: 500 });
      }
    } else {
      // SNAPSHOT EXISTS - Scan in background (non-blocking)
      console.log(`🔄 Triggering background rescan for ${user.username}...`);
      saveInventorySnapshot(user.id, user.robloxUserId)
        .then(snapshot => {
          console.log(`✅ Background scan completed - Snapshot ID: ${snapshot.id}`);
        })
        .catch(err => {
          console.error('❌ Background scan failed:', err);
        });
    }

    // Get latest snapshot with OPTIMIZED RAW SQL
    const inventoryData = await prisma.$queryRaw<Array<{
      assetId: string;
      userAssetId: string;
      name: string;
      imageUrl: string | null;
      rap: number | null;
      itemCount: number;
      serialNumbers: (number | null)[];
      userAssetIds: string[];
    }>>`
      WITH LatestSnapshot AS (
        SELECT id, "createdAt"
        FROM "InventorySnapshot"
        WHERE "userId" = ${user.id}
        ORDER BY "createdAt" DESC
        LIMIT 1
      ),
      InventoryWithPrices AS (
        SELECT 
          ii."assetId",
          ii."userAssetId",
          i.name,
          i."imageUrl",
          ph.rap,
          ARRAY_AGG(ii."userAssetId") OVER (PARTITION BY ii."assetId") as user_asset_ids,
          COUNT(*) OVER (PARTITION BY ii."assetId") as item_count
        FROM "InventoryItem" ii
        INNER JOIN LatestSnapshot ls ON ii."snapshotId" = ls.id
        LEFT JOIN "Item" i ON ii."assetId" = i."assetId"
        LEFT JOIN LATERAL (
          SELECT rap
          FROM "PriceHistory"
          WHERE "itemId" = i.id
          ORDER BY timestamp DESC
          LIMIT 1
        ) ph ON true
      )
      SELECT DISTINCT ON ("assetId")
        "assetId",
        "userAssetId",
        COALESCE(name, 'Unknown Item') as name,
        "imageUrl",
        COALESCE(rap, 0) as rap,
        item_count::int as "itemCount",
        ARRAY[]::int[] as "serialNumbers",
        user_asset_ids as "userAssetIds"
      FROM InventoryWithPrices
      ORDER BY "assetId", rap DESC NULLS LAST
    `;

    // Get graph data
    const graphData = await prisma.$queryRaw<Array<{
      snapshotId: string;
      createdAt: Date;
      totalRap: number;
      itemCount: number;
      uniqueCount: number;
    }>>`
      WITH RecentSnapshots AS (
        SELECT id, "createdAt"
        FROM "InventorySnapshot"
        WHERE "userId" = ${user.id}
        ORDER BY "createdAt" DESC
        LIMIT 30
      )
      SELECT 
        rs.id as "snapshotId",
        rs."createdAt",
        COALESCE(SUM(ph.rap), 0) as "totalRap",
        COUNT(ii.id)::int as "itemCount",
        COUNT(DISTINCT ii."assetId")::int as "uniqueCount"
      FROM RecentSnapshots rs
      LEFT JOIN "InventoryItem" ii ON ii."snapshotId" = rs.id
      LEFT JOIN "Item" i ON ii."assetId" = i."assetId"
      LEFT JOIN LATERAL (
        SELECT rap
        FROM "PriceHistory"
        WHERE "itemId" = i.id
        ORDER BY timestamp DESC
        LIMIT 1
      ) ph ON true
      GROUP BY rs.id, rs."createdAt"
      ORDER BY rs."createdAt" ASC
    `;

    // Calculate totals
    const totalRAP = inventoryData.reduce((sum, item) => sum + ((item.rap || 0) * item.itemCount), 0);
    const totalItems = inventoryData.reduce((sum, item) => sum + item.itemCount, 0);

    const latestSnapshot = graphData.length > 0 
      ? graphData[graphData.length - 1] 
      : null;

    return NextResponse.json({
      user: {
        id: user.id,
        robloxUserId: user.robloxUserId,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: avatarUrl || user.avatarUrl,
        description: user.description
      },
      inventory: inventoryData.map(item => ({
        assetId: item.assetId,
        name: item.name,
        imageUrl: item.imageUrl,
        rap: item.rap || 0,
        count: item.itemCount,
        userAssetIds: item.userAssetIds,
        serialNumbers: item.serialNumbers
      })),
      stats: {
        totalRAP,
        totalItems,
        uniqueItems: inventoryData.length,
        lastScanned: latestSnapshot?.createdAt
      },
      graphData: graphData.map(snap => ({
        snapshotId: snap.snapshotId,
        date: new Date(snap.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        rap: snap.totalRap,
        itemCount: snap.itemCount,
        uniqueCount: snap.uniqueCount
      })),
      isPrivate: false // ✅ Not private if we got here
    });

  } catch (error) {
    console.error('Player inventory error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inventory', details: String(error) },
      { status: 500 }
    );
  }
}