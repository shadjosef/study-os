CREATE TABLE IF NOT EXISTS ai_usage (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day_utc TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, day_utc)
);
