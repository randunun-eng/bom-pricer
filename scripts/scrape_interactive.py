#!/usr/bin/env python3
"""
AliExpress Interactive Scraper - Waits for user to solve CAPTCHA

This script:
1. Opens a visible browser window
2. Navigates to AliExpress search
3. PAUSES and waits for you to solve any CAPTCHA/verification
4. Press ENTER in terminal when ready
5. Extracts products and sends to Cloudflare

Usage:
    source .venv/bin/activate
    python scripts/scrape_interactive.py "30A ESC"
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


def random_delay(min_sec=1, max_sec=3):
    """Human-like random delay"""
    time.sleep(random.uniform(min_sec, max_sec))


def extract_products(page, keyword):
    """Extract product URLs from current page"""
    print("📦 Extracting product links...")
    
    # Extract all links to product pages
    product_links = page.evaluate("""
        () => {
            const links = new Set();
            
            // Find all links containing /item/
            document.querySelectorAll('a[href*="/item/"]').forEach(a => {
                const href = a.href;
                if (href && href.includes('aliexpress.com/item/')) {
                    links.add(href.split('?')[0]);  // Remove query params
                }
            });
            
            return Array.from(links);
        }
    """)
    
    # Deduplicate by product ID
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
    """Extract data from a single product page with per-variant pricing"""
    print(f"  📥 Loading: {url.split('/item/')[-1][:20]}...")
    
    try:
        page.goto(url, timeout=30000, wait_until="domcontentloaded")
        random_delay(3, 5)
    except Exception as e:
        print(f"  ❌ Failed: {e}")
        return None
    
    # Scroll to load lazy content
    page.evaluate("window.scrollBy(0, 300)")
    random_delay(1, 2)
    
    # Get title first (with better selector)
    title = page.evaluate("""
        () => {
            // Try multiple title selectors
            const selectors = [
                'h1[data-pl="product-title"]',
                'h1',
                '[class*="ProductTitle"]',
                '[class*="product-title"]',
                '[class*="HalfLayout"] h1'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent?.trim()) {
                    return el.textContent.trim();
                }
            }
            return document.title || 'Unknown Product';
        }
    """)
    print(f"    Title: {title[:50]}...")
    
    # Helper function to get current displayed price
    def get_current_price():
        result = page.evaluate("""
            () => {
                let price = 0;
                let currency = 'LKR';
                let foundIn = '';
                
                // Broader price selectors
                const priceSelectors = [
                    '[class*="price--current"] span',
                    '[class*="price--current"]',
                    '[class*="Price"] span',
                    '[class*="product-price"]',
                    '[class*="es--wrap"] span',
                    '.uniform-banner-box-price',
                    '[class*="SnapshotPrice"]',
                    '[class*="Price_Price"]'
                ];
                
                for (const sel of priceSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        const text = el.textContent || '';
                        // Match LKR or plain numbers
                        const match = text.match(/(?:LKR|රු)?\\s*([\\d,]+(?:\\.\\d{1,2})?)/);
                        if (match) {
                            const parsed = parseFloat(match[1].replace(/,/g, ''));
                            if (parsed > 0) {
                                price = parsed;
                                foundIn = sel;
                                if (text.includes('LKR') || text.includes('රු')) currency = 'LKR';
                                else if (text.includes('$')) currency = 'USD';
                                break;
                            }
                        }
                    }
                }
                
                // Fallback: search body text for LKR pattern
                if (price === 0) {
                    const allText = document.body?.innerText || '';
                    const lkrMatch = allText.match(/LKR\\s*([\\d,]+(?:\\.\\d{1,2})?)/);
                    if (lkrMatch) {
                        price = parseFloat(lkrMatch[1].replace(/,/g, ''));
                        currency = 'LKR';
                        foundIn = 'body-text-fallback';
                    }
                }
                
                return { price, currency, foundIn };
            }
        """)
        if result['price'] > 0:
            return result
        return {'price': 0, 'currency': 'LKR', 'foundIn': ''}
    
    # Find variant buttons using Playwright
    variant_selectors = [
        '[class*="sku-item"]', 
        '[class*="skuPropertyValue"]', 
        'button[class*="SkuValue"]',
        '.sku-property-text'
    ]
    
    variants = []
    variant_buttons = []
    
    for sel in variant_selectors:
        buttons = page.query_selector_all(sel)
        if buttons and len(buttons) > 0:
            variant_buttons = buttons
            print(f"    Found {len(buttons)} variant buttons with '{sel}'")
            break
    
    if variant_buttons and len(variant_buttons) > 0:
        for i, btn in enumerate(variant_buttons[:15]):  # Limit to 15 variants
            try:
                # Get variant label
                label = btn.text_content()
                if not label or len(label.strip()) == 0 or len(label) > 80:
                    continue
                label = label.strip()
                
                # Click the variant to update price
                btn.click()
                random_delay(0.3, 0.6)
                
                # Get updated price after clicking
                price_info = get_current_price()
                
                if price_info['price'] > 0:
                    variants.append({
                        'variant_label': label,
                        'price': price_info['price'],
                        'currency': price_info['currency'],
                        'stock_available': True
                    })
                    print(f"      {label}: {price_info['currency']} {price_info['price']}")
                    
            except Exception as e:
                continue
    
    # If no variants found, get default price
    if len(variants) == 0:
        price_info = get_current_price()
        if price_info['price'] > 0:
            variants.append({
                'variant_label': 'Default',
                'price': price_info['price'],
                'currency': price_info['currency'],
                'stock_available': True
            })
    
    data = {
        'title': title,
        'product_url': url,
        'variants': variants,
        'price': variants[0]['price'] if variants else 0,
        'currency': variants[0]['currency'] if variants else 'LKR'
    }
    
    print(f"  ✅ {title[:40]}... | {len(variants)} variants with individual prices")
    return data


def send_to_cloudflare(products, keyword):
    """Send products to Cloudflare Worker using direct insert endpoint"""
    print(f"\n📤 Uploading {len(products)} products...")
    
    # Use the simpler direct insert endpoint
    INSERT_API = "https://bom-pricer-api.randunun.workers.dev/api/nova/insert"
    
    success = 0
    for p in products:
        if not p:
            continue
        
        # Build simple payload for direct insert
        payload = {
            "title": p['title'],
            "product_url": p['product_url'],
            "variants": p['variants'],
            "search_keyword": keyword,
            "currency": p['currency']
        }
        
        try:
            r = requests.post(
                INSERT_API,
                headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
                data=json.dumps(payload),
                timeout=30
            )
            if r.status_code == 200:
                result = r.json()
                print(f"  ✅ {result.get('title', '?')[:35]}... ({result.get('variants_stored', 0)} variants)")
                success += 1
            else:
                err = r.text[:100] if r.text else str(r.status_code)
                print(f"  ❌ Failed: {r.status_code} - {err}")
        except Exception as e:
            print(f"  ❌ Error: {e}")
    
    return success



def main(keyword):
    print("=" * 60)
    print(f"🚀 AliExpress Interactive Scraper - '{keyword}'")
    print("=" * 60)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,  # Visible browser!
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
        page.goto(url, timeout=60000)
        
        # Wait for user
        print("\n" + "=" * 60)
        print("👀 BROWSER IS OPEN")
        print("=" * 60)
        print("1. Solve any CAPTCHA or verification challenge")
        print("2. Wait for product listings to appear")
        print("3. Press ENTER here when ready...")
        print("=" * 60)
        input()
        
        # Extract
        urls = extract_products(page, keyword)
        
        if not urls:
            print("❌ No products found on page")
            input("Press ENTER to close browser...")
            browser.close()
            return
        
        # Process each product
        products = []
        for i, url in enumerate(urls, 1):
            print(f"\n[{i}/{len(urls)}] Extracting...")
            data = extract_product_data(page, url, keyword)
            if data:
                products.append(data)
            random_delay(2, 4)
        
        # Upload
        if products:
            stored = send_to_cloudflare(products, keyword)
            print(f"\n✅ Done! Stored {stored}/{len(products)} products")
        else:
            print("\n❌ No products extracted")
        
        print("\nPress ENTER to close browser...")
        input()
        browser.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrape_interactive.py '<keyword>'")
        print("Example: python scrape_interactive.py '30A ESC'")
        sys.exit(1)
    
    main(sys.argv[1])
