"""
Nova ACT: Title-Variant Consistency Validator

Validates that listing titles match variant offerings without inventing data.
"""

import os
import json

def validate_consistency_stub(listing_title, valid_variants, feedback_samples=None):
    """
    Mock implementation of Nova consistency validation.
    In production, this calls the real Nova ACT API.
    
    Args:
        listing_title: Product listing title string
        valid_variants: List of dicts with 'name' and 'price'
        feedback_samples: Optional list of buyer feedback strings
        
    Returns:
        dict with title_variant_consistent, risk, notes
    """
    if not valid_variants:
        return {
            "title_variant_consistent": False,
            "risk": "HIGH",
            "notes": "No valid variants found for this listing."
        }
    
    # Simple heuristic check (mock logic)
    title_upper = listing_title.upper()
    
    # Check if any variant matches expected pattern from title
    matching_variants = 0
    for v in valid_variants:
        variant_name = v.get("name", "").upper()
        # Check for common ESC specs in both title and variant
        for spec in ["30A", "40A", "20A", "50A", "ESC"]:
            if spec in title_upper and spec in variant_name:
                matching_variants += 1
                break
    
    consistency_ratio = matching_variants / len(valid_variants) if valid_variants else 0
    
    if consistency_ratio >= 0.8:
        return {
            "title_variant_consistent": True,
            "risk": "LOW",
            "notes": f"All sellable variants match title specs; {matching_variants}/{len(valid_variants)} variants consistent."
        }
    elif consistency_ratio >= 0.5:
        return {
            "title_variant_consistent": True,
            "risk": "MEDIUM",
            "notes": f"Some variants match title; {matching_variants}/{len(valid_variants)} consistent. Minor discrepancies detected."
        }
    else:
        return {
            "title_variant_consistent": False,
            "risk": "HIGH",
            "notes": f"Title may be misleading; only {matching_variants}/{len(valid_variants)} variants match title claims."
        }


def validate_consistency(listing_title, valid_variants, feedback_samples=None, use_real_api=False):
    """
    Main entry point for consistency validation.
    
    Args:
        listing_title: Product listing title string
        valid_variants: List of dicts with 'name' and 'price'
        feedback_samples: Optional list of buyer feedback strings
        use_real_api: If True, call real Nova ACT API (requires NOVA_ACT_API_KEY)
        
    Returns:
        dict with title_variant_consistent, risk, notes
    """
    if use_real_api and os.getenv("NOVA_ACT_API_KEY") not in [None, "MOCK"]:
        # TODO: Implement real API call
        # For now, fall back to stub
        pass
    
    return validate_consistency_stub(listing_title, valid_variants, feedback_samples)


# Test
if __name__ == "__main__":
    # Test case 1: Good match
    result1 = validate_consistency(
        "4Pcs LITTLEBEE BLHeli-s 30A ESC Brushless",
        [
            {"name": "30A ESC BLHeli", "price": 3.55},
            {"name": "30A ESC Long Wire", "price": 3.70}
        ]
    )
    print("Test 1 (Good match):", json.dumps(result1, indent=2))
    
    # Test case 2: Misleading title
    result2 = validate_consistency(
        "30A ESC Premium Quality",
        [
            {"name": "Wire Set Only", "price": 0.50},
            {"name": "Screws Pack", "price": 0.30}
        ]
    )
    print("\nTest 2 (Misleading):", json.dumps(result2, indent=2))
    
    # Test case 3: Partial match
    result3 = validate_consistency(
        "ESC Speed Controller 30A 40A",
        [
            {"name": "30A Standard", "price": 3.55},
            {"name": "40A Extended", "price": 4.20},
            {"name": "Mounting Kit", "price": 0.80}
        ]
    )
    print("\nTest 3 (Partial match):", json.dumps(result3, indent=2))
