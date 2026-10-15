CREATE TABLE sms_recovery_requests (
 id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, user_id INTEGER REFERENCES users(id),
 auth_version INTEGER, verification_sid TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+INTERVAL '10 minutes', attempts INTEGER NOT NULL DEFAULT 0,
 used_at TIMESTAMPTZ
);
CREATE INDEX sms_recovery_phone_created ON sms_recovery_requests(phone_hash,created_at);
