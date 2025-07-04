// setup-database.js (improved version)
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { pathToFileURL } from "url";
dotenv.config();

async function setupDatabase() {
  let connection;

  try {
    console.log("🚀 Starting database setup...");
    console.log(`Host: ${process.env.DB_HOST}`);
    console.log(`Port: ${process.env.DB_PORT}`);
    console.log(`User: ${process.env.DB_USER}`);
    console.log(`Database: ${process.env.DB_NAME}`);

    // Validate environment variables
    if (
      !process.env.DB_HOST ||
      !process.env.DB_USER ||
      !process.env.DB_PASSWORD ||
      !process.env.DB_NAME
    ) {
      throw new Error(
        "Missing required environment variables. Check your .env file."
      );
    }

    // First connect without database to create it
    console.log("\n1. Connecting to MySQL server...");
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    console.log("✅ Connected to MySQL server");

    // Create database if it doesn't exist
    console.log("\n2. Creating database...");
    await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``
    );
    console.log(
      `✅ Database '${process.env.DB_NAME}' created or already exists`
    );

    // Close and reconnect to the specific database
    console.log("\n3. Reconnecting to specific database...");
    await connection.end();

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    console.log(`✅ Connected to database '${process.env.DB_NAME}'`);

    // Create stores table
    console.log("\n4. Creating 'stores' table...");
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS stores (
        store_id VARCHAR(50) PRIMARY KEY,
        store_name VARCHAR(255),
        last_heartbeat DATETIME,
        status ENUM('online', 'offline', 'unknown') DEFAULT 'unknown',
        last_alert_sent DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ 'stores' table created");

    // Create heartbeat_history table
    console.log("\n5. Creating 'heartbeat_history' table...");
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS heartbeat_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id VARCHAR(50),
        timestamp DATETIME,
        cpu_usage DECIMAL(5,2),
        memory_usage DECIMAL(5,2),
        disk_free_gb DECIMAL(10,2),
        active_cameras INT,
        total_cameras INT,
        network_connected BOOLEAN,
        payload JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
        INDEX idx_store_timestamp (store_id, timestamp),
        INDEX idx_timestamp (timestamp)
      )
    `);
    console.log("✅ 'heartbeat_history' table created");

    // Create alerts table
    console.log("\n6. Creating 'alerts' table...");
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id VARCHAR(50),
        alert_type ENUM('offline', 'system_warning', 'camera_failure', 'test') DEFAULT 'offline',
        message TEXT,
        severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
        resolved BOOLEAN DEFAULT FALSE,
        resolved_at DATETIME NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
        INDEX idx_store_timestamp (store_id, timestamp),
        INDEX idx_resolved (resolved)
      )
    `);
    console.log("✅ 'alerts' table created");

    // Create system_stats table for detailed monitoring
    console.log("\n7. Creating 'system_stats' table...");
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS system_stats (
        id INT AUTO_INCREMENT PRIMARY KEY,
        store_id VARCHAR(50),
        timestamp DATETIME,
        cpu_usage DECIMAL(5,2),
        memory_usage DECIMAL(5,2),
        memory_available_gb DECIMAL(10,2),
        disk_free_gb DECIMAL(10,2),
        disk_usage_percent DECIMAL(5,2),
        process_memory_mb DECIMAL(10,2),
        uptime_hours DECIMAL(10,2),
        network_connected BOOLEAN,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
        INDEX idx_store_timestamp (store_id, timestamp)
      )
    `);
    console.log("✅ 'system_stats' table created");

    // Verify all tables were created
    console.log("\n8. Verifying tables...");
    const [tables] = await connection.query("SHOW TABLES");
    console.log("📊 Tables in database:");
    tables.forEach((table) => {
      console.log(`  - ${Object.values(table)[0]}`);
    });

    // Show table structures for verification
    console.log("\n9. Verifying table structures...");
    const tableNames = [
      "stores",
      "heartbeat_history",
      "alerts",
      "system_stats",
    ];

    for (const tableName of tableNames) {
      console.log(`\n📋 Structure of '${tableName}' table:`);
      const [columns] = await connection.query(`DESCRIBE ${tableName}`);
      columns.forEach((column) => {
        console.log(
          `  ${column.Field}: ${column.Type} ${
            column.Key ? "(" + column.Key + ")" : ""
          }`
        );
      });
    }

    console.log("\n🎉 All tables created successfully!");
  } catch (error) {
    console.error("\n❌ Error setting up database:", error);

    // Provide specific error solutions
    if (error.code === "ER_ACCESS_DENIED_ERROR") {
      console.error(
        "\n💡 Solution: Check your MySQL username and password in .env file"
      );
    } else if (error.code === "ECONNREFUSED") {
      console.error("\n💡 Solution: Make sure MySQL server is running:");
      console.error("   - Windows: net start mysql");
      console.error("   - Linux/Mac: sudo systemctl start mysql");
    } else if (error.code === "ER_BAD_DB_ERROR") {
      console.error(
        "\n💡 Solution: Database access issue - check your MySQL permissions"
      );
    } else if (error.code === "ENOTFOUND") {
      console.error(
        "\n💡 Solution: Check your DB_HOST in .env file (should be 'localhost' for local MySQL)"
      );
    }
  } finally {
    if (connection) {
      await connection.end();
      console.log("\n🔌 Database connection closed");
    }
  }
}

// Manual table creation function (backup method)
async function createTablesManually() {
  console.log("🔧 Creating tables manually...");

  const sqlCommands = [
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\`;`,
    `USE \`${process.env.DB_NAME}\`;`,
    `CREATE TABLE IF NOT EXISTS stores (
      store_id VARCHAR(50) PRIMARY KEY,
      store_name VARCHAR(255),
      last_heartbeat DATETIME,
      status ENUM('online', 'offline', 'unknown') DEFAULT 'unknown',
      last_alert_sent DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS heartbeat_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id VARCHAR(50),
      timestamp DATETIME,
      cpu_usage DECIMAL(5,2),
      memory_usage DECIMAL(5,2),
      disk_free_gb DECIMAL(10,2),
      active_cameras INT,
      total_cameras INT,
      network_connected BOOLEAN,
      payload JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
      INDEX idx_store_timestamp (store_id, timestamp),
      INDEX idx_timestamp (timestamp)
    );`,
    `CREATE TABLE IF NOT EXISTS alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id VARCHAR(50),
      alert_type ENUM('offline', 'system_warning', 'camera_failure', 'test') DEFAULT 'offline',
      message TEXT,
      severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      resolved BOOLEAN DEFAULT FALSE,
      resolved_at DATETIME NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
      INDEX idx_store_timestamp (store_id, timestamp),
      INDEX idx_resolved (resolved)
    );`,
    `CREATE TABLE IF NOT EXISTS system_stats (
      id INT AUTO_INCREMENT PRIMARY KEY,
      store_id VARCHAR(50),
      timestamp DATETIME,
      cpu_usage DECIMAL(5,2),
      memory_usage DECIMAL(5,2),
      memory_available_gb DECIMAL(10,2),
      disk_free_gb DECIMAL(10,2),
      disk_usage_percent DECIMAL(5,2),
      process_memory_mb DECIMAL(10,2),
      uptime_hours DECIMAL(10,2),
      network_connected BOOLEAN,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (store_id) REFERENCES stores(store_id) ON DELETE CASCADE,
      INDEX idx_store_timestamp (store_id, timestamp)
    );`,
  ];

  console.log("\n📋 SQL Commands to run manually:");
  console.log("Copy and paste these into your MySQL command line:\n");
  sqlCommands.forEach((cmd, index) => {
    console.log(`-- Command ${index + 1}`);
    console.log(cmd);
    console.log("");
  });
}

console.log("import.meta.url", import.meta.url);
console.log("import.meta.url2", `file://${process.argv[1]}`);
console.log(import.meta.url === pathToFileURL(process.argv[1]).href);
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Check if user wants manual SQL output
  if (process.argv.includes("--manual")) {
    createTablesManually();
  } else {
    setupDatabase();
  }
}

export { setupDatabase };
