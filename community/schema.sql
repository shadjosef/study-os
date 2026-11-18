PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  nickname TEXT COLLATE NOCASE UNIQUE NOT NULL,
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

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_latest ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS chat_sender ON chat_messages(sender, created_at DESC);

CREATE TABLE IF NOT EXISTS presence (
  profile TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  elapsed_seconds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  break_ends_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS study_sets (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cards TEXT NOT NULL,
  card_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS study_sets_recent ON study_sets(created_at DESC);
CREATE INDEX IF NOT EXISTS study_sets_owner ON study_sets(owner);

CREATE TABLE IF NOT EXISTS blocks (
  owner TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  blocked TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (owner, blocked)
);
