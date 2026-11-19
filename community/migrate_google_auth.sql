PRAGMA foreign_keys = ON;

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
