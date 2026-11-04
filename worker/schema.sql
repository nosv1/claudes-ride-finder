-- Ride Finder accounts (D1). Apply with: npx wrangler@4 d1 execute ride-finder --remote --file worker/schema.sql
-- users.id is the Google account's id ("sub"); no email or name is kept. data is the settings and road tags blob.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT, data_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS rides (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, trip TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rides_user ON rides (user_id);
CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, trip TEXT NOT NULL, name TEXT, user_id TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS links_user ON links (user_id);
-- Daily counts for the limits: k is "<kind>:<who>:<day>".
CREATE TABLE IF NOT EXISTS counts (k TEXT PRIMARY KEY, n INTEGER NOT NULL, day INTEGER NOT NULL);
