import pool from './src/database/db.js';

async function initializeDatabase() {
  try {
    console.log('Creating users table...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        user_type VARCHAR(50) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✓ Users table created successfully');
    
    // Create an index on email for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);
    
    console.log('✓ Database initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('✗ Database initialization error:', error);
    process.exit(1);
  }
}

initializeDatabase();