-- Preserve existing ledger and balances; lower future one-time grants only.
ALTER TABLE welcome_credit_grants DROP CONSTRAINT IF EXISTS welcome_credit_grants_amount_check;
ALTER TABLE welcome_credit_grants ADD CONSTRAINT welcome_credit_grants_amount_check CHECK(amount IN (1000,2000,10000));
INSERT INTO admin_config(config_key,config_value) VALUES('welcome_credit_amount','2000')
ON CONFLICT(config_key) DO UPDATE SET config_value=EXCLUDED.config_value;
