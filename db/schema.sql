CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  canonical_type TEXT NOT NULL,
  current_A INTEGER NOT NULL,

  title TEXT,
  variant TEXT,

  price_value REAL NOT NULL,
  price_currency TEXT NOT NULL,

  seller_name TEXT,
  seller_rating REAL,

  product_url TEXT,

  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_catalog_lookup
ON catalog_items (canonical_type, current_A);
