CREATE TABLE IF NOT EXISTS archive_passes (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  invite_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_passes_invite ON archive_passes(invite_id);
