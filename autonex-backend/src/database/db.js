import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

export async function initializeDatabase() {
  try {
    await pool.query("SELECT NOW()");
    console.log("Database initialized");
  } catch (error) {
    console.error("Database error:", error);
  }
}

export default pool;