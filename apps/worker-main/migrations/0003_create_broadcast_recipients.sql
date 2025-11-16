CREATE TABLE IF NOT EXISTS broadcast_recipients (
  chat_id TEXT PRIMARY KEY,
  username TEXT,
  language_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  active_flag INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_active
  ON broadcast_recipients (active_flag, created_at);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_language
  ON broadcast_recipients (language_code, active_flag);
