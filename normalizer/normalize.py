import re
import json
import os

def extract_current_amp(text: str):
    if not text:
        return None
    m = re.search(r'(\d+)\s*A', text.upper())
    return int(m.group(1)) if m else None

def is_esc(text: str):
    if not text:
        return False
    keywords = ["ESC", "ELECTRONIC SPEED CONTROLLER", "BRUSHLESS ESC"]
    t = text.upper()
    return any(k in t for k in keywords)

def normalize_item(item):
    title = item.get("product_title", "")
    variant = item.get("variant_label", "")
    price = item.get("price")

    try:
        price = float(price)
    except:
        price = None

    # Prioritize variant for Amp extraction as it is more specific
    # If variant string has "30A", we want that, even if title says "20A/30A"
    return {
        "canonical_type": "ESC" if is_esc(title + " " + variant) else None,
        "current_A": extract_current_amp(variant + " " + title),
        "title": title.strip(),
        "variant": variant.strip(),
        "price_usd": price,
        "price_value": price,
        "price_currency": item.get("currency", "UNKNOWN"),
        "product_url": item.get("product_url"),
        "seller": item.get("seller", {})
    }

def main():
    # Use absolute path or relative to script location
    base_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(base_dir, "../crawler/sample_raw.json")
    output_path = os.path.join(base_dir, "sample_normalized.json")
    
    with open(input_path) as f:
        raw = json.load(f)

    normalized = [normalize_item(i) for i in raw]

    # Task 2.4 — Filter garbage
    normalized = [
        n for n in normalized
        if n["canonical_type"] == "ESC"
        and n["current_A"] is not None
        and n["price_usd"] is not None
    ]

    with open(output_path, "w") as f:
        json.dump(normalized, f, indent=2)

if __name__ == "__main__":
    main()
