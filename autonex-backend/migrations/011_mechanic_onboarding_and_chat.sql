-- Existing mechanics must submit a profile; existing wallet balances and journeys are preserved.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mechanic_review_status TEXT NOT NULL DEFAULT 'draft' CHECK(mechanic_review_status IN ('draft','pending','approved','rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'en' CHECK(preferred_language IN ('en','fr'));
CREATE TABLE mechanic_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, public_details JSONB NOT NULL, private_cipher TEXT NOT NULL, portrait TEXT NOT NULL, garage_photo TEXT NOT NULL, review_note TEXT NOT NULL DEFAULT '', submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMPTZ, reviewed_by INTEGER REFERENCES users(id));
UPDATE users SET availability=FALSE WHERE user_type='mechanic';
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_driver_id_mechanic_id_key;
ALTER TABLE conversations ADD COLUMN journey_id INTEGER UNIQUE REFERENCES journeys(id);
-- Unlinked legacy chats remain archived and cannot be reopened or used to send messages.
CREATE INDEX mechanic_review_idx ON users(mechanic_review_status) WHERE user_type='mechanic';
