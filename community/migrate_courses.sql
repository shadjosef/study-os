CREATE TABLE IF NOT EXISTS community_courses (
  course_key TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  last_seen_at INTEGER NOT NULL
);
