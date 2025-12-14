def nova_rank(bom_item, candidates):
    # TEMP heuristic fallback
    return {
        "selected_index": 0,
        "match_score": 0.85,
        "reasoning": "Exact 30A match in variant label and lowest price."
    }
