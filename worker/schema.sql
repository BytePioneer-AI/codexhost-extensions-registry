-- CodexHost product telemetry & extension marketplace stats schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS extension_downloads (
  id TEXT PRIMARY KEY,
  downloads INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extension_downloads_daily (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, id)
);

CREATE INDEX IF NOT EXISTS idx_ext_downloads_daily_day
  ON extension_downloads_daily(day);

CREATE TABLE IF NOT EXISTS devices (
  install_id TEXT PRIMARY KEY,
  first_seen_day TEXT NOT NULL,
  last_seen_day TEXT NOT NULL,
  last_seen_week TEXT NOT NULL,
  last_seen_month TEXT NOT NULL,
  retained_d1 INTEGER NOT NULL DEFAULT 0,
  retained_d7 INTEGER NOT NULL DEFAULT 0,
  retained_w1 INTEGER NOT NULL DEFAULT 0,
  app_version TEXT,
  codex_desktop_version TEXT,
  os TEXT,
  arch TEXT,
  locale TEXT,
  country TEXT
);

CREATE TABLE IF NOT EXISTS daily_device_state (
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  app_version TEXT,
  codex_desktop_version TEXT,
  os TEXT,
  arch TEXT,
  locale TEXT,
  country TEXT,
  surfaces_json TEXT NOT NULL DEFAULT '[]',
  harnesses_json TEXT NOT NULL DEFAULT '[]',
  extensions_json TEXT NOT NULL DEFAULT '[]',
  remote_access_json TEXT NOT NULL DEFAULT '[]',
  remote_configured_json TEXT NOT NULL DEFAULT '[]',
  features_json TEXT NOT NULL DEFAULT '[]',
  remote_counts_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, install_id)
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  dim TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, dim)
);

CREATE INDEX IF NOT EXISTS idx_daily_metrics_metric_day
  ON daily_metrics(metric, day);

CREATE TABLE IF NOT EXISTS period_metrics (
  period_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  dim TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period_type, period_key, metric, dim)
);

CREATE TABLE IF NOT EXISTS worker_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
