// 📱 WhatsApp Baileys Server (No old ping)
import express from "express";
import cors from "cors";
import qrcode from "qrcode-terminal";
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

let sock;
let isConnected = false;

const silentLogger = {
  level: 'silent',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger // This fixes the error
};

// 🚀 Start WhatsApp connection
async function startWhatsApp() {
 

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const version = [ 2, 3000, 1028450369 ] 
  console.log("🆕 Using WA Web version:", version);

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0"],
    printQRInTerminal: false,
     logger: {
    level: silentLogger
  }
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

// ✉️ Message sending with retry
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

    await sock.sendMessage(jid, { text: message });
    return { success: true };
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
    await sendWithRetry(jid, message);
    res.json({
      status: "Message sent",
      to: jid,
      timestamp: new Date().toISOString(),
    });
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
    timestamp: new Date().toISOString(),
  });
});

// 🧼 Clean up on exit
process.on("SIGINT", () => {
  process.exit();
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// Start the socket
startWhatsApp().catch(console.error);
