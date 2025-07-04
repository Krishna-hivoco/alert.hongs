// database.js - Fixed version
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  // Important: These settings help with the prepared statement issues
  namedPlaceholders: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Test the pool connection
async function testPool() {
  try {
    const connection = await pool.getConnection();
    console.log("✅ Database pool connected successfully");
    connection.release();
  } catch (error) {
    console.error("❌ Database pool connection failed:", error);
  }
}

// Export pool and test function
export default pool;
export { testPool };
