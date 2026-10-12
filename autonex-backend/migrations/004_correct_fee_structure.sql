-- Correct Fee Configuration for AutoNex
-- Created: October 9, 2026
-- NOTE: Platform uses ONE connection fee per participant (driver and mechanic)
-- Reserved BEFORE action (driver before posting, mechanic before accepting)
-- Collected ONLY after GPS arrival verification AND driver PIN entry
-- NO separate arrival fees or cancellation penalties
-- Released on cancellation or expiry before arrival

-- Delete any incorrect fee configuration from previous migrations
DELETE FROM admin_config WHERE config_key LIKE 'fee_%' OR config_key LIKE 'arrival_%' OR config_key LIKE 'cancellation_%';

-- Insert correct connection fee configuration (test values only - not approved for production)
INSERT INTO admin_config (config_key, config_value, description)
VALUES
  ('connection_fee_driver', '1000', '[TEST] Driver connection fee in FCFA when posting a repair request - RESERVED before posting, COLLECTED after arrival verification'),
  ('connection_fee_mechanic', '1000', '[TEST] Mechanic connection fee in FCFA when accepting a request - RESERVED before accepting, COLLECTED after arrival verification'),
  ('connection_fee_currency', 'FCFA', 'Currency for all fees'),
  ('environment', 'TEST', 'AutoNex test environment - all fees are simulated, do NOT enable live payments')
ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, description = EXCLUDED.description;

-- Ensure admin_config table exists
CREATE TABLE IF NOT EXISTS admin_config (
  config_key VARCHAR(100) PRIMARY KEY,
  config_value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_admin_config_key ON admin_config(config_key);

-- Add columns to journeys table to track fee reservations (if not exist)
ALTER TABLE journeys
ADD COLUMN IF NOT EXISTS driver_fee_reserved BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS driver_fee_reserved_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS mechanic_fee_reserved BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS mechanic_fee_reserved_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS both_fees_collected BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS both_fees_collected_at TIMESTAMP;

-- Create or update fee_log table for detailed tracking of all fee operations
CREATE TABLE IF NOT EXISTS fee_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_id INTEGER REFERENCES journeys(id) ON DELETE SET NULL,
  operation VARCHAR(50) NOT NULL CHECK (operation IN ('reserve', 'collect', 'release')),
  fee_type VARCHAR(50) NOT NULL, -- 'connection_fee_driver' or 'connection_fee_mechanic'
  amount INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- Create indexes for fee_log
CREATE INDEX IF NOT EXISTS idx_fee_log_user_id ON fee_log(user_id);
CREATE INDEX IF NOT EXISTS idx_fee_log_journey_id ON fee_log(journey_id);
CREATE INDEX IF NOT EXISTS idx_fee_log_operation ON fee_log(operation);
CREATE INDEX IF NOT EXISTS idx_fee_log_status ON fee_log(status);
CREATE INDEX IF NOT EXISTS idx_fee_log_created_at ON fee_log(created_at);

-- Add comment to clarify fee structure
COMMENT ON TABLE fee_log IS 'Audit trail for all fee operations (reserve, collect, release). One connection fee per participant: driver reserves when posting, mechanic reserves when accepting. Both collected together after verified GPS arrival AND driver PIN entry. Released on cancellation or expiry before arrival.';
