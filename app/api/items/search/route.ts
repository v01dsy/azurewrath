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


    let items;
    if (query.length < 1) {
      // No query: return all items (up to 2500)
      items = await prisma.item.findMany({
        include: {
          priceHistory: {
            orderBy: { timestamp: 'desc' },
            take: 1,
          },
          marketTrends: true,
        },
        take: 2500,
      });
    } else {
      // Query: search as before
      items = await prisma.item.findMany({
        where: {
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
        },
        include: {
          priceHistory: {
            orderBy: { timestamp: 'desc' },
            take: 1,
          },
          marketTrends: true,
        },
        take: 20,
      });
    }

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
