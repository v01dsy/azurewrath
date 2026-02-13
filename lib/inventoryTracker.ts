import { scanFullInventory } from './robloxApi';
import prisma from './prisma';

/**
 * Save inventory snapshot with these rules:
 * 1. ONE SNAPSHOT PER DAY - Check if today's snapshot exists
 * 2. SAME DAY = UPDATE existing snapshot (don't create new)
 * 3. NEW DAY = CREATE new snapshot
 * 4. NEW items = Fresh scannedAt timestamp
 * 5. UNCHANGED items = PRESERVE original scannedAt timestamp
 * 6. REMOVED items = KEEP in snapshot with original scannedAt (for ownership history)
 */
export async function saveInventorySnapshot(userId: string, robloxUserId: string) {
  console.log('\n========== INVENTORY SCAN ==========');
  console.log(`userId: ${userId}`);
  console.log(`robloxUserId: ${robloxUserId}`);

  // Fetch current inventory from Roblox
  const currentInventory = await scanFullInventory(robloxUserId);
  console.log(`📦 Fetched ${currentInventory.length} items from Roblox`);

  if (!Array.isArray(currentInventory)) {
    throw new Error('scanFullInventory did not return an array');
  }

  // Ensure asset IDs exist in database
  const uniqueAssetIds = [...new Set(currentInventory.map((item: any) => item.assetId.toString()))];
  const existingItems = await prisma.item.findMany({
    where: { assetId: { in: uniqueAssetIds } },
    select: { assetId: true }
  });
  
  const existingAssetIds = new Set(existingItems.map(i => i.assetId));
  const missingAssetIds = uniqueAssetIds.filter(id => !existingAssetIds.has(id));
  
  if (missingAssetIds.length > 0) {
    await prisma.item.createMany({
      data: missingAssetIds.map(assetId => ({
        assetId,
        name: `Unknown Item ${assetId}`,
      })),
      skipDuplicates: true,
    });
  }

  // Check if today's snapshot exists
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  let todaysSnapshot = await prisma.inventorySnapshot.findFirst({
    where: {
      userId,
      createdAt: {
        gte: todayStart,
        lte: todayEnd
      }
    },
    include: { items: true }
  });

  // Get the most recent snapshot (for timestamp preservation)
  const latestSnapshot = await prisma.inventorySnapshot.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { items: true }
  });

  if (!latestSnapshot) {
    // VERY FIRST SNAPSHOT EVER - Create it
    console.log('💾 Creating FIRST EVER snapshot...');
    const snapshot = await prisma.inventorySnapshot.create({
      data: {
        userId,
        items: {
          create: currentInventory.map((item: any) => ({
            assetId: item.assetId.toString(),
            userAssetId: item.userAssetId.toString(),
            serialNumber: item.serialNumber ?? null,
            scannedAt: new Date() // All items are brand new
          })),
        },
      },
      include: { items: true },
    });
    
    console.log(`✅ FIRST snapshot created (ID: ${snapshot.id}, ${snapshot.items.length} items)`);
    console.log('====================================\n');
    return snapshot;
  }

  // Build timestamp map from LATEST snapshot (to preserve old scannedAt)
  const previousTimestampMap = new Map(
    latestSnapshot.items.map(item => [item.userAssetId, item.scannedAt])
  );

  // Compare current inventory with latest snapshot
  const currentUAIDs = new Set(currentInventory.map((item: any) => item.userAssetId.toString()));
  const latestUAIDs = new Set(latestSnapshot.items.map(item => item.userAssetId));
  
  const newUAIDs = [...currentUAIDs].filter(uaid => !latestUAIDs.has(uaid));
  const removedUAIDs = [...latestUAIDs].filter(uaid => !currentUAIDs.has(uaid));
  
  console.log(`📊 Changes: ${newUAIDs.length} new, ${removedUAIDs.length} removed`);

  if (newUAIDs.length === 0 && removedUAIDs.length === 0) {
    console.log(`✅ NO CHANGES - returning existing snapshot`);
    console.log('====================================\n');
    return latestSnapshot;
  }

  // Prepare ALL items (current + removed from latest)
  const allItemsForSnapshot = [];
  
  // Add current items (new + unchanged)
  for (const item of currentInventory) {
    const userAssetId = item.userAssetId.toString();
    const isNew = newUAIDs.includes(userAssetId);
    const previousScannedAt = previousTimestampMap.get(userAssetId);
    
    allItemsForSnapshot.push({
      assetId: item.assetId.toString(),
      userAssetId: userAssetId,
      serialNumber: item.serialNumber ?? null,
      // ✅ NEW items get current time, UNCHANGED keep original
      scannedAt: isNew ? new Date() : (previousScannedAt || new Date())
    });
  }
  
  // Add REMOVED items (for ownership history)
  const removedItems = latestSnapshot.items.filter(item => 
    removedUAIDs.includes(item.userAssetId)
  );
  
  for (const item of removedItems) {
    allItemsForSnapshot.push({
      assetId: item.assetId,
      userAssetId: item.userAssetId,
      serialNumber: item.serialNumber,
      scannedAt: item.scannedAt // ✅ PRESERVE original timestamp
    });
  }

  if (todaysSnapshot) {
    // TODAY'S SNAPSHOT EXISTS - UPDATE IT
    console.log(`🔄 Updating TODAY'S snapshot (ID: ${todaysSnapshot.id})...`);
    
    // Delete old items and replace with new set
    await prisma.inventoryItem.deleteMany({
      where: { snapshotId: todaysSnapshot.id }
    });
    
    await prisma.inventoryItem.createMany({
      data: allItemsForSnapshot.map(item => ({
        ...item,
        snapshotId: todaysSnapshot.id
      }))
    });
    
    // Fetch updated snapshot
    const updatedSnapshot = await prisma.inventorySnapshot.findUnique({
      where: { id: todaysSnapshot.id },
      include: { items: true }
    });
    
    console.log(`✅ UPDATED today's snapshot (${updatedSnapshot!.items.length} items total)`);
    console.log(`   - ${newUAIDs.length} items got fresh scannedAt`);
    console.log(`   - ${currentInventory.length - newUAIDs.length} items kept original scannedAt`);
    console.log(`   - ${removedUAIDs.length} removed items tracked with original scannedAt`);
    console.log('====================================\n');
    return updatedSnapshot!;
  } else {
    // NEW DAY - CREATE NEW SNAPSHOT
    console.log(`📸 Creating NEW snapshot for new day...`);
    
    const newSnapshot = await prisma.inventorySnapshot.create({
      data: {
        userId,
        items: {
          create: allItemsForSnapshot
        },
      },
      include: { items: true },
    });
    
    console.log(`✅ NEW snapshot created (ID: ${newSnapshot.id}, ${newSnapshot.items.length} items)`);
    console.log(`   - ${newUAIDs.length} items got fresh scannedAt`);
    console.log(`   - ${currentInventory.length - newUAIDs.length} items kept original scannedAt`);
    console.log(`   - ${removedUAIDs.length} removed items tracked with original scannedAt`);
    console.log('====================================\n');
    return newSnapshot;
  }
}

export async function getLatestSnapshot(userId: string) {
  return await prisma.inventorySnapshot.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        include: {
          item: true,
        },
      },
    },
  });
}

export async function getInventoryHistory(userId: string, limit: number = 10) {
  return await prisma.inventorySnapshot.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      items: {
        include: {
          item: true,
        },
      },
    },
  });
}

export async function compareSnapshots(oldSnapshotId: string, newSnapshotId: string) {
  const [oldSnapshot, newSnapshot] = await Promise.all([
    prisma.inventorySnapshot.findUnique({
      where: { id: oldSnapshotId },
      include: { items: true },
    }),
    prisma.inventorySnapshot.findUnique({
      where: { id: newSnapshotId },
      include: { items: true },
    }),
  ]);
  
  if (!oldSnapshot || !newSnapshot) return null;
  
  const oldItems = oldSnapshot.items.reduce((map, i) => {
    map.set(i.assetId, (map.get(i.assetId) || 0) + 1);
    return map;
  }, new Map<string, number>());

  const newItems = newSnapshot.items.reduce((map, i) => {
    map.set(i.assetId, (map.get(i.assetId) || 0) + 1);
    return map;
  }, new Map<string, number>());
  
  const added: string[] = [];
  const removed: string[] = [];
  const quantityChanged: { assetId: string; from: number; to: number }[] = [];
  
  newItems.forEach((qty, assetId) => {
    const oldQty = oldItems.get(assetId) || 0;
    if (oldQty === 0) {
      added.push(assetId);
    } else if (oldQty !== qty) {
      quantityChanged.push({ assetId, from: oldQty, to: qty });
    }
  });
  
  oldItems.forEach((qty, assetId) => {
    if (!newItems.has(assetId)) {
      removed.push(assetId);
    }
  });
  
  return { added, removed, quantityChanged };
}