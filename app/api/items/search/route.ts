import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';

    let where = undefined;
    if (query.length > 0) {
      where = {
        OR: [
          {
            name: {
              contains: query,
              mode: 'insensitive',
            },
          },
          {
            assetId: {
              contains: query,
              mode: 'insensitive',
            },
          },
        ],
      };
    }

    const items = await prisma.item.findMany({
      ...(where ? { where } : {}),
      include: {
        priceHistory: {
          orderBy: {
            timestamp: 'desc',
          },
          take: 1,
        },
        marketTrends: true,
      },
      take: 2500,
    });

    console.log(`Search query: "${query}", found: ${items.length} items`);
    return NextResponse.json(items);
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: 'Search failed', details: String(error) },
      { status: 500 }
    );
  }
}
