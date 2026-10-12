-- Two hours from publication; do not reopen cancelled/expired/selected requests.
ALTER TABLE repair_requests ALTER COLUMN expires_at SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '2 hours');
UPDATE repair_requests SET expires_at=created_at+INTERVAL '2 hours'
WHERE status='open' AND expires_at>CURRENT_TIMESTAMP;
