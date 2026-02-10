import requests
import json
import time
import os
from dotenv import load_dotenv
import logging
import psycopg2
from psycopg2 import pool
from datetime import datetime
import traceback
import re

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuration
DATABASE_URL = os.getenv('DATABASE_URL')
WORKER_INTERVAL = int(os.getenv('WORKER_INTERVAL_SECONDS', 120))

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
}

# Connection pool
connection_pool = None

def init_connection_pool():
    """Initialize the connection pool"""
    global connection_pool
    try:
        connection_pool = psycopg2.pool.SimpleConnectionPool(
            1, 
            10,
            DATABASE_URL
        )
        logger.info("✅ Database connection pool initialized successfully")
    except Exception as e:
        logger.error(f"❌ Failed to initialize connection pool: {e}")
        raise

def get_db_connection():
    """Get PostgreSQL connection from pool"""
    try:
        conn = connection_pool.getconn()
        logger.debug("Got connection from pool")
        return conn
    except Exception as e:
        logger.error(f"❌ Failed to get connection from pool: {e}")
        raise

def return_db_connection(conn):
    """Return connection to pool"""
    try:
        connection_pool.putconn(conn)
        logger.debug("Returned connection to pool")
    except Exception as e:
        logger.error(f"❌ Failed to return connection to pool: {e}")

def fetch_rolimons_data():
    """Fetch all item data from Rolimons deals page (includes best price)"""
    try:
        logger.info("📡 Fetching item data from Rolimons deals page...")
        response = requests.get(
            'https://www.rolimons.com/deals',
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'},
            timeout=30
        )
        
        logger.info(f"Response status code: {response.status_code}")
        
        if response.status_code == 200:
            html = response.text
            logger.debug(f"Received HTML response ({len(html)} characters)")
            
            # Extract the item_details variable
            pattern = r'var item_details = ({.+?});'
            match = re.search(pattern, html, re.DOTALL)
            
            if match:
                item_details_str = match.group(1)
                logger.debug(f"Found item_details JSON ({len(item_details_str)} characters)")
                
                items_data = json.loads(item_details_str)
                logger.info(f"✅ Successfully parsed {len(items_data)} items from Rolimons")
                
                # Debug: Show first item
                if items_data:
                    first_key = list(items_data.keys())[0]
                    logger.debug(f"Sample item {first_key}: {items_data[first_key]}")
                
                return items_data
            else:
                logger.error("❌ Could not find item_details variable in page source")
                logger.debug(f"First 1000 chars of HTML: {html[:1000]}")
                return {}
        else:
            logger.error(f"❌ Rolimons page returned status {response.status_code}")
            return {}
            
    except requests.exceptions.Timeout:
        logger.error("❌ Request to Rolimons timed out after 30 seconds")
        return {}
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ Request error: {e}")
        return {}
    except json.JSONDecodeError as e:
        logger.error(f"❌ Failed to parse JSON: {e}")
        return {}
    except Exception as e:
        logger.error(f"❌ Unexpected error fetching from Rolimons: {e}")
        logger.error(traceback.format_exc())
        return {}

def process_items_data(items_from_db, rolimons_data, previous_raps):
    """Process all fetched data and prepare for database insertion"""
    results = []
    items_processed = 0
    items_skipped_no_data = 0
    items_skipped_no_rap = 0
    items_with_price = 0
    
    logger.info(f"Processing {len(items_from_db)} items from database...")
    
    for item_id, asset_id, name in items_from_db:
        items_processed += 1
        
        # Get data from Rolimons (key is asset_id as string)
        item_data = rolimons_data.get(str(asset_id))
        
        if not item_data or not isinstance(item_data, list):
            items_skipped_no_data += 1
            logger.debug(f"No Rolimons data for {name} (asset_id: {asset_id})")
            continue
        
        # Rolimons deals page data structure:
        # [0] = name, [1] = best price, [2] = RAP, [3-8] = other data, [9] = thumbnail
        
        best_price = item_data[1] if len(item_data) > 1 and item_data[1] else None
        rap = item_data[2] if len(item_data) > 2 and item_data[2] else None
        
        # Skip if no RAP data
        if rap is None:
            items_skipped_no_rap += 1
            logger.debug(f"No RAP for {name}")
            continue
        
        if best_price:
            items_with_price += 1
        
        # Use best_price as the price field
        price = best_price
        lowest_resale = None
        
        # Check if RAP changed
        previous_rap = previous_raps.get(item_id)
        rap_changed = False
        
        if previous_rap is not None:
            rap_changed = rap != previous_rap
            if rap_changed:
                logger.info(f"📈 RAP Change: {name} - {previous_rap} → {rap}")
        
        # Log good deals (best price < RAP)
        if best_price and rap and best_price < rap:
            discount = ((rap - best_price) / rap) * 100
            if discount > 5:  # Only log deals > 5% off
                logger.info(f"💰 Deal Found: {name} - {best_price} Robux (RAP: {rap}) - {discount:.1f}% off")
        
        results.append({
            'item_id': item_id,
            'name': name,
            'price': price,
            'rap': rap,
            'lowest_resale': lowest_resale,
            'rap_changed': rap_changed
        })
    
    logger.info(f"✅ Processing complete:")
    logger.info(f"   - Items in DB: {len(items_from_db)}")
    logger.info(f"   - Items processed: {items_processed}")
    logger.info(f"   - Items with valid data: {len(results)}")
    logger.info(f"   - Items with price: {items_with_price}")
    logger.info(f"   - Items skipped (no Rolimons data): {items_skipped_no_data}")
    logger.info(f"   - Items skipped (no RAP): {items_skipped_no_rap}")
    
    return results

def save_results_to_db(results):
    """Batch save all results to database"""
    if not results:
        logger.warning("⚠️ No results to save")
        return
    
    conn = None
    cursor = None
    
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        price_history_data = []
        sale_data = []
        
        logger.info(f"Preparing database updates for {len(results)} items...")
        
        for result in results:
            # PriceHistory insert - ONLY if we have a valid price
            if result['price'] is not None:
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
        
        logger.info(f"Database operations planned:")
        logger.info(f"   - PriceHistory inserts: {len(price_history_data)}")
        logger.info(f"   - Sale inserts: {len(sale_data)}")
        
        # Batch insert PriceHistory
        if price_history_data:
            logger.info("Inserting into PriceHistory...")
            cursor.executemany('''
                INSERT INTO "PriceHistory" 
                (id, "itemId", price, rap, "lowestResale", "salesVolume", timestamp)
                VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s)
            ''', price_history_data)
            logger.info(f"✅ Inserted {len(price_history_data)} PriceHistory records")
        
        # Batch insert Sales
        if sale_data:
            logger.info("Inserting into Sale...")
            cursor.executemany('''
                INSERT INTO "Sale" 
                (id, "itemId", "salePrice", "sellerUsername", "buyerUsername", "serialNumber", "saleDate")
                VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s)
            ''', sale_data)
            logger.info(f"✅ Inserted {len(sale_data)} Sale records")
        
        conn.commit()
        logger.info(f"💾 Database commit successful!")
        
    except psycopg2.Error as e:
        logger.error(f"❌ PostgreSQL error: {e}")
        logger.error(f"Error code: {e.pgcode}")
        if conn:
            conn.rollback()
    except Exception as e:
        logger.error(f"❌ Unexpected database error: {e}")
        logger.error(traceback.format_exc())
        if conn:
            conn.rollback()
    finally:
        if cursor:
            cursor.close()
        if conn:
            return_db_connection(conn)

def update_item_prices():
    """Main update logic using Rolimons deals page scraping"""
    conn = None
    cursor = None
    
    try:
        logger.info("=" * 80)
        logger.info("Starting price update cycle")
        logger.info("=" * 80)
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get all items from database
        logger.info("Fetching items from database...")
        cursor.execute('SELECT id, "assetId", name FROM "Item"')
        items = cursor.fetchall()
        
        if not items:
            logger.warning("⚠️ No items found in database!")
            return
        
        logger.info(f"📊 Found {len(items)} items in database")
        
        # Load previous RAPs
        logger.info("Loading previous RAP values...")
        cursor.execute('''
            SELECT DISTINCT ON ("itemId") "itemId", rap
            FROM "PriceHistory"
            ORDER BY "itemId", timestamp DESC
        ''')
        previous_raps = {row[0]: row[1] for row in cursor.fetchall()}
        logger.info(f"Loaded {len(previous_raps)} previous RAP values")
        
        # Close this connection before long HTTP request
        cursor.close()
        return_db_connection(conn)
        conn = None
        cursor = None
        
        # Fetch all data from Rolimons deals page (single HTTP call!)
        rolimons_data = fetch_rolimons_data()
        
        if not rolimons_data:
            logger.error("❌ Failed to fetch data from Rolimons - skipping this cycle")
            return
        
        # Process all data
        results = process_items_data(items, rolimons_data, previous_raps)
        
        # Save to database
        save_results_to_db(results)
        
        logger.info("=" * 80)
        logger.info("✅ Price update cycle complete!")
        logger.info("=" * 80)
        
    except Exception as e:
        logger.error(f"❌ Critical error in update_item_prices: {e}")
        logger.error(traceback.format_exc())
    finally:
        if cursor:
            cursor.close()
        if conn:
            return_db_connection(conn)

def main():
    """Main worker loop"""
    logger.info("=" * 80)
    logger.info("🚀 Azurewrath Worker Starting")
    logger.info("=" * 80)
    logger.info(f"Mode: Rolimons Deals Page Scraping")
    logger.info(f"Update interval: {WORKER_INTERVAL} seconds")
    logger.info(f"Database: {DATABASE_URL[:30]}..." if DATABASE_URL else "No database URL!")
    logger.info("=" * 80)
    
    # Initialize connection pool
    try:
        init_connection_pool()
    except Exception as e:
        logger.error(f"❌ Failed to initialize - exiting")
        input("Press Enter to exit...")
        return
    
    cycle_count = 0
    
    while True:
        try:
            cycle_count += 1
            logger.info(f"\n🔄 Starting cycle #{cycle_count}")
            
            start_time = time.time()
            update_item_prices()
            elapsed = time.time() - start_time
            
            logger.info(f"⏱️  Cycle #{cycle_count} took {elapsed:.2f} seconds")
            logger.info(f"😴 Sleeping for {WORKER_INTERVAL} seconds...")
            logger.info("")
            
            time.sleep(WORKER_INTERVAL)
            
        except KeyboardInterrupt:
            logger.info("\n" + "=" * 80)
            logger.info("👋 Worker stopped by user (Ctrl+C)")
            logger.info("=" * 80)
            break
        except Exception as e:
            logger.error(f"❌ Unexpected error in main loop: {e}")
            logger.error(traceback.format_exc())
            logger.info("⏳ Waiting 30 seconds before retry...")
            time.sleep(30)

if __name__ == "__main__":
    main()