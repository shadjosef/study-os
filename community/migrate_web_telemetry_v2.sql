-- Study-OS Rich Internal Product Analytics v2 (EU D1, cookie-free, zero IPs/PII)
-- Adds engaged active_sec and Notes-reader flag onto daily anonymous/authed visitor rows.
-- Safe to run once against existing study-os-community D1 database.

ALTER TABLE web_daily_visitors ADD COLUMN active_sec INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_daily_visitors ADD COLUMN has_notes INTEGER NOT NULL DEFAULT 0;
