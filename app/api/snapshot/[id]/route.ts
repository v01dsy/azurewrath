import { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';

const prisma = new PrismaClient();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // Fetch the snapshot with its items
    const snapshot = await prisma.inventorySnapshot.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            item: {
              include: {
                priceHistory: {
                  orderBy: { timestamp: 'desc' },
                  take: 1
                }
              }
            }
          }
        }
      }
    });

    if (!snapshot) {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }

    // Get unique assetIds to fetch current prices
    const assetIds = [...new Set(snapshot.items.map(item => item.assetId))];
    
    const currentItems = await prisma.item.findMany({
      where: {
        assetId: {
          in: assetIds
        }
      },
      include: {
        priceHistory: {
          orderBy: { timestamp: 'desc' },
          take: 1
        }
      }
    });

    const currentPriceMap = new Map(
      currentItems.map(item => [
        item.assetId,
        item.priceHistory[0]?.rap || 0
      ])
    );

    // Group items by assetId
    const itemCounts: Record<string, any> = {};
    
    snapshot.items.forEach(snapshotItem => {
      const assetId = snapshotItem.assetId;
      if (!itemCounts[assetId]) {
        itemCounts[assetId] = {
          assetId,
          name: snapshotItem.item?.name || 'Unknown Item',
          imageUrl: snapshotItem.item?.imageUrl || `https://www.roblox.com/asset-thumbnail/image?assetId=${assetId}&width=150&height=150&format=png`,
          rapThen: snapshotItem.item?.priceHistory[0]?.rap || 0,
          rapNow: currentPriceMap.get(assetId) || 0,
          count: 0
        };
      }
      itemCounts[assetId].count++;
    });

    const items = Object.values(itemCounts);

    // Calculate totals
    const totalRapThen = items.reduce((sum, item) => sum + (item.rapThen * item.count), 0);
    const totalRapNow = items.reduce((sum, item) => sum + (item.rapNow * item.count), 0);

    return NextResponse.json({
      items,
      totalRapThen,
      totalRapNow
    });
  } catch (error) {
    console.error('Error fetching snapshot:', error);
    return NextResponse.json({ error: 'Failed to fetch snapshot' }, { status: 500 });
  }
}