PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  nickname TEXT COLLATE NOCASE UNIQUE NOT NULL,
  share_stats INTEGER NOT NULL DEFAULT 0 CHECK (share_stats IN (0, 1)),
  study_minutes INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  accuracy INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_from ON messages(sender, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_to ON messages(recipient, created_at DESC);

CREATE TABLE IF NOT EXISTS blocks (
  owner TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  blocked TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (owner, blocked)
);
