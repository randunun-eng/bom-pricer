import json
import sqlite3
import os

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(base_dir, "../bom_pricer.db")
    json_path = os.path.join(base_dir, "../normalizer/sample_normalized.json")
    
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Ensure table exists locally for validation if not using schema.sql here
    # (The user instructions imply schema.sql is for D1, but we need it locally too to insert)
    # I'll just execute the schema definition string or assume user wants to test the INSERTs.
    # To be safe and identical to D1, I'll read the schema file.
    
    schema_path = os.path.join(base_dir, "schema.sql")
    with open(schema_path) as f:
        schema_sql = f.read()
    cur.executescript(schema_sql)

    with open(json_path) as f:
        items = json.load(f)

    for i in items:
        cur.execute("""
          INSERT INTO catalog_items
          (canonical_type, current_A, title, variant,
           price_value, price_currency,
           seller_name, seller_rating, product_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            i["canonical_type"],
            i["current_A"],
            i["title"],
            i["variant"],
            i["price_value"],
            i["price_currency"],
            i["seller"].get("name"),
            i["seller"].get("rating"),
            i["product_url"]
        ))

    conn.commit()
    conn.close()
    print(f"Loaded {len(items)} items into {db_path}")

if __name__ == "__main__":
    main()
