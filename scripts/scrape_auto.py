#!/usr/bin/env python3
"""
AliExpress Auto Scraper - Fully automated, no user input required

This script is used by the Nova daemon for automated crawling.
It does NOT wait for CAPTCHA solving - if blocked, it fails gracefully.

Usage:
    python scripts/scrape_auto.py "30A ESC"
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
PAGE_LOAD_WAIT = 8  # seconds to wait for page to load


def random_delay(min_sec=1, max_sec=2):
    """Random delay"""
    time.sleep(random.uniform(min_sec, max_sec))


def extract_products(page, keyword):
    """Extract product URLs from search page"""
    print("📦 Extracting product links...")
    
    product_links = page.evaluate("""
        () => {
            const links = new Set();
            document.querySelectorAll('a[href*="/item/"]').forEach(a => {
                const href = a.href;
                if (href && href.includes('aliexpress.com/item/')) {
                    links.add(href.split('?')[0]);
                }
            });
            return Array.from(links);
        }
    """)
    
    # Deduplicate
    seen_ids = set()
    unique_urls = []
    for url in product_links:
        if '/item/' in url:
            product_id = url.split('/item/')[-1].split('.')[0]
            if product_id.isdigit() and product_id not in seen_ids:
                seen_ids.add(product_id)
                unique_urls.append(url)
                if len(unique_urls) >= MAX_PRODUCTS:
                    break
    
    print(f"   Found {len(unique_urls)} unique products")
    return unique_urls


def extract_product_data(page, url, keyword):
    """Extract data from product page"""
    print(f"  📥 Loading: {url.split('/item/')[-1][:20]}...")
    
    try:
        page.goto(url, timeout=30000, wait_until="domcontentloaded")
        time.sleep(PAGE_LOAD_WAIT)  # Wait for dynamic content
    except Exception as e:
        print(f"  ❌ Failed: {e}")
        return None
    
    # Scroll to trigger lazy loading
    page.evaluate("window.scrollBy(0, 300)")
    time.sleep(1)
    
    data = page.evaluate("""
        (keyword) => {
            const titleEl = document.querySelector('h1') || document.querySelector('[class*="title"]');
            const title = titleEl?.textContent?.trim() || 'Unknown Product';
            
            let price = 0;
            let currency = 'USD';
            const priceSelectors = [
                '.product-price-value',
                '[class*="Price_Price"]',
                '[class*="price--current"]',
                '.uniform-banner-box-price'
            ];
            for (const sel of priceSelectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const text = el.textContent;
                    const match = text.match(/([\\d,.]+)/);
                    if (match) {
                        price = parseFloat(match[1].replace(',', ''));
                        if (text.includes('LKR') || text.includes('රු')) currency = 'LKR';
                        break;
                    }
                }
            }
            
            const variants = [];
            const skuSelectors = [
                '.sku-property-text',
                '[class*="sku-item"]',
                '[class*="skuPropertyValue"]',
                'button[class*="SkuValue"]'
            ];
            
            for (const sel of skuSelectors) {
                const elements = document.querySelectorAll(sel);
                if (elements.length > 0) {
                    elements.forEach((el) => {
                        const label = el.textContent?.trim();
                        if (label && label.length < 80 && label.length > 0) {
                            variants.push({
                                variant_label: label,
                                price: price,
                                currency: currency,
                                stock_available: true
                            });
                        }
                    });
                    break;
                }
            }
            
            if (variants.length === 0) {
                variants.push({
                    variant_label: 'Default',
                    price: price,
                    currency: currency,
                    stock_available: true
                });
            }
            
            return { title, price, currency, variants };
        }
    """, keyword)
    
    if data:
        data['product_url'] = url
        print(f"  ✅ {data['title'][:40]}... | {data['currency']} {data['price']} | {len(data['variants'])} variants")
    
    return data


def send_to_cloudflare(products, keyword):
    """Upload products to Cloudflare"""
    print(f"\n📤 Uploading {len(products)} products...")
    
    success = 0
    for p in products:
        if not p:
            continue
            
        payload = {
            "html": f"<title>{p['title']}</title>",
            "json": {
                "priceComponent": {"discountPrice": {"minPrice": p['price']}},
                "skuComponent": {"productSKUPropertyList": [{"skuPropertyName": "Model", "skuPropertyValues": [{"propertyValueName": v['variant_label']} for v in p['variants']]}]}
            },
            "product_url": p['product_url'],
            "search_keyword": keyword,
            "currency": p['currency']
        }
        
        try:
            r = requests.post(
                CLOUDFLARE_API,
                headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
                data=json.dumps(payload),
                timeout=30
            )
            if r.status_code == 200:
                result = r.json()
                print(f"  ✅ {result.get('title', '?')[:35]}... ({result.get('variants_stored', 0)} variants)")
                success += 1
            else:
                print(f"  ❌ Failed: {r.status_code}")
        except Exception as e:
            print(f"  ❌ Error: {e}")
    
    return success


def check_for_captcha(page):
    """Check if page has CAPTCHA"""
    return page.evaluate("""
        () => {
            const body = document.body?.innerText?.toLowerCase() || '';
            return body.includes('verify') || 
                   body.includes('captcha') || 
                   body.includes('robot') ||
                   body.includes('security check');
        }
    """)


def main(keyword):
    print("=" * 60)
    print(f"🤖 AliExpress Auto Scraper - '{keyword}'")
    print("=" * 60)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,  # Visible for now, can set True for fully headless
            args=['--disable-blink-features=AutomationControlled']
        )
        
        context = browser.new_context(
            viewport={'width': 1400, 'height': 900},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        )
        
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
        
        # Navigate to search
        url = f"https://www.aliexpress.com/wholesale?SearchText={keyword.replace(' ', '+')}"
        print(f"\n🌐 Opening: {url}")
        
        try:
            page.goto(url, timeout=30000)
        except Exception as e:
            print(f"❌ Failed to load search page: {e}")
            browser.close()
            return 1
        
        # Wait for page to load
        print(f"⏳ Waiting {PAGE_LOAD_WAIT}s for page load...")
        time.sleep(PAGE_LOAD_WAIT)
        
        # Check for CAPTCHA
        if check_for_captcha(page):
            print("🚫 CAPTCHA detected! Aborting.")
            browser.close()
            return 1
        
        # Extract products
        urls = extract_products(page, keyword)
        
        if not urls:
            print("❌ No products found")
            browser.close()
            return 1
        
        # Process each product
        products = []
        for i, product_url in enumerate(urls, 1):
            print(f"\n[{i}/{len(urls)}] Extracting...")
            data = extract_product_data(page, product_url, keyword)
            if data:
                products.append(data)
            random_delay(1, 2)
        
        # Upload
        if products:
            stored = send_to_cloudflare(products, keyword)
            print(f"\n✅ Done! Stored {stored}/{len(products)} products")
            browser.close()
            return 0 if stored > 0 else 1
        else:
            print("\n❌ No products extracted")
            browser.close()
            return 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrape_auto.py '<keyword>'")
        sys.exit(1)
    
    exit_code = main(sys.argv[1])
    sys.exit(exit_code)
