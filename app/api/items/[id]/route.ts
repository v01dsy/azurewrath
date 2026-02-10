import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: itemId } = await params;

    const item = await prisma.item.findFirst({
      where: {
        OR: [{ id: itemId }, { assetId: itemId }],
      },
      include: {
        priceHistory: {
          orderBy: {
            timestamp: 'desc',
          },
          take: 1, // Only get the most recent price history
        },
        marketTrends: true,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: 'Item not found' },
        { status: 404 }
      );
    }

    // Add latest price data to the top level for easier access
    const latestPrice = item.priceHistory[0];
    const response = {
      ...item,
      currentPrice: latestPrice?.price || null,
      currentRap: latestPrice?.rap || null,
      lowestResale: latestPrice?.lowestResale || null,
      lastUpdated: latestPrice?.timestamp || null,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Fetch item error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch item', details: String(error) },
      { status: 500 }
    );
  }
}