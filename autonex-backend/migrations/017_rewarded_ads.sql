CREATE TABLE rewarded_ad_sessions (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 reward_day DATE NOT NULL,
 slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5),
 mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 ad_unit TEXT NOT NULL,
 client_completed BOOLEAN NOT NULL DEFAULT FALSE,
 credited BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP+INTERVAL '1 hour',
 UNIQUE(user_id,reward_day,slot)
);
CREATE TABLE rewarded_ad_grants (
 transaction_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL UNIQUE REFERENCES rewarded_ad_sessions(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 credits INTEGER NOT NULL DEFAULT 2 CHECK(credits=2),
 mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
