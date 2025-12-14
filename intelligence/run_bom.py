import json
import os
import sys

# Ensure imports work if running from root or directory
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from parse_bom import parse_bom
from match_catalog import match_items

def main():
    # Construct absolute path to the normalized file
    base_dir = os.path.dirname(os.path.abspath(__file__))
    normalized_path = os.path.join(base_dir, "../normalizer/sample_normalized.json")
    
    with open(normalized_path) as f:
        catalog = json.load(f)

    bom_text = """
    30A ESC x2
    """

    bom_items = parse_bom(bom_text)
    result = match_items(bom_items, catalog)

    from pprint import pprint
    pprint(result)

if __name__ == "__main__":
    main()
