// ============================================================
//  WASEEM RESTAURANT - WhatsApp Order Bot  (no database)
//  Link with: 03019022815  ->  923019022815
//  Run: npm start   (node wtpbot.js)
// ============================================================
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

let qrcodeTerminal = null;
try { qrcodeTerminal = require('qrcode-terminal'); } catch (e) {}

// ───────────────────────── SETTINGS (edit these) ─────────────────────────
const BOT_NUMBER       = "03019022815";            // number the bot is linked with
const RESTAURANT_NAME  = "Waseem Restaurant";
const RESTAURANT_PHONE = "0301 9022815";           // number customers can CALL
const OPEN_HOURS       = "12:00 PM – 12:00 AM";
const DELIVERY_FEE     = 100;                      // Rs, set 0 for free delivery
const DELIVERY_TIME    = "30 minutes";
const OWNER_NUMBER     = "";                       // e.g. "03001234567" -> every order is also sent here ("" = off)

// Online payment details shown to the customer
const PAYMENT_ACCOUNTS =
`• JazzCash: 0301 9022815 (Waseem Restaurant)
• EasyPaisa: 0301 9022815 (Waseem Restaurant)`;

const SESSION_DIR = "session_bot";

// ───────────────────────── MENU (edit names & prices) ─────────────────────────
const MENU = [
    { id: 1,  cat: '🍕 PIZZA',            name: 'Chicken Tikka Pizza (Medium)', price: 1100 },
    { id: 2,  cat: '🍕 PIZZA',            name: 'Fajita Pizza (Medium)',        price: 1150 },
    { id: 3,  cat: '🍕 PIZZA',            name: 'Cheese Lovers Pizza (Medium)', price: 1200 },
    { id: 4,  cat: '🍕 PIZZA',            name: 'Chicken Tikka Pizza (Large)',  price: 1600 },
    { id: 5,  cat: '🍔 BURGERS',          name: 'Zinger Burger',                price: 450 },
    { id: 6,  cat: '🍔 BURGERS',          name: 'Beef Smash Burger',            price: 550 },
    { id: 7,  cat: '🍔 BURGERS',          name: 'Double Cheese Burger',         price: 650 },
    { id: 8,  cat: '🍔 BURGERS',          name: 'Crispy Chicken Burger',        price: 400 },
    { id: 9,  cat: '🍟 SIDES & LOCAL',    name: 'French Fries',                 price: 250 },
    { id: 10, cat: '🍟 SIDES & LOCAL',    name: 'Chicken Wings (6 pcs)',        price: 500 },
    { id: 11, cat: '🍟 SIDES & LOCAL',    name: 'Chapli Kabab (2 pcs)',         price: 400 },
    { id: 12, cat: '🥤 DRINKS',           name: 'Soft Drink 1.5L',              price: 220 }
];
const BY_ID = Object.fromEntries(MENU.map(i => [i.id, i]));

// ───────────────────────── HELPERS ─────────────────────────
process.on('uncaughtException', (e) => console.log('⚠️ Uncaught:', e?.stack || e));
process.on('unhandledRejection', (e) => console.log('⚠️ Unhandled:', e?.stack || e));

const TYPING_MS = process.env.BOT_FAST ? 0 : 700;
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const rs = (n) => `Rs ${n.toLocaleString('en-US')}`;

function formatPhoneNumber(phone) {
    let c = String(phone).replace(/[^0-9]/g, '');
    if (c.startsWith('03')) c = '92' + c.substring(1);
    else if (c.startsWith('0092')) c = c.substring(2);
    return c;
}
const DEVICE_ID = formatPhoneNumber(BOT_NUMBER);

async function typing(sock, jid) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        if (TYPING_MS) await delay(TYPING_MS);
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {}
}

const altJid = new Map();
async function send(sock, jid, text) {
    await typing(sock, jid);
    const targets = [jid];
    if (altJid.get(jid)) targets.push(altJid.get(jid));
    for (const t of targets) {
        try {
            await sock.sendMessage(t, { text });
            console.log(`📤 Reply sent to ${t}`);
            return true;
        } catch (e) {
            console.log(`❌ Send failed to ${t}: ${e.message}`);
        }
    }
    return false;
}

// ───────────────────────── MESSAGE TEXTS ─────────────────────────
const welcomeText = () =>
`🍕 *Welcome to ${RESTAURANT_NAME}* 🍔
Fresh, hot and tasty food delivered to your door.

📞 *Call us directly:* ${RESTAURANT_PHONE}
🕘 *Open:* ${OPEN_HOURS}

To order, reply:
*1* or *MENU* – See menu & prices and place an order
*2* – Contact the restaurant`;

const contactText = () =>
`📞 *Contact ${RESTAURANT_NAME}*

Call us: *${RESTAURANT_PHONE}*
Open: ${OPEN_HOURS}

Reply *MENU* anytime to order.`;

function menuText() {
    let out = `📋 *${RESTAURANT_NAME} – MENU*\n`;
    let lastCat = '';
    for (const it of MENU) {
        if (it.cat !== lastCat) { out += `\n*${it.cat}*\n`; lastCat = it.cat; }
        out += `*${it.id}.* ${it.name} — ${rs(it.price)}\n`;
    }
    out += `\n🚚 Delivery fee: ${DELIVERY_FEE ? rs(DELIVERY_FEE) : 'FREE'}`;
    out += `\n\n✍️ *To order, send item numbers.*\nExample: *1x2, 5, 9x2*\n(means 2 of item 1, 1 of item 5, 2 of item 9)\n\n_Reply *0* to cancel._`;
    return out;
}

function cartLines(cart) {
    let sub = 0, lines = [];
    for (const [id, q] of Object.entries(cart)) {
        const it = BY_ID[id];
        const line = it.price * q;
        sub += line;
        lines.push(`• ${q} x ${it.name} — ${rs(line)}`);
    }
    return { lines: lines.join('\n'), sub, total: sub + DELIVERY_FEE };
}

function cartText(cart) {
    const c = cartLines(cart);
    return `🛒 *Your Order*\n\n${c.lines}\n\nSubtotal: ${rs(c.sub)}\nDelivery: ${DELIVERY_FEE ? rs(DELIVERY_FEE) : 'FREE'}\n*Total: ${rs(c.total)}*\n\n` +
           `*1* – Confirm order\n*2* – Add more items\n*3* – Cancel order`;
}

const paymentText = () =>
`💳 *How would you like to pay?*

*1* – Cash on Delivery
*2* – Online Payment (JazzCash / EasyPaisa)`;

// ───────────────────────── ORDER PARSER ─────────────────────────
// "1x2, 5, 9 x 2"  ->  {1:2, 5:1, 9:2}
function parseItems(text) {
    const found = {}, invalid = [];
    const re = /(\d{1,2})\s*(?:x|\*|×)\s*(\d{1,2})|(\d{1,2})/gi;
    let m;
    while ((m = re.exec(text))) {
        const id = parseInt(m[1] || m[3], 10);
        const qty = m[2] ? parseInt(m[2], 10) : 1;
        if (BY_ID[id] && qty >= 1 && qty <= 20) found[id] = (found[id] || 0) + qty;
        else invalid.push(m[0].trim());
    }
    return { found, invalid };
}

// ───────────────────────── CHAT STATE ─────────────────────────
// step: idle | ordering | cart | payment | online_proof | address
const sessions = new Map();
const SESSION_TTL = 3 * 60 * 60 * 1000;

function getSession(jid) {
    let s = sessions.get(jid);
    if (!s || Date.now() - s.t > SESSION_TTL) {
        s = { step: 'idle', cart: {}, pay: '', t: Date.now() };
        sessions.set(jid, s);
    }
    s.t = Date.now();
    return s;
}
function resetSession(s) { s.step = 'idle'; s.cart = {}; s.pay = ''; }

function newOrderId() { return 'WR-' + Math.floor(1000 + Math.random() * 9000); }

async function finishOrder(sock, jid, s, address, customerNumber) {
    const c = cartLines(s.cart);
    const id = newOrderId();
    const payLine = s.pay;

    await send(sock, jid,
`✅ *Order Confirmed!*  (${id})

${c.lines}

Total: *${rs(c.total)}*
Payment: ${payLine}
Address: ${address}

🛵 Your order will reach you in *${DELIVERY_TIME}*.
Need help? Call *${RESTAURANT_PHONE}*.

Thank you for ordering from *${RESTAURANT_NAME}*! ❤️
_Send any message to order again._`);

    if (OWNER_NUMBER) {
        const ownerJid = formatPhoneNumber(OWNER_NUMBER) + '@s.whatsapp.net';
        try {
            await sock.sendMessage(ownerJid, { text:
`🔔 *NEW ORDER ${id}*

${c.lines}

Total: ${rs(c.total)}
Payment: ${payLine}
Address: ${address}
Customer: +${customerNumber}` });
        } catch (e) { console.log('⚠️ Could not notify owner:', e.message); }
    }
    console.log(`🧾 ORDER ${id} | +${customerNumber} | ${rs(c.total)} | ${payLine}`);
    resetSession(s);
}

// ───────────────────────── READ INCOMING ─────────────────────────
function extractInput(msg) {
    let m = msg.message;
    if (!m) return { text: '', hasImage: false };
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
    const text = m.conversation || m.extendedTextMessage?.text ||
                 m.buttonsResponseMessage?.selectedDisplayText ||
                 m.imageMessage?.caption || m.videoMessage?.caption || '';
    return { text: String(text).trim(), hasImage: !!m.imageMessage };
}

// ───────────────────────── MAIN LOGIC ─────────────────────────
async function handleIncoming(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || msg.key.fromMe) return;
    if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    if (!msg.message) return;

    const alt = msg.key.remoteJidAlt || msg.key.participantAlt;
    if (alt) altJid.set(jid, alt);

    const { text, hasImage } = extractInput(msg);
    const t = text.toLowerCase().trim();
    const customerNumber = (alt || jid).split('@')[0].split(':')[0];
    console.log(`📩 From ${jid} | "${text}"${hasImage ? ' [image]' : ''}`);

    try { await sock.readMessages([msg.key]); } catch (e) {}

    const s = getSession(jid);

    // ── global commands ──
    if (s.step !== 'idle' && ['0', 'cancel', 'stop'].includes(t)) {
        resetSession(s);
        return send(sock, jid, `❌ Order cancelled.\n\n${welcomeText()}`);
    }
    if (t === 'menu' && s.step !== 'address') {
        s.step = 'ordering';
        return send(sock, jid, menuText());
    }

    switch (s.step) {

        case 'idle':
            if (t === '1') { s.step = 'ordering'; return send(sock, jid, menuText()); }
            if (t === '2' || t === 'contact' || t === 'call') return send(sock, jid, contactText());
            return send(sock, jid, welcomeText());

        case 'ordering': {
            const { found, invalid } = parseItems(text);
            if (!Object.keys(found).length) {
                return send(sock, jid, `⚠️ I could not find any valid item number.\n\nPlease send item numbers from the menu, for example: *1x2, 5, 9*\n\nReply *MENU* to see the menu again or *0* to cancel.`);
            }
            for (const [id, q] of Object.entries(found)) s.cart[id] = (s.cart[id] || 0) + q;
            s.step = 'cart';
            const warn = invalid.length ? `⚠️ Ignored invalid: ${invalid.join(', ')}\n\n` : '';
            return send(sock, jid, warn + cartText(s.cart));
        }

        case 'cart':
            if (['1', 'confirm', 'yes', 'ok'].includes(t)) { s.step = 'payment'; return send(sock, jid, paymentText()); }
            if (['2', 'add', 'more'].includes(t)) {
                s.step = 'ordering';
                return send(sock, jid, `➕ Send the extra item numbers (example: *9x2, 12*).\nReply *MENU* to see the menu again.`);
            }
            if (['3', 'no'].includes(t)) {
                resetSession(s);
                return send(sock, jid, `❌ Order cancelled.\n\n${welcomeText()}`);
            }
            return send(sock, jid, `Please reply with:\n*1* – Confirm order\n*2* – Add more items\n*3* – Cancel order`);

        case 'payment':
            if (['1', 'cash', 'cod', 'cash on delivery'].includes(t)) {
                s.pay = 'Cash on Delivery';
                s.step = 'address';
                return send(sock, jid, `💵 Cash on Delivery selected.\n\n📍 Please send your *full delivery address* (area, street, house number, landmark).`);
            }
            if (['2', 'online', 'jazzcash', 'easypaisa'].includes(t)) {
                s.step = 'online_proof';
                const total = cartLines(s.cart).total;
                return send(sock, jid, `💳 *Online Payment*\n\nPlease send *${rs(total)}* to:\n${PAYMENT_ACCOUNTS}\n\nThen send the *payment screenshot* here (or type *PAID*).`);
            }
            return send(sock, jid, `Please reply with:\n*1* – Cash on Delivery\n*2* – Online Payment`);

        case 'online_proof':
            if (hasImage || ['paid', 'done', 'sent'].includes(t)) {
                s.pay = 'Online Payment (screenshot received – to be verified)';
                s.step = 'address';
                return send(sock, jid, `✅ Payment received, thank you!\n\n📍 Now please send your *full delivery address* (area, street, house number, landmark).`);
            }
            return send(sock, jid, `Please send the *payment screenshot* (or type *PAID* after paying).\nReply *0* to cancel.`);

        case 'address':
            if (text.length < 8) {
                return send(sock, jid, `📍 Please send your *complete address* so the rider can find you (area, street, house number, landmark).`);
            }
            return finishOrder(sock, jid, s, text, customerNumber);
    }
}

// ───────────────────────── WHATSAPP ENGINE ─────────────────────────
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);
    let pairingCodeRequested = false;

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`🔔 messages.upsert type=${type} count=${messages.length}`);
        for (const msg of messages) {
            try {
                if (type !== 'notify') {
                    const ts = Number(msg.messageTimestamp || 0);
                    if (!ts || Date.now() / 1000 - ts > 60) continue;
                }
                await handleIncoming(sock, msg);
            } catch (e) {
                console.log('❌ Handler error:', e?.stack || e);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !sock.authState.creds.registered) {
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log('\n📷 SCAN QR: open this link and scan it (WhatsApp > Linked Devices > Link a device):');
            console.log(qrLink + '\n');
            if (qrcodeTerminal) qrcodeTerminal.generate(qr, { small: true });

            if (!pairingCodeRequested) {
                pairingCodeRequested = true;
                setTimeout(async () => {
                    try {
                        console.log(`⏳ Requesting pairing code for ${DEVICE_ID} ...`);
                        const code = await sock.requestPairingCode(DEVICE_ID);
                        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                        console.log(`\n🔗 PAIRING CODE: ${formatted}`);
                        console.log('   WhatsApp > Linked Devices > Link a device > "Link with phone number instead" > enter the code\n');
                    } catch (err) {
                        console.error('❌ Pairing code error:', err.message);
                    }
                }, 1000);
            }
        }

        if (connection === 'open') {
            console.log(`✅ Connected as ${DEVICE_ID}. ${RESTAURANT_NAME} bot is LIVE. Send "Hi" from another phone.`);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔌 Connection closed (code ${reason})`);
            if (reason === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Clearing session and starting fresh pairing...');
                try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
            } else {
                console.log('🔄 Reconnecting...');
            }
            setTimeout(connectWhatsApp, 4000);
        }
    });
}

if (require.main === module) {
    console.log(`🌟 ${RESTAURANT_NAME} bot v4 starting for ${BOT_NUMBER} (${DEVICE_ID})`);
    connectWhatsApp();
    setInterval(() => console.log(`💓 alive ${new Date().toISOString()}`), 10 * 60 * 1000);
}

module.exports = { handleIncoming, parseItems };
