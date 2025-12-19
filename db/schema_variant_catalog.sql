CREATE TABLE IF NOT EXISTS product_variants (
  variant_id TEXT PRIMARY KEY,          -- sha1(product_id + variant_label + pack_qty)
  product_id TEXT,                      -- AliExpress Item ID
  canonical_item TEXT,                  -- ESC, MOTOR, BATTERY
  spec_key TEXT,                        -- "ESC:30A", "MOTOR:2205:2300KV"
  
  brand TEXT,
  model TEXT,
  variant_label TEXT,                   
  
  -- Flexible Specs
  current_A INTEGER,
  voltage_s TEXT,
  capacity_mah INTEGER,
  kv INTEGER,
  
  pack_qty INTEGER DEFAULT 1,
  unit_price_usd REAL,
  pack_price_usd REAL,
  currency TEXT,
  
  stock INTEGER,
  rating REAL,
  review_count INTEGER,
  seller TEXT,
  
  product_url TEXT,
  image_url TEXT,
  
  first_seen INTEGER,
  last_seen INTEGER,
  last_price_update INTEGER
);

CREATE INDEX IF NOT EXISTS idx_spec_key ON product_variants(spec_key);
CREATE INDEX IF NOT EXISTS idx_canonical_item ON product_variants(canonical_item);
