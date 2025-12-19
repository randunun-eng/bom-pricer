#!/usr/bin/env python3
"""
Nova Daemon - Polls Cloudflare for pending keywords and auto-crawls

Run this in background on your machine to automatically process crawl requests.

Usage:
    source .venv/bin/activate
    python scripts/nova_daemon.py

Press Ctrl+C to stop.
"""

import time
import json
import sys
import os
import subprocess
import requests

# Configuration
CLOUDFLARE_API = "https://bom-pricer-api.randunun.workers.dev"
POLL_INTERVAL = 10  # seconds
MAX_CRAWLS_PER_RUN = 3

def get_pending_keywords():
    """Fetch pending keywords from Cloudflare"""
    try:
        r = requests.get(f"{CLOUDFLARE_API}/api/crawl/pending", timeout=10)
        if r.status_code == 200:
            data = r.json()
            # Sort by priority (urgent first)
            keywords = data.get("keywords", [])
            keywords.sort(key=lambda x: x.get("priority", 0), reverse=True)
            return keywords
        return []
    except Exception as e:
        print(f"❌ Error fetching pending: {e}")
        return []


def mark_complete(keyword):
    """Mark keyword as crawled"""
    try:
        r = requests.post(
            f"{CLOUDFLARE_API}/api/crawl/complete",
            json={"keyword": keyword},
            timeout=10
        )
        return r.status_code == 200
    except:
        return False


def run_crawl(keyword):
    """Run the interactive scraper for a keyword"""
    print(f"\n🤖 Crawling: '{keyword}'")
    
    script_path = os.path.join(os.path.dirname(__file__), "scrape_interactive.py")
    
    try:
        result = subprocess.run(
            [sys.executable, script_path, keyword],
            timeout=300,  # 5 minute timeout
            capture_output=False
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print(f"⏰ Timeout for '{keyword}'")
        return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


def daemon_loop():
    """Main daemon loop"""
    print("=" * 60)
    print("🤖 Nova Daemon Started")
    print(f"📡 Polling: {CLOUDFLARE_API}")
    print(f"⏰ Interval: {POLL_INTERVAL}s")
    print("=" * 60)
    print("\nPress Ctrl+C to stop\n")
    
    crawl_count = 0
    
    while True:
        try:
            # Get pending keywords
            keywords = get_pending_keywords()
            urgent = [k for k in keywords if k.get("priority", 0) >= 10]
            
            if urgent:
                print(f"\n🚨 {len(urgent)} urgent keyword(s) found!")
                
                for kw in urgent[:MAX_CRAWLS_PER_RUN]:
                    keyword = kw["keyword"]
                    success = run_crawl(keyword)
                    
                    if success:
                        mark_complete(keyword)
                        crawl_count += 1
                        print(f"✅ Completed: '{keyword}' (total: {crawl_count})")
                    else:
                        print(f"⚠️ Failed: '{keyword}'")
            else:
                # Show status dot
                print(".", end="", flush=True)
            
            time.sleep(POLL_INTERVAL)
            
        except KeyboardInterrupt:
            print(f"\n\n👋 Daemon stopped. Crawled {crawl_count} keywords.")
            break


if __name__ == "__main__":
    daemon_loop()
