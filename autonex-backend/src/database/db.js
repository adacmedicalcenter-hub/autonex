import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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