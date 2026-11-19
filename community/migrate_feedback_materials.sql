CREATE TABLE IF NOT EXISTS user_feedback (
  id TEXT PRIMARY KEY,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  nickname TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'idea',
  message TEXT NOT NULL,
  page_context TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_feedback_created ON user_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS user_feedback_owner ON user_feedback(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_materials (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_code TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_materials_owner ON user_materials(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_material_chunks (
  material_id TEXT NOT NULL REFERENCES user_materials(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  PRIMARY KEY (material_id, chunk_index)
);
