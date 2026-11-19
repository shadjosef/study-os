-- Migration for existing study-os-community D1 databases to support PFPs, bios, 30-day nickname edits, and break tracking.
ALTER TABLE profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN nickname_changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN break_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN break_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN last_break_at INTEGER NOT NULL DEFAULT 0;
