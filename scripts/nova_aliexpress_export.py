#!/usr/bin/env python3
"""
Nova Desktop AliExpress Export Helper

Extracts product data from current AliExpress page in Nova/Playwright browser
and sends it to your Cloudflare Worker for storage.

Usage:
    1. Open AliExpress product page in Nova
    2. Solve any verification if needed
    3. Run: export_current_product(page)
"""

import requests
import json
import sys

# Configuration - Update these values
CLOUDFLARE_API = "https://bom-pricer-api.randunun.workers.dev/api/nova/ingest"
API_KEY = "66d22b8346317ce8f696f75e250e70811c9c5055ba2f5894"


def export_current_product(page, api_key=None):
    """
    Export current AliExpress product from Nova/Playwright page.
    
    Args:
        page: Playwright page object with AliExpress product loaded
        api_key: Optional API key override
    
    Returns:
        dict with upload result
    """
    key = api_key or API_KEY
    
    # Get current URL
    product_url = page.url
    print(f"📦 Exporting product: {product_url}")
    
    if "aliexpress.com/item" not in product_url:
        print("⚠️ Warning: This doesn't look like an AliExpress product page")
    
    # 1️⃣ Extract HTML
    html = page.content()
    print(f"   HTML: {len(html):,} bytes")
    
    # 2️⃣ Extract AliExpress embedded JSON (runParams or __INIT_DATA__)
    run_params = page.evaluate("""
        () => window.runParams || window.__INIT_DATA__ || null
    """)
    print(f"   JSON: {'Found' if run_params else 'Not found'}")
    
    # 3️⃣ Build payload
    payload = {
        "html": html,
        "json": run_params,
        "product_url": product_url
    }
    
    # 4️⃣ Send to Cloudflare
    print(f"   Uploading to {CLOUDFLARE_API}...")
    
    try:
        r = requests.post(
            CLOUDFLARE_API,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"
            },
            data=json.dumps(payload),
            timeout=30
        )
        
        result = r.json() if r.headers.get('content-type', '').startswith('application/json') else {"text": r.text}
        
        if r.status_code == 200:
            print(f"✅ Success!")
            print(f"   Product ID: {result.get('product_id')}")
            print(f"   Title: {result.get('title', 'N/A')[:60]}...")
            print(f"   Variants stored: {result.get('variants_stored')}")
            print(f"   Share URL: {result.get('share_url')}")
        else:
            print(f"❌ Upload failed: {r.status_code}")
            print(f"   {result}")
        
        return result
        
    except requests.exceptions.Timeout:
        print("❌ Request timed out")
        return {"error": "timeout"}
    except Exception as e:
        print(f"❌ Error: {e}")
        return {"error": str(e)}


def export_from_url(browser, url, api_key=None):
    """
    Navigate to URL and export product.
    
    Args:
        browser: Playwright browser instance
        url: AliExpress product URL
        api_key: Optional API key override
    """
    page = browser.new_page()
    
    print(f"🌐 Navigating to {url}...")
    page.goto(url, wait_until="networkidle", timeout=60000)
    
    # Wait for page to fully load
    page.wait_for_timeout(3000)
    
    result = export_current_product(page, api_key)
    page.close()
    
    return result


# CLI usage
if __name__ == "__main__":
    print("Nova AliExpress Export Helper")
    print("=" * 40)
    print()
    print("This script should be called from Nova/Playwright environment.")
    print()
    print("Example usage in Nova:")
    print("  from nova_aliexpress_export import export_current_product")
    print("  export_current_product(page)")
    print()
    print(f"API Endpoint: {CLOUDFLARE_API}")
    print(f"API Key configured: {'Yes' if API_KEY != 'YOUR_NOVA_INGEST_KEY' else 'No - update API_KEY in script'}")
