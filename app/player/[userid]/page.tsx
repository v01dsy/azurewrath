import { PrismaClient } from '@prisma/client';
import { fetchRobloxUserInfo, fetchRobloxHeadshotUrl, scanFullInventory } from '@/lib/robloxApi';
import { saveInventorySnapshot } from '@/lib/inventoryTracker';
import ClientInventoryGrid from '@/app/player/[userid]/ClientInventoryGrid';

const prisma = new PrismaClient();

// Helper function for "time ago"
function timeAgo(date: Date): string {
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  const intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60,
  };
  
  for (const [unit, secondsInUnit] of Object.entries(intervals)) {
    const interval = Math.floor(seconds / secondsInUnit);
    if (interval >= 1) {
      return `${interval} ${unit}${interval === 1 ? '' : 's'} ago`;
    }
  }
  
  return 'just now';
}

export default async function PlayerPage({ params }: { params: Promise<{ userid: string }> }) {
  const { userid } = await params;
  
  let user = null;
  if (userid) {
    user = await prisma.user.findUnique({ where: { robloxUserId: userid } });
    if (!user) {
      user = await prisma.user.findUnique({ where: { id: userid } });
    }
  }

  // If user not found, create profile from Roblox info
  if (!user && userid) {
    try {
      const robloxInfo = await fetchRobloxUserInfo(userid);
      const avatarUrl = await fetchRobloxHeadshotUrl(robloxInfo.id.toString());
      
      user = await prisma.user.create({
        data: {
          robloxUserId: robloxInfo.id.toString(),
          username: robloxInfo.name,
          displayName: robloxInfo.displayName,
          avatarUrl: avatarUrl || '',
          description: robloxInfo.description,
        },
      });
    } catch (e) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-900">
          <div className="text-white text-2xl">User not found and could not be created.</div>
        </div>
      );
    }
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="text-white text-2xl">User not found.</div>
      </div>
    );
  }

  // Fetch inventory from Roblox
  const inventory = await scanFullInventory(user.robloxUserId);
  
  if (inventory.length === 0) {
    return (
      <div className="min-h-screen bg-slate-900 p-4">
        <div className="max-w-6xl mx-auto">
          <div className="bg-slate-800 rounded-2xl border border-purple-500/20 p-8 text-center">
            <p className="text-white text-xl mb-2">Unable to load inventory</p>
            <p className="text-slate-400">Roblox API timed out. Please try again in a moment.</p>
          </div>
        </div>
      </div>
    );
  }
  
  // Save snapshot if we don't have one from today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todaySnapshot = await prisma.inventorySnapshot.findFirst({
    where: {
      userId: user.id,
      createdAt: { gte: today },
    },
  });
  
  if (!todaySnapshot) {
    await saveInventorySnapshot(user.id, user.robloxUserId);
  }

  // Fetch latest snapshot for timestamp
  const latestSnapshot = await prisma.inventorySnapshot.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  
  // Get unique assetIds
  const assetIds = [...new Set(inventory.map((item: any) => item.assetId.toString()))];
  
  // Fetch item data from database
  const dbItems = await prisma.item.findMany({
    where: {
      assetId: {
        in: assetIds
      }
    },
    include: {
      priceHistory: {
        orderBy: {
          timestamp: 'desc'
        },
        take: 1
      }
    }
  });
  
  // Create a map for quick lookup
  const itemMap = new Map(dbItems.map(item => [item.assetId, item]));
  
  // Group items by assetId and count, enriching with database data
  const itemCounts = inventory.reduce((acc: any, item: any) => {
    const id = item.assetId.toString();
    if (!acc[id]) {
      const dbItem = itemMap.get(id);
      const latestPrice = dbItem?.priceHistory[0];
      acc[id] = {
        assetId: id,
        name: dbItem?.name || item.name || 'Unknown Item',
        imageUrl: dbItem?.imageUrl || `https://www.roblox.com/asset-thumbnail/image?assetId=${id}&width=150&height=150&format=png`,
        rap: latestPrice?.rap || item.recentAveragePrice || 0,
        count: 0,
        userAssetIds: []
      };
    }
    acc[id].count++;
    acc[id].userAssetIds.push(item.userAssetId);
    return acc;
  }, {});

  const uniqueItems = Object.values(itemCounts);
  
  // Calculate total RAP
  const totalRAP = uniqueItems.reduce((sum: number, item: any) => {
    return sum + (item.rap * item.count);
  }, 0);

  const scannedTime = latestSnapshot ? timeAgo(latestSnapshot.createdAt) : null;

  return (
    <div className="min-h-screen bg-slate-900 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Profile Card */}
        <div className="bg-slate-800 rounded-2xl border border-purple-500/20 p-8 mb-8 shadow-lg flex flex-col items-center">
          {user.avatarUrl && (
            <img 
              src={user.avatarUrl} 
              alt={user.username} 
              width={150} 
              height={150} 
              className="rounded-full mb-4"
            />
          )}
          <h1 className="text-3xl font-bold text-white mb-2">{user.displayName || user.username}</h1>
          <p className="text-purple-300 mb-2">@{user.username}</p>
          {user.description && <p className="text-slate-300 mb-4 text-center">{user.description}</p>}
          <div className="text-slate-400 text-sm">Roblox User ID: {user.robloxUserId}</div>
          
          {/* Stats Grid */}
          <div className="grid grid-cols-3 gap-4 mt-6 w-full max-w-md">
            <div className="bg-slate-700/50 rounded-lg p-4 text-center">
              <p className="text-slate-400 text-xs mb-1">Total Items</p>
              <p className="text-white text-2xl font-bold">{inventory.length}</p>
            </div>
            <div className="bg-slate-700/50 rounded-lg p-4 text-center">
              <p className="text-slate-400 text-xs mb-1">Unique Items</p>
              <p className="text-white text-2xl font-bold">{uniqueItems.length}</p>
            </div>
            <div className="bg-purple-900/30 rounded-lg p-4 text-center border border-purple-500/30">
              <p className="text-purple-300 text-xs mb-1">Total RAP</p>
              <p className="text-purple-400 text-2xl font-bold">{totalRAP.toLocaleString()}</p>
              <p className="text-purple-300 text-xs">R$</p>
            </div>
          </div>
        </div>

        {/* Inventory Grid with Sorting */}
        <ClientInventoryGrid items={uniqueItems} scannedTime={scannedTime} />
      </div>
    </div>
  );
}