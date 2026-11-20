-- Daily counts behind the limits that are not a count of rows: question rewrites per agent,
-- and agents started per internet address (kept as a salted hash, never the address).
CREATE TABLE IF NOT EXISTS usage_counts (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
