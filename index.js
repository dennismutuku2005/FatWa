// 📱 WhatsApp Baileys Server (No old ping) with Duplicate Protection
import express from "express";
import cors from "cors";
import qrcode from "qrcode-terminal";
process.env.DEBUG = ''; // Disable Baileys debug logs
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4050;
const RETRY_DELAY = 3000;
const MAX_RETRIES = 5;
const DUPLICATE_BLOCK_TIME = 15000; // 15 seconds

let sock;
let isConnected = false;

// Store recent messages to prevent duplicates
const recentMessages = new Map();

const silentLogger = {
  level: 'silent',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger
};

// 🚀 Start WhatsApp connection
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const version = [2, 3000, 1028450369];
  console.log("🆕 Using WA Web version:", version);

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0"],
    printQRInTerminal: false,
    logger: silentLogger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📸 Scan this QR code in your WhatsApp app:");
      qrcode.generate(qr, { small: true });
      isConnected = false;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Disconnected (code ${statusCode}). Reconnect: ${shouldReconnect}`);
      isConnected = false;
      if (shouldReconnect) startWhatsApp();
    } else if (connection === "open") {
      console.log("✅ WhatsApp connected successfully!");
      isConnected = true;
    }
  });
}

// 🔍 Check if message is duplicate
function isDuplicateMessage(jid, message) {
  const key = `${jid}:${message}`;
  const lastSent = recentMessages.get(key);
  
  if (lastSent) {
    const timeSinceLastSend = Date.now() - lastSent;
    if (timeSinceLastSend < DUPLICATE_BLOCK_TIME) {
      return true; // Duplicate detected
    }
  }
  
  // Update the timestamp for this message
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

// Set up periodic cleanup (every 30 seconds)
setInterval(cleanupOldEntries, 30000);

// ✉️ Message sending with retry and duplicate protection
async function sendWithRetry(jid, message, retryCount = 0) {
  try {
    if (!isConnected || !sock) {
      if (retryCount >= MAX_RETRIES) {
        throw new Error("Max retry attempts reached. Socket not connected.");
      }
      console.log(`🕒 Retrying in ${RETRY_DELAY / 1000}s (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return sendWithRetry(jid, message, retryCount + 1);
    }

    // Check for duplicate message
    if (isDuplicateMessage(jid, message)) {
      console.log(`⏳ Duplicate message blocked for ${jid}. Waiting ${DUPLICATE_BLOCK_TIME/1000}s cooldown.`);
      return { success: true, duplicate: true, message: "Message appears to be duplicate but marked as sent" };
    }

    await sock.sendMessage(jid, { text: message });
    return { success: true, duplicate: false };
  } catch (error) {
    console.error("Send message error:", error);
    throw error;
  }
}

// 📩 Send message API
app.post("/send", async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: "Please provide 'number' and 'message'" });
    }

    const jid = number.includes("@") ? number : number + "@s.whatsapp.net";
    const result = await sendWithRetry(jid, message);
    
    if (result.duplicate) {
      res.json({
        status: "Message appears to be duplicate but marked as sent",
        to: jid,
        duplicate: true,
        cooldown: `${DUPLICATE_BLOCK_TIME/1000} seconds`,
        timestamp: new Date().toISOString(),
      });
    } else {
      res.json({
        status: "Message sent",
        to: jid,
        duplicate: false,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("❌ Failed to send message:", error);
    res.status(503).json({ error: "Failed to send message", details: error.message });
  }
});

// 🩺 Status check
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "Ready" : "Connecting...",
    duplicate_protection: "Active (15 seconds cooldown)",
    recent_messages_tracked: recentMessages.size,
    timestamp: new Date().toISOString(),
  });
});

// 🧹 Clear duplicates endpoint (for testing/maintenance)
app.delete("/clear-duplicates", (req, res) => {
  const previousSize = recentMessages.size;
  recentMessages.clear();
  res.json({
    cleared: true,
    previous_entries: previousSize,
    message: "Duplicate protection cache cleared"
  });
});

// 🧼 Clean up on exit
process.on("SIGINT", () => {
  console.log("🔄 Cleaning up before exit...");
  recentMessages.clear();
  process.exit();
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🛡️ Duplicate protection active: ${DUPLICATE_BLOCK_TIME/1000} seconds cooldown`);
});

// Start the socket
startWhatsApp().catch(console.error);