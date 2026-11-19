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

CREATE TABLE IF NOT EXISTS study_rooms (
  code TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('group', 'duel')),
  created_at INTEGER NOT NULL,
  starts_at INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER NOT NULL DEFAULT 0,
  deck TEXT
);

CREATE TABLE IF NOT EXISTS room_members (
  code TEXT NOT NULL REFERENCES study_rooms(code) ON DELETE CASCADE,
  profile TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ready INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (code, profile)
);
CREATE INDEX IF NOT EXISTS rooms_by_member ON room_members(profile);

CREATE TRIGGER IF NOT EXISTS add_room_host AFTER INSERT ON study_rooms
BEGIN
  INSERT INTO room_members(code, profile) VALUES (NEW.code, NEW.owner);
END;

CREATE TABLE IF NOT EXISTS room_answers (
  code TEXT NOT NULL,
  profile TEXT NOT NULL,
  question INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  PRIMARY KEY (code, profile, question),
  FOREIGN KEY (code, profile) REFERENCES room_members(code, profile) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS duel_ratings (
  profile TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1200,
  matches INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS duel_results (
  code TEXT PRIMARY KEY REFERENCES study_rooms(code) ON DELETE CASCADE,
  first_player TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  second_player TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  first_change INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS apply_duel_result AFTER INSERT ON duel_results
BEGIN
  UPDATE duel_ratings SET matches = matches + 1, rating = rating + NEW.first_change WHERE profile = NEW.first_player;
  UPDATE duel_ratings SET matches = matches + 1, rating = rating - NEW.first_change WHERE profile = NEW.second_player;
END;
