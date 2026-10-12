-- Add admin features to database
-- Created: October 8, 2026

-- Add admin and suspension columns to users table
ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS suspend_reason TEXT,
ADD COLUMN IF NOT EXISTS suspend_until TIMESTAMP;

-- Create admin configuration table
CREATE TABLE IF NOT EXISTS admin_config (
  id SERIAL PRIMARY KEY,
  config_key VARCHAR(255) UNIQUE NOT NULL,
  config_value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create disputes table
CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  raised_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  description TEXT,
  status VARCHAR(50) DEFAULT 'open', -- open, in_review, resolved
  resolution VARCHAR(50), -- driver_win, mechanic_win, split
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create ratings table (for mechanic ratings)
CREATE TABLE IF NOT EXISTS ratings (
  id SERIAL PRIMARY KEY,
  journey_id INTEGER REFERENCES journeys(id) ON DELETE CASCADE,
  rater_id INTEGER NOT NULL REFERENCES users(id),
  rated_user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_disputes_journey ON disputes(journey_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_created_at ON disputes(created_at);
CREATE INDEX IF NOT EXISTS idx_ratings_journey ON ratings(journey_id);
CREATE INDEX IF NOT EXISTS idx_ratings_rated_user ON ratings(rated_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_config_key ON admin_config(config_key);

-- Insert default fee configuration
INSERT INTO admin_config (config_key, config_value, description)
VALUES
  ('fee_platform_percentage', '10', 'Platform takes 10% of each transaction'),
  ('fee_minimum_amount', '500', 'Minimum fee in FCFA'),
  ('fee_maximum_percentage', '25', 'Maximum platform fee percentage'),
  ('fee_cancellation', '1000', 'Cancellation fee in FCFA')
ON CONFLICT (config_key) DO NOTHING;

-- Add is_admin flag to first user (for initial admin access)
-- Uncomment and modify as needed:
-- UPDATE users SET is_admin = TRUE WHERE id = 1;
