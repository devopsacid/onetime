-- Bytes of all stored blobs, next to the row count. The capped insert checks both in one statement.
-- One trigger per event keeps the extra writes per create and reveal at the level of 0002.
ALTER TABLE stats ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER secrets_stats_insert AFTER INSERT ON secrets
BEGIN
  UPDATE stats SET stored = stored + 1, bytes = bytes + length(NEW.blob) WHERE id = 1;
END;
CREATE TRIGGER secrets_stats_delete AFTER DELETE ON secrets
BEGIN
  UPDATE stats SET stored = stored - 1, bytes = bytes - length(OLD.blob) WHERE id = 1;
END;
DROP TRIGGER secrets_counter_insert;
DROP TRIGGER secrets_counter_delete;
-- Between the CREATE and the DROP both trigger sets ran: an insert counts twice (over-count), but a delete
-- decrements `stored` twice (an under-count). The reset below corrects it.
-- This resets both counters exactly, also if the file did not run as one transaction.
UPDATE stats SET stored = (SELECT COUNT(*) FROM secrets),
                 bytes = (SELECT COALESCE(SUM(length(blob)), 0) FROM secrets) WHERE id = 1;
