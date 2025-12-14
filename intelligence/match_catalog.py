from nova_stub import nova_rank
from currency import to_usd

def match_items(bom_items, catalog):
    results = []

    for b in bom_items:
        candidates = [
            c for c in catalog
            if c["canonical_type"] == b["canonical_type"]
            and c["current_A"] == b["current_A"]
        ]

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
