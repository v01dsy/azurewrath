import requests
import json
import time
import os
from dotenv import load_dotenv
import logging
import psycopg2
from psycopg2 import pool
from datetime import datetime

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
DATABASE_URL = os.getenv('DATABASE_URL')
WORKER_INTERVAL = int(os.getenv('WORKER_INTERVAL_SECONDS', 120))
BATCH_SIZE = 120  # Roblox catalog API supports up to 120 items per batch

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
}

if os.getenv('ROBLOX_BOUND_AUTH_TOKEN'):
    HEADERS['x-bound-auth-token'] = os.getenv('ROBLOX_BOUND_AUTH_TOKEN')

if os.getenv('ROBLOX_COOKIE'):
    HEADERS['Cookie'] = f".ROBLOSECURITY={os.getenv('ROBLOX_COOKIE')}"

# Connection pool
connection_pool = None

def init_connection_pool():
    """Initialize the connection pool"""
    global connection_pool
    connection_pool = psycopg2.pool.SimpleConnectionPool(
        1, 
        10,
        DATABASE_URL
    )

def get_db_connection():
    """Get PostgreSQL connection from pool"""
    return connection_pool.getconn()

def return_db_connection(conn):
    """Return connection to pool"""
    connection_pool.putconn(conn)

def fetch_batch_item_details(asset_ids):
    """Fetch item details in batches of 120 using Roblox catalog API"""
    all_details = {}
    total_batches = (len(asset_ids) + BATCH_SIZE - 1) // BATCH_SIZE
    
    logger.info(f"📦 Fetching {len(asset_ids)} items in {total_batches} batches of {BATCH_SIZE}")
    
    for i in range(0, len(asset_ids), BATCH_SIZE):
        batch = asset_ids[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        
        try:
            payload = {
                "items": [{"itemType": "Asset", "id": int(aid)} for aid in batch]
            }
            
            response = requests.post(
                'https://catalog.roblox.com/v1/catalog/items/details',
                headers=HEADERS,
                json=payload,
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                items_data = data.get('data', [])
                
                for item in items_data:
                    asset_id = str(item.get('id'))
                    all_details[asset_id] = item
                
                logger.info(f"✅ Batch {batch_num}/{total_batches}: Fetched {len(items_data)} items")
                
            elif response.status_code == 429:
                logger.error(f"🚫 RATE LIMITED on batch {batch_num}! Waiting 60s...")
                time.sleep(60)
                continue
            else:
                logger.error(f"❌ Batch {batch_num} failed: {response.status_code} - {response.text[:200]}")
            
            # Rate limit between batches (be nice to Roblox APIs)
            time.sleep(0.5)
            
        except Exception as e:
            logger.error(f"Error fetching batch {batch_num}: {e}")
    
    logger.info(f"📊 Successfully fetched details for {len(all_details)}/{len(asset_ids)} items")
    return all_details

def fetch_resale_data_for_collectibles(collectible_items):
    """Fetch resale data for collectible items (still individual calls, but only for collectibles)"""
    resale_data = {}
    total = len(collectible_items)
    
    if total == 0:
        return resale_data
    
    logger.info(f"💎 Fetching resale data for {total} collectible items...")
    
    for idx, (asset_id, collectible_id) in enumerate(collectible_items.items(), 1):
        try:
            response = requests.get(
                f'https://apis.roblox.com/marketplace-sales/v1/item/{collectible_id}/resale-data',
                headers=HEADERS,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                resale_data[asset_id] = data
                
                if idx % 50 == 0:
                    logger.info(f"  Progress: {idx}/{total} resale records fetched")
                    
            elif response.status_code == 429:
                logger.error(f"🚫 RATE LIMITED on resale data! Waiting 60s...")
                time.sleep(60)
                continue
            else:
                logger.warning(f"Resale fetch failed for {collectible_id}: {response.status_code}")
            
            # Rate limit between calls (10 per second = 0.1s delay)
            time.sleep(0.1)
            
        except Exception as e:
            logger.error(f"Failed to fetch resale for {collectible_id}: {e}")
    
    logger.info(f"✅ Fetched resale data for {len(resale_data)}/{total} collectibles")
    return resale_data

def process_items_data(items_from_db, catalog_details, resale_data, previous_raps):
    """Process all fetched data and prepare for database insertion"""
    results = []
    
    for item_id, asset_id, name in items_from_db:
        # Get catalog details
        item_details = catalog_details.get(str(asset_id))
        if not item_details:
            logger.warning(f"⚠️ No catalog data for {name} ({asset_id})")
            continue
        
        # Check if it's a collectible
        collectible_item_id = item_details.get('collectibleItemId')
        
        # Get price data
        price = None
        rap = None
        lowest_resale = None
        
        if collectible_item_id and str(asset_id) in resale_data:
            # Use resale data for collectibles
            resale_info = resale_data[str(asset_id)]
            rap = resale_info.get('recentAveragePrice')
            lowest_resale = resale_info.get('lowestResalePrice')
            price = lowest_resale or rap
        else:
            # For non-collectibles, try to get price from catalog
            price = item_details.get('price')
            rap = price  # Use price as RAP for non-collectibles
        
        # Skip if no price data at all
        if not price and not rap:
            continue
        
        # Check if RAP changed
        previous_rap = previous_raps.get(item_id)
        rap_changed = False
        
        if rap is not None and previous_rap is not None:
            rap_changed = rap != previous_rap
            if rap_changed:
                logger.info(f"📈 RAP Change: {name} - {previous_rap} → {rap}")
        
        results.append({
            'item_id': item_id,
            'name': name,
            'price': price or rap,
            'rap': rap,
            'lowest_resale': lowest_resale,
            'rap_changed': rap_changed
        })
    
    logger.info(f"✅ Processed {len(results)} items with valid price data")
    return results

def save_results_to_db(results):
    """Batch save all results to database"""
    if not results:
        logger.warning("⚠️ No results to save")
        return
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        price_history_data = []
        sale_data = []
        
        for result in results:
            # PriceHistory insert - only if we have valid rap
            if result['rap'] is not None:
                price_history_data.append((
                    result['item_id'],
                    result['price'],
                    result['rap'],
                    result['lowest_resale'],
                    None,  # salesVolume
                    datetime.now()
                ))
            
            # Sale insert only if RAP changed AND rap is valid
            if result['rap_changed'] and result['rap'] is not None:
                sale_data.append((
                    result['item_id'],
                    result['rap'],
                    None,  # sellerUsername
                    None,  # buyerUsername
                    None,  # serialNumber
                    datetime.now()
                ))
        
        # Batch insert PriceHistory
        if price_history_data:
            cursor.executemany('''
                INSERT INTO "PriceHistory" 
                (id, "itemId", price, rap, "lowestResale", "salesVolume", timestamp)
                VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s)
            ''', price_history_data)
        
        # Batch insert Sales
        if sale_data:
            cursor.executemany('''
                INSERT INTO "Sale" 
                (id, "itemId", "salePrice", "sellerUsername", "buyerUsername", "serialNumber", "saleDate")
                VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s)
            ''', sale_data)
        
        conn.commit()
        logger.info(f"💾 Saved {len(price_history_data)} price updates and {len(sale_data)} sales")
        
    except Exception as e:
        logger.error(f"❌ Database error: {e}")
        conn.rollback()
    finally:
        cursor.close()
        return_db_connection(conn)

def update_item_prices():
    """Main update logic using batch APIs"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Get all items from database
        cursor.execute('SELECT id, "assetId", name FROM "Item"')
        items = cursor.fetchall()
        
        if not items:
            logger.warning("⚠️ No items found in database!")
            return_db_connection(conn)
            return
        
        logger.info(f"📊 Updating prices for {len(items)} items...")
        
        # Load previous RAPs
        cursor.execute('''
            SELECT DISTINCT ON ("itemId") "itemId", rap
            FROM "PriceHistory"
            ORDER BY "itemId", timestamp DESC
        ''')
        previous_raps = {row[0]: row[1] for row in cursor.fetchall()}
        
        return_db_connection(conn)
        
        # Extract asset IDs
        asset_ids = [str(item[1]) for item in items]
        
        # Step 1: Fetch all item details in batches
        catalog_details = fetch_batch_item_details(asset_ids)
        
        # Step 2: Identify collectibles and fetch their resale data
        collectible_items = {}
        for asset_id, details in catalog_details.items():
            collectible_id = details.get('collectibleItemId')
            if collectible_id:
                collectible_items[asset_id] = collectible_id
        
        logger.info(f"💎 Found {len(collectible_items)} collectible items out of {len(catalog_details)}")
        
        resale_data = fetch_resale_data_for_collectibles(collectible_items)
        
        # Step 3: Process all data
        results = process_items_data(items, catalog_details, resale_data, previous_raps)
        
        # Step 4: Save to database
        save_results_to_db(results)
        
        logger.info("✅ Price update cycle complete!")
        
    except Exception as e:
        logger.error(f"❌ Error in update_item_prices: {e}")
        try:
            return_db_connection(conn)
        except:
            pass

def main():
    """Main worker loop"""
    logger.info("🚀 Azurewrath Worker started (Batch Mode)!")
    logger.info(f"⏱️  Update interval: {WORKER_INTERVAL} seconds")
    logger.info(f"📦 Batch size: {BATCH_SIZE} items per request")
    
    # Initialize connection pool
    init_connection_pool()
    
    while True:
        try:
            start_time = time.time()
            update_item_prices()
            elapsed = time.time() - start_time
            logger.info(f"⏱️  Update took {elapsed:.2f} seconds")
            logger.info(f"😴 Sleeping for {WORKER_INTERVAL} seconds...")
            time.sleep(WORKER_INTERVAL)
        except KeyboardInterrupt:
            logger.info("👋 Worker stopped by user")
            break
        except Exception as e:
            logger.error(f"Worker error: {e}")
            time.sleep(30)

if __name__ == "__main__":
    main()