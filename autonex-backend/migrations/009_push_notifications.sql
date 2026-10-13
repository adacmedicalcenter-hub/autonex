CREATE TABLE push_devices (
 installation_id UUID PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token TEXT NOT NULL UNIQUE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX push_devices_user ON push_devices(user_id);
CREATE TABLE push_outbox (
 id BIGSERIAL PRIMARY KEY,
 event_key TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 installation_id UUID NOT NULL REFERENCES push_devices(installation_id) ON DELETE CASCADE,
 repair_request_id INTEGER REFERENCES repair_requests(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('request','test')),
 expires_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_error TEXT,
 sent_at TIMESTAMPTZ,
 UNIQUE(event_key,installation_id)
);
CREATE INDEX push_outbox_pending ON push_outbox(next_attempt_at) WHERE status='pending';
