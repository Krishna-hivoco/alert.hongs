

import express from "express";
import nodemailer from "nodemailer";
import cron from "node-cron";
import dotenv from "dotenv";
import pool from "./database.js";
import { pathToFileURL } from "url";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Enhanced CORS configuration
app.use((req, res, next) => {
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://192.168.1.11:8829",
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS, PATCH"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );
    res.setHeader("Access-Control-Allow-Credentials", true);
  }

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  next();
});

class CentralizedMonitoringServer {
  constructor() {
    console.log("🏭 Initializing Centralized Store Monitoring Server...");

    // Configuration
    this.alertThresholdMinutes =
      parseInt(process.env.ALERT_THRESHOLD_MINUTES) || 5;
    this.offlineAlertCooldownMinutes =
      parseInt(process.env.OFFLINE_ALERT_COOLDOWN_MINUTES) || 5;
    this.healthCheckIntervalMinutes =
      parseInt(process.env.HEALTH_CHECK_INTERVAL) || 2;

    // File paths - only email config needed
    this.emailConfigPath =
      process.env.EMAIL_CONFIG_PATH || "./email-config.json";

    // Central store tracking - This is the main data store for ALL stores
    this.allStores = new Map(); // storeId -> store info
    this.storeMetrics = new Map(); // storeId -> latest metrics
    this.alertHistory = new Map(); // storeId -> alert timestamps
    this.storeEmailConfig = new Map(); // storeId -> [email1, email2, ...]

    // Alert tracking to prevent spam
    this.lastOfflineAlerts = new Map();
    this.lastRecoveryAlerts = new Map();
    this.lastStartupAlerts = new Map();

    this.db = pool;
    this.emailEnabled = false;

    // Initialize all configurations
    this.loadEmailConfiguration();
    this.initEmailTransporter();
    this.loadExistingStoresFromDB();
    this.startHealthMonitoring();

    console.log(`🚨 Alert threshold: ${this.alertThresholdMinutes} minutes`);
    console.log(
      `⏰ Alert cooldown: ${this.offlineAlertCooldownMinutes} minutes`
    );
    console.log(
      `🔍 Health check interval: ${this.healthCheckIntervalMinutes} minutes`
    );
  }

  // Load existing stores from database on startup
  async loadExistingStoresFromDB() {
    try {
      console.log("📊 Loading existing stores from database...");
      const [stores] = await this.db.execute(`
        SELECT store_id, store_name, last_heartbeat, status, created_at, updated_at 
        FROM stores
      `);

      for (const store of stores) {
        this.allStores.set(store.store_id, {
          store_id: store.store_id,
          store_name: store.store_name || `Store ${store.store_id}`,
          location: "Unknown", // Will be updated from heartbeat data if available
          status: store.status,
          last_heartbeat: store.last_heartbeat
            ? new Date(store.last_heartbeat)
            : null,
          last_seen: store.last_heartbeat
            ? new Date(store.last_heartbeat)
            : null,
          data: null,
          config: {
            store_name: store.store_name || `Store ${store.store_id}`,
            location: "Unknown",
          },
          metrics: {},
          updated_at: new Date(store.updated_at),
          first_seen: new Date(store.created_at),
        });
      }

      console.log(`✅ Loaded ${stores.length} existing stores from database`);
    } catch (error) {
      console.error(`❌ Error loading stores from database: ${error.message}`);
    }
  }

  // Remove store configuration loading methods since we only use email config

  // Load email configuration from JSON file
  loadEmailConfiguration() {
    try {
      if (fs.existsSync(this.emailConfigPath)) {
        const configData = fs.readFileSync(this.emailConfigPath, "utf8");
        const emailConfig = JSON.parse(configData);

        Object.entries(emailConfig).forEach(([storeId, emails]) => {
          if (Array.isArray(emails)) {
            this.storeEmailConfig.set(
              storeId,
              emails.map((email) => email.trim())
            );
            console.log(
              `📧 Email config loaded for store ${storeId}: ${emails.join(
                ", "
              )}`
            );
          } else {
            console.warn(`⚠️ Invalid email config for store ${storeId}`);
          }
        });

        console.log(
          `✅ Email configurations loaded: ${this.storeEmailConfig.size} stores`
        );
      } else {
        console.warn(`⚠️ Email config file not found: ${this.emailConfigPath}`);
        this.createSampleEmailConfig();
      }
    } catch (error) {
      console.error(`❌ Error loading email configuration: ${error.message}`);
    }
  }

  // Create sample email configuration
  createSampleEmailConfig() {
    const sampleConfig = {
      2308: ["krishna@hivoco.com"],
      2309: ["krishna@hivoco.com"],
      2310: ["krishna@hivoco.com"],
      default: ["krishna@hivoco.com"],
    };

    try {
      fs.writeFileSync(
        this.emailConfigPath,
        JSON.stringify(sampleConfig, null, 2)
      );
      console.log(
        `📄 Sample email configuration created at ${this.emailConfigPath}`
      );
    } catch (error) {
      console.error(`❌ Error creating sample email config: ${error.message}`);
    }
  }

  // Initialize email transporter
  initEmailTransporter() {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      console.warn("⚠️ Email credentials missing! Alerts will not be sent.");
      this.emailEnabled = false;
      return;
    }

    this.emailConfig = {
      service: process.env.EMAIL_SERVICE || "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
    };

    this.transporter = nodemailer.createTransport({
      service: this.emailConfig.service,
      auth: this.emailConfig.auth,
    });

    this.emailEnabled = true;
    console.log(
      `📧 Email transporter configured: ${this.emailConfig.auth.user}`
    );
  }

  // Get email recipients for a store
  getEmailRecipients(storeId) {
    const storeEmails = this.storeEmailConfig.get(storeId) || [];
    const defaultEmails = this.storeEmailConfig.get("default") || [];

    // Use store-specific emails if available, otherwise use default
    const allEmails = storeEmails.length > 0 ? storeEmails : defaultEmails;

    if (allEmails.length === 0) {
      console.warn(`⚠️ No email recipients configured for store ${storeId}`);
    }

    return allEmails;
  }

  // MAIN HEARTBEAT PROCESSOR - This handles heartbeats from ALL stores
  async processHeartbeat(heartbeatData) {
    const storeId = heartbeatData.store_id;
    const timestamp = new Date();

    // Get store information from heartbeat data or use defaults
    const storeName = heartbeatData.store_name || `Store ${storeId}`;
    const storeLocation = heartbeatData.location_info?.timezone || "Unknown";

    // Get previous state
    const previousState = this.allStores.get(storeId);
    const wasOffline = previousState?.status === "offline";
    const isFirstHeartbeat = !previousState;
    const isStartup = heartbeatData.is_startup === true;

    console.log(
      `   📊 Previous state: ${previousState ? previousState.status : "NEW"}`
    );
    console.log(`   🆕 Is first heartbeat: ${isFirstHeartbeat}`);
    console.log(`   🚀 Is startup flag: ${isStartup}`);
    console.log(`   ❌ Was offline: ${wasOffline}`);

    // Update store state in central tracking
    const storeState = {
      store_id: storeId,
      store_name: storeName,
      location: storeLocation,
      status: "online", // Always online when receiving heartbeat
      last_heartbeat: timestamp,
      last_seen: timestamp,
      data: heartbeatData,
      config: {
        store_name: storeName,
        location: storeLocation,
      },
      metrics: this.extractMetrics(heartbeatData),
      updated_at: timestamp,
      first_seen: previousState?.first_seen || timestamp,
    };

    this.allStores.set(storeId, storeState);
    this.storeMetrics.set(storeId, storeState.metrics);

    // Save to database using existing schema
    await this.saveHeartbeatToDatabase(storeId, heartbeatData, timestamp);

    // Handle alerts - improved logic to match your old behavior
    if (isFirstHeartbeat) {
      console.log(
        `   🚀 FIRST HEARTBEAT for store ${storeId} - sending startup alert`
      );
      await this.sendAlert(
        storeId,
        "startup",
        `Store ${storeName} (${storeId}) has come online`,
        "low",
        heartbeatData
      );
      this.lastStartupAlerts.set(storeId, timestamp);
    } else if (isStartup) {
      // Check if we already sent a startup alert recently to avoid spam
      const lastStartup = this.lastStartupAlerts.get(storeId);
      const shouldSendStartup =
        !lastStartup || (timestamp - lastStartup) / (1000 * 60) > 10; // 10 minute cooldown

      if (shouldSendStartup) {
        console.log(
          `   🚀 STARTUP HEARTBEAT for store ${storeId} - sending startup alert`
        );
        await this.sendAlert(
          storeId,
          "startup",
          `Store ${storeName} (${storeId}) has started up and is now online`,
          "low",
          heartbeatData
        );
        this.lastStartupAlerts.set(storeId, timestamp);
      } else {
        console.log(
          `   ⏭️ Startup alert skipped for ${storeId} (cooldown active)`
        );
      }
    } else if (wasOffline) {
      console.log(`   ✅ Store ${storeId} recovered from offline state`);
      const lastRecovery = this.lastRecoveryAlerts.get(storeId);
      const shouldSendRecovery =
        !lastRecovery || (timestamp - lastRecovery) / (1000 * 60) > 5; // 5 minute cooldown

      if (shouldSendRecovery) {
        await this.sendAlert(
          storeId,
          "recovery",
          `Store ${storeName} (${storeId}) has recovered and is back online`,
          "medium",
          heartbeatData
        );
        this.lastRecoveryAlerts.set(storeId, timestamp);
      }
    }

    console.log(`   ✅ Heartbeat processed successfully for store ${storeId}`);

    return {
      status: "success",
      message: "Heartbeat processed",
      store_name: storeName,
      total_stores_monitored: this.allStores.size,
    };
  }

  // Extract key metrics from heartbeat data
  extractMetrics(heartbeatData) {
    const sys = heartbeatData.system_stats || {};
    const cam = heartbeatData.camera_status || {};
    const app = heartbeatData.application_stats || {};
    const net = heartbeatData.network_info || {};

    return {
      cpu_usage: sys.cpu_usage_percent,
      memory_usage: sys.memory_usage_percent,
      memory_available_gb: sys.memory_available_gb,
      disk_free_gb: sys.disk_free_gb,
      disk_usage: sys.disk_usage_percent,
      network_connected: sys.network_connected,
      network_speed_mbps: sys.network_speed_mbps || net.current_speed_mbps,
      cameras_active: cam.active_cameras,
      cameras_total: cam.total_cameras,
      process_memory_mb: sys.process_memory_mb,
      uptime_hours: sys.uptime_hours,
      detections_today: app.total_detections_today,
      last_detection: app.last_detection_time,
      application_version: app.application_version,
      node_version: app.node_version,
    };
  }

  // Save heartbeat to database using existing schema
  async saveHeartbeatToDatabase(storeId, heartbeatData, timestamp) {
    try {
      const connection = await this.db.getConnection();

      try {
        await connection.beginTransaction();

        // Update/insert store using existing schema
        await connection.execute(
          `INSERT INTO stores (store_id, store_name, last_heartbeat, status, updated_at)
           VALUES (?, ?, ?, 'online', ?)
           ON DUPLICATE KEY UPDATE
           store_name = VALUES(store_name),
           last_heartbeat = VALUES(last_heartbeat),
           status = 'online',
           updated_at = VALUES(updated_at)`,
          [
            storeId,
            heartbeatData.store_name || `Store ${storeId}`,
            timestamp,
            timestamp,
          ]
        );

        // Insert heartbeat history using existing schema
        await connection.execute(
          `INSERT INTO heartbeat_history
           (store_id, timestamp, cpu_usage, memory_usage, disk_free_gb, active_cameras, 
            total_cameras, network_connected, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            storeId,
            timestamp,
            heartbeatData.system_stats?.cpu_usage_percent,
            heartbeatData.system_stats?.memory_usage_percent,
            heartbeatData.system_stats?.disk_free_gb,
            heartbeatData.camera_status?.active_cameras,
            heartbeatData.camera_status?.total_cameras,
            heartbeatData.system_stats?.network_connected,
            JSON.stringify(heartbeatData),
          ]
        );

        // Insert system stats using existing schema
        await connection.execute(
          `INSERT INTO system_stats
           (store_id, timestamp, cpu_usage, memory_usage, memory_available_gb, disk_free_gb,
            disk_usage_percent, process_memory_mb, uptime_hours, network_connected)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            storeId,
            timestamp,
            heartbeatData.system_stats?.cpu_usage_percent,
            heartbeatData.system_stats?.memory_usage_percent,
            heartbeatData.system_stats?.memory_available_gb,
            heartbeatData.system_stats?.disk_free_gb,
            heartbeatData.system_stats?.disk_usage_percent,
            heartbeatData.system_stats?.process_memory_mb,
            heartbeatData.system_stats?.uptime_hours,
            heartbeatData.system_stats?.network_connected,
          ]
        );

        await connection.commit();
        console.log(`   💾 Data saved to database for store ${storeId}`);
      } catch (dbError) {
        await connection.rollback();
        throw dbError;
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error(
        `   ❌ Database error for store ${storeId}:`,
        error.message
      );
    }
  }

  // CENTRALIZED HEALTH MONITORING - Checks ALL stores
  async performHealthCheck() {
    const timestamp = new Date();
    console.log(`\n${"=".repeat(80)}`);
    console.log(`🔍 [${timestamp.toISOString()}] CENTRALIZED HEALTH CHECK`);
    console.log(`📊 Monitoring ${this.allStores.size} stores total`);

    let onlineCount = 0;
    let offlineCount = 0;
    let alertsSent = 0;

    // Check each store's health
    for (const [storeId, store] of this.allStores) {
      if (!store.last_heartbeat) {
        console.log(
          `\n🏪 ${store.store_name} (${storeId}) - No heartbeat data yet`
        );
        continue;
      }

      const minutesSinceLastHeartbeat =
        (timestamp - store.last_heartbeat) / (1000 * 60);
      const isOffline = minutesSinceLastHeartbeat > this.alertThresholdMinutes;

      console.log(`\n🏪 ${store.store_name} (${storeId})`);
      console.log(`   📍 Location: ${store.location}`);
      console.log(
        `   💓 Last heartbeat: ${store.last_heartbeat.toISOString()}`
      );
      console.log(`   ⏰ Minutes ago: ${minutesSinceLastHeartbeat.toFixed(1)}`);
      console.log(`   📊 Current status: ${store.status}`);

      if (isOffline) {
        console.log(`   ❌ STORE IS OFFLINE`);

        // Only send alert if status changed or cooldown expired
        if (store.status !== "offline") {
          // Store just went offline
          store.status = "offline";
          await this.updateStoreStatusInDB(storeId, "offline", timestamp);

          await this.sendAlert(
            storeId,
            "offline",
            `Store ${
              store.store_name
            } (${storeId}) has gone offline. Last seen: ${store.last_heartbeat.toLocaleString()}`,
            "critical"
          );

          alertsSent++;
          console.log(`   🚨 FIRST offline alert sent`);
        } else if (this.canSendOfflineAlert(storeId)) {
          // Send repeat offline alert
          const duration = this.formatDuration(
            minutesSinceLastHeartbeat * 60 * 1000
          );

          await this.sendAlert(
            storeId,
            "offline",
            `Store ${
              store.store_name
            } (${storeId}) has been offline for ${duration}. Last seen: ${store.last_heartbeat.toLocaleString()}`,
            "critical"
          );

          alertsSent++;
          console.log(`   🚨 REPEAT offline alert sent (${duration})`);
        }

        offlineCount++;
      } else {
        console.log(`   ✅ STORE IS ONLINE`);
        onlineCount++;
      }
    }

    // Also check database for any stores not in memory
    await this.syncWithDatabase(timestamp);

    console.log(`\n📈 HEALTH CHECK SUMMARY:`);
    console.log(`   🟢 Online stores: ${onlineCount}`);
    console.log(`   🔴 Offline stores: ${offlineCount}`);
    console.log(`   📧 Alerts sent: ${alertsSent}`);
    console.log(`   🏭 Total stores monitored: ${this.allStores.size}`);
    console.log(`${"=".repeat(80)}\n`);
  }

  // Sync with database to find any stores not in memory
  async syncWithDatabase(timestamp) {
    try {
      const [dbStores] = await this.db.execute(
        `SELECT store_id, store_name, last_heartbeat, status FROM stores`
      );

      for (const dbStore of dbStores) {
        if (!this.allStores.has(dbStore.store_id)) {
          console.log(
            `🔄 Found store ${dbStore.store_id} in DB but not in memory, adding...`
          );

          this.allStores.set(dbStore.store_id, {
            store_id: dbStore.store_id,
            store_name: dbStore.store_name || `Store ${dbStore.store_id}`,
            location: "Unknown",
            status: dbStore.status,
            last_heartbeat: dbStore.last_heartbeat
              ? new Date(dbStore.last_heartbeat)
              : null,
            last_seen: dbStore.last_heartbeat
              ? new Date(dbStore.last_heartbeat)
              : null,
            config: {
              store_name: dbStore.store_name || `Store ${dbStore.store_id}`,
              location: "Unknown",
            },
            data: null,
            metrics: {},
            updated_at: timestamp,
            first_seen: dbStore.last_heartbeat
              ? new Date(dbStore.last_heartbeat)
              : timestamp,
          });
        }
      }
    } catch (error) {
      console.error(`❌ Error syncing with database: ${error.message}`);
    }
  }

  // Update store status in database
  async updateStoreStatusInDB(storeId, status, timestamp) {
    try {
      await this.db.execute(
        `UPDATE stores SET status = ?, updated_at = ? WHERE store_id = ?`,
        [status, timestamp, storeId]
      );
    } catch (error) {
      console.error(`❌ Error updating store status: ${error.message}`);
    }
  }

  // Check if we can send offline alert (prevent spam)
  canSendOfflineAlert(storeId) {
    const lastAlert = this.lastOfflineAlerts.get(storeId);
    if (!lastAlert) {
      this.lastOfflineAlerts.set(storeId, new Date());
      return true;
    }

    const minutesSince = (new Date() - lastAlert) / (1000 * 60);
    if (minutesSince >= this.offlineAlertCooldownMinutes) {
      this.lastOfflineAlerts.set(storeId, new Date());
      return true;
    }

    return false;
  }

  // Send email alert using existing alerts table schema
  async sendAlert(
    storeId,
    alertType,
    message,
    severity = "medium",
    storeData = null
  ) {
    try {
      // Map alert types to match existing schema and improve logging
      const alertTypeMapping = {
        startup: "test", // Using test as closest match for startup
        recovery: "test", // Using test as closest match for recovery
        offline: "offline",
      };

      const dbAlertType = alertTypeMapping[alertType] || "offline";

      // Store alert in database using existing schema
      await this.db.execute(
        `INSERT INTO alerts (store_id, alert_type, message, severity, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
        [storeId, dbAlertType, message, severity, new Date()]
      );

      console.log(
        `   📝 Alert stored in database: ${alertType} for store ${storeId}`
      );

      if (!this.emailEnabled) {
        console.log(
          `   📧 Email disabled - would send ${alertType} alert for ${storeId}`
        );
        return;
      }

      const recipients = this.getEmailRecipients(storeId);
      if (recipients.length === 0) {
        console.log(`   📧 No email recipients for store ${storeId}`);
        return;
      }

      const storeInfo = this.allStores.get(storeId);
      const mailOptions = {
        from: this.emailConfig.auth.user,
        to: recipients.join(", "),
        subject: this.createEmailSubject(
          storeId,
          alertType,
          severity,
          storeInfo
        ),
        html: this.createEmailBody(
          storeId,
          alertType,
          message,
          severity,
          storeData,
          storeInfo
        ),
      };

      console.log(
        `   📧 Preparing to send ${alertType} email to: ${recipients.join(
          ", "
        )}`
      );

      // Send email asynchronously
      setImmediate(async () => {
        try {
          const info = await this.transporter.sendMail(mailOptions);
          console.log(
            `   ✅ ${alertType.toUpperCase()} email sent successfully - ID: ${
              info.messageId
            }`
          );
        } catch (emailError) {
          console.error(
            `   ❌ Email failed for ${alertType}: ${emailError.message}`
          );
        }
      });
    } catch (error) {
      console.error(`   ❌ Alert error for ${alertType}: ${error.message}`);
    }
  }

  // Create email subject
  createEmailSubject(storeId, alertType, severity, storeInfo) {
    const icons = { startup: "🚀", recovery: "✅", offline: "🚨" };
    const storeName = storeInfo?.store_name || `Store ${storeId}`;

    return `${
      icons[alertType] || "📧"
    } ${storeName} - ${alertType.toUpperCase()} Alert`;
  }

  // Create email body
  createEmailBody(storeId, alertType, message, severity, storeData, storeInfo) {
    const colors = {
      low: "#28a745",
      medium: "#17a2b8",
      high: "#fd7e14",
      critical: "#dc3545",
    };

    const color = colors[severity];
    const storeName = storeInfo?.store_name || `Store ${storeId}`;
    const location = storeInfo?.location || "Unknown";
    const isGoodNews = alertType === "startup" || alertType === "recovery";

    return `
      <html>
      <body style="font-family: Arial, sans-serif; margin: 20px;">
        <div style="background-color: ${color}; color: white; padding: 20px; border-radius: 8px;">
          <h2>🏪 Store Alert: ${storeName}</h2>
          <h3>Status: ${alertType.toUpperCase()}</h3>
        </div>
        
        <div style="margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Store ID:</td>
              <td style="padding: 10px; border: 1px solid #ddd;">${storeId}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Store Name:</td>
              <td style="padding: 10px; border: 1px solid #ddd;">${storeName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Location:</td>
              <td style="padding: 10px; border: 1px solid #ddd;">${location}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Alert Type:</td>
              <td style="padding: 10px; border: 1px solid #ddd; color: ${color}; font-weight: bold;">${alertType.toUpperCase()}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Message:</td>
              <td style="padding: 10px; border: 1px solid #ddd;">${message}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Time:</td>
              <td style="padding: 10px; border: 1px solid #ddd;">${new Date().toLocaleString()}</td>
            </tr>
          </table>
        </div>
        
        ${
          storeData && storeData.system_stats
            ? this.createSystemInfoSection(storeData)
            : ""
        }
        
        <div style="margin-top: 20px; padding: 15px; background: ${
          isGoodNews ? "#d4edda" : "#f8d7da"
        }; border-radius: 5px;">
          <h4 style="color: ${isGoodNews ? "#155724" : "#721c24"}; margin: 0;">
            ${isGoodNews ? "✅ Good News!" : "🚨 Action Required!"}
          </h4>
          <p style="color: ${
            isGoodNews ? "#155724" : "#721c24"
          }; margin: 5px 0 0 0;">
            ${
              isGoodNews
                ? "Store system is operational and monitoring resumed."
                : `Please check the store system immediately. This alert repeats every ${this.offlineAlertCooldownMinutes} minutes until resolved.`
            }
          </p>
        </div>
        
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 5px;">
          <p><strong>🏭 Centralized Store Monitoring System</strong></p>
          <p>Total Stores Monitored: ${
            this.allStores.size
          } | Alert Threshold: ${this.alertThresholdMinutes}min</p>
        </div>
      </body>
      </html>
    `;
  }

  // Create system info section for emails
  createSystemInfoSection(storeData) {
    const sys = storeData.system_stats || {};
    const cam = storeData.camera_status || {};

    return `
      <div style="margin: 20px 0;">
        <h3>📊 System Information:</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">CPU Usage:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              sys.cpu_usage_percent || "Unknown"
            }%</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Memory Usage:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              sys.memory_usage_percent || "Unknown"
            }%</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Disk Free:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              sys.disk_free_gb || "Unknown"
            } GB</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Network:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              sys.network_connected ? "✅ Connected" : "❌ Disconnected"
            }</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold; background: #f9f9f9;">Cameras:</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${
              cam.active_cameras || 0
            } / ${cam.total_cameras || 0} active</td>
          </tr>
        </table>
      </div>
    `;
  }

  // Start health monitoring
  startHealthMonitoring() {
    // Run health check every X minutes
    cron.schedule(`*/${this.healthCheckIntervalMinutes} * * * *`, () => {
      this.performHealthCheck();
    });

    console.log(
      `🚀 Health monitoring started (every ${this.healthCheckIntervalMinutes} minutes)`
    );
  }

  // Format duration
  formatDuration(durationMs) {
    const minutes = Math.floor(durationMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;

    if (hours > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${minutes}m`;
  }

  // Get dashboard data for ALL stores
  getDashboardData() {
    const stores = [];
    const currentTime = new Date();

    for (const [storeId, store] of this.allStores) {
      let minutesSinceHeartbeat = null;
      let isOnline = false;

      if (store.last_heartbeat) {
        minutesSinceHeartbeat =
          (currentTime - store.last_heartbeat) / (1000 * 60);
        isOnline = minutesSinceHeartbeat <= this.alertThresholdMinutes;
      }

      stores.push({
        store_id: storeId,
        store_name: store.store_name,
        location: store.location,
        status: store.last_heartbeat
          ? isOnline
            ? "online"
            : "offline"
          : "unknown",
        last_heartbeat: store.last_heartbeat
          ? store.last_heartbeat.toISOString()
          : null,
        minutes_since_heartbeat: minutesSinceHeartbeat
          ? minutesSinceHeartbeat.toFixed(1)
          : null,
        first_seen: store.first_seen ? store.first_seen.toISOString() : null,
        email_recipients: this.getEmailRecipients(storeId),
        metrics: store.metrics || {},
        config: store.config || {},
      });
    }

    return {
      stores: stores.sort((a, b) => a.store_id.localeCompare(b.store_id)),
      summary: {
        total_stores: this.allStores.size,
        online_stores: stores.filter((s) => s.status === "online").length,
        offline_stores: stores.filter((s) => s.status === "offline").length,
        unknown_stores: stores.filter((s) => s.status === "unknown").length,
        last_updated: currentTime.toISOString(),
      },
    };
  }

  // Reload configurations - only email config now
  reloadConfigurations() {
    console.log("🔄 Reloading email configuration...");
    this.storeEmailConfig.clear();
    this.loadEmailConfiguration();

    return {
      email_configs_loaded: this.storeEmailConfig.size,
    };
  }
}

// Initialize the centralized monitoring server
const centralMonitor = new CentralizedMonitoringServer();

// ============================================================================
// API ROUTES
// ============================================================================

// Main heartbeat endpoint - receives heartbeats from ALL stores
app.post("/heartbeat", async (req, res) => {
  try {
    const result = await centralMonitor.processHeartbeat(req.body);
    res.json({
      status: "received",
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    console.error("Heartbeat processing error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Buffered heartbeat endpoint
app.post("/heartbeat/buffered", async (req, res) => {
  try {
    const result = await centralMonitor.processHeartbeat(req.body);
    res.json({
      status: "received",
      timestamp: new Date().toISOString(),
      buffered: true,
      ...result,
    });
  } catch (error) {
    console.error("Buffered heartbeat error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Dashboard endpoint - returns data for ALL stores
app.get("/dashboard", (req, res) => {
  try {
    const data = centralMonitor.getDashboardData();
    res.json(data);
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get specific store details
app.get("/store/:storeId", (req, res) => {
  try {
    const { storeId } = req.params;
    const store = centralMonitor.allStores.get(storeId);

    if (!store) {
      return res.status(404).json({ error: "Store not found" });
    }

    const currentTime = new Date();
    let minutesSinceHeartbeat = null;
    let isOnline = false;

    if (store.last_heartbeat) {
      minutesSinceHeartbeat =
        (currentTime - store.last_heartbeat) / (1000 * 60);
      isOnline = minutesSinceHeartbeat <= centralMonitor.alertThresholdMinutes;
    }

    res.json({
      ...store,
      minutes_since_heartbeat: minutesSinceHeartbeat
        ? minutesSinceHeartbeat.toFixed(1)
        : null,
      is_online: isOnline,
      email_recipients: centralMonitor.getEmailRecipients(storeId),
      alert_threshold_minutes: centralMonitor.alertThresholdMinutes,
    });
  } catch (error) {
    console.error("Store details error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manual health check trigger
app.get("/trigger-health-check", async (req, res) => {
  try {
    await centralMonitor.performHealthCheck();
    res.json({
      status: "Health check completed",
      stores_checked: centralMonitor.allStores.size,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test email for specific store
app.get("/test-email/:storeId", async (req, res) => {
  try {
    const { storeId } = req.params;
    const recipients = centralMonitor.getEmailRecipients(storeId);

    if (recipients.length === 0) {
      return res.status(400).json({
        error: "No email recipients configured for this store",
        store_id: storeId,
      });
    }

    await centralMonitor.sendAlert(
      storeId,
      "offline",
      "This is a test email from the centralized monitoring system",
      "critical"
    );

    res.json({
      status: "Test email sent",
      store_id: storeId,
      recipients: recipients,
      recipients_count: recipients.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Configuration management - only email config
app.get("/config/email", (req, res) => {
  try {
    const config = {};
    for (const [storeId, emails] of centralMonitor.storeEmailConfig) {
      config[storeId] = emails;
    }
    res.json({
      email_configurations: config,
      total_configured: centralMonitor.storeEmailConfig.size,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/config/reload", (req, res) => {
  try {
    const result = centralMonitor.reloadConfigurations();
    res.json({
      status: "Email configuration reloaded",
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent alerts
app.get("/alerts", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const [alerts] = await centralMonitor.db.execute(
      `SELECT a.*, s.store_name 
       FROM alerts a 
       LEFT JOIN stores s ON a.store_id = s.store_id 
       ORDER BY a.timestamp DESC 
       LIMIT ?`,
      [limit]
    );

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get alerts for specific store
app.get("/alerts/:storeId", async (req, res) => {
  try {
    const { storeId } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    const [alerts] = await centralMonitor.db.execute(
      `SELECT * FROM alerts 
       WHERE store_id = ? 
       ORDER BY timestamp DESC 
       LIMIT ?`,
      [storeId, limit]
    );

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// System health endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    stores_monitored: centralMonitor.allStores.size,
    stores_with_email_config: centralMonitor.storeEmailConfig.size,
    alert_threshold_minutes: centralMonitor.alertThresholdMinutes,
    health_check_interval_minutes: centralMonitor.healthCheckIntervalMinutes,
    email_enabled: centralMonitor.emailEnabled,
    memory_usage: process.memoryUsage(),
    config_files: {
      email_config_path: centralMonitor.emailConfigPath,
    },
  });
});

// Start the server
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = process.env.SERVER_PORT || 3000;

  app.listen(PORT, () => {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`🚀 CENTRALIZED STORE MONITORING SERVER STARTED`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🏪 Store details: http://localhost:${PORT}/store/STORE_ID`);
    console.log(
      `🔧 Manual health check: http://localhost:${PORT}/trigger-health-check`
    );
    console.log(`📧 Test email: http://localhost:${PORT}/test-email/STORE_ID`);
    console.log(`📋 Recent alerts: http://localhost:${PORT}/alerts`);
    console.log(`🏪 Store alerts: http://localhost:${PORT}/alerts/STORE_ID`);
    console.log(`⚙️ Email config: http://localhost:${PORT}/config/email`);
    console.log(`🔄 Reload config: http://localhost:${PORT}/config/reload`);
    console.log(`❤️ Health check: http://localhost:${PORT}/health`);
    console.log(`${"=".repeat(80)}\n`);
  });

  process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down centralized monitoring server...");
    await pool.end();
    process.exit(0);
  });
}

export default CentralizedMonitoringServer;
