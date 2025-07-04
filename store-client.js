import axios from "axios";
import mysql from "mysql2/promise";
import si from "systeminformation";
import dotenv from "dotenv";
import { pathToFileURL } from "url";

dotenv.config();

class StoreHeartbeatClient {
  constructor(config) {
    this.storeId = config.storeId;
    this.storeName = config.storeName || this.storeId;
    this.monitoringServerUrl = config.monitoringServerUrl.replace(/\/$/, "");
    this.heartbeatInterval = config.heartbeatInterval || 300000; // 5 minutes in ms
    this.running = false;
    this.intervalId = null;
    this.cleanupIntervalId = null;
    this.isFirstHeartbeat = true;

    // Performance tracking
    this.lastDetectionTime = new Date();
    this.totalDetections = 0;

    // Connection status tracking
    this.consecutiveFailures = 0;
    this.lastSuccessfulConnection = null;

    // Network speed tracking
    this.lastNetworkSpeed = null;
    this.networkSpeedHistory = [];

    // Initialize local database for offline storage
    this.initLocalDatabase();

    console.log(
      `🏪 Heartbeat client initialized for store: ${this.storeId} (${this.storeName})`
    );
  }

  async initLocalDatabase() {
    try {
      this.localDb = await mysql.createConnection({
        host: "localhost",
        user: "root",
        password: "root",
        database: "hongs_data",
      });
      // this.localDb = await mysql.createConnection({
      //   host: process.env.DB_HOST,
      //   user: process.env.DB_USER,
      //   password: process.env.DB_PASSWORD,
      //   database: process.env.DB_NAME,
      // });

      await this.localDb.execute(`
        CREATE TABLE IF NOT EXISTS heartbeat_buffer (
          id INT AUTO_INCREMENT PRIMARY KEY,
          timestamp DATETIME,
          data JSON,
          sent BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      console.log("📁 Local database connection initialized");
    } catch (error) {
      console.error("❌ Failed to initialize local database:", error);
      console.log("💾 Falling back to memory storage for buffering");
      this.heartbeatBuffer = [];
    }
  }

  // NEW: Measure network speed
  async measureNetworkSpeed() {
    try {
      console.log("🌐 Measuring network speed...");

      // Test URLs with different sizes
      const testUrls = [
        {
          url: "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png",
          size: 13000,
        }, // ~13KB
        {
          url: "https://httpbin.org/drip?duration=1&numbytes=100000",
          size: 100000,
        }, // 100KB
      ];

      const speeds = [];

      for (const test of testUrls) {
        try {
          const startTime = Date.now();
          const response = await axios.get(test.url, {
            timeout: 10000,
            responseType: "arraybuffer",
          });
          const endTime = Date.now();

          const duration = (endTime - startTime) / 1000; // seconds
          const actualSize = response.data.byteLength;
          const speedBps = actualSize / duration; // bytes per second
          const speedMbps = (speedBps * 8) / (1024 * 1024); // Mbps

          speeds.push(speedMbps);
          console.log(
            `   📊 Test ${test.url.split("/").pop()}: ${speedMbps.toFixed(
              2
            )} Mbps`
          );
        } catch (error) {
          console.log(
            `   ❌ Speed test failed for ${test.url}: ${error.message}`
          );
        }
      }

      if (speeds.length > 0) {
        const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
        this.lastNetworkSpeed = Math.round(avgSpeed * 100) / 100; // Round to 2 decimal places

        // Keep history of last 5 measurements
        this.networkSpeedHistory.push({
          speed: this.lastNetworkSpeed,
          timestamp: new Date().toISOString(),
        });
        if (this.networkSpeedHistory.length > 5) {
          this.networkSpeedHistory.shift();
        }

        console.log(`🚀 Network speed: ${this.lastNetworkSpeed} Mbps`);
        return this.lastNetworkSpeed;
      } else {
        console.log("⚠️ No successful speed tests");
        return null;
      }
    } catch (error) {
      console.error("❌ Network speed measurement failed:", error.message);
      return null;
    }
  }

  async getSystemStats() {
    try {
      const [cpu, memory, fsSize, networkInterfaces] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
        si.networkInterfaces(),
      ]);

      // Get disk info for main drive
      const mainDisk =
        fsSize.find((disk) => disk.mount === "/" || disk.mount === "C:") ||
        fsSize[0];

      // Check network connectivity
      const networkConnected = await this.checkInternetConnection();

      // Measure network speed (but not on every heartbeat to avoid overhead)
      let networkSpeed = this.lastNetworkSpeed;
      if (!networkSpeed || this.isFirstHeartbeat) {
        networkSpeed = await this.measureNetworkSpeed();
      }

      // Get process memory
      const processMemory = process.memoryUsage();

      return {
        cpu_usage_percent: Math.round(cpu.currentLoad * 100) / 100,
        memory_usage_percent:
          Math.round((memory.used / memory.total) * 100 * 100) / 100,
        memory_available_gb:
          Math.round((memory.available / 1024 ** 3) * 100) / 100,
        disk_free_gb: mainDisk
          ? Math.round((mainDisk.available / 1024 ** 3) * 100) / 100
          : 0,
        disk_usage_percent: mainDisk
          ? Math.round(
              ((mainDisk.size - mainDisk.available) / mainDisk.size) * 100 * 100
            ) / 100
          : 0,
        network_connected: networkConnected,
        network_speed_mbps: networkSpeed, // NEW: Network speed
        process_memory_mb:
          Math.round((processMemory.rss / 1024 / 1024) * 100) / 100,
        uptime_hours: Math.round((process.uptime() / 3600) * 100) / 100,
      };
    } catch (error) {
      console.error("❌ Failed to get system stats:", error);
      return {};
    }
  }

  async checkCamerasStatus() {
    try {
      const cameraStatus = {};
      let activeCameras = 0;

      // Mock camera check - replace with your actual OpenCV/camera logic
      for (let i = 0; i < 4; i++) {
        const isActive = Math.random() > 0.1; // 90% chance camera is active

        if (isActive) {
          cameraStatus[`camera_${i}`] = {
            active: true,
            resolution: "1920x1080",
            last_frame_time: new Date().toISOString(),
          };
          activeCameras++;
        } else {
          cameraStatus[`camera_${i}`] = {
            active: false,
            error: "No frame captured",
          };
        }
      }

      return {
        total_cameras: Object.keys(cameraStatus).length,
        active_cameras: activeCameras,
        cameras: cameraStatus,
      };
    } catch (error) {
      console.error("❌ Error checking cameras:", error);
      return {
        total_cameras: 0,
        active_cameras: 0,
        cameras: {},
      };
    }
  }

  async checkInternetConnection() {
    try {
      const testUrls = [
        "http://www.google.com",
        "http://www.cloudflare.com",
        this.monitoringServerUrl + "/health",
      ];

      for (const url of testUrls) {
        try {
          const response = await axios.get(url, { timeout: 3000 });
          if (response.status === 200) {
            return true;
          }
        } catch (error) {
          continue;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  async createHeartbeatPayload() {
    const timestamp = new Date().toISOString();

    const [systemStats, cameraStatus] = await Promise.all([
      this.getSystemStats(),
      this.checkCamerasStatus(),
    ]);

    return {
      store_id: this.storeId,
      store_name: this.storeName,
      timestamp: timestamp,
      status: "running",
      system_stats: systemStats,
      camera_status: cameraStatus,
      application_stats: {
        last_detection_time: this.lastDetectionTime.toISOString(),
        total_detections_today: this.totalDetections,
        application_version: "1.0.0",
        node_version: process.version,
        consecutive_failures: this.consecutiveFailures,
        last_successful_connection: this.lastSuccessfulConnection,
      },
      location_info: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        local_time: new Date().toLocaleTimeString(),
      },
      network_info: {
        current_speed_mbps: this.lastNetworkSpeed,
        speed_history: this.networkSpeedHistory,
        last_speed_test:
          this.networkSpeedHistory.length > 0
            ? this.networkSpeedHistory[this.networkSpeedHistory.length - 1]
                .timestamp
            : null,
      },
      is_startup: this.isFirstHeartbeat,
    };
  }

  async sendHeartbeat() {
    try {
      const payload = await this.createHeartbeatPayload();

      const response = await axios.post(
        `${this.monitoringServerUrl}/heartbeat`,
        payload,
        {
          timeout: 10000,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `Store-Monitor-${this.storeId}`,
          },
        }
      );

      if (response.status === 200) {
        this.consecutiveFailures = 0;
        this.lastSuccessfulConnection = new Date().toISOString();

        if (this.isFirstHeartbeat) {
          console.log(
            `🚀 First heartbeat sent successfully for store ${this.storeId} - Server notified of startup`
          );
          console.log(
            `📊 Network speed: ${this.lastNetworkSpeed || "Unknown"} Mbps`
          );
          this.isFirstHeartbeat = false;
        } else {
          console.log(
            `✅ Heartbeat sent successfully for store ${this.storeId}`
          );
        }

        await this.sendBufferedHeartbeats();
        return true;
      } else {
        console.warn(
          `⚠️ Heartbeat failed with status code: ${response.status}`
        );
        this.consecutiveFailures++;
        await this.storeHeartbeatLocally(payload);
        return false;
      }
    } catch (error) {
      this.consecutiveFailures++;
      console.error(
        `❌ Failed to send heartbeat (attempt #${this.consecutiveFailures}): ${error.message}`
      );

      if (error.code === "ECONNREFUSED") {
        console.error(`   Connection refused - monitoring server may be down`);
      } else if (error.code === "ETIMEDOUT") {
        console.error(`   Request timeout - server may be slow or unreachable`);
      } else if (error.response) {
        console.error(
          `   Server responded with ${error.response.status}: ${error.response.statusText}`
        );
      }

      const payload = await this.createHeartbeatPayload();
      await this.storeHeartbeatLocally(payload);
      return false;
    }
  }

  async storeHeartbeatLocally(payload) {
    try {
      const now = new Date();
      const mysqlTimestamp = now.toISOString().slice(0, 19).replace("T", " ");
      // Results in: "2025-07-03 12:49:31"

      if (this.localDb) {
        await this.localDb.execute(
          "INSERT INTO heartbeat_buffer (timestamp, data) VALUES (?, ?)",
          [mysqlTimestamp, JSON.stringify(payload)]
        );
        console.log(
          `💾 Heartbeat stored locally in database (${payload.store_id})`
        );
      } else {
        this.heartbeatBuffer = this.heartbeatBuffer || [];
        this.heartbeatBuffer.push({
          id: Date.now(),
          timestamp: mysqlTimestamp,
          data: payload,
        });

        if (this.heartbeatBuffer.length > 100) {
          this.heartbeatBuffer = this.heartbeatBuffer.slice(-50);
          console.log("🧹 Trimmed memory buffer to last 50 entries");
        }

        console.log(
          `💾 Heartbeat stored in memory (${payload.store_id}) - Buffer size: ${this.heartbeatBuffer.length}`
        );
      }
    } catch (error) {
      console.error("❌ Failed to store heartbeat locally:", error);
    }
  }

  async sendBufferedHeartbeats() {
    try {
      let bufferedHeartbeats = [];

      if (this.localDb) {
        try {
          const [rows] = await this.localDb.execute(
            "SELECT id, data, timestamp FROM heartbeat_buffer WHERE sent = FALSE ORDER BY id LIMIT 10"
          );
          bufferedHeartbeats = rows;
          if (rows.length > 0) {
            console.log(
              `📤 Found ${rows.length} buffered heartbeats in database`
            );
          }
        } catch (dbError) {
          console.error("❌ Error reading from database buffer:", dbError);
          return;
        }
      } else if (this.heartbeatBuffer && this.heartbeatBuffer.length > 0) {
        bufferedHeartbeats = this.heartbeatBuffer.slice(0, 10);
        console.log(
          `📤 Found ${bufferedHeartbeats.length} buffered heartbeats in memory`
        );
      }

      if (bufferedHeartbeats.length === 0) {
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const row of bufferedHeartbeats) {
        try {
          let heartbeatData;

          if (this.localDb) {
            if (typeof row.data === "string") {
              try {
                heartbeatData = JSON.parse(row.data);
              } catch (parseError) {
                console.error(
                  `❌ Failed to parse heartbeat data for ID ${row.id}:`,
                  parseError
                );
                continue;
              }
            } else {
              heartbeatData = row.data;
            }
          } else {
            heartbeatData = row.data;
          }

          if (!heartbeatData || !heartbeatData.store_id) {
            console.error(
              `❌ Invalid heartbeat data for ID ${row.id}: missing store_id`
            );
            continue;
          }

          console.log(
            `📤 Sending buffered heartbeat ${row.id} for store ${heartbeatData.store_id}`
          );

          const response = await axios.post(
            `${this.monitoringServerUrl}/heartbeat/buffered`,
            heartbeatData,
            {
              timeout: 5000,
              headers: { "Content-Type": "application/json" },
            }
          );

          if (response.status === 200) {
            if (this.localDb) {
              await this.localDb.execute(
                "UPDATE heartbeat_buffer SET sent = TRUE WHERE id = ?",
                [row.id]
              );
            } else {
              const index = this.heartbeatBuffer.findIndex(
                (item) => item.id === row.id
              );
              if (index > -1) {
                this.heartbeatBuffer.splice(index, 1);
              }
            }

            successCount++;
            console.log(`✅ Buffered heartbeat ${row.id} sent successfully`);
          } else {
            console.warn(
              `⚠️ Unexpected response status ${response.status} for heartbeat ${row.id}`
            );
            failCount++;
          }
        } catch (error) {
          failCount++;
          console.error(
            `❌ Failed to send buffered heartbeat ${row.id}:`,
            error.message
          );

          if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
            console.log(
              `🛑 Stopping buffered heartbeat sending due to network issues`
            );
            break;
          }
        }
      }

      if (successCount > 0 || failCount > 0) {
        console.log(
          `📊 Buffered heartbeat summary: ${successCount} sent, ${failCount} failed`
        );
      }
    } catch (error) {
      console.error("❌ Error in sendBufferedHeartbeats:", error);
    }
  }

  async clearOldBufferedHeartbeats() {
    try {
      if (this.localDb) {
        const [result] = await this.localDb.execute(
          "DELETE FROM heartbeat_buffer WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)"
        );
        if (result.affectedRows > 0) {
          console.log(
            `🧹 Cleared ${result.affectedRows} old buffered heartbeats from database`
          );
        }
      } else if (this.heartbeatBuffer) {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        const originalLength = this.heartbeatBuffer.length;
        this.heartbeatBuffer = this.heartbeatBuffer.filter((item) => {
          const itemTime = new Date(item.timestamp).getTime();
          return itemTime > oneHourAgo;
        });
        const removedCount = originalLength - this.heartbeatBuffer.length;
        if (removedCount > 0) {
          console.log(
            `🧹 Cleared ${removedCount} old buffered heartbeats from memory`
          );
        }
      }
    } catch (error) {
      console.error("❌ Error clearing old buffered heartbeats:", error);
    }
  }

  start() {
    this.running = true;

    console.log(
      `🚀 Starting heartbeat monitoring for store ${this.storeId}...`
    );
    console.log(`📡 Server URL: ${this.monitoringServerUrl}`);
    console.log(`⏰ Interval: ${this.heartbeatInterval / 1000} seconds`);

    // Send initial heartbeat immediately
    this.sendHeartbeat();

    // Set up periodic heartbeats
    this.intervalId = setInterval(() => {
      if (this.running) {
        this.sendHeartbeat();
      }
    }, this.heartbeatInterval);

    // Set up periodic cleanup
    this.cleanupIntervalId = setInterval(() => {
      if (this.running) {
        this.clearOldBufferedHeartbeats();
      }
    }, 30 * 60 * 1000);

    // Measure network speed every 30 minutes
    setInterval(() => {
      if (this.running) {
        this.measureNetworkSpeed();
      }
    }, 30 * 60 * 1000);

    console.log(`✅ Heartbeat monitoring started successfully!`);
  }

  async stop() {
    console.log("🛑 Stopping heartbeat monitoring...");
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }

    console.log("📤 Sending final buffered heartbeats before shutdown...");
    await this.sendBufferedHeartbeats();

    if (this.localDb) {
      await this.localDb.end();
    }

    console.log("⏹️ Heartbeat monitoring stopped");
  }

  updateDetectionStats(detectionCount) {
    this.lastDetectionTime = new Date();
    this.totalDetections += detectionCount;
    if (detectionCount > 0) {
      console.log(
        `👥 Detection update: +${detectionCount} people (total today: ${this.totalDetections})`
      );
    }
  }

  getStatus() {
    const bufferInfo = {
      has_local_db: !!this.localDb,
      memory_buffer_count: this.heartbeatBuffer
        ? this.heartbeatBuffer.length
        : 0,
      consecutive_failures: this.consecutiveFailures,
      last_successful_connection: this.lastSuccessfulConnection,
      network_speed_mbps: this.lastNetworkSpeed,
      network_speed_history: this.networkSpeedHistory,
    };

    return {
      store_id: this.storeId,
      store_name: this.storeName,
      running: this.running,
      is_first_heartbeat: this.isFirstHeartbeat,
      total_detections: this.totalDetections,
      last_detection: this.lastDetectionTime.toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      buffer_info: bufferInfo,
    };
  }

  async getBufferStatus() {
    const status = {
      has_local_db: !!this.localDb,
      memory_buffer_count: this.heartbeatBuffer
        ? this.heartbeatBuffer.length
        : 0,
      db_buffer_count: 0,
      network_speed_mbps: this.lastNetworkSpeed,
    };

    if (this.localDb) {
      try {
        const [rows] = await this.localDb.execute(
          "SELECT COUNT(*) as count FROM heartbeat_buffer WHERE sent = FALSE"
        );
        status.db_buffer_count = rows[0].count;
      } catch (err) {
        console.error("Error checking database buffer status:", err);
      }
    }

    console.log("📊 Buffer Status:", status);
    return status;
  }
}

// Example usage
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log("🏪 Enhanced Store Monitoring Client Starting...");
  console.log("=".repeat(60));

  const requiredEnvVars = ["STORE_ID", "MONITORING_SERVER_URL"];
  const missingVars = requiredEnvVars.filter(
    (varName) => !process.env[varName]
  );

  if (missingVars.length > 0) {
    console.error("❌ Missing required environment variables:");
    missingVars.forEach((varName) => {
      console.error(`   - ${varName}`);
    });
    process.exit(1);
  }

  const config = {
    storeId: process.env.STORE_ID,
    storeName: process.env.STORE_NAME || process.env.STORE_ID,
    monitoringServerUrl: process.env.MONITORING_SERVER_URL,
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 60000,
  };

  console.log("📋 Configuration:");
  console.log(`   Store ID: ${config.storeId}`);
  console.log(`   Store Name: ${config.storeName}`);
  console.log(`   Server URL: ${config.monitoringServerUrl}`);
  console.log(`   Heartbeat Interval: ${config.heartbeatInterval / 1000}s`);
  console.log("=".repeat(60));

  const client = new StoreHeartbeatClient(config);

  process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down store monitoring...");
    console.log("📊 Final status:", client.getStatus());
    await client.getBufferStatus();
    await client.stop();
    process.exit(0);
  });

  process.on("uncaughtException", async (error) => {
    console.error("💥 Uncaught Exception:", error);
    await client.stop();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
  });

  try {
    client.start();

    setInterval(() => {
      const detectionCount = Math.floor(Math.random() * 10);
      client.updateDetectionStats(detectionCount);
    }, 30000);

    console.log("🏪 Store monitoring started. Press Ctrl+C to stop.");

    setInterval(() => {
      console.log("\n📊 Current Status:", client.getStatus());
    }, 300000);

    setInterval(async () => {
      await client.getBufferStatus();
    }, 600000);
  } catch (error) {
    console.error("💥 Error starting store monitoring:", error);
    await client.stop();
    process.exit(1);
  }
}

export default StoreHeartbeatClient;
