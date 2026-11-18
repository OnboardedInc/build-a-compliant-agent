-- A visitor who is building an agent. `token` is the browser's credential.
CREATE TABLE IF NOT EXISTS builders (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  company       TEXT NOT NULL,
  website       TEXT NOT NULL,
  brand         TEXT NOT NULL DEFAULT '{}',
  verify_token  TEXT,
  verify_sent_at TEXT,
  verified_at   TEXT,
  description   TEXT,
  job_title     TEXT,
  questions     TEXT NOT NULL DEFAULT '[]',
  agent_name    TEXT,
  agent_face    INTEGER,
  built_at      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_builders_email ON builders(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_builders_verify ON builders(verify_token);

-- One call from screening to the last form. Four JSON columns, one kind of writer each
-- (base, work, transcript, hire), so the webhook and the browser never overwrite each other.
CREATE TABLE IF NOT EXISTS interview_sessions (
  id          TEXT PRIMARY KEY,
  builder_id  TEXT NOT NULL REFERENCES builders(id),
  status      TEXT NOT NULL DEFAULT 'idle',
  tool_secret TEXT NOT NULL,
  link_token  TEXT NOT NULL,
  base        TEXT NOT NULL,
  work        TEXT NOT NULL,
  transcript  TEXT NOT NULL DEFAULT '[]',
  hire        TEXT,
  call        TEXT NOT NULL,
  api_log     TEXT NOT NULL DEFAULT '[]',
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_builder ON interview_sessions(builder_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_link ON interview_sessions(link_token);

-- Small values the Worker keeps: the public address for Vapi's webhooks in local dev, Vapi's org id.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
