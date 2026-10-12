-- AutoNex Initial Database Schema
-- This migration creates all required tables for the mobile app MVP

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  user_type VARCHAR(50) NOT NULL CHECK (user_type IN ('driver', 'mechanic')),
  full_name VARCHAR(255) NOT NULL,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url VARCHAR(255),
  location_latitude DECIMAL(10, 8),
  location_longitude DECIMAL(11, 8),
  is_active BOOLEAN DEFAULT TRUE,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Repair Requests table
CREATE TABLE IF NOT EXISTS repair_requests (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  vehicle_type VARCHAR(100),
  location VARCHAR(255) NOT NULL,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  budget_min INTEGER, -- FCFA (XAF) whole numbers
  budget_max INTEGER, -- FCFA (XAF) whole numbers
  status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'in_progress', 'completed', 'cancelled', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '45 minutes')
);

-- Service Offers table
CREATE TABLE IF NOT EXISTS service_offers (
  id SERIAL PRIMARY KEY,
  mechanic_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_name VARCHAR(255) NOT NULL,
  description TEXT,
  specialization VARCHAR(100),
  hourly_rate INTEGER, -- FCFA (XAF) whole numbers
  location VARCHAR(255),
  phone_number VARCHAR(20),
  availability JSON, -- { mon: [08:00-17:00], tue: [08:00-17:00], ... }
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Quotes table
CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  repair_request_id INTEGER NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  mechanic_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quoted_price INTEGER, -- FCFA (XAF) whole numbers
  estimated_time VARCHAR(100),
  description TEXT,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Conversations table for messaging
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mechanic_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repair_request_id INTEGER REFERENCES repair_requests(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(driver_id, mechanic_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_type VARCHAR(50) NOT NULL,
  sender_name VARCHAR(255),
  message_text TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wallet table - user balance tracking
CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER DEFAULT 0, -- FCFA (XAF) whole numbers
  reserved INTEGER DEFAULT 0, -- Amount reserved for active requests
  available INTEGER DEFAULT 0, -- balance - reserved
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wallet Transactions table - complete audit trail
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
    'topup', 'withdrawal', 'fee_collection', 'reservation', 'reservation_release', 'refund'
  )),
  amount INTEGER NOT NULL, -- FCFA (XAF) whole numbers, can be negative for debits
  balance_before INTEGER,
  balance_after INTEGER,
  source VARCHAR(100), -- 'mtn_momo', 'orange_money', 'test_deposit', 'journey_fee', etc.
  reference_id VARCHAR(255), -- external transaction ID, journey ID, etc.
  description TEXT,
  status VARCHAR(50) DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reservations table - track reserved funds for journeys
CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repair_request_id INTEGER NOT NULL REFERENCES repair_requests(id) ON DELETE CASCADE,
  reservation_type VARCHAR(50) NOT NULL CHECK (reservation_type IN ('connection_fee', 'service_deposit')),
  amount INTEGER NOT NULL, -- FCFA (XAF) whole numbers
  status VARCHAR(50) DEFAULT 'reserved' CHECK (status IN ('reserved', 'collected', 'released', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '45 minutes'),
  released_at TIMESTAMP,
  release_reason VARCHAR(255),
  collected_at TIMESTAMP
);

-- Journeys table - track active repair sessions
CREATE TABLE IF NOT EXISTS journeys (
  id SERIAL PRIMARY KEY,
  repair_request_id INTEGER NOT NULL UNIQUE REFERENCES repair_requests(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mechanic_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN (
    'active', 'driver_arrived', 'mechanic_arrived', 'service_started',
    'service_completed', 'cancelled', 'disputed'
  )),
  driver_arrival_latitude DECIMAL(10, 8),
  driver_arrival_longitude DECIMAL(11, 8),
  driver_arrival_time TIMESTAMP,
  driver_arrival_pin VARCHAR(10), -- 4-digit PIN for verification
  driver_pin_attempts INTEGER DEFAULT 0,
  mechanic_arrival_latitude DECIMAL(10, 8),
  mechanic_arrival_longitude DECIMAL(11, 8),
  mechanic_arrival_time TIMESTAMP,
  mechanic_arrival_pin VARCHAR(10),
  mechanic_pin_attempts INTEGER DEFAULT 0,
  connection_fee_collected BOOLEAN DEFAULT FALSE,
  connection_fee_amount INTEGER, -- FCFA (XAF)
  service_charge INTEGER, -- FCFA (XAF)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancelled_by VARCHAR(50), -- 'driver' or 'mechanic'
  cancellation_reason TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- GPS Location Tracking table
CREATE TABLE IF NOT EXISTS location_tracking (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  journey_id INTEGER REFERENCES journeys(id) ON DELETE SET NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  accuracy DECIMAL(10, 2), -- meters
  altitude DECIMAL(10, 2), -- meters
  heading DECIMAL(10, 2), -- degrees
  speed DECIMAL(10, 2), -- m/s
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Arrival Verification table - track verification attempts
CREATE TABLE IF NOT EXISTS arrival_verifications (
  id SERIAL PRIMARY KEY,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_type VARCHAR(50) NOT NULL CHECK (user_type IN ('driver', 'mechanic')),
  attempt_number INTEGER NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  accuracy DECIMAL(10, 2),
  distance_from_destination DECIMAL(10, 2), -- meters
  is_within_radius BOOLEAN,
  arrival_pin VARCHAR(10),
  pin_correct BOOLEAN,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
  verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Fee Collection Log table - audit trail for all fees
CREATE TABLE IF NOT EXISTS fee_collections (
  id SERIAL PRIMARY KEY,
  journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mechanic_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fee_type VARCHAR(50) NOT NULL CHECK (fee_type IN ('connection_fee', 'service_charge')),
  amount INTEGER NOT NULL, -- FCFA (XAF) whole numbers
  driver_verified BOOLEAN DEFAULT FALSE,
  mechanic_verified BOOLEAN DEFAULT FALSE,
  both_verified_at TIMESTAMP,
  collected_at TIMESTAMP,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'collected', 'disputed', 'refunded')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_repair_requests_driver_id ON repair_requests(driver_id);
CREATE INDEX idx_repair_requests_status ON repair_requests(status);
CREATE INDEX idx_repair_requests_created_at ON repair_requests(created_at);
CREATE INDEX idx_repair_requests_expires_at ON repair_requests(expires_at);
CREATE INDEX idx_quotes_repair_request_id ON quotes(repair_request_id);
CREATE INDEX idx_quotes_mechanic_id ON quotes(mechanic_id);
CREATE INDEX idx_quotes_status ON quotes(status);
CREATE INDEX idx_conversations_driver_id ON conversations(driver_id);
CREATE INDEX idx_conversations_mechanic_id ON conversations(mechanic_id);
CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_wallet_transactions_user_id ON wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_created_at ON wallet_transactions(created_at);
CREATE INDEX idx_reservations_user_id ON reservations(user_id);
CREATE INDEX idx_reservations_repair_request_id ON reservations(repair_request_id);
CREATE INDEX idx_reservations_status ON reservations(status);
CREATE INDEX idx_journeys_driver_id ON journeys(driver_id);
CREATE INDEX idx_journeys_mechanic_id ON journeys(mechanic_id);
CREATE INDEX idx_journeys_status ON journeys(status);
CREATE INDEX idx_location_tracking_user_id ON location_tracking(user_id);
CREATE INDEX idx_location_tracking_journey_id ON location_tracking(journey_id);
CREATE INDEX idx_location_tracking_timestamp ON location_tracking(timestamp);
CREATE INDEX idx_arrival_verifications_journey_id ON arrival_verifications(journey_id);
CREATE INDEX idx_fee_collections_journey_id ON fee_collections(journey_id);
CREATE INDEX idx_fee_collections_status ON fee_collections(status);

-- Create function to update wallet available balance
CREATE OR REPLACE FUNCTION update_wallet_available()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE wallets
  SET available = balance - reserved, last_updated = CURRENT_TIMESTAMP
  WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for wallets after reservation changes
CREATE TRIGGER trg_update_wallet_on_reservation
AFTER INSERT OR UPDATE ON reservations
FOR EACH ROW
WHEN (NEW.status IN ('reserved', 'collected', 'released'))
EXECUTE FUNCTION update_wallet_available();
