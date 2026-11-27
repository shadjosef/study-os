-- First-party, cookie-free, privacy-preserving web traffic & funnel aggregates (EU D1).
-- Zero IP addresses, zero persistent identifiers, daily-rotating cryptographic visitor hashes (90-day retention).

CREATE TABLE IF NOT EXISTS web_daily_visitors (
  day_oslo TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT 'desktop',
  auth_state TEXT NOT NULL DEFAULT 'anon' CHECK (auth_state IN ('anon', 'authed')),
  first_path TEXT NOT NULL DEFAULT '/',
  referrer_host TEXT NOT NULL DEFAULT 'direct',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 1,
  has_run INTEGER NOT NULL DEFAULT 0,
  has_attempt INTEGER NOT NULL DEFAULT 0,
  has_auth_open INTEGER NOT NULL DEFAULT 0,
  has_signup INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_oslo, visitor_hash)
);
CREATE INDEX IF NOT EXISTS web_daily_visitors_day ON web_daily_visitors(day_oslo, auth_state);

CREATE TABLE IF NOT EXISTS web_daily_events (
  day_oslo TEXT NOT NULL,
  event TEXT NOT NULL,
  dim TEXT NOT NULL DEFAULT '',
  auth_state TEXT NOT NULL DEFAULT 'anon' CHECK (auth_state IN ('anon', 'authed')),
  count INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (day_oslo, event, dim, auth_state)
);
CREATE INDEX IF NOT EXISTS web_daily_events_day ON web_daily_events(day_oslo, event);
