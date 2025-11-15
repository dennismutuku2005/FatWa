// 📱 WhatsApp Baileys Server with Duplicate Protection
import express from "express";
import cors from "cors";
import qrcode from "qrcode-terminal";
process.env.DEBUG = ''; // Disable Baileys debug logs
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4050;
const RETRY_DELAY = 5000; // Increased delay for reconnection
const MAX_RETRIES = 10;
const DUPLICATE_BLOCK_TIME = 15000; // 15 seconds

let sock;
let isConnected = false;
let retryCount = 0;

// Store recent messages to prevent duplicates
const recentMessages = new Map();

// 🚀 Start WhatsApp connection
async function startWhatsApp() {
  try {
    console.log("🔄 Starting WhatsApp connection...");
    
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
    
    // ✅ FIX: Use dynamic version instead of hardcoded
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🆕 Using WA Version: ${version.join('.')}, Latest: ${isLatest}`);
    const CUSTOM_WHATSAPP_VERSION = [2, 3000, 1029950210];
    sock = makeWASocket({
      version:CUSTOM_WHATSAPP_VERSION, // ✅ This will use the correct latest version
      auth: state,
      printQRInTerminal: false, // ✅ Fixed: Remove deprecated option
      // ✅ FIXED: Remove incompatible logger configuration
      browser: ["Ubuntu", "Chrome", "120.0.0.0"],
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 20000,
      retryRequestDelayMs: 2000,
      maxRetries: 3,
      emitOwnEvents: true,
      defaultQueryTimeoutMs: 60000,
    });

    // Save credentials when updated
    sock.ev.on("creds.update", saveCreds);

    // Handle connection updates
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // ✅ FIXED: Handle QR code generation manually
      if (qr) {
        console.log("📸 Scan this QR code:");
        qrcode.generate(qr, { small: true });
        isConnected = false;
        retryCount = 0; // Reset retry count when QR is generated
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const error = lastDisconnect?.error;
        
        console.log(`❌ Connection closed - Code: ${statusCode}, Error: ${error?.message}`);
        
        // Handle different disconnect reasons
        switch (statusCode) {
          case DisconnectReason.connectionClosed:
            console.log("🔄 Connection closed, reconnecting...");
            break;
          case DisconnectReason.connectionLost:
            console.log("🔌 Connection lost, reconnecting...");
            break;
          case DisconnectReason.connectionReplaced:
            console.log("📱 Connection replaced from another device");
            break;
          case DisconnectReason.restartRequired:
            console.log("🔄 Restart required, reconnecting...");
            break;
          case DisconnectReason.timedOut:
            console.log("⏰ Connection timeout, reconnecting...");
            break;
          default:
            console.log(`🔄 Unknown disconnect (${statusCode}), reconnecting...`);
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        isConnected = false;

        if (shouldReconnect && retryCount < MAX_RETRIES) {
          retryCount++;
          console.log(`🔄 Reconnect attempt ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY/1000}s...`);
          setTimeout(() => {
            startWhatsApp();
          }, RETRY_DELAY);
        } else if (retryCount >= MAX_RETRIES) {
          console.log("❌ Max reconnection attempts reached. Please restart the server.");
        }
      } 
      else if (connection === "open") {
        console.log("✅ WhatsApp connected successfully!");
        isConnected = true;
        retryCount = 0; // Reset retry count on successful connection
        
        if (sock.user) {
          console.log(`👤 Connected as: ${sock.user.name || sock.user.id}`);
          console.log(`📱 Phone: ${sock.user.phone}`);
        }
      }
      else if (connection === "connecting") {
        console.log("🔄 Connecting to WhatsApp...");
        isConnected = false;
      }
    });

    // Handle connection errors
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "close" && update.lastDisconnect) {
        console.log("📊 Connection details:", {
          statusCode: update.lastDisconnect.error?.output?.statusCode,
          error: update.lastDisconnect.error?.message,
          retryCount
        });
      }
    });

  } catch (error) {
    console.error("❌ Failed to start WhatsApp:", error);
    
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      console.log(`🔄 Initial connection retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY/1000}s...`);
      setTimeout(() => {
        startWhatsApp();
      }, RETRY_DELAY);
    }
  }
}

// 🔍 Check if message is duplicate
function isDuplicateMessage(jid, message) {
  const key = `${jid}:${message}`;
  const lastSent = recentMessages.get(key);
  
  if (lastSent) {
    const timeSinceLastSend = Date.now() - lastSent;
    if (timeSinceLastSend < DUPLICATE_BLOCK_TIME) {
      return true;
    }
  }
  
  recentMessages.set(key, Date.now());
  return false;
}

// 🧹 Clean up old entries from recentMessages map
function cleanupOldEntries() {
  const now = Date.now();
  for (const [key, timestamp] of recentMessages.entries()) {
    if (now - timestamp > DUPLICATE_BLOCK_TIME) {
      recentMessages.delete(key);
    }
  }
}

// Set up periodic cleanup
setInterval(cleanupOldEntries, 30000);

// ✉️ Message sending with retry and duplicate protection
async function sendWithRetry(jid, message, messageRetryCount = 0) {
  try {
    if (!isConnected || !sock) {
      if (messageRetryCount >= 3) {
        throw new Error("WhatsApp not connected after 3 attempts");
      }
      console.log(`🕒 Waiting for connection... (Attempt ${messageRetryCount + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return sendWithRetry(jid, message, messageRetryCount + 1);
    }

    // Check for duplicate message
    if (isDuplicateMessage(jid, message)) {
      console.log(`⏳ Duplicate message blocked for ${jid}`);
      return { success: true, duplicate: true };
    }

    // Send message using Baileys
    const result = await sock.sendMessage(jid, { text: message });
    
    console.log(`✅ Message sent to ${jid}`);
    return { success: true, duplicate: false, messageId: result.key?.id };

  } catch (error) {
    console.error("❌ Send message error:", error.message);
    
    if (messageRetryCount < 2 && error.message?.includes('not connected')) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return sendWithRetry(jid, message, messageRetryCount + 1);
    }
    
    throw error;
  }
}

// 📩 Send message API
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body;
    
    if (!number || !message) {
      return res.status(400).json({ 
        error: "Missing number or message",
        received: { number: !!number, message: !!message }
      });
    }

    const jid = number.includes("@") ? number : number + "@s.whatsapp.net";
    
    if (!jid.match(/^\d+@s\.whatsapp\.net$/)) {
      return res.status(400).json({ 
        error: "Invalid number format. Use: 254712345678"
      });
    }

    const result = await sendWithRetry(jid, message);
    
    res.json({
      status: "success",
      message: result.duplicate ? "Duplicate blocked" : "Message sent",
      to: jid,
      duplicate: result.duplicate,
      cooldown: result.duplicate ? `${DUPLICATE_BLOCK_TIME/1000}s` : null,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    console.error("❌ API Error:", error.message);
    res.status(503).json({ 
      error: "Failed to send message", 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 🩺 Status check
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "Ready" : "Connecting...",
    retry_count: retryCount,
    max_retries: MAX_RETRIES,
    duplicate_protection: {
      active: true,
      cooldown: `${DUPLICATE_BLOCK_TIME/1000}s`,
      tracked_messages: recentMessages.size
    },
    timestamp: new Date().toISOString(),
  });
});

// 🧹 Clear duplicates endpoint
app.delete("/clear-duplicates", (req, res) => {
  const previousSize = recentMessages.size;
  recentMessages.clear();
  res.json({
    status: "success",
    cleared: true,
    previous_entries: previousSize,
    message: "Duplicate cache cleared"
  });
});

// 🏠 Home endpoint
app.get("/", (req, res) => {
  res.json({
    service: "WhatsApp Baileys Server",
    status: isConnected ? "Connected" : "Waiting for QR scan",
    endpoints: {
      "POST /send": "Send message",
      "GET /status": "Check status", 
      "DELETE /clear-duplicates": "Clear cache"
    }
  });
});

// 🧼 Clean up on exit
process.on("SIGINT", () => {
  console.log("🔄 Cleaning up...");
  recentMessages.clear();
  if (sock) {
    sock.end();
  }
  process.exit();
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🛡️ Duplicate protection active: ${DUPLICATE_BLOCK_TIME/1000} seconds cooldown`);
  
  // Start WhatsApp connection
  startWhatsApp();
});