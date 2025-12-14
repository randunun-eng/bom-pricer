"""
Variant Price Filter Algorithm

Computes a "likely real price" from variant prices:
1. Collect all valid variant prices
2. Sort ascending
3. Remove bottom 30% (bulk/fake price traps)
4. Remove top 10% (rare overpriced)
5. Take median of remaining
"""

import statistics

def compute_likely_price(variant_prices):
    """
    Given a list of variant prices, compute the likely real price.
    
    Args:
        variant_prices: List of float prices
        
    Returns:
        dict with likely_price, variant_count, price_method
    """
    if not variant_prices:
        return {
            "likely_price": None,
            "variant_count": 0,
            "price_method": "no_variants"
        }
    
    # Sort ascending
    sorted_prices = sorted(variant_prices)
    n = len(sorted_prices)
    
    if n == 1:
        return {
            "likely_price": sorted_prices[0],
            "variant_count": 1,
            "price_method": "single_variant"
        }
    
    if n == 2:
        # For 2 variants, take the average
        return {
            "likely_price": round(sum(sorted_prices) / 2, 4),
            "variant_count": 2,
            "price_method": "pair_average"
        }
    
    # Remove bottom 30%
    bottom_cut = int(n * 0.30)
    # Remove top 10%
    top_cut = int(n * 0.10)
    
    # Ensure we keep at least 1 item
    if bottom_cut + top_cut >= n:
        # If too few items, just use median of all
        return {
            "likely_price": round(statistics.median(sorted_prices), 4),
            "variant_count": n,
            "price_method": "full_median"
        }
    
    # Filter: keep middle portion
    filtered = sorted_prices[bottom_cut : n - top_cut] if top_cut > 0 else sorted_prices[bottom_cut:]
    
    if not filtered:
        # Fallback: use all prices
        filtered = sorted_prices
    
    likely_price = round(statistics.median(filtered), 4)
    
    return {
        "likely_price": likely_price,
        "variant_count": n,
        "price_method": "variant_median"
    }


def filter_product_variants(product):
    """
    Process a product with variants and compute likely price.
    
    Args:
        product: dict with 'variants' list, each having 'price'
        
    Returns:
        Product dict enriched with likely_price, variant_count, price_method
    """
    variants = product.get("variants", [])
    
    # Extract valid prices (non-null, positive)
    valid_prices = [
        v["price"] for v in variants 
        if v.get("price") is not None and v["price"] > 0
    ]
    
    price_info = compute_likely_price(valid_prices)
    
    return {
        **product,
        **price_info,
        "min_price": min(valid_prices) if valid_prices else None,
        "max_price": max(valid_prices) if valid_prices else None
    }


# Test with example from user
if __name__ == "__main__":
    # Example: 1.20, 1.30, 3.55, 3.70, 3.80
    test_prices = [1.20, 1.30, 3.55, 3.70, 3.80]
    result = compute_likely_price(test_prices)
    
    print("Input prices:", test_prices)
    print("Sorted:", sorted(test_prices))
    print("After filtering bottom 30%:", sorted(test_prices)[1:])  # Remove 1 item (30% of 5)
    print("After filtering top 10%:", sorted(test_prices)[1:4])    # Remove 1 item from top (10% of 5 = 0.5, rounds to 0 or 1)
    print()
    print("Result:", result)
    print()
    print("Expected: likely_price ~3.62-3.70, variant_count=5, price_method=variant_median")
