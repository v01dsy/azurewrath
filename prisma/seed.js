import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import dotenv from 'dotenv';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
dotenv.config();

const prisma = new PrismaClient();

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  ...(process.env.ROBLOX_BOUND_AUTH_TOKEN
    ? { 'x-bound-auth-token': process.env.ROBLOX_BOUND_AUTH_TOKEN }
    : {}),
  ...(process.env.ROBLOX_COOKIE
    ? { 'Cookie': `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}` }
    : {}),
};

// Rate limiting helper - 50 requests per 60 seconds = 1.2s per request
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestWithRetry(url, options, maxRetries = 5) {
  let attempt = 0;

  while (true) {
    try {
      return await axios.get(url, options);
    } catch (error) {
      const status = error.response?.status;
      if (status !== 429 || attempt >= maxRetries) {
        throw error;
      }

      const retryAfterHeader = error.response?.headers?.['retry-after'];
      const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : 5000;

      attempt += 1;
      console.warn(`Rate limited (429). Waiting ${waitMs}ms before retry ${attempt}/${maxRetries}...`);
      await delay(waitMs);
    }
  }
}

async function fetchThumbnailUrl(assetId) {
  if (!assetId) {
    return null;
  }

  try {
    const response = await axios.get(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=420x420&format=Png&isCircular=false`,
      { headers }
    );

    return response.data?.data?.[0]?.imageUrl || null;
  } catch (error) {
    console.warn(`Thumbnail fetch failed for asset ${assetId}:`, error.message);
    return null;
  }
}

async function fetchItemData(assetId) {
  try {
    console.log(`📥 Fetching data for asset ${assetId}...`);
    // Fetch item details from Roblox API
    const response = await requestWithRetry(
      `https://economy.roblox.com/v2/assets/${assetId}/details`,
      { headers }
    );

    const data = response.data;
    const collectibleProductId = data.CollectibleProductId;
    const collectibleItemId = data.CollectibleItemId;
    const resaleLookupId = collectibleItemId || collectibleProductId;

    console.log('📋 API Response:', JSON.stringify(data, null, 2));
    console.log(`🔑 CollectibleProductId: ${collectibleProductId}`);
    console.log(`🔑 CollectibleItemId: ${collectibleItemId}`);

    if (!resaleLookupId) {
      throw new Error(`No CollectibleItemId or CollectibleProductId found for asset ${assetId}`);
    }

    // Rate limit between requests
    await delay(1200);

    console.log(`\n📥 Fetching resale data for asset ${assetId}...`);
    
    const resaleResponse = await requestWithRetry(
      `https://apis.roblox.com/marketplace-sales/v1/item/${resaleLookupId}/resale-data`,
      { headers }
    );

    const resaleData = resaleResponse.data;
    console.log('📋 Resale Data:', JSON.stringify(resaleData, null, 2));

    // Calculate RAP from recentAveragePrice
    const rap = resaleData.recentAveragePrice || null;
    const resalePrice = data.CollectiblesItemDetails?.CollectibleLowestResalePrice
      ?? resaleData.lowestResalePrice
      ?? null;

    const thumbnailAssetId = data.IconImageAssetId || assetId;
    const imageUrl = await fetchThumbnailUrl(thumbnailAssetId)
      ?? `https://www.roblox.com/asset-thumbnail/image?assetId=${thumbnailAssetId}&width=420&height=420&format=png`;

    return {
      name: data.Name,
      image: imageUrl,
      rap: rap,
      price: resalePrice,
    };
  } catch (error) {
    console.error('❌ Failed to fetch item:', error.message);
    if (error.response) {
      const responseHeaders = error.response.headers || {};
      const requestUrl = error.config?.url || 'unknown-url';
      console.error('Response Status:', error.response.status);
      console.error('Response Data:', error.response.data);
      console.error('Request URL:', requestUrl);
      console.error('Response Headers:', {
        'retry-after': responseHeaders['retry-after'],
        'x-ratelimit-limit': responseHeaders['x-ratelimit-limit'],
        'x-ratelimit-remaining': responseHeaders['x-ratelimit-remaining'],
        'x-ratelimit-reset': responseHeaders['x-ratelimit-reset'],
        'x-roblox-edge': responseHeaders['x-roblox-edge'],
        'x-ingress-proxy': responseHeaders['x-ingress-proxy'],
        'x-terms-message': responseHeaders['x-terms-message'],
      });
    }
    throw error;
  }
}

async function loadAssetIds() {
  const filePath = path.join(process.cwd(), 'asset-ids.json');
  const raw = await readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  const ids = Array.isArray(data) ? data : data.assetIds;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('asset-ids.json must contain a non-empty array of asset IDs');
  }

  const sortedIds = ids
    .map(String)
    .map(id => id.trim())
    .filter(Boolean)
    .sort((a, b) => {
      try {
        return (BigInt(a) > BigInt(b)) ? 1 : (BigInt(a) < BigInt(b)) ? -1 : 0;
      } catch {
        return a.localeCompare(b);
      }
    });

  await writeFile(filePath, JSON.stringify(sortedIds, null, 2) + '\n', 'utf8');

  return sortedIds;
}

async function main() {
  const assetIds = await loadAssetIds();
  
  try {
    for (const assetId of assetIds) {
      const existingItem = await prisma.item.findUnique({
        where: { assetId },
        select: { id: true },
      });

      if (existingItem) {
        console.log(`\nSkipping ${assetId} (already in database).`);
        continue;
      }

      const itemData = await fetchItemData(assetId);
      
      console.log(`\nSeeding ${itemData.name}...\n`);
      
      console.log('Item Data Retrieved:');
      console.log('  Name:', itemData.name);
      console.log('  Image:', itemData.image);
      console.log('  RAP:', itemData.rap);

      // Save to database
      const item = await prisma.item.upsert({
        where: { assetId },
        update: {
          name: itemData.name,
          imageUrl: itemData.image,
          description: `${itemData.name} - Asset ID: ${assetId}`,
        },
        create: {
          assetId,
          name: itemData.name,
          imageUrl: itemData.image,
          description: `${itemData.name} - Asset ID: ${assetId}`,
        },
      });

      console.log('\nItem saved to database:', item.id);

      // Save price history
      if (itemData.price !== null || itemData.rap !== null) {
        const priceHistory = await prisma.priceHistory.create({
          data: {
            itemId: item.id,
            price: itemData.price ?? itemData.rap,
            rap: itemData.rap,
            lowestResale: itemData.price ?? null,
          },
        });

        console.log('Price history saved:', priceHistory.id);
      }

      console.log('\nSeed completed successfully!');

      // Slow down between items to reduce throttling
      await delay(2000);
    }
  } catch (error) {
    console.error('\nSeed failed:', error.message);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
