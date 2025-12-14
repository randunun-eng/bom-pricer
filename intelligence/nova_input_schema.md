Nova Input:
- bom_item:
    - canonical_type
    - current_A
    - qty
    - raw (original text)
- candidates[]:
    - title
    - variant
    - current_A
    - price_value
    - price_currency
    - seller.name
    - seller.rating

Nova Output:
- selected_index (int)
- match_score (0.0 - 1.0)
- reasoning (short text)
