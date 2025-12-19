CREATE TABLE IF NOT EXISTS crawl_tasks (
  task_id TEXT PRIMARY KEY,
  keyword TEXT,
  status TEXT,          -- pending, sent, completed, failed
  created_at INTEGER,
  completed_at INTEGER,
  error_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON crawl_tasks(status);
