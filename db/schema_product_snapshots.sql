-- Product Snapshots Table
-- Stores full product data for /product/:id endpoint

CREATE TABLE IF NOT EXISTS product_snapshots (
  product_id TEXT PRIMARY KEY,
  title TEXT,
  data TEXT,  -- JSON blob with full parsed product
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_snapshots_updated 
ON product_snapshots(updated_at DESC);
