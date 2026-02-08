import requests
import json
import time
import os
from dotenv import load_dotenv
import logging
import psycopg2
from psycopg2 import pool
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
DATABASE_URL = os.getenv('DATABASE_URL')
WORKER_INTERVAL = int(os.getenv('WORKER_INTERVAL_SECONDS', 120))
MAX_WORKERS = int(os.getenv('MAX_WORKERS', 10))  # Adjust based on rate limits

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
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
        MAX_WORKERS + 5,  # A few extra connections
        DATABASE_URL
    )

def get_db_connection():
    """Get PostgreSQL connection from pool"""
    return connection_pool.getconn()

def return_db_connection(conn):
    """Return connection to pool"""
    connection_pool.putconn(conn)

def fetch_roblox_item_price(asset_id: str):
    """Fetch real resale data from Roblox APIs"""
    try:
        # Fetch item details
        response = requests.get(
            f'https://economy.roblox.com/v2/assets/{asset_id}/details',
            headers=HEADERS,
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            collectible_item_id = data.get('CollectibleItemId')
            if not collectible_item_id:
                return None

            resale_response = requests.get(
                f'https://apis.roblox.com/marketplace-sales/v1/item/{collectible_item_id}/resale-data',
                headers=HEADERS,
                timeout=10
            )

            if resale_response.status_code != 200:
                logger.warning(f"Resale fetch failed for {asset_id}: {resale_response.status_code}")
                return None

            resale_data = resale_response.json()
            lowest_resale = data.get('CollectiblesItemDetails', {}).get('CollectibleLowestResalePrice')
            if lowest_resale is None:
                lowest_resale = resale_data.get('lowestResalePrice')

            return {
                'price': lowest_resale,
                'rap': resale_data.get('recentAveragePrice'),
                'name': data.get('Name', ''),
            }
    except Exception as e:
        logger.error(f"Failed to fetch price for {asset_id}: {e}")
    
    return None

def process_single_item(item_tuple, previous_raps):
    """Process a single item (runs in thread)"""
    item_id, asset_id, name = item_tuple
    logger.info(f"🔄 Fetching price for {name} ({asset_id})")
    
    price_data = fetch_roblox_item_price(asset_id)
    
    # Only process if we have valid price data
    if not price_data or not (price_data.get('price') or price_data.get('rap')):
        logger.warning(f"⚠️ No price data for {name} - skipping completely")
        return None
    
    price = price_data.get('price')
    rap = price_data.get('rap')
    lowest_resale = price_data.get('price')
    previous_rap = previous_raps.get(item_id)
    
    # Only mark RAP as changed if BOTH previous and current rap exist, are not None, and differ
    rap_changed = False
    if rap is not None and previous_rap is not None:
        rap_changed = rap != previous_rap
        if rap_changed:
            logger.info(f"📈 RAP Change detected for {name}: {previous_rap} -> {rap}")
    
    logger.info(f"✅ Updated: {name} - Price: {price} | RAP: {rap} | Sale trigger: {rap_changed}")
    
    return {
        'item_id': item_id,
        'name': name,
        'price': price or rap,
        'rap': rap,
        'lowest_resale': lowest_resale,
        'rap_changed': rap_changed
    }

def save_results_to_db(results):
    """Batch save all results to database"""
    if not results:
        return
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Prepare batch data for PriceHistory
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
                logger.info(f"💸 RAP changed: {result['name']} synthetic sale at {result['rap']}")
            elif result['rap_changed']:
                logger.error(f"🔴 ERROR: RAP marked as changed but rap is None for {result['name']}")
        
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
        logger.info(f"💾 Saved {len(price_history_data)} price updates and {len(sale_data)} sales to database")
        
    except Exception as e:
        logger.error(f"Error saving to database: {e}")
        conn.rollback()
    finally:
        cursor.close()
        return_db_connection(conn)

def update_item_prices():
    """Fetch all items and update their prices in parallel"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # Get all items
        cursor.execute('SELECT id, "assetId", name FROM "Item"')
        items = cursor.fetchall()
        
        logger.info(f"📊 Updating prices for {len(items)} items using {MAX_WORKERS} workers...")
        
        # Load previous RAPs into memory
        cursor.execute('''
            SELECT DISTINCT ON ("itemId") "itemId", rap
            FROM "PriceHistory"
            ORDER BY "itemId", timestamp DESC
        ''')
        previous_raps = {row[0]: row[1] for row in cursor.fetchall()}
        
        # Return this connection early
        return_db_connection(conn)
        
        # Process items in parallel
        results = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {
                executor.submit(process_single_item, item, previous_raps): item 
                for item in items
            }
            
            for future in as_completed(futures):
                try:
                    result = future.result()
                    if result:
                        results.append(result)
                except Exception as e:
                    logger.error(f"Error processing item: {e}")
        
        # Batch save all results
        save_results_to_db(results)
        
        logger.info("✅ Price and sales update complete!")
        
    except Exception as e:
        logger.error(f"Error updating prices: {e}")
        try:
            return_db_connection(conn)
        except:
            pass

def main():
    """Main worker loop"""
    logger.info("🚀 Azurewrath Worker started!")
    logger.info(f"⏱️  Update interval: {WORKER_INTERVAL} seconds")
    logger.info(f"👷 Max workers: {MAX_WORKERS}")
    
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
            time.sleep(30)  # Wait 30s on error

if __name__ == "__main__":
    main()
