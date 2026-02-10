import { PrismaClient } from '@prisma/client';
import { scanFullInventory } from './robloxApi';

const prisma = new PrismaClient();

export async function saveInventorySnapshot(userId: string, robloxUserId: string) {
  // Fetch current inventory from Roblox
  const inventory = await scanFullInventory(robloxUserId);
  
  // Deduplicate by userAssetId (in case API returns duplicates)
  const uniqueItems = Array.from(
    new Map(inventory.map(item => [item.userAssetId, item])).values()
  );
  
  // Create snapshot with individual userAssetId tracking
  const snapshot = await prisma.inventorySnapshot.create({
    data: {
      userId,
      items: {
        create: uniqueItems.map((item: any) => ({
          assetId: item.assetId.toString(),
          userAssetId: item.userAssetId.toString(),
        })),
      },
    },
    include: {
      items: true,
    },
  });
  
  return snapshot;
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
  
  // Check for new/changed items
  newItems.forEach((qty, assetId) => {
    const oldQty = oldItems.get(assetId) || 0;
    if (oldQty === 0) {
      added.push(assetId);
    } else if (oldQty !== qty) {
      quantityChanged.push({ assetId, from: oldQty, to: qty });
    }
  });
  
  // Check for removed items
  oldItems.forEach((qty, assetId) => {
    if (!newItems.has(assetId)) {
      removed.push(assetId);
    }
  });
  
  return { added, removed, quantityChanged };
}