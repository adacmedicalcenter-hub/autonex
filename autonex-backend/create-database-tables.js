#!/usr/bin/env node

/**
 * Create all database tables for AutoNex
 * Run this ONCE to set up your PostgreSQL database schema
 */

import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`
});

async function createTables() {
  const client = await pool.connect();
  try {
    console.log('📦 Creating AutoNex database schema...\n');

    // Users table
    console.log('Creating users table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_type VARCHAR(50) NOT NULL CHECK (user_type IN ('driver', 'mechanic')),
        full_name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ users table created');

    // Repair Requests table
    console.log('Creating repair_requests table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS repair_requests (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER NOT NULL REFERENCES users(id),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        vehicle_type VARCHAR(100),
        location VARCHAR(255),
        budget_min DECIMAL(10, 2),
        budget_max DECIMAL(10, 2),
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ repair_requests table created');

    // Service Offers table
    console.log('Creating service_offers table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_offers (
        id SERIAL PRIMARY KEY,
        mechanic_id INTEGER NOT NULL REFERENCES users(id),
        service_name VARCHAR(255) NOT NULL,
        description TEXT,
        specialization VARCHAR(255),
        hourly_rate DECIMAL(10, 2),
        location VARCHAR(255),
        phone_number VARCHAR(20),
        availability VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ service_offers table created');

    // Quotes table
    console.log('Creating quotes table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        repair_request_id INTEGER NOT NULL REFERENCES repair_requests(id),
        mechanic_id INTEGER NOT NULL REFERENCES users(id),
        quoted_price DECIMAL(10, 2),
        estimated_time VARCHAR(100),
        description TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ quotes table created');

    // Conversations table
    console.log('Creating conversations table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER NOT NULL REFERENCES users(id),
        mechanic_id INTEGER NOT NULL REFERENCES users(id),
        repair_request_id INTEGER REFERENCES repair_requests(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ conversations table created');

    // Messages table
    console.log('Creating messages table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id),
        sender_id INTEGER NOT NULL REFERENCES users(id),
        sender_type VARCHAR(50) NOT NULL CHECK (sender_type IN ('driver', 'mechanic')),
        message_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ messages table created');

    // Create indexes for better performance
    console.log('\nCreating indexes...');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_repair_requests_driver ON repair_requests(driver_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_service_offers_mechanic ON service_offers(mechanic_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quotes_mechanic ON quotes(mechanic_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_driver ON conversations(driver_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);`);
    console.log('✅ Indexes created');

    console.log('\n🎉 Database schema created successfully!\n');
    console.log('Tables created:');
    console.log('  ✓ users');
    console.log('  ✓ repair_requests');
    console.log('  ✓ service_offers');
    console.log('  ✓ quotes');
    console.log('  ✓ conversations');
    console.log('  ✓ messages');

  } catch (error) {
    console.error('❌ Error creating tables:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
}

createTables();
