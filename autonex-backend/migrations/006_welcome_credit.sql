-- One grant per account, including existing pilot users. Wallet credit is not cash revenue.
CREATE TABLE IF NOT EXISTS welcome_credit_grants (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 amount INTEGER NOT NULL CHECK(amount=10000),
 granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO wallets(user_id) SELECT id FROM users WHERE user_type IN ('driver','mechanic') ON CONFLICT(user_id) DO NOTHING;
WITH grants AS (
 INSERT INTO welcome_credit_grants(user_id,amount)
 SELECT id,10000 FROM users WHERE user_type IN ('driver','mechanic')
 ON CONFLICT(user_id) DO NOTHING RETURNING user_id,amount
), credited AS (
 UPDATE wallets w SET balance=w.balance+g.amount FROM grants g WHERE w.user_id=g.user_id
 RETURNING w.user_id,w.balance-10000 AS before_balance,w.balance AS after_balance
)
INSERT INTO wallet_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description)
SELECT user_id,'topup',10000,before_balance,after_balance,'welcome_credit','welcome_'||user_id,'One-time nonwithdrawable AutoNex welcome credit' FROM credited;
