-- Private E2E-encrypted daily evening debrief journal (ciphertext-only in D1)
CREATE TABLE IF NOT EXISTS encrypted_journals (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, entry_date)
);
CREATE INDEX IF NOT EXISTS idx_encrypted_journals_profile_updated
  ON encrypted_journals (profile_id, updated_at DESC);
