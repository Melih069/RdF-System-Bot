require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_FILE = path.join(DATA_DIR, 'public-url.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 8080);
const LOCAL_URL = process.env.PUBLIC_TUNNEL_TARGET || `http://localhost:${PORT}`;
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_TOKEN || '').trim();
function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.channels || typeof cfg.channels !== 'object') cfg.channels = {};
    return cfg;
  } catch {
    return { channels: {} };
  }
}
function getPublicLinkChannelId() {
  const cfg = readConfig();
  return String(process.env.PUBLIC_LINK_CHANNEL_ID || cfg.channels.public_link || '').trim();
}
let PUBLIC_LINK_MESSAGE_ID = String(process.env.PUBLIC_LINK_MESSAGE_ID || '').trim();
const PUBLIC_LINK_TITLE = process.env.PUBLIC_LINK_TITLE || '🌐 RdF Dashboard';
const PUBLIC_LINK_NOTE = process.env.PUBLIC_LINK_NOTE || '';
const PUBLIC_LINK_MENTION = process.env.PUBLIC_LINK_MENTION || '';
const DASHBOARD_TOKEN = String(process.env.DASHBOARD_TOKEN || process.env.RECEIVER_SECRET || '').trim();

fs.mkdirSync(DATA_DIR, { recursive: true });

function readPublic() {
  try { return JSON.parse(fs.readFileSync(PUBLIC_FILE, 'utf8')); } catch { return {}; }
}
function writePublic(patch) {
  const current = readPublic();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  fs.writeFileSync(PUBLIC_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
function log(...args) { console.log('[public]', ...args); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForDashboard() {
  const headers = DASHBOARD_TOKEN ? { Authorization: `Bearer ${DASHBOARD_TOKEN}` } : {};
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${LOCAL_URL}/api/health`, { headers });
      if (res.ok) return true;
    } catch (_) {}
    await sleep(1000);
  }
  throw new Error(`Dashboard unter ${LOCAL_URL} nicht erreichbar.`);
}

function discordPayload(url, status = 'online') {
  const online = status === 'online' && url;
  return {
    content: PUBLIC_LINK_MENTION || undefined,
    embeds: [
      {
        title: PUBLIC_LINK_TITLE,
        description: online
          ? `**Aktueller Dashboard-Link:**
${url}`
          : `**Status:** Offline`,
        color: online ? 0xD4AF37 : 0x8B0000,
        fields: [
          { name: 'Status', value: online ? '🟢 Online' : '🔴 Offline', inline: true },
          { name: 'Aktualisiert', value: `<t:${Math.floor(Date.now()/1000)}:R>`, inline: true }
        ],
        footer: { text: 'RdF • Public Link Auto-Updater' }
      }
    ],
    allowed_mentions: PUBLIC_LINK_MENTION ? undefined : { parse: [] }
  };
}

async function discordRequest(method, route, body) {
  const res = await fetch(`https://discord.com/api/v10${route}`, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${JSON.stringify(json)}`);
  return json;
}


async function findExistingPublicLinkMessage(channelId) {
  try {
    const messages = await discordRequest('GET', `/channels/${channelId}/messages?limit=50`);
    const own = Array.isArray(messages) ? messages.find(msg => {
      const title = msg.embeds?.[0]?.title || '';
      const footer = msg.embeds?.[0]?.footer?.text || '';
      const desc = msg.embeds?.[0]?.description || '';
      const botAuthor = msg.author?.bot;
      return botAuthor && (
        title === PUBLIC_LINK_TITLE
        || title.includes('Family Control Dashboard')
        || title.includes('Reyes del Fuego')
        || title.includes('RdF Dashboard')
        || footer.includes('Public Link Auto-Updater')
        || footer.includes('Family Control')
        || desc.includes('Aktueller Link:')
        || desc.includes('Aktueller Dashboard-Link:')
      );
    }) : null;
    return own || null;
  } catch (err) {
    log('Konnte bestehende Public-Link-Nachricht nicht suchen:', err.message);
    return null;
  }
}

async function updateDiscordMessage(url, status = 'online') {
  const PUBLIC_LINK_CHANNEL_ID = getPublicLinkChannelId();
  if (!DISCORD_BOT_TOKEN || !PUBLIC_LINK_CHANNEL_ID) {
    log('Discord Update übersprungen: DISCORD_BOT_TOKEN/BOT_TOKEN und PUBLIC_LINK_CHANNEL_ID oder /set kanal public_link fehlen.');
    return;
  }
  const payload = discordPayload(url, status);
  const saved = readPublic();
  if (!PUBLIC_LINK_MESSAGE_ID && saved.messageId) PUBLIC_LINK_MESSAGE_ID = String(saved.messageId);
  if (!PUBLIC_LINK_MESSAGE_ID && saved.channelId && String(saved.channelId) !== String(PUBLIC_LINK_CHANNEL_ID)) {
    // Kanal wurde geändert; alte Message-ID nicht verwenden.
    PUBLIC_LINK_MESSAGE_ID = '';
  }

  try {
    if (PUBLIC_LINK_MESSAGE_ID) {
      const msg = await discordRequest('PATCH', `/channels/${PUBLIC_LINK_CHANNEL_ID}/messages/${PUBLIC_LINK_MESSAGE_ID}`, payload);
      writePublic({ messageId: msg.id, channelId: PUBLIC_LINK_CHANNEL_ID, discordUpdatedAt: Date.now() });
      log('Discord-Link-Nachricht aktualisiert:', msg.id);
      return;
    }
  } catch (err) {
    log('PATCH fehlgeschlagen, suche bestehende Link-Nachricht:', err.message);
    PUBLIC_LINK_MESSAGE_ID = '';
  }

  const existing = await findExistingPublicLinkMessage(PUBLIC_LINK_CHANNEL_ID);
  if (existing?.id) {
    const msg = await discordRequest('PATCH', `/channels/${PUBLIC_LINK_CHANNEL_ID}/messages/${existing.id}`, payload);
    PUBLIC_LINK_MESSAGE_ID = msg.id;
    writePublic({ messageId: msg.id, channelId: PUBLIC_LINK_CHANNEL_ID, discordUpdatedAt: Date.now() });
    log('Bestehende Discord-Link-Nachricht gefunden und aktualisiert:', msg.id);
    return;
  }

  const msg = await discordRequest('POST', `/channels/${PUBLIC_LINK_CHANNEL_ID}/messages`, payload);
  PUBLIC_LINK_MESSAGE_ID = msg.id;
  writePublic({ messageId: msg.id, channelId: PUBLIC_LINK_CHANNEL_ID, discordUpdatedAt: Date.now() });
  log('Discord-Link-Nachricht erstellt:', msg.id);
  log('Trage diese ID optional in .env ein: PUBLIC_LINK_MESSAGE_ID=' + msg.id);
}

async function notifyDashboard(url, status = 'online') {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (DASHBOARD_TOKEN) headers.Authorization = `Bearer ${DASHBOARD_TOKEN}`;
    await fetch(`${LOCAL_URL}/api/public-url`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, status, source: 'cloudflared', by: 'start-public', messageId: PUBLIC_LINK_MESSAGE_ID, channelId: getPublicLinkChannelId() })
    });
  } catch (err) {
    log('Dashboard konnte public-url nicht übernehmen:', err.message);
  }
}

function startProcess(name, cmd, args, opts = {}) {
  log(`Starte ${name}:`, cmd, args.join(' '));
  const child = spawn(cmd, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`));
  child.on('exit', code => log(`${name} beendet mit Code`, code));
  return child;
}

async function main() {
  writePublic({ url: '', status: 'starting', target: LOCAL_URL });

  const dashboard = startProcess('system', process.execPath, ['supervisor.js']);
  await waitForDashboard();
  log('Dashboard erreichbar:', LOCAL_URL);

  const tunnel = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', LOCAL_URL, '--no-autoupdate'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let currentUrl = '';
  let updatedOnce = false;
  const handleOutput = async buffer => {
    const text = String(buffer);
    process.stdout.write(`[cloudflared] ${text}`);
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (!match) return;
    const url = match[0];
    if (url === currentUrl && updatedOnce) return;
    currentUrl = url;
    updatedOnce = true;
    writePublic({ url, status: 'online', target: LOCAL_URL });
    await notifyDashboard(url, 'online');
    await updateDiscordMessage(url, 'online').catch(err => log('Discord Update Fehler:', err.message));
    log('Öffentlicher Link:', url);
  };

  tunnel.stdout.on('data', handleOutput);
  tunnel.stderr.on('data', handleOutput);
  tunnel.on('error', err => {
    log('cloudflared konnte nicht gestartet werden:', err.message);
    log('Installiere cloudflared oder setze CLOUDFLARED_BIN in der .env.');
  });
  tunnel.on('exit', async code => {
    log('cloudflared beendet mit Code', code);
    writePublic({ status: 'offline' });
    await notifyDashboard(currentUrl, 'offline');
    await updateDiscordMessage(currentUrl, 'offline').catch(err => log('Discord Offline-Update Fehler:', err.message));
  });

  const shutdown = async () => {
    log('Beende Public Dashboard...');
    writePublic({ status: 'offline' });
    await notifyDashboard(currentUrl, 'offline');
    await updateDiscordMessage(currentUrl, 'offline').catch(() => {});
    tunnel.kill('SIGTERM');
    dashboard.kill('SIGTERM');
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[public] Fehler:', err);
  writePublic({ status: 'error', error: err.message });
  process.exit(1);
});
