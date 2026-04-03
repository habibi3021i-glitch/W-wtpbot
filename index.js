 const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// 🌟 Github Secrets سے Firebase URL
const FIREBASE_URL = process.env.FIREBASE_URL;

// آپ کی ڈیوائسز (جتنے چاہیں ایڈ کریں)
const DEVICES = ['device_1', 'device_2'];

async function getSettings() {
  const res = await fetch(`${FIREBASE_URL}/settings.json`);
  const data = await res.json();
  return data || { messageTemplate: "Test Message", dailyLimitPerDevice: 30, delayMinutes: 60 };
}

async function getAndLockPendingNumber() {
  const res = await fetch(`${FIREBASE_URL}/numbers.json`);
  const numbers = await res.json();
  if (!numbers) return null;
  
  for (const phone in numbers) {
    if (numbers[phone].status === 'pending') {
      await fetch(`${FIREBASE_URL}/numbers/${phone}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'processing' })
      });
      return phone;
    }
  }
  return null;
}

async function markNumberAsSent(phone, deviceId) {
  await fetch(`${FIREBASE_URL}/numbers/${phone}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'sent', sentBy: deviceId, timestamp: new Date().toISOString() })
  });
}

async function checkAndUpdateDeviceLimit(deviceId, maxLimit) {
  const today = new Date().toISOString().split('T')[0];
  const res = await fetch(`${FIREBASE_URL}/devices_stats/${deviceId}.json`);
  let stats = await res.json();
  
  if (!stats || stats.date !== today) {
    stats = { sentToday: 0, date: today };
  }
  
  if (stats.sentToday >= maxLimit) {
    return false;
  }
  
  stats.sentToday += 1;
  await fetch(`${FIREBASE_URL}/devices_stats/${deviceId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stats)
  });
  
  return true;
}

async function startBroadcastWorker(sock, deviceId) {
  console.log(`[${deviceId}] 🟢 ورکر ایکٹیویٹ ہو گیا ہے۔`);
  
  const runWorker = async () => {
    try {
      const settings = await getSettings();
      const canSend = await checkAndUpdateDeviceLimit(deviceId, settings.dailyLimitPerDevice);
      
      if (!canSend) {
        console.log(`[${deviceId}] 🛑 آج کی لمٹ پوری ہو گئی۔ ورکر کل تک سو رہا ہے...`);
        setTimeout(runWorker, 12 * 60 * 60 * 1000);
        return;
      }
      
      const phone = await getAndLockPendingNumber();
      
      if (!phone) {
        console.log(`[${deviceId}] 📂 کوئی پینڈنگ نمبر نہیں۔ تھوڑی دیر بعد دوبارہ چیک کرے گا...`);
        setTimeout(runWorker, 10 * 60 * 1000);
        return;
      }
      
      const jid = phone + "@s.whatsapp.net";
      await sock.sendMessage(jid, { text: settings.messageTemplate });
      
      await markNumberAsSent(phone, deviceId);
      console.log(`[${deviceId}] ✅ میسج سینڈ ہو گیا: ${phone}`);
      
      const delayMs = settings.delayMinutes * 60 * 1000;
      console.log(`[${deviceId}] ⏳ اگلا میسج ${settings.delayMinutes} منٹ بعد جائے گا...`);
      setTimeout(runWorker, delayMs);
      
    } catch (error) {
      console.log(`[${deviceId}] ❌ ایرر:`, error);
      setTimeout(runWorker, 5 * 60 * 1000);
    }
  };
  
  runWorker();
}

async function startDevice(deviceId) {
  const sessionDir = `sessions_${deviceId}`;
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: [`W-Broadcaster (${deviceId})`, "Chrome", "1.0"]
  });
  
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      console.log(`\n=============================================================`);
      console.log(`📱 [${deviceId.toUpperCase()}] SCAN TO CONNECT`);
      console.log(`🔗 LINK: 👉 ${qrImageUrl}`);
      console.log(`=============================================================\n`);
    }
    
    if (connection === 'open') {
      console.log(`✅ [${deviceId.toUpperCase()}] IS READY!`);
      startBroadcastWorker(sock, deviceId);
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`🔄 [${deviceId}] Reconnecting...`);
        startDevice(deviceId);
      } else {
        console.log(`❌ [${deviceId}] Logged out. Delete "${sessionDir}" and rescan.`);
      }
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
}

async function startAllDevices() {
  if (!FIREBASE_URL) {
    console.log("❌ ERROR: FIREBASE_URL is missing!");
    process.exit(1);
  }
  
  console.log("🚀 Starting SaaS Broadcaster...\n");
  for (const device of DEVICES) {
    startDevice(device);
    await new Promise(res => setTimeout(res, 5000));
  }
}

startAllDevices();
