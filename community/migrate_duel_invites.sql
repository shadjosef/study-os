CREATE TABLE IF NOT EXISTS duel_invites (
  id TEXT PRIMARY KEY,
  challenger TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT 'mixed',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'started', 'expired')),
  room_code TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS duel_invites_target ON duel_invites(target, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS duel_invites_challenger ON duel_invites(challenger, status, updated_at DESC);
