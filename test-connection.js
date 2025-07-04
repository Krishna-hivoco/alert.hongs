// test-connection.js
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function testConnection() {
  let connection;

  try {
    console.log("Testing database connection...");
    console.log(`Host: ${process.env.DB_HOST}`);
    console.log(`Port: ${process.env.DB_PORT}`);
    console.log(`User: ${process.env.DB_USER}`);
    console.log(`Database: ${process.env.DB_NAME}`);

    // Test connection without database first
    console.log("\n1. Testing connection to MySQL server...");
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

    console.log("✅ Successfully connected to MySQL server!");

    // Test database creation
    console.log("\n2. Creating database...");
    const [result] = await connection.execute(
      `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\``
    );
    console.log(
      `✅ Database '${process.env.DB_NAME}' created or already exists`
    );

    // Close connection and reconnect to the specific database
    console.log("\n3. Reconnecting to specific database...");
    await connection.end();

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    console.log(
      `✅ Successfully connected to database '${process.env.DB_NAME}'`
    );

    // Test table creation with a simple table first
    console.log("\n4. Testing table creation...");
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS test_table (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ Test table created successfully!");

    // List all tables
    console.log("\n5. Listing all tables...");
    const [tables] = await connection.query("SHOW TABLES");
    console.log("Tables in database:", tables);

    // Clean up test table
    await connection.execute("DROP TABLE IF EXISTS test_table");
    console.log("✅ Test table cleaned up");

    console.log(
      "\n🎉 All tests passed! Your database connection is working correctly."
    );
  } catch (error) {
    console.error("❌ Error during connection test:", error);

    if (error.code === "ER_ACCESS_DENIED_ERROR") {
      console.error(
        "\n💡 Solution: Check your username and password in .env file"
      );
    } else if (error.code === "ECONNREFUSED") {
      console.error("\n💡 Solution: Make sure MySQL server is running");
    } else if (error.code === "ER_BAD_DB_ERROR") {
      console.error(
        "\n💡 Solution: Database doesn't exist, but we'll create it"
      );
    }
  } finally {
    if (connection) {
      await connection.end();
      console.log("\n🔌 Connection closed");
    }
  }
}

testConnection();
