-- Optional aggregated AI crawler telemetry for Cloudflare Edge GEO Worker
-- (Zero IP addresses, zero cookies, zero PII — strictly daily path counts per bot)
CREATE TABLE IF NOT EXISTS ai_bot_daily_hits (
  day_utc TEXT NOT NULL,
  bot TEXT NOT NULL,
  path TEXT NOT NULL,
  served_format TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (day_utc, bot, path, served_format)
);

CREATE INDEX IF NOT EXISTS idx_ai_bot_daily_day ON ai_bot_daily_hits(day_utc DESC, hits DESC);
