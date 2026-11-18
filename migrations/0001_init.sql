-- expires_at is milliseconds since the epoch.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  blob BLOB NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX secrets_expires_at ON secrets (expires_at);
