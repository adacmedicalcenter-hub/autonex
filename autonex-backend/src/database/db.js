import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();
// Legacy SQL timestamp columns are interpreted as UTC on every host.
process.env.TZ = "UTC";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c timezone=UTC",
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