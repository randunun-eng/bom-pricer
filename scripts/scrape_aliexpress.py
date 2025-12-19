#!/usr/bin/env python3
"""
AliExpress Search Scraper - Bypasses blocking using local Playwright browser

This script:
1. Opens a real browser on your machine
2. Searches AliExpress for a keyword (e.g., "30A ESC")
3. Extracts the top 5 product URLs
4. Opens each product and extracts variants with prices
5. Sends data to Cloudflare Worker for storage

Requirements:
    pip install playwright requests
    playwright install chromium

Usage:
    python scrape_aliexpress.py "30A ESC"
    python scrape_aliexpress.py "40A ESC"
"""

import sys
import time
import json
import random
import requests
from playwright.sync_api import sync_playwright

# Configuration
CLOUDFLARE_API = "https://bom-pricer-api.randunun.workers.dev/api/nova/ingest"
API_KEY = "66d22b8346317ce8f696f75e250e70811c9c5055ba2f5894"
MAX_PRODUCTS = 5
HEADLESS = False  # Set to True to run without visible browser


def random_delay(min_sec=1, max_sec=3):
    """Human-like random delay"""
    time.sleep(random.uniform(min_sec, max_sec))


def search_aliexpress(page, keyword):
    """Search AliExpress and return product URLs"""
    print(f"🔍 Searching for: {keyword}")
    
    # Go to AliExpress search
    search_url = f"https://www.aliexpress.com/wholesale?SearchText={keyword.replace(' ', '+')}"
    page.goto(search_url, timeout=60000, wait_until="domcontentloaded")
    random_delay(5, 8)  # Longer delay to let page fully load
    
    # Scroll down to trigger lazy loading
    page.evaluate("window.scrollBy(0, 500)")
    random_delay(2, 3)
    page.evaluate("window.scrollBy(0, 500)")
    random_delay(2, 3)
    
    # Wait for any product-related element
    product_selectors = [
        "a[href*='/item/'][href*='.html']",
        "[class*='SearchProductFeed'] a",
        "[class*='product'] a[href*='item']",
        ".list--gallery--C2f2tvm a",
        "[data-widget-cid*='search'] a[href*='item']"
    ]
    
    found = False
    for selector in product_selectors:
        try:
            page.wait_for_selector(selector, timeout=5000)
            print(f"   Found products with: {selector}")
            found = True
            break
        except:
            continue
    
    if not found:
        # Take a screenshot for debugging
        page.screenshot(path="/tmp/aliexpress_debug.png")
        print("   📸 Debug screenshot saved to /tmp/aliexpress_debug.png")
    
    # Extract product URLs
    product_links = page.evaluate("""
        () => {
            const links = [];
            // Try multiple selectors for different AliExpress layouts
            const selectors = [
                '.search-item-card-wrapper-gallery a[href*="/item/"]',
                '[class*="product-card"] a[href*="/item/"]',
                'a[href*="aliexpress.com/item/"]'
            ];
            
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    elements.forEach(el => {
                        const href = el.href || el.getAttribute('href');
                        if (href && href.includes('/item/') && !links.includes(href)) {
                            links.push(href);
                        }
                    });
                    break;
                }
            }
            
            return links.slice(0, 10);  // Get top 10 for deduplication
        }
    """)
    
    # Deduplicate by product ID
    seen_ids = set()
    unique_urls = []
    for url in product_links:
        match = url.split('/item/')[-1].split('.')[0] if '/item/' in url else None
        if match and match not in seen_ids:
            seen_ids.add(match)
            unique_urls.append(url)
            if len(unique_urls) >= MAX_PRODUCTS:
                break
    
    print(f"📦 Found {len(unique_urls)} unique products")
    return unique_urls


def extract_product_data(page, url, keyword):
    """Extract product data including variants from a single product page"""
    print(f"  📥 Loading: {url[:60]}...")
    
    try:
        page.goto(url, timeout=60000, wait_until="domcontentloaded")
        random_delay(2, 4)
    except Exception as e:
        print(f"  ❌ Failed to load page: {e}")
        return None
    
    # Wait for page to stabilize
    random_delay(1, 2)
    
    # Extract data using AliExpress's embedded JSON
    data = page.evaluate("""
        (keyword) => {
            // Try to get runParams or __INIT_DATA__
            const runParams = window.runParams || window.__INIT_DATA__;
            
            // Extract title
            let title = document.querySelector('h1')?.textContent?.trim() || '';
            if (!title) {
                title = document.querySelector('[class*="title"]')?.textContent?.trim() || 'Unknown';
            }
            
            // Extract price (try multiple formats)
            let priceText = '';
            const priceSelectors = [
                '[class*="price--current"] span',
                '.product-price-value',
                '[class*="Price_Price"]',
                '.uniform-banner-box-price'
            ];
            for (const sel of priceSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    priceText = el.textContent;
                    break;
                }
            }
            
            // Parse price
            let price = 0;
            let currency = 'USD';
            const priceMatch = priceText.match(/[\\d,.]+/);
            if (priceMatch) {
                price = parseFloat(priceMatch[0].replace(',', ''));
            }
            if (priceText.includes('LKR') || priceText.includes('රු')) {
                currency = 'LKR';
            }
            
            // Extract variants (SKU options)
            const variants = [];
            const skuElements = document.querySelectorAll('[class*="sku-item"], [class*="sku-property-item"], .sku-property-text');
            
            skuElements.forEach((el, i) => {
                const label = el.textContent?.trim() || `option-${i}`;
                if (label && label.length < 100) {  // Sanity check
                    variants.push({
                        variant_label: label,
                        price: price,
                        currency: currency,
                        stock_available: true
                    });
                }
            });
            
            // If no variants found, create a default one
            if (variants.length === 0) {
                variants.push({
                    variant_label: 'Default',
                    price: price,
                    currency: currency,
                    stock_available: true
                });
            }
            
            // Filter variants that match the keyword (case-insensitive)
            const kw = keyword.toUpperCase();
            const matchingVariants = variants.filter(v => {
                const label = (v.variant_label + ' ' + title).toUpperCase();
                // Check if the amperage matches
                const kwMatch = kw.match(/(\\d+)A/);
                const labelMatch = label.match(/(\\d+)A/);
                if (kwMatch && labelMatch) {
                    return kwMatch[1] === labelMatch[1];
                }
                return label.includes(kw.replace(/\\s+/g, ''));
            });
            
            return {
                title: title,
                price: price,
                currency: currency,
                variants: matchingVariants.length > 0 ? matchingVariants : variants.slice(0, 3),
                has_json: !!runParams
            };
        }
    """, keyword)
    
    if data:
        data['product_url'] = url
        print(f"  ✅ Title: {data['title'][:50]}... | Price: {data['currency']} {data['price']} | Variants: {len(data['variants'])}")
    
    return data


def send_to_cloudflare(products, keyword):
    """Send extracted products to Cloudflare Worker"""
    print(f"\n📤 Sending {len(products)} products to Cloudflare...")
    
    successful = 0
    for product in products:
        if not product:
            continue
            
        # Build payload for /api/nova/ingest
        payload = {
            "html": f"<title>{product['title']}</title>",  # Minimal HTML
            "json": {
                "priceComponent": {
                    "discountPrice": {"minPrice": product['price']},
                    "origPrice": {"minPrice": product['price']}
                },
                "skuComponent": {
                    "productSKUPropertyList": [{
                        "skuPropertyName": "Model",
                        "skuPropertyValues": [
                            {"propertyValueName": v['variant_label']} 
                            for v in product['variants']
                        ]
                    }]
                }
            },
            "product_url": product['product_url'],
            "search_keyword": keyword,
            "currency": product['currency']
        }
        
        try:
            r = requests.post(
                CLOUDFLARE_API,
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json"
                },
                data=json.dumps(payload),
                timeout=30
            )
            
            if r.status_code == 200:
                result = r.json()
                print(f"  ✅ Stored: {result.get('title', 'Unknown')[:40]}... ({result.get('variants_stored', 0)} variants)")
                successful += 1
            else:
                print(f"  ❌ Failed ({r.status_code}): {r.text[:100]}")
                
        except Exception as e:
            print(f"  ❌ Error: {e}")
    
    return successful


def main(keyword):
    """Main scraping workflow"""
    print("=" * 60)
    print(f"🚀 AliExpress Scraper - Keyword: '{keyword}'")
    print("=" * 60)
    
    with sync_playwright() as p:
        # Launch browser with realistic settings
        browser = p.chromium.launch(
            headless=HEADLESS,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-dev-shm-usage'
            ]
        )
        
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale='en-US'
        )
        
        page = context.new_page()
        
        # Anti-detection: Remove webdriver property
        page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)
        
        try:
            # Step 1: Search
            product_urls = search_aliexpress(page, keyword)
            
            if not product_urls:
                print("❌ No products found. AliExpress may have blocked the search.")
                return
            
            # Step 2: Extract data from each product
            products = []
            for i, url in enumerate(product_urls, 1):
                print(f"\n[{i}/{len(product_urls)}] Extracting product...")
                data = extract_product_data(page, url, keyword)
                if data:
                    products.append(data)
                random_delay(2, 4)  # Delay between products
            
            # Step 3: Send to Cloudflare
            if products:
                stored = send_to_cloudflare(products, keyword)
                print(f"\n✅ Done! Stored {stored}/{len(products)} products.")
            else:
                print("\n❌ No products extracted.")
                
        finally:
            browser.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrape_aliexpress.py '<keyword>'")
        print("Example: python scrape_aliexpress.py '30A ESC'")
        sys.exit(1)
    
    keyword = sys.argv[1]
    main(keyword)
