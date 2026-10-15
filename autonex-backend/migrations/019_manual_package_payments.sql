CREATE TABLE manual_package_orders (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), client_key TEXT NOT NULL,
 package_id TEXT NOT NULL, amount_xaf INTEGER NOT NULL CHECK(amount_xaf>0), credits INTEGER NOT NULL CHECK(credits>0),
 method TEXT NOT NULL CHECK(method IN ('mtn_momo','orange_money','bank_transfer')),
 status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK(status IN ('awaiting_payment','submitted','approved','rejected')),
 customer_reference TEXT, provider_reference TEXT, review_note TEXT, reviewed_by INTEGER REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), submitted_at TIMESTAMPTZ, reviewed_at TIMESTAMPTZ,
 UNIQUE(user_id,client_key), UNIQUE(method,provider_reference)
);
