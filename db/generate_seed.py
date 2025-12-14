import json
import os

def check_none(val):
    if val is None:
        return "NULL"
    if isinstance(val, str):
        return f"'{val.replace("'", "''")}'" # Escape single quotes
    return str(val)

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    json_path = os.path.join(base_dir, "../normalizer/sample_normalized.json")
    output_path = os.path.join(base_dir, "seed_remote.sql")

    with open(json_path) as f:
        items = json.load(f)

    with open(output_path, "w") as f:
        f.write("-- Normalized catalog seed data\n")
        f.write("DELETE FROM catalog_items; -- Clear existing data to avoid dupes on re-run\n")
        
        for i in items:
            # Construct INSERT statement
            # Note: We must carefully handle strings and NULLs
            
            canonical_type = check_none(i.get("canonical_type"))
            current_A = check_none(i.get("current_A"))
            title = check_none(i.get("title"))
            variant = check_none(i.get("variant"))
            price_value = check_none(i.get("price_value"))
            price_currency = check_none(i.get("price_currency"))
            seller_name = check_none(i["seller"].get("name"))
            seller_rating = check_none(i["seller"].get("rating"))
            product_url = check_none(i.get("product_url"))

            sql = f"""INSERT INTO catalog_items (canonical_type, current_A, title, variant, price_value, price_currency, seller_name, seller_rating, product_url) VALUES ({canonical_type}, {current_A}, {title}, {variant}, {price_value}, {price_currency}, {seller_name}, {seller_rating}, {product_url});\n"""
            f.write(sql)

    print(f"Generated {len(items)} INSERT statements in {output_path}")

if __name__ == "__main__":
    main()
