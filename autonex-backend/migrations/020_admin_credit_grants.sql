CREATE TABLE admin_credit_grants (
 reference TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 admin_id INTEGER NOT NULL REFERENCES users(id),
 credits INTEGER NOT NULL CHECK(credits BETWEEN 1 AND 10000),
 reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
