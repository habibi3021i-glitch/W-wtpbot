const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// Optional: npm i qrcode-terminal  (prints the QR right in the logs)
let qrcodeTerminal = null;
try { qrcodeTerminal = require('qrcode-terminal'); } catch (e) {}

// ───────────────────────── CONFIG ─────────────────────────
const FIREBASE_URL = "https://wtpbot-default-rtdb.firebaseio.com";
const BOT_NUMBER = "03019022815";          // the one number this agent runs on
const BRAND = "Demo Assistant";            // change to your own channel / brand name
// ──────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => console.log('⚠️ Uncaught:', err?.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Unhandled:', err?.message || err));

const activeSockets = new Map();
const chatState = new Map(); // jid -> { consent: true/false }
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ───────────────────────── FIREBASE ─────────────────────────
function updateFirebase(path, data) {
    fetch(`${FIREBASE_URL}/${path}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(() => {});
}

async function getFirebase(path) {
    try {
        const res = await fetch(`${FIREBASE_URL}/${path}.json`);
        return await res.json();
    } catch (e) { return null; }
}

// ───────────────────────── PHONE FORMAT ─────────────────────────
function formatPhoneNumber(phone) {
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.startsWith('03')) clean = '92' + clean.substring(1);
    else if (clean.startsWith('0092')) clean = clean.substring(2);
    return clean;
}

const DEVICE_ID = formatPhoneNumber(BOT_NUMBER); // 923019022815

// ───────────────────────── MESSAGE HELPERS ─────────────────────────
async function typing(sock, jid, ms = 1200) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await delay(ms);
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {}
}

// Quick-reply buttons (native flow). If WhatsApp doesn't render them,
// the numbered text fallback below still lets the user reply with 1 / 2 / 3.
async function sendButtons(sock, jid, { title, body, footer, buttons }) {
    try {
        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        header: { title: title || '', subtitle: '', hasMediaAttachment: false },
                        body: { text: body },
                        footer: { text: footer || BRAND },
                        nativeFlowMessage: {
                            buttons: buttons.map(b => ({
                                name: 'quick_reply',
                                buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
                            }))
                        }
                    })
                }
            }
        }, {});

        await sock.relayMessage(jid, msg.message, {
            messageId: msg.key.id,
            additionalNodes: [{
                tag: 'biz', attrs: {},
                content: [{
                    tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
                    content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                }]
            }]
        });
    } catch (e) {
        console.log('⚠️ Buttons failed, using text fallback:', e.message);
        const list = buttons.map((b, i) => `${i + 1}. ${b.text}`).join('\n');
        await sock.sendMessage(jid, {
            text: `${title ? `*${title}*\n\n` : ''}${body}\n\n${list}\n\n_Reply with the number of your choice._`
        });
    }
}

// ───────────────────────── AGENT FLOWS ─────────────────────────
async function sendWelcome(sock, jid) {
    await typing(sock, jid, 1000);
    await sock.sendMessage(jid, {
        text: `Welcome to *${BRAND}* 👋\n\nI'm your virtual assistant. Before we begin, please review and accept the consent below.`
    });
    await typing(sock, jid, 1200);
    await sendButtons(sock, jid, {
        title: 'Opt In Consent',
        body:
            `Dear Customer 👋\n\nThank you for choosing ${BRAND} on WhatsApp.\n\n` +
            `By selecting the Yes button, you give your consent to chat with this assistant ` +
            `and agree to the terms and conditions of this service.`,
        buttons: [
            { id: 'consent_no', text: 'No' },
            { id: 'consent_yes', text: 'Yes' }
        ]
    });
}

async function sendMainMenu(sock, jid) {
    await typing(sock, jid, 1000);
    await sendButtons(sock, jid, {
        title: 'Main Menu',
        body: 'How can I help you today? Please choose an option below.',
        buttons: [
            { id: 'menu_services', text: 'Our Services' },
            { id: 'menu_support', text: 'Talk to Support' },
            { id: 'menu_about', text: 'About Us' }
        ]
    });
}

async function handleChoice(sock, jid, choice) {
    switch (choice) {
        case 'consent_yes':
            chatState.set(jid, { consent: true });
            await typing(sock, jid);
            await sock.sendMessage(jid, { text: '✅ Thank you! Your consent has been recorded.' });
            return sendMainMenu(sock, jid);

        case 'consent_no':
            chatState.set(jid, { consent: false });
            await typing(sock, jid);
            return sock.sendMessage(jid, {
                text: 'No problem. Without your consent I cannot continue. Send *Hi* anytime to start again.'
            });

        case 'menu_services':
            await typing(sock, jid);
            await sock.sendMessage(jid, {
                text: `*Our Services*\n\n• Website development\n• Mobile apps\n• Game development\n• Automation bots`
            });
            return sendBackButton(sock, jid);

        case 'menu_support':
            await typing(sock, jid);
            await sock.sendMessage(jid, {
                text: 'A support agent will get back to you shortly. Please describe your issue in a message. 📝'
            });
            return sendBackButton(sock, jid);

        case 'menu_about':
            await typing(sock, jid);
            await sock.sendMessage(jid, {
                text: `*About ${BRAND}*\n\nA demo WhatsApp assistant that answers instantly and guides you with quick-reply buttons.`
            });
            return sendBackButton(sock, jid);

        case 'menu_back':
            return sendMainMenu(sock, jid);
    }
}

async function sendBackButton(sock, jid) {
    await typing(sock, jid, 800);
    await sendButtons(sock, jid, {
        body: 'Is there anything else I can help you with?',
        buttons: [{ id: 'menu_back', text: 'Main Menu' }]
    });
}

// Pull text / button id out of any incoming message type
function extractInput(msg) {
    const m = msg.message;
    if (!m) return { text: '', id: '' };

    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
    let id = '';

    const nf = inner.interactiveResponseMessage?.nativeFlowResponseMessage;
    if (nf?.paramsJson) {
        try { id = JSON.parse(nf.paramsJson).id || ''; } catch (e) {}
    }
    if (!id) id = inner.buttonsResponseMessage?.selectedButtonId || inner.templateButtonReplyMessage?.selectedId || '';

    const text =
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        inner.buttonsResponseMessage?.selectedDisplayText ||
        inner.interactiveResponseMessage?.body?.text ||
        '';

    return { text: text.trim(), id };
}

// Maps typed replies ("yes", "1", "menu"...) to button ids (fallback mode)
function textToChoice(jid, text) {
    const t = text.toLowerCase();
    const st = chatState.get(jid);

    if (!st || st.consent === undefined || st.consent === false) {
        if (['yes', 'y', '2'].includes(t) && st?.awaiting) return 'consent_yes';
        if (['no', 'n', '1'].includes(t) && st?.awaiting) return 'consent_no';
        return null;
    }
    if (['1', 'services', 'our services'].includes(t)) return 'menu_services';
    if (['2', 'support', 'talk to support'].includes(t)) return 'menu_support';
    if (['3', 'about', 'about us'].includes(t)) return 'menu_about';
    if (['menu', 'main menu', 'back'].includes(t)) return 'menu_back';
    return null;
}

async function handleIncoming(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || msg.key.fromMe || jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    const { text, id } = extractInput(msg);
    if (!text && !id) return;

    try { await sock.readMessages([msg.key]); } catch (e) {}
    console.log(`📩 [${DEVICE_ID}] ${jid}: ${id || text}`);

    // Button tap
    if (id) return handleChoice(sock, jid, id);

    // Typed reply that matches a choice
    const st = chatState.get(jid) || {};
    const typed = textToChoice(jid, text);
    if (typed) return handleChoice(sock, jid, typed);

    // New chat or no consent yet -> consent flow
    if (!st.consent) {
        chatState.set(jid, { ...st, consent: false, awaiting: true });
        return sendWelcome(sock, jid);
    }

    // Consent given, free text -> show menu
    await typing(sock, jid);
    await sock.sendMessage(jid, { text: "Sorry, I didn't catch that. Please pick an option from the menu 👇" });
    return sendMainMenu(sock, jid);
}

// ───────────────────────── WHATSAPP ENGINE ─────────────────────────
async function connectWhatsApp(deviceId, isNewRequest = false) {
    const sessionDir = `session_${deviceId}`;

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false
    });

    activeSockets.set(deviceId, sock);
    sock.ev.on('creds.update', saveCreds);

    let pairingCodeRequested = false;

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            try { await handleIncoming(sock, msg); }
            catch (e) { console.log('❌ Handler error:', e.message); }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR + pairing code (same timing as the original working version)
        if (qr && isNewRequest) {
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;

            console.log(`\n📷 [${deviceId}] SCAN QR — open this link and scan it from WhatsApp > Linked Devices:`);
            console.log(qrLink + '\n');
            if (qrcodeTerminal) qrcodeTerminal.generate(qr, { small: true });

            updateFirebase(`bot_requests/${deviceId}`, {
                qrCode: qr,
                qrLink,
                status: "waiting_for_scan",
                timestamp: Date.now()
            });

            if (!pairingCodeRequested && !sock.authState.creds.registered) {
                pairingCodeRequested = true;
                setTimeout(async () => {
                    try {
                        const cleanPhone = formatPhoneNumber(deviceId);
                        console.log(`⏳ [${deviceId}] Requesting Pairing Code for: ${cleanPhone}`);

                        const code = await sock.requestPairingCode(cleanPhone);
                        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

                        console.log(`\n🔗 [${deviceId}] PAIRING CODE: ${formattedCode}`);
                        console.log(`   WhatsApp > Linked Devices > Link with phone number instead > enter the code\n`);
                        updateFirebase(`bot_requests/${deviceId}`, { pairingCode: formattedCode });
                    } catch (err) {
                        console.error(`❌ [${deviceId}] Pairing Code Error:`, err.message);
                    }
                }, 1000);
            }
        }

        if (connection === 'open') {
            console.log(`✅ [${deviceId}] Connected! Agent is live and replying to messages.`);
            isNewRequest = false;

            updateFirebase(`bot_requests/${deviceId}`, { status: "connected", qrCode: "", qrLink: "", pairingCode: "" });
            updateFirebase(`devices/${deviceId}`, {
                status: "connected", phone: deviceId,
                date: new Date().toISOString().split('T')[0],
                lastActive: new Date().toISOString()
            });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            activeSockets.delete(deviceId);

            if (reason === DisconnectReason.loggedOut) {
                console.log(`❌ [${deviceId}] Logged out.`);
                updateFirebase(`bot_requests/${deviceId}`, { status: "disconnected" });
                updateFirebase(`devices/${deviceId}`, { status: "disconnected" });
                try {
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {}
            } else {
                console.log(`🔄 [${deviceId}] Reconnecting...`);
                setTimeout(() => connectWhatsApp(deviceId, false), 5000);
            }
        }
    });
}

// ───────────────────────── RE-PAIR REQUEST MONITOR ─────────────────────────
// Setting bot_requests/<number>/status = "requested" in Firebase triggers a fresh pairing.
async function monitorRequests() {
    try {
        const req = await getFirebase(`bot_requests/${DEVICE_ID}`);
        if (req && req.status === 'requested') {
            console.log(`🚀 New pairing request for: ${DEVICE_ID}`);

            if (activeSockets.has(DEVICE_ID)) {
                try { activeSockets.get(DEVICE_ID).ws.close(); } catch (e) {}
                activeSockets.delete(DEVICE_ID);
                await delay(2000);
            }
            try {
                const dir = `session_${DEVICE_ID}`;
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            } catch (e) {}

            updateFirebase(`bot_requests/${DEVICE_ID}`, { status: "processing_setup" });
            connectWhatsApp(DEVICE_ID, true);
        }
    } catch (e) {}
    setTimeout(monitorRequests, 3000);
}

// ───────────────────────── START ─────────────────────────
console.log(`🌟 ${BRAND} agent starting for ${BOT_NUMBER} (${DEVICE_ID})`);

const sessionExists = fs.existsSync(`session_${DEVICE_ID}`) &&
                      fs.existsSync(`session_${DEVICE_ID}/creds.json`);

if (sessionExists) {
    console.log('🔄 Restoring saved session...');
    connectWhatsApp(DEVICE_ID, false);
} else {
    console.log('🆕 No session found. Generating pairing code + QR link...');
    connectWhatsApp(DEVICE_ID, true);
}
monitorRequests();
