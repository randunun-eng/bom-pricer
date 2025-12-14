import requests
import os
from nova_stub import nova_rank as stub_rank

# Default to example, but allow override
NOVA_ENDPOINT = os.getenv("NOVA_ENDPOINT", "https://api.amazon.com/nova/act")

def nova_rank(bom_item, candidates):
    api_key = os.getenv("NOVA_ACT_API_KEY")
    if not api_key:
        print("Warning: NOVA_ACT_API_KEY not set. Returning dummy error.")
        return {"selected_index": -1, "match_score": 0.0, "reasoning": "Missing API Key"}

    # FAILSAFE: Allow local testing without burning credits or needing real creds
    if api_key == "MOCK":
        print("[Nova Client] Using MOCK mode (Stub).")
        return stub_rank(bom_item, candidates)

    payload = {
        "bom_item": {
            "canonical_type": bom_item.get("canonical_type"),
            "current_A": bom_item.get("current_A"),
            "qty": bom_item.get("qty"),
            "raw": bom_item.get("raw")
        },
        "candidates": candidates
    }

    try:
        r = requests.post(
            NOVA_ENDPOINT,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=20
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"Nova API Call Failed: {e}")
        # Fail gracefully so pipeline doesn't crash, but return no selection
        return {"selected_index": -1, "match_score": 0.0, "reasoning": f"API Error: {str(e)}"}
