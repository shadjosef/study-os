PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  nickname TEXT COLLATE NOCASE UNIQUE NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  nickname_changed_at INTEGER NOT NULL DEFAULT 0,
  study_minutes INTEGER NOT NULL DEFAULT 0,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  break_count INTEGER NOT NULL DEFAULT 0,
  last_break_at INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS community_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  hint TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_codes_created ON invite_codes(created_at DESC);

CREATE TABLE IF NOT EXISTS profile_sessions (
  token_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS profile_sessions_owner ON profile_sessions(profile_id, last_used_at DESC);

CREATE TABLE IF NOT EXISTS recovery_keys (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  public_key_spki TEXT NOT NULL,
  algorithm INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS passkeys_owner ON passkeys(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_exp ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS device_link_codes (
  code_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_link_codes_owner ON device_link_codes(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_backups (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_links (
  provider TEXT NOT NULL,
  provider_sub TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email_hint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_sub)
);
CREATE INDEX IF NOT EXISTS oauth_links_owner ON oauth_links(profile_id);

CREATE TABLE IF NOT EXISTS oauth_pending (
  ticket TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_sub TEXT NOT NULL,
  email_hint TEXT NOT NULL DEFAULT '',
  suggested_name TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_pending_exp ON oauth_pending(expires_at);
CREATE TABLE IF NOT EXISTS community_courses (
  course_key TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day_utc TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, day_utc)
);
