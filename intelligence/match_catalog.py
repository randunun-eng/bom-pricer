from nova_client import nova_rank
from currency import to_usd

import sqlite3
import os

def load_candidates(bom_item):
    # Ensure robust path handling
    base_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(base_dir, "../bom_pricer.db")
    
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute("""
      SELECT title, variant, current_A,
             price_value, price_currency,
             seller_name, seller_rating, product_url
      FROM catalog_items
      WHERE canonical_type = ?
      AND current_A = ?
    """, (bom_item["canonical_type"], bom_item["current_A"]))

    rows = cur.fetchall()
    conn.close()

    return [
      {
        "title": r[0],
        "variant": r[1],
        "current_A": r[2],
        "price_value": r[3],
        "price_currency": r[4],
        "seller": {"name": r[5], "rating": r[6]},
        "product_url": r[7],
        "canonical_type": bom_item["canonical_type"] # Add this to satisfy any downstream checks expecting it
      }
      for r in rows
    ]

def match_items(bom_items, catalog=None): # catalog arg is now unused but kept for compatibility signature if needed
    results = []

    for b in bom_items:
        candidates = load_candidates(b)

        if not candidates:
            results.append({"bom": b, "status": "NOT_FOUND"})
            continue

        nova = nova_rank(b, candidates)

        if nova["selected_index"] == -1:
            results.append({"bom": b, "status": "LOW_CONFIDENCE"})
            continue

        selected = candidates[nova["selected_index"]]
        
        usd_price = to_usd(
            selected["price_value"],
            selected["price_currency"]
        )

        results.append({
            "bom": b,
            "status": "MATCHED",
            "selected": selected,
            "unit_price_usd": usd_price,
            "total_price_usd": usd_price * b["qty"] if usd_price else None,
            "match_score": nova["match_score"],
            "reasoning": nova["reasoning"]
        })

    return results
