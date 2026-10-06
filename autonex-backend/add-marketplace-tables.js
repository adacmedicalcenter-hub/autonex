import pool from './src/database/db.js';

async function addMarketplaceTables() {
  try {
    console.log('Creating marketplace tables...');

    // Repair Requests table (drivers post their repair needs)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repair_requests (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        vehicle_type VARCHAR(100),
        location VARCHAR(255),
        status VARCHAR(50) DEFAULT 'open',
        budget_min DECIMAL(10, 2),
        budget_max DECIMAL(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_id) REFERENCES users(id)
      );
    `);
    console.log('✓ repair_requests table created');

    // Service Offers table (mechanics post their services)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_offers (
        id SERIAL PRIMARY KEY,
        mechanic_id INTEGER NOT NULL,
        service_name VARCHAR(255) NOT NULL,
        description TEXT,
        specialization VARCHAR(100),
        hourly_rate DECIMAL(10, 2),
        rating DECIMAL(3, 2) DEFAULT 0,
        reviews_count INTEGER DEFAULT 0,
        location VARCHAR(255),
        availability VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (mechanic_id) REFERENCES users(id)
      );
    `);
    console.log('✓ service_offers table created');

    // Quotes/Bids table (mechanics bid on repair requests)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id SERIAL PRIMARY KEY,
        repair_request_id INTEGER NOT NULL,
        mechanic_id INTEGER NOT NULL,
        quoted_price DECIMAL(10, 2),
        estimated_time VARCHAR(100),
        description TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (repair_request_id) REFERENCES repair_requests(id),
        FOREIGN KEY (mechanic_id) REFERENCES users(id)
      );
    `);
    console.log('✓ quotes table created');

    // Create indexes for better query performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_repair_requests_driver_id ON repair_requests(driver_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_repair_requests_status ON repair_requests(status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_service_offers_mechanic_id ON service_offers(mechanic_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quotes_repair_request_id ON quotes(repair_request_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_quotes_mechanic_id ON quotes(mechanic_id);`);

    console.log('✓ All indexes created');
    console.log('✓ Marketplace tables initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('✗ Error creating marketplace tables:', error);
    process.exit(1);
  }
}

addMarketplaceTables();