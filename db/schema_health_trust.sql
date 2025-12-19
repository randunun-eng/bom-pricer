-- Part 1: Crawl Health Snapshot (Optional history)
CREATE TABLE IF NOT EXISTS crawl_health (
  snapshot_time INTEGER PRIMARY KEY,
  total_keywords INTEGER,
  pending_keywords INTEGER,
  blocked_keywords INTEGER,
  avg_price_age_hours REAL,
  last_captcha_time INTEGER
);

-- Part 2: User Trust Memory
CREATE TABLE IF NOT EXISTS user_trust (
  user_key TEXT,
  seller TEXT,
  brand TEXT,
  trust_score REAL DEFAULT 0,
  select_count INTEGER DEFAULT 0,
  last_selected INTEGER,
  PRIMARY KEY (user_key, seller, brand)
);
