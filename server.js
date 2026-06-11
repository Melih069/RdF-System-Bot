require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { REST, Routes } = require('discord.js');

const PORT = Number(process.env.PORT || 8080);
const TOKEN = String(process.env.DASHBOARD_TOKEN || process.env.RECEIVER_SECRET || '').trim();
const BOT_SYNC_SECRET = String(process.env.BOT_SYNC_SECRET || process.env.RECEIVER_SECRET || '').trim();
const DATA = path.join(__dirname, 'data');
const BACKUPS = path.join(__dirname, 'backups');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

const BOT_BRIDGE_URL = String(process.env.BOT_BRIDGE_URL || `http://127.0.0.1:${Number(process.env.CASHBOX_WEBHOOK_PORT || process.env.RECEIVER_PORT || 3000)}/api/web-sync`).trim();
const BOT_BRIDGE_SECRET = String(process.env.BOT_BRIDGE_SECRET || process.env.CASHBOX_WEBHOOK_SECRET || process.env.RECEIVER_SECRET || '').trim();
async function notifyBot(kind = 'all', meta = {}) {
  if (!BOT_BRIDGE_URL) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (BOT_BRIDGE_SECRET) headers['x-web-sync-secret'] = BOT_BRIDGE_SECRET;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    await fetch(BOT_BRIDGE_URL, { method: 'POST', headers, body: JSON.stringify({ kind, meta, at: Date.now() }), signal: controller.signal });
    clearTimeout(timer);
  } catch (err) {
    console.warn('[bot-bridge] Bot-Sync konnte nicht ausgeführt werden:', err.message || err);
  }
}
function changed(kind, auditItem) { emitUpdate(kind, auditItem || {}); notifyBot(kind, auditItem || {}); }



// =========================================================
// DISCORD OAUTH + ROLE PERMISSIONS
// =========================================================
const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET || '').trim();
const DISCORD_GUILD_ID = String(process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '').trim();
const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_TOKEN || '').trim();
const SESSION_SECRET = String(process.env.SESSION_SECRET || process.env.DASHBOARD_TOKEN || 'change-me-local-secret').trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || '').trim();
// Standard: Discord-Redirect wird aus dem aktuellen Host erkannt.
// Alte/statische .env-Redirects werden nur benutzt, wenn USE_ENV_DISCORD_REDIRECT=true gesetzt ist.
const USE_ENV_DISCORD_REDIRECT = String(process.env.USE_ENV_DISCORD_REDIRECT || 'false').toLowerCase() === 'true';
const REQUIRE_DISCORD_LOGIN = String(process.env.REQUIRE_DISCORD_LOGIN || 'true').toLowerCase() !== 'false';

function csvEnv(...names) {
  return names.flatMap(name => String(process.env[name] || '').split(','))
    .map(x => x.trim()).filter(Boolean);
}
const ROLE_RULES = {
  leadership: csvEnv('ROLE_LEADERSHIP_IDS', 'LEADERSHIP_ROLE_IDS', 'LEADERSHIP_ROLE_ID'),
  routenverwaltung: csvEnv('ROLE_ROUTENVERWALTUNG_IDS', 'ROUTENVERWALTUNG_ROLE_IDS', 'ROUTENVERWALTUNG_ROLE_ID'),
  routenverwaltungLeitung: csvEnv('ROLE_ROUTENVERWALTUNG_LEITUNG_IDS', 'ROUTENVERWALTUNG_LEITUNG_ROLE_IDS', 'ROUTENVERWALTUNG_LEITUNG_ROLE_ID'),
  routen: csvEnv('ROLE_ROUTEN_IDS', 'ROUTEN_ROLE_IDS', 'ROUTEN_ROLE_ID'),
};
function hasAnyRole(user, ids = []) { return ids.some(id => user?.roles?.includes(id)); }

function getAdminUserIdsFallback() {
  const fromEnv = [
    process.env.ADMIN_USER_IDS,
    process.env.OWNER_IDS,
    process.env.LEADERSHIP_USER_IDS,
    process.env.DASHBOARD_ADMIN_IDS
  ].filter(Boolean).join(',');
  const ids = new Set(String(fromEnv || '').split(/[,\n ]+/).map(x => x.trim()).filter(Boolean));
  try {
    const cfg = readJson('config', {});
    for (const key of ['adminUserIds','ownerIds','leadershipUserIds','dashboardAdminIds']) {
      const value = cfg?.[key] || cfg?.roles?.[key] || cfg?.web?.[key];
      if (Array.isArray(value)) value.forEach(v => ids.add(String(v).trim()));
      else if (value) String(value).split(/[,\n ]+/).forEach(v => v.trim() && ids.add(v.trim()));
    }
  } catch {}
  // Merve/Melih Hauptaccount aus Screenshot als lokaler Fallback für dieses Dashboard
  ids.add('447008003170762753');
  return ids;
}
function isAdminUserIdFallback(user) {
  const id = String(user?.id || user?.discordId || '').trim();
  return !!id && getAdminUserIdsFallback().has(id);
}


function splitRoleIdList(value) {
  if (Array.isArray(value)) return value.map(String).map(x => x.trim()).filter(Boolean);
  return String(value || '').split(/[,\n ]+/).map(x => x.trim()).filter(Boolean);
}
function getLiveRoleRules() {
  const cfg = readJson('config', {});
  const roles = cfg.roles || {};
  const permissions = roles.permissions || {};
  const base = ROLE_RULES || {};
  return {
    leadership: [...new Set([...(base.leadership || []), ...splitRoleIdList(roles.leadership)])],
    routenverwaltung: [...new Set([...(base.routenverwaltung || []), ...splitRoleIdList(roles.routenverwaltung)])],
    routenverwaltungLeitung: [...new Set([...(base.routenverwaltungLeitung || []), ...splitRoleIdList(roles.routenverwaltungLeitung)])],
    routen: [...new Set([...(base.routen || []), ...splitRoleIdList(roles.routen)])],
    permissions
  };
}
function hasAnyDynamicPermissionRole(user, permissionKey, liveRules = null) {
  const rules = liveRules || getLiveRoleRules();
  const roles = rules.permissions || {};
  const direct = splitRoleIdList(roles[permissionKey]);
  const aliases = {
    configWrite: ['config_manage','settings_manage','admin'],
    configRead: ['config_manage','dashboard_view','admin'],
    sanctionsWrite: ['sanction_manage','sanctions_manage','admin'],
    sanctionWrite: ['sanction_manage','sanctions_manage','admin'],
    sanctionApprove: ['sanction_approve','admin'],
    abgabenWrite: ['abgaben_manage','abgabe_manage','admin'],
    cashboxWrite: ['cashbox_manage','kasse_manage','admin'],
    inventoryWriteAny: ['inventory_manage','lager_manage','admin'],
    absenceManage: ['absence_manage','abmeldungen_manage','admin'],
    attendanceManage: ['attendance_manage','wache_manage','admin'],
    rollbackManage: ['rollback_manage','admin'],
    dashboard_view: ['dashboard_view','admin'],
    admin: ['admin']
  };
  for (const alias of [permissionKey, ...(aliases[permissionKey] || [])]) {
    for (const id of splitRoleIdList(roles[alias])) direct.push(id);
  }
  return hasAnyRole(user, [...new Set(direct)]);
}
function moduleAllowedByDynamicRole(user, moduleKey, defaultValue, liveRules = null) {
  const rules = liveRules || getLiveRoleRules();
  const roles = rules.permissions || {};
  if (hasAnyDynamicPermissionRole(user, 'admin', rules)) return true;
  if (hasAnyDynamicPermissionRole(user, 'dashboard_view', rules)) return true;
  const moduleIds = splitRoleIdList(roles['module_' + moduleKey] || roles[moduleKey]);
  if (moduleIds.length) return hasAnyRole(user, moduleIds);
  return !!defaultValue;
}

function buildPermissions(user) {
  const liveRules = getLiveRoleRules();
  const isAdminUser = isAdminUserIdFallback(user) || hasAnyDynamicPermissionRole(user, 'admin', liveRules);
  const isLeadership = isAdminUser || hasAnyRole(user, liveRules.leadership);
  const isRoutenVerwaltung = isAdminUser || hasAnyRole(user, liveRules.routenverwaltung);
  const isRoutenLeitung = isAdminUser || hasAnyRole(user, liveRules.routenverwaltungLeitung);
  const isRouten = isAdminUser || hasAnyRole(user, liveRules.routen);
  const canAbgaben = isLeadership || isRoutenVerwaltung || isRoutenLeitung || hasAnyDynamicPermissionRole(user, 'abgabenWrite', liveRules);
  const canTermsCreate = isLeadership || isRoutenVerwaltung || isRoutenLeitung;
  const canConfig = isLeadership || hasAnyDynamicPermissionRole(user, 'configWrite', liveRules);
  const canAdminPanel = isAdminUser;
  const canSanctions = isLeadership || hasAnyDynamicPermissionRole(user, 'sanctionsWrite', liveRules);
  const canAbsences = isLeadership || hasAnyDynamicPermissionRole(user, 'absenceManage', liveRules);
  const canAttendance = isLeadership || isRouten || hasAnyDynamicPermissionRole(user, 'attendanceManage', liveRules);
  const canCashbox = isLeadership || hasAnyDynamicPermissionRole(user, 'cashboxWrite', liveRules);
  const canInventoryAny = isLeadership || hasAnyDynamicPermissionRole(user, 'inventoryWriteAny', liveRules);
  const baseModules = {
    overview: true, map: true, families: true, phonebook: true, members: true,
    abgaben: canAbgaben,
    abgabenStats: true,
    sanctions: true,
    blood: true,
    cashbox: canCashbox,
    inventory: true,
    terms: true,
    wache: canAttendance,
    absences: true,
    config: canConfig,
    settings: false,
    monitoring: isLeadership || canConfig || canSanctions,
    leader_all: isLeadership
  };
  const modules = {};
  for (const [key, value] of Object.entries(baseModules)) {
    modules[key] = key === 'overview' ? true : moduleAllowedByDynamicRole(user, key, value, liveRules);
  }
  // Harte UX-Regel: Zentrale Verwaltung nur für Leaderschaft/Admins; alter Einstellungs-Tab bleibt ausgeblendet.
  modules.leader_all = isLeadership;
  modules.settings = false;
  return {
    roleGroups: { isAdminUser, isLeadership, isRoutenVerwaltung, isRoutenLeitung, isRouten },
    modules,
    actions: {
      dashboardAdmin: isAdminUser,
      admin: isAdminUser,
      dashboard_view: true,
      familiesWrite: isLeadership || isRoutenVerwaltung || isRoutenLeitung,
      membersWrite: isLeadership,
      abgabenWrite: canAbgaben,
      sanctionsWrite: canSanctions,
      sanctionWrite: canSanctions,
      sanctionApprove: isLeadership || hasAnyDynamicPermissionRole(user, 'sanctionApprove', liveRules),
      cashboxWrite: canCashbox,
      inventoryWriteOwn: true,
      inventoryWriteAny: canInventoryAny,
      termsCreate: canTermsCreate,
      absencesCreate: true,
      absenceManage: canAbsences,
      attendanceManage: canAttendance,
      rollbackManage: isAdminUser || hasAnyDynamicPermissionRole(user, 'rollbackManage', liveRules),
      configRead: canConfig,
      configWrite: canConfig,
    }
  };
}
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex'); }
function makeSessionId() { return crypto.randomBytes(24).toString('hex'); }
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('='); return [decodeURIComponent(v.slice(0, i)), decodeURIComponent(v.slice(i + 1))];
  }));
}
function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return res.setHeader('Set-Cookie', cookie);
  if (Array.isArray(existing)) return res.setHeader('Set-Cookie', [...existing, cookie]);
  return res.setHeader('Set-Cookie', [existing, cookie]);
}
function setCookie(res, name, value, maxAgeSec) {
  // Langes Login-Cookie. Über Cloudflare/HTTPS zusätzlich Secure, damit Safari zuverlässiger speichert.
  const secure = process.env.COOKIE_SECURE === 'true' || String(process.env.PUBLIC_BASE_URL || '').startsWith('https://');
  appendSetCookie(res, `${encodeURIComponent(name)}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}
function clearCookie(res, name) { appendSetCookie(res, `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); }
function getSessionToken(req) { return parseCookies(req).rp_session || ''; }
function readWebSessions() { return readJson('webSessions', { sessions: {} }); }
function writeWebSessions(data) { writeJson('webSessions', data); }
function getDetectedBaseUrl(req) {
  const forwardedHost = req.get('x-forwarded-host');
  const host = forwardedHost || req.get('host');
  const forwardedProto = req.get('x-forwarded-proto');
  let proto = forwardedProto || req.protocol || 'http';
  // Cloudflare/Reverse Proxy: trycloudflare ist immer öffentlich HTTPS, auch wenn Express lokal http sieht.
  if (host && String(host).includes('trycloudflare.com')) proto = 'https';
  return `${proto}://${host}`.replace(/\/$/, '');
}
function getRedirectUri(req) {
  if (USE_ENV_DISCORD_REDIRECT && DISCORD_REDIRECT_URI) return DISCORD_REDIRECT_URI;
  return `${getDetectedBaseUrl(req)}/auth/discord/callback`;
}
async function discordApi(pathname, options = {}) {
  const res = await fetch(`https://discord.com/api/v10${pathname}`, options);
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) throw new Error(json?.message || text || `Discord API ${res.status}`);
  return json;
}
async function exchangeDiscordCode(code, redirectUri) {
  const body = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  return discordApi('/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
}
async function loadDiscordUser(accessToken) {
  return discordApi('/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
}
async function loadGuildMember(userId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) throw new Error('DISCORD_BOT_TOKEN und DISCORD_GUILD_ID fehlen.');
  return discordApi(`/guilds/${DISCORD_GUILD_ID}/members/${userId}`, { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } });
}
function getCurrentUser(req) {
  const raw = getSessionToken(req);
  const [sid, mac] = raw.split('.');
  if (!sid || !mac || sign(sid) !== mac) return null;
  const db = readWebSessions();
  const sess = db.sessions?.[sid];
  if (!sess || Number(sess.expiresAt || 0) < Date.now()) return null;
  return sess.user || null;
}
function requireLogin(req, res, next) {
  const user = getCurrentUser(req);
  if (user) { req.user = user; req.perms = buildPermissions(user); return next(); }
  if (!REQUIRE_DISCORD_LOGIN && !DISCORD_CLIENT_ID) return next();
  return res.status(401).json({ error: 'Bitte mit Discord einloggen.' });
}
function allowTokenOrLogin(req, res, next) {
  const header = req.headers.authorization || '';
  const q = req.query.token || req.body?.token;
  if (TOKEN && (header === `Bearer ${TOKEN}` || q === TOKEN)) {
    req.user = { id: 'token', username: 'Token Login', roles: ROLE_RULES.leadership };
    req.perms = buildPermissions(req.user);
    return next();
  }
  return requireLogin(req, res, next);
}
function requireModule(moduleName) {
  return (req, res, next) => {
    if (!req.perms) req.perms = buildPermissions(req.user);
    if (req.perms.modules?.[moduleName]) return next();
    return res.status(403).json({ error: 'Keine Berechtigung für diesen Bereich.' });
  };
}
function requireAction(actionName) {
  return (req, res, next) => {
    if (!req.perms) req.perms = buildPermissions(req.user);
    if (req.perms.actions?.[actionName]) return next();
    return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
  };
}
function accessLabelForUser(user, permissions = null) {
  const p = permissions || user?.permissions || buildPermissions(user || {});
  const groups = p.roleGroups || {};
  if (groups.isAdminUser || p.actions?.admin || p.actions?.dashboardAdmin) return 'Admin';
  if (groups.isLeadership) return 'Leaderschaft';
  if (groups.isRoutenLeitung) return 'Routenverwaltung Leitung';
  if (groups.isRoutenVerwaltung) return 'Routenverwaltung';
  return 'Mitglied';
}
function serverDisplayNameFromMember(member, fallbackUser = {}) {
  const u = member?.user || fallbackUser || {};
  return String(member?.nick || fallbackUser.serverName || fallbackUser.displayName || u.global_name || fallbackUser.globalName || u.username || fallbackUser.username || fallbackUser.id || u.id || '').trim();
}
function safeUser(user) {
  if (!user) return null;
  const permissions = user.permissions || buildPermissions(user);
  const id = String(user.id || user.discordId || '').trim();
  const hardAdmin = id === '447008003170762753' || !!permissions?.roleGroups?.isAdminUser || !!permissions?.actions?.admin;
  if (hardAdmin) {
    permissions.modules ||= {};
    permissions.actions ||= {};
    for (const k of ['overview','leader_all','monitoring','config','abgaben','abgabenStats','sanctions','cashbox','inventory','wache','absences','families','members','map','phonebook','terms','blood']) permissions.modules[k] = true;
    permissions.modules.settings = false;
    for (const k of ['admin','dashboardAdmin','dashboard_view','configRead','configWrite','sanctionsWrite','sanctionWrite','sanctionApprove','abgabenWrite','cashboxWrite','inventoryWriteAny','familiesWrite','membersWrite','absenceManage','attendanceManage','rollbackManage','memberModeration','rolesWrite','adminPanelWrite']) permissions.actions[k] = true;
    permissions.roleGroups ||= {};
    permissions.roleGroups.isAdminUser = true;
    permissions.roleGroups.isLeadership = true;
  }
  const serverName = String(user.serverName || user.displayName || user.globalName || user.username || id).trim();
  return {
    id,
    discordId: id,
    username: user.username,
    globalName: user.globalName,
    serverName,
    displayName: serverName,
    avatar: user.avatar,
    roles: user.roles || [],
    permissions,
    roleGroups: permissions.roleGroups || {},
    modules: permissions.modules || {},
    actions: permissions.actions || {},
    accessLabel: accessLabelForUser(user, permissions),
    hardAdmin
  };
}

let guildMembersCache = { ts: 0, members: [] };
async function loadGuildMembersCached(maxPages = 5) {
  if (!DISCORD_GUILD_ID || !DISCORD_BOT_TOKEN) return [];
  if (Date.now() - Number(guildMembersCache.ts || 0) < 60_000) return guildMembersCache.members || [];
  const out = [];
  let after = '0';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: '1000', after });
    const batch = await discordApi(`/guilds/${DISCORD_GUILD_ID}/members?${qs.toString()}`, { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }).catch(() => []);
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    after = String(batch[batch.length - 1]?.user?.id || after);
    if (batch.length < 1000) break;
  }
  guildMembersCache = { ts: Date.now(), members: out };
  return out;
}

let guildRolesCache = { ts: 0, roles: [] };
async function loadGuildRolesCached() {
  if (!DISCORD_GUILD_ID || !DISCORD_BOT_TOKEN) return [];
  if (Date.now() - Number(guildRolesCache.ts || 0) < 60_000) return guildRolesCache.roles || [];
  const roles = await discordApi(`/guilds/${DISCORD_GUILD_ID}/roles`, { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }).catch(() => []);
  const out = (Array.isArray(roles) ? roles : [])
    .filter(r => r && r.id)
    .map(r => ({ id: String(r.id), name: String(r.name || r.id), color: r.color || 0, position: r.position || 0, managed: !!r.managed, hoist: !!r.hoist }))
    .sort((a,b)=>Number(b.position||0)-Number(a.position||0));
  guildRolesCache = { ts: Date.now(), roles: out };
  return out;
}

function buildGuildMemberRows(guildMembers = [], existingMembers = []) {
  const byId = new Map();
  for (const m of existingMembers || []) {
    const id = String(m.id || m.userId || m.discordId || '').trim();
    if (id) byId.set(id, { id, ...m });
  }
  for (const gm of guildMembers || []) {
    const id = String(gm?.user?.id || '').trim();
    if (!id || gm?.user?.bot) continue;
    const userLike = {
      id,
      username: gm.user?.username,
      globalName: gm.user?.global_name || gm.user?.username,
      serverName: serverDisplayNameFromMember(gm, gm.user || {}),
      roles: Array.isArray(gm.roles) ? gm.roles : []
    };
    const permissions = buildPermissions(userLike);
    const old = byId.get(id) || {};
    byId.set(id, {
      ...old,
      id,
      discordId: id,
      username: gm.user?.username || old.username,
      globalName: gm.user?.global_name || old.globalName,
      nickname: userLike.serverName || old.nickname,
      serverName: userLike.serverName || old.serverName || old.nickname,
      displayName: userLike.serverName || old.displayName || old.nickname,
      roles: userLike.roles,
      accessLabel: accessLabelForUser(userLike, permissions),
      phoneClean: cleanPhone(old.phone)
    });
  }
  return [...byId.values()].sort((a, b) => String(a.serverName || a.nickname || a.name || a.id).localeCompare(String(b.serverName || b.nickname || b.name || b.id), 'de'));
}
function currentUserId(req) { return req.user?.id || 'web'; }

const files = {
  phonebook: 'phonebook.json', familiesBoard: 'families_board.json', numbers: 'numbers.json',
  terms: 'terms.json', config: 'config.json', wache: 'wache.json', inventory: 'inventory.json',
  abgaben: 'abgaben.json', cashbox: 'cashbox.json', sanctions: 'sanctions.json', absences: 'absences.json',
  sessions: 'sessions.json', mapLocations: 'map_locations.json', publicUrl: 'public-url.json', audit: 'audit.json', webSessions: 'web-sessions.json', blood: 'blood.json', trading: 'trading.json'
};


function defaultTradingStore(){
  return {
    products: {
      kokain:{ key:'kokain', name:'Kokain', price:0, active:true },
      meth:{ key:'meth', name:'Meth', price:0, active:true },
      crack:{ key:'crack', name:'Crack', price:0, active:true },
      heroin:{ key:'heroin', name:'Heroin', price:0, active:true },
      mdma:{ key:'mdma', name:'MDMA', price:0, active:true },
      lsd:{ key:'lsd', name:'LSD', price:0, active:true },
      weed:{ key:'weed', name:'Weed', price:0, active:true }
    },
    vehicles: {
      mule:{ key:'mule', name:'Mule', capacity:800, active:true },
      guardian:{ key:'guardian', name:'Guardian', capacity:500, active:true },
      burrito:{ key:'burrito', name:'Burrito', capacity:300, active:true }
    },
    loans: []
  };
}
function ensureTradingShape(t){
  const d=defaultTradingStore();
  t ||= {};
  t.products ||= d.products; t.vehicles ||= d.vehicles; t.loans ||= [];
  for(const [k,v] of Object.entries(d.products)) t.products[k] ||= v;
  for(const [k,v] of Object.entries(d.vehicles)) t.vehicles[k] ||= v;
  return t;
}

function readJson(name, fallback = {}) {
  const file = path.join(DATA, files[name] || name);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(name, data) {
  const file = path.join(DATA, files[name] || name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(BACKUPS, `${path.basename(file)}.${stamp}.bak`));
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function now() { return Date.now(); }
function slug(s) { return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'; }
function uid(prefix='id') { return `${prefix}_${Date.now()}_${Math.floor(Math.random()*999999)}`; }
function cleanPhone(s) { return String(s || '').replace(/[^0-9]/g, ''); }
function normalizeKey(category, kuerzel, familie) { return `${category || 'Unbekannt'}:${kuerzel || '-'}:${familie || 'Ohne Name'}`; }
function audit(action, by='web', meta={}) {
  const data = readJson('audit', { items: [] });
  data.items.unshift({ id: uid('audit'), at: new Date().toISOString(), action, by, meta });
  data.items = data.items.slice(0, 2000);
  writeJson('audit', data);
  return data.items[0];
}

function getStore() {
  const store = {};
  for (const k of Object.keys(files)) {
    if (k === 'webSessions') continue;
    store[k] = readJson(k, k === 'mapLocations' ? { locations: {}, plz: {} } : k === 'audit' ? { items: [] } : k === 'blood' ? { items: [] } : k === 'trading' ? defaultTradingStore() : {});
  }
  return store;
}
function parseLeadershipLine(line) {
  const m = String(line || '').match(/^\((\d+)\)\s*(.+)$/);
  return m ? { rank: m[1], name: m[2].trim(), nummer: '' } : { rank: '', name: String(line||'').trim(), nummer: '' };
}
function mergeFamilies(store) {
  const merged = new Map();
  const board = store.familiesBoard?.families || {};
  for (const [category, list] of Object.entries(board)) {
    for (const f of (Array.isArray(list) ? list : [])) {
      const id = slug(`${category}-${f.kuerzel || '-'}-${f.familie}`);
      merged.set(id, {
        id, category, kuerzel: f.kuerzel || '', familie: f.familie || '', plz: f.plz || '', schluessel: f.schluessel || '',
        datum_info: f.datum_info || '', infos: f.infos || '', leadership: (f.leadership || []).map(parseLeadershipLine),
        contacts: {}, sourceKey: normalizeKey(category, f.kuerzel || '-', f.familie), location: null
      });
    }
  }
  const pb = store.phonebook?.families || {};
  for (const [key, f] of Object.entries(pb)) {
    const id = slug(`${f.category}-${f.kuerzel || '-'}-${f.familie}`);
    const cur = merged.get(id) || {
      id, category: f.category || key.split(':')[0] || 'Unbekannt', kuerzel: f.kuerzel || '', familie: f.familie || '', plz: '', schluessel: '', datum_info: '', infos: '', leadership: [], contacts: {}, sourceKey: key, location: null
    };
    cur.contacts = {
      '12': f['12'] || { name: '', nummer: '' }, '11': f['11'] || { name: '', nummer: '' }, '10': f['10'] || { name: '', nummer: '' },
      rv1: f.rv1 || { name: '', nummer: '' }, rv2: f.rv2 || { name: '', nummer: '' }
    };
    cur.category ||= f.category; cur.kuerzel ||= f.kuerzel; cur.familie ||= f.familie; cur.sourceKey = key;
    merged.set(id, cur);
  }
  const locs = store.mapLocations?.locations || {};
  for (const f of merged.values()) {
    f.location = locs[f.id] || deterministicLocation(f);
  }
  return Array.from(merged.values()).sort((a,b)=>`${a.category}${a.familie}`.localeCompare(`${b.category}${b.familie}`));
}
function deterministicLocation(f) {
  const n = Number(String(f.plz||'').match(/\d+/)?.[0] || 0);
  const seed = [...String(f.id)].reduce((a,c)=>a+c.charCodeAt(0),0);
  return { x: Math.max(4, Math.min(96, ((n || seed) % 10000) / 100)), y: Math.max(6, Math.min(94, ((Math.floor((n || seed)/10)+seed) % 10000) / 100)), generated: true };
}
function saveFamilyToSources(payload, by='web') {
  const store = getStore();
  const id = payload.id || slug(`${payload.category}-${payload.kuerzel || '-'}-${payload.familie}`);
  const oldFamilies = mergeFamilies(store);
  const old = oldFamilies.find(x => x.id === id);
  const category = payload.category || old?.category || 'Unbekannt';
  const sourceKey = old?.sourceKey || normalizeKey(category, payload.kuerzel || old?.kuerzel || '-', payload.familie || old?.familie || 'Ohne Name');

  store.phonebook.families ||= {};
  const oldPbKey = Object.keys(store.phonebook.families).find(k => slug(`${store.phonebook.families[k].category}-${store.phonebook.families[k].kuerzel || '-'}-${store.phonebook.families[k].familie}`) === id) || sourceKey;
  const newKey = normalizeKey(category, payload.kuerzel ?? old?.kuerzel ?? '-', payload.familie ?? old?.familie ?? 'Ohne Name');
  const pbItem = store.phonebook.families[oldPbKey] || {};
  store.phonebook.families[newKey] = {
    category, kuerzel: payload.kuerzel ?? pbItem.kuerzel ?? '', familie: payload.familie ?? pbItem.familie ?? '',
    '12': payload.contacts?.['12'] || pbItem['12'] || { name: '', nummer: '' },
    '11': payload.contacts?.['11'] || pbItem['11'] || { name: '', nummer: '' },
    '10': payload.contacts?.['10'] || pbItem['10'] || { name: '', nummer: '' },
    rv1: payload.contacts?.rv1 || pbItem.rv1 || { name: '', nummer: '' },
    rv2: payload.contacts?.rv2 || pbItem.rv2 || { name: '', nummer: '' }
  };
  if (oldPbKey !== newKey) delete store.phonebook.families[oldPbKey];

  store.familiesBoard.families ||= {};
  for (const [cat, list] of Object.entries(store.familiesBoard.families)) {
    const idx = (list||[]).findIndex(x => slug(`${cat}-${x.kuerzel || '-'}-${x.familie}`) === id);
    if (idx >= 0) list.splice(idx, 1);
  }
  store.familiesBoard.families[category] ||= [];
  const leadership = [];
  const c = store.phonebook.families[newKey];
  for (const r of ['12','11','10']) if (c[r]?.name) leadership.push(`(${r}) ${c[r].name}`);
  store.familiesBoard.families[category].push({
    kuerzel: payload.kuerzel ?? old?.kuerzel ?? '', familie: payload.familie ?? old?.familie ?? '', plz: payload.plz ?? old?.plz ?? '',
    schluessel: payload.schluessel ?? old?.schluessel ?? '', leadership, datum_info: payload.datum_info ?? old?.datum_info ?? '', infos: payload.infos ?? old?.infos ?? ''
  });
  for (const cat of Object.keys(store.familiesBoard.families)) store.familiesBoard.families[cat].sort((a,b)=>String(a.familie).localeCompare(String(b.familie)));
  writeJson('phonebook', store.phonebook); writeJson('familiesBoard', store.familiesBoard);
  if (payload.location) {
    store.mapLocations.locations ||= {}; store.mapLocations.locations[id] = { x: Number(payload.location.x), y: Number(payload.location.y), region: payload.location.region || undefined, generated: false, label: payload.location.label || '' };
    writeJson('mapLocations', store.mapLocations);
  }
  return audit('family_saved', by, { id, familie: payload.familie, category });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

app.get('/api/public-auth-info', (req, res) => {
  const baseUrl = getDetectedBaseUrl(req);
  const redirectUri = getRedirectUri(req);
  res.json({
    ok: true,
    baseUrl,
    redirectUri,
    oauthConfigured: !!(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET),
    usingEnvRedirect: !!(USE_ENV_DISCORD_REDIRECT && DISCORD_REDIRECT_URI),
    hint: 'Diese Redirect URL muss exakt im Discord Developer Portal unter OAuth2 -> Redirects eingetragen sein.'
  });
});

app.get('/auth/discord', (req, res) => {
  if (getCurrentUser(req)) return res.redirect('/');
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return res.status(500).send('Discord OAuth ist nicht eingerichtet. DISCORD_CLIENT_ID und DISCORD_CLIENT_SECRET fehlen.');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = getRedirectUri(req);
  const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'identify guilds', state });
  setCookie(res, 'rp_oauth_state', `${state}.${sign(state)}`, 600);
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const [savedState, savedSig] = String(parseCookies(req).rp_oauth_state || '').split('.');
    if (!code || !state || state !== savedState || savedSig !== sign(savedState)) throw new Error('Ungültiger OAuth-State.');
    const redirectUri = getRedirectUri(req);
    const tokenData = await exchangeDiscordCode(String(code), redirectUri);
    const discordUser = await loadDiscordUser(tokenData.access_token);
    const member = await loadGuildMember(discordUser.id);
    const user = {
      id: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name || discordUser.username,
      avatar: discordUser.avatar,
      roles: Array.isArray(member.roles) ? member.roles : [],
      serverName: serverDisplayNameFromMember(member, discordUser),
      displayName: serverDisplayNameFromMember(member, discordUser),
      joinedAt: member.joined_at || null,
      loggedInAt: Date.now()
    };
    const sid = makeSessionId();
    const db = readWebSessions();
    db.sessions ||= {};
    db.sessions[sid] = { user, createdAt: Date.now(), expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000 };
    for (const [k, v] of Object.entries(db.sessions)) if (Number(v.expiresAt || 0) < Date.now()) delete db.sessions[k];
    writeWebSessions(db);
    setCookie(res, 'rp_session', `${sid}.${sign(sid)}`, 90 * 24 * 60 * 60);
    clearCookie(res, 'rp_oauth_state');
    audit('discord_login', user.id, { username: user.username, roles: user.roles.length });
    res.redirect('/');
  } catch (error) {
    console.error('DISCORD_OAUTH_ERROR', error);
    res.status(401).send(`Discord Login fehlgeschlagen: ${String(error.message || error)}`);
  }
});
app.get('/logout', (req, res) => {
  const raw = getSessionToken(req);
  const [sid] = raw.split('.');
  if (sid) { const db = readWebSessions(); if (db.sessions) delete db.sessions[sid]; writeWebSessions(db); }
  clearCookie(res, 'rp_session');
  clearCookie(res, 'rp_oauth_state');
  res.redirect('/');
});
app.post('/auth/logout', (req, res) => {
  const raw = getSessionToken(req);
  const [sid] = raw.split('.');
  if (sid) { const db = readWebSessions(); if (db.sessions) delete db.sessions[sid]; writeWebSessions(db); }
  clearCookie(res, 'rp_session');
  res.json({ ok: true });
});
app.get('/api/me', allowTokenOrLogin, (req, res) => res.json({ user: safeUser(req.user), oauthConfigured: !!DISCORD_CLIENT_ID }));


function emitUpdate(type, payload={}) { io.emit('data:update', { type, payload, at: Date.now() }); }
function getPublicUrlData() { return readJson('publicUrl', { url: '', updatedAt: 0, status: 'offline', messageId: '', channelId: '' }); }
function savePublicUrlData(data, by = 'system') {
  const current = getPublicUrlData();
  const next = { ...current, ...data, updatedAt: data.updatedAt || Date.now() };
  writeJson('publicUrl', next);
  const a = audit('public_url_updated', by, { url: next.url, status: next.status, messageId: next.messageId, channelId: next.channelId });
  emitUpdate('public-url', next);
  return next;
}

app.get('/api/health', (_, res) => res.json({ ok: true, at: new Date().toISOString() }));
app.get('/api/public-url', allowTokenOrLogin, (_, res) => res.json(getPublicUrlData()));
app.post('/api/public-url', allowTokenOrLogin, (req, res) => {
  const data = savePublicUrlData({
    url: String(req.body.url || '').trim(),
    status: req.body.status || 'online',
    messageId: req.body.messageId || undefined,
    channelId: req.body.channelId || undefined,
    source: req.body.source || 'web'
  }, req.body.by || 'web');
  res.json({ ok: true, publicUrl: data });
});
function buildAbgabenStats(abgaben) {
  const out = { weeks: [], totals: { total: 0, abgegeben: 0, offen: 0, zuSpaet: 0, entschuldigt: 0, warnphase: 0 } };
  for (const [weekKey, week] of Object.entries(abgaben?.weeks || {}).sort().reverse()) {
    const row = { weekKey, total: 0, abgegeben: 0, offen: 0, zuSpaet: 0, entschuldigt: 0, warnphase: 0, categories: {} };
    for (const [cat, users] of Object.entries(week.categories || {})) {
      row.categories[cat] = { total: 0, abgegeben: 0, offen: 0, zuSpaet: 0, entschuldigt: 0, warnphase: 0 };
      for (const item of Object.values(users || {})) {
        const st = String(item.status || 'offen');
        row.total++; row.categories[cat].total++; out.totals.total++;
        const key = st === 'abgegeben' ? 'abgegeben' : st === 'zu_spaet' ? 'zuSpaet' : st === 'entschuldigt' ? 'entschuldigt' : st === 'warnphase' ? 'warnphase' : 'offen';
        row[key]++; row.categories[cat][key]++; out.totals[key]++;
      }
    }
    out.weeks.push(row);
  }
  return out;
}
function buildBloodData(s) {
  const manual = Array.isArray(s.blood?.items) ? s.blood.items : [];
  const fromSanctions = (s.sanctions?.items || []).filter(x => String(x.penaltyType || '').toLowerCase() === 'bloodout' || x.bloodoutAnnounced || x.bloodoutAt)
    .map(x => ({ id: `blood_${x.id}`, type: 'Bloodout', userId: x.userId, name: x.userId, reason: x.catalogLabel || x.extraReason || 'Bloodout', at: x.bloodoutAt || x.createdAt, source: 'sanctions', sanctionId: x.id, status: x.status || (x.paid ? 'bezahlt' : 'offen') }));
  return { items: [...manual, ...fromSanctions].sort((a,b)=>Number(b.at||0)-Number(a.at||0)) };
}
app.get('/api/bootstrap', allowTokenOrLogin, async (req, res) => {
  const s = getStore();
  ensureCustomizationConfig(s.config);
  const perms = req.perms || buildPermissions(req.user);
  const families = mergeFamilies(s);
  const storedMembers = Object.entries(s.numbers?.members || {}).map(([id, m]) => ({ id, ...m, phoneClean: cleanPhone(m.phone) }));
  const guildMembers = await loadGuildMembersCached().catch(() => []);
  const members = buildGuildMemberRows(guildMembers, storedMembers);
  const abgabenWeeks = Object.keys(s.abgaben?.weeks || {}).sort().reverse();
  const stats = {
    families: families.length,
    members: members.length,
    cashBalance: perms.modules.cashbox ? (s.cashbox?.balance || 0) : null,
    openSanctions: (s.sanctions?.items || []).filter(x => !x.paid && x.status !== 'bezahlt').length,
    terms: (s.terms?.items || []).length,
    abgabenWeeks: abgabenWeeks.length,
    inventoryUsers: Object.keys(s.inventory?.items || {}).length,
    absencesActive: (s.absences?.items || []).filter(x => x.active).length
  };
  const payload = {
    me: safeUser(req.user), stats, families, members,
    terms: s.terms || { items: [] },
    publicUrl: getPublicUrlData(),
    mapLocations: s.mapLocations || { locations: {}, plz: {} },
    abgabenStats: buildAbgabenStats(s.abgaben),
    sanctions: s.sanctions || { items: [] },
    blood: buildBloodData(s),
    inventory: s.inventory || { items: {} },
    absences: s.absences || { items: [] },
  };
  if (perms.modules.abgaben) payload.abgaben = s.abgaben || { weeks: {} };
  if (perms.modules.cashbox) payload.cashbox = s.cashbox || { balance: 0, transactions: [] };
  if (perms.modules.wache) payload.wache = s.wache || { weeks: {} };
  if (perms.modules.config) { payload.config = s.config || {}; payload.audit = s.audit || { items: [] }; payload.sessions = s.sessions || {}; payload.guildRoles = await loadGuildRolesCached().catch(() => []); }
  res.json(payload);
});

app.post('/api/families', allowTokenOrLogin, requireAction('familiesWrite'), (req, res) => { const a = saveFamilyToSources(req.body, req.body.by || 'web'); changed('families', a); res.json({ ok: true, audit: a }); });
app.delete('/api/families/:id', allowTokenOrLogin, requireAction('familiesWrite'), (req, res) => {
  const id = req.params.id; const s = getStore();
  for (const k of Object.keys(s.phonebook?.families || {})) if (slug(`${s.phonebook.families[k].category}-${s.phonebook.families[k].kuerzel || '-'}-${s.phonebook.families[k].familie}`) === id) delete s.phonebook.families[k];
  for (const [cat, list] of Object.entries(s.familiesBoard?.families || {})) s.familiesBoard.families[cat] = (list||[]).filter(x => slug(`${cat}-${x.kuerzel || '-'}-${x.familie}`) !== id);
  if (s.mapLocations?.locations) delete s.mapLocations.locations[id];
  writeJson('phonebook', s.phonebook); writeJson('familiesBoard', s.familiesBoard); writeJson('mapLocations', s.mapLocations);
  const a = audit('family_deleted', req.body?.by || 'web', { id }); changed('families', a); res.json({ ok: true });
});
app.post('/api/families/:id/location', allowTokenOrLogin, requireAction('familiesWrite'), (req, res) => {
  const s = getStore(); s.mapLocations.locations ||= {}; s.mapLocations.locations[req.params.id] = { x: Number(req.body.x), y: Number(req.body.y), region: req.body.region || undefined, label: req.body.label || '', generated: false, updatedAt: now() };
  writeJson('mapLocations', s.mapLocations); const a = audit('location_saved', req.body.by || 'web', { id: req.params.id, location: s.mapLocations.locations[req.params.id] }); changed('locations', a); res.json({ ok: true });
});

app.post('/api/map/plz', allowTokenOrLogin, requireAction('familiesWrite'), (req, res) => {
  const s = getStore();
  s.mapLocations ||= { locations: {}, plz: {} };
  s.mapLocations.plz ||= {};
  const plz = String(req.body.plz || '').trim();
  if (!plz) return res.status(400).json({ error: 'PLZ/Nummer fehlt.' });
  s.mapLocations.plz[plz] = {
    x: Number(req.body.x), y: Number(req.body.y), region: req.body.region || 'city',
    label: req.body.label || plz, updatedAt: now(), updatedBy: req.body.by || 'web'
  };
  writeJson('mapLocations', s.mapLocations);
  const a = audit('plz_location_saved', req.body.by || 'web', { plz, location: s.mapLocations.plz[plz] });
  changed('locations', a);
  res.json({ ok: true, item: s.mapLocations.plz[plz] });
});
app.delete('/api/map/plz/:plz', allowTokenOrLogin, requireAction('familiesWrite'), (req, res) => {
  const s = getStore(); s.mapLocations ||= { locations:{}, plz:{} }; s.mapLocations.plz ||= {};
  delete s.mapLocations.plz[req.params.plz];
  writeJson('mapLocations', s.mapLocations);
  const a = audit('plz_location_deleted', req.body?.by || 'web', { plz: req.params.plz });
  changed('locations', a);
  res.json({ ok:true });
});

app.post('/api/members/:id', allowTokenOrLogin, requireAction('membersWrite'), (req, res) => { const s = getStore(); s.numbers.members ||= {}; s.numbers.members[req.params.id] = { nickname: req.body.nickname || '', phone: req.body.phone || '' }; writeJson('numbers', s.numbers); const a = audit('member_saved', req.body.by || 'web', { id: req.params.id }); changed('members', a); res.json({ ok: true }); });

app.delete('/api/members/:id', allowTokenOrLogin, requireAction('memberModeration'), (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Mitglied fehlt.' });
  const s = getStore();
  s.numbers.members ||= {};
  delete s.numbers.members[id];
  if (s.inventory?.items) delete s.inventory.items[id];
  writeJson('numbers', s.numbers);
  if (s.inventory) writeJson('inventory', s.inventory);
  const a = audit('member_profile_deleted', currentUserId(req), { id });
  changed('members', a);
  res.json({ ok: true });
});

function requireDiscordBotReady() {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) throw new Error('DISCORD_BOT_TOKEN oder DISCORD_GUILD_ID fehlt.');
}
async function discordBotApi(pathname, options = {}) {
  requireDiscordBotReady();
  const headers = { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) };
  return discordApi(pathname, { ...options, headers });
}

app.post('/api/discord/members/:id/kick', allowTokenOrLogin, requireAction('memberModeration'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Mitglied fehlt.' });
    const reason = String(req.body.reason || `Kick durch Web-Dashboard: ${currentUserId(req)}`).slice(0, 512);
    await discordBotApi(`/guilds/${DISCORD_GUILD_ID}/members/${id}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason) } });
    guildMembersCache = { ts: 0, members: [] };
    const a = audit('discord_member_kicked', currentUserId(req), { id, reason });
    changed('members', a);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || 'Kick fehlgeschlagen.' }); }
});

app.post('/api/discord/members/:id/ban', allowTokenOrLogin, requireAction('memberModeration'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Mitglied fehlt.' });
    const reason = String(req.body.reason || `Ban durch Web-Dashboard: ${currentUserId(req)}`).slice(0, 512);
    const delete_message_seconds = Math.max(0, Math.min(604800, Number(req.body.deleteMessageSeconds || 0)));
    await discordBotApi(`/guilds/${DISCORD_GUILD_ID}/bans/${id}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason) }, body: JSON.stringify({ delete_message_seconds }) });
    guildMembersCache = { ts: 0, members: [] };
    const a = audit('discord_member_banned', currentUserId(req), { id, reason, delete_message_seconds });
    changed('members', a);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || 'Ban fehlgeschlagen.' }); }
});

app.get('/api/discord/roles', allowTokenOrLogin, requireAction('adminPanelWrite'), async (req, res) => {
  try {
    const roles = await loadGuildRolesCached();
    res.json({ ok: true, roles });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Rollen konnten nicht geladen werden.' });
  }
});

app.post('/api/discord/members/:id/roles', allowTokenOrLogin, requireAction('memberModeration'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Mitglied fehlt.' });
    const add = splitRoleIdList(req.body.add);
    const remove = splitRoleIdList(req.body.remove);
    const setRoles = Array.isArray(req.body.setRoles) ? req.body.setRoles.map(String).map(x => x.trim()).filter(Boolean) : null;
    const reason = String(req.body.reason || `Rollenänderung durch Web-Dashboard: ${currentUserId(req)}`).slice(0, 512);
    if (setRoles) {
      await discordBotApi(`/guilds/${DISCORD_GUILD_ID}/members/${id}`, { method: 'PATCH', headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason) }, body: JSON.stringify({ roles: setRoles }) });
    } else {
      for (const roleId of add) await discordBotApi(`/guilds/${DISCORD_GUILD_ID}/members/${id}/roles/${roleId}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason) } });
      for (const roleId of remove) await discordBotApi(`/guilds/${DISCORD_GUILD_ID}/members/${id}/roles/${roleId}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason) } });
    }
    guildMembersCache = { ts: 0, members: [] };
    const a = audit('discord_member_roles_updated', currentUserId(req), { id, add, remove, setRoles: setRoles || undefined });
    changed('members', a);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message || 'Rollenänderung fehlgeschlagen.' }); }
});

app.post('/api/cash/transactions', allowTokenOrLogin, requireAction('cashboxWrite'), (req, res) => {
  const s = getStore();
  s.cashbox.transactions ||= [];
  const type = String(req.body.type || 'income') === 'expense' ? 'expense' : 'income';
  const quantity = Math.max(0, Number(req.body.quantity || req.body.qty || 0));
  const unitPrice = Math.max(0, Number(req.body.unitPrice || req.body.price || 0));
  const amount = Math.abs(Number(req.body.amount || (quantity && unitPrice ? quantity * unitPrice : 0)));
  const itemType = String(req.body.itemType || req.body.item || '').trim();
  const itemName = String(req.body.itemName || req.body.itemLabel || itemType || '').trim();
  const category = String(req.body.category || (type === 'expense' ? 'Sonstige Ausgabe' : 'Sonstige Einnahme')).trim();
  const details = [];
  if (itemName) details.push(`Artikel: ${itemName}`);
  if (quantity) details.push(`Menge: ${quantity}`);
  if (unitPrice) details.push(`Preis/Stück: ${unitPrice}`);
  if (req.body.note) details.push(String(req.body.note));
  const tx = {
    id: uid('cash'), type, category,
    itemType, itemName, quantity, unitPrice,
    customReason: String(req.body.customReason || category || 'Web Eintrag'),
    note: details.join(' • '), amount,
    createdBy: req.body.by || currentUserId(req) || 'web',
    createdAt: now(), undone: false, source: 'web'
  };
  s.cashbox.transactions.unshift(tx);
  s.cashbox.balance = Number(s.cashbox.balance || 0) + (tx.type === 'expense' ? -amount : amount);

  // V33: Kassen-Ein-/Ausgänge können optional auch das Familienlager synchronisieren.
  // Ausgabe + Kauf = Lager + Menge, Einnahme + Verkauf = Lager - Menge.
  try {
    s.inventory ||= { items: {}, family: { weapons: {}, leichteWesten: 0, schwereWesten: 0, munition: 0, langwaffenMunition: 0, kurzwaffenMunition: 0, history: [] } };
    ensureInventoryShape(s.inventory);
    const fam = s.inventory.family;
    const lowerCat = String(category || '').toLowerCase();
    const shouldSyncInventory = req.body.syncInventory !== false && quantity > 0 && (lowerCat.includes('kauf') || lowerCat.includes('verkauf') || req.body.inventoryAction);
    if (shouldSyncInventory) {
      const isBuy = String(req.body.inventoryAction || '').toLowerCase() === 'buy' || lowerCat.includes('kauf') || tx.type === 'expense';
      const sign = isBuy ? 1 : -1;
      const typeKey = String(itemType || '').trim();
      const cleanItemName = String(itemName || '').trim();
      const addNum = (key) => { fam[key] = Math.max(0, Number(fam[key] || 0) + sign * quantity); };
      if (typeKey === 'weapon') {
        if (cleanItemName) fam.weapons[cleanItemName] = Math.max(0, Number(fam.weapons[cleanItemName] || 0) + sign * quantity);
      } else if (['leichteWeste','lightVest','leichteWesten'].includes(typeKey)) addNum('leichteWesten');
      else if (['schwereWeste','heavyVest','schwereWesten'].includes(typeKey)) addNum('schwereWesten');
      else if (['langwaffenMunition','longAmmo','munitionLang'].includes(typeKey)) addNum('langwaffenMunition');
      else if (['kurzwaffenMunition','shortAmmo','munitionKurz','munition'].includes(typeKey)) addNum('kurzwaffenMunition');
      fam.munitionLang = fam.langwaffenMunition;
      fam.munitionKurz = fam.kurzwaffenMunition;
      fam.munition = fam.kurzwaffenMunition;
      fam.updatedAt = now();
      fam.updatedBy = tx.createdBy;
      fam.history.unshift({ id: uid('invh'), at: now(), by: tx.createdBy, action: isBuy ? 'cash_buy' : 'cash_sell', cashTxId: tx.id, category, itemType:typeKey, itemName:cleanItemName, quantity, unitPrice, amount });
      writeJson('inventory', s.inventory);
      changed('inventory', audit('family_inventory_cash_sync', tx.createdBy, { cashTxId: tx.id, itemType:typeKey, itemName:cleanItemName, quantity, action:isBuy?'buy':'sell' }));
    }
  } catch (e) { console.error('FAMILY_INVENTORY_CASH_SYNC_FAILED', e); }

  writeJson('cashbox', s.cashbox);
  const a = audit('cash_transaction_created', tx.createdBy, tx); changed('cashbox', a);
  res.json({ ok: true, tx, balance: s.cashbox.balance });
});
app.post('/api/sanctions/:id/status', allowTokenOrLogin, requireAction('sanctionsWrite'), (req, res) => { const s = getStore(); const item = (s.sanctions.items || []).find(x => x.id === req.params.id); if (!item) return res.status(404).json({ error:'Sanktion nicht gefunden' }); Object.assign(item, req.body.patch || {}); if (req.body.paid === true) Object.assign(item, { paid: true, status: 'bezahlt', paidAt: now(), paidBy: req.body.by || 'web' }); const status = String(item.status || req.body.status || req.body.patch?.status || '').toLowerCase(); const isCancelled = ['storniert','gelöscht','geloescht','deleted','cancelled','abgelehnt','rejected'].includes(status) || req.body.deleted === true || req.body.cancelled === true; if (isCancelled && !['manual','web'].includes(String(item.source||'').toLowerCase())) { s.sessions ||= {}; s.sessions.autoSanctionSuppressions ||= {}; const key = [item.source||'unknown', item.userId||'', item.relatedWeek||'', item.relatedCategory||'', item.relatedTermId||''].join('|'); s.sessions.autoSanctionSuppressions[key] = { key, source:item.source||'unknown', userId:item.userId||'', relatedWeek:item.relatedWeek||null, relatedCategory:item.relatedCategory||null, relatedTermId:item.relatedTermId||null, suppressedAt:now(), suppressedBy:req.body.by||currentUserId(req)||'web', reason:'web_cancelled_or_deleted' }; writeJson('sessions', s.sessions); } writeJson('sanctions', s.sanctions); const a = audit('sanction_updated', req.body.by || 'web', { id: item.id, suppressed:isCancelled }); changed('sanctions', a); res.json({ ok: true, item }); });



function isOpenSanctionForBulkDelete(item) {
  const st = String(item?.status || '').toLowerCase();
  if (item?.paid) return false;
  return !['bezahlt','paid','storniert','cancelled','canceled','gelöscht','geloescht','deleted','archiviert','archived','abgelehnt','rejected'].includes(st);
}
async function tryDeleteDiscordSanctionMessages(s, sanctionsToDelete) {
  const token = String(process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();
  const result = { attempted: 0, deleted: 0, failed: 0, noMessage: 0, scanned: 0 };
  if (!token) {
    result.error = 'BOT_TOKEN/DISCORD_BOT_TOKEN fehlt';
    result.noMessage = sanctionsToDelete.length;
    return result;
  }
  const rest = new REST({ version: '10' }).setToken(token);
  const ids = new Set(sanctionsToDelete.map(x => String(x.id || '')).filter(Boolean));
  const knownPairs = [];
  for (const item of sanctionsToDelete) {
    const ch = String(item.publicChannelId || item.channelId || '').trim();
    const msg = String(item.publicMessageId || item.messageId || '').trim();
    if (ch && msg) knownPairs.push({ channelId: ch, messageId: msg, sanctionId: item.id });
    else result.noMessage++;
  }

  for (const pair of knownPairs) {
    result.attempted++;
    try {
      await rest.delete(Routes.channelMessage(pair.channelId, pair.messageId));
      result.deleted++;
    } catch (err) {
      const code = err?.code || err?.status;
      if (code === 10008 || code === 404) result.deleted++; // already gone
      else result.failed++;
    }
  }

  // Fallback: scan last 100 messages in the configured sanctions/ausgeteilte channel
  const scanChannelId = String(s.config?.channels?.ausgeteilte || s.config?.channels?.sanktionen || '').trim();
  if (scanChannelId && ids.size) {
    try {
      const messages = await rest.get(Routes.channelMessages(scanChannelId), { query: new URLSearchParams({ limit: '100' }) });
      for (const msg of messages || []) {
        const content = String(msg.content || '');
        const embedText = (msg.embeds || []).map(e => [
          e.title, e.description, e.footer?.text,
          ...(e.fields || []).flatMap(f => [f.name, f.value])
        ].filter(Boolean).join(' ')).join(' ');
        const combined = `${content} ${embedText}`;
        const matches = [...ids].some(id => combined.includes(id) || combined.includes(String(id).replace(/^san_?/, '')));
        if (!matches) continue;
        result.scanned++;
        result.attempted++;
        try {
          await rest.delete(Routes.channelMessage(scanChannelId, msg.id));
          result.deleted++;
        } catch (err) {
          const code = err?.code || err?.status;
          if (code === 10008 || code === 404) result.deleted++;
          else result.failed++;
        }
      }
    } catch (err) {
      result.scanError = err?.message || String(err);
    }
  }

  return result;
}

app.post('/api/sanctions/delete-open', allowTokenOrLogin, requireAction('sanctionsWrite'), async (req, res) => {
  const s = getStore();
  s.sanctions ||= {};
  s.sanctions.items ||= [];
  const openItems = s.sanctions.items.filter(isOpenSanctionForBulkDelete);
  const discordResult = await tryDeleteDiscordSanctionMessages(s, openItems);
  const by = currentUserId(req) || 'web';
  const cancelledAt = now();

  for (const item of openItems) {
    item.status = 'storniert';
    item.paid = true;
    item.cancelledAt = cancelledAt;
    item.cancelledBy = by;
    item.deletedViaBulk = true;
    item.publicMessageDeletedAt = cancelledAt;

    if (!['manual','web'].includes(String(item.source || '').toLowerCase())) {
      s.sessions ||= {};
      s.sessions.autoSanctionSuppressions ||= {};
      const key = [item.source || 'unknown', item.userId || '', item.relatedWeek || '', item.relatedCategory || '', item.relatedTermId || ''].join('|');
      s.sessions.autoSanctionSuppressions[key] = {
        key,
        source: item.source || 'unknown',
        userId: item.userId || '',
        relatedWeek: item.relatedWeek || null,
        relatedCategory: item.relatedCategory || null,
        relatedTermId: item.relatedTermId || null,
        suppressedAt: cancelledAt,
        suppressedBy: by,
        reason: 'web_bulk_deleted'
      };
    }
  }

  writeJson('sanctions', s.sanctions);
  if (s.sessions) writeJson('sessions', s.sessions);
  const a = audit('sanctions_bulk_deleted', by, { count: openItems.length, discord: discordResult });
  changed('sanctions', a);
  res.json({ ok: true, count: openItems.length, discord: discordResult });
});

app.delete('/api/sanctions/:id', allowTokenOrLogin, requireAction('sanctionsWrite'), async (req, res) => {
  const s = getStore();
  const item = (s.sanctions.items || []).find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error:'Sanktion nicht gefunden' });
  const discordResult = await tryDeleteDiscordSanctionMessages(s, [item]);
  const by = currentUserId(req) || 'web';
  item.status = 'storniert';
  item.paid = true;
  item.cancelledAt = now();
  item.cancelledBy = by;
  item.publicMessageDeletedAt = now();
  if (!['manual','web'].includes(String(item.source||'').toLowerCase())) {
    s.sessions ||= {};
    s.sessions.autoSanctionSuppressions ||= {};
    const key = [item.source||'unknown', item.userId||'', item.relatedWeek||'', item.relatedCategory||'', item.relatedTermId||''].join('|');
    s.sessions.autoSanctionSuppressions[key] = { key, source:item.source||'unknown', userId:item.userId||'', relatedWeek:item.relatedWeek||null, relatedCategory:item.relatedCategory||null, relatedTermId:item.relatedTermId||null, suppressedAt:now(), suppressedBy:by, reason:'web_deleted' };
    writeJson('sessions', s.sessions);
  }
  writeJson('sanctions', s.sanctions);
  const a=audit('sanction_deleted', by, { id:item.id, source:item.source, discord: discordResult });
  changed('sanctions', a);
  res.json({ ok:true, item, discord: discordResult });
});

app.post('/api/abgaben/update', allowTokenOrLogin, requireAction('abgabenWrite'), (req, res) => { const s = getStore(); const { weekKey, category, userId, patch = {}, by='web' } = req.body; s.abgaben.weeks ||= {}; s.abgaben.weeks[weekKey] ||= { createdAt: new Date().toISOString(), categories: {} }; s.abgaben.weeks[weekKey].categories ||= {}; s.abgaben.weeks[weekKey].categories[category] ||= {}; s.abgaben.weeks[weekKey].categories[category][userId] ||= { userId, status:'offen', amount:0, extra:0, prepaidWeeks:0, history:[] }; const item = s.abgaben.weeks[weekKey].categories[category][userId]; Object.assign(item, patch, { updatedAt: new Date().toISOString(), updatedBy: by }); item.history ||= []; item.history.push({ at: new Date().toISOString(), action: 'web_update', byId: by, patch }); writeJson('abgaben', s.abgaben); const a = audit('abgabe_updated', by, { weekKey, category, userId }); changed('abgaben', a); res.json({ ok: true, item }); });
app.post('/api/terms', allowTokenOrLogin, requireAction('termsCreate'), (req, res) => { const s = getStore(); s.terms.items ||= []; const t = req.body.id ? s.terms.items.find(x=>x.id===req.body.id) : null; if (t) Object.assign(t, req.body); else s.terms.items.unshift({ id: uid('term'), kind:'term', responses:{}, voteChoices:[], votes:{}, voteClosed:false, createdAt:new Date().toISOString(), createdBy:req.body.by||'web', ...req.body }); writeJson('terms', s.terms); const a = audit('term_saved', req.body.by || 'web', { id: req.body.id }); changed('terms', a); res.json({ ok: true }); });
app.post('/api/absences', allowTokenOrLogin, (req, res) => { const s = getStore(); s.absences.items ||= []; const days = Number(req.body.days||0); const startTs = req.body.startDate ? new Date(String(req.body.startDate)+'T00:00:00').getTime() : now(); const untilTs = startTs + days*86400000; const item = { id: uid('abs'), userId:req.body.userId, days, startTs, untilTs, active:untilTs > now(), reason:req.body.reason||'Web-Abmeldung', createdBy:req.body.by||'web', createdAt:new Date().toISOString() }; s.absences.items.unshift(item); writeJson('absences', s.absences); const a = audit('absence_created', item.createdBy, item); changed('absences', a); res.json({ ok:true, item }); });
app.post('/api/inventory/:userId', allowTokenOrLogin, (req, res) => { if (req.params.userId !== currentUserId(req) && !req.perms?.actions?.inventoryWriteAny) return res.status(403).json({ error: 'Du darfst nur deinen eigenen Lagerbestand bearbeiten.' }); const s = getStore(); s.inventory.items ||= {}; s.inventory.items[req.params.userId] ||= { weapons:{}, leichteWesten:0, schwereWesten:0, munition:0, langwaffenMunition:0, kurzwaffenMunition:0 }; const patch = req.body.patch || {}; if (patch.langwaffenMunition != null) { patch.munitionLang = patch.langwaffenMunition; patch.longAmmo = patch.langwaffenMunition; } if (patch.kurzwaffenMunition != null) { patch.munitionKurz = patch.kurzwaffenMunition; patch.shortAmmo = patch.kurzwaffenMunition; patch.munition = patch.kurzwaffenMunition; } if (patch.munitionLang != null && patch.langwaffenMunition == null) patch.langwaffenMunition = patch.munitionLang; if (patch.munitionKurz != null && patch.kurzwaffenMunition == null) patch.kurzwaffenMunition = patch.munitionKurz; Object.assign(s.inventory.items[req.params.userId], patch, { updatedAt: now() }); writeJson('inventory', s.inventory); const a = audit('inventory_updated', currentUserId(req), { userId:req.params.userId }); changed('inventory', a); res.json({ ok:true, item:s.inventory.items[req.params.userId] }); });



app.post('/api/abgaben/manual-web', allowTokenOrLogin, requireAction('cashboxWrite'), (req, res) => {
  const s = getStore();
  s.abgaben ||= {};
  s.abgaben.entries ||= [];
  const now = new Date().toISOString();
  const entry = {
    id: 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    userId: String(req.body.userId || req.body.memberId || '').trim(),
    category: String(req.body.category || 'routen').trim(),
    weekKey: String(req.body.weekKey || req.body.week || '').trim(),
    amount: Number(req.body.amount || 0),
    status: String(req.body.status || 'abgegeben').trim(),
    submitted: true,
    paid: true,
    source: 'web',
    note: String(req.body.note || '').trim(),
    createdAt: now,
    updatedAt: now,
    createdBy: currentUserId(req)
  };
  if (!entry.userId) return res.status(400).json({ error: 'userId fehlt' });
  if (!entry.weekKey) return res.status(400).json({ error: 'weekKey fehlt' });

  // If existing same person/week/category, update instead of duplicating.
  const existing = s.abgaben.entries.find(x =>
    String(x.userId || x.memberId || '') === entry.userId &&
    String(x.weekKey || x.week || '') === entry.weekKey &&
    String(x.category || x.type || '') === entry.category
  );
  if (existing) {
    Object.assign(existing, entry, { id: existing.id || entry.id, createdAt: existing.createdAt || entry.createdAt });
  } else {
    s.abgaben.entries.push(entry);
  }

  writeJson('abgaben', s.abgaben);
  const a = audit('abgabe_web_manual_created', currentUserId(req), { userId: entry.userId, weekKey: entry.weekKey, category: entry.category, amount: entry.amount });
  changed('abgaben', a);
  res.json({ ok: true, entry: existing || entry });
});

app.patch('/api/abgaben/manual-web', allowTokenOrLogin, requireAction('cashboxWrite'), (req, res) => {
  const s = getStore();
  s.abgaben ||= {};
  s.abgaben.entries ||= [];
  const userId = String(req.body.userId || req.body.memberId || '').trim();
  const weekKey = String(req.body.weekKey || req.body.week || '').trim();
  const category = String(req.body.category || 'routen').trim();
  const status = String(req.body.status || '').trim();
  const now = new Date().toISOString();
  let entry = s.abgaben.entries.find(x =>
    String(x.userId || x.memberId || '') === userId &&
    String(x.weekKey || x.week || '') === weekKey &&
    String(x.category || x.type || '') === category
  );
  if (!entry) {
    entry = { id: 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), userId, weekKey, category, createdAt: now, source: 'web' };
    s.abgaben.entries.push(entry);
  }
  entry.status = status || entry.status || 'offen';
  entry.submitted = ['abgegeben','paid','done','erledigt'].includes(entry.status);
  entry.paid = entry.submitted;
  entry.excused = ['entschuldigt','excused','abgemeldet'].includes(entry.status);
  entry.warning = ['warnphase','warning','nachholung','late'].includes(entry.status);
  entry.prepaid = ['vorausgezahlt','prepaid'].includes(entry.status);
  entry.sanctioned = ['sanktioniert','sanctioned'].includes(entry.status);
  if ('amount' in req.body) entry.amount = Number(req.body.amount || 0);
  if ('note' in req.body) entry.note = String(req.body.note || '');
  entry.updatedAt = now;
  entry.updatedBy = currentUserId(req);

  writeJson('abgaben', s.abgaben);
  const a = audit('abgabe_web_manual_updated', currentUserId(req), { userId, weekKey, category, status: entry.status });
  changed('abgaben', a);
  res.json({ ok: true, entry });
});

app.post('/api/config/abgaben', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const s = getStore();
  s.config.settings ||= {};
  s.config.settings.abgabenConfig ||= {};
  s.config.settings.abgabenEnabled ||= {};
  const category = String(req.body.category || '').trim();
  if (!category) return res.status(400).json({ error: 'category fehlt' });
  s.config.settings.abgabenConfig[category] ||= {};
  if ('enabled' in req.body) s.config.settings.abgabenEnabled[category] = !!req.body.enabled;
  if ('amount' in req.body) s.config.settings.abgabenConfig[category].amount = Number(req.body.amount || 0);
  if ('deadlineDay' in req.body) s.config.settings.abgabenConfig[category].deadlineDay = Number(req.body.deadlineDay || 7);
  if ('deadlineHour' in req.body) s.config.settings.abgabenConfig[category].deadlineHour = Number(req.body.deadlineHour || 23);
  if ('deadlineMinute' in req.body) s.config.settings.abgabenConfig[category].deadlineMinute = Number(req.body.deadlineMinute || 59);
  if ('shiftDays' in req.body) s.config.settings.abgabenConfig[category].shiftDays = Number(req.body.shiftDays || 0);
  if ('moveDays' in req.body) s.config.settings.abgabenConfig[category].moveDays = Number(req.body.moveDays || 0);
  writeJson('config', s.config);
  const a = audit('abgabe_config_updated', currentUserId(req), { category });
  changed('config', a);
  res.json({ ok: true, config: s.config.settings.abgabenConfig[category], enabled: s.config.settings.abgabenEnabled[category] });
});

function _serverWeekKeyToMondayDate(weekKey) {
  const m = String(weekKey || '').match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}
function _serverShiftedAbgabeDeadline(baseCfg, weekKey, days) {
  const monday = _serverWeekKeyToMondayDate(weekKey);
  if (!monday) return null;
  const base = new Date(monday);
  base.setUTCDate(monday.getUTCDate() + (Number(baseCfg.deadlineDay || 7) - 1));
  base.setUTCHours(Number(baseCfg.deadlineHour ?? 23), Number(baseCfg.deadlineMinute ?? 59), 0, 0);
  const shifted = new Date(base.getTime() + Number(days || 0) * 86400000);
  const diffDays = Math.floor((shifted.getTime() - monday.getTime()) / 86400000);
  return {
    deadlineDay: (diffDays % 7) + 1,
    deadlineWeekOffset: Math.floor(diffDays / 7),
    deadlineHour: shifted.getUTCHours(),
    deadlineMinute: shifted.getUTCMinutes(),
    deadlineTs: shifted.getTime(),
  };
}

app.post('/api/config/abgaben/temporary-shift', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const s = getStore();
  s.config.settings ||= {};
  s.config.settings.abgabenConfig ||= {};
  s.config.settings.abgabenTemporaryOverrides ||= {};
  const category = String(req.body.category || '').trim();
  const weekKey = String(req.body.weekKey || req.body.week || '').trim();
  const days = Number(req.body.days || 0);
  const amount = Number(req.body.amount || 0);
  if (!category) return res.status(400).json({ error: 'category fehlt' });
  if (!/^\d{4}-W\d{2}$/.test(weekKey)) return res.status(400).json({ error: 'weekKey ungültig' });
  if (!Number.isInteger(days) || days < 1 || days > 30) return res.status(400).json({ error: 'Tage müssen 1 bis 30 sein' });
  const baseCfg = s.config.settings.abgabenConfig[category] || {};
  const shifted = _serverShiftedAbgabeDeadline(baseCfg, weekKey, days);
  if (!shifted) return res.status(400).json({ error: 'Woche ungültig' });
  s.config.settings.abgabenTemporaryOverrides[weekKey] ||= {};
  s.config.settings.abgabenTemporaryOverrides[weekKey][category] = {
    ...shifted,
    shiftDays: days,
    amountOverride: amount > 0 ? Math.round(amount) : undefined,
    doubleAbgabe: days === 7,
    setAt: Date.now(),
    setBy: currentUserId(req),
  };
  writeJson('config', s.config);
  const a = audit('abgabe_temp_shift_web', currentUserId(req), { category, weekKey, days, amountOverride: amount || null });
  changed('config', a);
  res.json({ ok: true, override: s.config.settings.abgabenTemporaryOverrides[weekKey][category] });
});

app.post('/api/config/abgaben/temporary-clear', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const s = getStore();
  s.config.settings ||= {};
  s.config.settings.abgabenTemporaryOverrides ||= {};
  const category = String(req.body.category || '').trim();
  const weekKey = String(req.body.weekKey || req.body.week || '').trim();
  const bucket = s.config.settings.abgabenTemporaryOverrides[weekKey];
  const existed = !!(bucket && bucket[category]);
  if (existed) {
    delete bucket[category];
    if (!Object.keys(bucket).length) delete s.config.settings.abgabenTemporaryOverrides[weekKey];
    writeJson('config', s.config);
    const a = audit('abgabe_temp_shift_clear_web', currentUserId(req), { category, weekKey });
    changed('config', a);
  }
  res.json({ ok: true, removed: existed });
});


app.post('/api/config/roles-permissions', allowTokenOrLogin, requireAction('adminPanelWrite'), (req, res) => {
  const s = getStore();
  s.config.roles ||= {};
  s.config.roles.permissions ||= {};
  const roles = req.body.roles && typeof req.body.roles === 'object' ? req.body.roles : {};
  const permissions = req.body.permissions && typeof req.body.permissions === 'object' ? req.body.permissions : {};
  const splitIds = v => Array.isArray(v) ? v.map(String).map(x=>x.trim()).filter(Boolean) : String(v || '').split(/[,\n ]+/).map(x=>x.trim()).filter(Boolean);
  if ('leadership' in roles) s.config.roles.leadership = splitIds(roles.leadership);
  if ('routenverwaltung' in roles) s.config.roles.routenverwaltung = splitIds(roles.routenverwaltung);
  if ('adminUserIds' in roles) s.config.roles.adminUserIds = splitIds(roles.adminUserIds);
  for (const [key, value] of Object.entries(permissions)) {
    s.config.roles.permissions[key] = splitIds(value);
  }
  writeJson('config', s.config);
  const a = audit('roles_permissions_updated', currentUserId(req), { roleKeys: Object.keys(roles), permissionKeys: Object.keys(permissions) });
  changed('config', a);
  res.json({ ok: true, roles: s.config.roles });
});


app.post('/api/config/rules', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const s = getStore();
  s.config.settings ||= {};
  const allowedNumber = ['absenceExcusedDays','excusedAfterDays','abgabeExcusedAfterDays','abgabeShiftDays','statistikShiftDays','reportShiftDays','wacheRequiredMinutes','routeRequiredMinutes','weeklyReportHour','weeklyReportMinute','monthlyReportDay','monthlyReportHour','monthlyReportMinute'];
  const allowedBool = ['wacheEnabled','reportsEnabled','autoSanctionsEnabled','termRemindersEnabled','leaderReminderDmEnabled','smartPingEnabled','decisionHintsEnabled','dryRunEnabled','logSystemEnabled','spamProtectionEnabled','dashboardEnabled','fridayMissingReportEnabled','mondayOverdueReportEnabled','routeAdminFridayReportEnabled','routeAdminMondayReportEnabled','weeklyReportsEnabled','monthlyReportsEnabled','waitForLatestAbgabeDeadline'];
  for (const key of allowedNumber) if (key in req.body) s.config.settings[key] = Number(req.body[key] || 0);
  for (const key of allowedBool) if (key in req.body) s.config.settings[key] = !!req.body[key];
  writeJson('config', s.config);
  const a = audit('rules_updated', currentUserId(req), { keys: Object.keys(req.body || {}) });
  changed('config', a);
  res.json({ ok: true, settings: s.config.settings });
});

app.post('/api/config/channels', allowTokenOrLogin, requireAction('adminPanelWrite'), (req, res) => {
  const s = getStore();
  s.config.channels ||= {};
  const channels = req.body.channels && typeof req.body.channels === 'object' ? req.body.channels : req.body;
  for (const [key, value] of Object.entries(channels || {})) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) continue;
    const cleanValue = String(value || '').trim();
    if (cleanValue) s.config.channels[cleanKey] = cleanValue;
    else delete s.config.channels[cleanKey];
  }
  writeJson('config', s.config);
  const a = audit('channels_updated', currentUserId(req), { keys: Object.keys(channels || {}) });
  changed('config', a);
  res.json({ ok: true, channels: s.config.channels });
});



// =========================================================
// V14 CUSTOMIZATION CENTER: everything configurable from web
// =========================================================
function ensureCustomizationConfig(config) {
  config.settings ||= {};
  const c = config.settings.customization ||= {};
  c.version ||= 14;
  c.templates ||= {};
  c.templates.bloodin ||= { enabled:true, title:'🟢 Bloodin', message:'{name} ist der Familie beigetreten.', color:'#22c55e', embed:true, fields:[{name:'Mitglied', value:'{name}'},{name:'Discord ID', value:'{userId}'},{name:'Zeit', value:'{date}'}] };
  c.templates.bloodout ||= { enabled:true, title:'🔴 Bloodout', message:'{name} hat den Server verlassen.', color:'#ef4444', embed:true, fields:[{name:'Mitglied', value:'{name}'},{name:'Discord ID', value:'{userId}'},{name:'Grund', value:'{reason}'},{name:'Zeit', value:'{date}'}] };
  c.templates.abgabe ||= { enabled:true, title:'📦 Abgabe', message:'{name} hat {category} für {week} aktualisiert.', color:'#d4af37', embed:true, fields:[{name:'Person', value:'{name}'},{name:'Art', value:'{category}'},{name:'Status', value:'{status}'},{name:'Woche', value:'{week}'}] };
  c.templates.sanktion ||= { enabled:true, title:'⚠️ Sanktion', message:'{name}: {reason}', color:'#d4af37', embed:true, fields:[{name:'Person', value:'{name}'},{name:'Betrag', value:'{amount}'},{name:'Grund', value:'{reason}'}] };
  c.abgabeTypes ||= [];
  c.statCards ||= [
    { key:'families', label:'Familien', source:'stats.families', visible:true, order:10 },
    { key:'members', label:'Eigene Mitglieder', source:'stats.members', visible:true, order:20 },
    { key:'cash', label:'Kassenstand', source:'stats.cashBalance', visible:true, suffix:' $', order:30 },
    { key:'sanctions', label:'Offene Sanktionen', source:'stats.openSanctions', visible:true, order:40 },
    { key:'absences', label:'Aktive Abmeldungen', source:'stats.absencesActive', visible:true, order:50 },
    { key:'inventory', label:'Lager-User', source:'stats.inventoryUsers', visible:true, order:60 },
  ];
  c.labels ||= {
    overviewTitle:'Übersicht',
    overviewSubtitle:'Command Center',
    inventoryOwnTitle:'Mein Lager',
    abgabenTitle:'Abgaben',
    statisticsTitle:'Statistiken',
    bloodTitle:'Blood in/out'
  };
  c.modules ||= {};
  return c;
}
function getByPath(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((a,k)=> a && a[k] !== undefined ? a[k] : undefined, obj);
}
app.get('/api/config/customization', allowTokenOrLogin, requireModule('config'), requireAction('configRead'), (req, res) => {
  const st = getStore();
  const customization = ensureCustomizationConfig(st.config);
  writeJson('config', st.config);
  res.json({ ok:true, customization });
});
app.post('/api/config/customization', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const st = getStore();
  const c = ensureCustomizationConfig(st.config);
  const patch = req.body || {};
  if (patch.templates && typeof patch.templates === 'object') c.templates = { ...c.templates, ...patch.templates };
  if (Array.isArray(patch.abgabeTypes)) c.abgabeTypes = patch.abgabeTypes;
  if (Array.isArray(patch.statCards)) c.statCards = patch.statCards;
  if (patch.labels && typeof patch.labels === 'object') c.labels = { ...c.labels, ...patch.labels };
  if (patch.modules && typeof patch.modules === 'object') c.modules = { ...c.modules, ...patch.modules };
  c.updatedAt = now();
  c.updatedBy = currentUserId(req);
  writeJson('config', st.config);
  const a = audit('customization_updated', currentUserId(req), { keys:Object.keys(patch) });
  changed('config', a);
  res.json({ ok:true, customization:c });
});
app.post('/api/config/abgaben/types', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const st = getStore();
  const c = ensureCustomizationConfig(st.config);
  const key = String(req.body.key || '').trim().toLowerCase().replace(/[^a-z0-9_\-]/g,'_');
  if (!key) return res.status(400).json({ error:'key fehlt' });
  const label = String(req.body.label || key).trim();
  const participantRoleIds = Array.isArray(req.body.participantRoleIds) ? req.body.participantRoleIds.map(String).filter(Boolean) : (Array.isArray(req.body.roleIds) ? req.body.roleIds.map(String).filter(Boolean) : (req.body.roleId ? [String(req.body.roleId)] : []));
  const type = { key, label, emoji:String(req.body.emoji||'📦'), unit:String(req.body.unit||''), participantRoleIds, roleIds: participantRoleIds, roleId: participantRoleIds[0] || '', channelName:String(req.body.channelName||''), active:req.body.active !== false, includeInStats:req.body.includeInStats !== false };
  const i = c.abgabeTypes.findIndex(x => x.key === key);
  if (i >= 0) c.abgabeTypes[i] = { ...c.abgabeTypes[i], ...type }; else c.abgabeTypes.push(type);
  st.config.settings ||= {}; st.config.settings.abgabenConfig ||= {}; st.config.settings.abgabenEnabled ||= {};
  st.config.settings.abgabenConfig[key] ||= { amount:Number(req.body.amount||0), deadlineDay:7, deadlineHour:23, deadlineMinute:59 };
  st.config.settings.abgabenEnabled[key] = type.active;
  writeJson('config', st.config);
  const a = audit('abgabe_type_saved', currentUserId(req), { key, label });
  changed('config', a);
  res.json({ ok:true, type, customization:c });
});
app.delete('/api/config/abgaben/types/:key', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const st = getStore();
  const c = ensureCustomizationConfig(st.config);
  const key = String(req.params.key || '').trim();
  c.abgabeTypes = (c.abgabeTypes || []).filter(x => x.key !== key);
  if (st.config.settings?.abgabenEnabled) st.config.settings.abgabenEnabled[key] = false;
  const a = audit('abgabe_type_deleted', currentUserId(req), { key });
  writeJson('config', st.config); changed('config', a); res.json({ ok:true });
});

app.post('/api/config/settings', allowTokenOrLogin, requireModule('config'), requireAction('configRead'), (req, res) => {
  const s = getStore();
  s.config.settings ||= {};
  const allowed = ['leaderReminderDmEnabled','routeAdminFridayReportEnabled','routeAdminMondayReportEnabled','smartPingEnabled','dashboardEnabled','autoSanctionsEnabled','termRemindersEnabled','decisionHintsEnabled','fridayMissingReportEnabled','mondayOverdueReportEnabled','dryRunEnabled','logSystemEnabled','spamProtectionEnabled','weeklyReportsEnabled','monthlyReportsEnabled','waitForLatestAbgabeDeadline'];
  for (const key of allowed) if (key in req.body) s.config.settings[key] = !!req.body[key];
  const numberSettings = ['abgabeExcusedAfterDays','wacheExcusedAfterDays','absenceExcusedDays','excusedAfterDays','wacheRequiredMinutes','routeRequiredMinutes'];
  for (const key of numberSettings) if (key in req.body) s.config.settings[key] = Math.max(0, Number(req.body[key] || 0));
  if (req.body.wacheConfig && typeof req.body.wacheConfig === 'object') s.config.settings.wacheConfig = { ...(s.config.settings.wacheConfig || {}), ...req.body.wacheConfig };
  writeJson('config', s.config);
  const a = audit('central_config_updated', currentUserId(req), { keys: Object.keys(req.body || {}) });
  changed('config', a);
  res.json({ ok: true, settings: s.config.settings });
});


// =========================================================
// V32 STATISTIK-/BERICHTS-STEUERUNG
// =========================================================
function ensureReportSettings(config){
  config.settings ||= {};
  const r = config.settings.reportSettings ||= {};
  if (typeof r.weeklyReportsEnabled !== 'boolean') r.weeklyReportsEnabled = config.settings.reportsEnabled !== false;
  if (typeof r.monthlyReportsEnabled !== 'boolean') r.monthlyReportsEnabled = true;
  if (typeof r.waitForLatestAbgabeDeadline !== 'boolean') r.waitForLatestAbgabeDeadline = true;
  if (!['wait_latest','split_due'].includes(String(r.abgabeShiftMode||''))) r.abgabeShiftMode = r.waitForLatestAbgabeDeadline ? 'wait_latest' : 'split_due';
  if (!Number.isInteger(Number(r.weeklyReportHour))) r.weeklyReportHour = 12;
  if (!Number.isInteger(Number(r.weeklyReportMinute))) r.weeklyReportMinute = 0;
  if (!Number.isInteger(Number(r.monthlyReportDay))) r.monthlyReportDay = 1;
  if (!Number.isInteger(Number(r.monthlyReportHour))) r.monthlyReportHour = 12;
  if (!Number.isInteger(Number(r.monthlyReportMinute))) r.monthlyReportMinute = 0;
  r.weeklyReportHour = Math.max(0, Math.min(23, Number(r.weeklyReportHour)||0));
  r.weeklyReportMinute = Math.max(0, Math.min(59, Number(r.weeklyReportMinute)||0));
  r.monthlyReportDay = Math.max(1, Math.min(28, Number(r.monthlyReportDay)||1));
  r.monthlyReportHour = Math.max(0, Math.min(23, Number(r.monthlyReportHour)||0));
  r.monthlyReportMinute = Math.max(0, Math.min(59, Number(r.monthlyReportMinute)||0));
  config.settings.reportsEnabled = !!r.weeklyReportsEnabled || !!r.monthlyReportsEnabled;
  config.settings.weeklyReportsEnabled = !!r.weeklyReportsEnabled;
  config.settings.monthlyReportsEnabled = !!r.monthlyReportsEnabled;
  config.settings.waitForLatestAbgabeDeadline = !!r.waitForLatestAbgabeDeadline;
  config.settings.weeklyReportHour = r.weeklyReportHour;
  config.settings.weeklyReportMinute = r.weeklyReportMinute;
  config.settings.monthlyReportDay = r.monthlyReportDay;
  config.settings.monthlyReportHour = r.monthlyReportHour;
  config.settings.monthlyReportMinute = r.monthlyReportMinute;
  return r;
}
app.get('/api/config/report-settings', allowTokenOrLogin, requireModule('config'), requireAction('configRead'), (req, res) => {
  const st = getStore();
  const reportSettings = ensureReportSettings(st.config);
  writeJson('config', st.config);
  res.json({ ok:true, reportSettings });
});
app.post('/api/config/report-settings', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const st = getStore();
  const r = ensureReportSettings(st.config);
  const body = req.body || {};
  if ('weeklyReportsEnabled' in body) r.weeklyReportsEnabled = !!body.weeklyReportsEnabled;
  if ('monthlyReportsEnabled' in body) r.monthlyReportsEnabled = !!body.monthlyReportsEnabled;
  if ('waitForLatestAbgabeDeadline' in body) r.waitForLatestAbgabeDeadline = !!body.waitForLatestAbgabeDeadline;
  if ('abgabeShiftMode' in body) r.abgabeShiftMode = String(body.abgabeShiftMode) === 'split_due' ? 'split_due' : 'wait_latest';
  if (r.abgabeShiftMode === 'split_due') r.waitForLatestAbgabeDeadline = false;
  if (r.abgabeShiftMode === 'wait_latest') r.waitForLatestAbgabeDeadline = true;
  for (const k of ['weeklyReportHour','weeklyReportMinute','monthlyReportDay','monthlyReportHour','monthlyReportMinute']) if (k in body) r[k] = Number(body[k] || 0);
  ensureReportSettings(st.config);
  r.updatedAt = now();
  r.updatedBy = currentUserId(req);
  writeJson('config', st.config);
  const a = audit('report_settings_updated', currentUserId(req), { reportSettings: r });
  changed('config', a);
  res.json({ ok:true, reportSettings:r });
});

app.post('/api/sanctions', allowTokenOrLogin, requireAction('sanctionsWrite'), (req, res) => {
  const s = getStore(); s.sanctions.items ||= [];
  const amount = Math.max(0, Number(req.body.amount || 0));
  const item = { id: uid('san'), userId: req.body.userId, issuerId: currentUserId(req), catalogNo: req.body.catalogNo || 'WEB', catalogLabel: req.body.catalogLabel || req.body.reason || 'Web-Sanktion', penaltyType: req.body.penaltyType || 'Geldstrafe', amount, extraReason: req.body.extraReason || req.body.reason || 'Web-Sanktion', createdAt: now(), appealUntil: req.body.appealUntil || null, appealStatus: 'none', dueAt: req.body.dueAt || null, status: amount > 0 ? 'offen' : 'bezahlt', paid: amount <= 0, paidAt: amount <= 0 ? now() : null, paidBy: amount <= 0 ? currentUserId(req) : null, paused: false, source: 'web' };
  if (String(item.penaltyType).toLowerCase() === 'bloodout') { item.bloodoutAnnounced = true; item.bloodoutAt = now(); item.escalationRule = 'bloodout_direct'; }
  s.sanctions.items.unshift(item); writeJson('sanctions', s.sanctions);
  const a = audit('sanction_created', currentUserId(req), { id: item.id, userId: item.userId, penaltyType: item.penaltyType });
  changed('sanctions', a); res.json({ ok: true, item });
});
app.post('/api/wache/session', allowTokenOrLogin, requireModule('wache'), (req, res) => {
  const s = getStore(); const weekKey = req.body.weekKey || new Date().toISOString().slice(0,10); s.wache.weeks ||= {}; s.wache.weeks[weekKey] ||= { weekKey, users: {}, sessions: [], weeklyReportPosted:false, sanctionsProcessed:false };
  const participants = Array.isArray(req.body.participants) ? req.body.participants : [currentUserId(req)]; const minutes = Math.max(1, Number(req.body.minutes || 60)); const startTs = now(); const endTs = startTs + minutes*60000;
  s.wache.weeks[weekKey].sessions.push({ id: uid('wache'), startTs, endTs, participants: participants.length, source:'web' });
  for (const uidv of participants) { const u = s.wache.weeks[weekKey].users[uidv] ||= { totalMinutes:0, count:0, days:{}, entries:[] }; u.totalMinutes += minutes; u.count += 1; u.entries.push({ startTs, endTs, minutes, mode:'web' }); }
  writeJson('wache', s.wache); const a = audit('wache_session_created', currentUserId(req), { weekKey, participants, minutes }); changed('wache', a); res.json({ ok:true });
});


// =========================================================
// EXPANDED ADMIN FEATURES: Bloodin/Bloodout + Familienlager
// =========================================================
app.post('/api/blood', allowTokenOrLogin, requireAction('sanctionsWrite'), (req, res) => {
  const st = getStore();
  st.blood.items ||= [];
  const type = String(req.body.type || 'Bloodin').toLowerCase().includes('out') ? 'Bloodout' : 'Bloodin';
  const item = {
    id: uid('blood'),
    type,
    userId: String(req.body.userId || '').trim(),
    name: String(req.body.name || '').trim(),
    reason: String(req.body.reason || '').trim() || (type === 'Bloodin' ? 'Bloodin' : 'Bloodout'),
    at: req.body.at ? Number(req.body.at) : now(),
    source: 'web',
    status: String(req.body.status || 'aktiv').trim(),
    createdBy: currentUserId(req),
    createdAt: now()
  };
  if (!item.userId && !item.name) return res.status(400).json({ error: 'Bitte User oder Namen angeben.' });
  st.blood.items.unshift(item);
  writeJson('blood', st.blood);
  const a = audit('blood_saved', currentUserId(req), { id: item.id, type: item.type, userId: item.userId, name: item.name });
  changed('blood', a);
  res.json({ ok: true, item });
});

function ensureInventoryShape(inv) {
  inv.items ||= {};
  inv.family ||= { weapons: {}, leichteWesten: 0, schwereWesten: 0, munition: 0, langwaffenMunition: 0, kurzwaffenMunition: 0, history: [] };
  inv.family.weapons ||= {};
  inv.family.history ||= [];
  if (!Number.isFinite(Number(inv.family.langwaffenMunition))) inv.family.langwaffenMunition = Number(inv.family.munitionLang || inv.family.longAmmo || 0);
  if (!Number.isFinite(Number(inv.family.kurzwaffenMunition))) inv.family.kurzwaffenMunition = Number(inv.family.munitionKurz || inv.family.shortAmmo || inv.family.munition || 0);
  inv.family.munitionLang = inv.family.langwaffenMunition;
  inv.family.munitionKurz = inv.family.kurzwaffenMunition;
  return inv;
}
app.post('/api/inventory/family', allowTokenOrLogin, requireAction('cashboxWrite'), (req, res) => {
  const st = getStore();
  ensureInventoryShape(st.inventory);
  const patch = req.body.patch || {};
  if (patch.weapons && typeof patch.weapons === 'object') {
    for (const [k, v] of Object.entries(patch.weapons)) st.inventory.family.weapons[k] = Math.max(0, Number(v || 0));
  }
  for (const k of ['leichteWesten','schwereWesten','munition','langwaffenMunition','kurzwaffenMunition']) if (k in patch) st.inventory.family[k] = Math.max(0, Number(patch[k] || 0));
  if ('munitionLang' in patch && !('langwaffenMunition' in patch)) st.inventory.family.langwaffenMunition = Math.max(0, Number(patch.munitionLang || 0));
  if ('munitionKurz' in patch && !('kurzwaffenMunition' in patch)) st.inventory.family.kurzwaffenMunition = Math.max(0, Number(patch.munitionKurz || 0));
  st.inventory.family.munitionLang = st.inventory.family.langwaffenMunition;
  st.inventory.family.munitionKurz = st.inventory.family.kurzwaffenMunition;
  st.inventory.family.munition = st.inventory.family.kurzwaffenMunition;
  st.inventory.family.updatedAt = now();
  st.inventory.family.updatedBy = currentUserId(req);
  st.inventory.family.history.unshift({ id: uid('invh'), at: now(), by: currentUserId(req), action: 'family_set', patch });
  writeJson('inventory', st.inventory);
  const a = audit('family_inventory_updated', currentUserId(req), { patch });
  changed('inventory', a);
  res.json({ ok: true, family: st.inventory.family });
});
app.post('/api/inventory/transfer', allowTokenOrLogin, requireAction('cashboxWrite'), (req, res) => {
  const st = getStore();
  ensureInventoryShape(st.inventory);
  const userId = String(req.body.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'User fehlt.' });
  const direction = String(req.body.direction || 'toUser');
  const itemType = String(req.body.itemType || 'weapon');
  const itemName = String(req.body.itemName || '').trim();
  const qty = Math.max(1, Math.floor(Number(req.body.quantity || 1)));
  st.inventory.items[userId] ||= { weapons: {}, leichteWesten: 0, schwereWesten: 0, munition: 0, history: [] };
  st.inventory.items[userId].weapons ||= {};
  st.inventory.items[userId].history ||= [];
  const fam = st.inventory.family;
  const usr = st.inventory.items[userId];
  function moveCounter(objFrom, objTo, key) {
    objFrom[key] = Math.max(0, Number(objFrom[key] || 0) - qty);
    objTo[key] = Math.max(0, Number(objTo[key] || 0) + qty);
  }
  let label = itemName;
  if (itemType === 'weapon') {
    if (!itemName) return res.status(400).json({ error: 'Waffenname fehlt.' });
    if (direction === 'toUser') moveCounter(fam.weapons, usr.weapons, itemName); else moveCounter(usr.weapons, fam.weapons, itemName);
  } else {
    const keyMap = { leichteWeste: 'leichteWesten', schwereWeste: 'schwereWesten', munition: 'munition' };
    const key = keyMap[itemType] || itemType;
    if (!['leichteWesten','schwereWesten','munition'].includes(key)) return res.status(400).json({ error: 'Unbekannter Lagertyp.' });
    label = key;
    if (direction === 'toUser') moveCounter(fam, usr, key); else moveCounter(usr, fam, key);
  }
  const hist = { id: uid('invh'), at: now(), by: currentUserId(req), action: direction === 'toUser' ? 'family_to_user' : 'user_to_family', userId, itemType, itemName: label, quantity: qty, note: req.body.note || '' };
  fam.history.unshift(hist); usr.history.unshift(hist); fam.updatedAt = usr.updatedAt = now();
  writeJson('inventory', st.inventory);
  const a = audit('inventory_transfer', currentUserId(req), hist);
  changed('inventory', a);
  res.json({ ok: true, family: fam, user: usr, history: hist });
});


app.post('/api/trading/config', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const s = getStore(); s.trading = ensureTradingShape(s.trading);
  const type = String(req.body.type||'product');
  const key = slug(req.body.key || req.body.name || 'item');
  if (type === 'vehicle') {
    if (req.body.delete) delete s.trading.vehicles[key];
    else s.trading.vehicles[key] = { key, name:String(req.body.name||key), capacity:Number(req.body.capacity||0), active:req.body.active !== false };
  } else {
    if (req.body.delete) delete s.trading.products[key];
    else s.trading.products[key] = { key, name:String(req.body.name||key), price:Number(req.body.price||0), active:req.body.active !== false };
  }
  writeJson('trading', s.trading);
  const a = audit('trading_config_updated', currentUserId(req), { type, key }); changed('trading', a);
  res.json({ ok:true, trading:s.trading });
});
app.post('/api/trading/loans', allowTokenOrLogin, requireAction('cashboxWrite'), (req, res) => {
  const s = getStore(); s.trading = ensureTradingShape(s.trading);
  if (req.body.id && req.body.status) {
    const item = s.trading.loans.find(x=>x.id===req.body.id); if(!item) return res.status(404).json({error:'Ausleihe nicht gefunden'});
    item.status = String(req.body.status); item.closedAt = now(); item.closedBy = currentUserId(req);
  } else {
    const vehicleKey = String(req.body.vehicleKey||'').trim(); const productKey = String(req.body.productKey||'').trim();
    const v = s.trading.vehicles[vehicleKey] || {}; const pr = s.trading.products[productKey] || {};
    const amount = Math.max(0, Number(req.body.amount || v.capacity || 0));
    const price = Math.max(0, Number(req.body.price ?? pr.price ?? 0));
    if (s.trading.products[productKey] && Number.isFinite(price)) {
      // Der eingegebene Preis wird als neuer Standardpreis für dieses Produkt gespeichert.
      s.trading.products[productKey].price = price;
    }
    s.trading.loans.unshift({ id:uid('loan'), vehicleKey, vehicleName:v.name||vehicleKey, productKey, productName:pr.name||productKey, amount, price, value: amount * price, from:String(req.body.from||''), to:String(req.body.to||''), note:String(req.body.note||''), status:'aktiv', createdAt:now(), createdBy:currentUserId(req) });
  }
  writeJson('trading', s.trading);
  const a = audit('trading_loan_updated', currentUserId(req), req.body); changed('trading', a);
  res.json({ ok:true, trading:s.trading });
});



// ===== V26: Web-Wache, Reports und Sanktions-Freigaben =====
function currentIsoWeekKeyV26(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}
function ensureWacheV26(st) {
  st.wache ||= { weeks:{} };
  st.wache.weeks ||= {};
  st.wache.active ||= {};
  return st.wache;
}
app.post('/api/wache/start', allowTokenOrLogin, requireModule('wache'), (req, res) => {
  const st = getStore(); const w = ensureWacheV26(st);
  const userId = String(req.body.userId || currentUserId(req) || '').trim();
  if (!userId) return res.status(400).json({ error:'User fehlt.' });
  if (userId !== currentUserId(req) && !req.perms?.actions?.attendanceManage) return res.status(403).json({ error:'Keine Berechtigung für andere Mitglieder.' });
  if (w.active[userId]?.startTs) return res.json({ ok:true, active:w.active[userId], alreadyActive:true });
  w.active[userId] = { userId, startTs: now(), startedBy: currentUserId(req), source:'web' };
  writeJson('wache', w); const a=audit('wache_started', currentUserId(req), { userId }); changed('wache', a);
  res.json({ ok:true, active:w.active[userId] });
});
app.post('/api/wache/end', allowTokenOrLogin, requireModule('wache'), (req, res) => {
  const st = getStore(); const w = ensureWacheV26(st);
  const userId = String(req.body.userId || currentUserId(req) || '').trim();
  if (!userId) return res.status(400).json({ error:'User fehlt.' });
  if (userId !== currentUserId(req) && !req.perms?.actions?.attendanceManage) return res.status(403).json({ error:'Keine Berechtigung für andere Mitglieder.' });
  const active = w.active[userId];
  if (!active?.startTs) return res.status(404).json({ error:'Keine aktive Wache gefunden.' });
  const endTs = now(); const minutes = Math.max(1, Math.round((endTs - Number(active.startTs || endTs)) / 60000));
  const weekKey = currentIsoWeekKeyV26(new Date(Number(active.startTs || endTs)));
  w.weeks[weekKey] ||= { weekKey, users:{}, sessions:[], weeklyReportPosted:false, sanctionsProcessed:false };
  w.weeks[weekKey].sessions.push({ id: uid('wache'), startTs: active.startTs, endTs, participants: 1, participantIds:[userId], userId, minutes, source:'web-live' });
  const u = w.weeks[weekKey].users[userId] ||= { totalMinutes:0, count:0, days:{}, entries:[] };
  u.totalMinutes += minutes; u.count += 1; u.entries.push({ startTs:active.startTs, endTs, minutes, mode:'web-live' });
  delete w.active[userId];
  writeJson('wache', w); const a=audit('wache_ended', currentUserId(req), { userId, weekKey, minutes }); changed('wache', a);
  res.json({ ok:true, weekKey, minutes });
});

app.get('/api/reports/monthly', allowTokenOrLogin, requireModule('cashbox'), (req, res) => {
  const st = getStore();
  const month = String(req.query.month || new Date().toISOString().slice(0,7));
  const start = new Date(month + '-01T00:00:00.000Z').getTime();
  const endDate = new Date(start); endDate.setUTCMonth(endDate.getUTCMonth()+1);
  const end = endDate.getTime();
  const inMonth = t => { const n=Number(t||0); return n>=start && n<end; };
  const cashTx = (st.cashbox?.transactions||[]).filter(x=>inMonth(x.createdAt||x.at));
  const cashIncome = cashTx.filter(x=>x.type!=='expense').reduce((a,x)=>a+Number(x.amount||0),0);
  const cashExpense = cashTx.filter(x=>x.type==='expense').reduce((a,x)=>a+Number(x.amount||0),0);
  const familyHistory = (st.inventory?.family?.history||[]).filter(x=>inMonth(x.at||x.createdAt));
  const userHistory = Object.entries(st.inventory?.items||{}).flatMap(([userId,item])=>(item.history||[]).map(h=>({userId,...h}))).filter(x=>inMonth(x.at||x.createdAt));
  const loans = (st.trading?.loans||[]).filter(x=>inMonth(x.createdAt));
  res.json({ ok:true, month, cash:{ balance:st.cashbox?.balance||0, transactions:cashTx, income:cashIncome, expense:cashExpense, net:cashIncome-cashExpense }, inventory:{ familyHistory, userHistory }, loans });
});

function pendingSanctionsV26(st) {
  return (st.sanctions?.items||[]).filter(x => {
    const stt=String(x.status||'').toLowerCase();
    if (x.paid || ['bezahlt','gelöscht','geloescht','storniert','abgelehnt','rejected','approved','freigegeben'].includes(stt)) return false;
    return x.needsApproval === true || x.approvalStatus === 'pending' || ['auto','abgabe_auto','term_auto'].includes(String(x.source||'').toLowerCase()) || !x.approvalStatus;
  });
}
app.get('/api/sanctions/approvals', allowTokenOrLogin, requireAction('sanctionApprove'), (req, res) => {
  const st=getStore(); res.json({ ok:true, items: pendingSanctionsV26(st) });
});
app.post('/api/sanctions/approvals', allowTokenOrLogin, requireAction('sanctionApprove'), (req, res) => {
  const st=getStore(); st.sanctions ||= {}; st.sanctions.items ||= [];
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
  const action = String(req.body.action||'').toLowerCase();
  const selected = ids.length ? st.sanctions.items.filter(x=>ids.includes(String(x.id))) : pendingSanctionsV26(st);
  const by=currentUserId(req)||'web';
  const changedItems=[];
  for (const item of selected) {
    if (action === 'approve' || action === 'accept' || action === 'ausstellen') {
      item.approvalStatus='approved'; item.status = item.status && item.status !== 'pending' ? item.status : 'offen'; item.approvedAt=now(); item.approvedBy=by; item.needsApproval=false;
    } else if (action === 'reject' || action === 'decline' || action === 'ablehnen') {
      item.approvalStatus='rejected'; item.status='abgelehnt'; item.rejectedAt=now(); item.rejectedBy=by; item.needsApproval=false;
      st.sessions ||= {}; st.sessions.autoSanctionSuppressions ||= {};
      const key = [item.source||'unknown', item.userId||'', item.relatedWeek||'', item.relatedCategory||'', item.relatedTermId||''].join('|');
      st.sessions.autoSanctionSuppressions[key] = { key, source:item.source||'unknown', userId:item.userId||'', relatedWeek:item.relatedWeek||null, relatedCategory:item.relatedCategory||null, relatedTermId:item.relatedTermId||null, suppressedAt:now(), suppressedBy:by, reason:'approval_rejected' };
    }
    changedItems.push(item.id);
  }
  writeJson('sanctions', st.sanctions); if (st.sessions) writeJson('sessions', st.sessions);
  const a=audit('sanction_approvals_updated', by, { action, ids:changedItems }); changed('sanctions', a);
  res.json({ ok:true, action, count:changedItems.length, items:selected });
});



// ===== V27: Reset-Zentrale + saubere Kassenartikel =====
function emptyInventoryV27(){ return { items:{}, family:{ weapons:{}, leichteWesten:0, schwereWesten:0, langwaffenMunition:0, kurzwaffenMunition:0, munition:0, history:[] } }; }
function emptyWacheV27(){ return { weeks:{}, active:{} }; }
app.post('/api/admin/reset-data', allowTokenOrLogin, requireAction('configWrite'), (req, res) => {
  const st = getStore();
  const raw = Array.isArray(req.body.targets) ? req.body.targets.map(String) : [String(req.body.target || '')];
  const targets = new Set(raw.map(x => x.trim()).filter(Boolean));
  if (targets.has('all')) ['wache','abgaben','sanctions','absences','inventory','cashbox','trading','blood','stats'].forEach(x=>targets.add(x));
  const by = currentUserId(req) || 'web';
  const changedTargets = [];
  if (targets.has('wache')) { st.wache = emptyWacheV27(); writeJson('wache', st.wache); changedTargets.push('wache'); }
  if (targets.has('abgaben') || targets.has('abgabenStats')) { st.abgaben = { weeks:{} }; writeJson('abgaben', st.abgaben); changedTargets.push('abgaben'); }
  if (targets.has('sanctions')) { st.sanctions = { items:[] }; writeJson('sanctions', st.sanctions); changedTargets.push('sanctions'); }
  if (targets.has('absences')) { st.absences = { items:[] }; writeJson('absences', st.absences); changedTargets.push('absences'); }
  if (targets.has('inventory') || targets.has('lager')) { st.inventory = emptyInventoryV27(); writeJson('inventory', st.inventory); changedTargets.push('inventory'); }
  if (targets.has('cashbox') || targets.has('kasse')) { st.cashbox = { balance:0, transactions:[] }; writeJson('cashbox', st.cashbox); changedTargets.push('cashbox'); }
  if (targets.has('trading')) { st.trading = ensureTradingShape({}); writeJson('trading', st.trading); changedTargets.push('trading'); }
  if (targets.has('blood')) { st.blood = { items:[] }; writeJson('blood', st.blood); changedTargets.push('blood'); }
  const a = audit('admin_data_reset', by, { targets:[...targets], changedTargets });
  for (const t of changedTargets) changed(t, a);
  res.json({ ok:true, changedTargets });
});

app.post('/api/bot-sync', (req, res) => { if (BOT_SYNC_SECRET && req.headers['x-bot-sync-secret'] !== BOT_SYNC_SECRET) return res.status(401).json({ error:'Bad secret' }); const a = audit('bot_sync_event', 'bot', req.body); emitUpdate(req.body.type || 'bot', req.body); res.json({ ok:true, audit:a }); });
app.get('/api/export', allowTokenOrLogin, requireModule('config'), (_, res) => res.json(getStore()));

io.on('connection', socket => socket.emit('hello', { ok:true, at:Date.now() }));
server.listen(PORT, () => console.log(`RP Dashboard online: http://localhost:${PORT}`));
