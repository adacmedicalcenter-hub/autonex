const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function createChatTables() {
  const client = await pool.connect();
  try {
    console.log('Creating chat tables...');
    await client.query(`CREATE TABLE IF NOT EXISTS conversations (id SERIAL PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, mechanic_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, repair_request_id INTEGER REFERENCES repair_requests(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(driver_id, mechanic_id));`);
    console.log('✓ conversations table created');
    await client.query(`CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, sender_type VARCHAR(50), message_text TEXT NOT NULL, is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    console.log('✓ messages table created');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_driver_id ON conversations(driver_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_conversations_mechanic_id ON conversations(mechanic_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);`);
    console.log('✓ Indexes created for performance');
    console.log('\n✅ Chat tables created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error creating tables:', error.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

createChatTables();