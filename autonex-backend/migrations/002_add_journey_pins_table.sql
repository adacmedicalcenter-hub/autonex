-- Add Journey PINs table for arrival verification
-- Tracks PINs generated for each driver and mechanic in a journey

CREATE TABLE IF NOT EXISTS journey_pins (
  id SERIAL PRIMARY KEY,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_type VARCHAR(50) NOT NULL CHECK (user_type IN ('driver', 'mechanic')),
  pin VARCHAR(10) NOT NULL,
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'verified', 'expired', 'blocked')),
  attempt_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP,
  UNIQUE(journey_id, user_type)
);

-- Create indexes for better query performance
CREATE INDEX idx_journey_pins_journey_id ON journey_pins(journey_id);
CREATE INDEX idx_journey_pins_status ON journey_pins(status);
CREATE INDEX idx_journey_pins_expires_at ON journey_pins(expires_at);

-- Create index for cleanup queries
CREATE INDEX idx_journey_pins_cleanup ON journey_pins(expires_at) WHERE status IN ('expired', 'blocked');
