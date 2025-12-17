// ============================================================
// CONFIGURACIÓN INICIAL Y DEPENDENCIAS
// ============================================================
require("dotenv").config();

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;

const { GoogleGenerativeAI } = require("@google/generative-ai");
const qrcodeTerminal = require("qrcode-terminal");
const QRCodeLib = require('qrcode'); // Librería para renderizar QR en web
const pino = require("pino");
const http = require("http");

// --- VARIABLE GLOBAL PARA EL QR ---
let lastQr = null;
const PORT = process.env.PORT || 5000;

// ============================================================
// SERVIDOR HTTP - MANTENER ACTIVO Y MOSTRAR QR WEB
// ============================================================
http.createServer(async (req, res) => {
    if (req.url === "/qr") {
        if (!lastQr) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<h2>El QR aún no se genera o ya estás conectado.</h2><p>Si acabas de encenderlo, espera 5 segundos y refresca.</p>");
            return;
        }
        try {
            const qrImage = await QRCodeLib.toDataURL(lastQr);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
                <html>
                    <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background-color:#f0f2f5;">
                        <div style="background:white;padding:30px;border-radius:15px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;">
                            <h2 style="color:#128c7e;">Vincular WhatsApp</h2>
                            <img src="${qrImage}" style="width:300px;height:300px;margin:20px 0;">
                            <p style="color:#666;">El QR se actualiza automáticamente cada 20 segundos.</p>
                            <script>setTimeout(() => { location.reload(); }, 20000);</script>
                        </div>
                    </body>
                </html>
            `);
        } catch (err) {
            res.end("Error generando el QR.");
        }
    } else {
        res.end("Bot activo. Accede a /qr para vincular.");
    }
}).listen(PORT, () => {
    console.log(`\n🌐 Servidor iniciado en puerto: ${PORT}`);
    console.log(`🔗 LINK PARA ESCANEAR QR: http://localhost:${PORT}/qr\n`);
});

// Configuración de Gemini
// Configuración de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ============================================================
// CONFIGURACIÓN DEL BOT Y MENSAJES PROGRAMADOS
// ============================================================
const chatHistory = new Map();
const processedMessages = new Set();
const cooldowns = new Map();
const conversationEnded = new Set(); 

const MAX_HISTORY_LENGTH = 5;
const COOLDOWN_SECONDS = 5;

const NEWS_GROUP_ID = "120363347522191441@g.us";
const NEWS_HOUR = 7;      
const NEWS_MINUTE = 40;    

let lastNewsSent = null;

const personalityPrompt = `
Eres un asistente conversacional profesional pero cercano. Responde en español de forma natural y directa.
REGLAS: Máximo 2-3 oraciones, NO digas que eres IA, NO uses emojis en exceso.
`;

// ============================================================
// FUNCIÓN PARA ENVIAR MENSAJE PROGRAMADO AL GRUPO
// ============================================================
async function sendDailyNews(sock) {
    if (!NEWS_GROUP_ID) return;

    const now = new Date();
    const todayKey = now.toDateString();

    if (lastNewsSent === todayKey) return;

    try {
        await sock.sendPresenceUpdate('composing', NEWS_GROUP_ID);

        const fullMessage = `📌 Te invitamos a unirte al canal de WhatsApp donde subimos vacantes o empleos 📌\n\nhttps://whatsapp.com/channel/0029Vb6CrqvK0IBpRURgAl1R\n\n👉 Si eres una empresa que solicita o simplemente te gustaría apoyar a subir vacantes que nos mantengan al día a todos , simplemente manda msj a los administradores para que se te asigne admin en el canal y puedas publicarte tambien en el 👈\n\n‼️ CONOCE TAMBIÉN NUESTROS DEMAS GRUPOS AQUÍ EN WHATSAPP, UNIÉNDOTE A ESTE OTRO CANAL ‼️\n\nhttps://whatsapp.com/channel/0029Vb6Ml1x0gcfBHsUjPs06`;

        await sock.sendMessage(NEWS_GROUP_ID, { text: fullMessage });
        await sock.sendPresenceUpdate('available', NEWS_GROUP_ID);

        lastNewsSent = todayKey;
        console.log("✅ MENSAJE PROGRAMADO ENVIADO EXITOSAMENTE");

    } catch (err) {
        console.error("❌ ERROR AL ENVIAR MENSAJE PROGRAMADO:", err.message);
    }
}

function scheduleNews(sock) {
    setInterval(() => {
        const now = new Date();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        if (currentHour === NEWS_HOUR && currentMinute === NEWS_MINUTE) {
            sendDailyNews(sock);
        }
    }, 60000);
    console.log(`⏰ Envío programado: ${NEWS_HOUR}:${NEWS_MINUTE.toString().padStart(2, '0')} hrs`);
}

// ============================================================
// CONEXIÓN PRINCIPAL
// ============================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const logger = pino({ level: "silent" });
    const { version } = await fetchLatestBaileysVersion();

    console.log("📦 Versión WhatsApp Web:", version);

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: true,
        syncFullHistory: false
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQr = qr; // Guardar el QR para el link web
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === "open") {
            lastQr = null; // Borrar QR al conectar
            console.log("🤖 Bot conectado con éxito");
            scheduleNews(sock);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== 401) {
                console.log("🔄 Reconectando...");
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log("⚠️ Sesión cerrada. Borra 'auth_info' y reinicia.");
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const remoteJid = m.key.remoteJid;
        if (remoteJid === NEWS_GROUP_ID || remoteJid.endsWith("@g.us") || remoteJid.includes("@newsletter")) return;

        if (processedMessages.has(m.key.id)) return;
        processedMessages.add(m.key.id);
        setTimeout(() => processedMessages.delete(m.key.id), 60000);

        let text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        if (!text) return;

        const normalizedText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        
        if (normalizedText === "outline") {
            chatHistory.delete(remoteJid);
            await sock.sendMessage(remoteJid, { text: "Conversación finalizada. 👋" });
            return;
        }

        if (cooldowns.has(remoteJid) && Date.now() < cooldowns.get(remoteJid)) return;

        const shortResponses = ["ok", "ya", "gracias", "vale", "si", "no", "listo", "bien"];
        if (shortResponses.includes(normalizedText) || text.length <= 3) {
            await sock.sendMessage(remoteJid, { text: "Entendido." });
            cooldowns.set(remoteJid, Date.now() + COOLDOWN_SECONDS * 1000);
            return;
        }

        if (!chatHistory.has(remoteJid)) chatHistory.set(remoteJid, []);
        let history = chatHistory.get(remoteJid);

        const conversation = [
            { role: "user", parts: [{ text: personalityPrompt }] },
            ...history,
            { role: "user", parts: [{ text }] },
        ];

        try {
            await sock.sendPresenceUpdate('composing', remoteJid);
            const result = await model.generateContent({ contents: conversation });
            let reply = result.response.text();

            reply += '\n\n_Escribe "Outline" para finalizar._';

            history.push({ role: "user", parts: [{ text }] });
            history.push({ role: "model", parts: [{ text: reply }] });

            if (history.length > MAX_HISTORY_LENGTH) history.shift();

            await sock.sendMessage(remoteJid, { text: reply });
            cooldowns.set(remoteJid, Date.now() + COOLDOWN_SECONDS * 1000);
        } catch (err) {
            console.error("Error Gemini:", err.message);
        }
    });
}


// ============================================================
// PING AUTOMÁTICO PARA EVITAR QUE EL BOT SE DUERMA
// ============================================================
setInterval(() => {
    // Nota: Reemplaza 'tu-app.koyeb.app' con tu URL real de Koyeb
    const url = `http://${process.env.KOYEB_APP_NAME || 'tu-app.koyeb.app'}/qr`;
    http.get(url, (res) => {
        console.log(`📡 Auto-Ping enviado: Estado ${res.statusCode}`);
    }).on('error', (err) => {
        console.error("❌ Error en Auto-Ping:", err.message);
    });
}, 600000); // Se ejecuta cada 10 minutos

connectToWhatsApp();

