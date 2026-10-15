-- Credits are service units. Legacy FCFA wallets remain untouched for audit.
LOCK TABLE reservations, wallets IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM reservations WHERE status='reserved') THEN
  RAISE EXCEPTION 'Cancel open pilot requests/journeys before installing connection credits';
 END IF;
END $$;
CREATE TABLE connection_credit_accounts (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
 reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=balance)
);
INSERT INTO connection_credit_accounts(user_id) SELECT id FROM users;
CREATE TABLE connection_credit_grants(user_id INTEGER PRIMARY KEY REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE SEQUENCE connection_reference_seq START 10001;
ALTER TABLE journeys ADD COLUMN connection_reference TEXT UNIQUE DEFAULT ('RES-' || nextval('connection_reference_seq'));
CREATE TABLE connection_credit_reservations (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 repair_request_id INTEGER NOT NULL REFERENCES repair_requests(id), journey_id INTEGER REFERENCES journeys(id),
 reservation_type TEXT NOT NULL, fee_type TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount=10),
 status TEXT NOT NULL CHECK(status IN ('reserved','collected','released')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), collected_at TIMESTAMPTZ, released_at TIMESTAMPTZ, release_reason TEXT
);
CREATE UNIQUE INDEX credit_active_hold ON connection_credit_reservations(user_id,repair_request_id,fee_type) WHERE status IN ('reserved','collected');
CREATE TABLE connection_credit_transactions (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 connection_reference TEXT, transaction_type TEXT NOT NULL, amount INTEGER NOT NULL,
 balance_before INTEGER NOT NULL CHECK(balance_before>=0), balance_after INTEGER NOT NULL CHECK(balance_after>=0),
 source TEXT NOT NULL, reference_id TEXT NOT NULL, description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'completed' CHECK(status='completed'), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,transaction_type,reference_id),
 CHECK(balance_after=balance_before+amount)
);
CREATE TABLE connection_credit_purchases (
 reference TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), package_id TEXT NOT NULL,
 amount_xaf INTEGER NOT NULL, credits INTEGER NOT NULL, provider TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','paid','failed')), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
-- This migration is run only on the existing demo/pilot environment.
UPDATE users SET is_demo=TRUE WHERE NOT is_admin;
CREATE TABLE signup_terms_acceptances (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), version TEXT NOT NULL, role TEXT NOT NULL,
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE account_recovery_codes (
 user_id INTEGER PRIMARY KEY REFERENCES users(id), code_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 created_by INTEGER NOT NULL REFERENCES users(id), used_at TIMESTAMPTZ
);
CREATE TABLE hidden_task_history (
 user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('request','journey')),
 task_id INTEGER NOT NULL, hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,kind,task_id)
);

-- Retired backend instances must fail rather than create new monetary holds.
CREATE FUNCTION reject_retired_money_mutation() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'FCFA wallet workflow retired; use the connection-credit backend';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER retired_reservations BEFORE INSERT OR UPDATE ON reservations
 FOR EACH ROW EXECUTE FUNCTION reject_retired_money_mutation();
CREATE TRIGGER retired_wallet_updates BEFORE UPDATE ON wallets
 FOR EACH ROW EXECUTE FUNCTION reject_retired_money_mutation();
