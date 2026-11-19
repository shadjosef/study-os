ALTER TABLE community_courses ADD COLUMN topics_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE community_courses ADD COLUMN ed_course_id TEXT NOT NULL DEFAULT '';
ALTER TABLE community_courses ADD COLUMN ed_host TEXT NOT NULL DEFAULT '';
ALTER TABLE community_courses ADD COLUMN contributor_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_courses ADD COLUMN sync_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE community_courses ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS community_course_contributors (
  course_key TEXT NOT NULL REFERENCES community_courses(course_key) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (course_key, profile_id)
);

CREATE TABLE IF NOT EXISTS user_timeedit_feeds (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  ics_text TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
