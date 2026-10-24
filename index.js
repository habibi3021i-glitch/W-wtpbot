// ============================================================
//  WhatsApp Button Agent  (no database, no Firebase)
//  Number : 03019022815  ->  923019022815
//  Install: npm i @whiskeysockets/baileys pino qrcode-terminal
//  Run    : node wtpbot.js
// ============================================================
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

let qrcodeTerminal = null;
try { qrcodeTerminal = require('qrcode-terminal'); } catch (e) {}

// ───────────────────────── CONFIG ─────────────────────────
const BOT_NUMBER = "03019022815";
const BRAND = "Demo Assistant";
const SESSION_DIR = "session_bot";

// ───────────────────────── MENU TREE (edit freely) ─────────────────────────
// Rules: max 3 buttons per screen. "children" are the next steps.
// Back / Main Menu buttons are added automatically.
const NODES = {
    main: {
        label: 'Main Menu',
        text: `Welcome to *${BRAND}* 👋\nHow can I help you today?`,
        children: ['services', 'support', 'about']
    },
    services: {
        label: 'Our Services', parent: 'main',
        text: '*Our Services*\nWhat are you interested in?',
        children: ['webapps', 'games']
    },
    webapps: {
        label: 'Web & Apps', parent: 'services',
        text: '*Web & Apps*\n\n• Websites & web apps\n• Android / iOS apps\n• Admin dashboards\n\nSend us your idea and we will build it.',
        children: []
    },
    games: {
        label: 'Games', parent: 'services',
        text: '*Games*\n\n• Mobile games\n• Puzzle & arcade games\n• Game backends and admin panels',
        children: []
    },
    support: {
        label: 'Talk to Support', parent: 'main',
        text: '*Support*\nHow would you like to get help?',
        children: ['contact', 'issue']
    },
    contact: {
        label: 'Contact Info', parent: 'support',
        text: '*Contact Info*\n\n📞 Phone: 0301 9022815\n🕘 Hours: 9 AM – 9 PM',
        children: []
    },
    issue: {
        label: 'Report an Issue', parent: 'support',
        text: '*Report an Issue*\n\nPlease type your problem in one message and our team will reply soon. 📝',
        children: []
    },
    about: {
        label: 'About Us', parent: 'main',
        text: `*About ${BRAND}*\n\nA WhatsApp assistant that answers instantly and guides you step by step with quick-reply buttons.`,
        children: []
    }
};

// Build the option list for a screen: [{id, label}]
function optionsFor(nodeId) {
    const node = NODES[nodeId];
    const opts = node.children.map(id => ({ id, label: NODES[id].label }));
    if (nodeId !== 'main') {
        if (opts.length < 3) opts.push({ id: node.parent, label: node.parent === 'main' ? 'Main Menu' : '⬅ Back' });
        if (opts.length < 3 && node.parent !== 'main') opts.push({ id: 'main', label: 'Main Menu' });
    }
    return opts.slice(0, 3);
}

// ───────────────────────── HELPERS ─────────────────────────
process.on('uncaughtException', (e) => console.log('⚠️ Uncaught:', e?.message));
process.on('unhandledRejection', (e) => console.log('⚠️ Unhandled:', e?.message || e));

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const chatState = new Map(); // jid -> current node id

function formatPhoneNumber(phone) {
    let c = String(phone).replace(/[^0-9]/g, '');
    if (c.startsWith('03')) c = '92' + c.substring(1);
    else if (c.startsWith('0092')) c = c.substring(2);
    return c;
}
const DEVICE_ID = formatPhoneNumber(BOT_NUMBER);

async function typing(sock, jid, ms = 900) {
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await delay(ms);
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {}
}

// ───────────────────────── SEND A SCREEN ─────────────────────────
// The numbered list is ALWAYS inside the message text, so even if
// WhatsApp does not draw the buttons, the user can reply 1 / 2 / 3.
async function sendScreen(sock, jid, nodeId) {
    chatState.set(jid, nodeId);
    const node = NODES[nodeId];
    const opts = optionsFor(nodeId);

    const list = opts.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
    const hint = nodeId === 'main' ? '' : '\n_Reply 0 for Main Menu_';
    const body = `${node.text}\n\n${list}\n\n_Tap a button or reply with a number._${hint}`;

    await typing(sock, jid);

    try {
        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        body: { text: body },
                        footer: { text: BRAND },
                        header: { title: '', subtitle: '', hasMediaAttachment: false },
                        nativeFlowMessage: {
                            buttons: opts.map(o => ({
                                name: 'quick_reply',
                                buttonParamsJson: JSON.stringify({ display_text: o.label, id: 'go:' + o.id })
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
        console.log('⚠️ Buttons failed, sending plain text:', e.message);
        await sock.sendMessage(jid, { text: body });
    }
}

// ───────────────────────── READ INCOMING ─────────────────────────
function extractInput(msg) {
    let m = msg.message;
    if (!m) return { text: '', id: '' };
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.documentWithCaptionMessage?.message || m;

    let id = '';
    const nf = m.interactiveResponseMessage?.nativeFlowResponseMessage;
    if (nf?.paramsJson) { try { id = JSON.parse(nf.paramsJson).id || ''; } catch (e) {} }
    if (!id) id = m.buttonsResponseMessage?.selectedButtonId || m.templateButtonReplyMessage?.selectedId || '';

    const text = m.conversation || m.extendedTextMessage?.text ||
                 m.buttonsResponseMessage?.selectedDisplayText ||
                 m.interactiveResponseMessage?.body?.text || '';
    return { text: String(text).trim(), id };
}

async function handleIncoming(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || msg.key.fromMe || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;

    const { text, id } = extractInput(msg);
    if (!text && !id) return;

    console.log(`📩 ${jid} -> ${id || text}`);
    try { await sock.readMessages([msg.key]); } catch (e) {}

    // 1) Button tapped
    if (id.startsWith('go:')) {
        const target = id.slice(3);
        if (NODES[target]) return sendScreen(sock, jid, target);
    }

    const t = text.toLowerCase();
    const current = chatState.get(jid);

    // 2) Typed number for the current screen
    if (current && /^[0-9]$/.test(t)) {
        if (t === '0') return sendScreen(sock, jid, 'main');
        const opt = optionsFor(current)[parseInt(t, 10) - 1];
        if (opt) return sendScreen(sock, jid, opt.id);
    }

    // 3) Typed label of an option (e.g. "about us")
    if (current) {
        const byLabel = optionsFor(current).find(o => o.label.toLowerCase().replace('⬅ ', '') === t);
        if (byLabel) return sendScreen(sock, jid, byLabel.id);
    }

    // 4) Anything else (hi, hello, menu, random text) -> main menu
    return sendScreen(sock, jid, 'main');
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
        syncFullHistory: false
    });

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

        // Not linked yet -> show QR link + pairing code in the logs
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
            console.log(`✅ Connected as ${DEVICE_ID}. Agent is live. Send "Hi" to this number from another phone.`);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Clearing session and starting fresh pairing...');
                try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
            } else {
                console.log('🔄 Connection closed, reconnecting...');
            }
            setTimeout(connectWhatsApp, 4000);
        }
    });
}

console.log(`🌟 ${BRAND} starting for ${BOT_NUMBER} (${DEVICE_ID})`);
connectWhatsApp();
