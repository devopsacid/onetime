-- The number of stored rows (expired rows not yet purged included), so the capped insert reads one row
-- instead of counting the table. The seed counts what is already there; the triggers keep it exact.
CREATE TABLE stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stored INTEGER NOT NULL
);

INSERT INTO stats (id, stored) SELECT 1, COUNT(*) FROM secrets;

CREATE TRIGGER secrets_counter_insert AFTER INSERT ON secrets
BEGIN
  UPDATE stats SET stored = stored + 1 WHERE id = 1;
END;

CREATE TRIGGER secrets_counter_delete AFTER DELETE ON secrets
BEGIN
  UPDATE stats SET stored = stored - 1 WHERE id = 1;
END;
