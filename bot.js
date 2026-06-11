require('dotenv').config();
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  AttachmentBuilder,
  REST,
  Routes,
} = require('discord.js');
// =========================================================
// CONFIG
// =========================================================
const TOKEN = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin';
const BOT_BUILD = 'V13.6-Stability-Speed-2026-05-06';
const CASHBOX_WEBHOOK_PORT = Number(process.env.CASHBOX_WEBHOOK_PORT || process.env.PORT || 3000);
const CASHBOX_WEBHOOK_SECRET = String(process.env.CASHBOX_WEBHOOK_SECRET || process.env.RECEIVER_SECRET || process.env.BOT_BRIDGE_SECRET || '').trim();
const MONITORING_CHANNEL_ID = '1486921108019220490';
const LOG_CHANNEL_ID = '1486974180506206250';
const APPROVAL_CHANNEL_ID = '1475995970960494784';
const APPROVAL_TIMEOUT_SECONDS = 300;
const ATTENDANCE_CHECK_TTL_MS = 30 * 60 * 1000;

const COLORS = {
  primary: 0xD4AF37,
  success: 0xD4AF37,
  warning: 0xD4AF37,
  danger: 0xD4AF37,
  info: 0xD4AF37,
};
const LEADERSHIP_ROLE_IDS = String(process.env.LEADERSHIP_ROLE_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);
const ROUTENVERWALTUNG_ROLE_IDS = String(process.env.ROUTENVERWALTUNG_ROLE_IDS || process.env.ROUTENVERWALTUNG_ROLE_ID || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);
const ROUTEN_ROLE_ID = process.env.ROUTEN_ROLE_ID || '';
const METH_ROLE_ID = process.env.METH_ROLE_ID || '';
const PATRONEN_ROLE_ID = process.env.PATRONEN_ROLE_ID || process.env.EISEN_ROLE_ID || '';
const SCHWARZPULVER_ROLE_ID = process.env.SCHWARZPULVER_ROLE_ID || process.env.SCHWEFEL_ROLE_ID || '';
if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Bitte .env prüfen: BOT_TOKEN/DISCORD_TOKEN, CLIENT_ID und GUILD_ID müssen gesetzt sein.');
  process.exit(1);
}
const ABGABEN = {
  routen: {
    key: 'routen',
    label: 'Routen',
    amount: 300000,
    unit: '$',
    roleId: ROUTEN_ROLE_ID,
    channelName: 'routen-abgabe',
    emoji: '💸',
  },
  patronen: {
    key: 'patronen',
    label: 'Patronenhülsen',
    amount: 200,
    unit: '',
    roleId: PATRONEN_ROLE_ID,
    channelName: 'patronenhuelsen-abgabe',
    emoji: '🧱',
  },
  schwarzpulver: {
    key: 'schwarzpulver',
    label: 'Schwarzpulver',
    amount: 200,
    unit: '',
    roleId: SCHWARZPULVER_ROLE_ID,
    channelName: 'schwarzpulver-abgabe',
    emoji: '⚗️',
  },
  meth: {
    key: 'meth',
    label: 'Methkisten',
    amount: 500,
    unit: 'Kisten',
    roleId: METH_ROLE_ID,
    channelName: 'meth-abgabe',
    emoji: '🧪',
  },
};
const ABSENCE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30];

function ensureAbgabenEnabledConfig() {
  if (!store?.config?.settings) return;
  if (!store.config.settings.abgabenEnabled || typeof store.config.settings.abgabenEnabled !== 'object') {
    store.config.settings.abgabenEnabled = {};
  }
  for (const key of ["routen", "patronen", "schwarzpulver", "meth"]) {
    if (typeof store.config.settings.abgabenEnabled[key] !== 'boolean') {
      store.config.settings.abgabenEnabled[key] = true;
    }
  }
}
function isAbgabeEnabled(category) {
  ensureAbgabenEnabledConfig();
  return store.config.settings.abgabenEnabled[category] !== false;
}
function getEnabledAbgabeKeys() {
  ensureAbgabenEnabledConfig();
  return ["routen","patronen","schwarzpulver","meth"].filter(key => isAbgabeEnabled(key));
}
function getAbgabeAbsenceExcuseDays() {
  ensureAbgabenRuntimeConfig();
  return Math.max(0, Math.round(Number(store.config.settings.abgabenAbsenceExcuseDays ?? 5)));
}
function setAbgabeAbsenceExcuseDays(days, byId = 'system') {
  ensureAbgabenRuntimeConfig();
  const next = Math.max(0, Math.min(30, Math.round(Number(days) || 0)));
  const before = getAbgabeAbsenceExcuseDays();
  store.config.settings.abgabenAbsenceExcuseDays = next;
  if (before !== next) {
    store.config.settings.abgabenReportSkipBeforeTs = now();
    appendAuditLog?.('abgabe_absence_excuse_days_changed', byId, null, { before, after: next });
  }
  saveAll();
  return next;
}

const ABGABE_DEFAULT_DEADLINE = { day: 7, hour: 23, minute: 59 }; // 1=Montag ... 7=Sonntag
const ABGABE_LABELS = { routen: 'Routen', patronen: 'Patronenhülsen', schwarzpulver: 'Schwarzpulver', meth: 'Methkisten' };
const ABGABE_DAY_LABELS = { 1: 'Montag', 2: 'Dienstag', 3: 'Mittwoch', 4: 'Donnerstag', 5: 'Freitag', 6: 'Samstag', 7: 'Sonntag' };
function ensureAbgabenRuntimeConfig() {
  ensureAbgabenEnabledConfig();
  if (!store?.config?.settings) return;
  if (!Number.isInteger(Number(store.config.settings.abgabenAbsenceExcuseDays)) || Number(store.config.settings.abgabenAbsenceExcuseDays) < 0) {
    store.config.settings.abgabenAbsenceExcuseDays = 5;
  }
  if (!store.config.settings.abgabenConfig || typeof store.config.settings.abgabenConfig !== 'object') {
    store.config.settings.abgabenConfig = {};
  }
  if (!store.config.settings.abgabenTemporaryOverrides || typeof store.config.settings.abgabenTemporaryOverrides !== 'object') {
    store.config.settings.abgabenTemporaryOverrides = {};
  }
  if (typeof store.config.settings.abgabenReportSkipBeforeTs !== 'number') {
    store.config.settings.abgabenReportSkipBeforeTs = 0;
  }
  for (const key of ["routen", "patronen", "schwarzpulver", "meth"]) {
    const base = ABGABEN[key];
    const current = store.config.settings.abgabenConfig[key];
    if (!current || typeof current !== 'object') store.config.settings.abgabenConfig[key] = {};
    const cfg = store.config.settings.abgabenConfig[key];
    if (!Number.isFinite(Number(cfg.amount)) || Number(cfg.amount) <= 0) cfg.amount = Number(base.amount || 0);
    if (!Number.isInteger(Number(cfg.deadlineDay)) || Number(cfg.deadlineDay) < 1 || Number(cfg.deadlineDay) > 7) cfg.deadlineDay = ABGABE_DEFAULT_DEADLINE.day;
    if (!Number.isInteger(Number(cfg.deadlineHour)) || Number(cfg.deadlineHour) < 0 || Number(cfg.deadlineHour) > 23) cfg.deadlineHour = ABGABE_DEFAULT_DEADLINE.hour;
    if (!Number.isInteger(Number(cfg.deadlineMinute)) || Number(cfg.deadlineMinute) < 0 || Number(cfg.deadlineMinute) > 59) cfg.deadlineMinute = ABGABE_DEFAULT_DEADLINE.minute;
  }
}
function getAbgabeRuntimeConfig(category) {
  ensureAbgabenRuntimeConfig();
  const base = ABGABEN[category] || {};
  const saved = store.config.settings.abgabenConfig?.[category] || {};
  return {
    ...base,
    amount: Number(saved.amount || base.amount || 0),
    enabled: isAbgabeEnabled(category),
    deadlineDay: Number(saved.deadlineDay || ABGABE_DEFAULT_DEADLINE.day),
    deadlineHour: Number(saved.deadlineHour ?? ABGABE_DEFAULT_DEADLINE.hour),
    deadlineMinute: Number(saved.deadlineMinute ?? ABGABE_DEFAULT_DEADLINE.minute),
  };
}
function getAbgabeAmount(category, weekKey = null) {
  if (weekKey) {
    const override = getAbgabeTemporaryOverride(category, weekKey);
    if (override && Number(override.amountOverride || 0) > 0) return Number(override.amountOverride);
  }
  return getAbgabeRuntimeConfig(category).amount;
}
function formatAbgabeDeadlineConfig(category) {
  const cfg = getAbgabeRuntimeConfig(category);
  return `${ABGABE_DAY_LABELS[cfg.deadlineDay] || 'Sonntag'} ${String(cfg.deadlineHour).padStart(2, '0')}:${String(cfg.deadlineMinute).padStart(2, '0')}`;
}
function parseAbgabeDay(input) {
  const raw = String(input || '').trim().toLowerCase();
  const map = { mo: 1, montag: 1, monday: 1, di: 2, dienstag: 2, tuesday: 2, mi: 3, mittwoch: 3, wednesday: 3, do: 4, donnerstag: 4, thursday: 4, fr: 5, freitag: 5, friday: 5, sa: 6, samstag: 6, saturday: 6, so: 7, sonntag: 7, sunday: 7 };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
  return map[raw] || null;
}
function parseAbgabeTime(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function normalizeAbgabeCategoryInput(input) {
  const raw = normalizeText(input);
  const map = {
    routen: 'routen', route: 'routen',
    patronen: 'patronen', patronenhuelsen: 'patronen', patronhuelsen: 'patronen',
    schwarzpulver: 'schwarzpulver', schwefel: 'schwarzpulver', pulver: 'schwarzpulver',
    meth: 'meth', methkisten: 'meth',
  };
  return map[raw] || (ABGABEN[raw] ? raw : null);
}
function getAbgabeTemporaryOverride(category, weekKey) {
  ensureAbgabenRuntimeConfig();
  return store.config.settings.abgabenTemporaryOverrides?.[weekKey]?.[category] || null;
}
function setAbgabeTemporaryOverride(category, weekKey, changes = {}) {
  ensureAbgabenRuntimeConfig();
  if (!ABGABEN[category]) throw new Error('Unbekannte Abgabeart.');
  if (!/^\d{4}-W\d{2}$/.test(String(weekKey || ''))) throw new Error('Woche muss z. B. 2026-W18 sein.');
  const day = Number(changes.deadlineDay);
  const hour = Number(changes.deadlineHour);
  const minute = Number(changes.deadlineMinute);
  if (!Number.isInteger(day) || day < 1 || day > 7) throw new Error('Tag muss 1-7 sein.');
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Uhrzeit muss HH:MM sein.');
  store.config.settings.abgabenTemporaryOverrides[weekKey] ||= {};
  store.config.settings.abgabenTemporaryOverrides[weekKey][category] = { deadlineDay: day, deadlineHour: hour, deadlineMinute: minute, setAt: now(), setBy: changes.setBy || 'system' };
  appendAuditLog('abgabe_temp_shift', changes.setBy || 'system', null, { category, weekKey, deadlineDay: day, deadlineHour: hour, deadlineMinute: minute });
  invalidateStatsCache('abgabe_temp_shift');
  saveAll();
  return store.config.settings.abgabenTemporaryOverrides[weekKey][category];
}
function setAbgabeTemporaryShiftByDays(category, weekKey, days, setBy = 'system') {
  ensureAbgabenRuntimeConfig();
  if (!ABGABEN[category]) throw new Error('Unbekannte Abgabeart.');
  if (!/^\d{4}-W\d{2}$/.test(String(weekKey || ''))) throw new Error('Woche muss z. B. 2026-W18 sein.');

  const add = Number(days);
  if (!Number.isInteger(add) || add < 1 || add > 30) throw new Error('Tage müssen eine Zahl zwischen 1 und 30 sein.');

  const baseCfg = getAbgabeRuntimeConfig(category);
  const mondayBase = weekKeyToMondayDate(weekKey);
  const baseDeadline = new Date(mondayBase);
  baseDeadline.setDate(mondayBase.getDate() + (Number(baseCfg.deadlineDay || 7) - 1));
  baseDeadline.setHours(Number(baseCfg.deadlineHour ?? 23), Number(baseCfg.deadlineMinute ?? 59), 0, 0);

  const shifted = new Date(baseDeadline.getTime() + (add * 24 * 60 * 60 * 1000));
  const monday = weekKeyToMondayDate(weekKey);
  const diffDays = Math.floor((shifted.getTime() - monday.getTime()) / 86400000);

  const deadlineDay = (diffDays % 7) + 1;
  const deadlineWeekOffset = Math.floor(diffDays / 7);
  const deadlineHour = shifted.getHours();
  const deadlineMinute = shifted.getMinutes();

  ensureAbgabenRuntimeConfig();
  store.config.settings.abgabenTemporaryOverrides[weekKey] ||= {};
  store.config.settings.abgabenTemporaryOverrides[weekKey][category] = {
    deadlineDay,
    deadlineWeekOffset,
    deadlineHour,
    deadlineMinute,
    deadlineTs: shifted.getTime(),
    shiftDays: add,
    amountOverride: add === 7 ? getAbgabeRuntimeConfig(category).amount * 2 : undefined,
    doubleAbgabe: add === 7,
    setAt: now(),
    setBy,
  };
  saveAll();
  return store.config.settings.abgabenTemporaryOverrides[weekKey][category];
}

function clearAbgabeTemporaryOverride(category, weekKey) {
  ensureAbgabenRuntimeConfig();
  const bucket = store.config.settings.abgabenTemporaryOverrides?.[weekKey];
  if (bucket && bucket[category]) {
    delete bucket[category];
    if (!Object.keys(bucket).length) delete store.config.settings.abgabenTemporaryOverrides[weekKey];
    saveAll();
    return true;
  }
  return false;
}
function formatAbgabeTemporaryOverrides() {
  ensureAbgabenRuntimeConfig();
  const lines = [];
  for (const [weekKey, bucket] of Object.entries(store.config.settings.abgabenTemporaryOverrides || {})) {
    for (const [category, cfg] of Object.entries(bucket || {})) {
      const label = ABGABEN[category]?.label || category;
      const displayTs = Number(cfg.deadlineTs || 0) || getAbgabeDeadlineTsForWeek(category, weekKey);
      const amountText = Number(cfg.amountOverride || 0) > 0 ? ` • Betrag: **${formatAmount(category, cfg.amountOverride)}**` : '';
      lines.push(`${weekKey} • ${label}: **${formatDateTime(displayTs)}**${amountText}`);
    }
  }
  return lines.slice(-8);
}
function markAbgabeReportsSkipBeforeNow() {
  ensureAbgabenRuntimeConfig();
  store.config.settings.abgabenReportSkipBeforeTs = now();
  saveAll();
}
function ensureAbgabeActivationTracking() {
  ensureAbgabenRuntimeConfig();
  const settings = store.config.settings;
  if (!settings.abgabenEnabledAt || typeof settings.abgabenEnabledAt !== 'object') settings.abgabenEnabledAt = {};
  if (!settings.abgabenDisabledAt || typeof settings.abgabenDisabledAt !== 'object') settings.abgabenDisabledAt = {};
  for (const key of Object.keys(ABGABEN)) {
    if (typeof settings.abgabenEnabledAt[key] !== 'number') settings.abgabenEnabledAt[key] = 0;
    if (typeof settings.abgabenDisabledAt[key] !== 'number') settings.abgabenDisabledAt[key] = 0;
  }
}
function markExistingAbgabeWeeksProcessedForCategory(category, changedAt = now()) {
  ensureAbgabeActivationTracking();
  for (const [weekKey, week] of Object.entries(store.abgaben?.weeks || {})) {
    const deadlineTs = getAbgabeDeadlineTsForWeek(category, weekKey);
    if (deadlineTs > changedAt) continue;
    week.categories ||= {};
    week.categories[category] ||= {};
    week.categories[category]._configSkipped = { at: changedAt, reason: 'config_changed_or_disabled' };
  }
}
function isAbgabeCategoryActiveForWeek(category, weekKey) {
  ensureAbgabeActivationTracking();
  if (!isAbgabeEnabled(category)) return false;
  const enabledAt = Number(store.config.settings.abgabenEnabledAt?.[category] || 0);
  if (!enabledAt) return true;
  const deadlineTs = getAbgabeDeadlineTsForWeek(category, weekKey);
  // Wenn eine Abgabe neu aktiviert wird, dürfen bereits abgelaufene Wochen nicht rückwirkend zählen.
  return deadlineTs > enabledAt;
}
function getEnabledAbgabeKeysForWeek(weekKey) {
  return getEnabledAbgabeKeys().filter(key => isAbgabeCategoryActiveForWeek(key, weekKey));
}
function setAbgabeRuntimeConfig(category, changes = {}) {
  ensureAbgabenRuntimeConfig();
  if (!ABGABEN[category]) throw new Error('Unbekannte Abgabeart.');
  ensureAbgabeActivationTracking();
  const cfg = store.config.settings.abgabenConfig[category];
  if (changes.enabled != null) {
    const before = store.config.settings.abgabenEnabled[category] !== false;
    const next = !!changes.enabled;
    store.config.settings.abgabenEnabled[category] = next;
    if (before !== next) {
      const changedAt = now();
      if (next) store.config.settings.abgabenEnabledAt[category] = changedAt;
      else store.config.settings.abgabenDisabledAt[category] = changedAt;
      store.config.settings.abgabenReportSkipBeforeTs = changedAt;
      markExistingAbgabeWeeksProcessedForCategory(category, changedAt);
    }
  }
  if (changes.amount != null) {
    const amount = Number(changes.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Menge muss größer als 0 sein.');
    cfg.amount = Math.round(amount);
  }
  if (changes.deadlineDay != null) {
    const day = Number(changes.deadlineDay);
    if (!Number.isInteger(day) || day < 1 || day > 7) throw new Error('Tag muss 1-7 sein.');
    cfg.deadlineDay = day;
  }
  if (changes.deadlineHour != null || changes.deadlineMinute != null) {
    const hour = Number(changes.deadlineHour ?? cfg.deadlineHour);
    const minute = Number(changes.deadlineMinute ?? cfg.deadlineMinute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Uhrzeit muss HH:MM sein.');
    cfg.deadlineHour = hour;
    cfg.deadlineMinute = minute;
  }
  saveAll();
  return getAbgabeRuntimeConfig(category);
}
function buildAbgabeConfigEmbed() {
  ensureAbgabenRuntimeConfig();
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📦 Abgaben-Konfiguration')
    .setDescription(`Hier kannst du Abgabearten einzeln aktivieren/deaktivieren, den festen Abgabetag verschieben und die Pflichtmenge anpassen. Entschuldigt ab: **${getAbgabeAbsenceExcuseDays()} Abmeldetagen/Woche**. Vorübergehende Verschiebungen gelten nur für eine gewählte Woche.`)
    .addFields(
      ...Object.keys(ABGABEN).map(key => {
      const cfg = getAbgabeRuntimeConfig(key);
      return {
        name: `${cfg.emoji || '📦'} ${cfg.label}`,
        value: [`Status: **${cfg.enabled ? 'AN' : 'AUS'}**`, `Pflichtmenge: **${formatAmount(key, cfg.amount)}**`, `Abgabetag: **${formatAbgabeDeadlineConfig(key)}**`].join('\n'),
        inline: true,
      };
      }),
      buildInfoField('⏰ Vorübergehend verschoben', formatAbgabeTemporaryOverrides().length ? formatAbgabeTemporaryOverrides() : ['Keine aktive vorübergehende Verschiebung.'], false),
    )
    .setFooter({ text: 'Normale Änderungen lösen keinen Wochenbericht aus. Berichte kommen nur zur Wochenfrist oder zur vorübergehend verschobenen Frist.' });
}
function buildAbgabeConfigComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('leader_abgabe_config_select')
        .setPlaceholder('Abgabe bearbeiten')
        .addOptions(Object.keys(ABGABEN).map(key => {
          const cfg = getAbgabeRuntimeConfig(key);
          return { label: cfg.label, value: key, description: `${cfg.enabled ? 'AN' : 'AUS'} • ${formatAmount(key, cfg.amount)} • ${formatAbgabeDeadlineConfig(key)}`.slice(0, 100), emoji: cfg.emoji || '📦' };
        }))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('leader_abgabe_temp_shift').setLabel('⏰ Vorübergehend verschieben').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('leader_abgabe_temp_clear').setLabel('🧹 Verschiebung löschen').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('leader_abgabe_absence_days').setLabel('📋 Abmeldetage').setStyle(ButtonStyle.Secondary),
    )
  ];
}
function buildAbgabeAbsenceDaysModal() {
  return new ModalBuilder()
    .setCustomId('abgabe_absence_days_modal')
    .setTitle('Abgabe: Entschuldigt ab')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('days')
          .setLabel('Abmeldetage pro Woche?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(getAbgabeAbsenceExcuseDays()))
      )
    );
}
function buildAbgabeTemporaryShiftModal() {
  return new ModalBuilder()
    .setCustomId('abgabe_temp_shift_modal')
    .setTitle('Abgabe + Tage verschieben')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Abgabe: routen/meth/schwarzpulver/patronen').setStyle(TextInputStyle.Short).setRequired(true).setValue('routen')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('week').setLabel('Woche z. B. 2026-W18').setStyle(TextInputStyle.Short).setRequired(true).setValue(currentWeekKey())),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('days').setLabel('Um wie viele Tage verschieben? z. B. 1, 2, 7').setStyle(TextInputStyle.Short).setRequired(true).setValue('1'))
    );
}
function buildAbgabeTemporaryClearModal() {
  return new ModalBuilder()
    .setCustomId('abgabe_temp_clear_modal')
    .setTitle('Vorübergehende Verschiebung löschen')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Abgabe: routen/meth/schwarzpulver/patronen').setStyle(TextInputStyle.Short).setRequired(true).setValue('routen')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('week').setLabel('Woche z. B. 2026-W18').setStyle(TextInputStyle.Short).setRequired(true).setValue(currentWeekKey()))
    );
}
function buildAbgabeConfigModal(category) {
  const cfg = getAbgabeRuntimeConfig(category);
  return new ModalBuilder()
    .setCustomId(`abgabe_config_modal:${category}`)
    .setTitle(`${cfg.label} bearbeiten`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Status: an oder aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Pflichtmenge').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.amount))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('day').setLabel('Abgabetag: 1-7 oder Montag-Sonntag').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.deadlineDay))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Uhrzeit: HH:MM').setStyle(TextInputStyle.Short).setRequired(true).setValue(`${String(cfg.deadlineHour).padStart(2, '0')}:${String(cfg.deadlineMinute).padStart(2, '0')}`))
    );
}
const SANCTION_TYPES = ['Grüngeld', 'Schwarzgeld', 'Eisen', 'Schwefel', 'Meth', 'Bloodout'];
const TERM_TYPES = [
  'Aufstellung',
  'Treffen mit Familie',
  'Munition Verkauf',
  'Munition Einkauf',
  'Waffe Verkauf',
  'Waffe Einkauf',
  'Westen Verkauf',
  'Westen Einkauf',
  'Eigene',
];
const ALWAYS_AUTO_CAN_USER_ID = '1233152028096856126';
const TERM_RESPONSE_MAP = {
  can: 'Kann',
  maybe: 'Kann vielleicht',
  cannot: 'Kann nicht',
};
const TERM_REQUIREMENT_OPTIONS = [
  { label: 'Pflichttermin', value: 'required', description: 'Keine Antwort kann sanktioniert werden.', emoji: '⚠️' },
  { label: 'Kein Pflichttermin', value: 'optional', description: 'Keine Antwort wird nicht sanktioniert.', emoji: '✅' },
];
function isTermRequired(term) {
  // Alte Termine hatten dieses Feld noch nicht. Sie bleiben zur Sicherheit Pflichttermine.
  return term?.required !== false;
}
function getTermRequirementLabel(term) {
  return isTermRequired(term) ? 'Pflichttermin' : 'Kein Pflichttermin';
}
const MEMBER_FETCH_TTL_MS = 30 * 60 * 1000;
const MEMBER_FETCH_TIMEOUT_MS = 15000;
const DASHBOARD_UPDATE_MIN_INTERVAL_MS = 60 * 1000;
const TERM_UPDATE_DEBOUNCE_MS = 2500;
const DISPLAY_CACHE_TTL_MS = 60 * 1000;
const guildMemberFetchState = new Map();
const termAnnouncementUpdateTimers = new Map();
const termAnnouncementUpdateRunning = new Set();
const approvalCountdownIntervals = new Map();
const approvalAutoTimeouts = new Map();
const displayNameCache = new Map();
const quickValueCache = new Map();
const undoExpiryTimers = new Map();
const dashboardUpdateState = new Map();
const DM_FAILURE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
async function ensureGuildMembersCached(guild, force = false) {
  if (!guild) return false;
  const cached = guildMemberFetchState.get(guild.id);
  const cacheSize = guild.members?.cache?.size || 0;

  // Wichtig: Ein kompletter GuildMember-Fetch ist eine teure Gateway-Operation.
  // Wenn Discord langsam ist, darf der Bot nicht jedes Mal einen Fehler in #logs posten.
  // Wir nutzen dann den vorhandenen Cache als Fallback und versuchen es später erneut.
  if (!force && cached && (Date.now() - cached.ts) < MEMBER_FETCH_TTL_MS && cacheSize > 0) return true;
  if (cached?.promise && !force) {
    await cached.promise.catch(() => null);
    return (guild.members?.cache?.size || 0) > 0;
  }

  const fetchPromise = guild.members.fetch({ withPresences: false });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Guild member fetch timed out after ${MEMBER_FETCH_TIMEOUT_MS}ms`)), MEMBER_FETCH_TIMEOUT_MS);
  });

  const promise = Promise.race([fetchPromise, timeoutPromise])
    .then(() => {
      guildMemberFetchState.set(guild.id, { ts: Date.now(), promise: null, failedAt: null });
      return true;
    })
    .catch(error => {
      guildMemberFetchState.set(guild.id, { ts: Date.now(), promise: null, failedAt: Date.now(), lastError: error?.message || String(error) });
      console.warn('GUILD_MEMBERS_FETCH_SKIPPED_USING_CACHE', error?.message || error);
      return false;
    });

  guildMemberFetchState.set(guild.id, { ts: Date.now(), promise });
  return await promise;
}
async function ensureGuildMembersCache(guild, force = false) {
  return ensureGuildMembersCached(guild, force);
}

async function sendSystemLog(title, text, color = COLORS.info) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const lines = Array.isArray(text) ? text : String(text || '').split('\n').filter(Boolean);
  return logSystemEvent(guild, title, lines, color);
}

async function runStepSafe(guild, label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`${label}_ERROR`, error);
    try {
      if (guild) await logSystemEvent(guild, `⚠️ ${label} Fehler`, [String(error?.stack || error).slice(0, 3800)], COLORS.warning);
    } catch (_) {}
    return null;
  }
}

function scheduleTermAnnouncementRefresh(guild, term, delay = TERM_UPDATE_DEBOUNCE_MS) {
  if (!guild || !term?.id) return;
  const existing = termAnnouncementUpdateTimers.get(term.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    termAnnouncementUpdateTimers.delete(term.id);
    if (termAnnouncementUpdateRunning.has(term.id)) return;
    termAnnouncementUpdateRunning.add(term.id);
    try {
      await updateTermAnnouncementMessageImmediate(guild, term);
    } catch (error) {
      console.error('TERM_UPDATE_ERROR', error);
    } finally {
      termAnnouncementUpdateRunning.delete(term.id);
    }
  }, delay);
  termAnnouncementUpdateTimers.set(term.id, timer);
}
async function safeDeferReply(interaction, options = { flags: 64 }) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply(options);
    return true;
  } catch (error) {
    const code = error?.code || error?.rawError?.code;
    if (code === 10062) return false;
    return false;
  }
}


async function runBackgroundDiscordTask(guild, label, task) {
  setImmediate(async () => {
    try {
      await task();
    } catch (error) {
      console.error(`${label}_BACKGROUND_ERROR`, error);
      try {
        if (guild) await logSystemEvent(guild, `⚠️ ${label} Hintergrundfehler`, [String(error?.stack || error).slice(0, 3800)], COLORS.warning);
      } catch (_) {}
    }
  });
}

async function safeReplyOnce(interaction, payload = {}) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (error) {
    const code = error?.code || error?.rawError?.code || error?.status;
    const msg = String(error?.message || '');
    // 10062 = Unknown interaction, 504/Gateway Timeout = Discord hat die Antwort zwar oft verarbeitet, aber zu spät bestätigt.
    // Nicht crashen, damit der Bot weiterläuft.
    if (code === 10062 || code === 504 || msg.includes('Gateway Timeout')) return null;
    console.error('SAFE_REPLY_ONCE_FAILED', error);
    return null;
  }
}

const SANCTION_CATALOG = {
  '01': 'Nicht erscheinen bei wichtigen Events → 200.000 $ – Bloodout (Grün)',
  '02': 'Beleidigung innerhalb der Familie → 150.000 $ (Schwarz)',
  '03': 'Beleidigung außerhalb → 200.000 $ – 400.000 $ (Schwarz)',
  '04': 'Funkpflicht missachtet → 100.000 $ (Schwarz)',
  '05': 'Funk missbraucht → 50.000 $ (Schwarz)',
  '06': 'Kindisches Verhalten → 100.000 $ (Grün)',
  '07': 'Aufstellung stören → 50.000 $ (Grün)',
  '08': 'Kolonne pitten/unterbrechen → 50.000 $ (Grün)',
  '09': 'Falsch geparkt → Verwarnung / 50.000 $ (Grün)',
  '10': 'Familienmitglied töten → 500.000 $ – Bloodout (Schwarz)',
  '11': 'Familienmitglied schlagen/anschießen → 50.000 $ – 200.000 $ (Schwarz)',
  '12': 'Schießen auf Anwesen → 100.000 $ (Schwarz)',
  '13': 'Ausparkpunkt blockieren → 250.000 $ (Grün)',
  '14': 'Stress außerhalb provozieren → 500.000 $ – 1.500.000 $ / Bloodout (Schwarz)',
  '15': 'Kleiderordnung missachtet → 100.000 $ (Grün)',
  '16': 'Keine Maske beim Gambo → 100.000 $ (Schwarz)',
  '17': 'Eigentum der Familie verschenkt → 100.000 $ – 1.500.000 $ (Schwarz)',
  '18': 'Nicht abgemeldet → 50.000 $ (Grün)',
  '19': 'Sanktion nicht bezahlt → +200.000 $ + Warnung (Schwarz)',
  '20': 'Familie nicht ernst nehmen → 100.000 $ – Bloodout (Schwarz)',
  '21': 'Familie lächerlich machen → Bloodout',
  '22': 'Fehlverhalten → 50.000 $ – 250.000 $ (Grün)',
  '23': 'Befehl höherer missachtet → Bis Bloodout',
  '24': 'Interne Infos weitergeben → Bloodout',
  '25': 'Keine Waffe dabei → 50.000 $ (Grün)',
  '26': 'Sanktion nach 3 Tagen nicht gezahlt → +100.000 $ (Schwarz)',
  '27': 'Familienmitglieder zinken → 250.000 $ (Schwarz)',
  '28': 'Personen tragen ohne Zustimmung → 50.000 $ (Grün)',
  '29': 'Wochenbeitrag nach 3 Tagen offen → +100.000 $ (Schwarz)',
  '30': 'Wochenbeitrag nach 2 Wochen offen → Bloodout',
};


const DEFAULT_RULES_CONFIG = {
  abgabeAutoSanction: {
    enabled: true,
    overdueDays: 0,
    catalogNo: '29',
    penaltyType: 'Schwarzgeld',
    amount: 100000,
  },
  termNoResponseSanction: {
    enabled: false,
    catalogNo: '18',
    penaltyType: 'Grüngeld',
    amount: 50000,
  },
  sanctionEscalation: {
    enabled: true,
    dueDays: 3,
    surchargeAmount: 100000,
    bloodoutAfterSurchargeDays: 2,
  },
};

function normalizeCatalogSeverity(value, fallback = 'mittel') {
  const raw = String(value || '').trim().toLowerCase();
  if (['leicht','light','gruen','grün','1'].includes(raw)) return 'leicht';
  if (['mittel','medium','gelb','2'].includes(raw)) return 'mittel';
  if (['schwer','heavy','rot','3'].includes(raw)) return 'schwer';
  return ['leicht','mittel','schwer'].includes(String(fallback || '').toLowerCase()) ? String(fallback).toLowerCase() : 'mittel';
}
function inferCatalogSeverity(text) {
  const raw = String(text || '').toLowerCase();
  const maxMoney = parseMaxMoneyFromCatalogText(text);
  if (raw.includes('bloodout') || raw.includes('ausschluss') || raw.includes('bis bloodout') || maxMoney >= 500000) return 'schwer';
  if (maxMoney >= 100000 || raw.includes('schwarz')) return 'mittel';
  return 'leicht';
}
function setSanctionCatalogMeta(catalogNo, meta = {}, byId = 'system') {
  ensureRulesConfig();
  const no = String(catalogNo || '').padStart(2, '0');
  if (!store.config.sanctionCatalog[no]) throw new Error(`Katalognummer ${no} existiert nicht.`);
  store.config.sanctionCatalogMeta ||= {};
  store.config.sanctionCatalogMeta[no] ||= {};
  if (meta.severity != null) store.config.sanctionCatalogMeta[no].severity = normalizeCatalogSeverity(meta.severity, getCatalogSeverity(no, store.config.sanctionCatalog[no]));
  appendAuditLog?.('sanktionskatalog_meta_geaendert', byId, null, { catalogNo: no, meta: store.config.sanctionCatalogMeta[no] });
  saveAll();
  return store.config.sanctionCatalogMeta[no];
}

function ensureRulesConfig() {
  ensureConfigShape?.();
  store.config.settings ||= {};
  store.config.settings.rules ||= {};
  for (const [key, defaults] of Object.entries(DEFAULT_RULES_CONFIG)) {
    if (!store.config.settings.rules[key] || typeof store.config.settings.rules[key] !== 'object') {
      store.config.settings.rules[key] = deepClone(defaults);
    }
    for (const [field, value] of Object.entries(defaults)) {
      if (store.config.settings.rules[key][field] === undefined || store.config.settings.rules[key][field] === null) {
        store.config.settings.rules[key][field] = value;
      }
    }
  }
  store.config.sanctionCatalog ||= {};
  store.config.sanctionCatalogMeta ||= {};
  for (const [no, text] of Object.entries(SANCTION_CATALOG)) {
    const key = String(no).padStart(2, '0');
    if (!store.config.sanctionCatalog[key]) store.config.sanctionCatalog[key] = text;
    if (!store.config.sanctionCatalogMeta[key] || typeof store.config.sanctionCatalogMeta[key] !== 'object') {
      store.config.sanctionCatalogMeta[key] = { severity: inferCatalogSeverity(text) };
    }
  }
  for (const [no, text] of Object.entries(store.config.sanctionCatalog || {})) {
    const key = String(no).padStart(2, '0');
    if (!store.config.sanctionCatalogMeta[key] || typeof store.config.sanctionCatalogMeta[key] !== 'object') {
      store.config.sanctionCatalogMeta[key] = { severity: inferCatalogSeverity(text) };
    }
    store.config.sanctionCatalogMeta[key].severity = normalizeCatalogSeverity(store.config.sanctionCatalogMeta[key].severity, inferCatalogSeverity(text));
  }
}
function getSanctionCatalog() {
  ensureRulesConfig();
  return store.config.sanctionCatalog || SANCTION_CATALOG;
}
function getSanctionCatalogLabel(catalogNo) {
  const no = String(catalogNo || '').padStart(2, '0');
  return getSanctionCatalog()[no] || null;
}
function setSanctionCatalogEntry(catalogNo, text, byId = 'system', meta = {}) {
  ensureRulesConfig();
  const no = String(catalogNo || '').padStart(2, '0');
  if (!/^\d{2}$/.test(no)) throw new Error('Katalognummer muss z. B. 01 oder 29 sein.');
  const clean = String(text || '').trim();
  if (clean.length < 3) throw new Error('Katalogtext ist zu kurz.');
  store.config.sanctionCatalog[no] = clean.slice(0, 900);
  store.config.sanctionCatalogMeta ||= {};
  store.config.sanctionCatalogMeta[no] ||= {};
  store.config.sanctionCatalogMeta[no].severity = normalizeCatalogSeverity(meta.severity, inferCatalogSeverity(clean));
  appendAuditLog?.('sanktionskatalog_geaendert', byId, null, { catalogNo: no, text: clean.slice(0, 250), severity: store.config.sanctionCatalogMeta[no].severity });
  saveAll();
  return no;
}
function removeSanctionCatalogEntry(catalogNo, byId = 'system') {
  ensureRulesConfig();
  const no = String(catalogNo || '').padStart(2, '0');
  if (!store.config.sanctionCatalog[no]) return false;
  delete store.config.sanctionCatalog[no];
  if (store.config.sanctionCatalogMeta) delete store.config.sanctionCatalogMeta[no];
  appendAuditLog?.('sanktionskatalog_geloescht', byId, null, { catalogNo: no });
  saveAll();
  return true;
}
function getRuleConfig(ruleKey) {
  ensureRulesConfig();
  return store.config.settings.rules[ruleKey];
}
function setRuleConfig(ruleKey, changes = {}, byId = 'system') {
  ensureRulesConfig();
  if (!store.config.settings.rules[ruleKey]) throw new Error('Unbekannte Regel.');
  const cfg = store.config.settings.rules[ruleKey];
  if (changes.enabled != null) cfg.enabled = !!changes.enabled;
  if (changes.overdueDays != null) cfg.overdueDays = Math.max(0, Math.min(30, Number(changes.overdueDays) || 0));
  if (changes.dueDays != null) cfg.dueDays = Math.max(0, Math.min(30, Number(changes.dueDays) || 0));
  if (changes.bloodoutAfterSurchargeDays != null) cfg.bloodoutAfterSurchargeDays = Math.max(0, Math.min(30, Number(changes.bloodoutAfterSurchargeDays) || 0));
  if (changes.surchargeAmount != null) cfg.surchargeAmount = Math.max(0, Math.round(Number(changes.surchargeAmount) || 0));
  if (changes.amount != null) cfg.amount = Math.max(0, Math.round(Number(changes.amount) || 0));
  if (changes.catalogNo != null) {
    const no = String(changes.catalogNo || '').padStart(2, '0');
    if (!getSanctionCatalogLabel(no)) throw new Error(`Katalognummer ${no} existiert nicht.`);
    cfg.catalogNo = no;
  }
  if (changes.penaltyType != null) {
    const allowed = ['Grüngeld','Schwarzgeld','Eisen','Schwefel','Meth','Bloodout'];
    if (!allowed.includes(changes.penaltyType)) throw new Error('Ungültige Strafart.');
    cfg.penaltyType = changes.penaltyType;
  }
  appendAuditLog?.('regel_config_geaendert', byId, null, { ruleKey, changes });
  saveAll();
  return cfg;
}
function buildRulesOverviewEmbed() {
  ensureRulesConfig();
  const rules = store.config.settings.rules;
  const catalogCount = Object.keys(getSanctionCatalog()).length;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Regel- & Katalog-Konfiguration')
    .setDescription('Diese Werte sind absichtlich konfigurierbar, damit spätere RP-Regeländerungen ohne Codeänderung möglich sind.')
    .addFields(
      buildInfoField('📦 Überfällige Abgaben', [
        `Status: **${rules.abgabeAutoSanction.enabled ? 'AN' : 'AUS'}**`,
        `Nach Frist + Tage: **${rules.abgabeAutoSanction.overdueDays}**`,
        `Sanktion: **${rules.abgabeAutoSanction.catalogNo} – ${getSanctionCatalogLabel(rules.abgabeAutoSanction.catalogNo) || '—'}**`,
        `Strafe: **${formatCurrency(rules.abgabeAutoSanction.amount)} ${rules.abgabeAutoSanction.penaltyType}**`,
      ], false),
      buildInfoField('📋 Termin nicht eingehalten / keine Antwort', [
        `Status: **${rules.termNoResponseSanction.enabled ? 'AN' : 'AUS'}**`,
        `Sanktion: **${rules.termNoResponseSanction.catalogNo} – ${getSanctionCatalogLabel(rules.termNoResponseSanction.catalogNo) || '—'}**`,
        `Strafe: **${formatCurrency(rules.termNoResponseSanction.amount)} ${rules.termNoResponseSanction.penaltyType}**`,
      ], false),
      buildInfoField('⏳ Sanktions-Eskalation', [
        `Status: **${rules.sanctionEscalation.enabled ? 'AN' : 'AUS'}**`,
        `Zahlungsfrist: **${rules.sanctionEscalation.dueDays} Tage**`,
        `Zuschlag: **${formatCurrency(rules.sanctionEscalation.surchargeAmount)}**`,
        `Bloodout nach Zuschlag: **${rules.sanctionEscalation.bloodoutAfterSurchargeDays} Tage**`,
      ], false),
      buildInfoField('📚 Sanktionskatalog', [`Einträge: **${catalogCount}**`, 'Texte, Nummern und Schweregruppen sind über die Buttons unten frei bearbeitbar.'], false),
    )
    .setFooter({ text: 'Regeln • Änderungen werden im Audit-Log gespeichert' });
}


function parseMaxMoneyFromCatalogText(text) {
  const nums = [...String(text || '').matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)\s*\$/g)]
    .map(m => Number(String(m[1]).replace(/\./g, '')))
    .filter(n => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : 0;
}
function getCatalogSeverity(no, text) {
  ensureRulesConfig();
  const key = String(no || '').padStart(2, '0');
  const saved = store.config.sanctionCatalogMeta?.[key]?.severity;
  return normalizeCatalogSeverity(saved, inferCatalogSeverity(text));
}
function formatCatalogLine(no, text) {
  return `**${String(no).padStart(2, '0')}** • ${String(text || '—')}`;
}
function getSanctionCatalogGroups() {
  const catalog = getSanctionCatalog();
  const groups = { leicht: [], mittel: [], schwer: [] };
  for (const [no, text] of Object.entries(catalog).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    groups[getCatalogSeverity(no, text)].push(formatCatalogLine(no, text));
  }
  return { catalog, groups };
}
function chunkCatalogLines(lines, maxLen = 950) {
  if (!Array.isArray(lines) || !lines.length) return ['—'];
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8);
}
function buildSanctionCatalogManageEmbed() {
  const { catalog, groups } = getSanctionCatalogGroups();
  const make = arr => chunkCatalogLines(arr, 1000)[0] || '—';
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🛠️ Sanktionskatalog bearbeiten')
    .setDescription('Interne Leader-Ansicht. Hier können Katalogeinträge hinzugefügt, überarbeitet oder gelöscht werden. Die öffentliche Leseansicht hat keine Buttons.')
    .addFields(
      buildInfoField('🟢 Leichte Verstöße', [make(groups.leicht)], false),
      buildInfoField('🟡 Mittlere Verstöße', [make(groups.mittel)], false),
      buildInfoField('🔴 Schwere Verstöße', [make(groups.schwer)], false),
    )
    .setFooter({ text: `Interner Katalog-Editor • ${Object.keys(catalog).length} Einträge` });
}
function buildSanctionCatalogPublicEmbeds() {
  const { catalog, groups } = getSanctionCatalogGroups();
  const embeds = [
    new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle('📚 Sanktionskatalog')
      .setDescription([
        'Hier findest du die aktuellen Sanktionen der Familie.',
        'Die Einträge sind nach Schwere sortiert: 🟢 leicht, 🟡 mittel, 🔴 schwer.',
        '',
        `Aktuelle Einträge: **${Object.keys(catalog).length}**`,
      ].join('\n'))
      .setFooter({ text: 'Sanktionskatalog • Nur Leseansicht' })
  ];
  const defs = [
    ['🟢 Leichte Verstöße', groups.leicht, COLORS.success],
    ['🟡 Mittlere Verstöße', groups.mittel, COLORS.warning],
    ['🔴 Schwere Verstöße', groups.schwer, COLORS.danger],
  ];
  for (const [title, lines, color] of defs) {
    const chunks = chunkCatalogLines(lines, 3800);
    for (let i = 0; i < chunks.length; i += 1) {
      embeds.push(new EmbedBuilder()
        .setColor(color)
        .setTitle(i === 0 ? title : `${title} (${i + 1})`)
        .setDescription(chunks[i] || '—'));
    }
  }
  return embeds.slice(0, 10);
}
function buildSanctionCatalogDashboardEmbed() {
  // Rückwärtskompatibel: alte Aufrufe zeigen jetzt die interne Bearbeitungsansicht.
  return buildSanctionCatalogManageEmbed();
}
function buildSanctionCatalogDashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rules_catalog_public').setLabel('👁️ Öffentliche Ansicht').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('rules_catalog_set').setLabel('📚 Eintrag hinzufügen/bearbeiten').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('rules_catalog_delete').setLabel('🗑️ Eintrag löschen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('systempanel_rules').setLabel('⬅️ Zurück Regeln').setStyle(ButtonStyle.Secondary),
    )
  ];
}
function buildRulesManagementComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rules_edit_abgabe').setLabel('📦 Überfällige Abgaben').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('rules_edit_term').setLabel('📋 Termin-Regel').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('rules_edit_escalation').setLabel('⏳ Eskalation').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rules_catalog_dashboard').setLabel('📊 Katalog-Dashboard').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('rules_catalog_set').setLabel('📚 Katalog eintragen').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('rules_catalog_delete').setLabel('🗑️ Katalog löschen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
function buildRuleAbgabeModal() {
  const cfg = getRuleConfig('abgabeAutoSanction');
  return new ModalBuilder()
    .setCustomId('rules_modal_abgabe')
    .setTitle('Überfällige Abgaben')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Status: an oder aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('overdueDays').setLabel('Nachfrist Tage nach Frist').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.overdueDays ?? 0))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('catalogNo').setLabel('Katalognummer z. B. 29').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.catalogNo || '29'))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Sanktionsbetrag').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.amount || 0))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('penaltyType').setLabel('Strafart z. B. Schwarzgeld').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.penaltyType || 'Schwarzgeld'))),
    );
}
function buildRuleTermModal() {
  const cfg = getRuleConfig('termNoResponseSanction');
  return new ModalBuilder()
    .setCustomId('rules_modal_term')
    .setTitle('Termin-Regel')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Status: an oder aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('catalogNo').setLabel('Katalognummer z. B. 18').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.catalogNo || '18'))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Sanktionsbetrag').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.amount || 0))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('penaltyType').setLabel('Strafart z. B. Grüngeld').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.penaltyType || 'Grüngeld'))),
    );
}
function buildRuleEscalationModal() {
  const cfg = getRuleConfig('sanctionEscalation');
  return new ModalBuilder()
    .setCustomId('rules_modal_escalation')
    .setTitle('Sanktions-Eskalation')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Status: an oder aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dueDays').setLabel('Zahlungsfrist Tage').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.dueDays ?? 3))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('surchargeAmount').setLabel('Zuschlag Betrag').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.surchargeAmount || 0))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bloodoutDays').setLabel('Bloodout nach Zuschlag Tage').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.bloodoutAfterSurchargeDays ?? 2))),
    );
}
function buildCatalogSetModal() {
  return new ModalBuilder()
    .setCustomId('rules_modal_catalog_set')
    .setTitle('Katalogeintrag setzen')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('number').setLabel('Nummer z. B. 29').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('severity').setLabel('Schwere: leicht, mittel oder schwer').setStyle(TextInputStyle.Short).setRequired(true).setValue('mittel')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Text').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(900)),
    );
}
function buildCatalogDeleteModal() {
  return new ModalBuilder()
    .setCustomId('rules_modal_catalog_delete')
    .setTitle('Katalogeintrag löschen')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('number').setLabel('Nummer z. B. 29').setStyle(TextInputStyle.Short).setRequired(true)),
    );
}


// =========================================================
// ZENTRALES SYSTEMPANEL / REMINDER & SMART-PING CONFIG
// =========================================================
const DEFAULT_SYSTEM_CONTROL_CONFIG = {
  reminders: {
    enabled: true,
    dmEnabled: true,
    abgabeEnabled: true,
    sanctionEnabled: true,
    termEnabled: true,
    wacheEnabled: true,
    abgabeStages: {
      thu: { enabled: true, day: 4, hour: 16, minute: 0 },
      fri: { enabled: true, day: 5, hour: 16, minute: 0 },
      sun: { enabled: true, day: 7, hour: 16, minute: 0 },
    },
    termMinutesBefore: [1440, 60, 30],
    overdueRepeatHours: 24,
  },
  smartPing: {
    enabled: true,
    minRisk: 35,
    reliableSkipScore: 90,
    sundayOnlyScore: 75,
    mediumScore: 55,
    openAbgabenThreshold: 1,
    sanctionThreshold: 1,
    termNoResponseThreshold: 1,
    // Frei einstellbares Punktesystem für Zuverlässigkeit/Risiko
    labelVeryReliable: 90,
    labelReliable: 75,
    labelMedium: 55,
    labelUnreliable: 35,
    openAbgabenPenaltyStart: 1,
    openAbgabenPenaltyPoints: 10,
    termNoResponsePenaltyPoints: 6,
    sanctionPenaltyLight: 5,
    sanctionPenaltyMedium: 12,
    sanctionPenaltyHeavy: 22,
    wachePenaltyStart: 1,
    wachePenaltyPoints: 15,
    wacheRepeatPenaltyPoints: 8,
    wachePenaltyHeavyAfter: 3,
    maxNegativePenalty: 65,
    activeDays: [1, 2, 3, 4, 5, 6, 7],
  },
  automations: {
    enabled: true,
    abgabeAutoSanctions: true,
    termNoResponseSanctions: true,
    sanctionEscalation: true,
    absenceCleanup: true,
    termReminders: true,
    abgabeReminders: true,
    sanctionReminders: true,
    wacheReports: true,
    weeklyReports: true,
    monthlyReports: true,
    cashboxMonthlyReports: true,
    warehouseMonthlyReports: true,
    warehouseMinimumWarnings: true,
    recovery: true,
    uiSync: true,
    dataIntegrity: true,
  },
};
function parseOnOffValue(value, fallback = true) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['an','on','ja','true','1','aktiv'].includes(raw)) return true;
  if (['aus','off','nein','false','0','inaktiv','deaktiviert'].includes(raw)) return false;
  return fallback;
}
function parseCsvNumbers(value, fallback = []) {
  const nums = String(value ?? '').split(/[;,\s]+/).map(x => Number(String(x).replace(/[^0-9-]/g, ''))).filter(n => Number.isFinite(n));
  return nums.length ? nums : fallback;
}
function parseDayList(value, fallback = [1,2,3,4,5,6,7]) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'alle' || raw === 'all') return [1,2,3,4,5,6,7];
  const map = { mo:1, montag:1, monday:1, di:2, dienstag:2, tuesday:2, mi:3, mittwoch:3, wednesday:3, do:4, donnerstag:4, thursday:4, fr:5, freitag:5, friday:5, sa:6, samstag:6, saturday:6, so:7, sonntag:7, sunday:7 };
  const days = [];
  for (const part of raw.split(/[;,\s]+/).filter(Boolean)) {
    const n = Number(part);
    const day = Number.isInteger(n) && n >= 1 && n <= 7 ? n : map[part];
    if (day && !days.includes(day)) days.push(day);
  }
  return days.length ? days : fallback;
}
function ensureSystemControlConfig() {
  store.config.settings ||= {};
  store.config.settings.systemControl ||= deepClone(DEFAULT_SYSTEM_CONTROL_CONFIG);
  const cfg = store.config.settings.systemControl;
  cfg.reminders ||= deepClone(DEFAULT_SYSTEM_CONTROL_CONFIG.reminders);
  cfg.smartPing ||= deepClone(DEFAULT_SYSTEM_CONTROL_CONFIG.smartPing);
  cfg.automations ||= deepClone(DEFAULT_SYSTEM_CONTROL_CONFIG.automations);
  for (const [k, v] of Object.entries(DEFAULT_SYSTEM_CONTROL_CONFIG.reminders)) {
    if (cfg.reminders[k] === undefined || cfg.reminders[k] === null) cfg.reminders[k] = deepClone(v);
  }
  cfg.reminders.abgabeStages ||= deepClone(DEFAULT_SYSTEM_CONTROL_CONFIG.reminders.abgabeStages);
  for (const [stage, defaults] of Object.entries(DEFAULT_SYSTEM_CONTROL_CONFIG.reminders.abgabeStages)) {
    cfg.reminders.abgabeStages[stage] ||= deepClone(defaults);
    for (const [k, v] of Object.entries(defaults)) if (cfg.reminders.abgabeStages[stage][k] === undefined || cfg.reminders.abgabeStages[stage][k] === null) cfg.reminders.abgabeStages[stage][k] = v;
  }
  if (!Array.isArray(cfg.reminders.termMinutesBefore) || !cfg.reminders.termMinutesBefore.length) cfg.reminders.termMinutesBefore = [...DEFAULT_SYSTEM_CONTROL_CONFIG.reminders.termMinutesBefore];
  for (const [k, v] of Object.entries(DEFAULT_SYSTEM_CONTROL_CONFIG.smartPing)) {
    if (cfg.smartPing[k] === undefined || cfg.smartPing[k] === null) cfg.smartPing[k] = deepClone(v);
  }
  if (!Array.isArray(cfg.smartPing.activeDays) || !cfg.smartPing.activeDays.length) cfg.smartPing.activeDays = [1,2,3,4,5,6,7];
  for (const [k, v] of Object.entries(DEFAULT_SYSTEM_CONTROL_CONFIG.automations)) {
    if (cfg.automations[k] === undefined || cfg.automations[k] === null) cfg.automations[k] = deepClone(v);
  }
  // Backwards compatibility mit alten Schaltern
  store.config.settings.smartPingEnabled = !!cfg.smartPing.enabled;
  store.config.settings.termRemindersEnabled = !!cfg.reminders.termEnabled && !!cfg.automations.termReminders;
  store.config.settings.autoSanctionsEnabled = !!cfg.automations.enabled && (!!cfg.automations.abgabeAutoSanctions || !!cfg.automations.termNoResponseSanctions);
  return cfg;
}
function getSystemControlConfig() {
  return ensureSystemControlConfig();
}
function setSystemReminderConfig(changes = {}, byId = 'system') {
  const cfg = ensureSystemControlConfig();
  Object.assign(cfg.reminders, changes);
  store.config.settings.termRemindersEnabled = !!cfg.reminders.termEnabled;
  appendAuditLog?.('system_reminder_config_geaendert', byId, null, changes);
  saveAll();
  return cfg.reminders;
}
function setSystemSmartPingConfig(changes = {}, byId = 'system') {
  const cfg = ensureSystemControlConfig();
  Object.assign(cfg.smartPing, changes);
  store.config.settings.smartPingEnabled = !!cfg.smartPing.enabled;
  appendAuditLog?.('system_smartping_config_geaendert', byId, null, changes);
  saveAll();
  return cfg.smartPing;
}

function setSystemAutomationConfig(changes = {}, byId = 'system') {
  const cfg = ensureSystemControlConfig();
  Object.assign(cfg.automations, changes);
  store.config.settings.termRemindersEnabled = !!cfg.reminders.termEnabled && !!cfg.automations.termReminders;
  store.config.settings.autoSanctionsEnabled = !!cfg.automations.enabled && (!!cfg.automations.abgabeAutoSanctions || !!cfg.automations.termNoResponseSanctions);
  appendAuditLog?.('system_automation_config_geaendert', byId, null, changes);
  saveAll();
  return cfg.automations;
}
function isAutomationEnabled(key) {
  const cfg = getSystemControlConfig().automations;
  if (!cfg.enabled) return false;
  return cfg[key] !== false;
}
function formatOnOff(value) {
  return value ? 'AN' : 'AUS';
}
function parseAutomationFlags(raw, current = {}) {
  const result = { ...current };
  for (const part of String(raw || '').split(/[;,]+/).map(x => x.trim()).filter(Boolean)) {
    const [kRaw, vRaw] = part.split('=').map(x => String(x || '').trim());
    if (!kRaw) continue;
    const keyMap = {
      abgaben: 'abgabeAutoSanctions', abgabe: 'abgabeAutoSanctions',
      termine: 'termNoResponseSanctions', term: 'termNoResponseSanctions',
      eskalation: 'sanctionEscalation', sanktionen: 'sanctionEscalation',
      reminders: 'abgabeReminders', abgabereminder: 'abgabeReminders',
      terminreminder: 'termReminders', sanktionsreminder: 'sanctionReminders',
      wache: 'wacheReports', wochenbericht: 'weeklyReports', monatsbericht: 'monthlyReports',
      kassenbericht: 'cashboxMonthlyReports', lagerbericht: 'warehouseMonthlyReports', lagerwarnung: 'warehouseMinimumWarnings',
      recovery: 'recovery', uisync: 'uiSync', integrity: 'dataIntegrity'
    };
    const key = result[kRaw] !== undefined ? kRaw : keyMap[kRaw.toLowerCase()];
    if (key && result[key] !== undefined) result[key] = parseOnOffValue(vRaw, result[key]);
  }
  return result;
}
function getSystemDmSettings() {
  const cfg = getDmSettings();
  cfg.areas ||= {};
  for (const area of ['general','abgaben','sanktionen','wache','termine','leader']) {
    if (typeof cfg.areas[area] !== 'boolean') cfg.areas[area] = true;
  }
  return cfg;
}
function setSystemDmSettings(changes = {}, byId = 'system') {
  const cfg = getSystemDmSettings();
  if (changes.enabled != null) cfg.enabled = !!changes.enabled;
  if (changes.dailyDedupEnabled != null) cfg.dailyDedupEnabled = !!changes.dailyDedupEnabled;
  if (changes.buttonsEnabled != null) cfg.buttonsEnabled = !!changes.buttonsEnabled;
  if (changes.areas) {
    cfg.areas ||= {};
    for (const [area, value] of Object.entries(changes.areas)) cfg.areas[area] = !!value;
  }
  appendAuditLog?.('system_dm_config_geaendert', byId, null, changes);
  saveAll();
  return cfg;
}
function dayLabelList(days) {
  const labels = {1:'Mo',2:'Di',3:'Mi',4:'Do',5:'Fr',6:'Sa',7:'So'};
  return (days || []).map(d => labels[d] || d).join(', ') || '—';
}
function getReliabilityPointConfig() {
  const cfg = getSystemControlConfig().smartPing || {};
  return {
    veryReliable: Math.max(0, Math.min(100, Number(cfg.labelVeryReliable ?? cfg.reliableSkipScore ?? 90))),
    reliable: Math.max(0, Math.min(100, Number(cfg.labelReliable ?? cfg.sundayOnlyScore ?? 75))),
    medium: Math.max(0, Math.min(100, Number(cfg.labelMedium ?? cfg.mediumScore ?? 55))),
    unreliable: Math.max(0, Math.min(100, Number(cfg.labelUnreliable ?? 35))),
    openStart: Math.max(0, Number(cfg.openAbgabenPenaltyStart ?? 1)),
    openPenalty: Math.max(0, Number(cfg.openAbgabenPenaltyPoints ?? 10)),
    termNoResponsePenalty: Math.max(0, Number(cfg.termNoResponsePenaltyPoints ?? 6)),
    sanctionLight: Math.max(0, Number(cfg.sanctionPenaltyLight ?? 5)),
    sanctionMedium: Math.max(0, Number(cfg.sanctionPenaltyMedium ?? 12)),
    sanctionHeavy: Math.max(0, Number(cfg.sanctionPenaltyHeavy ?? 22)),
    wacheStart: Math.max(0, Number(cfg.wachePenaltyStart ?? 1)),
    wachePenalty: Math.max(0, Number(cfg.wachePenaltyPoints ?? 15)),
    wacheRepeatPenalty: Math.max(0, Number(cfg.wacheRepeatPenaltyPoints ?? 8)),
    wacheHeavyAfter: Math.max(1, Number(cfg.wachePenaltyHeavyAfter ?? 3)),
    maxPenalty: Math.max(0, Math.min(100, Number(cfg.maxNegativePenalty ?? 65))),
  };
}
function getCatalogSeverityForSanction(sanction) {
  const no = String(sanction?.catalogNo || '').padStart(2, '0');
  const label = sanction?.catalogLabel || getSanctionCatalogLabel(no) || '';
  return getCatalogSeverity(no, label);
}
function getOpenAbgabePointPenalty(openCount) {
  const pc = getReliabilityPointConfig();
  const open = Math.max(0, Number(openCount || 0));
  if (pc.openStart <= 0) return 0;
  if (open < pc.openStart) return 0;
  return Math.round((open - pc.openStart + 1) * pc.openPenalty);
}
function buildSystemPanelEmbed() {
  ensureSystemControlConfig();
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⚙️ Systemsteuerung')
    .setDescription('Zentrale Stelle für Bot-Regeln, Reminder, Smart-Ping, Kasse, Lager und Sicherheit. Änderungen werden gespeichert und können später ohne Codeänderung angepasst werden.')
    .addFields(
      buildInfoField('⚖️ Sanktionen & Regeln', ['Katalog, Auto-Sanktionen, Eskalation, Termin-Regeln'], true),
      buildInfoField('🔔 Reminder & Smart Ping', ['DMs, Reminder-Zeiten, Schwellenwerte, aktive Tage'], true),
      buildInfoField('💰 Kasse & Lager', ['Kassen-Dashboard, Lager, Mindestbestand, Historie'], true),
      buildInfoField('🛡️ Sicherheit', ['Berechtigungen, Dry-Run, Whitelist/Blacklist'], true),
    )
    .setFooter({ text: 'Nur Leader/Admins mit Config-Recht sollten dieses Panel bedienen.' });
}
function buildSystemPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('systempanel_rules').setLabel('⚖️ Sanktionen/Regeln').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('systempanel_reminders').setLabel('🔔 Reminder').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('systempanel_smartping').setLabel('🧠 Smart Ping').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('systempanel_dms').setLabel('📬 DMs').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('systempanel_automations').setLabel('🤖 Automationen').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('systempanel_cashbox').setLabel('💰 Kasse').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('systempanel_warehouse').setLabel('📦 Lager').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('systempanel_security').setLabel('🛡️ Sicherheit').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verwaltung_back').setLabel('⬅️ Zurück zur Verwaltung').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
function buildReminderSettingsEmbed() {
  const cfg = getSystemControlConfig().reminders;
  const stages = cfg.abgabeStages || {};
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🔔 Reminder-Einstellungen')
    .setDescription('Hier stellst du ein, ob Reminder aktiv sind und wann sie auftreten.')
    .addFields(
      buildInfoField('Status', [
        `Reminder gesamt: **${cfg.enabled ? 'AN' : 'AUS'}**`,
        `DMs: **${cfg.dmEnabled ? 'AN' : 'AUS'}**`,
        `Abgaben: **${cfg.abgabeEnabled ? 'AN' : 'AUS'}**`,
        `Sanktionen: **${cfg.sanctionEnabled ? 'AN' : 'AUS'}**`,
        `Termine: **${cfg.termEnabled ? 'AN' : 'AUS'}**`,
        `Wache: **${cfg.wacheEnabled ? 'AN' : 'AUS'}**`,
      ], false),
      buildInfoField('Abgabe-Reminder', Object.entries(stages).map(([key, s]) => `${key}: **${s.enabled ? 'AN' : 'AUS'}** • Tag ${s.day} um ${String(s.hour).padStart(2,'0')}:${String(s.minute || 0).padStart(2,'0')}`), false),
      buildInfoField('Termin-Reminder', [`Minuten vor Termin: **${(cfg.termMinutesBefore || []).join(', ')}**`], false),
      buildInfoField('Überfällig', [`Wiederholung alle **${cfg.overdueRepeatHours || 24}h**`], false),
    );
}
function buildReminderSettingsComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('systempanel_reminder_toggle').setLabel('AN/AUS umschalten').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('systempanel_reminder_edit').setLabel('⏰ Zeiten bearbeiten').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
  )];
}
function buildSmartPingSettingsEmbed() {
  const cfg = getSystemControlConfig().smartPing;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🧠 Smart-Ping Einstellungen')
    .setDescription('Smart Ping entscheidet, wer wirklich erinnert/gepingt werden soll. Gute Member werden weniger genervt, auffällige Member stärker priorisiert.')
    .addFields(
      buildInfoField('Status', [`Smart Ping: **${cfg.enabled ? 'AN' : 'AUS'}**`, `Aktive Tage: **${dayLabelList(cfg.activeDays)}**`], false),
      buildInfoField('Zuverlässigkeits-Stufen', [
        `Sehr zuverlässig ab: **${cfg.labelVeryReliable ?? cfg.reliableSkipScore ?? 90}**`,
        `Zuverlässig ab: **${cfg.labelReliable ?? cfg.sundayOnlyScore ?? 75}**`,
        `Mittel ab: **${cfg.labelMedium ?? cfg.mediumScore ?? 55}**`,
        `Nicht zuverlässig unter: **${cfg.labelUnreliable ?? 35}**`,
      ], false),
      buildInfoField('Punkte-Abzug', [
        `Offene Abgaben: ab **${cfg.openAbgabenPenaltyStart ?? 1}** offen je **-${cfg.openAbgabenPenaltyPoints ?? 10}** Punkte`,
        `Termin ohne Antwort: **-${cfg.termNoResponsePenaltyPoints ?? 6}** Punkte`,
        `Sanktion leicht/mittel/schwer: **-${cfg.sanctionPenaltyLight ?? 5} / -${cfg.sanctionPenaltyMedium ?? 12} / -${cfg.sanctionPenaltyHeavy ?? 22}** Punkte`,
        `Wache nicht erfüllt: ab **${cfg.wachePenaltyStart ?? 1}** Woche(n) je **-${cfg.wachePenaltyPoints ?? 15}** Punkte + Wiederholung **-${cfg.wacheRepeatPenaltyPoints ?? 8}**, schwer ab **${cfg.wachePenaltyHeavyAfter ?? 3}**`,
        `Max. negativer Abzug: **${cfg.maxNegativePenalty ?? 65}** Punkte`,
      ], false),
      buildInfoField('Ping/Reminder wenn auffällig', [
        `Mindest-Risiko: **${cfg.minRisk}**`,
        `Offene Abgaben ab: **${cfg.openAbgabenThreshold}**`,
        `Sanktionen ab: **${cfg.sanctionThreshold}**`,
        `Termin-No-Responses ab: **${cfg.termNoResponseThreshold}**`,
      ], false),
    );
}
function buildSmartPingSettingsComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('systempanel_smartping_toggle').setLabel('AN/AUS umschalten').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('systempanel_smartping_edit').setLabel('🧠 Werte bearbeiten').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
  )];
}

function buildDmSystemSettingsEmbed() {
  const cfg = getSystemDmSettings();
  const areas = cfg.areas || {};
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📬 DM-Einstellungen')
    .setDescription('Hier steuerst du, ob der Bot private Nachrichten senden darf, für welche Bereiche und ob tägliche Duplikate verhindert werden.')
    .addFields(
      buildInfoField('Status', [
        `DMs gesamt: **${formatOnOff(cfg.enabled !== false)}**`,
        `Tägliche Duplikat-Sperre: **${formatOnOff(cfg.dailyDedupEnabled !== false)}**`,
        `DM-Buttons: **${formatOnOff(cfg.buttonsEnabled !== false)}**`,
      ], false),
      buildInfoField('Bereiche', Object.entries(areas).map(([k,v]) => `${k}: **${formatOnOff(v !== false)}**`), false),
    );
}
function buildDmSystemSettingsComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('systempanel_dms_toggle').setLabel('DMs AN/AUS').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('systempanel_dms_edit').setLabel('📬 Bereiche bearbeiten').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
  )];
}
function buildDmSystemConfigModal() {
  const cfg = getSystemDmSettings();
  const areas = cfg.areas || {};
  return new ModalBuilder()
    .setCustomId('systempanel_dms_modal')
    .setTitle('DMs bearbeiten')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('DMs gesamt: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled !== false ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('areas').setLabel('Bereiche z.B. abgaben=an,sanktionen=aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(Object.entries(areas).map(([k,v]) => `${k}=${v !== false ? 'an' : 'aus'}`).join(','))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dedup').setLabel('Tägliche Duplikat-Sperre: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.dailyDedupEnabled !== false ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('buttons').setLabel('DM-Buttons: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.buttonsEnabled !== false ? 'an' : 'aus')),
    );
}
function parseDmAreas(raw, current = {}) {
  const areas = { ...current };
  for (const part of String(raw || '').split(/[;,]+/).map(x => x.trim()).filter(Boolean)) {
    const [areaRaw, valueRaw] = part.split('=').map(x => String(x || '').trim());
    const area = areaRaw.toLowerCase();
    if (!['general','abgaben','sanktionen','wache','termine','leader'].includes(area)) continue;
    areas[area] = parseOnOffValue(valueRaw, areas[area] !== false);
  }
  return areas;
}
function buildAutomationSettingsEmbed() {
  const cfg = getSystemControlConfig().automations;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 Automationen')
    .setDescription('Diese Schalter bestimmen, welche Hintergrundlogiken wirklich laufen. Damit kannst du Systeme später ohne Codeänderung abschalten.')
    .addFields(
      buildInfoField('Hauptschalter', [`Automationen gesamt: **${formatOnOff(cfg.enabled)}**`], false),
      buildInfoField('Sanktionen & Regeln', [
        `Abgabe-Auto-Sanktionen: **${formatOnOff(cfg.abgabeAutoSanctions)}**`,
        `Termin-No-Response-Sanktionen: **${formatOnOff(cfg.termNoResponseSanctions)}**`,
        `Sanktions-Eskalation: **${formatOnOff(cfg.sanctionEscalation)}**`,
      ], false),
      buildInfoField('Reminder & Berichte', [
        `Abgabe-Reminder: **${formatOnOff(cfg.abgabeReminders)}**`,
        `Termin-Reminder: **${formatOnOff(cfg.termReminders)}**`,
        `Sanktions-Reminder: **${formatOnOff(cfg.sanctionReminders)}**`,
        `Wochenberichte: **${formatOnOff(cfg.weeklyReports)}**`,
        `Monatsberichte: **${formatOnOff(cfg.monthlyReports)}**`,
        `Kassen-Monatsbericht: **${formatOnOff(cfg.cashboxMonthlyReports)}**`,
        `Lager-Monatsbericht: **${formatOnOff(cfg.warehouseMonthlyReports)}**`,
      ], false),
      buildInfoField('Wartung & Lager', [
        `Wache-Berichte: **${formatOnOff(cfg.wacheReports)}**`,
        `Lager-Mindestbestand-Warnungen: **${formatOnOff(cfg.warehouseMinimumWarnings)}**`,
        `Recovery: **${formatOnOff(cfg.recovery)}**`,
        `UI-Sync: **${formatOnOff(cfg.uiSync)}**`,
        `Datenprüfung: **${formatOnOff(cfg.dataIntegrity)}**`,
      ], false),
    );
}
function buildAutomationSettingsComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('systempanel_automations_toggle').setLabel('Alle AN/AUS').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('systempanel_automations_edit').setLabel('🤖 Werte bearbeiten').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
  )];
}
function buildAutomationConfigModal() {
  const cfg = getSystemControlConfig().automations;
  return new ModalBuilder()
    .setCustomId('systempanel_automations_modal')
    .setTitle('Automationen bearbeiten')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Automationen gesamt: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sanctions').setLabel('abgaben=an,termine=an,eskalation=an').setStyle(TextInputStyle.Short).setRequired(true).setValue(`abgaben=${cfg.abgabeAutoSanctions?'an':'aus'},termine=${cfg.termNoResponseSanctions?'an':'aus'},eskalation=${cfg.sanctionEscalation?'an':'aus'}`)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reminders').setLabel('Reminder: abgabe,termin,sanktion').setStyle(TextInputStyle.Short).setRequired(true).setValue(`abgabereminder=${cfg.abgabeReminders?'an':'aus'},terminreminder=${cfg.termReminders?'an':'aus'},sanktionsreminder=${cfg.sanctionReminders?'an':'aus'}`)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reports').setLabel('Berichte: woche,monat,kasse,lager').setStyle(TextInputStyle.Short).setRequired(true).setValue(`wochenbericht=${cfg.weeklyReports?'an':'aus'},monatsbericht=${cfg.monthlyReports?'an':'aus'},kassenbericht=${cfg.cashboxMonthlyReports?'an':'aus'},lagerbericht=${cfg.warehouseMonthlyReports?'an':'aus'}`)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('misc').setLabel('Sonstiges: wache,lager,recovery').setStyle(TextInputStyle.Short).setRequired(true).setValue(`wache=${cfg.wacheReports?'an':'aus'},lagerwarnung=${cfg.warehouseMinimumWarnings?'an':'aus'},recovery=${cfg.recovery?'an':'aus'},uisync=${cfg.uiSync?'an':'aus'},integrity=${cfg.dataIntegrity?'an':'aus'}`)),
    );
}
function buildCashboxSystemSettingsEmbed() {
  ensureCashboxShape();
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('💰 Kassen-Einstellungen')
    .setDescription('Schnellzugriff auf Kasse und Monatsberichte.')
    .addFields(
      buildInfoField('Kasse', [`Aktueller Stand: **${formatCurrency(store.cashbox.balance)}**`, `Minus erlaubt: **${formatOnOff(store.cashbox.settings.allowNegativeBalance)}**`], false),
      buildInfoField('Berichte', [`Kassen-Monatsbericht: **${formatOnOff(isAutomationEnabled('cashboxMonthlyReports'))}**`, `Lager-Monatsbericht: **${formatOnOff(isAutomationEnabled('warehouseMonthlyReports'))}**`, `Berichtskanal: ${store.config.channels?.kassenberichte ? `<#${store.config.channels.kassenberichte}>` : 'nicht gesetzt'}`], false),
    );
}
function buildCashboxSystemSettingsComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cashbox_negative_toggle').setLabel('Minus AN/AUS').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('systempanel_cashbox_report_toggle').setLabel('Monatsbericht AN/AUS').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
  )];
}
function buildWarehouseSystemSettingsEmbed() {
  const f = ensureFamilyWarehouseShape();
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📦 Lager-Einstellungen')
    .setDescription(formatFamilyWarehouseLines().join('\n'))
    .addFields(buildInfoField('Warnungen', [`Mindestbestand-Warnungen: **${formatOnOff(f.minimumWarningsEnabled && isAutomationEnabled('warehouseMinimumWarnings'))}**`, `Warnkanal: ${f.minimumWarningChannelId ? `<#${f.minimumWarningChannelId}>` : 'nicht gesetzt'}`], false));
}
function buildWarehouseSystemSettingsComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('warehouse_minimum_toggle').setLabel('Warnungen AN/AUS').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('warehouse_minimum_pick').setLabel('Mindestbestand setzen').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('warehouse_history_pick').setLabel('📜 Item-Historie').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('systempanel_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary)),
  ];
}
function buildReminderConfigModal() {
  const cfg = getSystemControlConfig().reminders;
  const stages = cfg.abgabeStages || {};
  return new ModalBuilder()
    .setCustomId('systempanel_reminder_modal')
    .setTitle('Reminder bearbeiten')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Reminder gesamt: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dm').setLabel('DM-Reminder: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.dmEnabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('abgabe').setLabel('Abgaben: thu=4:16,fri=5:16,sun=7:16').setStyle(TextInputStyle.Short).setRequired(true).setValue(Object.entries(stages).map(([k,v]) => `${k}=${v.day}:${v.hour}`).join(','))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('term').setLabel('Termin-Reminder Minuten z.B. 1440,60,30').setStyle(TextInputStyle.Short).setRequired(true).setValue((cfg.termMinutesBefore || []).join(','))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('overdue').setLabel('Überfällig-Wiederholung in Stunden').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.overdueRepeatHours || 24))),
    );
}
function buildSmartPingConfigModal() {
  const cfg = getSystemControlConfig().smartPing;
  return new ModalBuilder()
    .setCustomId('systempanel_smartping_modal')
    .setTitle('Smart Ping bearbeiten')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Smart Ping: an/aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('days').setLabel('Aktive Tage: alle oder 1,2,3,4,5,6,7').setStyle(TextInputStyle.Short).setRequired(true).setValue((cfg.activeDays || []).join(','))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('scores').setLabel('Scores: risiko,sehr,zuv,mittel,unzuverlässig').setStyle(TextInputStyle.Short).setRequired(true).setValue(`${cfg.minRisk},${cfg.labelVeryReliable ?? cfg.reliableSkipScore},${cfg.labelReliable ?? cfg.sundayOnlyScore},${cfg.labelMedium ?? cfg.mediumScore},${cfg.labelUnreliable ?? 35}`)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thresholds').setLabel('Ping-Schwellen: abgaben,sanktionen,noresponse').setStyle(TextInputStyle.Short).setRequired(true).setValue(`${cfg.openAbgabenThreshold},${cfg.sanctionThreshold},${cfg.termNoResponseThreshold}`)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('points').setLabel('Punkte-Werte kommagetrennt').setPlaceholder('offenAb,offen-,noResp-,leicht-,mittel-,schwer-,wAb,w-,wWh,wSchwerAb').setStyle(TextInputStyle.Short).setRequired(true).setValue(`${cfg.openAbgabenPenaltyStart ?? 1},${cfg.openAbgabenPenaltyPoints ?? 10},${cfg.termNoResponsePenaltyPoints ?? 6},${cfg.sanctionPenaltyLight ?? 5},${cfg.sanctionPenaltyMedium ?? 12},${cfg.sanctionPenaltyHeavy ?? 22},${cfg.wachePenaltyStart ?? 1},${cfg.wachePenaltyPoints ?? 15},${cfg.wacheRepeatPenaltyPoints ?? 8},${cfg.wachePenaltyHeavyAfter ?? 3}`)),
    );
}
function parseReminderStageConfig(raw, current = {}) {
  const stages = deepClone(current || DEFAULT_SYSTEM_CONTROL_CONFIG.reminders.abgabeStages);
  for (const part of String(raw || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const [stageRaw, valueRaw] = part.split('=');
    const stage = String(stageRaw || '').trim().toLowerCase();
    if (!['thu','fri','sun'].includes(stage)) continue;
    const m = String(valueRaw || '').trim().match(/^(\d{1,2})[:.](\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) continue;
    const day = Math.max(1, Math.min(7, Number(m[1])));
    const hour = Math.max(0, Math.min(23, Number(m[2])));
    const minute = Math.max(0, Math.min(59, Number(m[3] || 0)));
    stages[stage] = { ...(stages[stage] || {}), enabled: true, day, hour, minute };
  }
  return stages;
}
function isReminderGloballyEnabled(area = 'general') {
  const cfg = getSystemControlConfig().reminders;
  if (!cfg.enabled) return false;
  if (area === 'dm' && !cfg.dmEnabled) return false;
  if (area === 'abgaben' && !cfg.abgabeEnabled) return false;
  if (area === 'sanktionen' && !cfg.sanctionEnabled) return false;
  if (area === 'termine' && !cfg.termEnabled) return false;
  if (area === 'wache' && !cfg.wacheEnabled) return false;
  return true;
}
function getIsoWeekdayNow() {
  const d = getTzDate();
  return ((d.getDay() + 6) % 7) + 1;
}
function shouldRunAbgabeReminderStage(stage) {
  const cfg = getSystemControlConfig().reminders;
  const s = cfg.abgabeStages?.[stage];
  if (!isAutomationEnabled('abgabeReminders')) return false;
  if (!isReminderGloballyEnabled('abgaben') || !s?.enabled) return false;
  const d = getTzDate();
  const isoDay = ((d.getDay() + 6) % 7) + 1;
  return isoDay === Number(s.day) && d.getHours() === Number(s.hour) && d.getMinutes() >= Number(s.minute || 0);
}
function isSmartPingActiveToday() {
  const cfg = getSystemControlConfig().smartPing;
  if (!cfg.enabled) return false;
  return (cfg.activeDays || []).includes(getIsoWeekdayNow());
}

const PANEL_CANAL_KEYS = {
  routen: 'routen',
  patronen: 'patronen',
  schwarzpulver: 'schwarzpulver',
  meth: 'meth',
  sanktionen: 'sanktionen',
  ausgeteilte: 'ausgeteilte',
  abmeldungen: 'abmeldungen',
  termine: 'termine',
  ankuendigungen: 'ankuendigungen',
  abstimmungen: 'abstimmungen',
  statistik: 'statistik',
  dashboard: 'dashboard',
  freigaben: 'freigaben',
  lagerbestand: 'lagerbestand',
};
const DM_TEMPLATES = {
  abgabeOpen: category => `Du hast noch nicht abgegeben: ${ABGABEN[category].label}.`,
  abgabeLastDay: category => `Du hast noch nicht abgegeben: ${ABGABEN[category].label}. Letzte Warnung bis zur eingestellten Abgabefrist.`,
  abgabeOverdue: (category, weekKey) => `Du hast eine überfällige Abgabe. Du hast bis Dienstag 22:00 Uhr Zeit, um eine Sanktion zu vermeiden. Offen: ${ABGABEN[category].label} (${weekKey}).`,
  abgabeRecoveryOpen: category => `Deine Abgabe ist noch offen und muss nach deiner Abmeldung nachgeholt werden: ${ABGABEN[category].label}.`,
  abgabeRecoveryWarning: category => `Deine Abgabe ist überfällig: ${ABGABEN[category].label}. Letzte Warnung – mach die Abgabe, um die Sanktion zu verhindern.`,
  abgabeFinalWarning: category => `Letzte Warnung: Deine Abgabe ist noch offen. Offen: ${ABGABEN[category].label}.`,
  sanctionIssued: (issuer, sanction, amountLabel) => [
    'Du hast eine Sanktion erhalten.',
    `Ausgestellt von: ${issuer}`,
    `Katalog: ${sanction.catalogNo} – ${sanction.catalogLabel}`,
    `Strafart: ${sanction.penaltyType}`,
    `Menge/Betrag: ${amountLabel}`,
    `Fällig bis: ${sanction.dueAt ? formatDateTime(sanction.dueAt) : '—'}`,
    `Grund: ${sanction.extraReason || '—'}`,
  ].join('\n'),
  sanctionOpenDays: days => `Deine Sanktion ist noch offen. Du hast noch ${days} ${days === 1 ? 'Tag' : 'Tage'} Zeit, um sie zu begleichen.`,
  sanctionLastDay: 'Heute ist der letzte Tag, um deine Sanktion zu bezahlen/zu erfüllen.',
  sanctionSurcharge: 'Du hast die Sanktion nicht bezahlt. 100.000$ Aufpreis wurden hinzugefügt.',
  sanctionBloodoutWarningDays: days => `Letzte Warnung. Du hast noch ${days} ${days === 1 ? 'Tag' : 'Tage'} Zeit, bevor Bloodout angekündigt wird.`,
  sanctionBloodoutLastDay: 'Letzte Warnung. Heute ist der letzte Tag vor dem Bloodout.',
  sanctionBloodout: 'Du bekommst ein Bloodout.',
};
// =========================================================
// STORAGE
// =========================================================
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const STORE_BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;
const STORE_BACKUP_LIMIT = 8;
const HEALTH_LOG_INTERVAL_MS = 15 * 60 * 1000;
const DISCORD_QUEUE_DELAY_MS = 1100;
const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  abgaben: path.join(DATA_DIR, 'abgaben.json'),
  sanctions: path.join(DATA_DIR, 'sanctions.json'),
  absences: path.join(DATA_DIR, 'absences.json'),
  terms: path.join(DATA_DIR, 'terms.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
  wache: path.join(DATA_DIR, 'wache.json'),
  inventory: path.join(DATA_DIR, 'inventory.json'),
  cashbox: path.join(DATA_DIR, 'cashbox.json'),
  blood: path.join(DATA_DIR, 'blood.json'),
};
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return deepClone(fallback);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('JSON READ ERROR', file, error);
    return deepClone(fallback);
  }
}
const lastSerializedByFile = new Map();
const lastBackupByFile = new Map();
function pruneBackupsForBase(baseName) {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(name => name.startsWith(baseName + '.'))
      .sort()
      .reverse();
    for (const stale of files.slice(STORE_BACKUP_LIMIT)) {
      fs.unlinkSync(path.join(BACKUP_DIR, stale));
    }
  } catch (error) {
    console.error('BACKUP_PRUNE_ERROR', baseName, error);
  }
}
function writeJSON(file, data) {
  const serialized = JSON.stringify(data, null, 2);
  if (lastSerializedByFile.get(file) === serialized) return;
  const base = path.basename(file);
  const nowTs = Date.now();
  try {
    if (fs.existsSync(file)) {
      const lastBackupTs = lastBackupByFile.get(file) || 0;
      if ((nowTs - lastBackupTs) >= STORE_BACKUP_MIN_INTERVAL_MS) {
        const stamp = new Date(nowTs).toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `${base}.${stamp}.bak`);
        fs.copyFileSync(file, backupFile);
        lastBackupByFile.set(file, nowTs);
        pruneBackupsForBase(base);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, serialized, 'utf8');
    fs.renameSync(tmp, file);
    lastSerializedByFile.set(file, serialized);
  } catch (error) {
    console.error('JSON_WRITE_ERROR', file, error);
    throw error;
  }
}
const DEFAULT_CONFIG = {
  channels: {},
  panelMessages: {},
  settings: {
    leaderReminderDmEnabled: true,
    routeAdminFridayReportEnabled: true,
    routeAdminMondayReportEnabled: true,
    smartPingEnabled: true,
    dashboardEnabled: true,
    sanctionApprovalEnabled: true,
    autoSanctionsEnabled: true,
    termRemindersEnabled: true,
    decisionHintsEnabled: true,
    dryRunEnabled: false,
    logSystemEnabled: true,
    leadershipDutiesEnabled: true,
    abgabenEnabled: {
      routen: true,
      patronen: true,
      schwarzpulver: true,
      meth: true,
    },
    abgabenConfig: {
      routen: { amount: 300000, deadlineDay: 7, deadlineHour: 23, deadlineMinute: 59 },
      patronen: { amount: 200, deadlineDay: 7, deadlineHour: 23, deadlineMinute: 59 },
      schwarzpulver: { amount: 200, deadlineDay: 7, deadlineHour: 23, deadlineMinute: 59 },
      meth: { amount: 500, deadlineDay: 7, deadlineHour: 23, deadlineMinute: 59 },
    },
    wacheConfig: {
      enabled: false,
      requiredMinutesPerWeek: 60,
      absenceExcuseDays: 5,
      sessionMinutes: 60,
      maxParticipants: 5,
      sanctionAmount: 100000,
      reportChannelKey: 'statistik',
      reportChannelId: '',
      dashboardChannelId: '',
      enabledAt: 0,
      startHour: 14,
      endHour: 24,
    },
  },
  roleTracking: {
    assignments: {},
  },
  roles: {
    leadership: [],
    routenverwaltung: [],
    permissions: {
      admin: [],
      sanction_manage: [],
      sanction_approve: [],
      absence_manage: [],
      attendance_manage: [],
      config_manage: [],
      dashboard_view: [],
      rollback_manage: [],
    },
  },
  safety: {
    whitelistUserIds: [],
    blacklistUserIds: [],
  },
  diagnostics: {
    dmFailures: [],
  },
};
const DEFAULT_ABGABEN = {
  weeks: {},
  monthReports: {},
};
const DEFAULT_SANCTIONS = {
  items: [],
};
const DEFAULT_ABSENCES = {
  items: [],
};
const DEFAULT_TERMS = {
  items: [],
};
const DEFAULT_SESSIONS = {
  abgabePanels: {},
  memberPickers: {},
  termBuilders: {},
  sanctionManage: {},
  absenceForms: {},
  pendingSanctionApprovals: {},
  autoSanctionSuppressions: {},
  attendanceChecks: {},
  attendanceLaunchers: {},
  rollbackStack: [],
};
const DEFAULT_WACHE = {
  active: null,
  weeks: {},
  monthReports: {},
  dashboardMessage: null,
};
const DEFAULT_INVENTORY = {
  items: {},
  listMessage: null,
};
const DEFAULT_CASHBOX = {
  balance: 0,
  transactions: [],
  monthReports: {},
  dashboardMessage: null,
};
const DEFAULT_BLOOD = {
  items: [],
};

const store = {
  config: readJSON(FILES.config, DEFAULT_CONFIG),
  abgaben: readJSON(FILES.abgaben, DEFAULT_ABGABEN),
  sanctions: readJSON(FILES.sanctions, DEFAULT_SANCTIONS),
  absences: readJSON(FILES.absences, DEFAULT_ABSENCES),
  terms: readJSON(FILES.terms, DEFAULT_TERMS),
  sessions: readJSON(FILES.sessions, DEFAULT_SESSIONS),
  wache: readJSON(FILES.wache, DEFAULT_WACHE),
  inventory: readJSON(FILES.inventory, DEFAULT_INVENTORY),
  cashbox: readJSON(FILES.cashbox, DEFAULT_CASHBOX),
  blood: readJSON(FILES.blood, DEFAULT_BLOOD),
};
function ensureConfigShape() {
  if (!store.config.channels) store.config.channels = {};
  if (!store.config.panelMessages) store.config.panelMessages = {};
  if (!store.config.settings) store.config.settings = {};
  if (!store.config.roleTracking || typeof store.config.roleTracking !== 'object') store.config.roleTracking = {};
  if (!store.config.roleTracking.assignments || typeof store.config.roleTracking.assignments !== 'object') store.config.roleTracking.assignments = {};
  if (!store.config.roles || typeof store.config.roles !== 'object') store.config.roles = {};
  if (!Array.isArray(store.config.roles.leadership)) store.config.roles.leadership = [];
  if (!Array.isArray(store.config.roles.routenverwaltung)) store.config.roles.routenverwaltung = [];
  if (!store.config.roles.permissions || typeof store.config.roles.permissions !== 'object') store.config.roles.permissions = {};
  for (const key of ['admin','sanction_manage','sanction_approve','absence_manage','attendance_manage','config_manage','dashboard_view','rollback_manage']) {
    if (!Array.isArray(store.config.roles.permissions[key])) store.config.roles.permissions[key] = [];
  }
  if (!store.config.safety || typeof store.config.safety !== 'object') store.config.safety = {};
  if (!Array.isArray(store.config.safety.whitelistUserIds)) store.config.safety.whitelistUserIds = [];
  if (!Array.isArray(store.config.safety.blacklistUserIds)) store.config.safety.blacklistUserIds = [];
  if (!store.config.diagnostics || typeof store.config.diagnostics !== 'object') store.config.diagnostics = {};
  if (!Array.isArray(store.config.diagnostics.dmFailures)) store.config.diagnostics.dmFailures = [];
  if (typeof store.config.settings.leaderReminderDmEnabled !== 'boolean') store.config.settings.leaderReminderDmEnabled = true;
  if (typeof store.config.settings.routeAdminFridayReportEnabled !== 'boolean') store.config.settings.routeAdminFridayReportEnabled = true;
  if (typeof store.config.settings.routeAdminMondayReportEnabled !== 'boolean') store.config.settings.routeAdminMondayReportEnabled = true;
  if (typeof store.config.settings.smartPingEnabled !== 'boolean') store.config.settings.smartPingEnabled = true;
  if (typeof store.config.settings.dashboardEnabled !== 'boolean') store.config.settings.dashboardEnabled = true;
  store.config.settings.sanctionApprovalEnabled = true;
  if (typeof store.config.settings.autoSanctionsEnabled !== 'boolean') store.config.settings.autoSanctionsEnabled = true;
  if (typeof store.config.settings.termRemindersEnabled !== 'boolean') store.config.settings.termRemindersEnabled = true;
  if (typeof store.config.settings.decisionHintsEnabled !== 'boolean') store.config.settings.decisionHintsEnabled = true;
  if (typeof store.config.settings.dryRunEnabled !== 'boolean') store.config.settings.dryRunEnabled = false;
  if (typeof store.config.settings.logSystemEnabled !== 'boolean') store.config.settings.logSystemEnabled = true;
  if (typeof store.config.settings.leadershipDutiesEnabled !== 'boolean') store.config.settings.leadershipDutiesEnabled = true;
  if (!store.config.settings.dmSettings || typeof store.config.settings.dmSettings !== 'object') store.config.settings.dmSettings = {};
  if (typeof store.config.settings.dmSettings.enabled !== 'boolean') store.config.settings.dmSettings.enabled = true;
  if (!store.config.settings.dmSettings.areas || typeof store.config.settings.dmSettings.areas !== 'object') store.config.settings.dmSettings.areas = {};
  for (const area of ['general','abgaben','sanktionen','wache','termine','leader']) {
    if (typeof store.config.settings.dmSettings.areas[area] !== 'boolean') store.config.settings.dmSettings.areas[area] = true;
  }
  if (typeof store.config.settings.dmSettings.dailyDedupEnabled !== 'boolean') store.config.settings.dmSettings.dailyDedupEnabled = true;
  if (typeof store.config.settings.dmSettings.buttonsEnabled !== 'boolean') store.config.settings.dmSettings.buttonsEnabled = true;
  if (!store.config.diagnostics.dmStatus || typeof store.config.diagnostics.dmStatus !== 'object') store.config.diagnostics.dmStatus = {};
  if (!store.config.diagnostics.dmDailySends || typeof store.config.diagnostics.dmDailySends !== 'object') store.config.diagnostics.dmDailySends = {};
  // Intelligence/Stabilitäts-Systeme müssen auch bei alten config.json-Dateien existieren.
  if (!Array.isArray(store.config.auditLog)) store.config.auditLog = [];
  if (!store.config.statsCache || typeof store.config.statsCache !== 'object' || Array.isArray(store.config.statsCache)) store.config.statsCache = {};
  if (!store.config.behaviorPatterns || typeof store.config.behaviorPatterns !== 'object' || Array.isArray(store.config.behaviorPatterns)) store.config.behaviorPatterns = {};
  if (!store.config.settings.archiveConfig || typeof store.config.settings.archiveConfig !== 'object') store.config.settings.archiveConfig = {};
  if (typeof store.config.settings.archiveConfig.enabled !== 'boolean') store.config.settings.archiveConfig.enabled = true;
  if (!Number.isInteger(Number(store.config.settings.archiveConfig.keepWeeks)) || Number(store.config.settings.archiveConfig.keepWeeks) < 4) store.config.settings.archiveConfig.keepWeeks = 12;
  if (!store.config.maintenance || typeof store.config.maintenance !== 'object') store.config.maintenance = {};
  if (!store.config.maintenance.cronRuns || typeof store.config.maintenance.cronRuns !== 'object') store.config.maintenance.cronRuns = {};
  if (!store.config.maintenance.recovery || typeof store.config.maintenance.recovery !== 'object') store.config.maintenance.recovery = {};
  if (!store.config.maintenance.locks || typeof store.config.maintenance.locks !== 'object') store.config.maintenance.locks = {};
  if (!store.config.maintenance.integrity || typeof store.config.maintenance.integrity !== 'object') store.config.maintenance.integrity = { lastRunAt: 0, lastIssueCount: 0 };
  if (!store.config.settings.appearance || typeof store.config.settings.appearance !== 'object') store.config.settings.appearance = {};
  const appearance = store.config.settings.appearance;
  if (typeof appearance.embedColor !== 'string') appearance.embedColor = '#D4AF37';
  if (typeof appearance.prefix !== 'string' || !appearance.prefix.trim()) appearance.prefix = '!';
  if (typeof appearance.footerText !== 'string') appearance.footerText = 'Admin GUI • live steuerbar';
  if (typeof appearance.dashboardTitle !== 'string' || !appearance.dashboardTitle.trim()) appearance.dashboardTitle = 'Live Dashboard • Übersicht';
  if (typeof appearance.cashboxTitle !== 'string' || !appearance.cashboxTitle.trim()) appearance.cashboxTitle = 'Familienkasse';
  if (typeof appearance.leaderPanelTitle !== 'string' || !appearance.leaderPanelTitle.trim()) appearance.leaderPanelTitle = 'Leader Panel';
  if (typeof appearance.adminPanelTitle !== 'string' || !appearance.adminPanelTitle.trim()) appearance.adminPanelTitle = 'Admin Controls';
  ensureAbgabenRuntimeConfig();
  if (store?.config?.settings) {
    store.config.settings.rules ||= deepClone(DEFAULT_RULES_CONFIG);
    store.config.sanctionCatalog ||= deepClone(SANCTION_CATALOG);
  }
}


ensureConfigShape();
function normalizeHexColor(input, fallback = '#D4AF37') {
  const raw = String(input || '').trim();
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toUpperCase() : fallback;
}
function hexColorToInt(hex, fallback = COLORS.primary) {
  const clean = normalizeHexColor(hex, '#D4AF37').replace('#', '');
  const parsed = parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function getBotAppearance() {
  ensureConfigShape();
  const cfg = store.config.settings.appearance;
  cfg.embedColor = normalizeHexColor(cfg.embedColor, '#D4AF37');
  return cfg;
}
function applyRuntimeAppearance() {
  const cfg = getBotAppearance();
  const color = hexColorToInt(cfg.embedColor, 0xD4AF37);
  COLORS.primary = color;
  COLORS.info = color;
  COLORS.success = color;
  return cfg;
}
function setBotAppearance(changes = {}, byId = 'system') {
  const cfg = getBotAppearance();
  if (changes.embedColor != null) cfg.embedColor = normalizeHexColor(changes.embedColor, cfg.embedColor);
  if (changes.prefix != null) cfg.prefix = String(changes.prefix || '!').trim().slice(0, 8) || '!';
  if (changes.footerText != null) cfg.footerText = String(changes.footerText || '').trim().slice(0, 120) || 'Admin GUI • live steuerbar';
  if (changes.dashboardTitle != null) cfg.dashboardTitle = String(changes.dashboardTitle || '').trim().slice(0, 80) || 'Live Dashboard • Übersicht';
  if (changes.cashboxTitle != null) cfg.cashboxTitle = String(changes.cashboxTitle || '').trim().slice(0, 80) || 'Familienkasse';
  if (changes.leaderPanelTitle != null) cfg.leaderPanelTitle = String(changes.leaderPanelTitle || '').trim().slice(0, 80) || 'Leader Panel';
  if (changes.adminPanelTitle != null) cfg.adminPanelTitle = String(changes.adminPanelTitle || '').trim().slice(0, 80) || 'Admin Controls';
  applyRuntimeAppearance();
  appendAuditLog?.('appearance_geaendert', byId, null, changes);
  saveAll();
  return cfg;
}
applyRuntimeAppearance();
function ensureSessionShape() {
  if (!store.sessions || typeof store.sessions !== 'object') store.sessions = {};
  if (!store.sessions.abgabePanels || typeof store.sessions.abgabePanels !== 'object') store.sessions.abgabePanels = {};
  if (!store.sessions.memberPickers || typeof store.sessions.memberPickers !== 'object') store.sessions.memberPickers = {};
  if (!store.sessions.termBuilders || typeof store.sessions.termBuilders !== 'object') store.sessions.termBuilders = {};
  if (!store.sessions.sanctionManage || typeof store.sessions.sanctionManage !== 'object') store.sessions.sanctionManage = {};
  if (!store.sessions.absenceForms || typeof store.sessions.absenceForms !== 'object') store.sessions.absenceForms = {};
  if (!store.sessions.pendingSanctionApprovals || typeof store.sessions.pendingSanctionApprovals !== 'object') store.sessions.pendingSanctionApprovals = {};
  if (!store.sessions.autoSanctionSuppressions || typeof store.sessions.autoSanctionSuppressions !== 'object') store.sessions.autoSanctionSuppressions = {};
  if (!store.sessions.attendanceChecks || typeof store.sessions.attendanceChecks !== 'object') store.sessions.attendanceChecks = {};
  if (!store.sessions.attendanceLaunchers || typeof store.sessions.attendanceLaunchers !== 'object') store.sessions.attendanceLaunchers = {};
  if (!Array.isArray(store.sessions.rollbackStack)) store.sessions.rollbackStack = [];
  if (!store.sessions.cashboxForms || typeof store.sessions.cashboxForms !== 'object') store.sessions.cashboxForms = {};
  if (!store.sessions.warehouseTransfers || typeof store.sessions.warehouseTransfers !== 'object') store.sessions.warehouseTransfers = {};
}


ensureSessionShape();


function ensureCustomizationConfigLocal() {
  store.config ||= {}; store.config.settings ||= {};
  const c = store.config.settings.customization ||= {};
  c.templates ||= {};
  c.templates.bloodin ||= { enabled:true, title:'🟢 Bloodin', message:'{name} ist der Familie beigetreten.', color:'#22c55e', embed:true, fields:[{name:'Mitglied', value:'{name}'},{name:'Discord ID', value:'{userId}'},{name:'Zeit', value:'{date}'}] };
  c.templates.bloodout ||= { enabled:true, title:'🔴 Bloodout', message:'{name} hat den Server verlassen.', color:'#ef4444', embed:true, fields:[{name:'Mitglied', value:'{name}'},{name:'Discord ID', value:'{userId}'},{name:'Grund', value:'{reason}'},{name:'Zeit', value:'{date}'}] };
  c.abgabeTypes ||= [];
  c.statCards ||= [];
  c.labels ||= {};
  return c;
}
function renderCustomTemplate(name, vars = {}) {
  const c = ensureCustomizationConfigLocal();
  const t = c.templates?.[name] || {};
  const fill = value => String(value || '').replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
  return { ...t, title:fill(t.title || name), message:fill(t.message || ''), fields:(t.fields || []).map(f => ({ name:fill(f.name), value:fill(f.value), inline:!!f.inline })) };
}

function ensureBloodShape() {
  if (!store.blood || typeof store.blood !== 'object') store.blood = { items: [] };
  if (!Array.isArray(store.blood.items)) store.blood.items = [];
}
ensureCustomizationConfigLocal();
function syncCustomAbgabeTypesIntoAbgaben() {
  const c = ensureCustomizationConfigLocal();
  for (const t of (c.abgabeTypes || [])) {
    if (!t || !t.key) continue;
    const key = String(t.key).trim();
    const participantRoleIds = Array.isArray(t.participantRoleIds) && t.participantRoleIds.length ? t.participantRoleIds.map(String).filter(Boolean) : (Array.isArray(t.roleIds) ? t.roleIds.map(String).filter(Boolean) : (t.roleId ? [String(t.roleId)] : []));
    ABGABEN[key] = {
      ...(ABGABEN[key] || {}),
      key,
      label: String(t.label || key),
      amount: Number(store.config?.settings?.abgabenConfig?.[key]?.amount || t.amount || ABGABEN[key]?.amount || 0),
      unit: String(t.unit || ABGABEN[key]?.unit || ''),
      roleId: participantRoleIds[0] || '',
      participantRoleIds,
      channelName: String(t.channelName || ABGABEN[key]?.channelName || `${key}-abgabe`),
      emoji: String(t.emoji || ABGABEN[key]?.emoji || '📦'),
    };
  }
}
function getAbgabeParticipantRoleIds(category) {
  syncCustomAbgabeTypesIntoAbgaben();
  const cfg = ABGABEN[category] || {};
  return (Array.isArray(cfg.participantRoleIds) && cfg.participantRoleIds.length ? cfg.participantRoleIds : (cfg.roleId ? [cfg.roleId] : [])).map(String).filter(Boolean);
}
syncCustomAbgabeTypesIntoAbgaben();
ensureBloodShape();
function getMemberBloodName(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || member?.id || 'Unbekannt';
}
function rememberBloodEvent(type, member, reason = '') {
  ensureBloodShape();
  const userId = String(member?.id || member?.user?.id || '');
  const item = {
    id: `blood_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    type,
    userId,
    name: getMemberBloodName(member),
    reason: reason || (type === 'Bloodin' ? renderCustomTemplate('bloodin',{name:getMemberBloodName(member),userId,reason,date:new Date().toLocaleString('de-DE')}).message || 'Server betreten' : renderCustomTemplate('bloodout',{name:getMemberBloodName(member),userId,reason,date:new Date().toLocaleString('de-DE')}).message || 'Server verlassen'),
    at: Date.now(),
    source: 'discord_member_event',
    status: type === 'Bloodin' ? 'aktiv' : 'verlassen',
  };
  store.blood.items.unshift(item);
  store.blood.items = store.blood.items.slice(0, 2000);
  appendAuditLog?.('blood_member_event', 'system', userId, { type, name: item.name, reason: item.reason });
  saveAll();
  return item;
}
let saveAllRunning = false;
function saveAll() {
  // Node läuft single-threaded, aber Interactions können zwischen await-Punkten denselben Store verändern.
  // Dieser Schutz verhindert re-entrante Writes und sorgt dafür, dass immer ein konsistenter Snapshot geschrieben wird.
  if (saveAllRunning) {
    setImmediate(() => { try { saveAll(); } catch (error) { console.error('DEFERRED_SAVE_ERROR', error); } });
    return;
  }
  saveAllRunning = true;
  try {
    writeJSON(FILES.config, store.config);
    writeJSON(FILES.abgaben, store.abgaben);
    writeJSON(FILES.sanctions, store.sanctions);
    writeJSON(FILES.absences, store.absences);
    writeJSON(FILES.terms, store.terms);
    writeJSON(FILES.sessions, store.sessions);
    writeJSON(FILES.wache, store.wache);
    writeJSON(FILES.inventory, store.inventory);
    writeJSON(FILES.cashbox, store.cashbox);
    writeJSON(FILES.blood, store.blood);
  } finally {
    saveAllRunning = false;
  }
}

function reloadAllFromDiskForWebSync() {
  try {
    store.config = readJSON(FILES.config, DEFAULT_CONFIG);
    store.abgaben = readJSON(FILES.abgaben, DEFAULT_ABGABEN);
    store.sanctions = readJSON(FILES.sanctions, DEFAULT_SANCTIONS);
    store.absences = readJSON(FILES.absences, DEFAULT_ABSENCES);
    store.terms = readJSON(FILES.terms, DEFAULT_TERMS);
    store.sessions = readJSON(FILES.sessions, DEFAULT_SESSIONS);
    store.wache = readJSON(FILES.wache, DEFAULT_WACHE);
    store.inventory = readJSON(FILES.inventory, DEFAULT_INVENTORY);
    store.cashbox = readJSON(FILES.cashbox, DEFAULT_CASHBOX);
    store.blood = readJSON(FILES.blood, DEFAULT_BLOOD);
    ensureConfigShape();
    ensureSessionShape();
    applyRuntimeAppearance();
    return true;
  } catch (error) {
    console.error('WEB_SYNC_RELOAD_ERROR', error);
    return false;
  }
}
async function handleWebSyncWebhook(req, res) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/web-sync') return false;
  if (CASHBOX_WEBHOOK_SECRET && String(req.headers['x-web-sync-secret'] || '') !== CASHBOX_WEBHOOK_SECRET) {
    sendJsonResponse(res, 401, { ok: false, error: 'Nicht autorisiert.' });
    return true;
  }
  let payload = {};
  try { const raw = await readRequestBody(req); payload = raw ? JSON.parse(raw) : {}; } catch (_) {}
  const reloaded = reloadAllFromDiskForWebSync();
  const guild = client.guilds.cache.get(GUILD_ID) || null;
  if (guild) {
    try {
      await syncAllStoredMessages(guild);
      if (payload.kind === 'cashbox') await upsertCashboxDashboardMessage(guild).catch(() => null);
      if (payload.kind === 'wache') await upsertWacheDashboardMessage(guild, null, true).catch(() => null);
      if (payload.kind === 'terms') await upsertTermDashboardMessage(guild).catch(() => null);
      if (payload.kind === 'members') await upsertMembersDashboardMessage(guild).catch(() => null);
      await emitHealthLog(guild, 'web-sync').catch(() => null);
    } catch (error) {
      console.error('WEB_SYNC_REFRESH_ERROR', error);
      sendJsonResponse(res, 500, { ok: false, reloaded, error: String(error.message || error) });
      return true;
    }
  }
  sendJsonResponse(res, 200, { ok: true, reloaded, kind: payload.kind || 'all' });
  return true;
}

function setTrackedRoleAssignment(userId, roleId, ts, source = 'tracked') {
  if (!userId || !roleId) return false;
  ensureConfigShape();
  store.config.roleTracking.assignments[userId] ||= {};
  const current = store.config.roleTracking.assignments[userId][roleId];
  if (current && Number(current.ts || 0) === Number(ts || 0) && current.source === source) return false;
  store.config.roleTracking.assignments[userId][roleId] = { ts: Number(ts || now()), source };
  return true;
}
function removeTrackedRoleAssignment(userId, roleId) {
  if (!userId || !roleId) return false;
  const bucket = store.config.roleTracking.assignments?.[userId];
  if (!bucket || !bucket[roleId]) return false;
  delete bucket[roleId];
  if (!Object.keys(bucket).length) delete store.config.roleTracking.assignments[userId];
  return true;
}
function getTrackedRoleAssignmentTs(userId, roleId) {
  return Number(store.config.roleTracking.assignments?.[userId]?.[roleId]?.ts || 0) || null;
}
function getWacheRequiredRoleIds() {
  // Wache-Pflicht gilt ausschließlich für Mitglieder mit der Routen-Rolle.
  // Routenverwaltung/Leader werden dadurch nicht automatisch einbezogen.
  return ROUTEN_ROLE_ID ? [ROUTEN_ROLE_ID] : [];
}
function getTrackedDutyRoleIds() {
  const abgabeRoleIds = Object.values(ABGABEN).map(cfg => cfg.roleId).filter(Boolean);
  return [...new Set([...abgabeRoleIds, ...getWacheRequiredRoleIds()])];
}
function seedRoleTrackingForMember(member) {
  if (!member || member.user?.bot) return false;
  let changed = false;
  for (const roleId of getTrackedDutyRoleIds()) {
    if (!member.roles.cache.has(roleId)) continue;
    const existing = getTrackedRoleAssignmentTs(member.id, roleId);
    if (existing) continue;
    const fallbackTs = Number(member.joinedTimestamp || now());
    if (setTrackedRoleAssignment(member.id, roleId, fallbackTs, 'fallback_joined_at')) changed = true;
  }
  return changed;
}
async function seedRoleTrackingForGuild(guild) {
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  let changed = false;
  for (const member of guild.members.cache.values()) {
    if (seedRoleTrackingForMember(member)) changed = true;
  }
  if (changed) saveAll();
}
function getRoleReceivedTsForCategory(member, category) {
  if (!member) return null;
  const roleIds = getAbgabeParticipantRoleIds(category);
  if (!roleIds.length) return Number(member.joinedTimestamp || 0) || null;
  const matches = roleIds.filter(roleId => member.roles?.cache?.has(roleId));
  if (!matches.length) return null;
  const times = matches.map(roleId => getTrackedRoleAssignmentTs(member.id, roleId) || Number(member.joinedTimestamp || 0) || null).filter(Boolean);
  return times.length ? Math.min(...times) : null;
}
function isExcusedDueToLateRoleAssignment(member, category, weekKey) {
  const roleReceivedTs = getRoleReceivedTsForCategory(member, category);
  if (!roleReceivedTs) return false;
  const weekStart = startOfWeekTsFromWeekKey(weekKey);
  const weekEnd = endOfWeekTsFromWeekKey(weekKey);
  const wednesdayStart = weekStart + (2 * 24 * 60 * 60 * 1000);
  return roleReceivedTs >= wednesdayStart && roleReceivedTs < weekEnd;
}
// =========================================================
// DATE / TIME HELPERS
// =========================================================
function now() {
  return Date.now();
}
function getTzDate(date = new Date()) {
  const asText = date.toLocaleString('sv-SE', { timeZone: TIMEZONE });
  return new Date(asText.replace(' ', 'T'));
}
function tsToTzDate(ts) {
  return getTzDate(new Date(ts));
}
function formatDateTime(ts) {
  return new Date(ts).toLocaleString('de-DE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function formatDateTimeLong(ts) {
  return new Date(ts).toLocaleString('de-DE', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function currentDayKey() {
  return getTzDate().toISOString().slice(0, 10);
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('de-DE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
function addDaysTs(ts, days) {
  return ts + (days * 24 * 60 * 60 * 1000);
}
function addMinutesTs(ts, minutes) {
  return ts + (minutes * 60 * 1000);
}
function isSameDayTs(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}
function formatRelativeDayLabel(ts) {
  const target = tsToTzDate(ts);
  const today = getTzDate();
  today.setHours(0, 0, 0, 0);
  const compare = new Date(target);
  compare.setHours(0, 0, 0, 0);
  const diffDays = Math.round((compare - today) / 86400000);
  if (diffDays === 0) return 'heute';
  if (diffDays === 1) return 'morgen';
  if (diffDays === 2) return 'übermorgen';
  if (diffDays === -1) return 'gestern';
  return null;
}
function formatDueLabel(ts) {
  if (!ts) return '—';
  const rel = formatRelativeDayLabel(ts);
  const base = formatDateTimeLong(ts);
  return rel ? `${rel[0].toUpperCase()}${rel.slice(1)} • ${base}` : base;
}
function formatDaysUntilLabel(ts) {
  if (!ts) return '—';
  const target = tsToTzDate(ts);
  const nowDate = getTzDate();
  const compareTarget = new Date(target);
  compareTarget.setHours(0, 0, 0, 0);
  const compareNow = new Date(nowDate);
  compareNow.setHours(0, 0, 0, 0);
  const diffDays = Math.round((compareTarget - compareNow) / 86400000);
  if (diffDays <= 0) return 'heute';
  if (diffDays == 1) return 'bis morgen';
  if (diffDays == 2) return 'bis übermorgen';
  return `noch ${diffDays} Tage`;
}


function hasDmFailure(userId) {
  try {
    const items = Array.isArray(store?.config?.diagnostics?.dmFailures) ? store.config.diagnostics.dmFailures : [];
    return items.some(entry => String(entry?.userId || '') === String(userId || ''));
  } catch (_) {
    return false;
  }
}

function uiList(lines) {
  return lines.filter(Boolean).join('\n');
}
function clampFieldValue(value, max = 1024) {
  const clean = String(value || '—');
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}
function buildInfoField(name, lines, inline = false) {
  return { name, value: clampFieldValue(uiList(lines) || '—'), inline };
}
function currentWeekKey() {
  return getWeekKey(getTzDate());
}
function getWeekKey(dateInput = new Date()) {
  const date = dateInput instanceof Date ? new Date(dateInput) : new Date(dateInput);
  date.setHours(0, 0, 0, 0);
  const thursday = new Date(date);
  const day = (date.getDay() + 6) % 7;
  thursday.setDate(date.getDate() - day + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  const weekNo = 1 + Math.round((thursday - firstThursday) / 604800000);
  return `${thursday.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
function weekKeyToMondayDate(weekKey) {
  const [yearStr, weekStr] = weekKey.split('-W');
  const year = Number(yearStr);
  const week = Number(weekStr);
  const jan4 = new Date(year, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4Day + ((week - 1) * 7));
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function previousWeekKey(weekKey) {
  const monday = weekKeyToMondayDate(weekKey);
  monday.setDate(monday.getDate() - 7);
  return getWeekKey(monday);
}
function nextWeekKey(weekKey) {
  const monday = weekKeyToMondayDate(weekKey);
  monday.setDate(monday.getDate() + 7);
  return getWeekKey(monday);
}
function getMonthKey(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function startOfWeekTsFromWeekKey(weekKey) {
  return weekKeyToMondayDate(weekKey).getTime();
}
function endOfWeekTsFromWeekKey(weekKey) {
  const monday = weekKeyToMondayDate(weekKey);
  monday.setDate(monday.getDate() + 7);
  return monday.getTime() - 1;
}
function parseGermanDateAndTime(dateText, timeText) {
  const [day, month, year] = dateText.split('.').map(Number);
  let [hour, minute] = timeText.split(':').map(Number);
  if (hour === 0) {
    // 00:00 belongs to next day if selected in range 16-00
    const base = new Date(year, month - 1, day, 0, minute, 0, 0);
    return addDaysTs(base.getTime(), 1);
  }
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function parseGermanDate(dateText) {
  if (!dateText) return null;
  const parts = String(dateText).split('.');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map(Number);
  if (![day, month, year].every(Number.isFinite)) return null;
  const value = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(value.getTime()) ? null : value;
}
function isRetryableDiscordError(err) {
  const status = err?.status ?? err?.rawError?.code ?? err?.code;
  return [429, 500, 502, 503, 504].includes(status);
}
function getDiscordRetryDelayMs(err, fallbackMs) {
  const retryAfter = err?.retryAfter ?? err?.rawError?.retry_after ?? err?.data?.retry_after;
  const parsed = Number(retryAfter);
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed * 1000) + 750;
  return fallbackMs;
}
async function withDiscordRetry(task, attempts = 4, delayMs = 1500) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (!isRetryableDiscordError(err) || i === attempts - 1) throw err;
      await sleep(getDiscordRetryDelayMs(err, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}
const DISCORD_QUEUE_PROFILES = {
  interaction: { delayMs: 125, running: false, jobs: [] },
  dashboard: { delayMs: 800, running: false, jobs: [] },
  dm: { delayMs: 1400, running: false, jobs: [] },
  log: { delayMs: 1600, running: false, jobs: [] },
  default: { delayMs: DISCORD_QUEUE_DELAY_MS, running: false, jobs: [] },
};
function getDiscordQueueProfile(label = '') {
  const raw = String(label || '').toLowerCase();
  if (raw.includes('interaction') || raw.includes('reply')) return DISCORD_QUEUE_PROFILES.interaction;
  if (raw.includes('dashboard') || raw.includes('stored.message.edit')) return DISCORD_QUEUE_PROFILES.dashboard;
  if (raw.includes('dm') || raw.includes('user.send')) return DISCORD_QUEUE_PROFILES.dm;
  if (raw.includes('log')) return DISCORD_QUEUE_PROFILES.log;
  return DISCORD_QUEUE_PROFILES.default;
}
function getDiscordQueueSize() {
  return Object.values(DISCORD_QUEUE_PROFILES).reduce((sum, profile) => sum + profile.jobs.length, 0);
}

const ACTION_LOCK_TTL_MS = 15000;
const runtimeActionLocks = new Map();
function acquireRuntimeActionLock(key, ttlMs = ACTION_LOCK_TTL_MS) {
  const lockKey = String(key || 'unknown');
  const until = runtimeActionLocks.get(lockKey) || 0;
  if (until > now()) return false;
  runtimeActionLocks.set(lockKey, now() + ttlMs);
  setTimeout(() => {
    if ((runtimeActionLocks.get(lockKey) || 0) <= now()) runtimeActionLocks.delete(lockKey);
  }, ttlMs + 250).unref?.();
  return true;
}
function releaseRuntimeActionLock(key) {
  runtimeActionLocks.delete(String(key || 'unknown'));
}
async function withRuntimeActionLock(key, fn, ttlMs = ACTION_LOCK_TTL_MS) {
  if (!acquireRuntimeActionLock(key, ttlMs)) return { locked: true };
  try {
    return { locked: false, result: await fn() };
  } finally {
    releaseRuntimeActionLock(key);
  }
}
function sanitizeWeekKey(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-W\d{2}$/.test(raw) ? raw : null;
}
function safePositiveAmount(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}
function getMaintenanceBucket() {
  ensureConfigShape();
  store.config.maintenance ||= {};
  store.config.maintenance.cronRuns ||= {};
  return store.config.maintenance;
}
function hasCronRun(key) {
  return !!getMaintenanceBucket().cronRuns[String(key || '')];
}
function markCronRun(key, meta = {}) {
  const bucket = getMaintenanceBucket();
  bucket.cronRuns[String(key)] = { at: now(), ...meta };
  const entries = Object.entries(bucket.cronRuns).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0));
  bucket.cronRuns = Object.fromEntries(entries.slice(0, 250));
  saveAll();
}
async function runOncePerCronKey(guild, key, label, task) {
  if (hasCronRun(key)) return false;
  const lock = await withRuntimeActionLock(`cron:${key}`, async () => {
    if (hasCronRun(key)) return false;
    await runStepSafe(guild, label, task);
    markCronRun(key, { label });
    return true;
  }, 120000);
  return !!lock.result;
}
async function processDiscordActionQueue(profile) {
  if (!profile || profile.running) return;
  profile.running = true;
  try {
    while (profile.jobs.length) {
      const job = profile.jobs.shift();
      try {
        const result = await job.task();
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      }
      if (profile.jobs.length) await sleep(profile.delayMs);
    }
  } finally {
    profile.running = false;
  }
}
function enqueueDiscordAction(label, task) {
  const profile = getDiscordQueueProfile(label);
  return new Promise((resolve, reject) => {
    profile.jobs.push({ label, task, resolve, reject, ts: Date.now() });
    processDiscordActionQueue(profile).catch(error => {
      console.error('DISCORD_QUEUE_FATAL', error);
      profile.running = false;
    });
  });
}
async function safeChannelSend(channel, payload, label = 'channel.send') {
  if (!channel?.send) return null;
  return enqueueDiscordAction(label, () => withDiscordRetry(() => channel.send(payload), 4, 1200));
}
async function safeMessageEdit(message, payload, label = 'message.edit') {
  if (!message?.edit) return null;
  return enqueueDiscordAction(label, () => withDiscordRetry(() => message.edit(payload), 4, 1200));
}
async function safeUserSend(user, payload, label = 'user.send') {
  if (!user?.send) return null;
  return enqueueDiscordAction(label, () => withDiscordRetry(() => user.send(payload), 4, 1200));
}
function stablePayloadForHash(payload) {
  return JSON.stringify(payload, (key, value) => {
    if (typeof value === 'function') return undefined;
    if (value && typeof value.toJSON === 'function') return value.toJSON();
    return value;
  });
}
function payloadHash(payload) {
  return crypto.createHash('sha256').update(stablePayloadForHash(payload)).digest('hex');
}

function isoStringNow() {
  return new Date().toISOString();
}
function daysBetween(startTs, endTs) {
  return Math.ceil((endTs - startTs) / 86400000);
}
// =========================================================
// GENERAL HELPERS
// =========================================================
function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 999999)}`;
}
function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
function parseNumber(input) {
  if (input == null) return 0;
  const clean = String(input).replace(/[^\d-]/g, '');
  const num = Number(clean || 0);
  return Number.isFinite(num) ? num : 0;
}
function formatCurrency(amount) {
  return `${Number(amount || 0).toLocaleString('de-DE')}$`;
}
function formatAmount(categoryKey, amount) {
  const cfg = ABGABEN[categoryKey];
  if (!cfg) return String(amount);
  const n = Number(amount || 0).toLocaleString('de-DE');
  if (cfg.unit === '$') return `${n}$`;
  if (!cfg.unit) return n;
  return `${n} ${cfg.unit}`;
}
function getLeadershipRoleIds() {
  const saved = store.config.roles?.leadership || [];
  return saved.length ? saved : LEADERSHIP_ROLE_IDS;
}
function getRoutenverwaltungRoleIds() {
  const saved = store.config.roles?.routenverwaltung || [];
  return saved.length ? saved : ROUTENVERWALTUNG_ROLE_IDS;
}
function getPermissionRoleIds(permissionKey) {
  const saved = store.config.roles?.permissions?.[permissionKey] || [];
  return saved.length ? saved : getLeadershipRoleIds();
}
function hasLeadership(member) {
  return Boolean(member?.roles?.cache?.some(role => getLeadershipRoleIds().includes(role.id)));
}
function areLeadershipDutiesEnabled() {
  ensureConfigShape();
  return store.config.settings.leadershipDutiesEnabled !== false;
}
function isLeadershipDutyExempt(member) {
  if (!member || !hasLeadership(member)) return false;
  return !areLeadershipDutiesEnabled();
}
function getLeadershipDutyLabel() {
  return areLeadershipDutiesEnabled() ? 'Leaderschaft-Pflicht: AN' : 'Leaderschaft-Pflicht: AUS';
}
function getLeadershipDutyStyle() {
  return areLeadershipDutiesEnabled() ? ButtonStyle.Success : ButtonStyle.Danger;
}
function setLeadershipDutiesEnabled(enabled) {
  ensureConfigShape();
  store.config.settings.leadershipDutiesEnabled = !!enabled;
  saveAll();
  return store.config.settings.leadershipDutiesEnabled;
}
function toggleLeadershipDutiesEnabled() {
  return setLeadershipDutiesEnabled(!areLeadershipDutiesEnabled());
}
function hasActionPermission(member, permissionKey) {
  if (hasLeadership(member)) return true;
  return Boolean(member?.roles?.cache?.some(role => getPermissionRoleIds(permissionKey).includes(role.id)));
}
function getDryRunEnabled() {
  return !!store.config.settings?.dryRunEnabled;
}
function isUserWhitelisted(userId) {
  return (store.config.safety?.whitelistUserIds || []).includes(String(userId));
}
function addSafetyListUser(listKey, userId) {
  const id = String(userId);
  store.config.safety[listKey] ||= [];
  if (store.config.safety[listKey].includes(id)) return false;
  store.config.safety[listKey].push(id);
  saveAll();
  return true;
}
function removeSafetyListUser(listKey, userId) {
  const id = String(userId);
  const arr = store.config.safety?.[listKey] || [];
  const idx = arr.indexOf(id);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  saveAll();
  return true;
}
function getRecentDmFailures(limit = 10) {
  const cutoff = now() - DM_FAILURE_WINDOW_MS;
  store.config.diagnostics.dmFailures = (store.config.diagnostics.dmFailures || []).filter(item => Number(item.ts || 0) >= cutoff);
  return store.config.diagnostics.dmFailures.slice(-limit).reverse();
}
function recordDmFailure(userId, reason) {
  store.config.diagnostics.dmFailures ||= [];
  store.config.diagnostics.dmFailures.push({ id: uid('dmfail'), userId: String(userId || ''), reason: String(reason || 'DM fehlgeschlagen').slice(0, 250), ts: now() });
  if (store.config.diagnostics.dmFailures.length > 250) store.config.diagnostics.dmFailures = store.config.diagnostics.dmFailures.slice(-250);
  saveAll();
}
function clearDmFailureForUser(userId) {
  const before = (store.config.diagnostics.dmFailures || []).length;
  store.config.diagnostics.dmFailures = (store.config.diagnostics.dmFailures || []).filter(item => item.userId !== String(userId));
  if ((store.config.diagnostics.dmFailures || []).length !== before) saveAll();
}
function hasConflictingOpenSanction(userId, source = null, relatedWeek = null, relatedCategory = null, relatedTermId = null) {
  return store.sanctions.items.some(item => item.userId === userId && !item.paid && !['bezahlt','storniert'].includes(item.status)
    && (!source || item.source === source)
    && (!relatedWeek || item.relatedWeek === relatedWeek)
    && (!relatedCategory || item.relatedCategory === relatedCategory)
    && (!relatedTermId || item.relatedTermId === relatedTermId));
}
function recordRollbackAction(action) {
  const entry = { id: uid('undo'), createdAt: now(), expiresAt: now() + (30 * 60 * 1000), used: false, ...action };
  store.sessions.rollbackStack.push(entry);
  if (store.sessions.rollbackStack.length > 100) store.sessions.rollbackStack = store.sessions.rollbackStack.slice(-100);
  saveAll();
  const existing = undoExpiryTimers.get(entry.id);
  if (existing) clearTimeout(existing);
  undoExpiryTimers.set(entry.id, setTimeout(() => {
    const current = (store.sessions.rollbackStack || []).find(item => item.id === entry.id);
    if (!current || current.used) return;
    current.used = true;
    current.usedAt = now();
    current.useReason = 'expired';
    saveAll();
  }, Math.max(1000, Number(entry.expiresAt || 0) - now())));
  return entry;
}
function getRollbackActionById(undoId) {
  return (store.sessions.rollbackStack || []).find(item => item.id === undoId) || null;
}
async function applyRollbackAction(guild, undoId, actorId) {
  const entry = getRollbackActionById(undoId);
  if (!entry) return { ok: false, message: 'Rollback nicht gefunden.' };
  if (entry.used || Number(entry.expiresAt || 0) <= now()) return { ok: false, message: 'Rollback ist abgelaufen oder bereits genutzt.' };
  entry.used = true;
  entry.usedAt = now();
  entry.usedBy = actorId || null;
  if (entry.kind === 'sanction_created') {
    const sanction = store.sanctions.items.find(item => item.id === entry.sanctionId);
    if (!sanction) return { ok: false, message: 'Sanktion nicht gefunden.' };
    sanction.status = 'storniert';
    sanction.paid = true;
    sanction.cancelledAt = now();
    sanction.cancelledBy = actorId || null;
    suppressAutoSanctionFromSanction(sanction, actorId || null, 'rollback_cancelled');
    saveAll();
    await updateSanctionPublicMessage(guild, sanction).catch(() => null);
    return { ok: true, message: `Sanktion ${sanction.id} wurde storniert.` };
  }
  if (entry.kind === 'absence_removed') {
    let restored = 0;
    for (const absenceId of entry.absenceIds || []) {
      const item = store.absences.items.find(x => x.id === absenceId);
      if (!item) continue;
      item.active = true;
      restored += 1;
    }
    saveAll();
    if (restored) await syncUserAcrossTerms(guild, entry.userId, { immediate: true }).catch(() => null);
    return { ok: true, message: restored ? 'Abmeldung wiederhergestellt.' : 'Keine Einträge wiederhergestellt.' };
  }
  return { ok: false, message: 'Rollback-Typ nicht unterstützt.' };
}

const CHANNEL_TYPE_CHOICES = [
  ['routen', 'Routen – Abgabe-Meldungen'],
  ['patronen', 'Patronenhülsen – Abgabe-Meldungen'],
  ['schwarzpulver', 'Schwarzpulver – Abgabe-Meldungen'],
  ['meth', 'Meth – Abgabe-Meldungen'],
  ['sanktionen', 'Sanktionen'],
  ['ausgeteilte', 'Ausgeteilte Strafen'],
  ['abmeldungen', 'Abmeldungen'],
  ['termine', 'Termine'],
  ['ankuendigungen', 'Ankündigungen'],
  ['abstimmungen', 'Abstimmungen'],
  ['statistik', 'Statistik/Berichte'],
  ['dashboard', 'Live Dashboard'],
  ['wache_dashboard', 'Wache Dashboard'],
  ['wache_reports', 'Wache Berichte'],
  ['leader_reminder', 'Leader Reminder'],
  ['lagerbestand', 'Lagerbestand Dashboard'],
  ['kasse', 'Kasse'],
  ['kassenberichte', 'Kassenberichte'],
  ['lagerberichte', 'Lagerberichte'],
  ['minimum_warning', 'Mindestbestand-Warnkanal'],
  ['public_link', 'Dashboard-Link / Public Link'],
  ['verify', 'Verifizierung'],
  ['welcome', 'Willkommen nach Verifizierung'],
  ['phone_list', 'Interne Mitglieder-Telefonliste'],
  ['family_list', 'Familienboard'],
  ['phonebook', 'Familien-Telefonbuch'],
];

function getChannelTypeLabel(type) {
  const labels = {
    routen: 'Routen – Abgabe-Meldungen für Route/Geld',
    patronen: 'Patronenhülsen – Abgabe-Meldungen',
    schwarzpulver: 'Schwarzpulver – Abgabe-Meldungen',
    meth: 'Meth – Abgabe-Meldungen für Methkisten',
    sanktionen: 'Sanktionen – offene Sanktionen/Verwaltung',
    ausgeteilte: 'Ausgeteilte Strafen – bezahlte/erteilte Strafen',
    abmeldungen: 'Abmeldungen – Abwesenheiten/Entschuldigungen',
    termine: 'Termine – Events und Zusagen',
    ankuendigungen: 'Ankündigungen – Info-Nachrichten',
    abstimmungen: 'Abstimmungen – Voting/Umfragen',
    statistik: 'Statistik – Wochenberichte & Auswertungen',
    dashboard: 'Dashboard – Hauptübersicht vom Bot',
    wache_dashboard: 'Wache Dashboard – Wache-Übersicht',
    wache_reports: 'Wache Berichte – Wache Wochenberichte',
    leader_reminder: 'Leader Reminder – Auto-Sanktionen intern',
    lagerbestand: 'Lagerbestand Dashboard – Bestände',
    kasse: 'Kasse – Live Dashboard & Buchungen',
    kassenberichte: 'Kassenberichte – automatische Monatsberichte',
    lagerberichte: 'Lagerberichte – automatische Lagerberichte',
    minimum_warning: 'Mindestbestand-Warnkanal',
    public_link: 'Dashboard-Link / Public Link',
    verify: 'Verifizierung',
    welcome: 'Willkommen nach Verifizierung',
    phone_list: 'Interne Mitglieder-Telefonliste',
    family_list: 'Familienboard',
    phonebook: 'Familien-Telefonbuch',

  };
  return labels[type] || type;
}


const INVENTORY_WEAPONS = [
  'SMG',
  'PDW',
  'Kampf PDW',
  'Karabiner',
  'Gusenberg',
  'AK',
  'Spezi',
  'ADV',
  'Sniper',
  'Pistole',
  '50er',
  'Kampfpistole',
  'Schwere Pistole',
  'Baseballschläger',
  'Machete',
  'Springmesser',
];

function ensureInventoryShape() {
  if (!store.inventory || typeof store.inventory !== 'object') store.inventory = {};
  if (!store.inventory.items || typeof store.inventory.items !== 'object') store.inventory.items = {};
  if (!('listMessage' in store.inventory)) store.inventory.listMessage = null;
}

function formatInventoryTableRows(guild, entries) {
  const rows = entries.map(([userId, entry], index) => {
    const name = String(getUserDisplay(guild, userId)).replace(/\|/g, '/').slice(0, 24);

    const weapons = INVENTORY_WEAPONS
      .map(w => {
        const amount = Number(entry?.weapons?.[w] || 0);
        return amount > 0 ? `${w}:${amount}` : null;
      })
      .filter(Boolean)
      .join(', ') || '-';

    const leichteWesten = Number(entry?.leichteWesten || 0);
    const schwereWesten = Number(entry?.schwereWesten || 0);
    const munition = Number(entry?.munition || 0);

    const updated = entry?.updatedAt
      ? `<t:${Math.floor(Number(entry.updatedAt) / 1000)}:R>`
      : '-';

    return `| ${index + 1} | ${name} | ${leichteWesten} | ${schwereWesten} | ${munition} | ${weapons} | ${updated} |`;
  });

  return [
    '| # | Name | Leicht | Schwer | Munition | Waffen | Update |',
    '|---|---|---:|---:|---:|---|---|',
    ...rows,
  ].join('\n');
}

function splitInventoryTable(tableText, maxLen = 1000) {
  const lines = String(tableText || '').split('\\n');
  const header = lines.slice(0, 2);
  const body = lines.slice(2);
  const chunks = [];
  let current = [...header];

  for (const line of body) {
    const next = [...current, line].join('\\n');
    if (next.length > maxLen && current.length > header.length) {
      chunks.push(current.join('\\n'));
      current = [...header, line];
    } else {
      current.push(line);
    }
  }

  if (current.length > header.length) chunks.push(current.join('\\n'));
  return chunks.length ? chunks : [header.join('\\n') + '\\n| - | Noch kein Eintrag | - | - | - | - | - |'];
}

function buildInventoryListEmbed(guild) {
  ensureInventoryShape();

  const entries = Object.entries(store.inventory.items || {})
    .filter(([, entry]) => entry && Number(entry.updatedAt || 0) > 0)
    .sort((a, b) => String(getUserDisplay(guild, a[0])).localeCompare(String(getUserDisplay(guild, b[0])), 'de'));

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📦 Lagerbestand Dashboard')
    .setDescription('Aktuelle Lagerbestände')
    .setFooter({
      text: `Dashboard automatisch aktualisiert • ${entries.length} Einträge • ${new Date().toLocaleTimeString('de-DE', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit'
      })} Uhr`
    })
    .setTimestamp(new Date());

  if (!entries.length) {
    embed.addFields({
      name: '📭 Keine Einträge',
      value: 'Noch niemand hat seinen Lagerbestand eingetragen.',
      inline: false,
    });

    return embed;
  }

  for (const [userId, entry] of entries.slice(0, 20)) {
    const name = getUserDisplay(guild, userId);

    const weapons = INVENTORY_WEAPONS
      .map(w => {
        const amount = Number(entry?.weapons?.[w] || 0);
        return amount > 0 ? `• ${w}: **${amount}**` : null;
      })
      .filter(Boolean);

    const leichte = Number(entry?.leichteWesten || 0);
    const schwere = Number(entry?.schwereWesten || 0);
    const muni = Number(entry?.munition || 0);

    const updated = entry?.updatedAt
      ? `<t:${Math.floor(Number(entry.updatedAt) / 1000)}:R>`
      : 'unbekannt';

    embed.addFields({
      name: `👤 ${name}`,
      value: [
        `🦺 Leichte Westen: **${leichte}**`,
        `🛡️ Schwere Westen: **${schwere}**`,
        `🔫 Munition: **${muni}**`,
        '',
        weapons.length ? weapons.join('\n') : 'Keine Waffen eingetragen',
        '',
        `🕒 Aktualisiert: ${updated}`
      ].join('\n').slice(0, 1024),
      inline: true,
    });
  }

  return embed;
}


function ensureInventoryEditorShape() {
  ensureInventoryShape();
  if (!store.sessions) store.sessions = {};
  if (!store.sessions.inventoryEditors || typeof store.sessions.inventoryEditors !== 'object') {
    store.sessions.inventoryEditors = {};
  }
}

function getInventoryEntry(userId) {
  ensureInventoryShape();
  if (!store.inventory.items[userId]) {
    const weapons = {};
    for (const weapon of INVENTORY_WEAPONS) weapons[weapon] = 0;
    store.inventory.items[userId] = {
      weapons,
      leichteWesten: 0,
      schwereWesten: 0,
      munition: 0,
      updatedAt: 0,
    };
  }
  if (!store.inventory.items[userId].weapons) store.inventory.items[userId].weapons = {};
  for (const weapon of INVENTORY_WEAPONS) {
    if (!Number.isFinite(Number(store.inventory.items[userId].weapons[weapon]))) {
      store.inventory.items[userId].weapons[weapon] = 0;
    }
  }
  if (!Number.isFinite(Number(store.inventory.items[userId].leichteWesten))) store.inventory.items[userId].leichteWesten = 0;
  if (!Number.isFinite(Number(store.inventory.items[userId].schwereWesten))) store.inventory.items[userId].schwereWesten = 0;
  if (!Number.isFinite(Number(store.inventory.items[userId].munition))) store.inventory.items[userId].munition = 0;
  return store.inventory.items[userId];
}

function getInventoryValue(entry, key) {
  if (key === 'leichte_westen') return Number(entry.leichteWesten || 0);
  if (key === 'schwere_westen') return Number(entry.schwereWesten || 0);
  if (key === 'munition') return Number(entry.munition || 0);
  return Number(entry.weapons?.[key] || 0);
}

function setInventoryValue(entry, key, value) {
  const clean = Math.max(0, Math.round(Number(value || 0)));
  if (key === 'leichte_westen') entry.leichteWesten = clean;
  else if (key === 'schwere_westen') entry.schwereWesten = clean;
  else if (key === 'munition') entry.munition = clean;
  else {
    entry.weapons ||= {};
    entry.weapons[key] = clean;
  }
  entry.updatedAt = now();
}

function getInventoryItemLabel(key) {
  if (key === 'leichte_westen') return 'Leichte Westen';
  if (key === 'schwere_westen') return 'Schwere Westen';
  if (key === 'munition') return 'Munition';
  return key;
}


function buildInventoryPrivateStatus(guild, userId) {
  ensureInventoryEditorShape();
  const entry = getInventoryEntry(userId);
  const selected = store.sessions.inventoryEditors[userId]?.selected || 'munition';
  const selectedLabel = getInventoryItemLabel(selected);
  const selectedValue = getInventoryValue(entry, selected);

  const weapons = INVENTORY_WEAPONS
    .map(w => Number(entry.weapons?.[w] || 0) > 0 ? `${w}: ${Number(entry.weapons[w])}` : null)
    .filter(Boolean)
    .join(' • ') || 'Keine Waffen';

  return [
    `**Ausgewählt:** ${selectedLabel}`,
    `**Menge:** ${selectedValue}`,
    '',
    `Leichte Westen: **${Number(entry.leichteWesten || 0)}**`,
    `Schwere Westen: **${Number(entry.schwereWesten || 0)}**`,
    `Munition: **${Number(entry.munition || 0)}**`,
    '',
    `Waffen: ${weapons}`,
  ].join('\n');
}

async function replyInventoryPrivateStatus(interaction, textPrefix = '') {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 64 }).catch(() => null);
    }

    const content = `${textPrefix}${textPrefix ? '\n\n' : ''}${buildInventoryPrivateStatus(interaction.guild, interaction.user.id)}`;

    return interaction.editReply({
      content,
      embeds: [],
      components: []
    }).catch(() => null);
  } catch (error) {
    console.error('replyInventoryPrivateStatus_ERROR', error);
  }
}

function buildInventoryEditorEmbed(guild, userId) {
  ensureInventoryEditorShape();
  const entry = getInventoryEntry(userId);
  const selected = store.sessions.inventoryEditors[userId]?.selected || 'munition';
  const selectedLabel = getInventoryItemLabel(selected);
  const selectedValue = getInventoryValue(entry, selected);

  const weapons = INVENTORY_WEAPONS
    .map(w => Number(entry.weapons?.[w] || 0) > 0 ? `${w}: **${Number(entry.weapons[w])}**` : null)
    .filter(Boolean);

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📦 Lagerbestand Bedienpanel')
    .setDescription([
      `Ausgewählt: **${selectedLabel}**`,
      `Aktuelle Menge: **${selectedValue}**`,
      '',
      `🦺 Leichte Westen: **${Number(entry.leichteWesten || 0)}**`,
      `🛡️ Schwere Westen: **${Number(entry.schwereWesten || 0)}**`,
      `🔫 Munition: **${Number(entry.munition || 0)}**`,
      '',
      weapons.length ? weapons.join('\n') : 'Noch keine Waffen eingetragen.',
    ].join('\n').slice(0, 4000));
}

function buildInventoryEditorComponents(userId) {
  ensureInventoryEditorShape();
  const selected = store.sessions.inventoryEditors[userId]?.selected || 'munition';

  const baseOptions = [
    { label: 'Leichte Westen', value: 'leichte_westen', emoji: '🦺' },
    { label: 'Schwere Westen', value: 'schwere_westen', emoji: '🛡️' },
    { label: 'Munition', value: 'munition', emoji: '🔫' },
  ];

  const weaponOptions = INVENTORY_WEAPONS.map(w => ({
    label: w,
    value: w,
    emoji: '⚔️',
  }));

  const options = [...baseOptions, ...weaponOptions].slice(0, 25).map(opt => ({
    ...opt,
    default: opt.value === selected,
  }));

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('inventory_select_item')
        .setPlaceholder('Waffe / Bestand auswählen')
        .addOptions(options)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inventory_dec_2').setLabel('-2').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('inventory_dec_1').setLabel('-1').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('inventory_reset_selected').setLabel('Zurücksetzen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('inventory_inc_1').setLabel('+1').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('inventory_inc_2').setLabel('+2').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inventory_dec_5').setLabel('-5').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('inventory_dec_10').setLabel('-10').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('inventory_spacer').setLabel('ㅤ').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('inventory_inc_5').setLabel('+5').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('inventory_inc_10').setLabel('+10').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inventory_save_close').setLabel('✅ Speichern & schließen').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('inventory_refresh_dashboard').setLabel('🔄 Dashboard aktualisieren').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function replyInventoryEditor(interaction) {
  ensureInventoryEditorShape();
  store.sessions.inventoryEditors[interaction.user.id] ||= { selected: 'munition' };
  saveAll();
  const payload = {
    embeds: [buildInventoryEditorEmbed(interaction.guild, interaction.user.id)],
    components: buildInventoryEditorComponents(interaction.user.id),
    flags: 64,
  };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function updateInventoryEditorInteraction(interaction) {
  const payload = {
    embeds: [buildInventoryEditorEmbed(interaction.guild, interaction.user.id)],
    components: buildInventoryEditorComponents(interaction.user.id),
  };
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    return interaction.update(payload);
  }
  return safeReplyOnce(interaction, { ...payload, flags: 64 });
}

async function adjustInventorySelected(interaction, delta) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 64 }).catch(() => null);
    }

    ensureInventoryEditorShape();

    const userId = interaction.user.id;
    store.sessions.inventoryEditors[userId] ||= { selected: 'munition' };

    const selected = store.sessions.inventoryEditors[userId].selected || 'munition';

    const entry = getInventoryEntry(userId);
    const current = getInventoryValue(entry, selected);

    setInventoryValue(entry, selected, current + delta);
    saveAll();

    const label = getInventoryItemLabel(selected);
    const value = getInventoryValue(entry, selected);

    await interaction.editReply({
      content: `✅ ${label} geändert auf **${value}**.\n\n${buildInventoryPrivateStatus(interaction.guild, userId)}`,
      embeds: [],
      components: []
    }).catch(() => null);

    setImmediate(() => {
      updateInventoryListMessage(interaction.guild).catch(error => console.error('INVENTORY_LIST_UPDATE_ERROR', error));
    });

  } catch (error) {
    console.error('adjustInventorySelected_ERROR', error);
  }
}

function buildInventoryPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📦 Lagerbestand Bedienpanel')
    .setDescription([
      'Wähle unten eine Waffe oder einen Bestand aus und ändere deine eigene Menge mit den Buttons.',
      '',
      'Jeder bearbeitet automatisch **seinen eigenen Bestand**.',
      'Die Bestätigung sieht nur die Person selbst.',
    ].join('\n'));
}

function buildInventoryPanelComponents() {
  const baseOptions = [
    { label: 'Leichte Westen', value: 'leichte_westen', emoji: '🦺' },
    { label: 'Schwere Westen', value: 'schwere_westen', emoji: '🛡️' },
    { label: 'Munition', value: 'munition', emoji: '🔫' },
  ];

  const weaponOptions = INVENTORY_WEAPONS.map(w => ({
    label: w,
    value: w,
    emoji: '⚔️',
  }));

  const options = [...baseOptions, ...weaponOptions].slice(0, 25);

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('inventory_select_item')
        .setPlaceholder('Waffe / Bestand auswählen')
        .addOptions(options)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inventory_dec_2').setLabel('-2').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('inventory_dec_1').setLabel('-1').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('inventory_reset_selected').setLabel('Zurücksetzen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('inventory_inc_1').setLabel('+1').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('inventory_inc_2').setLabel('+2').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inventory_dec_5').setLabel('-5').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('inventory_dec_10').setLabel('-10').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('inventory_spacer').setLabel('ㅤ').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('inventory_inc_5').setLabel('+5').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('inventory_inc_10').setLabel('+10').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('inventory_show_mine').setLabel('👤 Meinen Bestand anzeigen').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('inventory_refresh_dashboard').setLabel('🔄 Dashboard aktualisieren').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildInventoryModal(userId = null) {
  ensureInventoryShape();
  const current = userId ? store.inventory.items?.[userId] : null;
  const weapons = current?.weapons || {};
  const weaponDefault = INVENTORY_WEAPONS
    .map(w => {
      const amount = Number(weapons[w] || 0);
      return amount > 0 ? `${w}:${amount}` : null;
    })
    .filter(Boolean)
    .join(', ');

  return new ModalBuilder()
    .setCustomId('inventory_submit_modal')
    .setTitle('Lagerbestand Bedienpanel')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('weapons')
          .setLabel('Waffen + Anzahl, z. B. SMG:2, AK:1')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setValue(String(weaponDefault || '').slice(0, 1000))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('leichte_westen')
          .setLabel('Wie viele leichte Westen?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Number(current?.leichteWesten || 0)))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('schwere_westen')
          .setLabel('Wie viele schwere Westen?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Number(current?.schwereWesten || 0)))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('munition')
          .setLabel('Wie viel Munition?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(Number(current?.munition || 0)))
      )
    );
}

function parseInventoryWeapons(input) {
  const result = {};
  const raw = String(input || '').trim();
  for (const weapon of INVENTORY_WEAPONS) result[weapon] = 0;
  if (!raw) return result;

  const aliases = new Map();
  for (const weapon of INVENTORY_WEAPONS) {
    aliases.set(normalizeText(weapon), weapon);
  }
  aliases.set('karabiner', 'Karabiner');
  aliases.set('pdw', 'PDW');
  aliases.set('kampf-pdw', 'Kampf PDW');
  aliases.set('kampfpdw', 'Kampf PDW');
  aliases.set('gusenberg', 'Gusenberg');
  aliases.set('ak', 'AK');
  aliases.set('spezi', 'Spezi');
  aliases.set('adv', 'ADV');
  aliases.set('50er', '50er');
  aliases.set('fuenfziger', '50er');
  aliases.set('kampfpistole', 'Kampfpistole');
  aliases.set('schwere-pistole', 'Schwere Pistole');
  aliases.set('baseballschlaeger', 'Baseballschläger');

  const parts = raw.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/^(.+?)(?:\s*[:=x]\s*|\s+)(\d+)$/i);
    if (!m) continue;
    const nameKey = normalizeText(m[1]);
    const weapon = aliases.get(nameKey);
    if (!weapon) continue;
    const amount = Number(m[2]);
    if (Number.isFinite(amount) && amount >= 0) result[weapon] = Math.round(amount);
  }
  return result;
}

async function updateInventoryListMessage(guild) {
  ensureInventoryShape();
  const channelId = store.config.channels?.lagerbestand;
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !canBotWriteToChannel(channel)) return null;

  const payload = { embeds: [buildInventoryListEmbed(guild)] };
  if (store.inventory.listMessage?.channelId === channel.id && store.inventory.listMessage?.messageId) {
    const oldMessage = await channel.messages.fetch(store.inventory.listMessage.messageId).catch(() => null);
    if (oldMessage) {
      await safeMessageEdit(oldMessage, payload, 'inventory.list.edit').catch(() => null);
      return oldMessage;
    }
  }

  const msg = await safeChannelSend(channel, payload, 'inventory.list.send').catch(() => null);
  if (msg) {
    store.inventory.listMessage = { channelId: channel.id, messageId: msg.id, updatedAt: now() };
    saveAll();
  }
  return msg;
}

async function saveInventoryEntry(guild, userId, weapons, leichteWesten, schwereWesten, munition) {
  ensureInventoryShape();
  store.inventory.items[userId] = {
    weapons,
    leichteWesten: Math.max(0, Math.round(Number(leichteWesten || 0))),
    schwereWesten: Math.max(0, Math.round(Number(schwereWesten || 0))),
    munition: Math.max(0, Math.round(Number(munition || 0))),
    updatedAt: now(),
  };
  saveAll();
  await updateInventoryListMessage(guild).catch(error => console.error('INVENTORY_LIST_UPDATE_ERROR', error));
}

async function removeInventoryEntry(guild, userId, removedBy = 'system', reason = 'removed') {
  ensureInventoryEditorShape();
  const id = String(userId || '');
  if (!id) return { changed: false, message: 'Kein Mitglied angegeben.' };
  const existed = !!store.inventory.items?.[id];
  if (!existed) return { changed: false, message: 'Für dieses Mitglied ist kein Lagerbestand gespeichert.' };
  delete store.inventory.items[id];
  if (store.sessions?.inventoryEditors?.[id]) delete store.sessions.inventoryEditors[id];
  saveAll();
  if (guild) await updateInventoryListMessage(guild).catch(error => console.error('INVENTORY_REMOVE_DASHBOARD_UPDATE_ERROR', error));
  try {
    if (guild) await logSystemEvent(guild, '🧹 Lagerbestand entfernt', [
      `Mitglied: <@${id}> (${id})`,
      `Grund: ${reason}`,
      `Ausgeführt von: ${removedBy === 'system' ? 'System' : `<@${removedBy}>`}`,
    ], COLORS.warning);
  } catch (_) {}
  return { changed: true, message: 'Lagerbestand wurde entfernt.' };
}


// =========================================================
// FAMILIENLAGER / KASSE-LAGER-KOPPLUNG
// =========================================================
function ensureFamilyWarehouseShape() {
  ensureInventoryShape();
  if (!store.inventory.family || typeof store.inventory.family !== 'object') store.inventory.family = {};
  const f = store.inventory.family;
  if (!f.weapons || typeof f.weapons !== 'object') f.weapons = {};
  for (const weapon of INVENTORY_WEAPONS) {
    if (!Number.isFinite(Number(f.weapons[weapon]))) f.weapons[weapon] = 0;
  }
  if (!Number.isFinite(Number(f.leichteWesten))) f.leichteWesten = 0;
  if (!Number.isFinite(Number(f.schwereWesten))) f.schwereWesten = 0;
  if (!Number.isFinite(Number(f.munition))) f.munition = 0;
  if (!Array.isArray(f.movements)) f.movements = [];
  if (!f.minimums || typeof f.minimums !== 'object') f.minimums = {};
  if (typeof f.minimumWarningsEnabled !== 'boolean') f.minimumWarningsEnabled = true;
  if (!f.minimumWarningChannelId) f.minimumWarningChannelId = '';
  if (!f.lastMinimumWarnings || typeof f.lastMinimumWarnings !== 'object') f.lastMinimumWarnings = {};
  if (!f.monthReports || typeof f.monthReports !== 'object') f.monthReports = {};
  for (const item of getFamilyWarehouseItemOptions()) {
    if (!Number.isFinite(Number(f.minimums[item.key])) || Number(f.minimums[item.key]) < 0) f.minimums[item.key] = 0;
  }
  return f;
}
function getFamilyWarehouseItemOptions() {
  return [
    { key: 'munition', label: 'Munition', kind: 'munition', emoji: '🔫' },
    { key: 'leichte_westen', label: 'Leichte Westen', kind: 'vest', emoji: '🦺' },
    { key: 'schwere_westen', label: 'Schwere Westen', kind: 'vest', emoji: '🛡️' },
    ...INVENTORY_WEAPONS.map(weapon => ({ key: weapon, label: weapon, kind: 'weapon', emoji: '⚔️' })),
  ];
}
function getFamilyWarehouseItemByKey(key) {
  const raw = String(key || '');
  return getFamilyWarehouseItemOptions().find(item => item.key === raw) || resolveWarehouseItem(raw, '');
}
function getFamilyWarehouseMinimum(itemKey) {
  const f = ensureFamilyWarehouseShape();
  return Math.max(0, Math.round(Number(f.minimums?.[itemKey] || 0)));
}
function setFamilyWarehouseMinimum(itemKey, minimum) {
  const f = ensureFamilyWarehouseShape();
  const item = getFamilyWarehouseItemByKey(itemKey);
  if (!item || item.kind === 'other') throw new Error('Unbekannter Lagerartikel.');
  const min = Math.max(0, Math.round(parseNumber(minimum)));
  f.minimums[item.key] = min;
  saveAll();
  return { item, minimum: min };
}
function formatWarehouseAmountWithMinimum(itemKey, amount) {
  const min = getFamilyWarehouseMinimum(itemKey);
  const warning = min > 0 && Number(amount || 0) < min ? ' ⚠️' : '';
  return min > 0 ? `**${Number(amount || 0)}** / Min. ${min}${warning}` : `**${Number(amount || 0)}**${warning}`;
}
function resolveWarehouseItem(input, fallbackCategory = '') {
  const raw = String(input || '').trim();
  const norm = normalizeText(raw || fallbackCategory);
  if (['munition','muni','ammo'].includes(norm) || String(fallbackCategory).includes('munition')) return { key: 'munition', label: 'Munition', kind: 'munition' };
  if (['leichte-westen','leichte-weste','leicht','weste-leicht','westen'].includes(norm)) return { key: 'leichte_westen', label: 'Leichte Westen', kind: 'vest' };
  if (['schwere-westen','schwere-weste','schwer','weste-schwer'].includes(norm) || String(fallbackCategory).includes('westen')) return { key: 'schwere_westen', label: raw || 'Schwere Westen', kind: 'vest' };
  const aliases = new Map();
  for (const weapon of INVENTORY_WEAPONS) aliases.set(normalizeText(weapon), weapon);
  aliases.set('smg', 'SMG'); aliases.set('pdw', 'PDW'); aliases.set('kampf-pdw', 'Kampf PDW'); aliases.set('karabiner', 'Karabiner'); aliases.set('ak', 'AK'); aliases.set('50er', '50er'); aliases.set('fuenfziger', '50er');
  const weapon = aliases.get(norm) || INVENTORY_WEAPONS.find(w => normalizeText(w) === norm);
  if (weapon || String(fallbackCategory).includes('waffen')) return { key: weapon || raw || 'SMG', label: weapon || raw || 'Waffe', kind: 'weapon' };
  return { key: 'sonstiges', label: raw || 'Sonstiges', kind: 'other' };
}
function getFamilyWarehouseValue(item) {
  const f = ensureFamilyWarehouseShape();
  if (item.key === 'munition') return Number(f.munition || 0);
  if (item.key === 'leichte_westen') return Number(f.leichteWesten || 0);
  if (item.key === 'schwere_westen') return Number(f.schwereWesten || 0);
  if (item.kind === 'weapon') return Number(f.weapons?.[item.key] || 0);
  return 0;
}
function setFamilyWarehouseValue(item, value) {
  const f = ensureFamilyWarehouseShape();
  const clean = Math.max(0, Math.round(Number(value || 0)));
  if (item.key === 'munition') f.munition = clean;
  else if (item.key === 'leichte_westen') f.leichteWesten = clean;
  else if (item.key === 'schwere_westen') f.schwereWesten = clean;
  else if (item.kind === 'weapon') { f.weapons ||= {}; f.weapons[item.key] = clean; }
}
async function addFamilyWarehouseMovement(guild, direction, itemInput, quantity, createdBy, meta = {}) {
  const item = resolveWarehouseItem(itemInput, meta.category || '');
  if (item.kind === 'other') return null;
  const qty = Math.round(parseNumber(quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Menge muss größer als 0 sein.');
  const before = getFamilyWarehouseValue(item);
  const delta = direction === 'out' ? -qty : qty;
  if (before + delta < 0) throw new Error(`Nicht genug im Familienlager. Vorhanden: ${before} ${item.label}.`);
  setFamilyWarehouseValue(item, before + delta);
  const movement = { id: uid('wh'), direction, itemKey: item.key, itemLabel: item.label, kind: item.kind, quantity: qty, before, after: before + delta, createdBy: String(createdBy || 'system'), createdAt: now(), ...meta };
  const f = ensureFamilyWarehouseShape();
  f.movements.push(movement);
  if (f.movements.length > 1000) f.movements = f.movements.slice(-1000);
  saveAll();
  if (guild) await updateInventoryListMessage(guild).catch(() => null);
  if (guild) await checkFamilyWarehouseMinimumWarning(guild, item).catch(() => null);
  return movement;
}
async function transferFromFamilyWarehouseToMember(guild, toUserId, itemInput, quantity, createdBy, meta = {}) {
  const item = resolveWarehouseItem(itemInput, '');
  if (item.kind === 'other') throw new Error('Unbekannter Lagerartikel. Nutze z. B. SMG, Karabiner, Munition, leichte Westen oder schwere Westen.');
  const qty = Math.round(parseNumber(quantity));
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Menge muss größer als 0 sein.');
  await addFamilyWarehouseMovement(guild, 'out', item.key, qty, createdBy, { reason: meta.reason || `Übergabe an ${toUserId}`, targetUserId: String(toUserId || ''), ...meta });
  const entry = getInventoryEntry(String(toUserId));
  const current = getInventoryValue(entry, item.key);
  setInventoryValue(entry, item.key, current + qty);
  saveAll();
  if (guild) await updateInventoryListMessage(guild).catch(() => null);
  return { item, qty, toUserId };
}
function getLastWeaponPurchaseUnitPrice(itemKey) {
  ensureCashboxShape();
  const key = String(itemKey || '');
  const active = [...getCashboxActiveTransactions()].reverse();
  const tx = active.find(item => item.type === 'expense' && item.category === 'waffen_kauf' && item.warehouse?.itemKey === key && Number(item.warehouse?.unitPrice || 0) > 0);
  if (tx) return Math.round(Number(tx.warehouse.unitPrice || 0));
  const f = ensureFamilyWarehouseShape();
  const movement = [...(f.movements || [])].reverse().find(m => m.direction === 'in' && m.kind === 'weapon' && m.itemKey === key && Number(m.pricePerUnit || 0) > 0);
  return movement ? Math.round(Number(movement.pricePerUnit || 0)) : 0;
}
function buildWeaponTransferPaymentComponents(session) {
  const unitPrice = Math.max(0, Math.round(Number(session?.unitPrice || 0)));
  const disabled = unitPrice <= 0;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('warehouse_transfer_weapon_pay_confirm').setLabel('✅ Passt / Zahlung erfassen').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('warehouse_transfer_weapon_pay_edit').setLabel('✏️ Preis ändern').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('warehouse_transfer_weapon_no_pay').setLabel('❌ Ohne Zahlung übergeben').setStyle(ButtonStyle.Danger),
  )];
}
function buildWeaponTransferPaymentText(session) {
  const item = getFamilyWarehouseItemByKey(session?.itemKey);
  const qty = Math.max(0, Math.round(Number(session?.quantity || 0)));
  const unitPrice = Math.max(0, Math.round(Number(session?.unitPrice || 0)));
  const total = qty * unitPrice;
  return [
    '⚔️ **Waffen-Übergabe prüfen**',
    '',
    `Empfänger: ${session?.targetId ? `<@${session.targetId}>` : '—'}`,
    `Waffe: **${item?.label || session?.itemKey || '—'}**`,
    `Menge: **${qty}**`,
    `Einkaufspreis/Stück: **${unitPrice > 0 ? formatCurrency(unitPrice) : 'nicht gefunden'}**`,
    `Gesamt zu zahlen: **${unitPrice > 0 ? formatCurrency(total) : '—'}**`,
    '',
    unitPrice > 0 ? 'Bitte bestätigen, Preis ändern oder ohne Zahlung übergeben.' : 'Kein Einkaufspreis gefunden. Bitte Preis ändern oder ohne Zahlung übergeben.',
  ].join('\n');
}
function buildWeaponTransferPriceModal(currentPrice = 0) {
  return new ModalBuilder()
    .setCustomId('warehouse_transfer_weapon_price_modal')
    .setTitle('Waffen-Übergabe Preis ändern')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('unitPrice')
        .setLabel('Preis pro Stück')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(Math.max(0, Math.round(Number(currentPrice || 0))) || ''))
    ));
}
async function completeWarehouseTransferToMember(guild, session, createdBy, options = {}) {
  const targetId = String(session?.targetId || '');
  const itemKey = String(session?.itemKey || '');
  const qty = Math.round(Number(session?.quantity || 0));
  const item = getFamilyWarehouseItemByKey(itemKey);
  if (!targetId || !itemKey || !item) throw new Error('Übergabe unvollständig. Bitte nochmal starten.');
  if (!Number.isInteger(qty) || qty < 1 || qty > 25) throw new Error('Menge muss zwischen 1 und 25 sein.');
  const withPayment = !!options.withPayment && item.kind === 'weapon';
  const unitPrice = withPayment ? Math.round(parseNumber(options.unitPrice)) : 0;
  if (withPayment && (!Number.isFinite(unitPrice) || unitPrice <= 0)) throw new Error('Preis pro Stück muss größer als 0 sein.');
  const total = qty * unitPrice;
  if (getFamilyWarehouseValue(item) < qty) throw new Error(`Nicht genug im Familienlager. Vorhanden: ${getFamilyWarehouseValue(item)} ${item.label}, benötigt: ${qty}.`);
  const result = await transferFromFamilyWarehouseToMember(guild, targetId, item.key, qty, createdBy, {
    reason: withPayment ? `Waffen-Übergabe an ${targetId} bezahlt` : `Übergabe an ${targetId}`,
    transferPayment: withPayment,
    pricePerUnit: unitPrice || undefined,
    totalPrice: total || undefined,
  });
  let tx = null;
  if (withPayment) {
    tx = await addCashboxTransaction(guild, 'income', 'waffen_uebergabe_zahlung', total, createdBy, '', { skipDashboard: true, note: `${qty}x ${item.label} an ${targetId} zum Einkaufspreis` });
    tx.transfer = { itemKey: item.key, itemLabel: item.label, kind: item.kind, quantity: qty, targetUserId: targetId, unitPrice, totalPrice: total };
    saveAll();
  }
  if (guild) await upsertCashboxDashboardMessage(guild).catch(() => null);
  return { ...result, tx, unitPrice, total };
}
function formatFamilyWarehouseLines() {
  const f = ensureFamilyWarehouseShape();
  const weapons = INVENTORY_WEAPONS.map(w => {
    const amount = Number(f.weapons?.[w] || 0);
    const min = getFamilyWarehouseMinimum(w);
    return (amount > 0 || min > 0) ? `${w}: ${formatWarehouseAmountWithMinimum(w, amount)}` : null;
  }).filter(Boolean);
  return [
    `🔫 Munition: ${formatWarehouseAmountWithMinimum('munition', Number(f.munition || 0))}`,
    `🦺 Leichte Westen: ${formatWarehouseAmountWithMinimum('leichte_westen', Number(f.leichteWesten || 0))}`,
    `🛡️ Schwere Westen: ${formatWarehouseAmountWithMinimum('schwere_westen', Number(f.schwereWesten || 0))}`,
    weapons.length ? `⚔️ Waffen: ${weapons.join(' • ')}` : '⚔️ Waffen: —',
    `🔔 Mindestbestand-Warnungen: **${f.minimumWarningsEnabled ? 'AN' : 'AUS'}**${f.minimumWarningChannelId ? ` • <#${f.minimumWarningChannelId}>` : ''}`,
  ];
}
function getWarehouseTransferSession(userId) {
  ensureSessionShape();
  const key = String(userId || 'unknown');
  store.sessions.warehouseTransfers[key] ||= { createdAt: now(), updatedAt: now() };
  store.sessions.warehouseTransfers[key].updatedAt = now();
  return store.sessions.warehouseTransfers[key];
}
function clearWarehouseTransferSession(userId) {
  ensureSessionShape();
  delete store.sessions.warehouseTransfers[String(userId || 'unknown')];
  saveAll();
}
function getWarehouseTransferMemberOptions(guild) {
  const members = [...(guild?.members?.cache?.values?.() || [])]
    .filter(member => member && !member.user?.bot)
    .sort((a, b) => String(a.displayName || a.user?.username || '').localeCompare(String(b.displayName || b.user?.username || ''), 'de'));
  return members.map(member => ({
    label: String(member.displayName || member.user?.username || member.id).slice(0, 100),
    description: String(member.user?.username || member.id).slice(0, 100),
    value: member.id,
  }));
}
function buildWarehouseTransferMemberComponents(guild, page = 0) {
  const options = getWarehouseTransferMemberOptions(guild);
  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(options.length / pageSize) - 1);
  const cleanPage = Math.min(Math.max(Number(page) || 0, 0), maxPage);
  const shown = options.slice(cleanPage * pageSize, (cleanPage + 1) * pageSize);
  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`warehouse_transfer_member_select:${cleanPage}`)
      .setPlaceholder(`Empfänger auswählen (${cleanPage + 1}/${maxPage + 1})`)
      .addOptions(shown.length ? shown : [{ label: 'Keine Mitglieder gefunden', value: 'none', description: 'Member Cache leer' }])
  ));
  if (maxPage > 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`warehouse_transfer_member_page:${Math.max(0, cleanPage - 1)}`).setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(cleanPage <= 0),
      new ButtonBuilder().setCustomId(`warehouse_transfer_member_page:${Math.min(maxPage, cleanPage + 1)}`).setLabel('Weiter ➡️').setStyle(ButtonStyle.Secondary).setDisabled(cleanPage >= maxPage),
    ));
  }
  return rows;
}
function buildWarehouseTransferItemComponents(page = 0) {
  const items = getFamilyWarehouseItemOptions();
  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const cleanPage = Math.min(Math.max(Number(page) || 0, 0), maxPage);
  const shown = items.slice(cleanPage * pageSize, (cleanPage + 1) * pageSize);
  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`warehouse_transfer_item_select:${cleanPage}`)
      .setPlaceholder(`Artikel auswählen (${cleanPage + 1}/${maxPage + 1})`)
      .addOptions(shown.map(item => ({ label: item.label.slice(0, 100), value: item.key, emoji: item.emoji })))
  ));
  if (maxPage > 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`warehouse_transfer_item_page:${Math.max(0, cleanPage - 1)}`).setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(cleanPage <= 0),
      new ButtonBuilder().setCustomId(`warehouse_transfer_item_page:${Math.min(maxPage, cleanPage + 1)}`).setLabel('Weiter ➡️').setStyle(ButtonStyle.Secondary).setDisabled(cleanPage >= maxPage),
    ));
  }
  return rows;
}
function buildWarehouseTransferQuantityComponents() {
  const options = Array.from({ length: 25 }, (_, i) => ({ label: `${i + 1}`, value: String(i + 1) }));
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('warehouse_transfer_quantity_select')
      .setPlaceholder('Menge auswählen (max. 25)')
      .addOptions(options)
  )];
}

function buildWarehouseItemSelect(customId, placeholder = 'Lagerartikel auswählen', page = 0) {
  const items = getFamilyWarehouseItemOptions();
  const pageSize = 25;
  const maxPage = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const cleanPage = Math.min(Math.max(Number(page) || 0, 0), maxPage);
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(items.slice(cleanPage * pageSize, (cleanPage + 1) * pageSize).map(item => ({ label: item.label, value: item.key, emoji: item.emoji })))
  )];
}
function buildWarehouseMinimumModal(itemKey) {
  const item = getFamilyWarehouseItemByKey(itemKey);
  const currentMin = getFamilyWarehouseMinimum(item.key);
  return new ModalBuilder()
    .setCustomId(`warehouse_minimum_modal:${encodeURIComponent(item.key)}`)
    .setTitle(`Mindestbestand: ${item.label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('minimum')
          .setLabel('Mindestbestand (0 = deaktiviert)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(String(currentMin))
      )
    );
}
function buildWarehouseHistoryEmbed(itemKey) {
  const item = getFamilyWarehouseItemByKey(itemKey);
  const f = ensureFamilyWarehouseShape();
  const movements = (f.movements || []).filter(m => String(m.itemKey || '') === String(item.key)).slice(-15).reverse();
  const current = getFamilyWarehouseValue(item);
  const min = getFamilyWarehouseMinimum(item.key);
  const lines = movements.map(m => {
    const sign = m.direction === 'in' ? '+' : '-';
    const actor = m.createdBy && m.createdBy !== 'system' ? `<@${m.createdBy}>` : 'System';
    const target = m.targetUserId ? ` → <@${m.targetUserId}>` : '';
    const reason = m.reason ? ` • ${String(m.reason).slice(0, 80)}` : '';
    const price = m.totalPrice ? ` • ${formatCurrency(m.totalPrice)}` : '';
    return `${formatDateTime(Number(m.createdAt || now()))} | ${sign}${Number(m.quantity || 0)} | ${actor}${target}${price}${reason}`;
  });
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📜 Lager-Historie: ${item.label}`)
    .setDescription([
      `Aktuell: **${current}**`,
      `Mindestbestand: **${min || 'nicht gesetzt'}**`,
      '',
      lines.length ? lines.join('\n') : 'Noch keine Bewegungen für diesen Artikel.',
    ].join('\n'))
    .setTimestamp(new Date());
}
async function getWarehouseWarningChannel(guild) {
  const f = ensureFamilyWarehouseShape();
  const channelId = f.minimumWarningChannelId || store.config.channels?.leader_reminder || store.config.channels?.statistik || '';
  if (!channelId || !guild) return null;
  return guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
}
async function checkFamilyWarehouseMinimumWarning(guild, itemInput) {
  if (!isAutomationEnabled('warehouseMinimumWarnings')) return;
  const item = typeof itemInput === 'object' ? itemInput : getFamilyWarehouseItemByKey(itemInput);
  if (!guild || !item || item.kind === 'other') return;
  const f = ensureFamilyWarehouseShape();
  if (!f.minimumWarningsEnabled) return;
  const min = getFamilyWarehouseMinimum(item.key);
  if (min <= 0) return;
  const current = getFamilyWarehouseValue(item);
  const warnKey = String(item.key);
  if (current >= min) {
    if (f.lastMinimumWarnings?.[warnKey]) {
      delete f.lastMinimumWarnings[warnKey];
      saveAll();
    }
    return;
  }
  const state = `${current}/${min}`;
  if (f.lastMinimumWarnings?.[warnKey]?.state === state) return;
  const channel = await getWarehouseWarningChannel(guild);
  if (!channel || !canBotWriteToChannel(channel)) return;
  const roleIds = getLeadershipRoleIds().filter(Boolean);
  const ping = roleIds.map(id => `<@&${id}>`).join(' ');
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⚠️ Mindestbestand unterschritten')
    .addFields(
      { name: 'Artikel', value: item.label, inline: true },
      { name: 'Aktuell', value: String(current), inline: true },
      { name: 'Mindestbestand', value: String(min), inline: true },
    )
    .setTimestamp(new Date());
  const msg = await safeChannelSend(channel, { content: ping || undefined, embeds: [embed], allowedMentions: { roles: roleIds } }, 'warehouse.minimum.warning').catch(() => null);
  f.lastMinimumWarnings[warnKey] = { state, at: now(), messageId: msg?.id || null, channelId: channel.id };
  saveAll();
}
async function checkAllFamilyWarehouseMinimumWarnings(guild) {
  for (const item of getFamilyWarehouseItemOptions()) {
    await checkFamilyWarehouseMinimumWarning(guild, item).catch(() => null);
  }
}
function extractUserId(input) {
  const m = String(input || '').match(/\d{15,25}/);
  return m ? m[0] : null;
}

// =========================================================
// CASHBOX / FAMILIENKASSE
// =========================================================
const CASHBOX_INCOME_CATEGORIES = [
  { key: 'munition_verkauf', label: 'Munition Verkauf' },
  { key: 'waffen_verkauf', label: 'Waffen Verkauf' },
  { key: 'westen_verkauf', label: 'Westen Verkauf' },
  { key: 'sonstiges', label: 'Sonstiges' },
];
const CASHBOX_EXPENSE_CATEGORIES = [
  { key: 'waffen_kauf', label: 'Waffen Kauf' },
  { key: 'munitions_kauf', label: 'Munitions Kauf' },
  { key: 'westen_kauf', label: 'Westen Kauf' },
  { key: 'routen_einkauf', label: 'Routen Einkauf' },
  { key: 'sonstiges', label: 'Sonstiges' },
];
function ensureCashboxShape() {
  if (!store.cashbox || typeof store.cashbox !== 'object') store.cashbox = deepClone(DEFAULT_CASHBOX);
  if (!Number.isFinite(Number(store.cashbox.balance))) store.cashbox.balance = 0;
  if (!Array.isArray(store.cashbox.transactions)) store.cashbox.transactions = [];
  if (!store.cashbox.monthReports || typeof store.cashbox.monthReports !== 'object') store.cashbox.monthReports = {};
  if (!('dashboardMessage' in store.cashbox)) store.cashbox.dashboardMessage = null;
  if (!store.cashbox.settings || typeof store.cashbox.settings !== 'object') store.cashbox.settings = {};
  store.cashbox.settings.allowNegativeBalance = false;
}

function getCashboxCategories(type) {
  return type === 'expense' ? CASHBOX_EXPENSE_CATEGORIES : CASHBOX_INCOME_CATEGORIES;
}
function getCashboxCategoryLabel(type, key, customReason = '') {
  if (key === 'sonstiges' && customReason) return customReason;
  const special = { waffen_uebergabe_zahlung: 'Waffen-Übergabe Zahlung', abgabe: 'Wochenabgabe', sanktion_bezahlt: 'Sanktion bezahlt', term_trade: 'Termin Ankauf/Verkauf' };
  return special[key] || getCashboxCategories(type).find(x => x.key === key)?.label || key || 'Sonstiges';
}
function getCashboxActiveTransactions() {
  ensureCashboxShape();
  return store.cashbox.transactions.filter(tx => !tx.undone);
}
function getCashboxRangeStats(startTs, endTs) {
  const txs = getCashboxActiveTransactions().filter(tx => Number(tx.createdAt || 0) >= startTs && Number(tx.createdAt || 0) <= endTs);
  const income = txs.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const expense = txs.filter(tx => tx.type === 'expense').reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  return { txs, income, expense, profit: income - expense };
}
function getMonthStartTs(date = getTzDate()) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
}
function getMonthEndTs(date = getTzDate()) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
}
function getPreviousMonthKey(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number);
  const d = new Date(y, (m || 1) - 2, 1);
  return getMonthKey(d);
}
function recalculateCashboxBalance() {
  ensureCashboxShape();
  store.cashbox.balance = getCashboxActiveTransactions().reduce((sum, tx) => sum + (tx.type === 'income' ? 1 : -1) * Number(tx.amount || 0), 0);
  return store.cashbox.balance;
}
function formatCashboxTxLine(tx, guild = null, withDate = true) {
  const sign = tx.type === 'income' ? '+' : '-';
  const baseLabel = getCashboxCategoryLabel(tx.type, tx.category, tx.customReason);
  const who = tx.createdBy ? `<@${tx.createdBy}>` : 'System';
  const date = withDate ? `${formatDateTime(Number(tx.createdAt || now()))} | ` : '';
  let details = baseLabel;
  if (tx.warehouse) {
    const qty = Number(tx.warehouse.quantity || 0);
    const unit = Number(tx.warehouse.unitPrice || 0);
    const item = tx.warehouse.itemLabel || tx.warehouse.itemKey || '';
    details = `${getCashboxCategoryLabel(tx.type, tx.category)}: ${qty}x ${item}${unit ? ` à ${formatCurrency(unit)}` : ''}`;
    if (tx.note) details += ` • ${String(tx.note).slice(0, 80)}`;
  } else if (tx.note) {
    details += ` • ${String(tx.note).slice(0, 80)}`;
  }
  const undo = tx.undone ? ' [RÜCKGÄNGIG]' : '';
  return `${date}${sign}${formatCurrency(tx.amount)} | ${details} | ${who}${undo}`;
}
function buildCashboxDashboardEmbed(guild) {
  ensureCashboxShape();
  recalculateCashboxBalance();
  const weekStats = getCashboxRangeStats(startOfWeekTsFromWeekKey(currentWeekKey()), endOfWeekTsFromWeekKey(currentWeekKey()));
  const monthStats = getCashboxRangeStats(getMonthStartTs(), getMonthEndTs());
  const last10 = getCashboxActiveTransactions().slice(-10).reverse();
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`💰 ${getBotAppearance().cashboxTitle}`)
    .setDescription(`Aktueller Kassenstand: **${formatCurrency(store.cashbox.balance)}**`)
    .addFields(
      buildInfoField('📅 Diese Woche', [
        `Einnahmen: **+${formatCurrency(weekStats.income)}**`,
        `Ausgaben: **-${formatCurrency(weekStats.expense)}**`,
        `Gewinn/Verlust: **${weekStats.profit >= 0 ? '+' : '-'}${formatCurrency(Math.abs(weekStats.profit))}**`,
      ], true),
      buildInfoField('🗓️ Dieser Monat', [
        `Einnahmen: **+${formatCurrency(monthStats.income)}**`,
        `Ausgaben: **-${formatCurrency(monthStats.expense)}**`,
        `Gewinn/Verlust: **${monthStats.profit >= 0 ? '+' : '-'}${formatCurrency(Math.abs(monthStats.profit))}**`,
      ], true),
      buildInfoField('📜 Letzte 10 Transaktionen', last10.length ? last10.map(tx => formatCashboxTxLine(tx, guild, false)) : ['Noch keine Transaktionen.'], false),
      buildInfoField('📦 Familienlager', formatFamilyWarehouseLines(), false),
    )
    .setFooter({ text: 'Familienkasse • Einnahmen/Ausgaben über Buttons erfassen • Dashboard aktualisiert sich automatisch' })
    .setTimestamp(new Date());
}
function buildCashboxDashboardComponents() {
  const f = ensureFamilyWarehouseShape();
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('cashbox_add_income').setLabel('➕ Einnahme').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('cashbox_add_expense').setLabel('➖ Ausgabe').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cashbox_undo_last').setLabel('↩️ Rückgängig').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('warehouse_transfer').setLabel('📦 Übergabe').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('warehouse_minimum_setup').setLabel('⚙️ Mindestbestand').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('warehouse_history_open').setLabel('📜 Item-Verlauf').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('warehouse_warning_toggle').setLabel(`🔔 Warnungen ${f.minimumWarningsEnabled ? 'AUS' : 'AN'}`).setStyle(f.minimumWarningsEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
    ),
  ];
}
function buildCashboxCategorySelect(type) {
  const label = type === 'income' ? 'Einnahme' : 'Ausgabe';
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`cashbox_select_category:${type}`)
      .setPlaceholder(`${label}-Kategorie auswählen`)
      .addOptions(getCashboxCategories(type).map(cat => ({ label: cat.label, value: cat.key })))
  )];
}
function needsWarehouseDetails(type, category) {
  return ['munition_verkauf','waffen_verkauf','westen_verkauf','waffen_kauf','munitions_kauf','westen_kauf'].includes(category);
}
function isWeaponCashboxCategory(category) {
  return ['waffen_verkauf','waffen_kauf'].includes(String(category || ''));
}
function isVestCashboxCategory(category) {
  return ['westen_kauf','westen_verkauf'].includes(String(category || ''));
}
function buildCashboxItemSelect(type, category) {
  const isWeapon = isWeaponCashboxCategory(category);
  const options = isWeapon
    ? INVENTORY_WEAPONS.map(w => ({ label: w, value: w }))
    : [
        { label: 'Leichte Westen', value: 'leichte_westen', emoji: '🦺' },
        { label: 'Schwere Westen', value: 'schwere_westen', emoji: '🛡️' },
      ];
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`cashbox_select_item:${type}:${category}`)
      .setPlaceholder(isWeapon ? 'Welche Waffe?' : 'Welche Westen?')
      .addOptions(options.slice(0, 25))
  )];
}
function cashboxCategoryNeedsItemSelect(category) {
  return isWeaponCashboxCategory(category) || isVestCashboxCategory(category);
}
function getOptionalModalValue(interaction, key) {
  try { return interaction.fields.getTextInputValue(key); } catch (_) { return ''; }
}
function buildCashboxAmountModal(type, category, selectedItem = '') {
  const catLabel = getCashboxCategoryLabel(type, category);
  const encodedItem = selectedItem ? `:${encodeURIComponent(selectedItem)}` : '';
  const modal = new ModalBuilder().setCustomId(`cashbox_amount_modal:${type}:${category}${encodedItem}`).setTitle(`${type === 'income' ? 'Einnahme' : 'Ausgabe'} erfassen`);
  if (needsWarehouseDetails(type, category)) {
    const rows = [];
    if (!selectedItem) {
      rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item').setLabel('Artikel').setPlaceholder('z. B. Munition, SMG, Karabiner, leichte Westen').setStyle(TextInputStyle.Short).setRequired(!category.includes('munition'))));
    }
    rows.push(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('Menge/Stückzahl').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unitPrice').setLabel('Preis pro Stück').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(`Notiz optional (${catLabel})`).setStyle(TextInputStyle.Short).setRequired(false))
    );
    modal.addComponents(...rows);
    return modal;
  }
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('amount').setLabel('Wie viel Geld? z. B. 3000000').setStyle(TextInputStyle.Short).setRequired(true)
  ));
  if (category === 'sonstiges') {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel('Wofür?').setStyle(TextInputStyle.Short).setRequired(true)
    ));
  } else {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reason').setLabel(`Notiz optional (${catLabel})`).setStyle(TextInputStyle.Short).setRequired(false)
    ));
  }
  return modal;
}
async function addCashboxWarehouseTransaction(guild, type, category, form, createdBy) {
  ensureCashboxShape();
  const qty = Math.round(parseNumber(form.quantity));
  const unitPrice = Math.round(parseNumber(form.unitPrice));
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Menge muss größer als 0 sein.');
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error('Preis pro Stück muss größer als 0 sein.');
  const amount = qty * unitPrice;
  const itemInput = form.item || (category.includes('munition') ? 'Munition' : category.includes('westen') ? 'Schwere Westen' : '');
  const item = resolveWarehouseItem(itemInput, category);
  if (!item || item.kind === 'other') throw new Error('Unbekannter Lagerartikel.');
  recalculateCashboxBalance();
  if (type === 'expense' && !store.cashbox.settings.allowNegativeBalance && store.cashbox.balance - amount < 0) {
    throw new Error(`Nicht genug Geld in der Kasse. Aktuell: ${formatCurrency(store.cashbox.balance)}, benötigt: ${formatCurrency(amount)}.`);
  }
  const direction = type === 'expense' ? 'in' : 'out';
  // Vor dem Speichern prüfen, damit bei Verkäufen nicht erst die Kasse gebucht wird und danach das Lager fehlschlägt.
  if (direction === 'out') {
    const currentStock = getFamilyWarehouseValue(item);
    if (currentStock < qty) throw new Error(`Nicht genug im Familienlager. Vorhanden: ${currentStock} ${item.label}, benötigt: ${qty}.`);
  }
  const movement = await addFamilyWarehouseMovement(guild, direction, item.key, qty, createdBy, {
    category,
    pricePerUnit: unitPrice,
    totalPrice: amount,
    reason: form.reason || '',
  });
  const tx = await addCashboxTransaction(guild, type, category, amount, createdBy, form.reason || '', { skipDashboard: true });
  tx.warehouse = {
    movementId: movement?.id || null,
    direction,
    itemKey: item.key,
    itemLabel: item.label,
    kind: item.kind,
    quantity: qty,
    unitPrice,
  };
  tx.note = String(form.reason || '').trim().slice(0, 120);
  saveAll();
  await upsertCashboxDashboardMessage(guild).catch(error => console.error('CASHBOX_DASHBOARD_UPDATE_ERROR', error));
  return tx;
}


async function upsertCashboxDashboardMessage(guild, channel = null) {
  ensureCashboxShape();

  // Wichtig: Automatische Updates dürfen KEINE neue Dashboard-Nachricht senden.
  // Eine neue Kassen-/Lager-Nachricht wird nur erstellt, wenn der Befehl explizit
  // in einem Channel ausgeführt wurde und deshalb `channel` übergeben wird.
  const saved = store.cashbox.dashboardMessage || null;
  const channelId = channel?.id || saved?.channelId;
  if (!channelId) return null;

  const target = channel || guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!target || !canBotWriteToChannel(target)) return null;

  const payload = { embeds: [buildCashboxDashboardEmbed(guild)], components: buildCashboxDashboardComponents() };

  if (saved?.channelId === target.id && saved?.messageId) {
    const oldMessage = await target.messages.fetch(saved.messageId).catch(() => null);
    if (oldMessage) {
      await safeMessageEdit(oldMessage, payload, 'cashbox.dashboard.edit').catch(() => null);
      return oldMessage;
    }
  }

  // Ohne expliziten Setup-Befehl nicht neu posten. Dadurch gibt es beim Bot-Start
  // und bei Background-Jobs keine doppelten Kassen-Dashboards mehr.
  if (!channel) return null;

  const msg = await safeChannelSend(target, payload, 'cashbox.dashboard.send').catch(() => null);
  if (msg) {
    store.cashbox.dashboardMessage = { channelId: target.id, messageId: msg.id, updatedAt: now() };
    store.config.channels.kasse = target.id;
    saveAll();
  }
  return msg;
}
async function addCashboxTransaction(guild, type, category, amount, createdBy, customReason = '', options = {}) {
  ensureCashboxShape();
  const cleanAmount = parseNumber(amount);
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) throw new Error('Betrag muss größer als 0 sein.');
  if (!['income','expense'].includes(type)) throw new Error('Ungültiger Transaktionstyp.');
  recalculateCashboxBalance();
  if (type === 'expense' && !store.cashbox.settings.allowNegativeBalance && store.cashbox.balance - cleanAmount < 0) {
    throw new Error(`Nicht genug Geld in der Kasse. Aktuell: ${formatCurrency(store.cashbox.balance)}, benötigt: ${formatCurrency(cleanAmount)}.`);
  }
  const tx = {
    id: uid('cash'),
    type,
    category,
    customReason: String(customReason || '').trim().slice(0, 120),
    note: String(options.note || '').trim().slice(0, 120),
    externalId: String(options.externalId || '').trim().slice(0, 160),
    amount: Math.round(cleanAmount),
    createdBy: String(createdBy || 'system'),
    createdAt: now(),
    undone: false,
  };
  store.cashbox.transactions.push(tx);
  if (store.cashbox.transactions.length > 10000) store.cashbox.transactions = store.cashbox.transactions.slice(-10000);
  recalculateCashboxBalance();
  saveAll();
  if (!options.skipDashboard) await upsertCashboxDashboardMessage(guild).catch(error => console.error('CASHBOX_DASHBOARD_UPDATE_ERROR', error));
  return tx;
}

function getAbgabeCashboxAmount(category, entry) {
  const cfg = ABGABEN[category];
  if (!cfg || cfg.unit !== '$') return 0;
  return Math.max(0, Math.round(Number(entry?.amount || 0) + Number(entry?.extra || 0)));
}
function getAbgabeCashboxTransaction(entry) {
  ensureCashboxShape();
  const id = entry?.cashboxTransactionId;
  if (!id) return null;
  return store.cashbox.transactions.find(tx => tx.id === id) || null;
}
function scheduleCashboxDashboardRefresh() {
  try {
    const guild = (typeof client !== 'undefined' && client?.guilds?.cache) ? client.guilds.cache.get(GUILD_ID) : null;
    if (!guild) return;
    setImmediate(() => {
      upsertCashboxDashboardMessage(guild).catch(error => console.error('CASHBOX_DASHBOARD_UPDATE_ERROR', error));
    });
  } catch (_) {}
}
function syncAbgabeCashboxTransaction(userId, category, weekKey, entry, byId, reason = 'Abgabe aktualisiert') {
  ensureCashboxShape();
  const cfg = ABGABEN[category];
  if (!cfg || cfg.unit !== '$') return null;

  const status = String(entry?.status || '');
  const shouldBook = ['abgegeben', 'zu_spaet', 'teilabgabe'].includes(status);
  const amount = shouldBook ? getAbgabeCashboxAmount(category, entry) : 0;
  const existing = getAbgabeCashboxTransaction(entry);

  if (!shouldBook || amount <= 0) {
    if (existing && !existing.undone) {
      existing.undone = true;
      existing.undoneBy = String(byId || 'system');
      existing.undoneAt = now();
      existing.undoReason = reason || 'Abgabe zurückgesetzt/entschuldigt';
      existing.note = `${existing.note || ''}${existing.note ? ' • ' : ''}zurückgebucht`.slice(0, 120);
      recalculateCashboxBalance();
      scheduleCashboxDashboardRefresh();
    }
    entry.cashboxTransactionId = null;
    return null;
  }

  const note = `${cfg.label} ${weekKey} • <@${userId}>${Number(entry.extra || 0) > 0 ? ` • Zusatz ${formatCurrency(entry.extra)}` : ''}`;
  if (existing) {
    existing.type = 'income';
    existing.category = 'abgabe';
    existing.amount = amount;
    existing.customReason = `${cfg.label} Abgabe`;
    existing.note = note.slice(0, 120);
    existing.source = 'abgabe';
    existing.abgabe = { userId: String(userId), category, weekKey };
    existing.updatedBy = String(byId || 'system');
    existing.updatedAt = now();
    existing.undone = false;
    delete existing.undoneBy;
    delete existing.undoneAt;
    delete existing.undoReason;
    recalculateCashboxBalance();
    scheduleCashboxDashboardRefresh();
    return existing;
  }

  const tx = {
    id: uid('cash'),
    type: 'income',
    category: 'abgabe',
    customReason: `${cfg.label} Abgabe`,
    note: note.slice(0, 120),
    amount,
    createdBy: String(byId || 'system'),
    createdAt: now(),
    undone: false,
    source: 'abgabe',
    abgabe: { userId: String(userId), category, weekKey },
  };
  store.cashbox.transactions.push(tx);
  if (store.cashbox.transactions.length > 10000) store.cashbox.transactions = store.cashbox.transactions.slice(-10000);
  entry.cashboxTransactionId = tx.id;
  recalculateCashboxBalance();
  scheduleCashboxDashboardRefresh();
  return tx;
}
function reverseAbgabeCashboxTransaction(entry, byId, reason = 'Abgabe zurückgesetzt/entschuldigt') {
  ensureCashboxShape();
  const tx = getAbgabeCashboxTransaction(entry);
  if (tx && !tx.undone) {
    tx.undone = true;
    tx.undoneBy = String(byId || 'system');
    tx.undoneAt = now();
    tx.undoReason = reason;
    tx.note = `${tx.note || ''}${tx.note ? ' • ' : ''}zurückgebucht`.slice(0, 120);
    recalculateCashboxBalance();
    scheduleCashboxDashboardRefresh();
  }
  if (entry) entry.cashboxTransactionId = null;
  return tx;
}


function isMoneySanction(sanction) {
  if (!sanction) return false;
  const type = String(sanction.penaltyType || '').toLowerCase();
  return Number(sanction.amount || 0) > 0 && (type.includes('geld') || type.includes('$'));
}
function getSanctionCashboxTransaction(sanction) {
  ensureCashboxShape();
  const id = sanction?.cashboxTransactionId;
  if (!id) return null;
  return store.cashbox.transactions.find(tx => tx.id === id) || null;
}
function syncSanctionPaidCashboxTransaction(sanction, byId, reason = 'Sanktion bezahlt') {
  if (!sanction || !isMoneySanction(sanction)) return null;
  ensureCashboxShape();
  const amount = Math.max(0, Math.round(Number(sanction.amount || 0)));
  if (amount <= 0) return null;
  const existing = getSanctionCashboxTransaction(sanction);
  const note = `${sanction.catalogNo || '—'} – ${sanction.catalogLabel || 'Sanktion'} • <@${sanction.userId}>`;
  if (existing) {
    existing.type = 'income';
    existing.category = 'sanktion_bezahlt';
    existing.amount = amount;
    existing.customReason = 'Sanktion bezahlt';
    existing.note = note.slice(0, 120);
    existing.source = 'sanction';
    existing.sanction = { sanctionId: sanction.id, userId: String(sanction.userId || '') };
    existing.updatedBy = String(byId || 'system');
    existing.updatedAt = now();
    existing.undone = false;
    delete existing.undoneBy;
    delete existing.undoneAt;
    delete existing.undoReason;
    recalculateCashboxBalance();
    scheduleCashboxDashboardRefresh();
    return existing;
  }
  const tx = {
    id: uid('cash'),
    type: 'income',
    category: 'sanktion_bezahlt',
    customReason: 'Sanktion bezahlt',
    note: note.slice(0, 120),
    amount,
    createdBy: String(byId || 'system'),
    createdAt: now(),
    undone: false,
    source: 'sanction',
    sanction: { sanctionId: sanction.id, userId: String(sanction.userId || '') },
  };
  store.cashbox.transactions.push(tx);
  if (store.cashbox.transactions.length > 10000) store.cashbox.transactions = store.cashbox.transactions.slice(-10000);
  sanction.cashboxTransactionId = tx.id;
  recalculateCashboxBalance();
  scheduleCashboxDashboardRefresh();
  return tx;
}
function reverseSanctionCashboxTransaction(sanction, byId, reason = 'Sanktion storniert/gelöscht') {
  const tx = getSanctionCashboxTransaction(sanction);
  if (tx && !tx.undone) {
    tx.undone = true;
    tx.undoneBy = String(byId || 'system');
    tx.undoneAt = now();
    tx.undoReason = reason;
    tx.note = `${tx.note || ''}${tx.note ? ' • ' : ''}zurückgebucht`.slice(0, 120);
    recalculateCashboxBalance();
    scheduleCashboxDashboardRefresh();
  }
  if (sanction) sanction.cashboxTransactionId = null;
  return tx;
}

async function undoLastCashboxTransaction(guild, userId) {
  ensureCashboxShape();
  const tx = [...store.cashbox.transactions].reverse().find(item => !item.undone && item.source !== 'abgabe');
  if (!tx) return null;
  if (tx.transfer && tx.transfer.itemKey && Number(tx.transfer.quantity || 0) > 0 && tx.transfer.targetUserId) {
    const item = getFamilyWarehouseItemByKey(tx.transfer.itemKey);
    const qty = Math.round(Number(tx.transfer.quantity || 0));
    const targetId = String(tx.transfer.targetUserId || '');
    const entry = getInventoryEntry(targetId);
    const currentMemberAmount = getInventoryValue(entry, item.key);
    if (currentMemberAmount < qty) throw new Error(`Rückgängig nicht möglich: <@${targetId}> hat nur noch ${currentMemberAmount}x ${item.label}.`);
    setInventoryValue(entry, item.key, currentMemberAmount - qty);
    await addFamilyWarehouseMovement(guild, 'in', item.key, qty, userId || 'system', {
      category: tx.category,
      reason: `Rückgängig: Waffen-Übergabe Zahlung`,
      targetUserId: targetId,
      reversedCashboxTransactionId: tx.id,
    });
    if (guild) await updateInventoryListMessage(guild).catch(() => null);
  }
  if (tx.warehouse && tx.warehouse.itemKey && Number(tx.warehouse.quantity || 0) > 0) {
    const reverseDirection = tx.warehouse.direction === 'in' ? 'out' : 'in';
    await addFamilyWarehouseMovement(guild, reverseDirection, tx.warehouse.itemKey, tx.warehouse.quantity, userId || 'system', {
      category: tx.category,
      reason: `Rückgängig: ${getCashboxCategoryLabel(tx.type, tx.category, tx.customReason)}`,
      reversedCashboxTransactionId: tx.id,
    });
  }
  tx.undone = true;
  tx.undoneBy = String(userId || 'system');
  tx.undoneAt = now();
  recalculateCashboxBalance();
  saveAll();
  await upsertCashboxDashboardMessage(guild).catch(error => console.error('CASHBOX_DASHBOARD_UPDATE_ERROR', error));
  return tx;
}

function splitReportLines(lines, maxChars = 3400) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const rawLine of (lines && lines.length ? lines : ['—'])) {
    const line = String(rawLine || '—').slice(0, 900);
    const add = line.length + 1;
    if (current.length && (size + add) > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += add;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
function splitEmbedsIntoPayloads(embeds) {
  const payloads = [];
  for (let i = 0; i < embeds.length; i += 10) payloads.push({ embeds: embeds.slice(i, i + 10) });
  return payloads.length ? payloads : [{ embeds: [] }];
}
function buildCashboxMonthReportPayloads(monthKey) {
  ensureCashboxShape();
  const [year, month] = String(monthKey).split('-').map(Number);
  const monthDate = new Date(year, month - 1, 1);
  const startTs = getMonthStartTs(monthDate);
  const endTs = getMonthEndTs(monthDate);
  const stats = getCashboxRangeStats(startTs, endTs);
  const startBalance = getCashboxActiveTransactions().filter(tx => Number(tx.createdAt || 0) < startTs).reduce((sum, tx) => sum + (tx.type === 'income' ? 1 : -1) * Number(tx.amount || 0), 0);
  const endBalance = startBalance + stats.profit;
  const prevKey = getPreviousMonthKey(monthKey);
  const [py, pm] = prevKey.split('-').map(Number);
  const prevStats = getCashboxRangeStats(getMonthStartTs(new Date(py, pm - 1, 1)), getMonthEndTs(new Date(py, pm - 1, 1)));
  const diff = stats.profit - prevStats.profit;
  store.cashbox.monthReports[monthKey] = { startBalance, income: stats.income, expense: stats.expense, profit: stats.profit, endBalance, previousProfit: prevStats.profit, differenceToPrevious: diff, transactionCount: stats.txs.length, createdAt: now() };

  const categoryTotals = {};
  for (const tx of stats.txs) {
    const key = getCashboxCategoryLabel(tx.type, tx.category, tx.customReason);
    categoryTotals[key] ||= { income: 0, expense: 0, count: 0 };
    categoryTotals[key][tx.type === 'income' ? 'income' : 'expense'] += Number(tx.amount || 0);
    categoryTotals[key].count += 1;
  }
  const categoryLines = Object.entries(categoryTotals)
    .map(([name, v]) => `${name}: +${formatCurrency(v.income)} / -${formatCurrency(v.expense)} (${v.count} Buchung${v.count === 1 ? '' : 'en'})`)
    .sort();
  const biggestIncome = [...stats.txs].filter(tx => tx.type === 'income').sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0] || null;
  const biggestExpense = [...stats.txs].filter(tx => tx.type === 'expense').sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0] || null;
  const txLines = stats.txs.map(tx => formatCashboxTxLine(tx, null, true));

  const embeds = [];
  embeds.push(new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`💰 Monatsbericht Kasse • ${monthKey}`)
    .setDescription('Automatischer Monatsbericht als Discord-Embed. Alle Transaktionen werden unten in Folge-Embeds aufgelistet.')
    .addFields(
      buildInfoField('💰 Übersicht', [
        `Startbestand: **${formatCurrency(startBalance)}**`,
        `Einnahmen: **+${formatCurrency(stats.income)}**`,
        `Ausgaben: **-${formatCurrency(stats.expense)}**`,
        `Gewinn/Verlust: **${stats.profit >= 0 ? '+' : '-'}${formatCurrency(Math.abs(stats.profit))}**`,
        `Endbestand: **${formatCurrency(endBalance)}**`,
        `Transaktionen: **${stats.txs.length}**`,
      ], false),
      buildInfoField('📈 Vergleich zum Vormonat', [
        `${prevKey}: **${prevStats.profit >= 0 ? '+' : '-'}${formatCurrency(Math.abs(prevStats.profit))}**`,
        `${monthKey}: **${stats.profit >= 0 ? '+' : '-'}${formatCurrency(Math.abs(stats.profit))}**`,
        `Differenz: **${diff >= 0 ? '+' : '-'}${formatCurrency(Math.abs(diff))}**`,
      ], false),
      buildInfoField('⭐ Größte Buchungen', [
        `Einnahme: ${biggestIncome ? formatCashboxTxLine(biggestIncome, null, false) : '—'}`,
        `Ausgabe: ${biggestExpense ? formatCashboxTxLine(biggestExpense, null, false) : '—'}`,
      ], false),
      buildInfoField('🏷️ Kategorien', categoryLines.length ? categoryLines.slice(0, 12) : ['Keine Kategorien.'], false),
    )
    .setFooter({ text: 'Kassenbericht • automatisch erstellt' })
    .setTimestamp(new Date()));

  const chunks = splitReportLines(txLines.length ? txLines : ['Keine Transaktionen in diesem Monat.']);
  chunks.forEach((chunk, idx) => {
    embeds.push(new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`📜 Kassen-Transaktionen ${monthKey} • Teil ${idx + 1}/${chunks.length}`)
      .setDescription(chunk.join('\n'))
      .setFooter({ text: 'Alle Kassenbewegungen dieses Monats' }));
  });
  saveAll();
  return splitEmbedsIntoPayloads(embeds);
}
function buildCashboxMonthReportPayload(monthKey) {
  return buildCashboxMonthReportPayloads(monthKey)[0];
}
function buildCashboxMonthReportEmbed(monthKey) {
  return buildCashboxMonthReportPayload(monthKey).embeds[0];
}
async function postCashboxMonthlyReport(monthKey = getPreviousMonthKey(getMonthKey()), options = {}) {
  ensureCashboxShape();
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return null;
  if (!options.force && store.cashbox.monthReports?.[monthKey]?.postedAt) return null;
  const channelId = store.config.channels?.kassenberichte || store.config.channels?.statistik;
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !canBotWriteToChannel(channel)) return null;
  const payloads = buildCashboxMonthReportPayloads(monthKey);
  const sent = [];
  for (const payload of payloads) {
    const msg = await safeChannelSend(channel, payload, 'cashbox.monthly.report').catch(() => null);
    if (msg) sent.push(msg);
  }
  if (sent.length) {
    store.cashbox.monthReports[monthKey].postedAt = now();
    store.cashbox.monthReports[monthKey].messageId = sent[0].id;
    store.cashbox.monthReports[monthKey].messageIds = sent.map(m => m.id);
    store.cashbox.monthReports[monthKey].channelId = channel.id;
    saveAll();
  }
  return sent[0] || null;
}

async function maybePostCashboxMonthlyReport() {
  const reportCfg = ensureReportSettingsV32();
  if (!reportCfg.monthlyReportsEnabled) return null;
  const today = getTzDate();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (tomorrow.getMonth() === today.getMonth()) return null;
  return postCashboxMonthlyReport(getMonthKey(today));
}


function getWarehouseRangeMovements(startTs, endTs) {
  const f = ensureFamilyWarehouseShape();
  return (f.movements || [])
    .filter(m => !m.undone && Number(m.createdAt || 0) >= startTs && Number(m.createdAt || 0) < endTs)
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}
function formatWarehouseMovementLine(m, guild = null, withDate = true) {
  const date = withDate ? `${formatDateTime(Number(m.createdAt || now()))} | ` : '';
  const sign = m.direction === 'in' ? '+' : '-';
  const actor = m.createdBy && m.createdBy !== 'system' ? `<@${m.createdBy}>` : 'System';
  const target = m.targetUserId ? ` → <@${m.targetUserId}>` : '';
  const price = Number(m.totalPrice || 0) > 0
    ? ` | ${formatCurrency(Number(m.totalPrice || 0))}${Number(m.pricePerUnit || 0) > 0 ? ` (${formatCurrency(Number(m.pricePerUnit || 0))}/Stk.)` : ''}`
    : '';
  const reason = m.reason ? ` | ${String(m.reason).slice(0, 160)}` : '';
  return `${date}${sign}${Number(m.quantity || 0)}x ${m.itemLabel || m.itemKey}${target} | ${actor}${price}${reason}`;
}

function buildWarehouseMonthReportPayloads(monthKey) {
  const f = ensureFamilyWarehouseShape();
  const [year, month] = String(monthKey).split('-').map(Number);
  const monthDate = new Date(year, month - 1, 1);
  const startTs = getMonthStartTs(monthDate);
  const endTs = getMonthEndTs(monthDate);
  const movements = getWarehouseRangeMovements(startTs, endTs);
  const totals = {};
  let paidTotal = 0;
  for (const m of movements) {
    const key = m.itemKey || 'unbekannt';
    totals[key] ||= { label: m.itemLabel || key, inQty: 0, outQty: 0, paid: 0, count: 0 };
    if (m.direction === 'in') totals[key].inQty += Number(m.quantity || 0);
    else totals[key].outQty += Number(m.quantity || 0);
    totals[key].paid += Number(m.totalPrice || 0);
    paidTotal += Number(m.totalPrice || 0);
    totals[key].count += 1;
  }
  const itemLines = Object.values(totals)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), 'de'))
    .map(v => `${v.label}: rein ${v.inQty}x / raus ${v.outQty}x / gezahlt ${formatCurrency(v.paid)} (${v.count})`);
  const transferLines = movements.filter(m => m.targetUserId).map(m => formatWarehouseMovementLine(m, null, true));
  const allLines = movements.map(m => formatWarehouseMovementLine(m, null, true));
  const currentStockLines = formatFamilyWarehouseLines().map(line => line.replaceAll('**', ''));
  f.monthReports ||= {};
  f.monthReports[monthKey] = { movementCount: movements.length, paidTotal, itemCount: Object.keys(totals).length, transferCount: transferLines.length, createdAt: now() };

  const embeds = [];
  embeds.push(new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📦 Monatsbericht Lager • ${monthKey}`)
    .setDescription('Automatischer Monatsbericht als Discord-Embed. Alle Lagerbewegungen werden unten in Folge-Embeds aufgelistet.')
    .addFields(
      buildInfoField('📦 Übersicht', [
        `Bewegungen: **${movements.length}**`,
        `Übergaben: **${transferLines.length}**`,
        `Gezahlter/gebuchter Warenwert: **${formatCurrency(paidTotal)}**`,
        `Artikel mit Bewegung: **${Object.keys(totals).length}**`,
      ], false),
      buildInfoField('📍 Aktueller Bestand', currentStockLines.length ? currentStockLines.slice(0, 12) : ['Keine Bestände.'], false),
      buildInfoField('🏷️ Summen pro Artikel', itemLines.length ? itemLines.slice(0, 12) : ['Keine Lagerbewegungen in diesem Monat.'], false),
    )
    .setFooter({ text: 'Lagerbericht • automatisch erstellt' })
    .setTimestamp(new Date()));

  const transferChunks = splitReportLines(transferLines.length ? transferLines : ['Keine Übergaben in diesem Monat.']);
  transferChunks.forEach((chunk, idx) => {
    embeds.push(new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`📤 Lager-Übergaben ${monthKey} • Teil ${idx + 1}/${transferChunks.length}`)
      .setDescription(chunk.join('\n'))
      .setFooter({ text: 'Wohin Ware gegangen ist und welcher Wert gebucht wurde' }));
  });
  const allChunks = splitReportLines(allLines.length ? allLines : ['Keine Lagerbewegungen in diesem Monat.']);
  allChunks.forEach((chunk, idx) => {
    embeds.push(new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`📜 Alle Lagerbewegungen ${monthKey} • Teil ${idx + 1}/${allChunks.length}`)
      .setDescription(chunk.join('\n'))
      .setFooter({ text: 'Einkäufe, Verkäufe, Übergaben und Rückgänge' }));
  });
  saveAll();
  return splitEmbedsIntoPayloads(embeds);
}
function buildWarehouseMonthReportPayload(monthKey) {
  return buildWarehouseMonthReportPayloads(monthKey)[0];
}
async function postWarehouseMonthlyReport(monthKey = getPreviousMonthKey(getMonthKey()), options = {}) {
  const f = ensureFamilyWarehouseShape();
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return null;
  f.monthReports ||= {};
  if (!options.force && f.monthReports?.[monthKey]?.postedAt) return null;
  const channelId = store.config.channels?.lagerberichte || store.config.channels?.kassenberichte || store.config.channels?.statistik;
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !canBotWriteToChannel(channel)) return null;
  const payloads = buildWarehouseMonthReportPayloads(monthKey);
  const sent = [];
  for (const payload of payloads) {
    const msg = await safeChannelSend(channel, payload, 'warehouse.monthly.report').catch(() => null);
    if (msg) sent.push(msg);
  }
  if (sent.length) {
    f.monthReports[monthKey].postedAt = now();
    f.monthReports[monthKey].messageId = sent[0].id;
    f.monthReports[monthKey].messageIds = sent.map(m => m.id);
    f.monthReports[monthKey].channelId = channel.id;
    saveAll();
  }
  return sent[0] || null;
}

async function maybePostWarehouseMonthlyReport() {
  const reportCfg = ensureReportSettingsV32();
  if (!reportCfg.monthlyReportsEnabled) return null;
  const today = getTzDate();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (tomorrow.getMonth() === today.getMonth()) return null;
  return postWarehouseMonthlyReport(getMonthKey(today));
}

function resolveChannelByInput(guild, input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const id = raw.replace(/[<#>]/g, '');
  return guild.channels.cache.get(id)
    || guild.channels.cache.find(ch => ch.name === normalizeText(raw))
    || guild.channels.cache.find(ch => ch.name === raw);
}
function getCachedValue(key, ttlMs, factory) {
  const hit = quickValueCache.get(key);
  if (hit && (Date.now() - hit.ts) < ttlMs) return hit.value;
  const value = factory();
  quickValueCache.set(key, { ts: Date.now(), value });
  return value;
}
function getUserDisplay(guild, userId) {
  const key = `${guild?.id || 'noguild'}:${userId}`;
  const cached = displayNameCache.get(key);
  if (cached && (Date.now() - cached.ts) < DISPLAY_CACHE_TTL_MS) return cached.value;
  const value = guild?.members?.cache?.get(userId)?.displayName || `<@${userId}>`;
  displayNameCache.set(key, { ts: Date.now(), value });
  return value;
}

function memberHasRealRole(member, guild = null) {
  if (!member || member.user?.bot) return false;
  const everyoneId = guild?.id || member.guild?.id;
  return Boolean(member.roles?.cache?.some(role => role && role.id !== everyoneId));
}
function getRelevantGuildMembers(guild) {
  return [...(guild?.members?.cache?.values() || [])].filter(member => memberHasRealRole(member, guild));
}
function isRelevantGuildMember(guild, userId) {
  const member = guild?.members?.cache?.get(String(userId || ''));
  return memberHasRealRole(member, guild);
}
function getLeadershipMentions() {
  if (!LEADERSHIP_ROLE_IDS.length) return '';
  return LEADERSHIP_ROLE_IDS.map(roleId => `<@&${roleId}>`).join(' ');
}
async function getUsersForRoleIds(guild, roleIds) {
  await ensureGuildMembersCached(guild);
  const seen = new Set();
  const users = [];
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    for (const member of role.members.values()) {
      if (member.user.bot) continue;
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      users.push(member.user);
    }
  }
  return users;
}
async function getLeadershipUsers(guild) {
  return getUsersForRoleIds(guild, LEADERSHIP_ROLE_IDS);
}
async function getRoutenverwaltungUsers(guild) {
  return getUsersForRoleIds(guild, ROUTENVERWALTUNG_ROLE_IDS);
}
function getMonitoringChannel(guild) {
  if (!guild) return null;
  return guild.channels.cache.get(MONITORING_CHANNEL_ID) || null;
}
function getLogChannel(guild) {
  if (!guild) return null;
  return guild.channels.cache.get(LOG_CHANNEL_ID) || null;
}

async function resolveSystemTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels.cache.get(channelId);
  if (cached) return cached;
  try {
    const fetched = await guild.channels.fetch(channelId);
    return fetched || null;
  } catch (_) {
    return null;
  }
}
function canBotWriteToChannel(channel) {
  if (!channel || !channel.guild || !channel.isTextBased?.()) return false;
  try {
    const me = channel.guild.members.me;
    if (!me) return true;
    const perms = channel.permissionsFor(me);
    if (!perms) return true;
    return perms.has('ViewChannel') && perms.has('SendMessages') && perms.has('EmbedLinks');
  } catch (_) {
    return false;
  }
}
function getSuggestedWeekKeys(limit = 20) {
  const ordered = [];
  const seen = new Set();
  let pointer = currentWeekKey();
  for (let i = 0; i < Math.max(8, limit); i += 1) {
    if (!seen.has(pointer)) {
      ordered.push(pointer);
      seen.add(pointer);
    }
    pointer = previousWeekKey(pointer);
  }
  const stored = Object.keys(store.abgaben?.weeks || {}).sort((a, b) => b.localeCompare(a));
  for (const key of stored) {
    if (!seen.has(key)) {
      ordered.push(key);
      seen.add(key);
    }
  }
  return ordered.slice(0, limit);
}
function getWeekAutocompleteChoices(query = '', limit = 25) {
  const normalized = String(query || '').trim().toLowerCase();
  const keys = getSuggestedWeekKeys(40).filter(key => !normalized || key.toLowerCase().includes(normalized));
  return keys.slice(0, limit).map((key, idx) => ({
    name: idx === 0 ? `${key} (aktuell)` : key,
    value: key,
  }));
}

function getTodayKey() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE });
}
function simpleHashText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function appendAuditLog(type, actorId, targetId, details = {}) {
  ensureConfigShape();
  const entry = {
    id: uid('audit'),
    type: String(type || 'unknown').slice(0, 80),
    actorId: actorId ? String(actorId) : 'system',
    targetId: targetId ? String(targetId) : null,
    at: now(),
    details,
  };
  store.config.auditLog.push(entry);
  if (store.config.auditLog.length > 1200) store.config.auditLog = store.config.auditLog.slice(-1200);
  return entry;
}
function invalidateStatsCache(reason = 'changed') {
  ensureConfigShape();
  store.config.statsCache = { invalidatedAt: now(), reason };
}
function getCachedValue(cacheKey, ttlMs, builder) {
  ensureConfigShape();
  const bucket = store.config.statsCache || {};
  const cached = bucket[cacheKey];
  if (cached && Number(cached.expiresAt || 0) > now()) return cached.value;
  const value = builder();
  bucket[cacheKey] = { value, createdAt: now(), expiresAt: now() + ttlMs };
  store.config.statsCache = bucket;
  return value;
}
function getRecentAuditLines(limit = 8) {
  ensureConfigShape();
  const rows = (store.config.auditLog || []).slice(-limit).reverse();
  if (!rows.length) return ['Noch keine Audit-Einträge.'];
  return rows.map(row => {
    const actor = row.actorId === 'system' ? 'System' : `<@${row.actorId}>`;
    const target = row.targetId ? ` → <@${row.targetId}>` : '';
    return `• ${new Date(row.at).toLocaleString('de-DE', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${actor}${target}: **${row.type}**`;
  });
}
function getAllAbgabeWeeksIncludingArchive() {
  ensureAbgabenArchiveShape();
  return { ...(store.abgaben.archivedWeeks || {}), ...(store.abgaben.weeks || {}) };
}
function getRecentWeekKeys(limit = 4, baseWeekKey = currentWeekKey()) {
  const keys = [];
  let wk = baseWeekKey;
  for (let i = 0; i < Math.max(1, Number(limit || 4)); i += 1) {
    keys.push(wk);
    wk = previousWeekKey(wk);
  }
  return keys;
}
function getRecentAbgabeWeeks(limit = 4) {
  const all = getAllAbgabeWeeksIncludingArchive();
  const out = {};
  for (const weekKey of getRecentWeekKeys(limit)) {
    if (all[weekKey]) out[weekKey] = all[weekKey];
  }
  return out;
}
function memberHasAbgabeRole(guild, userId, category) {
  const roleIds = getAbgabeParticipantRoleIds(category);
  if (!roleIds.length) return true;
  const member = guild?.members?.cache?.get(String(userId));
  return !!member?.roles?.cache?.some(role => roleIds.includes(String(role.id)));
}
function getAbgabeCategoryStatsForUser(guild, userId, category, weekLimit = 4) {
  const cfg = getAbgabeRuntimeConfig(category);
  if (!cfg.enabled) return { enabled: false, inRole: false, total: 0, submitted: 0, partial: 0, late: 0, open: 0, excused: 0 };
  const inRole = memberHasAbgabeRole(guild, userId, category);
  if (!inRole) return { enabled: true, inRole: false, total: 0, submitted: 0, partial: 0, late: 0, open: 0, excused: 0 };
  let total = 0, submitted = 0, partial = 0, late = 0, open = 0, excused = 0;
  for (const [weekKey, week] of Object.entries(getRecentAbgabeWeeks(weekLimit))) {
    const row = week.categories?.[category]?.[userId];
    if (!row) continue;
    total += 1;
    const status = String(row.status || 'offen');
    if (['abgegeben','vorausgezahlt'].includes(status)) submitted += 1;
    else if (status === 'teilabgabe') partial += 1;
    else if (status === 'zu_spaet') { submitted += 1; late += 1; }
    else if (status === 'entschuldigt' || status === 'spaeter_abgabe') excused += 1;
    else if (['offen','warnphase','nicht_abgegeben'].includes(status)) open += 1;
    if (isLateAbgabeEntry(weekKey, category, row)) late += 1;
  }
  return { enabled: true, inRole: true, total, submitted, partial, late, open, excused };
}
function formatMemberAbgabeCategoryLine(guild, userId, category) {
  const cfg = getAbgabeRuntimeConfig(category);
  const label = ABGABEN[category]?.label || category;
  if (!cfg.enabled) return `${label}: **Nicht aktiviert**`;
  if (!memberHasAbgabeRole(guild, userId, category)) return `${label}: **Keine Daten**`;
  const st = getAbgabeCategoryStatsForUser(guild, userId, category, 4);
  if (!st.total) return `${label}: **Keine Einträge letzte 4 Wochen**`;
  return `${label}: **${st.submitted}/${st.total}** erledigt • offen ${st.open} • spät ${st.late} • teil ${st.partial}`;
}
function archiveOldAbgabeWeeks(force = false) {
  ensureConfigShape();
  ensureAbgabenArchiveShape();
  const cfg = store.config.settings.archiveConfig || {};
  if (!force && cfg.enabled === false) return { archived: 0, skipped: true };
  const keepWeeks = Math.max(4, Number(cfg.keepWeeks || 12));
  const currentMonday = weekKeyToMondayDate(currentWeekKey()).getTime();
  let archived = 0;
  for (const [weekKey, week] of Object.entries(store.abgaben.weeks || {})) {
    const ageWeeks = Math.floor((currentMonday - weekKeyToMondayDate(weekKey).getTime()) / 604800000);
    if (ageWeeks < keepWeeks) continue;
    if (week?.weeklyReportPosted === false && !force) continue;
    store.abgaben.archivedWeeks[weekKey] = { ...week, archivedAt: isoStringNow() };
    delete store.abgaben.weeks[weekKey];
    archived += 1;
  }
  store.abgaben.archiveMeta = { lastRunAt: now(), lastArchivedCount: archived, keepWeeks };
  if (archived) {
    appendAuditLog('auto_archive_abgaben', 'system', null, { archived, keepWeeks });
    invalidateStatsCache('archive');
    saveAll();
  }
  return { archived, keepWeeks };
}
function isLateAbgabeEntry(weekKey, category, entry) {
  const updated = entry?.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
  if (!updated) return false;
  return updated > abgabeDeadlineTsForWeek(weekKey, category);
}
function getBehaviorPatternForUser(guild, userId) {
  ensureConfigShape();
  if (!userId) return { sundayLastMinute: 0, lateAbgaben: 0, dmDependent: 0, termIgnored: 0, wacheAvoided: 0, modifier: 0, labels: [] };
  if (!store.config.behaviorPatterns || typeof store.config.behaviorPatterns !== 'object') store.config.behaviorPatterns = {};
  const allWeeks = getRecentAbgabeWeeks(4);
  const result = {
    sundayLastMinute: 0,
    lateAbgaben: 0,
    dmDependent: 0,
    termIgnored: 0,
    wacheAvoided: 0,
    modifier: 0,
    labels: [],
  };
  for (const [weekKey, week] of Object.entries(allWeeks)) {
    for (const category of Object.keys(ABGABEN)) {
      if (!isAbgabeEnabled(category) || !memberHasAbgabeRole(guild, userId, category)) continue;
      const entry = week.categories?.[category]?.[userId];
      if (!entry) continue;
      if (['abgegeben','zu_spaet','teilabgabe'].includes(entry.status) && isLateAbgabeEntry(weekKey, category, entry)) result.lateAbgaben += 1;
      const ts = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
      if (ts) {
        const d = tsToTzDate(ts);
        const deadline = abgabeDeadlineTsForWeek(weekKey, category);
        if (d.getDay() === 0 && ts >= deadline - (6 * 60 * 60 * 1000) && ts <= deadline) result.sundayLastMinute += 1;
      }
      if ((entry.reminders || []).length && ['abgegeben','zu_spaet','teilabgabe'].includes(entry.status)) result.dmDependent += 1;
    }
  }
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    const response = term.responses?.[userId];
    const absent = !!getAbsenceAt(userId, term.startTs, 'term');
    if (!response && !absent && !term.autoCanUsers?.[userId] && !term.autoCannotUsers?.[userId]) result.termIgnored += 1;
  }
  const wacheWeeks = store.wache?.weeks || {};
  for (const week of Object.values(wacheWeeks)) {
    const row = week.users?.[userId] || week.members?.[userId];
    if (!row && !getActiveAbsence(userId, 'wache')) result.wacheAvoided += 1;
  }
  if (result.sundayLastMinute >= 3) { result.modifier += 8; result.labels.push('oft letzte Minute'); }
  if (result.lateAbgaben >= 2) { result.modifier += 12; result.labels.push('oft verspätet'); }
  if (result.dmDependent >= 3) { result.modifier += 8; result.labels.push('reagiert oft erst nach DM'); }
  if (result.termIgnored >= 2) { result.modifier += 10; result.labels.push('Termine ignoriert'); }
  if (result.wacheAvoided >= 2) { result.modifier += 8; result.labels.push('Wache auffällig'); }
  store.config.behaviorPatterns[userId] = { ...result, updatedAt: now() };
  return result;
}
function getSanctionDecayPenaltyForUser(userId) {
  const pc = getReliabilityPointConfig();
  const sanctions = (store.sanctions.items || []).filter(x => x.userId === userId && x.status !== 'storniert');
  let penalty = 0;
  for (const s of sanctions) {
    const baseTs = Number(s.createdAtTs || s.createdAt || s.issuedAt || s.createdAtMs || 0) || (s.createdAt ? Date.parse(s.createdAt) : 0) || now();
    const ageDays = Math.max(0, Math.floor((now() - baseTs) / 86400000));
    const weight = Math.max(0.25, 1 - (ageDays / 90));
    const severity = getCatalogSeverityForSanction(s);
    const base = severity === 'schwer' ? pc.sanctionHeavy : severity === 'leicht' ? pc.sanctionLight : pc.sanctionMedium;
    penalty += base * weight;
  }
  return Math.min(pc.maxPenalty, Math.round(penalty));
}
function getDmSettings() {
  ensureConfigShape();
  return store.config.settings.dmSettings;
}
function isDmAreaEnabled(area = 'general') {
  const cfg = getDmSettings();
  return cfg.enabled !== false && cfg.areas?.[area] !== false;
}
function setDmAreaEnabled(area, enabled) {
  const cfg = getDmSettings();
  if (area === 'all') cfg.enabled = !!enabled;
  else cfg.areas[area] = !!enabled;
  saveAll();
}
function markDmStatus(userId, status, reason = '') {
  if (!userId) return;
  ensureConfigShape();
  store.config.diagnostics.dmStatus[userId] = {
    status,
    reason: String(reason || '').slice(0, 250),
    updatedAt: now(),
  };
}
function getDmStatusLabel(userId) {
  const row = store.config.diagnostics.dmStatus?.[userId];
  if (!row) return 'unbekannt';
  if (row.status === 'ok') return 'DM erreichbar';
  if (row.status === 'blocked') return 'DM blockiert';
  if (row.status === 'disabled') return 'DM deaktiviert';
  return 'unbekannt';
}
function shouldSuppressDailyDm(userId, area, noticeKey, content) {
  const cfg = getDmSettings();
  if (!cfg.dailyDedupEnabled || !userId) return false;
  const key = `${getTodayKey()}:${userId}:${area}:${noticeKey || simpleHashText(content)}`;
  store.config.diagnostics.dmDailySends ||= {};
  if (store.config.diagnostics.dmDailySends[key]) return true;
  store.config.diagnostics.dmDailySends[key] = now();
  const cutoff = now() - (3 * 24 * 60 * 60 * 1000);
  for (const [k, ts] of Object.entries(store.config.diagnostics.dmDailySends)) {
    if (Number(ts || 0) < cutoff) delete store.config.diagnostics.dmDailySends[k];
  }
  return false;
}
function addDmActionButtons(payload, area = 'general', noticeKey = '') {
  const cfg = getDmSettings();
  if (!cfg.buttonsEnabled) return payload;
  const base = typeof payload === 'string' ? { content: payload } : { ...(payload || {}) };
  const safeArea = String(area || 'general').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'general';
  const safeKey = simpleHashText(noticeKey || base).slice(0, 16);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dm_ack:${safeArea}:${safeKey}`).setLabel('✅ Ich habe es gesehen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dm_problem:${safeArea}:${safeKey}`).setLabel('⚠️ Problem melden').setStyle(ButtonStyle.Secondary),
  );
  base.components = [...(base.components || []), row];
  return base;
}
async function notifyDmFallback(user, area, reason, content) {
  const guild = client.guilds.cache.get(GUILD_ID);
  const channel = getLogChannel(guild);
  if (!channel) return;
  const leaderMentions = getLeadershipRoleIds().map(id => `<@&${id}>`).join(' ');
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('📭 DM konnte nicht zugestellt werden')
    .addFields(
      buildInfoField('Mitglied', [user?.id ? `<@${user.id}>` : 'Unbekannt'], true),
      buildInfoField('Bereich', [area || 'general'], true),
      buildInfoField('Status', [reason || 'DM blockiert/deaktiviert'], false),
    )
    .setFooter({ text: 'DM-Fallback • Leader/Admin bitte ggf. manuell informieren' })
    .setTimestamp(new Date());
  await safeChannelSend(channel, { content: leaderMentions || undefined, embeds: [embed] }, 'dm.fallback.log').catch(() => null);
}
async function sendDM(user, content, options = {}) {
  const area = options.area || 'general';
  const noticeKey = options.noticeKey || '';
  try { if (!Array.isArray(store.config.diagnostics.dmFailures)) store.config.diagnostics.dmFailures = []; } catch (_) {}
  if (!user?.id) return false;
  if (!isDmAreaEnabled(area)) {
    markDmStatus(user.id, 'disabled', `Bereich ${area} deaktiviert`);
    if (options.fallback !== false) await notifyDmFallback(user, area, `DM-Bereich ${area} ist deaktiviert`, content);
    return false;
  }
  if (shouldSuppressDailyDm(user.id, area, noticeKey, content)) return true;
  const payload = addDmActionButtons(content, area, noticeKey);
  try {
    await safeUserSend(user, payload, `dm.send.${area}`);
    markDmStatus(user.id, 'ok');
    clearDmFailureForUser(user.id);
    saveAll();
    return true;
  } catch (error) {
    markDmStatus(user.id, 'blocked', error?.message || String(error));
    recordDmFailure(user.id, error?.message || error);
    console.error('DM_SEND_FAILED', user?.id, error);
    saveAll();
    if (options.fallback !== false) await notifyDmFallback(user, area, error?.message || String(error), content);
    return false;
  }
}
function abgabeDeadlineTsForWeek(weekKey, category = null) {
  if (category && typeof getAbgabeDeadlineTsForWeek === 'function') {
    return getAbgabeDeadlineTsForWeek(category, weekKey);
  }
  const monday = weekKeyToMondayDate(weekKey);
  const cfg = ABGABE_DEFAULT_DEADLINE;
  const deadline = new Date(monday);
  deadline.setDate(deadline.getDate() + (Number(cfg.deadlineDay || 7) - 1));
  deadline.setHours(Number(cfg.deadlineHour ?? 23), Number(cfg.deadlineMinute ?? 59), 0, 0);
  return deadline.getTime();
}
function abgabeTuesdayDueTsForWeek(weekKey) {
  const monday = weekKeyToMondayDate(nextWeekKey(weekKey));
  const tuesday = new Date(monday);
  tuesday.setDate(tuesday.getDate() + 1);
  tuesday.setHours(22, 0, 0, 0);
  return tuesday.getTime();
}
function buildAbgabeDMEmbed({ category, title, status, weekKey = currentWeekKey(), deadlineTs, note, reminderType = 'Erinnerung', intelligenceLines = [] }) {
  const cfg = ABGABEN[category];
  const urgency = deadlineTs ? formatDaysUntilLabel(deadlineTs) : null;
  const extraFields = Array.isArray(intelligenceLines) && intelligenceLines.filter(Boolean).length
    ? [buildInfoField('🧠 Einschätzung', intelligenceLines, false)]
    : [];
  const embed = new EmbedBuilder()
    .setColor(reminderType === 'Letzte Warnung' ? COLORS.danger : reminderType === 'Überfällig' ? COLORS.warning : COLORS.primary)
    .setTitle(`${cfg.emoji} ${title}`)
    .setDescription(note || 'Bitte prüfe deine offene Abgabe.')
    .addFields(
      buildInfoField('📦 Abgabe', [cfg.label, `Pflichtmenge: **${formatAmount(category, getAbgabeAmount(category))}**`], true),
      buildInfoField('🗓️ Woche', [weekKey, `Status: **${status}**`], true),
      buildInfoField('⏳ Frist', [deadlineTs ? formatDueLabel(deadlineTs) : 'Keine feste Frist', urgency ? `Hinweis: **${urgency}**` : null], false),
      ...extraFields,
    )
    .setFooter({ text: `Kenway Abgabe-System • ${reminderType}` })
    .setTimestamp(new Date());
  return { embeds: [embed] };
}
function buildAbgabeOpenDM(category, stage, weekKey = currentWeekKey()) {
  const note = stage === 'sun'
    ? 'Letzte Warnung. Du musst die Abgabe bis zur eingestellten Frist erledigen.'
    : stage === 'fri'
      ? 'Deine Abgabe ist noch offen. Bis morgen solltest du abgegeben haben.'
      : 'Deine Abgabe ist noch offen.';
  return buildAbgabeDMEmbed({
    category,
    title: stage === 'sun' ? 'Letzte Warnung Abgabe' : 'Abgabe Erinnerung',
    status: stage === 'sun' ? 'Letzte Warnung' : 'Noch offen',
    weekKey,
    deadlineTs: abgabeDeadlineTsForWeek(weekKey, category),
    note,
    reminderType: stage === 'sun' ? 'Letzte Warnung' : 'Erinnerung',
  });
}
function buildAbgabeOverdueDM(category, weekKey) {
  const dueTs = typeof getAbgabeAutoSanctionDueTs === 'function' ? getAbgabeAutoSanctionDueTs(category, weekKey) : abgabeTuesdayDueTsForWeek(weekKey);
  return buildAbgabeDMEmbed({
    category,
    title: 'Überfällige Abgabe',
    status: 'Überfällig',
    weekKey,
    deadlineTs: dueTs,
    note: dueTs ? `Du hast bis ${formatDateTime(dueTs)} Zeit, um eine Sanktion zu vermeiden.` : 'Deine Abgabe ist überfällig.',
    reminderType: 'Überfällig',
  });
}
function buildAbgabeRecoveryOpenDM(category, weekKey) {
  return buildAbgabeDMEmbed({
    category,
    title: 'Nachholung offen',
    status: 'Nachholung erforderlich',
    weekKey,
    deadlineTs: null,
    note: 'Deine Abgabe ist nach deiner Abmeldung noch offen und muss nachgeholt werden.',
    reminderType: 'Nachholung',
  });
}
function buildAbgabeRecoveryWarningDM(category, weekKey, finalDueTs = null) {
  return buildAbgabeDMEmbed({
    category,
    title: 'Überfällige Abgabe',
    status: 'Letzte Warnung',
    weekKey,
    deadlineTs: finalDueTs,
    note: 'Deine Abgabe ist überfällig. Mach die Abgabe jetzt, um die Sanktion zu verhindern.',
    reminderType: 'Letzte Warnung',
  });
}
function buildAbgabeFinalWarningDM(category, weekKey, finalDueTs = null) {
  return buildAbgabeDMEmbed({
    category,
    title: 'Letzte Warnung',
    status: 'Noch offen',
    weekKey,
    deadlineTs: finalDueTs,
    note: 'Letzte Warnung: Deine Abgabe ist noch offen. Mach die Abgabe, um eine Sanktion zu verhindern.',
    reminderType: 'Letzte Warnung',
  });
}
function parseGermanUntilInput(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  const year = Number(m[3]);
  const hour = m[4] != null ? Number(m[4]) : 23;
  const minute = m[5] != null ? Number(m[5]) : 59;
  const d = new Date(year, month, day, hour, minute, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getDate() !== day || d.getMonth() !== month || d.getFullYear() != year) return null;
  return d.getTime();
}
function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
function listWeeksInMonth(monthKey) {
  const result = [];
  for (const weekKey of Object.keys(store.abgaben.weeks).sort()) {
    const monday = weekKeyToMondayDate(weekKey);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const mondayMonth = getMonthKey(monday);
    const sundayMonth = getMonthKey(sunday);
    if (mondayMonth === monthKey || sundayMonth === monthKey) result.push(weekKey);
  }
  return result;
}
function getRelevantMonthKeysForWeek(weekKey) {
  const monday = weekKeyToMondayDate(weekKey);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return [...new Set([getMonthKey(monday), getMonthKey(sunday)])];
}
// =========================================================
// STORAGE ENSURE HELPERS
// =========================================================
function ensureAbgabenArchiveShape() {
  if (!store.abgaben || typeof store.abgaben !== 'object') store.abgaben = deepClone(DEFAULT_ABGABEN);
  if (!store.abgaben.weeks || typeof store.abgaben.weeks !== 'object') store.abgaben.weeks = {};
  if (!store.abgaben.monthReports || typeof store.abgaben.monthReports !== 'object') store.abgaben.monthReports = {};
  if (!store.abgaben.archivedWeeks || typeof store.abgaben.archivedWeeks !== 'object') store.abgaben.archivedWeeks = {};
  if (!store.abgaben.archiveMeta || typeof store.abgaben.archiveMeta !== 'object') store.abgaben.archiveMeta = { lastRunAt: 0, lastArchivedCount: 0 };
}
function ensureWeek(weekKey) {
  ensureAbgabenArchiveShape();
  if (!store.abgaben.weeks[weekKey]) {
    store.abgaben.weeks[weekKey] = {
      createdAt: isoStringNow(),
      weekKey,
      categories: {},
      weeklyReportPosted: false,
      monthAccumulatedFor: [],
    };
  }
  const week = store.abgaben.weeks[weekKey];
  if (!week.categories || typeof week.categories !== 'object') week.categories = {};
  for (const key of Object.keys(ABGABEN)) {
    if (!week.categories[key] || typeof week.categories[key] !== 'object') {
      week.categories[key] = {};
    }
  }
  return week;
}
function ensureAbgabeEntry(weekKey, category, userId) {
  const week = ensureWeek(weekKey);
  if (!week.categories || typeof week.categories !== 'object') week.categories = {};
  if (!week.categories[category] || typeof week.categories[category] !== 'object') {
    week.categories[category] = {};
  }
  if (!week.categories[category][userId]) {
    week.categories[category][userId] = {
      userId,
      status: 'offen',
      amount: 0,
      extra: 0,
      prepaidWeeks: 0,
      updatedAt: null,
      updatedBy: null,
      note: '',
      reminders: [],
      carryFromWeek: null,
      followUp: null,
      sanctionIssued: false,
      history: [],
    };
  }
  return week.categories[category][userId];
}
function ensureMonthReport(monthKey) {
  ensureAbgabenArchiveShape();
  if (!store.abgaben.monthReports || typeof store.abgaben.monthReports !== 'object') {
    store.abgaben.monthReports = {};
  }
  if (!store.abgaben.monthReports[monthKey]) {
    store.abgaben.monthReports[monthKey] = {
      monthKey,
      createdAt: isoStringNow(),
      weeks: [],
      posted: false,
      users: {},
    };
  }
  return store.abgaben.monthReports[monthKey];
}
function logEntryHistory(entry, action, meta = {}) {
  entry.history ||= [];
  entry.history.push({ at: isoStringNow(), action, ...meta });
}
// =========================================================
// ABSENCE HELPERS
// =========================================================
function cleanupAbsences() {
  let changed = false;
  for (const item of store.absences.items) {
    if (item.active && item.untilTs <= now()) {
      item.active = false;
      changed = true;
    }
  }
  if (changed) saveAll();
}
function matchesAbsenceScope(item, scope = 'all') {
  const appliesTo = item.appliesTo || 'all';
  if (scope === 'term') return appliesTo === 'all' || appliesTo === 'term_only';
  if (scope === 'abgabe') return appliesTo === 'all' || appliesTo === 'abgabe' || appliesTo === 'abgabe_only';
  if (scope === 'wache') return appliesTo === 'all' || appliesTo === 'wache' || appliesTo === 'wache_only';
  return appliesTo === 'all';
}
function getActiveAbsence(userId, scope = 'all') {
  cleanupAbsences();
  return store.absences.items.find(item => item.userId === userId && item.active && item.untilTs > now() && matchesAbsenceScope(item, scope)) || null;
}
function getAbsenceAt(userId, ts, scope = 'all') {
  cleanupAbsences();
  return store.absences.items
    .filter(item => item.userId === userId && item.active && matchesAbsenceScope(item, scope))
    .find(item => item.startTs <= ts && item.untilTs > ts) || null;
}
function absenceDurationDays(absence) {
  return absence ? daysBetween(absence.startTs, absence.untilTs) : 0;
}
function isUserFullyExcusedForWeek(userId, weekKey) {
  const weekStart = startOfWeekTsFromWeekKey(weekKey);
  const weekEnd = endOfWeekTsFromWeekKey(weekKey);
  const requiredDays = getAbgabeAbsenceExcuseDays();
  if (requiredDays <= 0) return false;
  return store.absences.items.some(item => {
    if (item.userId !== userId || !item.active || !matchesAbsenceScope(item, 'abgabe')) return false;
    const overlapStart = Math.max(item.startTs, weekStart);
    const overlapEnd = Math.min(item.untilTs, weekEnd);
    if (overlapEnd <= overlapStart) return false;
    const overlapDays = daysBetween(overlapStart, overlapEnd);
    return overlapDays >= requiredDays;
  });
}
function isUserAbsentOnDeadline(userId, weekKey) {
  const monday = weekKeyToMondayDate(weekKey);
  const sunday2359 = new Date(monday);
  sunday2359.setDate(sunday2359.getDate() + 6);
  sunday2359.setHours(23, 59, 0, 0);
  return getAbsenceAt(userId, sunday2359.getTime(), 'abgabe');
}
function createAbsence(userId, days, reason, createdBy, appliesTo = 'all') {
  const item = {
    id: uid('abs'),
    userId,
    days,
    startTs: now(),
    untilTs: addDaysTs(now(), Number(days)),
    active: true,
    reason: reason || '',
    createdBy,
    createdAt: isoStringNow(),
    appliesTo,
  };
  store.absences.items.push(item);
  saveAll();
  return item;
}
function createAbsenceUntil(userId, untilTs, reason, createdBy, appliesTo = 'all') {
  const durationDays = Math.max(1, Math.ceil((untilTs - now()) / (24 * 60 * 60 * 1000)));
  const item = {
    id: uid('abs'),
    userId,
    days: durationDays,
    startTs: now(),
    untilTs,
    active: true,
    reason: reason || '',
    createdBy,
    createdAt: isoStringNow(),
    customUntil: true,
    appliesTo,
  };
  store.absences.items.push(item);
  saveAll();
  return item;
}

function createAbsenceRange(userId, fromTs, untilTs, reason, createdBy, appliesTo = 'all') {
  const cleanFrom = Number(fromTs || now());
  const cleanUntil = Number(untilTs || 0);
  const durationDays = Math.max(1, Math.ceil((cleanUntil - cleanFrom) / (24 * 60 * 60 * 1000)));
  const item = {
    id: uid('abs'),
    userId,
    days: durationDays,
    startTs: cleanFrom,
    fromTs: cleanFrom,
    untilTs: cleanUntil,
    active: true,
    reason: reason || '',
    createdBy,
    createdAt: isoStringNow(),
    customRange: true,
    appliesTo,
  };
  store.absences.items.push(item);
  saveAll();
  return item;
}

function markAbgabeExcusesForAbsence(guild, absence, byId, note = null) {
  const requiredDays = getAbgabeAbsenceExcuseDays();
  if (!absence || requiredDays <= 0 || Number(absence.days || 0) < requiredDays) return;
  if (!note) note = `Ab ${requiredDays} Tage abgemeldet`;
  const start = Number(absence.startTs || absence.fromTs || now());
  const end = Number(absence.untilTs || 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const touchedWeeks = new Set();
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end) {
    touchedWeeks.add(getWeekKey(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  touchedWeeks.add(getWeekKey(new Date(end)));
  for (const weekKey of touchedWeeks) {
    for (const category of getEnabledAbgabeKeys()) {
      if (guild && !isUserRequiredForAbgabeWeek(guild, absence.userId, category, weekKey, { reason: 'absence-excuse' })) continue;
      markExcused(absence.userId, category, weekKey, byId, note);
    }
  }
}
function createTodayTermOnlyAbsence(userId, reason, createdBy) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const item = {
    id: uid('abs'),
    userId,
    days: 1,
    startTs: now(),
    untilTs: end.getTime(),
    active: true,
    reason: reason || 'Nur für Termin heute',
    createdBy,
    createdAt: isoStringNow(),
    appliesTo: 'term_only',
    termOnlyToday: true,
  };
  store.absences.items.push(item);
  saveAll();
  return item;
}
function reopenCurrentWeekAbgabenIfNeeded(guild, userId, byId = 'system') {
  const weekKey = currentWeekKey();
  let changed = false;
  const fullyExcused = isUserFullyExcusedForWeek(userId, weekKey);
  for (const category of getEnabledAbgabeKeys()) {
    if (!isUserRequiredForAbgabeWeek(guild, userId, category, weekKey, { reason: 'absence-reopen' })) continue;
    const entry = ensureAbgabeEntry(weekKey, category, userId);
    if (['abgegeben', 'zu_spaet', 'nicht_abgegeben'].includes(entry.status)) continue;
    if (fullyExcused) continue;
    const prepay = guild ? findPrepaymentSource(userId, category, weekKey) : null;
    if (prepay) {
      if (entry.status !== 'vorausgezahlt' || entry.carryFromWeek !== prepay.sourceWeekKey) {
        entry.status = 'vorausgezahlt';
        entry.carryFromWeek = prepay.sourceWeekKey;
        entry.amount = getAbgabeAmount(category, weekKey);
        entry.note = `Vorausgezahlt aus ${prepay.sourceWeekKey}`;
        entry.updatedAt = isoStringNow();
        entry.updatedBy = byId;
        entry.followUp = null;
        logEntryHistory(entry, 'reopened_prepaid_after_absence_removed', { byId, sourceWeekKey: prepay.sourceWeekKey });
        changed = true;
      }
      continue;
    }

    const shouldReopen = ['entschuldigt', 'warnphase', 'spaeter_abgabe', 'offen', 'vorausgezahlt'].includes(entry.status);
    if (!shouldReopen) continue;

    if (entry.status !== 'offen' || entry.note !== 'Abmeldung entfernt' || entry.carryFromWeek || entry.followUp || entry.sanctionIssued) {
      entry.status = 'offen';
      entry.note = 'Abmeldung entfernt';
      entry.updatedAt = isoStringNow();
      entry.updatedBy = byId;
      entry.followUp = null;
      entry.carryFromWeek = null;
      entry.sanctionIssued = false;
      logEntryHistory(entry, 'reopened_after_absence_removed', { byId });
      changed = true;
    }
  }
  if (changed) saveAll();
  return changed;
}
function removeActiveAbsence(userId, options = {}) {
  const scope = options.scope || 'any';
  let changed = false;
  const removedItems = [];
  const stoppedAt = now();
  for (const item of store.absences.items) {
    if (item.userId !== userId || !item.active) continue;
    if (scope === 'general' && (item.appliesTo || 'all') !== 'all') continue;
    if (scope === 'term_only' && (item.appliesTo || 'all') !== 'term_only') continue;
    item.active = false;
    item.stoppedAt = stoppedAt;
    if (Number(item.untilTs || 0) > stoppedAt) item.untilTs = stoppedAt;
    removedItems.push(item);
    changed = true;
  }
  if (changed) saveAll();
  return { changed, removedItems };
}
async function syncUserAcrossTerms(guild, userId, options = {}) {
  if (!guild || !userId) return;
  const immediate = options.immediate !== false;
  const forceTodayTermOnly = !!options.forceTodayTermOnly;
  let changed = false;
  for (const term of store.terms.items) {
    if (term.kind !== 'term' || term.closed) continue;
    if (!term.announcementPosted || !term.messageId) continue;
    term.responses ||= {};
    term.autoCannotUsers ||= {};
    term.autoCanUsers ||= {};
    const alwaysCanIds = new Set(getTermAlwaysCanUserIds(term));
    const wasResponse = term.responses[userId];
    const wasAutoCannot = !!term.autoCannotUsers[userId];
    const wasAutoCan = !!term.autoCanUsers[userId];

    if (alwaysCanIds.has(userId)) {
      term.responses[userId] = 'can';
      term.autoCanUsers[userId] = true;
      delete term.autoCannotUsers[userId];
    } else {
      const absentForTerm = !!getAbsenceAt(userId, term.startTs, 'term');
      if (absentForTerm || (forceTodayTermOnly && isSameDayTs(term.startTs, now()))) {
        term.responses[userId] = 'cannot';
        term.autoCannotUsers[userId] = true;
        delete term.autoCanUsers[userId];
      } else if (term.autoCannotUsers[userId]) {
        delete term.autoCannotUsers[userId];
        if (term.responses[userId] === 'cannot') delete term.responses[userId];
      }
    }

    if (
      wasResponse !== term.responses[userId] ||
      wasAutoCannot !== !!term.autoCannotUsers[userId] ||
      wasAutoCan !== !!term.autoCanUsers[userId]
    ) {
      changed = true;
      await updateTermAnnouncementMessage(guild, term, immediate);
    }
  }
  if (changed) saveAll();
}
function buildAbsenceStatusEmbed(guild, userId = null) {
  cleanupAbsences();
  const active = store.absences.items
    .filter(item => item.active && item.untilTs > now())
    .filter(item => !userId || item.userId === userId)
    .sort((a, b) => a.untilTs - b.untilTs);
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle('Aktive Abmeldungen');
  if (!active.length) return embed.setDescription(userId ? 'Du hast aktuell keine aktive Abmeldung.' : 'Es gibt aktuell keine aktiven Abmeldungen.');
  const lines = active.slice(0, 40).map(item => {
    const scope = item.appliesTo === 'term_only' ? 'Nur Termin' : 'Alle Bereiche';
    const who = guild ? `<@${item.userId}>` : item.userId;
    return `• ${who} | bis ${formatDateTime(item.untilTs)} | ${scope}${item.reason ? ` | Grund: ${item.reason}` : ''}`;
  });
  return embed.setDescription(lines.join('\n').slice(0, 4000));
}

function getAbgabeShiftDays(category, weekKey = null) {
  ensureConfigShape();
  const cfg = store.config.settings?.abgabenConfig?.[category] || {};
  return Math.max(0, Number(cfg.shiftDays ?? cfg.moveDays ?? 0));
}

// =========================================================
// ABGABEN HELPERS
// =========================================================
function isMemberEligibleForAbgabe(member, category) {
  const roleIds = getAbgabeParticipantRoleIds(category);
  return roleIds.length ? member.roles.cache.some(role => roleIds.includes(String(role.id))) : true;
}
function getMembersForAbgabe(guild, category) {
  return [...guild.members.cache.values()]
    .filter(member => !member.user.bot)
    .filter(member => isMemberEligibleForAbgabe(member, category))
    .filter(member => !isLeadershipDutyExempt(member))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
}

function ensureAbgabeRequiredSnapshotShape(weekKey) {
  const week = ensureWeek(weekKey);
  if (!week.requiredMembers || typeof week.requiredMembers !== 'object') week.requiredMembers = {};
  return week.requiredMembers;
}
function getAbgabeRoleReceivedTs(member, category) {
  if (!member) return null;
  return getRoleReceivedTsForCategory(member, category) || null;
}
function isMemberRequiredForAbgabeWeek(member, category, weekKey) {
  if (!member || member.user?.bot) return false;
  if (!isMemberEligibleForAbgabe(member, category)) return false;
  if (isLeadershipDutyExempt(member)) return false;
  const roleIds = getAbgabeParticipantRoleIds(category);
  if (!roleIds.length) return true;
  const receivedTs = getAbgabeRoleReceivedTs(member, category);
  if (!receivedTs) return false;
  // Sicherheit: Wer die Rolle erst während/nach dieser Woche bekommen hat,
  // zählt erst ab der nächsten vollen Woche. So gibt es keine rückwirkenden Abgaben/Sanktionen.
  return Number(receivedTs) < startOfWeekTsFromWeekKey(weekKey);
}
function isAbgabeWeekClosed(weekKey) {
  // Nur abgeschlossene/vergangene Wochen bleiben eingefroren.
  // Die aktuelle Woche bleibt offen und synchronisiert weiter mit der Live-Rollenliste.
  try {
    return weekKeyToMondayDate(weekKey).getTime() < weekKeyToMondayDate(currentWeekKey()).getTime();
  } catch (_) {
    return true;
  }
}
function getLiveRequiredMembersForActiveAbgabeWeek(guild, category) {
  return getMembersForAbgabe(guild, category)
    .filter(member => !member.user?.bot)
    .filter(member => isMemberEligibleForAbgabe(member, category))
    .filter(member => !isLeadershipDutyExempt(member));
}
function buildAbgabeRequiredSnapshot(guild, category, weekKey, reason = 'auto') {
  const bucket = ensureAbgabeRequiredSnapshotShape(weekKey);
  const members = isAbgabeWeekClosed(weekKey)
    ? getMembersForAbgabe(guild, category).filter(member => isMemberRequiredForAbgabeWeek(member, category, weekKey))
    : getLiveRequiredMembersForActiveAbgabeWeek(guild, category);
  bucket[category] = {
    createdAt: isoStringNow(),
    createdTs: now(),
    updatedAt: isoStringNow(),
    updatedTs: now(),
    frozen: isAbgabeWeekClosed(weekKey),
    reason,
    userIds: [...new Set(members.map(member => member.id))],
    roleReceivedTs: Object.fromEntries(members.map(member => [member.id, getAbgabeRoleReceivedTs(member, category) || 0])),
  };
  return bucket[category];
}
function syncActiveAbgabeRequiredSnapshot(guild, category, weekKey, reason = 'active-sync') {
  if (isAbgabeWeekClosed(weekKey)) return getAbgabeRequiredSnapshot(guild, category, weekKey, { reason });
  const bucket = ensureAbgabeRequiredSnapshotShape(weekKey);
  const liveMembers = getLiveRequiredMembersForActiveAbgabeWeek(guild, category);
  const liveIds = [...new Set(liveMembers.map(member => member.id))];
  const existing = bucket[category] && Array.isArray(bucket[category].userIds) ? bucket[category] : null;
  const oldIds = existing ? existing.userIds.map(String) : [];
  const changed = !existing || oldIds.length !== liveIds.length || oldIds.some(id => !liveIds.includes(id));
  if (!changed) return existing;
  bucket[category] = {
    ...(existing || {}),
    createdAt: existing?.createdAt || isoStringNow(),
    createdTs: existing?.createdTs || now(),
    updatedAt: isoStringNow(),
    updatedTs: now(),
    frozen: false,
    reason,
    userIds: liveIds,
    roleReceivedTs: Object.fromEntries(liveMembers.map(member => [member.id, getAbgabeRoleReceivedTs(member, category) || 0])),
  };
  saveAll();
  return bucket[category];
}
function getAbgabeRequiredSnapshot(guild, category, weekKey, options = {}) {
  const create = options.create !== false;
  const bucket = ensureAbgabeRequiredSnapshotShape(weekKey);
  if (!isAbgabeWeekClosed(weekKey)) {
    if (!create && (!bucket[category] || !Array.isArray(bucket[category].userIds))) return { userIds: [], createdAt: null, missing: true };
    return syncActiveAbgabeRequiredSnapshot(guild, category, weekKey, options.reason || 'active-sync');
  }
  if (!bucket[category] || !Array.isArray(bucket[category].userIds)) {
    if (!create) return { userIds: [], createdAt: null, missing: true };
    return buildAbgabeRequiredSnapshot(guild, category, weekKey, options.reason || 'auto');
  }
  bucket[category].frozen = true;
  return bucket[category];
}
function getRequiredMembersForAbgabe(guild, category, weekKey, options = {}) {
  const snapshot = getAbgabeRequiredSnapshot(guild, category, weekKey, options);
  const ids = Array.isArray(snapshot.userIds) ? snapshot.userIds : [];
  return ids
    .map(id => guild?.members?.cache?.get(id))
    .filter(Boolean)
    .filter(member => isMemberEligibleForAbgabe(member, category))
    .filter(member => !isLeadershipDutyExempt(member))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
}
function isUserRequiredForAbgabeWeek(guild, userId, category, weekKey, options = {}) {
  const member = guild?.members?.cache?.get(String(userId));
  if (member && isLeadershipDutyExempt(member)) return false;
  const snapshot = getAbgabeRequiredSnapshot(guild, category, weekKey, options);
  return Array.isArray(snapshot.userIds) && snapshot.userIds.includes(String(userId));
}
function ensureAbgabeRequiredSnapshotsForWeek(guild, weekKey, reason = 'auto') {
  ensureWeek(weekKey);
  let changed = false;
  for (const category of getEnabledAbgabeKeysForWeek(weekKey)) {
    const bucket = ensureAbgabeRequiredSnapshotShape(weekKey);
    if (!isAbgabeWeekClosed(weekKey)) {
      syncActiveAbgabeRequiredSnapshot(guild, category, weekKey, reason || 'active-sync');
      changed = true;
      continue;
    }
    if (!bucket[category] || !Array.isArray(bucket[category].userIds)) {
      buildAbgabeRequiredSnapshot(guild, category, weekKey, reason);
      changed = true;
    } else {
      bucket[category].frozen = true;
    }
  }
  if (changed) saveAll();
  return ensureWeek(weekKey).requiredMembers || {};
}
function getCoveredWeeksByEntry(weekKey, entry) {
  const covered = [];
  let pointer = weekKey;
  for (let i = 0; i < (entry.prepaidWeeks || 0); i += 1) {
    pointer = nextWeekKey(pointer);
    covered.push(pointer);
  }
  return covered;
}
function findPrepaymentSource(userId, category, targetWeekKey) {
  const weekKeys = Object.keys(store.abgaben.weeks).sort();
  for (const weekKey of weekKeys) {
    const entry = store.abgaben.weeks[weekKey]?.categories?.[category]?.[userId];
    if (!entry?.prepaidWeeks) continue;
    const covered = getCoveredWeeksByEntry(weekKey, entry);
    if (covered.includes(targetWeekKey)) return { sourceWeekKey: weekKey, entry };
  }
  return null;
}
function calculatePrepaidWeeks(category, extraAmount) {
  const base = getAbgabeAmount(category);
  return Math.floor(Number(extraAmount || 0) / base);
}
function touchPrepaidStatusForWeek(guild, weekKey) {
  for (const category of getEnabledAbgabeKeys()) {
    for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'prepaid-touch' })) {
      const entry = ensureAbgabeEntry(weekKey, category, member.id);
      if (['abgegeben', 'zu_spaet', 'entschuldigt', 'nicht_abgegeben', 'spaeter_abgabe', 'warnphase'].includes(entry.status)) continue;
      const prepay = findPrepaymentSource(member.id, category, weekKey);
      if (prepay) {
        entry.status = 'vorausgezahlt';
        entry.carryFromWeek = prepay.sourceWeekKey;
        entry.amount = getAbgabeAmount(category, weekKey);
        entry.note = `Vorausgezahlt aus ${prepay.sourceWeekKey}`;
      }
    }
  }
}
function markExcused(userId, category, weekKey, byId, note) {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  reverseAbgabeCashboxTransaction(entry, byId, 'Abgabe entschuldigt');
  entry.status = 'entschuldigt';
  entry.updatedAt = isoStringNow();
  entry.updatedBy = byId;
  entry.note = note || 'Entschuldigt';
  entry.followUp = null;
  logEntryHistory(entry, 'excused', { byId, note });
  appendAuditLog('abgabe_entschuldigt', byId, userId, { category, weekKey, note });
  invalidateStatsCache('abgabe_excused');
  saveAll();
  try { if (typeof refreshAbgabeWeekAfterChange === "function") refreshAbgabeWeekAfterChange(client.guilds.cache.get(GUILD_ID), weekKey, category); } catch(e) {}
  return entry;
}
function clearAbgabe(userId, category, weekKey, byId) {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  reverseAbgabeCashboxTransaction(entry, byId, 'Abgabe gelöscht/zurückgesetzt');
  entry.status = 'offen';
  entry.amount = 0;
  entry.extra = 0;
  entry.prepaidWeeks = 0;
  entry.updatedAt = isoStringNow();
  entry.updatedBy = byId;
  entry.note = '';
  entry.followUp = null;
  entry.sanctionIssued = false;
  entry.carryFromWeek = null;
  logEntryHistory(entry, 'cleared', { byId });
  appendAuditLog('abgabe_zurueckgesetzt', byId, userId, { category, weekKey });
  invalidateStatsCache('abgabe_clear');
  saveAll();
  try { if (typeof refreshAbgabeWeekAfterChange === "function") refreshAbgabeWeekAfterChange(client.guilds.cache.get(GUILD_ID), weekKey, category); } catch(e) {}
  return entry;
}
function applyAbgabe(userId, category, totalAmount, weekKey, byId, status = 'abgegeben', note = '') {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  const cfg = ABGABEN[category];
  const amountNum = Number(totalAmount || 0);
  const requiredAmount = getAbgabeAmount(category, weekKey);
  const extra = Math.max(0, amountNum - requiredAmount);
  const deadlineTs = getAbgabeDeadlineTsForWeek(category, weekKey);
  const effectiveStatus = (status === 'abgegeben' && deadlineTs && now() > deadlineTs) ? 'zu_spaet' : status;
  entry.status = effectiveStatus;
  entry.amount = Math.min(amountNum, requiredAmount) || requiredAmount;
  entry.extra = extra;
  entry.prepaidWeeks = calculatePrepaidWeeks(category, extra);
  entry.updatedAt = isoStringNow();
  entry.updatedBy = byId;
  entry.note = note || (effectiveStatus === 'zu_spaet' && status === 'abgegeben' ? 'Nach Frist abgegeben' : '');
  entry.followUp = null;
  entry.sanctionIssued = false;
  logEntryHistory(entry, 'apply', { byId, totalAmount: amountNum, status: effectiveStatus, requestedStatus: status, note, prepaidWeeks: entry.prepaidWeeks });
  appendAuditLog('abgabe_eingetragen', byId, userId, { category, weekKey, amount: amountNum, status: effectiveStatus, requestedStatus: status, prepaidWeeks: entry.prepaidWeeks });
  syncAbgabeCashboxTransaction(userId, category, weekKey, entry, byId, 'Abgabe eingetragen/aktualisiert');
  invalidateStatsCache('abgabe_apply');
  saveAll();
  try { if (typeof refreshAbgabeWeekAfterChange === "function") refreshAbgabeWeekAfterChange(client.guilds.cache.get(GUILD_ID), weekKey, category); } catch(e) {}
  return entry;
}
function addExtraAbgabe(userId, category, extraOnly, weekKey, byId) {
  const cfg = ABGABEN[category];
  return applyAbgabe(userId, category, getAbgabeAmount(category, weekKey) + Number(extraOnly || 0), weekKey, byId, 'abgegeben', 'Mit Zusatz');
}

function applyPartialAbgabe(userId, category, partialAmount, weekKey, byId, note = 'Teilabgabe') {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  const amount = Math.max(0, Number(partialAmount || 0));
  const required = getAbgabeAmount(category, weekKey);
  entry.amount = Math.min(amount, required);
  entry.extra = 0;
  entry.prepaidWeeks = 0;
  entry.status = amount >= required ? 'abgegeben' : 'teilabgabe';
  entry.partialAmount = entry.amount;
  entry.requiredAmount = required;
  entry.updatedAt = isoStringNow();
  entry.updatedBy = byId;
  entry.note = amount >= required ? 'Teilabgabe erfüllt Pflichtmenge' : note;
  entry.followUp = null;
  entry.sanctionIssued = false;
  logEntryHistory(entry, 'partial', { byId, partialAmount: amount, required });
  appendAuditLog('teilabgabe_eingetragen', byId, userId, { category, weekKey, amount, required, status: entry.status });
  syncAbgabeCashboxTransaction(userId, category, weekKey, entry, byId, 'Teilabgabe eingetragen/aktualisiert');
  invalidateStatsCache('abgabe_partial');
  saveAll();
  try { if (typeof refreshAbgabeWeekAfterChange === "function") refreshAbgabeWeekAfterChange(client.guilds.cache.get(GUILD_ID), weekKey, category); } catch(e) {}
  return entry;
}
function markLateRecovery(userId, category, weekKey, absenceUntilTs) {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  entry.status = 'spaeter_abgabe';
  entry.updatedAt = isoStringNow();
  entry.followUp = {
    type: 'recovery_after_absence',
    firstDueTs: addDaysTs(absenceUntilTs, 3),
    finalDueTs: addDaysTs(absenceUntilTs, 5),
    lastReminderAt: 0,
    lastWarningAt: 0,
  };
  entry.note = 'Am Abgabetag abgemeldet – Nachholung nach Abmeldung';
  logEntryHistory(entry, 'followup_start', { absenceUntilTs });
  saveAll();
  try { if (typeof refreshAbgabeWeekAfterChange === "function") refreshAbgabeWeekAfterChange(client.guilds.cache.get(GUILD_ID), weekKey, category); } catch(e) {}
  return entry;
}
function markWeekOverdue(userId, category, weekKey) {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  entry.status = 'warnphase';
  entry.updatedAt = isoStringNow();
  entry.followUp = {
    type: 'overdue_after_week',
    firstDueTs: null,
    finalDueTs: null,
    phaseDeadlineTs: null,
    lastReminderAt: 0,
    lastWarningAt: 0,
  };
  logEntryHistory(entry, 'overdue_start');
  saveAll();
  try { if (typeof refreshAbgabeWeekAfterChange === "function") refreshAbgabeWeekAfterChange(client.guilds.cache.get(GUILD_ID), weekKey, category); } catch(e) {}
  return entry;
}
function getAbgabeStatusForWeek(guild, weekKey, category, userId) {
  const entry = ensureAbgabeEntry(weekKey, category, userId);
  const member = guild?.members?.cache?.get(userId) || null;
  const fullyExcused = isUserFullyExcusedForWeek(userId, weekKey);
  const lateRoleExcused = Boolean(member && isExcusedDueToLateRoleAssignment(member, category, weekKey));

  if (entry.status === 'entschuldigt' && String(entry.note || '').startsWith('Mindestens ') && String(entry.note || '').includes('Tage abgemeldet') && !fullyExcused) {
    entry.status = 'offen';
    entry.note = '';
    entry.followUp = null;
    entry.sanctionIssued = false;
    entry.updatedAt = isoStringNow();
  }

  const isPendingAbgabeState = ['offen', 'warnphase', 'spaeter_abgabe', 'nicht_abgegeben', 'teilabgabe'].includes(entry.status);
  if (isPendingAbgabeState && fullyExcused) {
    entry.status = 'entschuldigt';
    entry.note = `Mindestens ${getAbgabeAbsenceExcuseDays()} Tage abgemeldet`;
    entry.followUp = null;
    entry.sanctionIssued = false;
    entry.updatedAt = isoStringNow();
  }
  if (isPendingAbgabeState && lateRoleExcused) {
    entry.status = 'entschuldigt';
    entry.note = 'Rolle ab Mittwoch erhalten';
    entry.followUp = null;
    entry.sanctionIssued = false;
    entry.updatedAt = isoStringNow();
  }
  if (entry.status === 'offen') {
    const prepay = findPrepaymentSource(userId, category, weekKey);
    if (prepay) {
      entry.status = 'vorausgezahlt';
      entry.amount = getAbgabeAmount(category);
      entry.carryFromWeek = prepay.sourceWeekKey;
      entry.note = `Vorausgezahlt aus ${prepay.sourceWeekKey}`;
    }
  }
  return entry;
}
function simplifyAbgabeNote(entry) {
  if (entry.status === 'vorausgezahlt' && entry.carryFromWeek) return `aus ${entry.carryFromWeek}`;
  const note = String(entry.note || '').trim();
  if (!note) return '';
  const normalized = note.toLowerCase();
  if (normalized.includes('mindestens 5 tage') || normalized.includes('ab 5 tage')) return '5+ Tage';
  if (normalized.includes('rolle ab mittwoch')) return 'Mi-Rolle';
  if (normalized.includes('manuell')) return 'manuell';
  if (normalized.includes('vorausgezahlt')) return 'vorausgezahlt';
  return note.length > 22 ? `${note.slice(0, 22)}…` : note;
}
function createAbgabeLine(guild, category, entry, userId) {
  const display = getUserDisplay(guild, userId);
  const total = Number(entry.amount || 0) + Number(entry.extra || 0);
  let amountText = '';
  if (total > 0) {
    amountText = ` — ${formatAmount(category, entry.amount || 0)}`;
    if (entry.extra > 0) amountText += ` + ${formatAmount(category, entry.extra)}`;
  }
  const shortNote = simplifyAbgabeNote(entry);
  const note = shortNote ? ` (${shortNote})` : '';
  return `${display}${amountText}${note}`;
}
function buildCompactMemberBlock(title, emoji, rows, maxVisible = 999) {
  const count = rows.length;
  const valueLines = [];
  if (!count) {
    valueLines.push('—');
  } else {
    // Alle Mitglieder anzeigen. Discord begrenzt einzelne Embed-Felder auf 1024 Zeichen;
    // clampFieldValue schützt nur vor einem technischen Fehler, aber es wird kein "+ weitere" mehr versteckt.
    valueLines.push(...rows.slice(0, maxVisible).map(line => `• ${line}`));
  }
  return {
    name: `${emoji} ${title} (${count})`,
    value: clampFieldValue(valueLines.join('\n') || '—'),
    inline: false,
  };
}
async function buildStatusEmbeds(guild, weekKey, onlyCategory = null) {
  // Status/Übersicht darf nicht durch die Wochen-Aktivierungsbremse leer werden.
  // Beispiel: Abgabe wurde nachträglich wieder aktiviert/Frist verschoben → Panel ist aktiv,
  // aber getEnabledAbgabeKeysForWeek() kann für alte/aktuelle Wochen leer sein.
  // Für reine Anzeige/Panel-Status nutzen wir deshalb die aktuell aktivierten Arten.
  const categories = onlyCategory ? [onlyCategory] : getEnabledAbgabeKeys();
  const embeds = [];
  for (const category of categories) {
    if (!isAbgabeEnabled(category)) continue;
    const rows = {
      abgegeben: [],
      zu_spaet: [],
      entschuldigt: [],
      spaeter_abgabe: [],
      warnphase: [],
      vorausgezahlt: [],
      nicht_abgegeben: [],
      offen: [],
    };
    const members = getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'status-view' });
    for (const member of members) {
      const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
      const key = rows[entry.status] ? entry.status : 'offen';
      rows[key].push(createAbgabeLine(guild, category, entry, member.id));
    }
    const totalAmount = Object.values(ensureWeek(weekKey).categories[category]).reduce((acc, entry) => {
      return acc + Number(entry.amount || 0) + Number(entry.extra || 0);
    }, 0);
    const totalMembers = members.length;
    const warnedRows = [...rows.spaeter_abgabe, ...rows.warnphase];
    const erledigtCount = rows.abgegeben.length + rows.vorausgezahlt.length + rows.zu_spaet.length;
    const activeRelevantCount = Math.max(0, totalMembers - rows.entschuldigt.length);
    const progressPct = activeRelevantCount ? Math.round((erledigtCount / activeRelevantCount) * 100) : 100;
    const progressBars = Math.max(1, Math.round(progressPct / 10));
    const progress = `${'█'.repeat(progressBars)}${'░'.repeat(10 - progressBars)} ${progressPct}%`;
    const overviewLines = [
      `Pflicht: ${formatAmount(category, getAbgabeAmount(category, weekKey))}`,
      `Mitglieder: ${totalMembers}`,
      `Pflicht erfüllt: ${erledigtCount}`,
      `Entschuldigt: ${rows.entschuldigt.length}`,
      `Offen: ${rows.offen.length}`,
      `Warnphase: ${warnedRows.length}`,
      `Eingegangen: ${formatAmount(category, totalAmount)}`,
      `Fortschritt (pflichtig): ${progress}`,
    ];
    embeds.push(
      new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`${ABGABEN[category].emoji} ${ABGABEN[category].label} – ${weekKey}`)
        .setDescription('Vollständige Übersicht der Pflicht-Mitglieder für diese Abgabe.')
        .addFields(
          buildInfoField('📊 Überblick', overviewLines),
          buildCompactMemberBlock('Noch offen', '📭', rows.offen),
          buildCompactMemberBlock('Abgegeben', '✅', rows.abgegeben),
          buildCompactMemberBlock('Entschuldigt', '🟡', rows.entschuldigt),
          buildCompactMemberBlock('Warnphase / Nachholung', '🟠', warnedRows, 6),
          buildCompactMemberBlock('Vorausgezahlt', '🟦', rows.vorausgezahlt, 6),
          buildCompactMemberBlock('Nicht abgegeben', '❌', rows.nicht_abgegeben, 6),
        )
        .setFooter({ text: `Kurze Gründe: ${getAbgabeAbsenceExcuseDays()}+ Tage = mind. ${getAbgabeAbsenceExcuseDays()} Tage abgemeldet • Mi-Rolle = Rolle ab Mittwoch erhalten` })
    );
  }
  if (!embeds.length) {
    embeds.push(
      new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`📦 Abgaben – ${weekKey}`)
        .setDescription('Aktuell sind keine Abgabearten aktiv oder keine passende Abgabeart wurde gefunden.')
    );
  }
  return embeds;
}
function accumulateMonthFromWeek(weekKey) {
  const week = ensureWeek(weekKey);
  const monthKeys = getRelevantMonthKeysForWeek(weekKey);
  let changed = false;
  for (const monthKey of monthKeys) {
    if (week.monthAccumulatedFor.includes(monthKey)) continue;
    const month = ensureMonthReport(monthKey);
    if (!month.weeks.includes(weekKey)) month.weeks.push(weekKey);
    for (const category of getEnabledAbgabeKeysForWeek(weekKey)) {
      for (const [userId, entry] of Object.entries(week.categories?.[category] || {})) {
        if (!month.users[userId]) {
          month.users[userId] = {
            userId,
            overdueCount: 0,
            excusedCount: 0,
            perfectCount: 0,
            prepaidCount: 0,
            lateCount: 0,
            nonSubmittedCount: 0,
            categories: {},
            weeks: {},
          };
        }
        const userBlock = month.users[userId];
        userBlock.categories[category] ||= { total: 0, extra: 0 };
        userBlock.weeks[weekKey] ||= {};
        userBlock.weeks[weekKey][category] = {
          status: entry.status,
          amount: Number(entry.amount || 0),
          extra: Number(entry.extra || 0),
          note: entry.note || '',
        };
        userBlock.categories[category].total += Number(entry.amount || 0);
        userBlock.categories[category].extra += Number(entry.extra || 0);
        if (entry.status === 'warnphase') userBlock.overdueCount += 1;
        if (entry.status === 'entschuldigt') userBlock.excusedCount += 1;
        if (entry.status === 'abgegeben') userBlock.perfectCount += 1;
        if (entry.status === 'vorausgezahlt') userBlock.prepaidCount += 1;
        if (entry.status === 'zu_spaet') userBlock.lateCount += 1;
        if (entry.status === 'nicht_abgegeben') userBlock.nonSubmittedCount += 1;
      }
    }
    week.monthAccumulatedFor.push(monthKey);
    changed = true;
  }
  if (changed) saveAll();
}
function getAbgabeDeadlineTsForWeek(category, weekKey) {
  const baseCfg = getAbgabeRuntimeConfig(category);
  const override = getAbgabeTemporaryOverride(category, weekKey);
  if (override && Number.isFinite(Number(override.deadlineTs)) && Number(override.deadlineTs) > 0) {
    return Number(override.deadlineTs);
  }
  const cfg = override || baseCfg;
  const monday = weekKeyToMondayDate(weekKey);
  const deadline = new Date(monday);
  deadline.setDate(monday.getDate() + ((Number(cfg.deadlineWeekOffset || 0) * 7) + Number(cfg.deadlineDay || 7) - 1));
  deadline.setHours(Number(cfg.deadlineHour ?? 23), Number(cfg.deadlineMinute ?? 59), 0, 0);
  return deadline.getTime();
}
function formatAbgabeDeadlineForWeek(category, weekKey) {
  const override = getAbgabeTemporaryOverride(category, weekKey);
  const ts = getAbgabeDeadlineTsForWeek(category, weekKey);
  const text = formatDateTime(ts);
  return override ? `verschoben auf ${text}` : text;
}
function isAbgabeWeekFulfilledForCategory(guild, weekKey, category) {
  if (!guild || !ABGABEN[category] || !isAbgabeCategoryActiveForWeek(category, weekKey)) return true;
  const pendingStatuses = new Set(['offen', 'warnphase', 'spaeter_abgabe', 'nicht_abgegeben']);
  const members = getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'fulfillment-check' });
  if (!members.length) return true;
  for (const member of members) {
    const row = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
    if (pendingStatuses.has(String(row.status || 'offen'))) return false;
  }
  return true;
}
function getActiveAbgabeWeekForCategory(guild, category, baseWeekKey = currentWeekKey()) {
  ensureAbgabenRuntimeConfig();
  const blockingWeek = getBlockingAbgabeWeek(baseWeekKey);
  if (blockingWeek) return blockingWeek;
  const overrideWeeks = Object.entries(store.config.settings.abgabenTemporaryOverrides || {})
    .filter(([, bucket]) => bucket && bucket[category])
    .map(([weekKey]) => weekKey)
    .sort();
  for (const weekKey of overrideWeeks) {
    if (!isAbgabeCategoryActiveForWeek(category, weekKey)) continue;
    const deadlineTs = getAbgabeDeadlineTsForWeek(category, weekKey);
    // Eine verschobene Abgabe bleibt im Panel/Dashboard aktiv, solange die neue Frist noch nicht vorbei ist
    // und noch nicht alle Pflichtigen erledigt/entschuldigt sind.
    if (now() <= deadlineTs && !isAbgabeWeekFulfilledForCategory(guild, weekKey, category)) return weekKey;
  }
  return baseWeekKey;
}
function getActiveAbgabeDashboardWeek(guild, baseWeekKey = currentWeekKey()) {
  ensureAbgabenRuntimeConfig();
  const active = Object.keys(ABGABEN)
    .map(category => ({ category, weekKey: getActiveAbgabeWeekForCategory(guild, category, baseWeekKey) }))
    .filter(row => row.weekKey !== baseWeekKey)
    .sort((a, b) => getAbgabeDeadlineTsForWeek(a.category, a.weekKey) - getAbgabeDeadlineTsForWeek(b.category, b.weekKey));
  return active[0]?.weekKey || baseWeekKey;
}
function getActiveAbgabeWeekNotice(guild, baseWeekKey = currentWeekKey()) {
  const rows = Object.keys(ABGABEN)
    .map(category => ({ category, weekKey: getActiveAbgabeWeekForCategory(guild, category, baseWeekKey) }))
    .filter(row => row.weekKey !== baseWeekKey);
  if (!rows.length) return null;
  return rows.map(row => `${ABGABEN[row.category].label}: **${row.weekKey}** bis **${formatDateTime(getAbgabeDeadlineTsForWeek(row.category, row.weekKey))}**`).join('\n');
}

function buildDashboardSectionField(title) {
  return { name: `​`, value: `**${title}**`, inline: false };
}
function buildDashboardSpacerField() {
  return { name: '​', value: '​', inline: true };
}

function compactDashboardText(value, max = 18) {
  const clean = String(value ?? '—').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}
function padDashboardCell(value, width) {
  const clean = compactDashboardText(value, width);
  return clean + ' '.repeat(Math.max(0, width - clean.length));
}
function formatCompactDashboardDeadline(category, weekKey) {
  const text = formatAbgabeDeadlineForWeek(category, weekKey);
  return text
    .replace(/^verschoben auf\s+/i, 'verschoben auf ')
    .replace('Montag', 'Mo')
    .replace('Dienstag', 'Di')
    .replace('Mittwoch', 'Mi')
    .replace('Donnerstag', 'Do')
    .replace('Freitag', 'Fr')
    .replace('Samstag', 'Sa')
    .replace('Sonntag', 'So');
}
function buildDashboardAbgabenWideField(rows, weekKey) {
  const colWidth = 21;
  const cards = rows.map(detail => {
    const title = `${detail.emoji} ${detail.label}`;
    if (!detail.enabled) {
      return [
        padDashboardCell(title, colWidth),
        padDashboardCell(`Status: AUS`, colWidth),
        padDashboardCell(`Menge: ${formatAmount(detail.category, detail.amount)}`, colWidth),
        padDashboardCell(`Frist: ${formatCompactDashboardDeadline(detail.category, weekKey)}`, colWidth),
        padDashboardCell(`—`, colWidth),
        padDashboardCell(`—`, colWidth),
      ];
    }
    const openTotal = detail.counts.offen + detail.counts.nicht_abgegeben;
    return [
      padDashboardCell(title, colWidth),
      padDashboardCell(`Menge: ${formatAmount(detail.category, detail.amount)}`, colWidth),
      padDashboardCell(`Frist: ${formatCompactDashboardDeadline(detail.category, weekKey)}`, colWidth),
      padDashboardCell(`Abg.: ${detail.counts.erledigt}/${detail.counts.gesamt}`, colWidth),
      padDashboardCell(`Offen: ${openTotal} | W: ${detail.counts.warnphase}`, colWidth),
      padDashboardCell(`Nachh.: ${detail.counts.spaeter_abgabe} | Ent.: ${detail.counts.entschuldigt}`, colWidth),
      padDashboardCell(`Vor.: ${detail.counts.vorausgezahlt} | Spät: ${detail.counts.zu_spaet}`, colWidth),
    ];
  });
  const maxLines = Math.max(...cards.map(card => card.length), 0);
  const lines = [];
  for (let i = 0; i < maxLines; i += 1) {
    lines.push(cards.map(card => card[i] || ' '.repeat(colWidth)).join('  ').trimEnd());
  }
  return buildInfoField('📦 Einzelne Abgaben', ['```', ...lines, '```'], false);
}


// =========================================================
// V32 WEB-KONFIGURIERBARE STATISTIK-/BERICHTS-STEUERUNG
// =========================================================
function ensureReportSettingsV32() {
  store.config ||= {};
  store.config.settings ||= {};
  const s = store.config.settings;
  const r = s.reportSettings ||= {};
  if (typeof r.weeklyReportsEnabled !== 'boolean') r.weeklyReportsEnabled = s.reportsEnabled !== false;
  if (typeof r.monthlyReportsEnabled !== 'boolean') r.monthlyReportsEnabled = true;
  if (typeof r.waitForLatestAbgabeDeadline !== 'boolean') r.waitForLatestAbgabeDeadline = true;
  if (!['wait_latest','split_due'].includes(String(r.abgabeShiftMode||''))) r.abgabeShiftMode = r.waitForLatestAbgabeDeadline ? 'wait_latest' : 'split_due';
  r.weeklyReportHour = Math.max(0, Math.min(23, Number.isFinite(Number(r.weeklyReportHour)) ? Number(r.weeklyReportHour) : 12));
  r.weeklyReportMinute = Math.max(0, Math.min(59, Number.isFinite(Number(r.weeklyReportMinute)) ? Number(r.weeklyReportMinute) : 0));
  r.monthlyReportDay = Math.max(1, Math.min(28, Number.isFinite(Number(r.monthlyReportDay)) ? Number(r.monthlyReportDay) : 1));
  r.monthlyReportHour = Math.max(0, Math.min(23, Number.isFinite(Number(r.monthlyReportHour)) ? Number(r.monthlyReportHour) : 12));
  r.monthlyReportMinute = Math.max(0, Math.min(59, Number.isFinite(Number(r.monthlyReportMinute)) ? Number(r.monthlyReportMinute) : 0));
  s.reportsEnabled = !!r.weeklyReportsEnabled || !!r.monthlyReportsEnabled;
  s.weeklyReportsEnabled = !!r.weeklyReportsEnabled;
  s.monthlyReportsEnabled = !!r.monthlyReportsEnabled;
  s.waitForLatestAbgabeDeadline = !!r.waitForLatestAbgabeDeadline;
  s.weeklyReportHour = r.weeklyReportHour;
  s.weeklyReportMinute = r.weeklyReportMinute;
  s.monthlyReportDay = r.monthlyReportDay;
  s.monthlyReportHour = r.monthlyReportHour;
  s.monthlyReportMinute = r.monthlyReportMinute;
  return r;
}
function applyConfiguredReportTimeV32(ts, hour, minute) {
  if (!ts) return ts;
  const d = new Date(ts);
  const configured = new Date(ts);
  configured.setHours(Number(hour)||0, Number(minute)||0, 0, 0);
  // Nie vor der eigentlichen Abgabefrist senden.
  return Math.max(ts, configured.getTime());
}

function getWeeklyReportDeadlineTsForWeek(weekKey) {
  const cfg = ensureReportSettingsV32();
  if (!cfg.weeklyReportsEnabled) return null;
  const keys = getEnabledAbgabeKeysForWeek(weekKey);
  if (!keys.length) return null;
  const deadlines = keys.map(key => getAbgabeDeadlineTsForWeek(key, weekKey)).filter(Boolean);
  if (!deadlines.length) return null;
  // wait_latest = ein gemeinsamer Bericht erst nach spätester Frist.
  // split_due = erster Bericht sobald die erste nicht verschobene/aktive Abgabe fällig ist;
  // nachträgliche verschobene Abgaben aktualisieren denselben Bericht bei Fälligkeit.
  const base = cfg.abgabeShiftMode === 'split_due' ? Math.min(...deadlines) : Math.max(...deadlines);
  return applyConfiguredReportTimeV32(base, cfg.weeklyReportHour, cfg.weeklyReportMinute);
}
function getWeeklyReportDeadlineLabel(weekKey) {
  const ts = getWeeklyReportDeadlineTsForWeek(weekKey);
  return ts ? formatDateTime(ts) : 'Keine aktive Abgabe';
}

function getAbgabeAutoSanctionDueTs(category, weekKey) {
  const rule = getRuleConfig('abgabeAutoSanction');
  const deadlineTs = getAbgabeDeadlineTsForWeek(category, weekKey);
  if (!deadlineTs) return null;
  return addDaysTs(deadlineTs, Number(rule.overdueDays || 0));
}
function isAbgabeAutoSanctionDue(category, weekKey) {
  const dueTs = getAbgabeAutoSanctionDueTs(category, weekKey);
  return Boolean(dueTs && now() >= dueTs);
}
function getRecentAbgabeWeeksForAutomation(limit = 10) {
  const weeks = new Set(Object.keys(store.abgaben?.weeks || {}));
  // Aktuelle Woche mitprüfen: Wenn eine Abgabefrist + Nachfrist bereits innerhalb
  // derselben Kalenderwoche abläuft, darf die Sanktion nicht erst eine Woche später kommen.
  let wk = currentWeekKey();
  for (let i = 0; i <= limit; i += 1) {
    weeks.add(wk);
    wk = previousWeekKey(wk);
  }
  return [...weeks].filter(w => /^\d{4}-W\d{2}$/.test(String(w))).sort();
}
function touchAbgabeAutomationWeek(weekKey) {
  if (!weekKey || !/^\d{4}-W\d{2}$/.test(String(weekKey))) return null;
  return ensureWeek(weekKey);
}

function isAbgabeWeekStillRunning(weekKey) {
  const deadlineTs = getWeeklyReportDeadlineTsForWeek(weekKey);
  return Boolean(deadlineTs && now() < deadlineTs);
}
function getBlockingAbgabeWeek(baseWeekKey = currentWeekKey()) {
  const previous = previousWeekKey(baseWeekKey);
  const deadlineTs = getWeeklyReportDeadlineTsForWeek(previous);
  if (deadlineTs && now() < deadlineTs) return previous;
  return null;
}
function getEffectiveAbgabeWeek(guild, baseWeekKey = currentWeekKey()) {
  const blocking = getBlockingAbgabeWeek(baseWeekKey);
  return blocking || baseWeekKey;
}
function buildAbgabeWeekLockNotice(baseWeekKey = currentWeekKey()) {
  const blocking = getBlockingAbgabeWeek(baseWeekKey);
  if (!blocking) return null;
  return `⚠️ Neue Woche noch gesperrt. Aktive Abgabe-Woche bleibt **${blocking}** bis zur spätesten Frist: **${getWeeklyReportDeadlineLabel(blocking)}**.`;
}

function getStoredWeeklyReportMessages(week) {
  if (!week || typeof week !== 'object') return [];
  if (Array.isArray(week.weeklyReportMessages)) return week.weeklyReportMessages;
  const legacy = week.weeklyReportMessage || week.weeklyStatusMessages || [];
  return Array.isArray(legacy) ? legacy : [];
}
async function findExistingReportMessageByTitle(channel, title) {
  if (!channel || !title) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages?.size) return null;
  return messages.find(msg => msg.author?.id === client.user?.id && msg.embeds?.[0]?.title === title) || null;
}
async function sendOrEditStoredMessage(channel, stored, payload, label = 'weekly.report', lookupTitle = '') {
  if (stored?.messageId) {
    const storedChannel = stored.channelId && stored.channelId !== channel.id ? channel.guild?.channels?.cache?.get(stored.channelId) : channel;
    const message = await storedChannel?.messages?.fetch(stored.messageId).catch(() => null);
    if (message) {
      await safeMessageEdit(message, payload, `${label}.edit`);
      return { channelId: message.channel.id, messageId: message.id, updatedAt: isoStringNow() };
    }
  }
  // Rückwärtskompatibel: Ältere Bot-Versionen haben die Wochenbericht-Message-IDs nicht gespeichert.
  // Deshalb suchen wir einmal nach dem bestehenden Embed-Titel und bearbeiten diesen Bericht,
  // statt bei der ersten Nachbearbeitung einen doppelten Bericht zu posten.
  const existing = await findExistingReportMessageByTitle(channel, lookupTitle || payload?.embeds?.[0]?.data?.title || '');
  if (existing) {
    await safeMessageEdit(existing, payload, `${label}.legacy-edit`);
    return { channelId: existing.channel.id, messageId: existing.id, updatedAt: isoStringNow() };
  }
  const sent = await safeChannelSend(channel, payload, `${label}.send`);
  return sent ? { channelId: sent.channel.id, messageId: sent.id, updatedAt: isoStringNow() } : null;
}
function isAbgabeWeekReportDue(weekKey) {
  const reportDeadlineTs = getWeeklyReportDeadlineTsForWeek(weekKey);
  return !!reportDeadlineTs && now() >= reportDeadlineTs;
}
function finalizeAbgabeWeekOpenToWarnphase(guild, weekKey, onlyCategory = null, reason = 'auto-finalize') {
  if (!guild || !weekKey) return 0;
  ensureAbgabeRequiredSnapshotsForWeek(guild, weekKey, reason);
  touchPrepaidStatusForWeek(guild, weekKey);
  let changed = 0;
  const categories = (onlyCategory ? [onlyCategory] : getEnabledAbgabeKeysForWeek(weekKey))
    // Nicht mehr auf das Kalenderwochenende warten: Jede Abgabeart springt nach ihrer
    // eigenen Frist in die Warnphase. Das ist wichtig bei verschobenen/individuellen Fristen.
    .filter(category => ABGABEN[category] && isAbgabeEnabled(category) && now() >= getAbgabeDeadlineTsForWeek(category, weekKey));
  for (const category of categories) {
    if (!ABGABEN[category] || !isAbgabeEnabled(category)) continue;
    for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason })) {
      const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
      const status = String(entry.status || 'offen');
      if (!['offen', 'teilabgabe'].includes(status)) continue;
      if (isExcusedDueToLateRoleAssignment(member, category, weekKey)) {
        markExcused(member.id, category, weekKey, null, 'Rolle ab Mittwoch erhalten');
        changed += 1;
        continue;
      }
      if (findPrepaymentSource(member.id, category, weekKey)) {
        entry.status = 'vorausgezahlt';
        entry.amount = getAbgabeAmount(category);
        entry.carryFromWeek = findPrepaymentSource(member.id, category, weekKey)?.sourceWeekKey || null;
        entry.note = entry.carryFromWeek ? `Vorausgezahlt aus ${entry.carryFromWeek}` : 'Vorausgezahlt';
        entry.updatedAt = isoStringNow();
        changed += 1;
        continue;
      }
      if (isUserFullyExcusedForWeek(member.id, weekKey)) {
        markExcused(member.id, category, weekKey, null, `Mindestens ${getAbgabeAbsenceExcuseDays()} Tage abgemeldet`);
        changed += 1;
        continue;
      }
      const deadlineAbsence = isUserAbsentOnDeadline(member.id, weekKey);
      if (deadlineAbsence) {
        markLateRecovery(member.id, category, weekKey, deadlineAbsence.untilTs);
        changed += 1;
        continue;
      }
      markWeekOverdue(member.id, category, weekKey);
      changed += 1;
    }
  }
  if (changed) saveAll();
  return changed;
}
async function upsertWeeklyAbgabeReport(guild, targetWeek, options = {}) {
  if (!guild) return null;
  await ensureGuildMembersCached(guild);
  const week = ensureWeek(targetWeek);
  const channel = guild.channels.cache.get(store.config.channels.statistik);
  if (!channel) return null;
  const reportDeadlineTs = getWeeklyReportDeadlineTsForWeek(targetWeek);
  if (!reportDeadlineTs) return null;
  if (!options.force && now() < reportDeadlineTs) return null;
  const skipBefore = Number(store.config.settings?.abgabenReportSkipBeforeTs || 0);
  if (!options.force && skipBefore && reportDeadlineTs <= skipBefore) {
    week.weeklyReportPosted = true;
    week.weeklyReportSkippedBecauseConfigChangedAt = skipBefore;
    saveAll();
    return null;
  }
  ensureAbgabeRequiredSnapshotsForWeek(guild, targetWeek, options.reason || 'weekly-report-upsert');
  finalizeAbgabeWeekOpenToWarnphase(guild, targetWeek, options.category || null, options.reason || 'weekly-report-finalize');
  const weekly = buildWeeklyAbgabenSummary(guild, targetWeek);
  const summaryEmbed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📈 Wochenbericht • ${targetWeek}`)
    .setDescription('Wochenübersicht mit den wichtigsten Abgabe-Zahlen.')
    .addFields(
      buildInfoField('📦 Abgaben-Übersicht', [
        `Aktive Abgabearten: **${weekly.categories}**`,
        `Pflicht-Einträge: **${weekly.members}**`,
        `Erfüllt: **${weekly.fulfilled}**`,
        `Entschuldigt: **${weekly.excused}**`,
        `Offen: **${weekly.open}**`,
        `Warnphase/Nachholung: **${weekly.warnphase}**`,
        `Nicht abgegeben: **${weekly.notSubmitted}**`,
        `Vorausgezahlt: **${weekly.prepaid}**`,
        `Zu spät: **${weekly.late}**`,
      ], true),
      buildInfoField('💰 Einnahmen & Fortschritt', [
        `Einnahmen gesamt: **${Number(weekly.income || 0).toLocaleString('de-DE')}$**`,
        `Noch zu klären: **${weekly.pending}**`,
        `Fortschritt: **${weekly.progressPct}%**`,
        `Report-Frist: **${getWeeklyReportDeadlineLabel(targetWeek)}**`,
      ], true),
      buildInfoField('ℹ️ Hinweis', [
        'Dieser Bericht zählt nur die eingefrorenen Pflicht-Mitglieder der jeweiligen Woche.',
        'Nachträgliche Änderungen wie Zu-spät/Nachholung aktualisieren diesen Bericht automatisch.',
      ], false),
    )
    .setFooter({ text: `Wochenbericht • zuletzt aktualisiert ${formatDateTime(now())}` });
  const payloads = [{ embeds: [summaryEmbed] }];
  const embeds = await buildStatusEmbeds(guild, targetWeek);
  for (const embed of embeds) payloads.push({ embeds: [embed] });
  const stored = getStoredWeeklyReportMessages(week);
  const nextStored = [];
  for (let i = 0; i < payloads.length; i += 1) {
    const lookupTitle = payloads[i]?.embeds?.[0]?.data?.title || '';
    const msgMeta = await sendOrEditStoredMessage(channel, stored[i], payloads[i], `weekly.${targetWeek}.${i}`, lookupTitle);
    if (msgMeta) nextStored.push(msgMeta);
  }
  week.weeklyReportMessages = nextStored;
  week.weeklyReportPosted = true;
  week.weeklyReportPostedAt ||= isoStringNow();
  week.weeklyReportUpdatedAt = isoStringNow();
  week.weeklyReportDeadlineTs = reportDeadlineTs;
  saveAll();
  return week;
}
const abgabeRefreshRunning = new Set();
async function refreshAbgabeWeekAfterChange(guild, weekKey, category = null, reason = 'after-change') {
  if (!guild || !weekKey) return null;
  const refreshKey = `${weekKey}:${category || 'all'}`;
  if (abgabeRefreshRunning.has(refreshKey)) return null;
  abgabeRefreshRunning.add(refreshKey);
  try {
    ensureAbgabeRequiredSnapshotsForWeek(guild, weekKey, reason);
    finalizeAbgabeWeekOpenToWarnphase(guild, weekKey, category, reason);
    const week = ensureWeek(weekKey);
    let result = null;
    if (isAbgabeWeekReportDue(weekKey) || week.weeklyReportPosted) {
      result = await upsertWeeklyAbgabeReport(guild, weekKey, { force: true, category, reason });
    } else {
      saveAll();
    }
    // Wichtig für nachträgliche Änderungen: Wenn nach Frist/Nachfrist noch jemand offen ist
    // oder auf Zu-spät/Nachholung springt, wird der Auto-Sanktions-Scan direkt erneut angestoßen
    // und nicht erst irgendwann durch einen alten Dienstag-Job.
    if (isAutomationEnabled('abgabeAutoSanctions')) {
      setImmediate(() => { processAbgabeAutoSanctions().catch(error => console.error('ABGABE_AUTO_AFTER_CHANGE_ERROR', error)); });
    }
    return result;
  } finally {
    abgabeRefreshRunning.delete(refreshKey);
  }
}

function buildWeeklyAbgabenSummary(guild, weekKey) {
  const summary = {
    categories: 0,
    members: 0,
    fulfilled: 0,
    excused: 0,
    open: 0,
    warnphase: 0,
    notSubmitted: 0,
    prepaid: 0,
    late: 0,
    income: 0,
  };
  const week = ensureWeek(weekKey);
  for (const category of getEnabledAbgabeKeysForWeek(weekKey)) {
    if (!isAbgabeEnabled(category)) continue;
    summary.categories += 1;
    const members = getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'weekly-summary' });
    summary.members += members.length;
    const memberIds = new Set(members.map(m => m.id));
    for (const member of members) {
      const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
      const status = String(entry.status || 'offen');
      if (['abgegeben', 'zu_spaet', 'vorausgezahlt'].includes(status)) summary.fulfilled += 1;
      if (status === 'entschuldigt') summary.excused += 1;
      if (status === 'offen') summary.open += 1;
      if (['warnphase', 'spaeter_abgabe'].includes(status)) summary.warnphase += 1;
      if (status === 'nicht_abgegeben') summary.notSubmitted += 1;
      if (status === 'vorausgezahlt') summary.prepaid += 1;
      if (status === 'zu_spaet') summary.late += 1;
    }
    for (const [userId, entry] of Object.entries(week.categories?.[category] || {})) {
      // Einnahmen nur aus Einträgen dieser Woche zählen. Zusätzliche Einträge ohne Pflichtmitglied
      // bleiben erhalten, damit freiwillige Zusatzabgaben nicht verloren gehen.
      const amount = Number(entry.amount || 0) + Number(entry.extra || 0);
      if (amount > 0) summary.income += amount;
      if (!memberIds.has(userId) && ['abgegeben', 'zu_spaet', 'vorausgezahlt'].includes(String(entry.status || ''))) {
        summary.fulfilled += 0;
      }
    }
  }
  summary.pending = summary.open + summary.warnphase + summary.notSubmitted;
  const activeRelevant = Math.max(0, summary.members - summary.excused);
  summary.progressPct = activeRelevant ? Math.round((summary.fulfilled / activeRelevant) * 100) : 100;
  return summary;
}

async function postWeeklyReportsForWeek(targetWeek) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  return upsertWeeklyAbgabeReport(guild, targetWeek, { reason: 'scheduled-weekly-report' });
}
async function postWeeklyReports() {
  return postWeeklyReportsForWeek(previousWeekKey(currentWeekKey()));
}
async function processDynamicWeeklyReport() {
  const reportCfg = ensureReportSettingsV32();
  if (!reportCfg.weeklyReportsEnabled) return null;
  const keys = [previousWeekKey(currentWeekKey()), currentWeekKey()];
  for (const weekKey of [...new Set(keys)]) {
    const week = ensureWeek(weekKey);
    if (week.weeklyReportPosted) continue;
    const deadlineTs = getWeeklyReportDeadlineTsForWeek(weekKey);
    if (deadlineTs && Date.now() >= deadlineTs) await postWeeklyReportsForWeek(weekKey);
  }
}
function buildMonthUserDetail(guild, userId, data) {
  const lines = [
    `**${getUserDisplay(guild, userId)}**`,
    `• Überfällige Wochen: ${data.overdueCount}`,
    `• Entschuldigt: ${data.excusedCount}`,
    `• Immer abgegeben: ${data.perfectCount}`,
    `• Vorausgezahlt: ${data.prepaidCount}`,
    `• Zu spät: ${data.lateCount}`,
    `• Nicht abgegeben: ${data.nonSubmittedCount}`,
  ];
  for (const [category, totals] of Object.entries(data.categories || {})) {
    lines.push(`• ${ABGABEN[category].label}: ${formatAmount(category, totals.total)} | Extras: ${formatAmount(category, totals.extra)}`);
  }
  const weekLines = Object.entries(data.weeks || {}).sort(([a], [b]) => a.localeCompare(b)).map(([weekKey, weekBlock]) => {
    const detail = Object.entries(weekBlock).map(([category, row]) => {
      const base = `${ABGABEN[category].label}: ${row.status}`;
      const qty = (row.amount || row.extra) ? ` (${formatAmount(category, row.amount || 0)}${row.extra ? ` + ${formatAmount(category, row.extra)}` : ''})` : '';
      return `${base}${qty}`;
    }).join(' | ');
    return `– ${weekKey}: ${detail}`;
  });
  if (weekLines.length) lines.push('', ...weekLines);
  return lines.join('\n');
}

function getMonthWeekShortLabel(weekKey) {
  const m = String(weekKey || '').match(/W(\d{2})$/);
  return m ? `W${Number(m[1])}` : String(weekKey || '—');
}
function formatPercent(count, total) {
  const n = Number(count || 0);
  const d = Number(total || 0);
  if (!d) return '0%';
  const pct = (n / d) * 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1).replace('.', ',')}%`;
}
function compactTopList(guild, rows, emptyText = '- keiner -') {
  const filtered = rows.filter(([, count]) => Number(count || 0) > 0).sort(([, a], [, b]) => Number(b || 0) - Number(a || 0)).slice(0, 5);
  if (!filtered.length) return emptyText;
  return filtered.map(([userId, count], index) => `${index + 1}. ${getUserDisplay(guild, userId)} ${count}x`).join('\n');
}
function formatCompactMonthRange(monthKey) {
  const [year, month] = String(monthKey || '').split('-');
  if (!year || !month) return String(monthKey || '—');
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return `01.${month}.${year} - ${String(lastDay).padStart(2, '0')}.${month}.${year}`;
}
function makeProgressBar(percent, size = 10) {
  const pct = Math.max(0, Math.min(100, Number(percent || 0)));
  const filled = Math.round((pct / 100) * size);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, size - filled));
}
function formatStatusPercent(count, total) {
  return formatPercent(count, total);
}
function getMonthlyStatusAmountLine(category, count, total, amount) {
  const pct = formatStatusPercent(count, total);
  return `${pct} (${formatAmount(category, amount)})`;
}
function buildCompactMonthlyAbgabenReportData(guild, monthKey) {
  const weekKeys = listWeeksInMonth(monthKey).sort();
  const categoryStats = {};
  const userStats = {};
  const allActiveWeeks = new Set();
  for (const category of Object.keys(ABGABEN)) {
    categoryStats[category] = {
      category,
      label: category === 'routen' ? 'Route' : ABGABEN[category].label,
      amountTotal: 0,
      requiredTotal: 0,
      submitted: 0,
      late: 0,
      excused: 0,
      notSubmitted: 0,
      submittedAmount: 0,
      lateAmount: 0,
      excusedAmount: 0,
      notSubmittedAmount: 0,
      activeWeeks: [],
    };
  }

  for (const weekKey of weekKeys) {
    const week = ensureWeek(weekKey);
    for (const category of Object.keys(ABGABEN)) {
      const stats = categoryStats[category];
      const activeForWeek = isAbgabeCategoryActiveForWeek(category, weekKey);
      if (!activeForWeek) continue;
      const members = getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'monthly-compact-report' });
      if (!members.length) continue;
      stats.activeWeeks.push(weekKey);
      allActiveWeeks.add(weekKey);
      const requiredAmount = Number(getAbgabeAmount(category, weekKey) || ABGABEN[category]?.amount || 0);
      for (const member of members) {
        const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
        const status = String(entry.status || 'offen');
        const paidAmount = Number(entry.amount || 0) + Number(entry.extra || 0);
        const effectiveAmount = paidAmount > 0 ? paidAmount : requiredAmount;
        stats.requiredTotal += 1;
        userStats[member.id] ||= { excused: 0, late: 0, notSubmitted: 0 };
        if (status === 'entschuldigt') {
          stats.excused += 1;
          stats.excusedAmount += effectiveAmount;
          userStats[member.id].excused += 1;
        } else if (status === 'zu_spaet') {
          stats.late += 1;
          stats.lateAmount += effectiveAmount;
          userStats[member.id].late += 1;
        } else if (['abgegeben', 'vorausgezahlt'].includes(status)) {
          stats.submitted += 1;
          stats.submittedAmount += effectiveAmount;
        } else {
          stats.notSubmitted += 1;
          stats.notSubmittedAmount += effectiveAmount;
          userStats[member.id].notSubmitted += 1;
        }
      }
      for (const entry of Object.values(week.categories?.[category] || {})) {
        if (!entry || typeof entry !== 'object' || entry.userId === '_configSkipped') continue;
        stats.amountTotal += Number(entry.amount || 0) + Number(entry.extra || 0);
      }
    }
  }

  const activeCategoryCount = Object.values(categoryStats).filter(s => s.activeWeeks.length && s.requiredTotal > 0).length;
  const totalAmount = Object.values(categoryStats).reduce((sum, s) => sum + Number(s.amountTotal || 0), 0);
  const totalRequired = Object.values(categoryStats).reduce((sum, s) => sum + Number(s.requiredTotal || 0), 0);
  const totalSubmitted = Object.values(categoryStats).reduce((sum, s) => sum + Number(s.submitted || 0), 0);
  return { weekKeys, categoryStats, userStats, allActiveWeeks: [...allActiveWeeks].sort(), activeCategoryCount, totalAmount, totalRequired, totalSubmitted };
}
const MONTHLY_REPORT_SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const MONTHLY_REPORT_THIN_SEPARATOR = '──────────────────────────────────────────────';

function buildMonthlyCategoryText(category, stats) {
  const cfg = ABGABEN[category] || {};
  const title = `## ${cfg.emoji || '📦'} ${stats?.label || cfg.label || category}`;

  if (!stats || !stats.activeWeeks.length || !stats.requiredTotal) {
    return [
      title,
      '',
      `> ❌ **Nicht aktiv in diesem Monat**`,
    ].join('\n');
  }

  const activeWeeks = [...new Set(stats.activeWeeks)]
    .map(getMonthWeekShortLabel)
    .join(', ');

  const submittedPct = stats.requiredTotal
    ? (stats.submitted / stats.requiredTotal) * 100
    : 0;

  return [
    title,
    '',
    `💰 **Eingegangen:** ${formatAmount(category, stats.amountTotal)}`,
    `📅 **Aktiv in:** ${activeWeeks || '—'}`,
    `📈 **Fortschritt:** ${makeProgressBar(submittedPct, 22)} **${formatPercent(stats.submitted, stats.requiredTotal)}**`,
    '',
    `✅ **Abgegeben:** ${getMonthlyStatusAmountLine(category, stats.submitted, stats.requiredTotal, stats.submittedAmount)}`,
    `⏰ **Zu spät:** ${getMonthlyStatusAmountLine(category, stats.late, stats.requiredTotal, stats.lateAmount)}`,
    `🛡️ **Entschuldigt:** ${getMonthlyStatusAmountLine(category, stats.excused, stats.requiredTotal, stats.excusedAmount)}`,
    `❌ **Nicht abgegeben:** ${getMonthlyStatusAmountLine(category, stats.notSubmitted, stats.requiredTotal, stats.notSubmittedAmount)}`,
  ].join('\n');
}

function buildCompactMonthlyAbgabenEmbeds(guild, monthKey, { manual = false } = {}) {
  const data = buildCompactMonthlyAbgabenReportData(guild, monthKey);
  const monthNo = String(monthKey).split('-')[1] || monthKey;
  const year = String(monthKey).split('-')[0] || '';
  const categoryOrder = ['routen', 'patronen', 'meth', 'schwarzpulver'];
  const activeWeeksText = data.allActiveWeeks.length ? data.allActiveWeeks.map(getMonthWeekShortLabel).join(', ') : '—';
  const participation = data.totalRequired ? formatPercent(data.totalSubmitted, data.totalRequired) : '0%';

  const overviewLines = [
    `# 📊 Monatsbericht ${monthNo}${year ? ` / ${year}` : ''}`,
    MONTHLY_REPORT_SEPARATOR,
    '',
    `📅 **Zeitraum:** ${formatCompactMonthRange(monthKey)}`,
    `💰 **Gesamt eingegangen:** ${formatAmount('routen', data.totalAmount)}`,
    `📦 **Aktive Abgabenarten:** ${data.activeCategoryCount} / ${categoryOrder.length}`,
    `📆 **Aktive Wochen:** ${activeWeeksText}`,
    `📈 **Teilnahmequote gesamt:** **${participation}**`,
    '',
    MONTHLY_REPORT_SEPARATOR,
    '',
  ];

  for (const category of categoryOrder) {
    overviewLines.push(buildMonthlyCategoryText(category, data.categoryStats[category]));
    if (category !== categoryOrder[categoryOrder.length - 1]) overviewLines.push('', MONTHLY_REPORT_THIN_SEPARATOR, '');
  }

  const overview = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📊 Monatsbericht ${monthNo}`)
    .setDescription(clampFieldValue(overviewLines.join('\n'), 4090))
    .setFooter({ text: `Monatsreport • ${manual ? 'manuell' : 'automatisch'} erstellt` });

  const topRows = Object.entries(data.userStats || {});
  const detailsLines = [
    `# 📌 Auffälligkeiten ${monthNo}`,
    MONTHLY_REPORT_SEPARATOR,
    '',
    `## 🛡️ Entschuldigt`,
    compactTopList(guild, topRows.map(([id, s]) => [id, s.excused])),
    '',
    MONTHLY_REPORT_THIN_SEPARATOR,
    '',
    `## ⏰ Zu spät`,
    compactTopList(guild, topRows.map(([id, s]) => [id, s.late])),
    '',
    MONTHLY_REPORT_THIN_SEPARATOR,
    '',
    `## ❌ Nicht abgegeben`,
    compactTopList(guild, topRows.map(([id, s]) => [id, s.notSubmitted])),
    '',
    MONTHLY_REPORT_SEPARATOR,
    '',
    `ℹ️ **Hinweis:** Entschuldigungen wurden berücksichtigt.`,
    `🤖 **Kenway System**`,
  ];

  const details = new EmbedBuilder()
    .setColor(COLORS.warn || COLORS.info)
    .setTitle(`📌 Auffälligkeiten ${monthNo}`)
    .setDescription(clampFieldValue(detailsLines.join('\n'), 4090))
    .setFooter({ text: `Monatsreport Details • ${manual ? 'manuell' : 'automatisch'} erstellt` });

  return [overview, details];
}
async function postMonthlyReport() {
  const reportCfg = ensureReportSettingsV32();
  if (!reportCfg.monthlyReportsEnabled) return null;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const channel = guild.channels.cache.get(store.config.channels.statistik);
  if (!channel) return;
  const nowDate = getTzDate();
  const monthKey = getMonthKey(nowDate);
  const tomorrowMonthKey = getMonthKey(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1));
  const isLastDayOfMonth = tomorrowMonthKey !== monthKey;
  if (!isLastDayOfMonth) return;
  if (nowDate.getHours() !== 23 || nowDate.getMinutes() !== 59) return;

  const month = ensureMonthReport(monthKey);
  if (month.posted) return;

  const activeCategories = getEnabledAbgabeKeys();
  if (!activeCategories.length) {
    await safeChannelSend(channel, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`📊 Monatsreport Abgaben • ${monthKey}`).setDescription('Nicht aktiviert.').setFooter({ text: 'Monatsreport • automatisch erstellt' })] }, 'monthly.disabled.send');
    month.posted = true;
    month.disabledBecauseNoActiveAbgaben = true;
    saveAll();
    return;
  }

  await ensureGuildMembersCached(guild);
  const embeds = buildCompactMonthlyAbgabenEmbeds(guild, monthKey, { manual: false });
  await safeChannelSend(channel, { embeds }, 'monthly.compact.send');
  month.posted = true;
  month.postedAt = isoStringNow();
  saveAll();
}

// =========================================================
// MANUELLE ABGABEN-REPORTS (Vorschau/Test)
// =========================================================
async function postManualWeeklyAbgabenReport(guild, channel, targetWeek) {
  if (!guild || !channel) return false;
  await ensureGuildMembersCached(guild);
  const weekKey = targetWeek || previousWeekKey(currentWeekKey());
  const weekly = buildWeeklyAbgabenSummary(guild, weekKey);
  const summaryEmbed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📈 Wochenbericht • ${weekKey}`)
    .setDescription('Manuell angeforderte Wochenübersicht mit den wichtigsten Abgabe-Zahlen.')
    .addFields(
      buildInfoField('📦 Abgaben-Übersicht', [
        `Aktive Abgabearten: **${weekly.categories}**`,
        `Pflicht-Einträge: **${weekly.members}**`,
        `Erfüllt: **${weekly.fulfilled}**`,
        `Entschuldigt: **${weekly.excused}**`,
        `Offen: **${weekly.open}**`,
        `Warnphase/Nachholung: **${weekly.warnphase}**`,
        `Nicht abgegeben: **${weekly.notSubmitted}**`,
        `Vorausgezahlt: **${weekly.prepaid}**`,
        `Zu spät: **${weekly.late}**`,
      ], true),
      buildInfoField('💰 Einnahmen & Fortschritt', [
        `Einnahmen gesamt: **${Number(weekly.income || 0).toLocaleString('de-DE')}$**`,
        `Noch zu klären: **${weekly.pending}**`,
        `Fortschritt: **${weekly.progressPct}%**`,
        `Report-Frist: **${getWeeklyReportDeadlineLabel(weekKey)}**`,
      ], true),
      buildInfoField('ℹ️ Hinweis', [
        'Dieser Bericht wurde manuell angefordert.',
        'Die automatische Wochenbericht-Markierung wird dadurch nicht verändert.',
      ], false),
    )
    .setFooter({ text: 'Wochenbericht • manuell erstellt' });

  await safeChannelSend(channel, { embeds: [summaryEmbed] }, 'weekly.manual.summary.send');
  const embeds = await buildStatusEmbeds(guild, weekKey);
  for (const embed of embeds) await safeChannelSend(channel, { embeds: [embed] }, 'weekly.manual.embed.send');
  return true;
}

async function postManualMonthlyAbgabenReport(guild, channel, monthKey = getMonthKey()) {
  if (!guild || !channel) return false;
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('Monat muss im Format YYYY-MM sein, z. B. 2026-05.');
  await ensureGuildMembersCached(guild);

  const activeCategories = getEnabledAbgabeKeys();
  if (!activeCategories.length) {
    await safeChannelSend(channel, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`📊 Monatsreport Abgaben • ${monthKey}`).setDescription('Nicht aktiviert.').setFooter({ text: 'Monatsreport • manuell erstellt' })] }, 'monthly.manual.disabled.send');
    return true;
  }

  const embeds = buildCompactMonthlyAbgabenEmbeds(guild, monthKey, { manual: true });
  await safeChannelSend(channel, { embeds }, 'monthly.manual.compact.send');
  return true;
}

// =========================================================
// WACHE HELPERS
// =========================================================

function ensureWacheConfigShape() {
  ensureConfigShape();
  if (!store.config.settings.wacheConfig || typeof store.config.settings.wacheConfig !== 'object') {
    store.config.settings.wacheConfig = {};
  }

  const cfg = store.config.settings.wacheConfig;
  const defaults = DEFAULT_CONFIG.settings.wacheConfig || {};

  if (typeof cfg.enabled !== 'boolean') cfg.enabled = defaults.enabled ?? false;
  if (typeof cfg.requiredMinutesPerWeek !== 'number') cfg.requiredMinutesPerWeek = defaults.requiredMinutesPerWeek ?? 60;
  if (typeof cfg.absenceExcuseDays !== 'number') cfg.absenceExcuseDays = defaults.absenceExcuseDays ?? 5;
  if (typeof cfg.sessionMinutes !== 'number') cfg.sessionMinutes = defaults.sessionMinutes ?? 60;
  if (typeof cfg.maxParticipants !== 'number') cfg.maxParticipants = defaults.maxParticipants ?? 5;
  if (typeof cfg.sanctionAmount !== 'number') cfg.sanctionAmount = defaults.sanctionAmount ?? 100000;
  if (typeof cfg.reportChannelKey !== 'string') cfg.reportChannelKey = defaults.reportChannelKey ?? 'statistik';
  if (typeof cfg.reportChannelId !== 'string') cfg.reportChannelId = defaults.reportChannelId ?? '';
  if (typeof cfg.dashboardChannelId !== 'string') cfg.dashboardChannelId = defaults.dashboardChannelId ?? '';
  if (typeof cfg.enabledAt !== 'number') cfg.enabledAt = defaults.enabledAt ?? 0;
  if (typeof cfg.reportSkipBeforeTs !== 'number') cfg.reportSkipBeforeTs = 0;
  if (typeof cfg.startHour !== 'number') cfg.startHour = defaults.startHour ?? 14;
  if (typeof cfg.endHour !== 'number') cfg.endHour = defaults.endHour ?? 24;
}

function ensureWacheStoreShape() {
  if (!store.wache || typeof store.wache !== 'object') store.wache = deepClone(DEFAULT_WACHE);
  if (!store.wache.weeks || typeof store.wache.weeks !== 'object') store.wache.weeks = {};
  if (!store.wache.monthReports || typeof store.wache.monthReports !== 'object') store.wache.monthReports = {};
  if (!store.wache.dashboardMessage || typeof store.wache.dashboardMessage !== 'object') store.wache.dashboardMessage = null;
  if (!store.wache.statusMessage || typeof store.wache.statusMessage !== 'object') store.wache.statusMessage = null;
  if (store.wache.active && typeof store.wache.active !== 'object') store.wache.active = null;
  ensureWacheConfigShape();
}
function getWacheConfig() {
  ensureWacheStoreShape();
  return store.config.settings.wacheConfig;
}

function getWacheReportChannel(guild) {
  const cfg = getWacheConfig();
  return (cfg.reportChannelId && guild.channels.cache.get(cfg.reportChannelId))
    || guild.channels.cache.get(store.config.channels?.wache_reports || '')
    || guild.channels.cache.get(store.config.channels?.statistik || '')
    || getStatsChannel(guild)
    || getDashboardChannel(guild);
}
function getWacheDashboardChannel(guild) {
  const cfg = getWacheConfig();
  return (cfg.dashboardChannelId && guild.channels.cache.get(cfg.dashboardChannelId))
    || guild.channels.cache.get(store.config.channels?.wache_dashboard || '')
    || getDashboardChannel(guild)
    || getStatsChannel(guild);
}
function formatWacheRemaining(active) {
  if (!active || active.closed) return '—';
  return `${Math.max(0, Math.ceil((Number(active.endTs || 0) - now()) / 60000))} min`;
}
function buildWacheLiveDashboardEmbed(guild) {
  const cfg = getWacheConfig();
  const active = store.wache?.active && !store.wache.active.closed ? store.wache.active : null;
  const participants = active ? getWacheActiveParticipants() : [];
  const currentWeek = currentWeekKey();
  const maxParticipants = Math.max(1, Number(cfg.maxParticipants || 5));
  const participantLines = participants.length
    ? participants.map(p => `• ${getUserDisplay(guild, p.userId)} — seit **${new Date(p.startTs).toLocaleTimeString('de-DE', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })}**`)
    : ['—'];
  const week = getWacheWeek(currentWeek);
  const top = Object.entries(week.users || {})
    .sort((a,b)=>Number(b[1].totalMinutes||0)-Number(a[1].totalMinutes||0))
    .slice(0, 5)
    .map(([userId,row], i)=>`${i+1}. ${getUserDisplay(guild, userId)} — **${Number(row.totalMinutes||0)} min**`);
  return new EmbedBuilder()
    .setColor(active ? COLORS.success : COLORS.info)
    .setTitle('🟢 Wache Live-Dashboard')
    .addFields(
      buildInfoField('📡 Aktuelle Wache', [
        active ? `Läuft seit: **${formatDateTime(active.startTs)}**` : 'Läuft seit: **—**',
        active ? `Auto-Ende: **${formatDateTime(active.endTs)}**` : 'Auto-Ende: **—**',
        `Restzeit: **${active ? formatWacheRemaining(active) : '—'}**`,
        `Teilnehmer: **${participants.length}/${maxParticipants}**`,
      ], false),
      buildInfoField('👥 Eingestempelt', participantLines, false),
      buildInfoField('🏆 Wochenranking Top 5', top.length ? top : ['Noch keine Daten.'], false),
    )
    .setFooter({ text: 'Wache Dashboard • aktualisiert sich automatisch' })
    .setTimestamp(new Date());
}
async function upsertWacheDashboardMessage(guild, channel = null, force = false) {
  if (!guild) return null;
  // Dashboard darf auch angelegt werden, wenn Wache aktuell AUS ist.
  // Nur automatische Updates werden bei AUS übersprungen, wenn force=false.
  if (!force && !getWacheConfig().enabled) return null;
  const target = channel || getWacheDashboardChannel(guild);
  if (!target || !target.isTextBased?.()) return null;
  const payload = { embeds: [buildWacheLiveDashboardEmbed(guild)] };
  const nextHash = payloadHash(payload);
  const saved = store.wache.dashboardMessage;
  if (saved?.channelId && saved?.messageId) {
    const savedChannel = guild.channels.cache.get(saved.channelId);
    if (savedChannel) {
      try {
        const msg = await savedChannel.messages.fetch(saved.messageId);
        if (msg) {
          if (saved.payloadHash === nextHash) return msg;
          const edited = await safeMessageEdit(msg, payload, 'wache.dashboard.edit');
          if (edited) {
            store.wache.dashboardMessage = { channelId: edited.channel.id, messageId: edited.id, payloadHash: nextHash, updatedAt: now() };
            saveAll();
          }
          return edited;
        }
      } catch (_) {}
    }
  }
  const msg = await safeChannelSend(target, payload, 'wache.dashboard.send');
  if (msg) {
    store.wache.dashboardMessage = { channelId: msg.channel.id, messageId: msg.id, payloadHash: nextHash, updatedAt: now() };
    saveAll();
  }
  return msg;
}

async function sendFreshWacheDashboardBelowPanel(guild, channel) {
  if (!guild || !channel?.isTextBased?.()) return null;
  ensureWacheStoreShape();
  setWacheConfig({ dashboardChannelId: channel.id });
  const msg = await safeChannelSend(channel, { embeds: [buildWacheLiveDashboardEmbed(guild)] }, 'wache.dashboard.send.fresh');
  if (msg) {
    store.wache.dashboardMessage = { channelId: msg.channel.id, messageId: msg.id, payloadHash: payloadHash({ embeds: [buildWacheLiveDashboardEmbed(guild)] }), updatedAt: now() };
    saveAll();
  }
  return msg;
}
function markExistingWacheWeeksProcessed(changedAt = now()) {
  ensureWacheStoreShape();
  for (const [weekKey, week] of Object.entries(store.wache?.weeks || {})) {
    const deadline = endOfWeekTsFromWeekKey(weekKey);
    if (deadline <= changedAt) {
      week.weeklyReportPosted = true;
      week.sanctionsProcessed = true;
      week.skippedBecauseConfigChangedAt = changedAt;
    }
  }
}
function setWacheConfig(changes = {}) {
  const cfg = getWacheConfig();
  let shouldSkipOldWeeks = false;

  if (changes.enabled != null) {
    const nextEnabled = !!changes.enabled;
    if (nextEnabled !== cfg.enabled) {
      shouldSkipOldWeeks = true;
      if (nextEnabled) cfg.enabledAt = now();
    }
    cfg.enabled = nextEnabled;
  }
  if (changes.requiredMinutesPerWeek != null) {
    const next = Math.max(0, Math.round(Number(changes.requiredMinutesPerWeek) || 0));
    if (next !== Number(cfg.requiredMinutesPerWeek || 0)) shouldSkipOldWeeks = true;
    cfg.requiredMinutesPerWeek = next;
  }
  if (changes.absenceExcuseDays != null) {
    const next = Math.max(0, Math.round(Number(changes.absenceExcuseDays) || 0));
    if (next !== Number(cfg.absenceExcuseDays || 0)) shouldSkipOldWeeks = true;
    cfg.absenceExcuseDays = next;
  }
  if (changes.sessionMinutes != null) cfg.sessionMinutes = Math.max(1, Math.round(Number(changes.sessionMinutes) || 60));
  if (changes.maxParticipants != null) cfg.maxParticipants = Math.max(1, Math.round(Number(changes.maxParticipants) || 5));
  if (changes.sanctionAmount != null) {
    const next = Math.max(0, Math.round(Number(changes.sanctionAmount) || 0));
    if (next !== Number(cfg.sanctionAmount || 0)) shouldSkipOldWeeks = true;
    cfg.sanctionAmount = next;
  }
  if (changes.reportChannelId != null) cfg.reportChannelId = String(changes.reportChannelId || '');
  if (changes.dashboardChannelId != null) cfg.dashboardChannelId = String(changes.dashboardChannelId || '');

  // Nur echte Pflicht-/Sanktions-/AN-AUS-Änderungen markieren alte Wochen als verarbeitet.
  // Reine Dashboard-/Reportkanal-Änderungen dürfen keine Wochenberichte verlieren.
  if (shouldSkipOldWeeks) {
    cfg.reportSkipBeforeTs = now();
    markExistingWacheWeeksProcessed(cfg.reportSkipBeforeTs);
  }
  saveAll();
  return cfg;
}

function getWacheWeek(weekKey = currentWeekKey()) {
  ensureWacheStoreShape();
  if (!store.wache.weeks[weekKey]) {
    store.wache.weeks[weekKey] = { weekKey, users: {}, sessions: [], weeklyReportPosted: false, sanctionsProcessed: false };
  }
  const week = store.wache.weeks[weekKey];
  if (!week.users || typeof week.users !== 'object') week.users = {};
  if (!Array.isArray(week.sessions)) week.sessions = [];
  return week;
}
function getWacheMonth(monthKey = getMonthKey()) {
  ensureWacheStoreShape();
  if (!store.wache.monthReports[monthKey]) store.wache.monthReports[monthKey] = { monthKey, posted: false, weeks: [], users: {} };
  return store.wache.monthReports[monthKey];
}
function getWacheWeekKeyFromTs(ts) { return getWeekKey(tsToTzDate(ts)); }
function getWacheDayKeyFromTs(ts) { return new Date(ts).toLocaleDateString('de-DE', { timeZone: TIMEZONE, weekday: 'short' }); }
function getWacheActiveParticipants() {
  const active = store.wache?.active;
  if (!active || active.closed) return [];
  return Object.entries(active.participants || {}).filter(([, row]) => !row.endTs).map(([userId, row]) => ({ userId, ...row }));
}
function getWacheSessionEndTs(startTs = now()) {
  const cfg = getWacheConfig();
  const byDuration = startTs + (Number(cfg.sessionMinutes || 60) * 60 * 1000);
  const local = tsToTzDate(startTs);
  const midnight = new Date(local);
  midnight.setHours(Number(cfg.endHour || 24), 0, 0, 0);
  return Math.min(byDuration, midnight.getTime());
}
function getWacheStartWindowStatus(ts = now()) {
  const cfg = getWacheConfig();
  const local = tsToTzDate(ts);
  const start = new Date(local);
  start.setHours(Number(cfg.startHour || 14), 0, 0, 0);
  const end = new Date(local);
  end.setHours(Number(cfg.endHour || 24), 0, 0, 0);
  if (ts < start.getTime()) return { ok: false, message: `Wache kann erst ab ${String(Number(cfg.startHour || 14)).padStart(2, '0')}:00 Uhr gestartet werden.` };
  if (ts >= end.getTime()) return { ok: false, message: `Wache kann nach ${Number(cfg.endHour || 24) >= 24 ? '00' : String(Number(cfg.endHour)).padStart(2, '0')}:00 Uhr nicht mehr gestartet werden.` };
  return { ok: true, startTs: start.getTime(), endTs: end.getTime() };
}
function addWacheMinutes(userId, startTs, endTs, mode = 'manual') {
  const minutes = Math.max(0, Math.round((Number(endTs || now()) - Number(startTs || now())) / 60000));
  if (!userId || minutes <= 0) return 0;
  const weekKey = getWacheWeekKeyFromTs(startTs);
  const week = getWacheWeek(weekKey);
  week.users[userId] ||= { totalMinutes: 0, count: 0, days: {}, entries: [] };
  const row = week.users[userId];
  const dayKey = getWacheDayKeyFromTs(startTs);
  row.totalMinutes += minutes;
  row.count += 1;
  row.days[dayKey] = (row.days[dayKey] || 0) + minutes;
  row.entries.push({ startTs, endTs, minutes, mode });
  return minutes;
}
function isWacheMemberRequired(member) {
  if (!member || member.user?.bot) return false;
  const cfg = getWacheConfig();
  if (!cfg.enabled) return false;
  if (isLeadershipDutyExempt(member)) return false;
  const roleIds = getWacheRequiredRoleIds();
  if (!roleIds.length) return true;
  return member.roles.cache.some(role => roleIds.includes(role.id));
}
function getWacheRequiredSinceTs(member) {
  if (!member || member.user?.bot) return null;
  const roleIds = getWacheRequiredRoleIds();
  if (!roleIds.length) return Number(member.joinedTimestamp || now());
  const timestamps = roleIds
    .filter(roleId => member.roles.cache.has(roleId))
    .map(roleId => getTrackedRoleAssignmentTs(member.id, roleId) || Number(member.joinedTimestamp || now()))
    .filter(ts => Number.isFinite(Number(ts)) && Number(ts) > 0)
    .map(Number);
  return timestamps.length ? Math.min(...timestamps) : null;
}
function isWacheMemberRequiredForWeek(member, weekKey = currentWeekKey()) {
  if (!isWacheMemberRequired(member)) return false;
  const cfg = getWacheConfig();
  const weekStart = startOfWeekTsFromWeekKey(weekKey);
  const weekEnd = endOfWeekTsFromWeekKey(weekKey);
  const enabledAt = Number(cfg.enabledAt || 0);

  // Keine Pflicht für Wochen, die vor der Aktivierung oder vor einer Konfigurationsänderung abgeschlossen waren.
  if (enabledAt && weekEnd <= enabledAt) return false;
  if (Number(cfg.reportSkipBeforeTs || 0) && weekEnd <= Number(cfg.reportSkipBeforeTs || 0)) return false;

  const requiredSince = getWacheRequiredSinceTs(member);
  if (!requiredSince) return false;

  // Neue Mitglieder/Rollenempfänger werden erst ab der nächsten vollen Woche sanktionierbar.
  // Dadurch kann niemand rückwirkend in alte Wache-Wochen oder laufende Wochen reinfallen.
  const dutySince = Math.max(Number(requiredSince || 0), Number(enabledAt || 0));
  return dutySince <= weekStart;
}
async function getWacheRequiredMembers(guild, weekKey = currentWeekKey()) {
  await ensureGuildMembersCached(guild);
  let changed = false;
  for (const member of guild.members.cache.values()) {
    if (seedRoleTrackingForMember(member)) changed = true;
  }
  if (changed) saveAll();
  return [...guild.members.cache.values()].filter(member => isWacheMemberRequiredForWeek(member, weekKey)).sort((a,b)=>a.displayName.localeCompare(b.displayName, 'de'));
}
function getWacheUserStats(weekKey, userId) {
  const week = getWacheWeek(weekKey);
  return week.users[userId] || { totalMinutes: 0, count: 0, days: {}, entries: [] };
}
function isUserExcusedForWacheWeek(userId, weekKey) {
  const cfg = getWacheConfig();
  const weekStart = startOfWeekTsFromWeekKey(weekKey);
  const weekEnd = endOfWeekTsFromWeekKey(weekKey);
  const requiredDays = Number(cfg.absenceExcuseDays || 0);
  if (requiredDays <= 0) return false;
  return (store.absences.items || []).some(item => {
    if (item.userId !== userId || !item.active || !matchesAbsenceScope(item, 'wache')) return false;
    const overlapStart = Math.max(Number(item.startTs || 0), weekStart);
    const overlapEnd = Math.min(Number(item.untilTs || 0), weekEnd);
    if (overlapEnd <= overlapStart) return false;
    return daysBetween(overlapStart, overlapEnd) >= requiredDays;
  });
}
function getWacheUnfulfilledStatsForUser(userId, weeksBack = 4) {
  const cfg = getWacheConfig();
  const required = Math.max(0, Number(cfg.requiredMinutesPerWeek || 0));
  if (!cfg.enabled || required <= 0) return { missed: 0, repeated: 0, worstMissing: 0, penalty: 0, labels: [] };
  const pc = getReliabilityPointConfig();
  let weekKey = previousWeekKey(currentWeekKey());
  let missed = 0;
  let worstMissing = 0;
  const labels = [];
  for (let i = 0; i < Math.max(1, Number(weeksBack || 4)); i += 1) {
    if (!/^\d{4}-W\d{2}$/.test(weekKey)) break;
    const processState = canProcessWacheWeekForReportOrSanctions(weekKey, cfg);
    // Für laufende/noch nicht fällige Wochen gibt es keinen Abzug.
    if (processState.reason === 'not_due') { weekKey = previousWeekKey(weekKey); continue; }
    if (!processState.ok && ['disabled', 'before_enabled', 'before_config_change'].includes(processState.reason)) { weekKey = previousWeekKey(weekKey); continue; }
    if (isUserExcusedForWacheWeek(userId, weekKey)) { weekKey = previousWeekKey(weekKey); continue; }
    const stats = getWacheUserStats(weekKey, userId);
    const minutes = Number(stats.totalMinutes || 0);
    const missing = Math.max(0, required - minutes);
    if (missing > 0) {
      missed += 1;
      worstMissing = Math.max(worstMissing, missing);
      labels.push(`${weekKey}: ${minutes}/${required} min`);
    }
    weekKey = previousWeekKey(weekKey);
  }
  let penalty = 0;
  if (pc.wacheStart > 0 && missed >= pc.wacheStart) {
    penalty = (missed - pc.wacheStart + 1) * pc.wachePenalty;
    if (missed > 1) penalty += (missed - 1) * pc.wacheRepeatPenalty;
    if (missed >= pc.wacheHeavyAfter) penalty += pc.wachePenalty;
  }
  return { missed, repeated: Math.max(0, missed - 1), worstMissing, penalty: Math.round(penalty), labels };
}
async function buildWacheSummary(guild, weekKey = currentWeekKey()) {
  const cfg = getWacheConfig();
  const required = Number(cfg.requiredMinutesPerWeek || 0);
  const members = await getWacheRequiredMembers(guild, weekKey);
  const rows = [];
  for (const member of members) {
    const stats = getWacheUserStats(weekKey, member.id);
    const excused = isUserExcusedForWacheWeek(member.id, weekKey);
    const missing = Math.max(0, required - Number(stats.totalMinutes || 0));
    rows.push({ userId: member.id, name: member.displayName, minutes: Number(stats.totalMinutes || 0), count: Number(stats.count || 0), missing, fulfilled: missing <= 0, excused });
  }
  rows.sort((a,b)=>b.minutes-a.minutes || a.name.localeCompare(b.name, 'de'));
  return { cfg, required, rows };
}

function canProcessWacheWeekForReportOrSanctions(weekKey, cfg = getWacheConfig()) {
  const deadline = endOfWeekTsFromWeekKey(weekKey);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (now() <= deadline) return { ok: false, reason: 'not_due' };
  if (Number(cfg.enabledAt || 0) && deadline <= Number(cfg.enabledAt || 0)) return { ok: false, reason: 'before_enabled' };
  if (Number(cfg.reportSkipBeforeTs || 0) && deadline <= Number(cfg.reportSkipBeforeTs || 0)) return { ok: false, reason: 'before_config_change' };
  return { ok: true, reason: 'ok' };
}
function markWacheWeekSkipped(week, reason, cfg = getWacheConfig()) {
  week.weeklyReportPosted = true;
  week.sanctionsProcessed = true;
  week.skippedBecause = reason;
  week.skippedBecauseConfigChangedAt = Number(cfg.reportSkipBeforeTs || cfg.enabledAt || 0);
}
function buildWachePanelEmbed(guild) {
  const cfg = getWacheConfig();
  const active = store.wache?.active && !store.wache.active.closed ? store.wache.active : null;
  const participants = active ? getWacheActiveParticipants() : [];
  const endLabel = active ? formatDateTime(active.endTs) : '—';
  return new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.success : COLORS.warning)
    .setTitle('🟢 Wache Panel')
    .setDescription([
      `Status: **${cfg.enabled ? 'AN' : 'AUS'}**`,
      `Wochenpflicht: **${cfg.requiredMinutesPerWeek} Minuten**`,
      `Entschuldigt ab: **${cfg.absenceExcuseDays} Abmeldetagen/Woche**`,
      `Zeitfenster: **${String(Number(cfg.startHour || 14)).padStart(2, '0')}:00–${Number(cfg.endHour || 24) >= 24 ? '00' : String(Number(cfg.endHour)).padStart(2, '0')}:00 Uhr**`,
      `Auto-Ende: **${cfg.sessionMinutes} Minuten oder Restzeit bis 00:00 Uhr**`,
      active ? `Aktuelle Wache: **läuft** • Ende: **${endLabel}** • Teilnehmer: **${participants.length}/${Math.max(1, Number(cfg.maxParticipants || 5))}**` : 'Aktuelle Wache: **keine**',
    ].join('\n'))
    .setFooter({ text: 'Start = startet Wache • Join = beitreten • Stop = ausstempeln • Status = Übersicht' });
}
function buildWachePanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wache_start').setLabel('Start').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('wache_join').setLabel('Join').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('wache_stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('wache_status').setLabel('Status').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
function buildWacheConfigModal() {
  const cfg = getWacheConfig();
  return new ModalBuilder()
    .setCustomId('wache_config_modal')
    .setTitle('Wache einstellen')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('enabled').setLabel('Status: an oder aus').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.enabled ? 'an' : 'aus')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('required').setLabel('Pflicht Minuten pro Woche').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.requiredMinutesPerWeek))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('absence').setLabel('Entschuldigt ab wie vielen Abmeldetagen?').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.absenceExcuseDays))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('session').setLabel('Auto-Ende nach Minuten').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.sessionMinutes))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sanction').setLabel('Sanktion bei Nichterfüllung ($)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.sanctionAmount)))
    );
}

function buildWacheLeaderConfigEmbed(guild) {
  const cfg = getWacheConfig();
  const dash = cfg.dashboardChannelId ? `<#${cfg.dashboardChannelId}>` : 'nicht gesetzt';
  const report = cfg.reportChannelId ? `<#${cfg.reportChannelId}>` : 'nicht gesetzt';
  return new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.success : COLORS.warning)
    .setTitle('🟢 Wache einstellen')
    .setDescription('Nur Leader können diese Einstellungen ändern. Das öffentliche Wache-Panel hat keine Einstellungsbuttons mehr.')
    .addFields(
      buildInfoField('Status', [cfg.enabled ? 'AN' : 'AUS'], true),
      buildInfoField('Pflicht', [`${cfg.requiredMinutesPerWeek} Minuten/Woche`], true),
      buildInfoField('Entschuldigt ab', [`${cfg.absenceExcuseDays} Abmeldetage/Woche`], true),
      buildInfoField('Zeitfenster', [`${String(Number(cfg.startHour || 14)).padStart(2, '0')}:00 bis ${Number(cfg.endHour || 24) >= 24 ? '00' : String(Number(cfg.endHour)).padStart(2, '0')}:00 Uhr`], true),
      buildInfoField('Auto-Ende', [`${cfg.sessionMinutes} Minuten oder Restzeit bis 00:00`], true),
      buildInfoField('Plätze', [`${Math.max(1, Number(cfg.maxParticipants || 5))}`], true),
      buildInfoField('Leaderschaft-Pflichten', [areLeadershipDutiesEnabled() ? 'AN – Leaderschaft wird bei Abgabe/Wache berücksichtigt' : 'AUS – Leaderschaft wird nicht gelistet und nicht sanktioniert'], false),
      buildInfoField('Kanäle', [`Dashboard: ${dash}`, `Berichte: ${report}`], false),
    );
}
function buildWacheLeaderConfigComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wache_cfg_toggle').setLabel('AN/AUS umschalten').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('wache_cfg_values').setLabel('Werte ändern').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wache_cfg_window').setLabel('Zeitfenster ändern').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wache_cfg_channels').setLabel('Kanäle setzen').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wache_cfg_refresh').setLabel('Aktualisieren').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wache_cfg_leadership_duties').setLabel(getLeadershipDutyLabel()).setStyle(getLeadershipDutyStyle()),
    ),
  ];
}
function buildWacheValuesModal() {
  const cfg = getWacheConfig();
  return new ModalBuilder()
    .setCustomId('wache_values_modal')
    .setTitle('Wache Werte ändern')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('required').setLabel('Pflicht Minuten pro Woche').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.requiredMinutesPerWeek))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('absence').setLabel('Entschuldigt ab Abmeldetagen/Woche').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.absenceExcuseDays))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('session').setLabel('Auto-Ende Minuten').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.sessionMinutes))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('places').setLabel('Max. Teilnehmer/Plätze').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.maxParticipants || 5))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('sanction').setLabel('Sanktion bei Nichterfüllung ($)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.sanctionAmount)))
    );
}
function buildWacheWindowModal() {
  const cfg = getWacheConfig();
  return new ModalBuilder()
    .setCustomId('wache_window_modal')
    .setTitle('Wache Zeitfenster ändern')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('startHour').setLabel('Start-Stunde (0-23)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(Number(cfg.startHour || 14)))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('endHour').setLabel('End-Stunde (1-24, 24 = 00:00)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(Number(cfg.endHour || 24))))
    );
}
function buildWacheChannelsModal() {
  const cfg = getWacheConfig();
  return new ModalBuilder()
    .setCustomId('wache_channels_modal')
    .setTitle('Wache Kanäle setzen')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dashboard').setLabel('Dashboard Kanal ID').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.dashboardChannelId || ''))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('report').setLabel('Berichte Kanal ID').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.reportChannelId || '')))
    );
}
function normalizeChannelIdInput(input) {
  return String(input || '').trim().replace(/[<#>]/g, '');
}
async function refreshWacheLeaderConfigInteraction(interaction, text = null) {
  const payload = { embeds: [buildWacheLeaderConfigEmbed(interaction.guild)], components: buildWacheLeaderConfigComponents(), flags: 64 };
  if (text) payload.content = text;
  return safeReplyOnce(interaction, payload);
}
async function startOrJoinWache(guild, userId, startNew = false) {
  const cfg = getWacheConfig();
  if (!cfg.enabled) return { ok: false, message: 'Wache-System ist aktuell deaktiviert.' };
  ensureWacheStoreShape();

  const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch(userId).catch(() => null);
  const routeRoleIds = getWacheRequiredRoleIds();
  const hasRouteRole = Boolean(member && routeRoleIds.length && member.roles.cache.some(role => routeRoleIds.includes(role.id)));
  const hasLeaderRole = Boolean(member && hasLeadership(member));
  if (!member || (!hasRouteRole && !hasLeaderRole)) {
    return { ok: false, message: 'Nur Mitglieder mit der Routen-Rolle oder Leaderschaft können Wache starten oder beitreten.' };
  }
  if (seedRoleTrackingForMember(member)) saveAll();

  const windowStatus = getWacheStartWindowStatus(now());
  if (!windowStatus.ok) return { ok: false, message: windowStatus.message };
  if (!store.wache.active || store.wache.active.closed || Number(store.wache.active.endTs || 0) <= now()) {
    const startTs = now();
    store.wache.active = { id: uid('wache'), startTs, endTs: getWacheSessionEndTs(startTs), closed: false, participants: {}, createdBy: userId };
  }
  const active = store.wache.active;
  active.participants ||= {};
  if (active.participants[userId] && !active.participants[userId].endTs) return { ok: true, message: `Du bist bereits in der Wache. Restzeit: ${Math.max(0, Math.ceil((active.endTs - now())/60000))} min` };
  active.participants[userId] = { startTs: now(), joinedBy: userId };
  saveAll();
  return { ok: true, message: `🟢 Beigetreten. Restzeit: ${Math.max(0, Math.ceil((active.endTs - now())/60000))} min` };
}
async function stopWacheForUser(userId, reason = 'stop') {
  const active = store.wache?.active;
  if (!active || active.closed || !active.participants?.[userId] || active.participants[userId].endTs) return { ok: false, message: 'Du bist aktuell in keiner Wache eingestempelt.' };
  const row = active.participants[userId];
  row.endTs = Math.min(now(), Number(active.endTs || now()));
  row.minutes = addWacheMinutes(userId, row.startTs, row.endTs, reason);
  saveAll();
  return { ok: true, message: `🔴 Ausgestempelt. Gutgeschrieben: ${row.minutes} min` };
}
async function closeActiveWacheIfDue(guild) {
  ensureWacheStoreShape();
  const active = store.wache.active;
  if (!active || active.closed || Number(active.endTs || 0) > now()) return false;
  for (const [userId, row] of Object.entries(active.participants || {})) {
    if (!row.endTs) {
      row.endTs = Number(active.endTs || now());
      row.minutes = addWacheMinutes(userId, row.startTs, row.endTs, 'auto');
    }
  }
  active.closed = true;
  active.closedAt = now();
  const week = getWacheWeek(getWacheWeekKeyFromTs(active.startTs));
  week.sessions.push({ id: active.id, startTs: active.startTs, endTs: active.endTs, participants: Object.keys(active.participants || {}).length });
  store.wache.active = null;
  saveAll();
  await upsertWacheDashboardMessage(guild).catch(() => null);
  return true;
}
async function buildWacheStatusEmbed(guild, weekKey = currentWeekKey()) {
  const { rows } = await buildWacheSummary(guild, weekKey);
  const week = getWacheWeek(weekKey);
  const dayLabels = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const dayMap = Object.fromEntries(dayLabels.map(day => [day, []]));

  const formatWacheTime = ts => new Date(Number(ts || 0)).toLocaleTimeString('de-DE', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
  const getWacheDayLabel = ts => dayLabels[(tsToTzDate(Number(ts || 0)).getDay() + 6) % 7] || 'Mo';
  const pushWacheEntry = (userId, entry, activeLabel = null) => {
    const startTs = Number(entry?.startTs || 0);
    if (!userId || !startTs) return;
    const endTs = Number(entry?.endTs || 0);
    const minutes = Number(entry?.minutes || (endTs ? Math.max(0, Math.round((endTs - startTs) / 60000)) : 0));
    const day = getWacheDayLabel(startTs);
    const endLabel = activeLabel || (endTs ? formatWacheTime(endTs) : 'läuft');
    const minuteLabel = minutes > 0 ? ` • ${minutes} min` : '';
    dayMap[day].push({
      startTs,
      text: `• ${getUserDisplay(guild, userId)} ${formatWacheTime(startTs)}–${endLabel}${minuteLabel}`,
    });
  };

  for (const [userId, stats] of Object.entries(week.users || {})) {
    for (const entry of (stats.entries || [])) pushWacheEntry(userId, entry);
  }

  const active = store.wache?.active && !store.wache.active.closed ? store.wache.active : null;
  if (active && getWacheWeekKeyFromTs(active.startTs) === weekKey) {
    for (const [userId, entry] of Object.entries(active.participants || {})) {
      if (!entry?.endTs) pushWacheEntry(userId, { ...entry, minutes: Math.max(0, Math.round((now() - Number(entry.startTs || now())) / 60000)) }, 'läuft');
    }
  }

  const fields = dayLabels.map(day => {
    const lines = dayMap[day]
      .sort((a, b) => a.startTs - b.startTs)
      .map(entry => entry.text);
    return buildInfoField(day, lines.length ? lines : ['—'], true);
  });

  // Ranking nicht aus der Pflichtliste bauen, sondern direkt aus den gespeicherten Wache-Daten.
  // So erscheinen auch User korrekt, die Wache gemacht haben, aber wegen Rolle/Pflicht gerade nicht in buildWacheSummary() auftauchen.
  const rankingRows = Object.entries(week.users || {})
    .map(([userId, stats]) => ({
      userId,
      minutes: Number(stats?.totalMinutes || 0),
      count: Number(stats?.count || (Array.isArray(stats?.entries) ? stats.entries.length : 0)),
    }))
    .filter(row => row.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || getUserDisplay(guild, a.userId).localeCompare(getUserDisplay(guild, b.userId), 'de'));

  const ranking = rankingRows
    .slice(0, 15)
    .map((row, index) => `${index + 1}. ${getUserDisplay(guild, row.userId)} — **${row.minutes} min** | Wachen: ${row.count}`);

  fields.push(buildInfoField('🏆 Ranking', ranking.length ? ranking : ['—'], false));

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`🟢 Wache Status • ${weekKey}`)
    .addFields(fields)
    .setFooter({ text: 'Wache • Minuten werden beim Stop oder Auto-Ende gutgeschrieben' });
}

async function cleanupDuplicateWacheStatusMessages(guild, channel, keepMessageId = null, weekKey = currentWeekKey()) {
  if (!guild || !channel?.messages?.fetch) return;
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botId = client?.user?.id;
    const statusTitle = `🟢 Wache Status • ${weekKey}`;
    for (const msg of messages.values()) {
      if (keepMessageId && msg.id === keepMessageId) continue;
      if (botId && msg.author?.id !== botId) continue;
      const hasStatusEmbed = Array.isArray(msg.embeds) && msg.embeds.some(embed => String(embed?.title || '') === statusTitle);
      if (hasStatusEmbed) await msg.delete().catch(() => null);
    }
  } catch (_) {}
}

async function upsertWacheStatusMessage(guild, channel = null, weekKey = currentWeekKey()) {
  if (!guild) return null;
  ensureWacheStoreShape();
  const target = channel || getWacheDashboardChannel(guild) || getStatsChannel(guild);
  if (!target || !target.isTextBased?.()) return null;

  const payload = { embeds: [await buildWacheStatusEmbed(guild, weekKey)] };
  const nextHash = payloadHash(payload);
  const saved = store.wache.statusMessage;

  if (saved?.channelId && saved?.messageId) {
    const savedChannel = guild.channels.cache.get(saved.channelId);
    if (savedChannel) {
      try {
        const msg = await savedChannel.messages.fetch(saved.messageId);
        if (msg) {
          if (saved.payloadHash !== nextHash) await safeMessageEdit(msg, payload, 'wache.status.edit');
          store.wache.statusMessage = { channelId: msg.channel.id, messageId: msg.id, weekKey, payloadHash: nextHash, updatedAt: now() };
          saveAll();
          await cleanupDuplicateWacheStatusMessages(guild, msg.channel, msg.id, weekKey);
          return msg;
        }
      } catch (_) {}
    }
  }

  await cleanupDuplicateWacheStatusMessages(guild, target, null, weekKey);
  const msg = await safeChannelSend(target, payload, 'wache.status.send');
  if (msg) {
    store.wache.statusMessage = { channelId: msg.channel.id, messageId: msg.id, weekKey, payloadHash: nextHash, updatedAt: now() };
    saveAll();
    await cleanupDuplicateWacheStatusMessages(guild, msg.channel, msg.id, weekKey);
  }
  return msg;
}

async function processWacheWeeklyReport(weekKey = previousWeekKey(currentWeekKey())) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const cfg = getWacheConfig();
  const week = getWacheWeek(weekKey);
  if (week.weeklyReportPosted && week.sanctionsProcessed) return;

  const processState = canProcessWacheWeekForReportOrSanctions(weekKey, cfg);
  if (!processState.ok) {
    if (['disabled', 'before_enabled', 'before_config_change'].includes(processState.reason)) {
      markWacheWeekSkipped(week, processState.reason, cfg);
      saveAll();
    }
    return;
  }

  // Wochenberichte/Sanktionen nutzen einen frischen Member-Fetch, damit Rollenstände nicht aus altem Cache kommen.
  await ensureGuildMembersCached(guild, true).catch(() => null);
  const summary = await buildWacheSummary(guild, weekKey);

  if (!week.sanctionsProcessed && Number(cfg.sanctionAmount || 0) > 0) {
    for (const row of summary.rows) {
      if (row.fulfilled || row.excused) continue;
      const member = guild.members.cache.get(row.userId);
      if (!member || !isWacheMemberRequiredForWeek(member, weekKey)) continue;
      if (hasConflictingOpenSanction(row.userId, 'wache_weekly', weekKey, 'wache')) continue;
      await createSanctionApproval(guild, {
        userId: row.userId,
        issuerId: 'system',
        catalogNo: '29',
        penaltyType: 'Schwarzgeld',
        amount: Number(cfg.sanctionAmount || 0),
        reason: `Wache-Pflicht nicht erfüllt: ${row.minutes}/${summary.required} Minuten in ${weekKey}`,
        source: 'wache_weekly',
        relatedWeek: weekKey,
        relatedCategory: 'wache',
        executeAt: now() + (APPROVAL_TIMEOUT_SECONDS * 1000),
      });
    }
    week.sanctionsProcessed = true;
  }

  if (!week.weeklyReportPosted) {
    const channel = getWacheReportChannel(guild);
    if (channel) await safeChannelSend(channel, { embeds: [await buildWacheStatusEmbed(guild, weekKey)] }, 'wache.weekly.report');
    week.weeklyReportPosted = true;
  }
  saveAll();
}

async function postWacheMonthlyReport() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild || !getWacheConfig().enabled) return;
  const nowDate = getTzDate();
  const monthKey = getMonthKey(nowDate);
  const tomorrowMonthKey = getMonthKey(new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1));
  if (tomorrowMonthKey === monthKey) return;
  if (nowDate.getHours() !== 23 || nowDate.getMinutes() !== 59) return;
  const month = getWacheMonth(monthKey);
  if (month.posted) return;
  const weeks = Object.keys(store.wache.weeks || {}).filter(w => getRelevantMonthKeysForWeek(w).includes(monthKey)).sort();
  const totals = {};
  for (const weekKey of weeks) {
    const week = getWacheWeek(weekKey);
    if (!month.weeks.includes(weekKey)) month.weeks.push(weekKey);
    for (const [userId, row] of Object.entries(week.users || {})) {
      totals[userId] ||= { minutes: 0, count: 0 };
      totals[userId].minutes += Number(row.totalMinutes || 0);
      totals[userId].count += Number(row.count || 0);
    }
  }
  const lines = Object.entries(totals).sort((a,b)=>b[1].minutes-a[1].minutes).slice(0, 20).map(([userId, row], idx)=>`${idx+1}. ${getUserDisplay(guild, userId)} — **${row.minutes} min** | Wachen: ${row.count}`);
  const channel = getWacheReportChannel(guild);
  if (channel) await safeChannelSend(channel, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`🟢 Wache Monatsbericht • ${monthKey}`).setDescription(lines.join('\n') || 'Keine Wache-Daten.').setFooter({ text: 'Wache Monatsbericht • automatisch erstellt' })] }, 'wache.monthly.report');
  month.posted = true;
  saveAll();
}
async function processWacheReports() {
  await closeActiveWacheIfDue(client.guilds.cache.get(GUILD_ID));
  await processWacheWeeklyReport(previousWeekKey(currentWeekKey()));
  await postWacheMonthlyReport();
}

// =========================================================
// SANCTIONS HELPERS
// =========================================================
function createSanction({ userId, issuerId, catalogNo, penaltyType, amount, extraReason, extraDays = 0, source = 'manual', relatedWeek = null, relatedCategory = null, relatedTermId = null }) {
  if (!userId) throw new Error('Sanktion ohne Mitglied wurde blockiert.');
  catalogNo = String(catalogNo || '').padStart(2, '0');
  if (!getSanctionCatalogLabel(catalogNo)) throw new Error(`Ungültige Katalognummer: ${catalogNo}`);
  amount = safePositiveAmount(amount, 0);
  extraDays = Math.max(0, safePositiveAmount(extraDays, 0));
  if (relatedWeek && !sanitizeWeekKey(relatedWeek)) throw new Error(`Ungültige Woche: ${relatedWeek}`);
  const existing = store.sanctions.items.find(item => !item.paid && !['bezahlt','storniert'].includes(item.status)
    && item.userId === userId
    && item.source === source
    && (item.relatedWeek || null) === (relatedWeek || null)
    && (item.relatedCategory || null) === (relatedCategory || null)
    && (item.relatedTermId || null) === (relatedTermId || null));
  if (existing) return existing;
  const catalogLabel = getSanctionCatalogLabel(catalogNo) || 'Unbekannt';
  const escalationCfg = getRuleConfig('sanctionEscalation');
  const baseDueDays = escalationCfg.enabled ? Number(escalationCfg.dueDays || 0) : 3;
  const dueAt = penaltyType === 'Bloodout' ? null : addDaysTs(now(), baseDueDays + Number(extraDays || 0));
  const sanction = {
    id: uid('san'),
    userId,
    issuerId,
    catalogNo,
    catalogLabel,
    penaltyType,
    amount: penaltyType === 'Bloodout' ? 0 : Number(amount || 0),
    extraReason: extraReason || '',
    createdAt: now(),
    appealUntil: addDaysTs(now(), 1),
    appealStatus: 'none',
    dueAt,
    firstDueAt: dueAt,
    escalationRule: penaltyType === 'Bloodout' ? 'bloodout_direct' : '3d_surcharge_2d_bloodout',
    status: penaltyType === 'Bloodout' ? 'bloodout' : 'offen',
    paid: false,
    paidAt: null,
    paidBy: null,
    paused: false,
    pausedAt: null,
    surchargeApplied: false,
    surchargeAt: null,
    bloodoutAnnounced: penaltyType === 'Bloodout',
    bloodoutAt: penaltyType === 'Bloodout' ? now() : null,
    lastReminderAt: 0,
    lastReminderKey: '',
    lastLeaderReminderKey: '',
    publicMessageId: null,
    publicChannelId: null,
    source,
    relatedWeek,
    relatedCategory,
    relatedTermId,
  };
  store.sanctions.items.push(sanction);
  appendAuditLog('sanktion_erstellt', sanction.issuedBy || sanction.createdBy || 'system', sanction.userId, { sanctionId: sanction.id, source: sanction.source, relatedWeek: sanction.relatedWeek, relatedCategory: sanction.relatedCategory });
  invalidateStatsCache('sanction_created');
  saveAll();
  return sanction;
}
function getOpenSanctionsForUser(userId) {
  return store.sanctions.items.filter(item => item.userId === userId && !item.paid && item.status !== 'bezahlt');
}
function sanctionAmountLabel(sanction) {
  if (sanction.penaltyType === 'Bloodout') return 'Bloodout';
  if (sanction.penaltyType === 'Grüngeld' || sanction.penaltyType === 'Schwarzgeld') {
    return `${formatCurrency(sanction.amount)} ${sanction.penaltyType}`;
  }
  return `${Number(sanction.amount).toLocaleString('de-DE')} ${sanction.penaltyType}`;
}
function sanctionStatusLabel(sanction) {
  if (sanction.paid || sanction.status === 'bezahlt') return 'Bezahlt';
  if (sanction.paused) return 'Timer pausiert';
  if (sanction.status === 'bloodout') return sanction.bloodoutAnnounced ? 'Bloodout angekündigt' : 'Bloodout';
  if (sanction.status === 'zuschlag') return 'Zuschlag offen';
  return 'Offen';
}
function buildSanctionPublicEmbed(guild, sanction) {
  const victim = getUserDisplay(guild, sanction.userId);
  const issuer = sanction.issuerId ? getUserDisplay(guild, sanction.issuerId) : 'System';
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle(`⚖️ Sanktion #${String(sanction.id).replace(/^san_?/, '')}`)
    .setDescription(`Gegen **${victim}** wurde eine Sanktion ausgestellt.`)
    .addFields(
      buildInfoField('📌 Details', [
        `Katalog: **${sanction.catalogNo} – ${sanction.catalogLabel}**`,
        sanction.extraReason ? `Grund: ${sanction.extraReason}` : null,
        `Strafe: **${sanctionAmountLabel(sanction)}**`,
      ]),
      buildInfoField('📅 Fristen & Status', [
        `Status: **${sanctionStatusLabel(sanction)}**`,
        sanction.dueAt ? `Frist: ${formatDueLabel(sanction.dueAt)}` : null,
        sanction.surchargeApplied ? 'Zuschlag offen: **+100.000$ Schwarzgeld**' : null,
        sanction.bloodoutAt ? `Bloodout-Zeitpunkt: ${formatDueLabel(sanction.bloodoutAt)}` : null,
      ]),
      buildInfoField('👤 Ausgestellt von', [issuer], true),
    )
    .setFooter({ text: `Erstellt am ${formatDateTime(sanction.createdAt)}` });
}
function buildSanctionPublicComponents(sanction) {
  const isPaid = sanction.paid || sanction.status === 'bezahlt';
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanction_card_paid:${sanction.id}`).setLabel('✅ Bezahlt').setStyle(ButtonStyle.Success).setDisabled(isPaid),
      new ButtonBuilder().setCustomId(`sanction_card_pause:${sanction.id}`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary).setDisabled(isPaid || sanction.paused),
      new ButtonBuilder().setCustomId(`sanction_card_resume:${sanction.id}`).setLabel('▶️ Weiter').setStyle(ButtonStyle.Primary).setDisabled(isPaid || !sanction.paused),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanction_card_resend:${sanction.id}`).setLabel('✉️ DM erneut').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function ensureOpenSanctionsSessionShape() {
  if (!store.sessions.openSanctions || typeof store.sessions.openSanctions !== 'object') store.sessions.openSanctions = {};
}
function getOpenSanctionsList() {
  return (store.sanctions.items || [])
    .filter(item => !item.paid && !['bezahlt','storniert','gelöscht','geloescht'].includes(String(item.status || '').toLowerCase()))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}
function buildLeaderOpenSanctionsView(guild, sessionId, page = 0, selectedId = '') {
  ensureOpenSanctionsSessionShape();
  const items = getOpenSanctionsList();
  const pages = chunk(items, 10);
  const safePage = Math.max(0, Math.min(Number(page || 0), Math.max(0, pages.length - 1)));
  const pageItems = pages[safePage] || [];
  const selected = items.find(item => item.id === selectedId) || pageItems[0] || null;
  store.sessions.openSanctions[sessionId] = { page: safePage, selectedId: selected?.id || '', createdAt: now() };
  saveAll();

  const lines = pageItems.map((sanction, idx) => {
    const nr = safePage * 10 + idx + 1;
    const marker = selected?.id === sanction.id ? '➡️ ' : '';
    return `${marker}${nr}. **${getUserDisplay(guild, sanction.userId)}** • ${sanctionAmountLabel(sanction)} • ${sanction.extraReason || sanction.catalogLabel || 'Ohne Grund'} • ${sanctionStatusLabel(sanction)}`;
  });
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⚖️ Offene Sanktionen • Leader')
    .setDescription(lines.length ? lines.join('\n').slice(0, 3500) : 'Keine offenen Sanktionen vorhanden.')
    .addFields(selected ? [
      buildInfoField('Ausgewählt', [
        `Mitglied: **${getUserDisplay(guild, selected.userId)}**`,
        `Höhe / Art: **${sanctionAmountLabel(selected)}**`,
        `Grund: ${selected.extraReason || selected.catalogLabel || '—'}`,
        `Status: **${sanctionStatusLabel(selected)}**`,
        selected.dueAt ? `Frist: ${formatDueLabel(selected.dueAt)}` : null,
      ], false),
    ] : [])
    .setFooter({ text: `Seite ${safePage + 1}/${Math.max(1, pages.length)} • Aktionen nur für Leader` })
    .setTimestamp(new Date());

  const components = [];
  if (pageItems.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`open_sanctions_select:${sessionId}`)
      .setPlaceholder('Offene Sanktion auswählen')
      .addOptions(pageItems.map(sanction => ({
        label: (getUserDisplay(guild, sanction.userId) || sanction.userId).slice(0, 75),
        description: `${sanctionAmountLabel(sanction)} • ${(sanction.extraReason || sanction.catalogLabel || '').slice(0, 55)}`.slice(0, 100),
        value: sanction.id,
        default: selected?.id === sanction.id,
      })));
    components.push(new ActionRowBuilder().addComponents(select));
    const isPaid = selected?.paid || selected?.status === 'bezahlt';
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`open_sanctions_action:${sessionId}:paid`).setLabel('✅ Bezahlt').setStyle(ButtonStyle.Success).setDisabled(!selected || isPaid),
      new ButtonBuilder().setCustomId(`open_sanctions_action:${sessionId}:pause`).setLabel('⏸️ Pause').setStyle(ButtonStyle.Secondary).setDisabled(!selected || isPaid || selected.paused),
      new ButtonBuilder().setCustomId(`open_sanctions_action:${sessionId}:resume`).setLabel('▶️ Weiter').setStyle(ButtonStyle.Primary).setDisabled(!selected || isPaid || !selected.paused),
      new ButtonBuilder().setCustomId(`open_sanctions_action:${sessionId}:delete`).setLabel('🗑️ Löschen').setStyle(ButtonStyle.Danger).setDisabled(!selected),
      new ButtonBuilder().setCustomId(`open_sanctions_action:${sessionId}:resend`).setLabel('✉️ DM').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`open_sanctions_page:${sessionId}:prev`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`open_sanctions_page:${sessionId}:next`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= Math.max(1, pages.length) - 1),
    new ButtonBuilder().setCustomId(`open_sanctions_page:${sessionId}:refresh`).setLabel('🔄 Aktualisieren').setStyle(ButtonStyle.Primary),
  ));
  return { embeds: [embed], components };
}
async function updateSanctionPublicMessage(guild, sanction) {
  if (!sanction.publicChannelId || !sanction.publicMessageId) return false;
  const channel = guild.channels.cache.get(sanction.publicChannelId);
  if (!channel) return false;
  const message = await withDiscordRetry(() => channel.messages.fetch(sanction.publicMessageId)).catch(() => null);
  if (!message) return false;
  await safeMessageEdit(message, { embeds: [buildSanctionPublicEmbed(guild, sanction)], components: [] }, 'sanction.public.edit').catch(() => null);
  return true;
}
async function postSanctionPublic(guild, sanction) {
  const channel = guild.channels.cache.get(store.config.channels.ausgeteilte);
  if (!channel) return;
  const edited = await updateSanctionPublicMessage(guild, sanction);
  if (edited) return;
  const message = await safeChannelSend(channel, { embeds: [buildSanctionPublicEmbed(guild, sanction)], components: [] }, 'sanction.public.send').catch(() => null);
  if (!message) return;
  sanction.publicMessageId = message.id;
  sanction.publicChannelId = channel.id;
  saveAll();
}
function buildSanctionIssuedDM(guild, sanction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('⚖️ Du hast eine Sanktion erhalten')
    .setDescription('Bitte begleiche oder erfülle die Sanktion fristgerecht, um weitere Eskalation zu vermeiden.')
    .addFields(
      buildInfoField('📌 Sanktion', [
        `${sanction.catalogNo} – ${sanction.catalogLabel}`,
        sanction.extraReason ? `Grund: ${sanction.extraReason}` : null,
      ], false),
      buildInfoField('💰 Strafe', [sanctionAmountLabel(sanction)], true),
      buildInfoField('⏳ Frist', [sanction.dueAt ? formatDueLabel(sanction.dueAt) : '—'], true),
      buildInfoField('ℹ️ Hinweis', ['Bei Nichtzahlung nach 3 Tagen folgt +100.000$ und danach die Bloodout-Ankündigung.'], false),
    )
    .setFooter({ text: 'Sanktionen • persönliche Mitteilung' })
    .setTimestamp(new Date());
  return { embeds: [embed], components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sanction_appeal:${sanction.id}`).setLabel('📝 Einspruch einlegen').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`dm_ack:sanktionen:${simpleHashText(sanction.id).slice(0,16)}`).setLabel('✅ Gesehen').setStyle(ButtonStyle.Success),
    )
  ] };
}
function buildSanctionReminderDM(sanction, text) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🔔 Erinnerung zu deiner Sanktion')
    .setDescription(text)
    .addFields(
      buildInfoField('📌 Sanktion', [`${sanction.catalogNo} – ${sanction.catalogLabel}`], false),
      buildInfoField('💰 Menge / Betrag', [sanctionAmountLabel(sanction)], true),
      buildInfoField('⏳ Fällig bis', [sanction.dueAt ? formatDueLabel(sanction.dueAt) : '—'], true),
      sanction.extraReason ? buildInfoField('📝 Grund', [sanction.extraReason], false) : null,
    ).setFooter({ text: 'Sanktionen • Erinnerung' }).setTimestamp(new Date());
  // remove null fields
  embed.data.fields = (embed.data.fields || []).filter(Boolean);
  return { embeds: [embed] };
}

function ensureSanctionAppealsShape() {
  if (!store.sanctions.appeals || typeof store.sanctions.appeals !== 'object') store.sanctions.appeals = {};
}
function getSanctionAppealHours() {
  ensureConfigShape();
  if (typeof store.config.settings.sanctionAppealHours !== 'number') store.config.settings.sanctionAppealHours = 24;
  return store.config.settings.sanctionAppealHours;
}
function canAppealSanction(sanction) {
  if (!sanction || sanction.paid || sanction.status === 'bezahlt' || sanction.status === 'storniert') return false;
  const until = Number(sanction.appealUntil || (Number(sanction.createdAt || 0) + getSanctionAppealHours() * 60 * 60 * 1000));
  return now() <= until;
}
async function createSanctionAppeal(guild, sanctionId, userId, text) {
  ensureSanctionAppealsShape();
  const sanction = (store.sanctions.items || []).find(item => item.id === sanctionId);
  if (!sanction) return { ok: false, message: 'Sanktion nicht gefunden.' };
  if (String(sanction.userId) !== String(userId)) return { ok: false, message: 'Du kannst nur für deine eigene Sanktion Einspruch einlegen.' };
  if (!canAppealSanction(sanction)) return { ok: false, message: 'Die Einspruchsfrist ist abgelaufen.' };
  const existing = Object.values(store.sanctions.appeals).find(a => a.sanctionId === sanctionId && !['abgelehnt','angenommen','geschlossen'].includes(a.status));
  if (existing) return { ok: false, message: 'Für diese Sanktion gibt es bereits einen offenen Einspruch.' };
  const appeal = { id: uid('appeal'), sanctionId, userId, text: String(text || '').slice(0, 1000), status: 'offen', createdAt: now() };
  store.sanctions.appeals[appeal.id] = appeal;
  sanction.appealStatus = 'offen';
  sanction.appealId = appeal.id;
  saveAll();
  const channel = getLogChannel(guild) || getStatsChannel(guild);
  if (channel) {
    const leaders = getLeadershipRoleIds().map(id => `<@&${id}>`).join(' ');
    await safeChannelSend(channel, { content: leaders || undefined, embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle('📝 Neuer Einspruch gegen Sanktion').addFields(
      buildInfoField('Mitglied', [`<@${userId}>`], true),
      buildInfoField('Sanktion', [sanctionId], true),
      buildInfoField('Begründung', [appeal.text || '—'], false),
    ).setTimestamp(new Date())] }, 'sanction.appeal.log').catch(() => null);
  }
  return { ok: true, message: 'Einspruch wurde eingereicht und an die Leitung gemeldet.' };
}
async function sendSanctionIssuedDM(guild, sanction) {
  if (getActiveAbsence(sanction.userId, 'all')) return;
  const user = await client.users.fetch(sanction.userId).catch(() => null);
  if (!user) return;
  await sendDM(user, buildSanctionIssuedDM(guild, sanction), { area: 'sanktionen', noticeKey: `sanction:${sanction.id}:issued` });
}
async function sendSanctionLeaderReminder(guild, sanction, text) {
  ensureConfigShape();
  if (!store.config.settings.leaderReminderDmEnabled) return;
  const leaders = await getLeadershipUsers(guild);
  if (!leaders.length) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('👑 Leader Erinnerung • offene Sanktion')
    .setDescription('Eine Sanktion benötigt Aufmerksamkeit.')
    .addFields(
      buildInfoField('👤 Mitglied', [getUserDisplay(guild, sanction.userId)], true),
      buildInfoField('📌 Sanktion', [`${sanction.catalogNo} – ${sanction.catalogLabel}`], true),
      buildInfoField('💰 Betrag / Art', [sanctionAmountLabel(sanction)], true),
      buildInfoField('⏳ Frist', [sanction.dueAt ? formatDueLabel(sanction.dueAt) : '—'], true),
      text ? buildInfoField('📝 Hinweis', [text], false) : null,
    );
  embed.data.fields = (embed.data.fields || []).filter(Boolean);
  embed.setFooter({ text: `Sanktions-ID: ${sanction.id}` }).setTimestamp(new Date());
  for (const leader of leaders) await sendDM(leader, { embeds: [embed] });
}
function markSanctionPaid(sanctionId, byId) {
  const sanction = store.sanctions.items.find(item => item.id === sanctionId);
  if (!sanction) return null;
  sanction.paid = true;
  sanction.paidAt = now();
  sanction.paidBy = byId;
  appendAuditLog('sanktion_bezahlt', byId, sanction.userId, { sanctionId: sanction.id });
  invalidateStatsCache('sanction_paid');
  sanction.status = 'bezahlt';
  sanction.paused = false;
  syncSanctionPaidCashboxTransaction(sanction, byId, 'Sanktion bezahlt');
  saveAll();
  return sanction;
}

function getAutoSanctionSuppressionKey(source, userId, weekKey = null, category = null, termId = null) {
  return [String(source || 'unknown'), String(userId || ''), String(weekKey || ''), String(category || ''), String(termId || '')].join('|');
}
function isAutoSanctionSuppressed(source, userId, weekKey = null, category = null, termId = null) {
  ensureSessionShape();
  const key = getAutoSanctionSuppressionKey(source, userId, weekKey, category, termId);
  return !!store.sessions.autoSanctionSuppressions?.[key];
}
function suppressAutoSanction(source, userId, weekKey = null, category = null, termId = null, byId = null, reason = 'manual_no') {
  ensureSessionShape();
  const key = getAutoSanctionSuppressionKey(source, userId, weekKey, category, termId);
  store.sessions.autoSanctionSuppressions[key] = {
    key,
    source: String(source || 'unknown'),
    userId: String(userId || ''),
    relatedWeek: weekKey || null,
    relatedCategory: category || null,
    relatedTermId: termId || null,
    suppressedAt: now(),
    suppressedBy: byId || null,
    reason: reason || 'manual_no',
  };
  return store.sessions.autoSanctionSuppressions[key];
}

async function shouldAutoSanctionAbgabeUser(guild, userId, category, weekKey) {
  if (!isAbgabeCategoryActiveForWeek(category, weekKey)) return false;
  if (!isUserRequiredForAbgabeWeek(guild, userId, category, weekKey, { reason: 'auto-sanction-check' })) return false;
  if (isAutoSanctionSuppressed('abgabe-auto', userId, weekKey, category, null)) return false;
  const member = guild?.members?.cache?.get(userId) || null;
  if (getActiveAbsence(userId, 'abgabe')) return false;
  if (member && isExcusedDueToLateRoleAssignment(member, category, weekKey)) return false;
  if (isUserFullyExcusedForWeek(userId, weekKey)) return false;
  if (findPrepaymentSource(userId, category, weekKey)) return false;
  const entry = getAbgabeStatusForWeek(guild, weekKey, category, userId);
  if (entry.sanctionIssued) return false;
  if (['entschuldigt', 'vorausgezahlt', 'abgegeben', 'zu_spaet'].includes(entry.status)) return false;
  return ['warnphase', 'spaeter_abgabe', 'offen', 'nicht_abgegeben'].includes(entry.status);
}

async function issueAutoAbgabeSanction(guild, userId, category, weekKey, reasonSuffix = '') {
  ensureConfigShape();
  if (!store.config.settings.autoSanctionsEnabled) return null;
  const rule = getRuleConfig('abgabeAutoSanction');
  if (!rule.enabled) return null;
  if (!isAbgabeAutoSanctionDue(category, weekKey)) return null;
  if (isAutoSanctionSuppressed('abgabe-auto', userId, weekKey, category, null)) return null;
  if (!isAbgabeCategoryActiveForWeek(category, weekKey)) return null;
  if (!isUserRequiredForAbgabeWeek(guild, userId, category, weekKey, { reason: 'auto-sanction-issue' })) return null;
  if (getActiveAbsence(userId, 'abgabe')) return null;
  const member = guild?.members?.cache?.get(userId) || null;
  if (member && isExcusedDueToLateRoleAssignment(member, category, weekKey)) return null;
  if (isUserFullyExcusedForWeek(userId, weekKey)) return null;
  const prepay = findPrepaymentSource(userId, category, weekKey);
  if (prepay) return null;
  const entry = getAbgabeStatusForWeek(guild, weekKey, category, userId);
  if (entry.sanctionIssued) return null;
  if (['entschuldigt', 'vorausgezahlt', 'abgegeben', 'zu_spaet'].includes(entry.status)) return null;
  const alreadyPending = Object.values(store.sessions.pendingSanctionApprovals || {}).some(item => !item.resolved && item.source === 'abgabe-auto' && item.userId === userId && item.relatedWeek === weekKey && item.relatedCategory === category);
  if (alreadyPending) return null;
  const reason = `${ABGABEN[category].label} für ${weekKey} offen${reasonSuffix ? ` – ${reasonSuffix}` : ''}`;
  return createSanctionApproval(guild, {
    userId,
    source: 'abgabe-auto',
    reason,
    catalogNo: rule.catalogNo || '29',
    penaltyType: rule.penaltyType || 'Schwarzgeld',
    amount: Number(rule.amount || 100000),
    relatedWeek: weekKey,
    relatedCategory: category,
    entryMarker: true,
    executeAt: now() + (APPROVAL_TIMEOUT_SECONDS * 1000),
  });
}

async function processAbgabeAutoSanctions() {
  if (!isAutomationEnabled('abgabeAutoSanctions')) return { checked: 0, issued: 0 };
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return { checked: 0, issued: 0, skipped: 'no_guild' };
  await ensureGuildMembersCached(guild);
  const rule = getRuleConfig('abgabeAutoSanction');
  if (!store.config.settings.autoSanctionsEnabled || !rule.enabled) return { checked: 0, issued: 0, skipped: 'disabled' };

  let checked = 0;
  let issued = 0;
  for (const weekKey of getRecentAbgabeWeeksForAutomation(12)) {
    touchAbgabeAutomationWeek(weekKey);
    // Auch die aktuelle Woche wird geprüft, falls eine Abgabefrist + Nachfrist
    // bereits innerhalb dieser Woche abgelaufen ist.
    // Stellt sicher, dass nachträgliche Änderungen nach Fristablauf die Wochenstatistik
    // und offene Einträge wieder auf Warnphase bringen, bevor sanktioniert wird.
    finalizeAbgabeWeekOpenToWarnphase(guild, weekKey, null, 'auto-sanction-scan');
    for (const category of getEnabledAbgabeKeysForWeek(weekKey)) {
      if (!isAbgabeAutoSanctionDue(category, weekKey)) continue;
      for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'auto-sanction-scan' })) {
        checked += 1;
        const shouldSanction = await shouldAutoSanctionAbgabeUser(guild, member.id, category, weekKey);
        if (!shouldSanction) continue;
        const sanction = await issueAutoAbgabeSanction(guild, member.id, category, weekKey, `Nachfrist von ${Number(rule.overdueDays || 0)} Tag(en) verpasst`);
        if (sanction) issued += 1;
      }
    }
    if (isAbgabeWeekReportDue(weekKey) || ensureWeek(weekKey).weeklyReportPosted) {
      await upsertWeeklyAbgabeReport(guild, weekKey, { force: true, reason: 'auto-sanction-scan-refresh' }).catch(() => null);
    }
  }
  if (issued) saveAll();
  return { checked, issued };
}

async function processSanctions() {
  if (!isAutomationEnabled('sanctionEscalation') && !isAutomationEnabled('sanctionReminders')) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const dayKey = currentDayKey();
  for (const sanction of store.sanctions.items) {
    if (sanction.paid || sanction.status === 'bezahlt') {
      await updateSanctionPublicMessage(guild, sanction);
      continue;
    }
    if (sanction.paused || getActiveAbsence(sanction.userId, 'all')) continue;
    const user = await client.users.fetch(sanction.userId).catch(() => null);
    if (!user) continue;
    const escalationCfg = getRuleConfig('sanctionEscalation');
    if (escalationCfg.enabled && sanction.status === 'offen' && sanction.dueAt && now() >= sanction.dueAt) {
      sanction.firstDueAt ||= sanction.dueAt;
      sanction.escalationRule ||= '3d_surcharge_2d_bloodout';
      sanction.surchargeApplied = true;
      sanction.surchargeAt = sanction.surchargeAt || now();
      sanction.status = 'zuschlag';
      if (!sanction.surchargeAmountApplied) {
        const addAmount = Number(escalationCfg.surchargeAmount || 0);
        sanction.amount += addAmount;
        sanction.surchargeAmountApplied = addAmount;
      }
      sanction.bloodoutAt = sanction.bloodoutAt || addDaysTs(now(), Number(escalationCfg.bloodoutAfterSurchargeDays || 0));
      saveAll();
      await updateSanctionPublicMessage(guild, sanction);
      await sendDM(user, buildSanctionReminderDM(sanction, `Du hast die Sanktion nicht bezahlt. ${formatCurrency(Number(escalationCfg.surchargeAmount || 0))} Aufpreis wurde hinzugefügt.`), { area: 'sanktionen', noticeKey: `sanction:${sanction.id}:surcharge` });
      await sendSanctionLeaderReminder(guild, sanction, `Frist überschritten. Zuschlag angewendet. Bloodout-Zeitpunkt: ${formatDateTimeLong(sanction.bloodoutAt)}.`);
      continue;
    }
    if (sanction.status === 'zuschlag' && sanction.bloodoutAt && now() >= sanction.bloodoutAt && !sanction.bloodoutAnnounced) {
      sanction.status = 'bloodout';
      sanction.bloodoutAnnounced = true;
      sanction.bloodoutAnnouncedAt = sanction.bloodoutAnnouncedAt || now();
      saveAll();
      await updateSanctionPublicMessage(guild, sanction);
      await sendDM(user, buildSanctionReminderDM(sanction, 'Du bekommst ein Bloodout.'), { area: 'sanktionen', noticeKey: `sanction:${sanction.id}:bloodout` });
      await sendSanctionLeaderReminder(guild, sanction, 'Bloodout wurde angekündigt.');
      continue;
    }
    let reminderKey = '';
    let reminderText = '';
    let leaderText = '';
    if (sanction.status === 'offen' && sanction.dueAt) {
      const remainingDays = Math.max(0, Math.ceil((sanction.dueAt - now()) / 86400000));
      if (remainingDays <= 1) {
        reminderKey = `offen:last:${dayKey}`;
        reminderText = 'Deine Sanktion ist noch offen. Heute ist der letzte Tag, um sie zu begleichen.';
        leaderText = `Heute ist der letzte Tag. Fällig: ${formatDateTimeLong(sanction.dueAt)}.`;
      } else {
        reminderKey = `offen:${remainingDays}:${dayKey}`;
        reminderText = `Deine Sanktion ist noch offen. Du hast noch ${remainingDays} ${remainingDays === 1 ? 'Tag' : 'Tage'} Zeit, um sie zu begleichen.`;
        leaderText = `Fällig: ${formatDateTimeLong(sanction.dueAt)}.`;
      }
    } else if (sanction.status === 'zuschlag' && sanction.bloodoutAt) {
      const remainingDays = Math.max(0, Math.ceil((sanction.bloodoutAt - now()) / 86400000));
      if (remainingDays <= 1) {
        reminderKey = `zuschlag:last:${dayKey}`;
        reminderText = 'Letzte Warnung. Heute ist der letzte Tag vor dem Bloodout.';
        leaderText = `Heute ist der letzte Tag vor Bloodout. Zeitpunkt: ${formatDateTimeLong(sanction.bloodoutAt)}.`;
      } else {
        reminderKey = `zuschlag:${remainingDays}:${dayKey}`;
        reminderText = `Letzte Warnung. Du hast noch ${remainingDays} ${remainingDays === 1 ? 'Tag' : 'Tage'} Zeit, bevor Bloodout angekündigt wird.`;
        leaderText = `Noch ${remainingDays} ${remainingDays === 1 ? 'Tag' : 'Tage'} bis Bloodout. Zeitpunkt: ${formatDateTimeLong(sanction.bloodoutAt)}.`;
      }
    }
    if (reminderKey && sanction.lastReminderKey !== reminderKey) {
      sanction.lastReminderKey = reminderKey;
      sanction.lastReminderAt = now();
      saveAll();
      await sendDM(user, buildSanctionReminderDM(sanction, reminderText), { area: 'sanktionen', noticeKey: `sanction:${sanction.id}:${reminderKey}` });
    }
    if (reminderKey && sanction.lastLeaderReminderKey !== reminderKey) {
      sanction.lastLeaderReminderKey = reminderKey;
      saveAll();
      await sendSanctionLeaderReminder(guild, sanction, leaderText);
    }
  }
}
// =========================================================
// TERM / VOTE HELPERS
// =========================================================
function twoWeeksDateOptions() {
  const out = [];
  const base = getTzDate();
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    out.push(`${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`);
  }
  return out;
}
function timeOptionsOne() {
  const arr = [];
  for (let hour = 16; hour <= 21; hour += 1) {
    for (const minute of [0, 15, 30, 45]) {
      arr.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  arr.push('22:00');
  return arr;
}
function timeOptionsTwo() {
  return ['22:15', '22:30', '22:45', '23:00', '23:15', '23:30', '23:45', '00:00'];
}
function getTermAlwaysCanUserIds(term) {
  const ids = [];
  if (term?.createdBy) ids.push(String(term.createdBy));
  if (ALWAYS_AUTO_CAN_USER_ID && String(term?.createdBy) !== ALWAYS_AUTO_CAN_USER_ID) ids.push(ALWAYS_AUTO_CAN_USER_ID);
  return [...new Set(ids)];
}
function createTermObject(builder, createdBy) {
  const startTs = parseGermanDateAndTime(builder.date, builder.time);
  return {
    id: uid(builder.mode === 'vote' ? 'vote' : 'term'),
    kind: builder.mode,
    type: builder.type,
    title: builder.type === 'Eigene' ? (builder.customTitle || 'Eigener Termin') : builder.type,
    required: builder.required !== false,
    date: builder.date,
    time: builder.time,
    startTs,
    createdBy,
    createdAt: isoStringNow(),
    closed: false,
    announcementPosted: false,
    responses: {},
    voteChoices: builder.voteChoices || [],
    votes: {},
    voteClosed: false,
    winner: null,
    sourceVoteId: null,
    messageId: null,
    autoCannotUsers: {},
    autoCanUsers: {},
    expectedMembers: 0,
    remindersSent: {},
  };
}

function isTradeTermType(type) {
  return ['Munition Verkauf','Munition Einkauf','Waffe Verkauf','Waffe Einkauf','Westen Verkauf','Westen Einkauf'].includes(String(type || ''));
}
function tradeTypeToCashbox(type) {
  const t = String(type || '');
  if (t.includes('Verkauf')) {
    return { type: 'income', category: t.includes('Munition') ? 'munition_verkauf' : t.includes('Waffe') ? 'waffen_verkauf' : t.includes('Westen') ? 'westen_verkauf' : 'sonstiges' };
  }
  return { type: 'expense', category: t.includes('Munition') ? 'munitions_kauf' : t.includes('Waffe') ? 'waffen_kauf' : 'westen_kauf' };
}
function buildTermTradeItemSelect(sessionId, type) {
  const isWeapon = String(type).includes('Waffe');
  const options = isWeapon
    ? INVENTORY_WEAPONS.map(w => ({ label: w, value: w }))
    : [
        { label: 'Leichte Westen', value: 'leichte_westen', emoji: '🦺' },
        { label: 'Schwere Westen', value: 'schwere_westen', emoji: '🛡️' },
      ];
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`term_trade_item_select:${sessionId}`)
      .setPlaceholder(isWeapon ? 'Welche Waffe?' : 'Welche Westen?')
      .addOptions(options.slice(0, 25))
  )];
}
function buildTermTradeModal(sessionId, type, selectedItem = '') {
  const isWeapon = String(type).includes('Waffe');
  const isVest = String(type).includes('Westen');
  const modal = new ModalBuilder().setCustomId(`term_trade_modal:${sessionId}`).setTitle(`${type} Details optional`);
  const rows = [];
  if (!selectedItem) {
    rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item').setLabel(isWeapon ? 'Welche Waffe? z. B. SMG, Karabiner' : isVest ? 'Welche Westen? leichte/schwere Westen' : 'Artikel').setStyle(TextInputStyle.Short).setRequired(isWeapon || isVest).setValue(isVest ? 'Schwere Westen' : String(type).includes('Munition') ? 'Munition' : '')));
  }
  rows.push(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('Menge optional').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unitPrice').setLabel('Preis pro Stück optional').setStyle(TextInputStyle.Short).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note').setLabel(selectedItem ? `Notiz optional (${getInventoryItemLabel(selectedItem)})` : 'Notiz optional').setStyle(TextInputStyle.Short).setRequired(false))
  );
  modal.addComponents(...rows);
  return modal;
}

function buildTermRequirementSelectPayload(sessionId, builder) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`term_required_select:${sessionId}`)
    .setPlaceholder('Pflicht oder kein Pflichttermin?')
    .addOptions(TERM_REQUIREMENT_OPTIONS);
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle('Pflicht auswählen')
      .setDescription([
        `Termin: **${builder.type || 'Termin'}**`,
        `Datum: **${builder.date || '—'}**`,
        `Uhrzeit: **${builder.time || '—'} Uhr**`,
        '',
        '**Kein Pflichttermin** bedeutet: Wer nicht reagiert, wird dafür nicht sanktioniert.',
      ].join('\n'))],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}
async function continueTermBuilderAfterRequirement(interaction, sessionId) {
  const builder = store.sessions.termBuilders[sessionId];
  if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
  if (builder.type === 'Eigene') {
    const modal = new ModalBuilder()
      .setCustomId(`term_custom_modal:${sessionId}`)
      .setTitle('Eigener Termin')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('customTitle').setLabel('Titel').setStyle(TextInputStyle.Short).setRequired(true))
      );
    return interaction.showModal(modal);
  }
  if (builder.mode === 'vote') {
    const modal = new ModalBuilder()
      .setCustomId(`vote_options_modal:${sessionId}`)
      .setTitle('Abstimmung Optionen')
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option1').setLabel('Option 1').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option2').setLabel('Option 2').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option3').setLabel('Option 3').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option4').setLabel('Option 4 (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
      );
    return interaction.showModal(modal);
  }
  if (isTradeTermType(builder.type)) {
    if (String(builder.type).includes('Waffe') || String(builder.type).includes('Westen')) {
      return interaction.update({ content: `${builder.type}: Artikel auswählen.`, embeds: [], components: buildTermTradeItemSelect(sessionId, builder.type) });
    }
    return interaction.showModal(buildTermTradeModal(sessionId, builder.type));
  }
  const term = createTermObject(builder, interaction.user.id);
  store.terms.items.push(term);
  delete store.sessions.termBuilders[sessionId];
  saveAll();
  await postTermAnnouncement(interaction.guild, term);
  return interaction.update({ content: `Termin erstellt: **${term.title}** am ${term.date} um ${term.time} (${getTermRequirementLabel(term)})`, embeds: [], components: [] });
}
async function maybeBookTradeTerm(guild, term, builder, createdBy) {
  if (!isTradeTermType(builder.type)) return null;
  const qty = parseNumber(builder.tradeQuantity || 0);
  const unitPrice = parseNumber(builder.tradeUnitPrice || 0);
  if (!qty || !unitPrice) return null;
  const mapping = tradeTypeToCashbox(builder.type);
  const tx = await addCashboxWarehouseTransaction(guild, mapping.type, mapping.category, {
    item: builder.tradeItem || builder.type,
    quantity: qty,
    unitPrice,
    reason: `Termin: ${term.title}${builder.tradeNote ? ` • ${builder.tradeNote}` : ''}`,
  }, createdBy);
  term.cashboxTransactionId = tx.id;
  tx.source = 'term';
  tx.term = { termId: term.id, title: term.title, type: builder.type };
  saveAll();
  return tx;
}
function termResponseSummary(term) {
  const responses = term.responses || {};
  let can = 0;
  let maybe = 0;
  let cannot = 0;
  let autoCannot = 0;
  let autoCan = 0;
  for (const [userId, response] of Object.entries(responses)) {
    const isAutoCannot = !!term.autoCannotUsers?.[userId];
    const isAutoCan = !!term.autoCanUsers?.[userId];
    if (response === 'can') can += 1;
    if (response === 'maybe') maybe += 1;
    if (response === 'cannot' && !isAutoCannot) cannot += 1;
    if (isAutoCannot) autoCannot += 1;
    if (isAutoCan) autoCan += 1;
  }
  const totalMembers = Number(term.expectedMembers || 0);
  const noResponse = Math.max(0, totalMembers - can - maybe - cannot - autoCannot);
  return { can, maybe, cannot, autoCannot, autoCan, noResponse, totalMembers };
}
function buildTermActionRows(term) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`term_response:${term.id}:can`).setLabel('✅ Kann').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`term_response:${term.id}:maybe`).setLabel('🤔 Vielleicht').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`term_response:${term.id}:cannot`).setLabel('❌ Kann nicht').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`term_status:${term.id}`).setLabel('📋 Status').setStyle(ButtonStyle.Primary),
    ),
  ];
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatGermanDateLabelFromString(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr || '-';
  const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return dateStr;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return dateStr;
  const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const weekday = weekdays[d.getDay()];
  const today = new Date();
  const todayOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const tomorrowOnly = new Date(todayOnly.getTime());
  tomorrowOnly.setDate(tomorrowOnly.getDate() + 1);
  const dateOnly = new Date(year, month - 1, day);
  const base = `${weekday}, ${pad2(day)}.${pad2(month)}.${year}`;
  if (dateOnly.getTime() === todayOnly.getTime()) return `Heute (${base})`;
  if (dateOnly.getTime() === tomorrowOnly.getTime()) return `Morgen (${base})`;
  return base;
}


function formatRelativeTermCountdown(ts) {
  const diff = Number(ts || 0) - now();
  if (!Number.isFinite(diff)) return '—';
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff <= 0) return 'läuft gerade oder ist bereits gestartet';
  if (diff < hour) {
    const mins = Math.max(1, Math.round(diff / minute));
    return mins === 1 ? 'in 1 Minute' : `in ${mins} Minuten`;
  }
  if (diff < day) {
    const hours = Math.round(diff / hour);
    return hours === 1 ? 'in 1 Stunde' : `in ${hours} Stunden`;
  }
  const days = Math.round(diff / day);
  if (days <= 0) return 'heute';
  if (days == 1) return 'morgen';
  if (days == 2) return 'übermorgen';
  return `in ${days} Tagen`;
}
function getStatsChannel(guild) {
  return guild?.channels?.cache?.get(store.config.channels.statistik) || guild?.channels?.cache?.get(store.config.channels.ankuendigungen) || null;
}

function getDashboardChannel(guild) {
  return guild?.channels?.cache?.get(store.config.channels.dashboard) || guild?.channels?.cache?.get(store.config.channels.statistik) || getStatsChannel(guild) || null;
}
function getProblemScoreForUser(guild, userId) {
  const stats = calculateReliabilityForUser(guild, userId);
  const pc = getReliabilityPointConfig();
  const risk = Math.min(100, Math.max(0,
    (100 - stats.score) +
    (stats.termNoResponse * pc.termNoResponsePenalty) +
    getOpenAbgabePointPenalty(stats.abgabeOpen) +
    Number(stats.sanctionPenalty || 0) +
    Number(stats.wachePenalty || 0) +
    Number(stats.behaviorModifier || 0)
  ));
  return {
    risk,
    score: Number(stats.score ?? 50),
    abgabeOpen: Number(stats.abgabeOpen || 0),
    abgabeDone: Number(stats.abgabeDone || stats.abgabeCompleted || 0),
    termNoResponse: Number(stats.termNoResponse || 0),
    wacheMissed: Number(stats.wacheMissed || 0),
    wachePenalty: Number(stats.wachePenalty || 0),
    termCan: Number(stats.termCan || 0),
    termCannot: Number(stats.termCannot || 0),
    absenceDays: Number(stats.absenceDays || 0),
    sanctionCount: Number(stats.sanctionCount || 0),
    ...stats,
  };
}
async function buildProblemMembers(guild, limit = 5) {
  await ensureGuildMembersCached(guild);
  const rows = [];
  for (const member of getRelevantGuildMembers(guild)) {
    rows.push({ userId: member.id, ...getProblemScoreForUser(guild, member.id) });
  }
  rows.sort((a, b) => b.risk - a.risk);
  return rows.slice(0, limit);
}
function getPriorityLabel(row) {
  if (row.risk >= 85) return 'kritisch';
  if (row.risk >= 60) return 'hoch';
  if (row.risk >= 35) return 'mittel';
  return 'normal';
}
function buildPriorityMentionLines(guild, ids, limit = 12) {
  if (!ids?.length) return ['—'];
  const rows = ids.filter(userId => isRelevantGuildMember(guild, userId)).map(userId => ({ userId, ...getProblemScoreForUser(guild, userId) }))
    .sort((a, b) => b.risk - a.risk)
    .slice(0, limit);
  return rows.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} — ${getPriorityLabel(row)}`);
}
function getReminderIntelligenceForUser(guild, userId, category, stage = 'thu') {
  const profile = getProblemScoreForUser(guild, userId);
  const dmFailed = hasDmFailure(userId);
  const lines = [];
  if (profile.risk >= 85) lines.push('Kritisches Risikoprofil: diese offene Abgabe sollte jetzt priorisiert werden.');
  else if (profile.risk >= 60) lines.push('Erhöhtes Risiko: wiederholt offene Punkte wurden erkannt.');
  else if (profile.score >= 85) lines.push('Du bist normalerweise zuverlässig – diese Erinnerung ist eher ein Sicherheitscheck.');
  if (profile.abgabeOpen > 1) lines.push(`Offene Abgaben historisch: **${profile.abgabeOpen}**`);
  if (profile.termNoResponse > 0) lines.push(`Termin-No-Responses historisch: **${profile.termNoResponse}**`);
  if (profile.sanctionCount > 0) lines.push(`Bisherige Sanktionen: **${profile.sanctionCount}**`);
  if (dmFailed) lines.push('Vorherige DM konnte nicht sicher zugestellt werden – prüfe bitte zusätzlich Discord direkt.');
  if (stage === 'sun' && profile.risk >= 60) lines.push('Spätestens heute handeln, sonst steigt das Sanktionsrisiko deutlich.');
  return lines.slice(0, 4);
}

function shouldSendSmartAbgabeReminder(guild, userId, category, stage = 'thu') {
  if (!store.config.settings.smartPingEnabled || !isSmartPingActiveToday()) return true;
  const cfg = getSystemControlConfig().smartPing || {};
  const profile = getProblemScoreForUser(guild, userId);
  const reliableSkipScore = Number(cfg.reliableSkipScore ?? 90);
  const sundayOnlyScore = Number(cfg.sundayOnlyScore ?? 75);
  const mediumScore = Number(cfg.mediumScore ?? 55);
  const minRisk = Number(cfg.minRisk ?? 35);
  const openAbgabenThreshold = Math.max(0, Number(cfg.openAbgabenThreshold ?? 1));
  const sanctionThreshold = Math.max(0, Number(cfg.sanctionThreshold ?? 1));
  const termNoResponseThreshold = Math.max(0, Number(cfg.termNoResponseThreshold ?? 1));
  const hasHardTrigger = profile.abgabeOpen >= openAbgabenThreshold || profile.sanctionCount >= sanctionThreshold || profile.termNoResponse >= termNoResponseThreshold;
  // Wenn konkrete Schwellen überschritten sind, wird nicht übersprungen.
  if (hasHardTrigger) return true;
  // Sehr zuverlässige Mitglieder bekommen keine Standard-DMs, solange keine Auffälligkeiten bekannt sind.
  if (profile.score >= reliableSkipScore && profile.risk < minRisk) return false;
  // Zuverlässig: nur die letzte Abgabe-Erinnerung.
  if (profile.score >= sundayOnlyScore && profile.risk < minRisk) return stage === 'sun';
  // Mittel: nicht jede frühe Erinnerung, aber regelmäßig genug.
  if (profile.score >= mediumScore && profile.risk < (minRisk + 25)) return stage === 'fri' || stage === 'sun';
  // Auffällig/oft spät: alle Reminder-Stufen.
  return true;
}
function getSmartAbgabeSkipReason(guild, userId, category, stage = 'thu') {
  const cfg = getSystemControlConfig().smartPing || {};
  const profile = getProblemScoreForUser(guild, userId);
  const minRisk = Number(cfg.minRisk ?? 35);
  if (profile.score >= Number(cfg.reliableSkipScore ?? 90) && profile.risk < minRisk) return 'sehr zuverlässig – keine Standard-DM nötig';
  if (profile.score >= Number(cfg.sundayOnlyScore ?? 75) && profile.risk < minRisk && stage !== 'sun') return 'zuverlässig – nur letzte Erinnerung';
  if (profile.score >= Number(cfg.mediumScore ?? 55) && profile.risk < (minRisk + 25) && stage === 'thu') return 'mittel – frühe Erinnerung übersprungen';
  return '';
}
function getTermStatusBucketsSync(guild, term) {
  const can = [];
  const maybe = [];
  const cannot = [];
  const absent = [];
  const noResponse = [];
  const members = guild?.members?.cache || new Map();
  for (const member of members.values()) {
    if (member.user?.bot) continue;
    const userId = member.id;
    const response = term.responses?.[userId];
    const isAutoCan = !!term.autoCanUsers?.[userId];
    const isAbsent = !!getAbsenceAt(userId, term.startTs, 'term') && !isAutoCan;
    const isAutoCannot = !!term.autoCannotUsers?.[userId] && !isAutoCan;
    if (isAutoCan || response === 'can') can.push(userId);
    else if (isAbsent || isAutoCannot) absent.push(userId);
    else if (response === 'maybe') maybe.push(userId);
    else if (response === 'cannot') cannot.push(userId);
    else noResponse.push(userId);
  }
  return { can, maybe, cannot, absent, noResponse };
}
function analyzeOperationalRisk(guild) {
  const result = { abgabeAtRisk: [], sanctionAtRisk: [], noResponseAtRisk: [] };
  const prevWeek = previousWeekKey(currentWeekKey());
  for (const category of getEnabledAbgabeKeys()) {
    for (const member of getRequiredMembersForAbgabe(guild, category, prevWeek, { reason: 'risk-analysis' })) {
      const entry = getAbgabeStatusForWeek(guild, prevWeek, category, member.id);
      if (!['warnphase', 'spaeter_abgabe'].includes(entry.status)) continue;
      if (isUserFullyExcusedForWeek(member.id, prevWeek) || isUserAbsentOnDeadline(member.id, prevWeek)) continue;
      result.abgabeAtRisk.push({ userId: member.id, category, weekKey: prevWeek, risk: getProblemScoreForUser(guild, member.id).risk });
    }
  }
  for (const sanction of store.sanctions.items || []) {
    if (sanction.paid || !sanction.userId) continue;
    const dueAt = Number(sanction.dueAt || 0);
    const baseRisk = getProblemScoreForUser(guild, sanction.userId).risk;
    if (dueAt && dueAt <= now() + (48 * 60 * 60 * 1000)) {
      result.sanctionAtRisk.push({ userId: sanction.userId, sanctionId: sanction.id, dueAt, risk: Math.min(100, baseRisk + 10) });
    }
  }
  for (const term of (store.terms.items || []).filter(t => t.kind === 'term' && !t.closed && Number(t.startTs || 0) > now() && Number(t.startTs || 0) <= now() + (48 * 60 * 60 * 1000))) {
    const buckets = getTermStatusBucketsSync(guild, term);
    for (const userId of buckets.noResponse) {
      const baseRisk = getProblemScoreForUser(guild, userId).risk;
      result.noResponseAtRisk.push({ userId, termId: term.id, title: term.title, risk: Math.min(100, baseRisk + 15) });
    }
  }
  result.abgabeAtRisk.sort((a, b) => b.risk - a.risk);
  result.sanctionAtRisk.sort((a, b) => b.risk - a.risk || a.dueAt - b.dueAt);
  result.noResponseAtRisk.sort((a, b) => b.risk - a.risk);
  return result;
}

function getStressLevel(guild) {
  let openSanctions = store.sanctions.items.filter(x => !x.paid).length;
  let openAbgaben = 0;
  for (const week of Object.values(getAllAbgabeWeeksIncludingArchive())) {
    for (const category of getEnabledAbgabeKeys()) {
      for (const row of Object.values(week.categories?.[category] || {})) {
        if (['nicht_abgegeben', 'offen', 'warnphase'].includes(row.status)) openAbgaben += 1;
      }
    }
  }
  const upcomingTerms = (store.terms.items || []).filter(t => t.kind === 'term' && !t.closed && Number(t.startTs || 0) > now());
  const noResponseCount = upcomingTerms.reduce((sum, term) => {
    const members = guild?.members?.cache || new Map();
    let missing = 0;
    for (const member of members.values()) {
      if (member.user.bot) continue;
      const response = term.responses?.[member.id];
      const isAutoCan = !!term.autoCanUsers?.[member.id];
      const isAbsent = !!getAbsenceAt(member.id, term.startTs, 'term') && !isAutoCan;
      const isAutoCannot = !!term.autoCannotUsers?.[member.id] && !isAutoCan;
      if (!response && !isAutoCan && !isAbsent && !isAutoCannot) missing += 1;
    }
    return sum + missing;
  }, 0);
  const score = Math.min(100, openSanctions * 8 + openAbgaben * 3 + noResponseCount * 2);
  let label = 'ruhig';
  if (score >= 70) label = 'hoch';
  else if (score >= 40) label = 'mittel';
  return { score, label, openSanctions, openAbgaben, noResponseCount };
}
function getDecisionHelp(term, buckets) {
  const totalAnswered = buckets.can.length + buckets.maybe.length + buckets.cannot.length + buckets.absent.length;
  const totalTracked = totalAnswered + buckets.noResponse.length;
  const attendanceRate = totalTracked ? Math.round(((buckets.can.length + buckets.maybe.length * 0.5) / totalTracked) * 100) : 0;
  if (attendanceRate < 40) return `⚠️ Empfehlung: Termin eher verschieben. Aktuelle Zusagequote nur **${attendanceRate}%**.`;
  if (buckets.noResponse.length >= Math.max(5, Math.round(totalTracked * 0.3))) return `⚠️ Empfehlung: Erst Smart-Ping senden. Noch **${buckets.noResponse.length}** ohne Antwort.`;
  if (buckets.can.length < 5) return `⚠️ Empfehlung: Teilnahme eher knapp. Vielleicht Uhrzeit prüfen oder extra Erinnerung senden.`;
  return `✅ Empfehlung: Termin kann so stehen bleiben. Aktuelle Zusagequote **${attendanceRate}%**.`;
}
function getOptimizedTermSuggestion() {
  const slots = {};
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    const date = parseGermanDate(term.date);
    if (!date) continue;
    const weekday = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'][date.getDay()];
    const slotKey = `${weekday} ${term.time}`;
    let weight = 0;
    for (const [userId, response] of Object.entries(term.responses || {})) {
      if (response === 'can') weight += 1;
      else if (response === 'maybe') weight += 0.5;
      else if (response === 'cannot') weight += 0.1;
    }
    weight += Object.keys(term.autoCanUsers || {}).length;
    slots[slotKey] ||= { score: 0, count: 0 };
    slots[slotKey].score += weight;
    slots[slotKey].count += 1;
  }
  const rows = Object.entries(slots).map(([slot, data]) => ({ slot, avg: data.score / Math.max(1, data.count), count: data.count }))
    .filter(x => x.count >= 1)
    .sort((a, b) => b.avg - a.avg);
  return rows[0] || null;
}

function getBestControlChannelId() {
  return store.config.panelMessages?.leaderpanel?.channelId
    || store.config.panelMessages?.adminpanel?.channelId
    || store.config.channels?.statistik
    || store.config.channels?.sanktionen
    || null;
}
function getBestControlChannel(guild) {
  const id = getBestControlChannelId();
  if (!id || !guild) return null;
  return guild.channels.cache.get(id) || null;
}
function getSettingLabel(key) {
  const labels = {
    leaderReminderDmEnabled: 'Leader-DMs',
    routeAdminFridayReportEnabled: 'Freitagsliste',
    routeAdminMondayReportEnabled: 'Montagsliste',
    smartPingEnabled: 'Smart Ping',
    dashboardEnabled: 'Dashboard',
    sanctionApprovalEnabled: 'Sanktions-Freigabe',
    autoSanctionsEnabled: 'Auto-Sanktionen',
    termRemindersEnabled: 'Termin-Reminder',
    decisionHintsEnabled: 'Entscheidungshilfe',
  };
  return labels[key] || key;
}
function buildTogglePill(enabled) {
  return enabled ? '🟢 aktiv' : '🔴 aus';
}

function getDmAreaLabel(area) {
  const labels = {
    all: 'Global',
    general: 'Allgemein',
    abgaben: 'Abgaben',
    sanktionen: 'Sanktionen',
    wache: 'Wache',
    termine: 'Termine',
  };
  return labels[area] || area;
}
function getDmSettingStatusLine(area) {
  const cfg = getDmSettings();
  const enabled = area === 'all' ? cfg.enabled !== false : (cfg.enabled !== false && cfg.areas?.[area] !== false);
  return `${getDmAreaLabel(area)}: **${enabled ? 'AN' : 'AUS'}**`;
}
function buildDmSettingsLines() {
  const cfg = getDmSettings();
  return [
    getDmSettingStatusLine('all'),
    getDmSettingStatusLine('abgaben'),
    getDmSettingStatusLine('sanktionen'),
    getDmSettingStatusLine('wache'),
    getDmSettingStatusLine('termine'),
    `Spam-Schutz: **${cfg.dailyDedupEnabled !== false ? 'AN' : 'AUS'}**`,
    `DM-Buttons: **${cfg.buttonsEnabled !== false ? 'AN' : 'AUS'}**`,
  ];
}
function toggleDmSettingKey(key) {
  const cfg = getDmSettings();
  if (key === 'all') cfg.enabled = cfg.enabled === false;
  else if (key === 'dailyDedupEnabled') cfg.dailyDedupEnabled = cfg.dailyDedupEnabled === false;
  else if (key === 'buttonsEnabled') cfg.buttonsEnabled = cfg.buttonsEnabled === false;
  else {
    cfg.areas ||= {};
    cfg.areas[key] = cfg.areas[key] === false;
  }
  saveAll();
}
function buildDmSettingsComponents() {
  const cfg = getDmSettings();
  const styleFor = (key) => {
    const enabled = key === 'all' ? cfg.enabled !== false : key === 'dailyDedupEnabled' ? cfg.dailyDedupEnabled !== false : key === 'buttonsEnabled' ? cfg.buttonsEnabled !== false : cfg.areas?.[key] !== false;
    return enabled ? ButtonStyle.Success : ButtonStyle.Secondary;
  };
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_dm_toggle:all').setLabel('📨 DM Global').setStyle(styleFor('all')),
      new ButtonBuilder().setCustomId('admin_dm_toggle:abgaben').setLabel('📦 Abgaben').setStyle(styleFor('abgaben')),
      new ButtonBuilder().setCustomId('admin_dm_toggle:sanktionen').setLabel('⚖️ Sanktionen').setStyle(styleFor('sanktionen')),
      new ButtonBuilder().setCustomId('admin_dm_toggle:wache').setLabel('🟢 Wache').setStyle(styleFor('wache')),
      new ButtonBuilder().setCustomId('admin_dm_toggle:termine').setLabel('📅 Termine').setStyle(styleFor('termine')),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_dm_toggle:dailyDedupEnabled').setLabel('🛡️ Spam-Schutz').setStyle(styleFor('dailyDedupEnabled')),
      new ButtonBuilder().setCustomId('admin_dm_toggle:buttonsEnabled').setLabel('🔘 DM-Buttons').setStyle(styleFor('buttonsEnabled')),
      new ButtonBuilder().setCustomId('admin_dm_back').setLabel('↩️ Zurück').setStyle(ButtonStyle.Primary),
    ),
  ];
}
function buildDmSettingsEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📨 Admin • DM-Einstellungen')
    .setDescription('Diese Einstellungen sind nur im Admin-Panel erreichbar. Leader sehen diesen Bereich nicht.')
    .addFields(
      buildInfoField('Schalter', buildDmSettingsLines(), false),
      buildInfoField('Status', [`Bekannte DM-Blocker: **${Object.values(store.config.diagnostics.dmStatus || {}).filter(x => x?.status === 'blocked').length}**`, `DM-Fehler gespeichert: **${getRecentDmFailures(999).length}**`], false),
    )
    .setFooter({ text: 'Admin only • DMs pro Bereich steuerbar' });
}
function buildLeaderPanelEmbed(guild) {
  const stress = getStressLevel(guild);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`👑 ${getBotAppearance().leaderPanelTitle}`)
    .setDescription('Warnungen, Kontrolle, Freigaben.')
    .addFields(
      buildInfoField('⚠️ Jetzt wichtig', [
        `System-Stress: **${stress.label}** (${stress.score}/100)`,
        `Offene Sanktionen: **${stress.openSanctions}**`,
        `Offene Abgaben: **${stress.openAbgaben}**`,
      ], true),
      buildInfoField('🤖 Automatik', [
        `Smart Ping: ${buildTogglePill(store.config.settings.smartPingEnabled)}`,
        `Sanktions-Freigabe: ${buildTogglePill(store.config.settings.sanctionApprovalEnabled)}`,
        `Auto-Sanktionen: ${buildTogglePill(store.config.settings.autoSanctionsEnabled)}`,
      ], true),
      buildInfoField('🧭 Schnellzugriff', [
        'Dashboard aktualisieren',
        `Leaderschaft-Pflichten: **${areLeadershipDutiesEnabled() ? 'AN' : 'AUS'}**`,
        'Freigaben prüfen',
      ], false),
      buildInfoField('📦 Abgaben', Object.keys(ABGABEN).map(key => {
        const cfg = getAbgabeRuntimeConfig(key);
        return `${cfg.emoji} ${cfg.label}: **${cfg.enabled ? 'AN' : 'AUS'}** • ${formatAmount(key, cfg.amount)} • ${formatAbgabeDeadlineConfig(key)}`;
      }), false),
    )
    .addFields(buildInfoField('🟢 Wache', (() => { const cfg = getWacheConfig(); return [`Status: **${cfg.enabled ? 'AN' : 'AUS'}**`, `Pflicht: **${cfg.requiredMinutesPerWeek} min/Woche**`, `Entschuldigt ab: **${cfg.absenceExcuseDays} Tagen**`, `Auto-Ende: **${cfg.sessionMinutes} min oder 00:00**`]; })(), false))
    .setFooter({ text: 'Leader • Übersicht' });
}
function buildLeaderPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('leader_refresh_dashboard').setLabel('📊 Dashboard').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('leader_leadership_duties_toggle').setLabel(getLeadershipDutyLabel()).setStyle(getLeadershipDutyStyle()),
      new ButtonBuilder().setCustomId('leader_pending_approvals').setLabel('⚠️ Freigaben').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('leader_open_sanctions').setLabel('⚖️ Offene Sanktionen').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('leader_attendance_launch').setLabel('📋 Anwesenheit').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('leader_abgabe_config').setLabel('📦 Abgaben einstellen').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('leader_wache_config').setLabel('🟢 Wache einstellen').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verwaltung_back').setLabel('⬅️ Zurück zur Verwaltung').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
function buildAdminAppearanceEmbed() {
  const cfg = getBotAppearance();
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🎨 Bot Design & Darstellung')
    .setDescription('Technische/optische Grundeinstellungen. Diese Einstellungen gehören ins Admin-Panel, damit normale Leader sie nicht versehentlich ändern.')
    .addFields(
      buildInfoField('Farbe & Prefix', [`Embed-Farbe: **${cfg.embedColor}**`, `Prefix: **${cfg.prefix}**`], true),
      buildInfoField('Texte', [`Footer: **${cfg.footerText || '—'}**`, `Dashboard: **${cfg.dashboardTitle}**`, `Kasse: **${cfg.cashboxTitle}**`], false),
      buildInfoField('Panel-Titel', [`Leader: **${cfg.leaderPanelTitle}**`, `Admin: **${cfg.adminPanelTitle}**`], false),
    )
    .setFooter({ text: cfg.footerText || 'Admin Design' });
}
function buildAdminAppearanceComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_appearance_edit').setLabel('🎨 Design bearbeiten').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin_appearance_back').setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary),
  )];
}
function buildAdminAppearanceModal() {
  const cfg = getBotAppearance();
  return new ModalBuilder()
    .setCustomId('admin_appearance_modal')
    .setTitle('Bot Design bearbeiten')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('embedColor').setLabel('Embed Farbe Hex, z. B. #D4AF37').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.embedColor)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prefix').setLabel('Prefix, z. B. ! oder ?').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.prefix || '!')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footerText').setLabel('Footer Text').setStyle(TextInputStyle.Short).setRequired(false).setValue(cfg.footerText || '')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('titles').setLabel('Titel: Dashboard|Kasse|Leader|Admin').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue([cfg.dashboardTitle, cfg.cashboxTitle, cfg.leaderPanelTitle, cfg.adminPanelTitle].join(' | '))),
    );
}
function buildAdminPanelEmbed() {
  const keys = ['smartPingEnabled','dashboardEnabled','autoSanctionsEnabled','termRemindersEnabled','decisionHintsEnabled','dryRunEnabled','logSystemEnabled'];
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🛠️ ${getBotAppearance().adminPanelTitle}`)
    .setDescription('Module, Tests, Sicherheit, Kanäle und Rechte. Kanäle/Rechte kannst du direkt per Button-Hilfe oder Slash Commands setzen.')
    .addFields(
      buildInfoField('⚙️ Module', keys.map(key => `${getSettingLabel(key) || key}: **${store.config.settings[key] ? 'AN' : 'AUS'}**`), false),
      buildInfoField('🧪 Diagnose', ['Rechte prüfen • Kanäle/Rechte'], false),
      buildInfoField('📺 Kanäle', [`Dashboard: ${store.config.channels?.dashboard ? `<#${store.config.channels.dashboard}>` : 'fehlt'}`, `Wache Dashboard: ${getWacheConfig().dashboardChannelId ? `<#${getWacheConfig().dashboardChannelId}>` : (store.config.channels?.wache_dashboard ? `<#${store.config.channels.wache_dashboard}>` : 'fehlt')}`, `Wache Berichte: ${getWacheConfig().reportChannelId ? `<#${getWacheConfig().reportChannelId}>` : (store.config.channels?.wache_reports ? `<#${store.config.channels.wache_reports}>` : 'Statistik/Fallback')}`], false),
      buildInfoField('🛡️ Sicherheit', [
        `Offene Rollbacks: **${(store.sessions.rollbackStack || []).filter(x => !x.used && Number(x.expiresAt || 0) > now()).length}**`,
        `DM-Fehler: **${getRecentDmFailures(999).length}**`,
        `Whitelist: **${(store.config.safety?.whitelistUserIds || []).length}** • Blacklist: **${(store.config.safety?.blacklistUserIds || []).length}**`,
      ], false),
      buildInfoField('📨 DM-System', buildDmSettingsLines(), false),
      buildInfoField('🎨 Design', [`Farbe: **${getBotAppearance().embedColor}**`, `Prefix: **${getBotAppearance().prefix}**`, `Footer: **${getBotAppearance().footerText || '—'}**`], false),
    )
    .setFooter({ text: getBotAppearance().footerText || 'Admin GUI • live steuerbar' });
}
function buildAdminPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_toggle:smartPingEnabled').setLabel('📣 Smart Ping').setStyle(store.config.settings.smartPingEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_toggle:autoSanctionsEnabled').setLabel('🚨 Auto-Sanktionen').setStyle(store.config.settings.autoSanctionsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_toggle:logSystemEnabled').setLabel('🧾 Logs').setStyle(store.config.settings.logSystemEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_toggle:dryRunEnabled').setLabel('🧪 Dry-Run').setStyle(store.config.settings.dryRunEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_toggle:termRemindersEnabled').setLabel('⏰ Reminder').setStyle(store.config.settings.termRemindersEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_toggle:decisionHintsEnabled').setLabel('🧠 Hilfe').setStyle(store.config.settings.decisionHintsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_action:rights').setLabel('🔐 Rechte').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_action:dm_settings').setLabel('📨 DM Settings').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin_action:config_help').setLabel('⚙️ Kanäle/Rechte').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_action:appearance').setLabel('🎨 Design & Prefix').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('verwaltung_back').setLabel('⬅️ Zurück zur Verwaltung').setStyle(ButtonStyle.Secondary),
    ),
  ];
}


function buildVerwaltungEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⚙️ Zentrale Verwaltung')
    .setDescription('Ein Hauptpanel für alle wichtigen Bereiche. Öffne hier das Leader Panel, die Systemsteuerung oder das Admin Panel.')
    .addFields(
      buildInfoField('👑 Leader Panel', ['Tägliche Führung: Dashboard, Freigaben, offene Sanktionen, Abgaben und Wache.'], true),
      buildInfoField('⚙️ Systemsteuerung', ['Regeln, Reminder, Smart Ping, DMs, Automationen, Kasse/Lager und Sicherheit.'], true),
      buildInfoField('🛠️ Admin Panel', ['Technik, Design, Logs, Kanäle, Rechte und Diagnose.'], true),
    )
    .setFooter({ text: 'Zentrale Verwaltung • Nutze die Buttons unten' });
}
function buildVerwaltungComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verwaltung_open_leader').setLabel('👑 Leader Panel').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('verwaltung_open_system').setLabel('⚙️ Systemsteuerung').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('verwaltung_open_admin').setLabel('🛠️ Admin Panel').setStyle(ButtonStyle.Danger),
    ),
  ];
}
function withVerwaltungBackRow(components = []) {
  const rows = Array.isArray(components) ? [...components] : [];
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verwaltung_back').setLabel('⬅️ Zurück zur Verwaltung').setStyle(ButtonStyle.Secondary),
  ));
  return rows.slice(0, 5);
}

function getApprovalChannel(guild) {
  // Auto-Sanktions-Freigaben werden nicht mehr in einen extra Kanal gepostet.
  // Entscheidung läuft über Leader Panel -> Freigaben.
  return getBestControlChannel(guild);
}
function formatApprovalCountdown(executeAt) {
  const remainingMs = Math.max(0, Number(executeAt || 0) - now());
  const secs = Math.ceil(remainingMs / 1000);
  if (secs <= 0) return '0s';
  const minutes = Math.floor(secs / 60);
  const seconds = secs % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
function getApprovalCountdownUpdateInterval(approval) {
  const remainingMs = Math.max(0, Number(approval.executeAt || 0) - now());
  if (remainingMs <= 10000) return 1000;
  if (remainingMs <= 30000) return 2000;
  return 5000;
}
async function clearApprovalTimers(approvalId) {
  const interval = approvalCountdownIntervals.get(approvalId);
  if (interval) {
    clearInterval(interval);
    approvalCountdownIntervals.delete(approvalId);
  }
  const timeout = approvalAutoTimeouts.get(approvalId);
  if (timeout) {
    clearTimeout(timeout);
    approvalAutoTimeouts.delete(approvalId);
  }
}
async function scheduleApprovalTimers(guild, approval) {
  if (!approval || approval.resolved) return;
  await clearApprovalTimers(approval.id);
  const timeoutMs = Math.max(0, Number(approval.executeAt || 0) - now());
  approvalAutoTimeouts.set(approval.id, setTimeout(async () => {
    try {
      await finalizeApproval(guild, approval, true, null, 'no_response');
    } catch (error) {
      console.error('Approval auto-finalize failed', error);
    }
  }, timeoutMs));

  let currentIntervalMs = getApprovalCountdownUpdateInterval(approval);
  const tick = async () => {
    const current = store.sessions.pendingSanctionApprovals?.[approval.id];
    if (!current || current.resolved) {
      await clearApprovalTimers(approval.id);
      return;
    }
    const nextIntervalMs = getApprovalCountdownUpdateInterval(current);
    if (nextIntervalMs !== currentIntervalMs) {
      await scheduleApprovalTimers(guild, current);
      return;
    }
    await upsertApprovalMessage(guild, current).catch(() => null);
  };
  approvalCountdownIntervals.set(approval.id, setInterval(() => { tick().catch(() => null); }, currentIntervalMs));
}
async function restoreApprovalTimers(guild) {
  ensureSessionShape();
  for (const approval of Object.values(store.sessions.pendingSanctionApprovals || {})) {
    if (approval.resolved) continue;
    if (Number(approval.executeAt || 0) <= now()) {
      await finalizeApproval(guild, approval, true, null, 'no_response').catch(() => null);
    } else {
      await scheduleApprovalTimers(guild, approval).catch(() => null);
      await upsertApprovalMessage(guild, approval).catch(() => null);
    }
  }
}


let autoSanctionReminderTimer = null;
async function scheduleAutoSanctionBatchReminder(guild) {
  if (!guild) return;
  if (autoSanctionReminderTimer) clearTimeout(autoSanctionReminderTimer);
  autoSanctionReminderTimer = setTimeout(async () => {
    autoSanctionReminderTimer = null;
    const pending = Object.values(store.sessions.pendingSanctionApprovals || {}).filter(item => !item.resolved);
    if (!pending.length) return;
    const bySource = pending.reduce((acc, item) => {
      const key = item.source || 'auto';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const lines = [
      `Es werden gleich **${pending.length} automatische Sanktion${pending.length === 1 ? '' : 'en'}** verteilt.`,
      `Quellen: ${Object.entries(bySource).map(([k,v]) => `${k}: ${v}`).join(' • ')}`,
      `Im **Leader Panel → Freigaben** kannst du alle, einzelne Personen oder gar keine freigeben.`,
      `Ohne Entscheidung nach 5 Minuten werden sie automatisch ausgestellt.`,
    ];
    await sendLeaderReminderEvent(guild, '⚠️ Auto-Sanktionen warten auf Freigabe', lines, COLORS.warning).catch(() => null);
  }, 1500);
}

function buildLeaderPendingApprovalsView(guild, sessionId, page = 0, selectedId = '') {
  ensureSessionShape();
  const pending = Object.values(store.sessions.pendingSanctionApprovals || {})
    .filter(item => !item.resolved)
    .sort((a,b) => Number(a.executeAt || 0) - Number(b.executeAt || 0));
  const pages = chunk(pending, 10);
  const safePage = Math.max(0, Math.min(Number(page || 0), Math.max(0, pages.length - 1)));
  const pageItems = pages[safePage] || [];
  const selected = pending.find(item => item.id === selectedId) || pageItems[0] || null;
  store.sessions.pendingApprovalPanel ||= {};
  store.sessions.pendingApprovalPanel[sessionId] = { page: safePage, selectedId: selected?.id || '', createdAt: now() };
  saveAll();

  const lines = pageItems.map((item, idx) => {
    const nr = safePage * 10 + idx + 1;
    const marker = selected?.id === item.id ? '➡️ ' : '';
    const amount = item.penaltyType === 'Bloodout' ? 'Bloodout' : `${Number(item.amount || 0).toLocaleString('de-DE')}$`;
    return `${marker}${nr}. **${getUserDisplay(guild, item.userId)}** • ${amount} • ${item.reason || 'Ohne Grund'} • Auto in ${formatApprovalCountdown(item.executeAt)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⚠️ Auto-Sanktions-Freigaben')
    .setDescription(lines.length ? lines.join('\n').slice(0, 3500) : 'Aktuell keine offenen Auto-Sanktions-Freigaben.')
    .addFields(selected ? [
      buildInfoField('Ausgewählt', [
        `Mitglied: **${getUserDisplay(guild, selected.userId)}**`,
        `Grund: ${selected.reason || '—'}`,
        `Höhe / Art: **${selected.penaltyType === 'Bloodout' ? 'Bloodout' : `${Number(selected.amount || 0).toLocaleString('de-DE')}$`} • ${selected.penaltyType || '—'}**`,
        `Quelle: **${selected.source || 'auto'}**`,
        `Auto-Ausstellung in: **${formatApprovalCountdown(selected.executeAt)}**`,
      ], false),
    ] : [])
    .setFooter({ text: `Seite ${safePage + 1}/${Math.max(1, pages.length)} • 5 Min Auto-Ausstellung ohne Antwort` })
    .setTimestamp(new Date());

  const components = [];
  if (pageItems.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`pending_approvals_select:${sessionId}`)
        .setPlaceholder('Person / Auto-Sanktion auswählen')
        .addOptions(pageItems.map(item => ({
          label: (getUserDisplay(guild, item.userId) || item.userId).slice(0, 75),
          description: `${item.penaltyType || 'Sanktion'} • ${(item.reason || '').slice(0, 65)}`.slice(0, 100),
          value: item.id,
          default: selected?.id === item.id,
        })))
    ));
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pending_approvals_action:${sessionId}:approve_selected`).setLabel('✅ Auswahl akzeptieren').setStyle(ButtonStyle.Danger).setDisabled(!selected),
      new ButtonBuilder().setCustomId(`pending_approvals_action:${sessionId}:deny_selected`).setLabel('🛑 Auswahl abbrechen').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
      new ButtonBuilder().setCustomId(`pending_approvals_action:${sessionId}:approve_all`).setLabel('✅ Alle akzeptieren').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pending_approvals_action:${sessionId}:deny_all`).setLabel('🛑 Alle abbrechen').setStyle(ButtonStyle.Secondary),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pending_approvals_page:${sessionId}:prev`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`pending_approvals_page:${sessionId}:next`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= Math.max(1, pages.length) - 1),
    new ButtonBuilder().setCustomId(`pending_approvals_page:${sessionId}:refresh`).setLabel('🔄 Aktualisieren').setStyle(ButtonStyle.Primary),
  ));
  return { embeds: [embed], components };
}

function buildApprovalEmbed(guild, approval) {
  const isResolved = !!approval.resolved;
  const decisionText = approval.resolved
    ? approval.result === 'approved'
      ? `✅ Ausgestellt${approval.resolvedBy ? ` von <@${approval.resolvedBy}>` : approval.resolveReason === 'no_response' ? ' • keine Reaktion' : ''}`
      : `🛑 Gestoppt${approval.resolvedBy ? ` von <@${approval.resolvedBy}>` : ''}`
    : '⏳ Wartet auf Ja / Nein';
  const countdownText = isResolved
    ? approval.resolveReason === 'no_response'
      ? 'Abgelaufen • keine Reaktion'
      : 'Beendet'
    : `${formatApprovalCountdown(approval.executeAt)} verbleibend`;
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⚠️ Sanktions-Freigabe')
    .setDescription('Dieses Mitglied ist aktuell auffällig. Soll die Sanktion ausgestellt werden? Wenn 5 Minuten niemand reagiert, wird sie automatisch umgesetzt.')
    .addFields(
      buildInfoField('👤 Mitglied', [getUserDisplay(guild, approval.userId)], true),
      buildInfoField('📌 Grund', [approval.reason], true),
      buildInfoField('⏳ Countdown', [countdownText], true),
      buildInfoField('🧾 Sanktion', [`${approval.catalogNo} • ${approval.penaltyType} • ${approval.penaltyType === 'Bloodout' ? 'Bloodout' : approval.amount}`], false),
      buildInfoField('📍 Status', [decisionText], false),
    )
    .setFooter({ text: `Freigabe • ${approval.source}` });
}
function buildApprovalComponents(approval) {
  const done = !!approval.resolved;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approval_yes:${approval.id}`).setLabel('✅ Ja, ausstellen').setStyle(ButtonStyle.Danger).setDisabled(done),
    new ButtonBuilder().setCustomId(`approval_no:${approval.id}`).setLabel('🛑 Nein, stoppen').setStyle(ButtonStyle.Secondary).setDisabled(done),
  )];
}
async function upsertApprovalMessage(guild, approval) {
  // Kein einzelnes Freigabe-Posting mehr. Die Übersicht ist im Leader Panel -> Freigaben.
  return null;
}

function shouldUseApprovalForSanctionSource(source) {
  const s = String(source || '').toLowerCase();
  // Nur automatische Sanktionen brauchen Leader-Freigabe.
  // Manuelle/Web-Sanktionen werden sofort ausgestellt.
  return s !== 'manual' && s !== 'web';
}
function suppressAutoSanctionFromSanction(sanction, byId = null, reason = 'cancelled_or_deleted') {
  if (!sanction || !shouldUseApprovalForSanctionSource(sanction.source)) return null;
  return suppressAutoSanction(
    sanction.source,
    sanction.userId,
    sanction.relatedWeek || null,
    sanction.relatedCategory || null,
    sanction.relatedTermId || null,
    byId,
    reason
  );
}

async function finalizeApproval(guild, approval, execute = true, decidedBy = null, resolveReason = null) {
  if (!approval || approval.resolved) return null;
  await clearApprovalTimers(approval.id);
  approval.resolved = true;
  approval.resolvedAt = now();
  approval.resolvedBy = decidedBy;
  approval.result = execute ? 'approved' : 'cancelled';
  approval.resolveReason = resolveReason || (execute ? 'approved' : 'cancelled');
  let sanction = null;
  if (execute) {
    const existing = store.sanctions.items.find(item => !item.paid && !['bezahlt','storniert'].includes(item.status)
      && item.userId === approval.userId
      && item.source === approval.source
      && (item.relatedWeek || null) === (approval.relatedWeek || null)
      && (item.relatedCategory || null) === (approval.relatedCategory || null)
      && (item.relatedTermId || null) === (approval.relatedTermId || null));
    if (existing) {
      sanction = existing;
    } else {
      sanction = createSanction({
      userId: approval.userId,
      issuerId: approval.issuerId || decidedBy || null,
      catalogNo: approval.catalogNo,
      penaltyType: approval.penaltyType,
      amount: approval.amount,
      extraReason: approval.reason,
      extraDays: approval.extraDays || 0,
      source: approval.source,
      relatedWeek: approval.relatedWeek || null,
      relatedCategory: approval.relatedCategory || null,
      relatedTermId: approval.relatedTermId || null,
      });
    }
    if (approval.entryMarker && approval.relatedWeek && approval.relatedCategory) {
      const entry = ensureAbgabeEntry(approval.relatedWeek, approval.relatedCategory, approval.userId);
      entry.sanctionIssued = true;
      entry.status = 'nicht_abgegeben';
      entry.updatedAt = isoStringNow();
    }
    await postSanctionPublic(guild, sanction);
    await sendSanctionIssuedDM(guild, sanction);
  } else if (shouldUseApprovalForSanctionSource(approval.source) && approval.userId) {
    // Wenn Leader eine automatisch erzeugte Sanktion ablehnen/stoppen,
    // darf der nächste Scan dieselbe Sanktion beim Neustart nicht erneut vorschlagen.
    suppressAutoSanction(approval.source, approval.userId, approval.relatedWeek || null, approval.relatedCategory || null, approval.relatedTermId || null, decidedBy, approval.resolveReason || 'manual_no');
    if (approval.source === 'abgabe-auto' && approval.relatedWeek && approval.relatedCategory && approval.entryMarker) {
      const entry = ensureAbgabeEntry(approval.relatedWeek, approval.relatedCategory, approval.userId);
      entry.sanctionSuppressed = true;
      entry.sanctionSuppressedAt = isoStringNow();
      entry.sanctionSuppressedBy = decidedBy || null;
      entry.sanctionSuppressedReason = approval.resolveReason || 'manual_no';
      entry.updatedAt = isoStringNow();
    }
  }
  await upsertApprovalMessage(guild, approval);
  saveAll();
  return sanction;
}
async function createSanctionApproval(guild, data) {
  ensureSessionShape();
  if (!data?.userId) throw new Error('Freigabe ohne Mitglied wurde blockiert.');
  data.catalogNo = String(data.catalogNo || '').padStart(2, '0');
  if (!getSanctionCatalogLabel(data.catalogNo)) throw new Error(`Ungültige Katalognummer für Freigabe: ${data.catalogNo}`);
  if (data.relatedWeek && !sanitizeWeekKey(data.relatedWeek)) throw new Error(`Ungültige Woche für Freigabe: ${data.relatedWeek}`);
  data.amount = safePositiveAmount(data.amount, 0);
  data.extraDays = Math.max(0, safePositiveAmount(data.extraDays, 0));
  const normalizedReason = normalizeText(data.reason || '');

  if (isAutoSanctionSuppressed(data.source, data.userId, data.relatedWeek || null, data.relatedCategory || null, data.relatedTermId || null)) {
    return null;
  }

  if (!shouldUseApprovalForSanctionSource(data.source)) {
    const sanction = createSanction({
      userId: data.userId,
      issuerId: data.issuerId || null,
      catalogNo: data.catalogNo,
      penaltyType: data.penaltyType,
      amount: data.amount,
      extraReason: data.reason,
      extraDays: data.extraDays || 0,
      source: data.source || 'manual',
      relatedWeek: data.relatedWeek || null,
      relatedCategory: data.relatedCategory || null,
      relatedTermId: data.relatedTermId || null,
    });
    if (sanction) {
      await postSanctionPublic(guild, sanction);
      await sendSanctionIssuedDM(guild, sanction);
    }
    return sanction;
  }

  // Dry-Run/Testmodus darf echte Auto-Sanktionen nicht unsichtbar blockieren.
  // Vorher wurde trotz Dry-Run eine offene Freigabe gespeichert. Diese konnte
  // anschließend als Duplikat wirken oder später doch noch finalisiert werden.
  // Jetzt wird im Testmodus nur geloggt und KEINE Pending-Freigabe angelegt.
  if (getDryRunEnabled()) {
    const channel = getLogChannel(guild);
    if (channel) await safeChannelSend(channel, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🧪 Testmodus: Sanktion simuliert').setDescription('Es wurde keine echte Sanktion und keine Freigabe angelegt.').addFields(
      buildInfoField('Mitglied', [`<@${data.userId}>`], true),
      buildInfoField('Grund', [data.reason || '—'], false),
    )] }, 'dryrun.sanction.simulated').catch(() => null);
    return null;
  }

  const dupe = Object.values(store.sessions.pendingSanctionApprovals).find(item => !item.resolved
    && item.source === data.source
    && item.userId === data.userId
    && item.relatedTermId === (data.relatedTermId || null)
    && item.relatedWeek === (data.relatedWeek || null)
    && item.relatedCategory === (data.relatedCategory || null)
    && normalizeText(item.reason || '') === normalizedReason
    && String(item.catalogNo || '') === String(data.catalogNo || '')
  );
  if (dupe) return dupe;
  const approval = {
    id: uid('approve'),
    createdAt: now(),
    executeAt: data.executeAt || (now() + APPROVAL_TIMEOUT_SECONDS * 1000),
    resolved: false,
    userId: data.userId,
    issuerId: data.issuerId || null,
    source: data.source,
    reason: data.reason,
    catalogNo: data.catalogNo,
    penaltyType: data.penaltyType,
    amount: Number(data.amount || 0),
    extraDays: Number(data.extraDays || 0),
    relatedWeek: data.relatedWeek || null,
    relatedCategory: data.relatedCategory || null,
    relatedTermId: data.relatedTermId || null,
    entryMarker: !!data.entryMarker,
    channelId: null,
    messageId: null,
  };
  store.sessions.pendingSanctionApprovals[approval.id] = approval;
  saveAll();
  await scheduleAutoSanctionBatchReminder(guild);
  await scheduleApprovalTimers(guild, approval);
  return approval;
}
async function processPendingSanctionApprovals() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  for (const approval of Object.values(store.sessions.pendingSanctionApprovals || {})) {
    if (approval.resolved) continue;
    if (isAutoSanctionSuppressed(approval.source, approval.userId, approval.relatedWeek || null, approval.relatedCategory || null, approval.relatedTermId || null)) {
      approval.resolved = true;
      approval.resolvedAt = now();
      approval.result = 'cancelled';
      approval.resolveReason = 'suppressed';
      await upsertApprovalMessage(guild, approval).catch(() => null);
      saveAll();
      continue;
    }
    if (approval.executeAt <= now()) {
      await finalizeApproval(guild, approval, true, null, 'no_response');
    } else {
      await scheduleApprovalTimers(guild, approval).catch(() => null);
    }
  }
}

function getEligibleAttendanceTerms(limit = 20) {
  return (store.terms.items || [])
    .filter(term => term.kind === 'term' && !term.closed && Number(term.startTs || 0) <= now())
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, limit);
}
async function getAttendanceEligibleUserIds(guild, term) {
  const buckets = await getTermStatusBuckets(guild, term);
  return [...buckets.can];
}
function getAttendanceStatusConfig(status) {
  if (status === 'present') return { label: 'Ist da', emoji: '✅', catalogNo: null, penaltyType: null, amount: 0, color: COLORS.success };
  if (status === 'late') return { label: 'Zu spät', emoji: '🟡', catalogNo: '22', penaltyType: 'Grüngeld', amount: 50000, color: COLORS.warning };
  return { label: 'Nicht da', emoji: '❌', catalogNo: '01', penaltyType: 'Grüngeld', amount: 200000, color: COLORS.danger };
}
function getAttendanceStatusText(status) {
  return getAttendanceStatusConfig(status).label;
}
async function buildAttendanceTermPickerResponse(guild, sessionId) {
  const terms = getEligibleAttendanceTerms(25);
  if (!terms.length) {
    return { content: 'Aktuell gibt es keinen gestarteten Termin für einen Anwesenheitscheck.', flags: 64 };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`leader_attendance_term:${sessionId}`)
    .setPlaceholder('Termin für Anwesenheitscheck wählen')
    .addOptions(terms.map(term => ({
      label: `${term.title}`.slice(0, 100),
      description: `${formatGermanDateLabelFromString(term.date)} • ${term.time} Uhr`.slice(0, 100),
      value: term.id,
    })));
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('📋 Anwesenheitscheck starten').setDescription('Termin wählen.')],
    components: [new ActionRowBuilder().addComponents(select)],
    flags: 64,
  };
}
function buildAttendanceCheckEmbed(guild, check) {
  const term = store.terms.items.find(item => item.id === check.termId);
  const pendingMentions = check.pendingUserIds.map(id => `<@${id}>`);
  const doneLines = Object.entries(check.statusByUser || {})
    .map(([userId, status]) => `${getAttendanceStatusConfig(status).emoji} <@${userId}> • ${getAttendanceStatusText(status)}`)
    .sort();
  const selectedLabel = check.selectedUserId ? `<@${check.selectedUserId}>` : 'Niemand ausgewählt';
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📋 Anwesenheitscheck • ${term?.title || 'Termin'}`)
    .setDescription([
      term ? `📅 **${formatGermanDateLabelFromString(term.date)}** • **${term.time} Uhr**` : null,
      `⏳ Gültig bis: **${formatDueLabel(check.expiresAt)}**`,
      `🎯 Ausgewählt: **${selectedLabel}**`,
    ].filter(Boolean).join('\n'))
    .addFields(
      buildInfoField(`🕒 Offen (${check.pendingUserIds.length})`, [pendingMentions.length ? pendingMentions.join('\n') : 'Alle Teilnehmer bewertet.']),
      buildInfoField(`✅ Bearbeitet (${doneLines.length})`, [doneLines.length ? doneLines.join('\n') : 'Noch keine Bewertungen.']),
    )
    .setFooter({ text: 'Nur „Kann“-Teilnehmer • Ablauf nach 30 Minuten' });
}
function buildAttendanceCheckComponents(check) {
  const rows = [];
  const options = check.pendingUserIds.slice(0, 25).map(userId => ({ label: `${check.displayNames?.[userId] || userId}`.slice(0, 100), value: userId }));
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`attendance_pick:${check.id}`)
        .setPlaceholder(check.pendingUserIds.length ? 'Teilnehmer auswählen' : 'Keine offenen Teilnehmer')
        .setDisabled(!check.pendingUserIds.length)
        .addOptions(options.length ? options : [{ label: 'Keine offenen Teilnehmer', value: 'none' }])
    )
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`attendance_mark:${check.id}:present`).setLabel('✅ Ist da').setStyle(ButtonStyle.Success).setDisabled(!check.selectedUserId),
      new ButtonBuilder().setCustomId(`attendance_mark:${check.id}:late`).setLabel('🟡 Zu spät').setStyle(ButtonStyle.Secondary).setDisabled(!check.selectedUserId),
      new ButtonBuilder().setCustomId(`attendance_mark:${check.id}:absent`).setLabel('❌ Nicht da').setStyle(ButtonStyle.Danger).setDisabled(!check.selectedUserId),
    )
  );
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`attendance_close:${check.id}`).setLabel('🗑️ Check schließen').setStyle(ButtonStyle.Secondary),
    )
  );
  return rows;
}
async function updateAttendanceCheckMessage(guild, check) {
  if (!check?.channelId || !check?.messageId) return null;
  const channel = await resolveSystemTextChannel(guild, check.channelId);
  if (!channel) return null;
  const message = await withDiscordRetry(() => channel.messages.fetch(check.messageId)).catch(() => null);
  if (!message) return null;
  const expired = now() >= Number(check.expiresAt || 0);
  if (expired) {
    try { await message.delete().catch(() => null); } catch (_) {}
    check.closed = true;
    check.closedAt = now();
    saveAll();
    return null;
  }
  return safeMessageEdit(message, { embeds: [buildAttendanceCheckEmbed(guild, check)], components: buildAttendanceCheckComponents(check) }, 'attendance.check.edit').catch(error => {
    console.error('ATTENDANCE_CHECK_EDIT_ERROR', error);
    return null;
  });
}
async function scheduleAttendanceCheckExpiry(guild, check) {
  if (!check || check.closed) return;
  const delay = Math.max(1000, Number(check.expiresAt || 0) - now());
  setTimeout(async () => {
    const current = store.sessions.attendanceChecks?.[check.id];
    if (!current || current.closed) return;
    await updateAttendanceCheckMessage(guild, current);
  }, delay);
}
async function createAttendanceCheck(guild, term, createdBy) {
  const monitorChannel = await resolveSystemTextChannel(guild, MONITORING_CHANNEL_ID);
  if (!monitorChannel) throw new Error('Monitoring-Kanal nicht gefunden.');
  const dupe = Object.values(store.sessions.attendanceChecks || {}).find(item => !item.closed && item.termId === term.id && Number(item.expiresAt || 0) > now());
  if (dupe) return dupe;
  const userIds = await getAttendanceEligibleUserIds(guild, term);
  if (!userIds.length) throw new Error('Für diesen Termin gibt es aktuell keine offenen „Kann“-Teilnehmer.');
  const displayNames = {};
  for (const userId of userIds) displayNames[userId] = getUserDisplay(guild, userId);
  const check = {
    id: uid('attendance'),
    termId: term.id,
    createdBy,
    createdAt: now(),
    expiresAt: now() + ATTENDANCE_CHECK_TTL_MS,
    selectedUserId: null,
    pendingUserIds: [...userIds],
    statusByUser: {},
    displayNames,
    channelId: monitorChannel.id,
    messageId: null,
    closed: false,
  };
  const msg = await safeChannelSend(monitorChannel, { embeds: [buildAttendanceCheckEmbed(guild, check)], components: buildAttendanceCheckComponents(check) }, 'attendance.check.send');
  if (!msg) throw new Error('Anwesenheitscheck konnte nicht gesendet werden.');
  check.messageId = msg.id;
  store.sessions.attendanceChecks[check.id] = check;
  saveAll();
  await scheduleAttendanceCheckExpiry(guild, check);
  await logSystemEvent(guild, '📋 Anwesenheitscheck erstellt', [
    `Termin: ${term.title}`,
    `Teilnehmer: ${userIds.length}`,
    `Erstellt von: ${getUserDisplay(guild, createdBy)}`,
  ], COLORS.info);
  return check;
}
async function handleAttendanceStatusDecision(guild, check, userId, status, actorId) {
  if (!check || check.closed) return;
  if (!check.pendingUserIds.includes(userId)) return;
  check.pendingUserIds = check.pendingUserIds.filter(id => id !== userId);
  check.statusByUser[userId] = status;
  check.selectedUserId = null;
  saveAll();
  const cfg = getAttendanceStatusConfig(status);
  if (status === 'late' || status === 'absent') {
    const source = `attendance-${status}`;
    const reason = `${cfg.label} beim Anwesenheitscheck: ${(store.terms.items.find(item => item.id === check.termId)?.title) || 'Termin'}`;
    const alreadyExists = store.sanctions.items.some(item => !item.paid && item.source === source && item.relatedTermId === check.termId && item.userId === userId);
    const alreadyPending = Object.values(store.sessions.pendingSanctionApprovals || {}).some(item => !item.resolved && item.source === source && item.relatedTermId === check.termId && item.userId === userId);
    if (!alreadyExists && !alreadyPending) {
      await createSanctionApproval(guild, {
        userId,
        issuerId: actorId || null,
        source,
        reason,
        catalogNo: cfg.catalogNo,
        penaltyType: cfg.penaltyType,
        amount: cfg.amount,
        relatedTermId: check.termId,
        executeAt: now() + (APPROVAL_TIMEOUT_SECONDS * 1000),
      });
    }
  }
  await logSystemEvent(guild, '🧾 Anwesenheitsentscheidung', [
    `Mitglied: ${getUserDisplay(guild, userId)}`,
    `Status: ${cfg.label}`,
    `Bearbeitet von: ${getUserDisplay(guild, actorId)}`,
  ], cfg.color);
  await updateAttendanceCheckMessage(guild, check);
}
async function cleanupExpiredAttendanceChecks(guild) {
  let changed = false;
  for (const check of Object.values(store.sessions.attendanceChecks || {})) {
    if (check.closed) continue;
    if (Number(check.expiresAt || 0) <= now()) {
      await updateAttendanceCheckMessage(guild, check);
      check.closed = true;
      check.closedAt ||= now();
      changed = true;
      continue;
    }
    if (check.channelId && check.messageId) {
      const channel = await resolveSystemTextChannel(guild, check.channelId).catch(() => null);
      const msg = channel ? await channel.messages.fetch(check.messageId).catch(() => null) : null;
      if (!msg) {
        check.closed = true;
        check.closedAt = now();
        check.closedReason = 'message_missing_after_restart';
        changed = true;
      }
    }
  }
  if (changed) saveAll();
}
async function buildPendingApprovalsEmbed(guild) {
  const pending = Object.values(store.sessions.pendingSanctionApprovals || {}).filter(item => !item.resolved).sort((a,b)=>a.executeAt-b.executeAt);
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⚠️ Offene Sanktions-Freigaben')
    .setDescription(pending.length ? pending.map(item => `• ${getUserDisplay(guild, item.userId)} • ${item.reason} • Auto in ${formatRelativeTermCountdown(item.executeAt)}`).join('\n').slice(0,3900) : 'Aktuell keine offenen Freigaben.')
    .setFooter({ text: 'Freigaben • Ja/Nein möglich' });
}


function buildWeeklyBriefEmbed(guild) {
  const weekKey = currentWeekKey();
  const lines = [];
  const abgabe = { offen: 0, warnphase: 0, spaeter: 0, entschuldigt: 0 };
  for (const category of getEnabledAbgabeKeys()) {
    for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'weekly-brief' })) {
      const row = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
      if (row.status === 'offen') abgabe.offen += 1;
      else if (row.status === 'warnphase') abgabe.warnphase += 1;
      else if (row.status === 'spaeter_abgabe') abgabe.spaeter += 1;
      else if (row.status === 'entschuldigt') abgabe.entschuldigt += 1;
    }
  }
  const openSanctions = (store.sanctions.items || []).filter(item => !item.paid && !['bezahlt','storniert'].includes(item.status));
  const activeAbsences = (store.absences.items || []).filter(item => item.active && Number(item.untilTs || 0) > now());
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🗓️ Woche • ${weekKey}`)
    .addFields(
      buildInfoField('📦 Abgaben', [
        `Offen: **${abgabe.offen}**`,
        `Warnphase: **${abgabe.warnphase}**`,
        `Nachholen: **${abgabe.spaeter}**`,
        `Entschuldigt: **${abgabe.entschuldigt}**`,
      ], true),
      ...(await (async () => { const summary = await buildWacheSummary(guild, currentWeek); const open = summary.rows.filter(r => !r.fulfilled && !r.excused).length; const done = summary.rows.filter(r => r.fulfilled).length; const exc = summary.rows.filter(r => r.excused).length; const active = store.wache?.active && !store.wache.active.closed ? store.wache.active : null; return [buildInfoField('🟢 Wache', [`Status: **${summary.cfg.enabled ? 'AN' : 'AUS'}**`, `Pflicht: **${summary.required} min/Woche**`, `Erfüllt: **${done}/${summary.rows.length}**`, `Offen: **${open}** | Entschuldigt: **${exc}**`, active ? `Läuft bis: **${formatDateTime(active.endTs)}**` : 'Aktuell: **keine laufende Wache**'], true)]; })()),
      buildInfoField('⚖️ Sanktionen', [
        `Offen: **${openSanctions.length}**`,
        `Freigaben: **${Object.keys(store.sessions.pendingSanctionApprovals || {}).length}**`,
      ], true),
      buildInfoField('📋 Abmeldungen', [
        `Aktiv: **${activeAbsences.length}**`,
        `Nur Termin: **${activeAbsences.filter(x => x.appliesTo === 'term_only').length}**`,
      ], true),
    )
    .setFooter({ text: 'Wochenbericht • privat' })
    .setTimestamp(new Date());
}
function buildStatsSnapshotEmbed(guild) {
  const risk = analyzeOperationalRisk(guild);
  const top = (store.sanctions.items || []).filter(item => !item.paid && !['bezahlt','storniert'].includes(item.status)).slice(0, 5);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📈 Statistik')
    .addFields(
      buildInfoField('🚨 Risiko', [
        `Abgabe: **${risk.abgabeAtRisk.length}**`,
        `Sanktion 48h: **${risk.sanctionAtRisk.length}**`,
        `Keine Antwort 48h: **${risk.noResponseAtRisk.length}**`,
      ], true),
      buildInfoField('🛡️ Sicherheit', [
        `DM-Fehler: **${getRecentDmFailures(999).length}**`,
        `Rollbacks: **${(store.sessions.rollbackStack || []).filter(x => !x.used && Number(x.expiresAt || 0) > now()).length}**`,
        `Whitelist: **${(store.config.safety?.whitelistUserIds || []).length}**`,
        `Blacklist: **${(store.config.safety?.blacklistUserIds || []).length}**`,
      ], true),
      buildInfoField('⚖️ Offen', top.length ? top.map(item => `${getUserDisplay(guild, item.userId)} • ${item.catalogNo || '—'} • ${item.penaltyType || '—'}`) : ['—'], false),
    )
    .setFooter({ text: 'Statistik • privat' })
    .setTimestamp(new Date());
}
function buildRightsCheckEmbed(guild) {
  const rows = [];
  const checks = [
    ['Log', getLogChannel(guild)],
    ['Dashboard', getDashboardChannel(guild)],
    ['Statistik', getStatsChannel(guild)],
    ['Monitoring', guild?.channels?.cache?.get(MONITORING_CHANNEL_ID) || null],
    ['Freigaben', guild?.channels?.cache?.get(APPROVAL_CHANNEL_ID) || null],
  ];
  for (const [label, channel] of checks) rows.push(`${label}: **${channel ? 'OK' : 'fehlt'}**`);
  return new EmbedBuilder().setColor(COLORS.primary).setTitle('🔐 Rechte & Kanäle').setDescription(rows.join('\n')).setFooter({ text: 'Diagnose • privat' });
}


function formatPercentBar(value, size = 10) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(value || 0))));
  const filled = Math.round((pct / 100) * size);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, size - filled))} ${pct}%`;
}
function getRiskLabel(score) {
  const n = Number(score || 0);
  if (n >= 85) return '🔴 kritisch';
  if (n >= 60) return '🟠 hoch';
  if (n >= 35) return '🟡 beobachten';
  return '🟢 niedrig';
}
function getAbsenceStatsForUser(userId, monthKey = getMonthKey(getTzDate())) {
  const items = (store.absences.items || []).filter(x => x.userId === userId);
  let totalDays = 0;
  let monthDays = 0;
  let active = 0;
  let count = items.length;
  const monthStart = new Date(`${monthKey}-01T00:00:00`).getTime();
  const monthEndDate = new Date(monthStart);
  monthEndDate.setMonth(monthEndDate.getMonth() + 1);
  const monthEnd = monthEndDate.getTime() - 1;
  for (const item of items) {
    const from = Number(item.fromTs || item.createdAt || 0);
    const until = Number(item.untilTs || from || 0);
    if (item.active && until > now()) active += 1;
    if (from && until) {
      totalDays += Math.max(1, Math.ceil((until - from) / 86400000));
      const overlapStart = Math.max(from, monthStart);
      const overlapEnd = Math.min(until, monthEnd);
      if (overlapEnd > overlapStart) monthDays += Math.max(1, Math.ceil((overlapEnd - overlapStart) / 86400000));
    }
  }
  return { count, totalDays, monthDays, active };
}
function getAbgabeStatsForUser(guild, userId, weekLimit = 4) {
  let total = 0, submitted = 0, partial = 0, late = 0, open = 0, excused = 0;
  for (const category of Object.keys(ABGABEN)) {
    const st = getAbgabeCategoryStatsForUser(guild, userId, category, weekLimit);
    if (!st.enabled || !st.inRole) continue;
    total += st.total;
    submitted += st.submitted;
    partial += st.partial;
    late += st.late;
    open += st.open;
    excused += st.excused;
  }
  return { total, submitted, partial, late, open, excused };
}
function getTermStatsForUser(userId) {
  let total = 0, can = 0, maybe = 0, cannot = 0, absent = 0, noResponse = 0;
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    total += 1;
    const response = term.responses?.[userId];
    const isAutoCan = !!term.autoCanUsers?.[userId];
    const isAbsent = !!getAbsenceAt(userId, term.startTs, 'term') && !isAutoCan;
    const isAutoCannot = !!term.autoCannotUsers?.[userId] && !isAutoCan;
    if (isAutoCan || response === 'can') can += 1;
    else if (response === 'maybe') maybe += 1;
    else if (response === 'cannot') cannot += 1;
    else if (isAbsent || isAutoCannot) absent += 1;
    else noResponse += 1;
  }
  return { total, can, maybe, cannot, absent, noResponse };
}
function getWacheStatsForUser(userId) {
  if (!getWacheConfig().enabled) return { enabled: false, weeks: 0, fulfilled: 0, open: 0, minutes: 0 };
  let weeks = 0, fulfilled = 0, open = 0, minutes = 0;
  for (const week of Object.values(store.wache?.weeks || {})) {
    const row = week.users?.[userId] || week.members?.[userId];
    if (!row) continue;
    weeks += 1;
    const mins = Number(row.minutes || row.totalMinutes || 0);
    minutes += mins;
    if (row.fulfilled || mins >= Number(getWacheConfig().requiredMinutesPerWeek || 60)) fulfilled += 1;
    else open += 1;
  }
  return { enabled: true, weeks, fulfilled, open, minutes };
}
function getMemberAnalysisRecommendation(reliability, problem, abgabe, term, absence, wache) {
  const lines = [];
  if (problem.risk >= 85) lines.push('Sofort beobachten: sehr hohes Risiko durch mehrere negative Faktoren.');
  else if (problem.risk >= 60) lines.push('Beobachten: auffälliges Verhalten oder schlechte Zuverlässigkeit.');
  else if (reliability.score >= 85) lines.push('Sehr zuverlässig: keine unnötigen Reminder nötig.');
  else lines.push('Normal beobachten: aktuell kein harter Eingriff nötig.');
  if (abgabe.open > 0) lines.push(`Offene Abgaben: ${abgabe.open}.`);
  if (abgabe.late >= 3) lines.push('Muster: gibt häufig spät ab.');
  if (term.noResponse >= 3) lines.push('Muster: ignoriert Termine häufig.');
  if (absence.monthDays >= 10) lines.push('Viele Abmeldetage im aktuellen Monat.');
  if (wache.open >= 2) lines.push('Wache prüfen: Pflicht öfter nicht erfüllt.');
  if (Array.isArray(reliability.behaviorLabels) && reliability.behaviorLabels.length) lines.push(`Verhalten: ${reliability.behaviorLabels.join(', ')}.`);
  return lines.slice(0, 6);
}
async function buildMembersDashboardEmbed(guild) {
  await ensureGuildMembersCached(guild);
  const topReliable = await buildReliabilityLeaderboard(guild, 5, 'top');
  const lowReliable = await buildReliabilityLeaderboard(guild, 5, 'low');
  const problemMembers = await buildProblemMembers(guild, 5);
  const monthKey = getMonthKey(getTzDate());
  const absenceRows = getRelevantGuildMembers(guild)
    .map(m => ({ userId: m.id, ...getAbsenceStatsForUser(m.id, monthKey) }))
    .sort((a, b) => b.monthDays - a.monthDays)
    .slice(0, 5);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📊 Erweitertes Mitglieder-Dashboard')
    .setDescription('Analyse pro Person: Zuverlässigkeit, Risiko, Abgaben, Termine, Abmeldungen, Wache und Verhaltensmuster.')
    .addFields(
      buildInfoField('🏆 Top zuverlässig', buildReliabilityLines(guild, topReliable), true),
      buildInfoField('🚨 Höchstes Risiko', problemMembers.length ? problemMembers.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} • ${getRiskLabel(row.risk)} (${row.risk})`) : ['—'], true),
      buildInfoField('📉 Schwächste Zuverlässigkeit', lowReliable.length ? lowReliable.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} • ${row.score}% (${getReliabilityLabel(row.score)})`) : ['—'], true),
      buildInfoField('📋 Abmeldungen diesen Monat', absenceRows.length ? absenceRows.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} • ${row.monthDays} Tag(e) • ${row.count} Abmeldung(en)`) : ['—'], false),
      buildInfoField('ℹ️ Bedienung', ['Wähle unten ein Mitglied aus, um die Detailanalyse zu öffnen.', 'Die Auswahl zeigt Score, Risiko, Muster und konkrete Empfehlung.'], false),
    )
    .setFooter({ text: 'Mitglieder Analyse • Werte aus gespeicherten Abgaben, Terminen, Abmeldungen, Wache und Sanktionen' })
    .setTimestamp(new Date());
}
function buildMemberAnalysisEmbed(guild, userId) {
  const reliability = calculateReliabilityForUser(guild, userId);
  const problem = getProblemScoreForUser(guild, userId);
  const abgabe = getAbgabeStatsForUser(guild, userId);
  const term = getTermStatsForUser(userId);
  const absence = getAbsenceStatsForUser(userId);
  const wache = getWacheStatsForUser(userId);
  const sanctions = (store.sanctions.items || []).filter(x => x.userId === userId);
  const openSanctions = sanctions.filter(x => !x.paid && !['bezahlt','storniert'].includes(x.status)).length;
  const recommend = getMemberAnalysisRecommendation(reliability, problem, abgabe, term, absence, wache);
  return new EmbedBuilder()
    .setColor(problem.risk >= 85 ? COLORS.danger : problem.risk >= 60 ? COLORS.warning : COLORS.primary)
    .setTitle(`👤 Mitgliederanalyse • ${getUserDisplay(guild, userId)}`)
    .setDescription([
      `Zuverlässigkeit: **${getReliabilityLabel(reliability.score)}**`,
      formatPercentBar(reliability.score),
      `Risiko: **${getRiskLabel(problem.risk)}**`,
      formatPercentBar(problem.risk),
    ].join('\n'))
    .addFields(
      buildInfoField('📦 Abgaben gesamt (letzte 4 Wochen)', [`Gesamt: **${abgabe.total}**`, `Erledigt: **${abgabe.submitted}**`, `Teilabgaben: **${abgabe.partial}**`, `Offen: **${abgabe.open}**`, `Spät: **${abgabe.late}**`, `Entschuldigt/Nachholen: **${abgabe.excused}**`], true),
      buildInfoField('📦 Abgaben je Bereich', Object.keys(ABGABEN).map(category => formatMemberAbgabeCategoryLine(guild, userId, category)), true),
      buildInfoField('📅 Termine', [`Gesamt: **${term.total}**`, `Kann: **${term.can}**`, `Vielleicht: **${term.maybe}**`, `Kann nicht: **${term.cannot}**`, `Abgemeldet: **${term.absent}**`, `Keine Antwort: **${term.noResponse}**`], true),
      buildInfoField('📋 Abmeldungen', [`Aktiv: **${absence.active}**`, `Anzahl: **${absence.count}**`, `Tage gesamt: **${absence.totalDays}**`, `Tage diesen Monat: **${absence.monthDays}**`], true),
      buildInfoField('🟢 Wache', wache.enabled === false ? ['**Nicht aktiviert**'] : [`Wochen erfasst: **${wache.weeks}**`, `Erfüllt: **${wache.fulfilled}**`, `Offen/nicht erfüllt: **${wache.open}**`, `Minuten gesamt: **${wache.minutes}**`], true),
      buildInfoField('⚖️ Sanktionen', [`Gesamt: **${sanctions.length}**`, `Offen: **${openSanctions}**`, `Decay-Penalty: **${reliability.sanctionPenalty || 0}**`, `Behavior-Modifier: **${reliability.behaviorModifier || 0}**`], true),
      buildInfoField('🧠 Muster', reliability.behaviorLabels?.length ? reliability.behaviorLabels : ['Keine starken Muster erkannt.'], true),
      buildInfoField('🧭 Empfehlung', recommend, false),
    )
    .setFooter({ text: 'Detailanalyse • Score basiert auf den letzten 4 Wochen • gutes Verhalten verbessert den Score wieder' })
    .setTimestamp(new Date());
}
function getMembersDashboardRows(guild) {
  return getRelevantGuildMembers(guild)
    .map(m => ({ member: m, score: getProblemScoreForUser(guild, m.id).risk, reliability: calculateReliabilityForUser(guild, m.id).score }))
    .sort((a, b) => b.score - a.score || a.member.displayName.localeCompare(b.member.displayName, 'de'));
}
function getMembersDashboardOptions(guild, page = 0) {
  const rows = getMembersDashboardRows(guild);
  const safePage = Math.max(0, Math.min(Number(page || 0), Math.max(0, Math.ceil(rows.length / 25) - 1)));
  return rows.slice(safePage * 25, (safePage + 1) * 25).map(({ member, score, reliability }) => ({
    label: String(member.displayName || member.user.username || member.id).slice(0, 100),
    description: `Risiko ${score} • ${getReliabilityLabel(reliability)}`.slice(0, 100),
    value: member.id,
  }));
}
function buildMembersDashboardComponents(guild, page = 0) {
  const rowsAll = getMembersDashboardRows(guild);
  const maxPage = Math.max(0, Math.ceil(rowsAll.length / 25) - 1);
  const safePage = Math.max(0, Math.min(Number(page || 0), maxPage));
  const options = getMembersDashboardOptions(guild, safePage);
  const rows = [];
  if (options.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`members_dashboard_select:${safePage}`)
        .setPlaceholder(`Mitglied auswählen • Seite ${safePage + 1}/${maxPage + 1} • ${rowsAll.length} Mitglieder`)
        .addOptions(options)
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`members_dashboard_page:prev:${Math.max(0, safePage - 1)}`).setLabel('⬅️ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`members_dashboard_page:next:${Math.min(maxPage, safePage + 1)}`).setLabel('Weiter ➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= maxPage),
    new ButtonBuilder().setCustomId(`members_dashboard_back:${safePage}`).setLabel('📊 Übersicht').setStyle(ButtonStyle.Primary),
  ));
  return rows;
}
async function upsertMembersDashboardMessage(guild, channel = null) {
  await ensureGuildMembersCached(guild);
  const target = channel || getDashboardChannel(guild);
  if (!target) return null;
  const payload = { embeds: [await buildMembersDashboardEmbed(guild)], components: buildMembersDashboardComponents(guild) };
  return upsertStoredPanelMessage('members_dashboard', target, payload);
}
function buildMainDashboardComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dashboard_members_open').setLabel('📊 Erweitertes Mitglieder-Dashboard').setStyle(ButtonStyle.Primary),
  )];
}

async function buildDashboardEmbed(guild) {
  const cacheKey = `dashboardEmbed:${guild?.id || 'guild'}`;
  const cached = store.config?.statsCache?.[cacheKey];
  if (cached && Number(cached.expiresAt || 0) > now()) {
    try { return EmbedBuilder.from(cached.value); } catch (_) {}
  }
  await ensureGuildMembersCached(guild);
  const baseWeek = currentWeekKey();
  const currentWeek = getActiveAbgabeDashboardWeek(guild, baseWeek);
  const activeWeekNotice = getActiveAbgabeWeekNotice(guild, baseWeek);
  const stress = getStressLevel(guild);
  const topReliable = await buildReliabilityLeaderboard(guild, 5, 'top');
  const problemMembers = await buildProblemMembers(guild, 5);
  const nextTerm = (store.terms.items || [])
    .filter(t => t.kind === 'term' && !t.closed && Number(t.startTs || 0) > now())
    .sort((a, b) => a.startTs - b.startTs)[0] || null;
  const operationalRisk = analyzeOperationalRisk(guild);

  const abgabeCounts = {
    erledigt: 0,
    offen: 0,
    warnphase: 0,
    spaeter_abgabe: 0,
    entschuldigt: 0,
    vorausgezahlt: 0,
    zu_spaet: 0,
    nicht_abgegeben: 0,
    gesamt: 0,
    aktiv: 0,
    deaktiviert: 0,
  };
  const abgabeDetailRows = [];
  for (const category of Object.keys(ABGABEN)) {
    const cfg = getAbgabeRuntimeConfig(category);
    const detail = {
      category,
      label: cfg.label,
      emoji: cfg.emoji || '📦',
      enabled: cfg.enabled,
      amount: Number(cfg.amount || 0),
      deadlineTs: abgabeDeadlineTsForWeek(currentWeek, category),
      counts: { erledigt: 0, offen: 0, warnphase: 0, spaeter_abgabe: 0, entschuldigt: 0, vorausgezahlt: 0, zu_spaet: 0, nicht_abgegeben: 0, gesamt: 0 },
    };
    if (!cfg.enabled) {
      abgabeCounts.deaktiviert += 1;
      abgabeDetailRows.push(detail);
      continue;
    }
    abgabeCounts.aktiv += 1;
    for (const member of getRequiredMembersForAbgabe(guild, category, currentWeek, { reason: 'dashboard' })) {
      const row = getAbgabeStatusForWeek(guild, currentWeek, category, member.id);
      const status = String(row.status || 'offen');
      detail.counts.gesamt += 1;
      abgabeCounts.gesamt += 1;
      if (status === 'abgegeben') {
        detail.counts.erledigt += 1;
        abgabeCounts.erledigt += 1;
      } else if (Object.prototype.hasOwnProperty.call(detail.counts, status)) {
        detail.counts[status] += 1;
        if (Object.prototype.hasOwnProperty.call(abgabeCounts, status)) abgabeCounts[status] += 1;
      } else if (status === 'nicht_abgegeben') {
        detail.counts.nicht_abgegeben += 1;
        abgabeCounts.nicht_abgegeben += 1;
      } else {
        detail.counts.offen += 1;
        abgabeCounts.offen += 1;
      }
    }
    abgabeDetailRows.push(detail);
  }
  abgabeCounts.offen += abgabeCounts.nicht_abgegeben;

  const abgabeCards = abgabeDetailRows.map(detail => {
    const shortDeadline = formatCompactDashboardDeadline(detail.category, currentWeek)
      .replace(/^verschoben auf\s+/i, 'verschoben: ');
    if (!detail.enabled) {
      return buildInfoField(`${detail.emoji} ${detail.label}`, [
        `Status: **AUS**`,
        `Menge: **${formatAmount(detail.category, detail.amount)}**`,
        `Frist: **${shortDeadline}**`,
        '​',
        '​',
        '​',
      ], true);
    }
    const openTotal = detail.counts.offen + detail.counts.nicht_abgegeben;
    const relative = formatDaysUntilLabel(detail.deadlineTs);
    const deadlineLine = relative && relative !== '—' ? `${shortDeadline} (${relative})` : shortDeadline;
    return buildInfoField(`${detail.emoji} ${detail.label}`, [
      `Menge: **${formatAmount(detail.category, detail.amount)}**`,
      `Frist: **${deadlineLine}**`,
      `Abgegeben: **${detail.counts.erledigt}/${detail.counts.gesamt}**`,
      `Offen: **${openTotal}** | Warn: **${detail.counts.warnphase}**`,
      `Nachholen: **${detail.counts.spaeter_abgabe}** | Entsch.: **${detail.counts.entschuldigt}**`,
      `Voraus: **${detail.counts.vorausgezahlt}** | Spät: **${detail.counts.zu_spaet}**`,
    ], true);
  });
  const abgabeDetailFields = [];
  if (activeWeekNotice) {
    abgabeDetailFields.push(buildInfoField('⏰ Verschobene Abgabe aktiv', [activeWeekNotice, `Panel/Dashboard schreiben weiter auf die alte Woche, bis erledigt oder Frist vorbei ist.`], false));
  }
  for (let i = 0; i < abgabeCards.length; i += 2) {
    abgabeDetailFields.push(abgabeCards[i]);
    if (abgabeCards[i + 1]) abgabeDetailFields.push(abgabeCards[i + 1]);
    // Discord zeigt maximal 3 Inline-Felder pro Zeile. Dieser leere Platzhalter erzwingt ein sauberes 2x2-Layout
    // statt 3 Felder oben und 1 Feld unten. So bleibt das Dashboard wie vorher, nur deutlich ordentlicher/breiter.
    abgabeDetailFields.push(buildDashboardSpacerField());
  }

  const sanctions = store.sanctions.items || [];
  const openSanctions = sanctions.filter(item => !item.paid && item.status !== 'bezahlt');
  const sanctionsDueToday = openSanctions.filter(item => item.dueAt && formatRelativeDayLabel(item.dueAt) === 'heute').length;
  const sanctionsSurcharge = openSanctions.filter(item => item.status === 'zuschlag' || item.surchargeApplied).length;
  const sanctionsBloodout = openSanctions.filter(item => item.status === 'bloodout' || item.bloodoutAnnounced).length;
  const sanctionsApproval = Object.keys(store.sessions.pendingSanctionApprovals || {}).length;

  let nextTermSummary = '—';
  let nextTermAdvice = 'Kein kommender Termin.';
  let nextTermAnswers = ['Kann: **0**', 'Vielleicht: **0**', 'Kann nicht: **0**', 'Keine Antwort: **0**'];
  if (nextTerm) {
    const buckets = await getTermStatusBuckets(guild, nextTerm);
    nextTermSummary = `**${nextTerm.title}**\n${formatGermanDateLabelFromString(nextTerm.date)} • ${nextTerm.time} Uhr\n${formatRelativeTermCountdown(nextTerm.startTs)}`;
    nextTermAnswers = [
      `Kann: **${buckets.can.length}**`,
      `Vielleicht: **${buckets.maybe.length}**`,
      `Kann nicht: **${buckets.cannot.length}**`,
      `Keine Antwort: **${buckets.noResponse.length}**`,
    ];
    nextTermAdvice = getDecisionHelp(nextTerm, buckets)
      .replace(/^⚠️\s*Empfehlung:\s*/i, '')
      .replace(/^Empfehlung:\s*/i, '');
  }

  cleanupAbsences();
  const activeAbsences = (store.absences.items || []).filter(item => item.active && Number(item.untilTs || 0) > now());
  const absenceEndsToday = activeAbsences.filter(item => formatDate(item.untilTs) === formatDate(now())).length;
  const termOnlyAbsences = activeAbsences.filter(item => item.appliesTo === 'term_only').length;
  const longAbsences = activeAbsences.filter(item => absenceDurationDays(item) >= 5).length;

  const recentDmFailures = getRecentDmFailures(25).length;
  const openRollbacks = (store.sessions.rollbackStack || []).filter(x => !x.used && Number(x.expiresAt || 0) > now()).length;
  const openAttendanceChecks = Object.values(store.sessions.attendanceChecks || {}).filter(item => !item.closed && Number(item.expiresAt || 0) > now()).length;
  const integrityWarnings = (runIntegrityAudit() || []).length;

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📊 ${getBotAppearance().dashboardTitle}`)
    .setDescription(`Woche **${currentWeek}** • Status live`)
    .addFields(
      buildInfoField('📦 Abgaben Gesamt', [
        `Aktive Arten: **${abgabeCounts.aktiv}** | Aus: **${abgabeCounts.deaktiviert}**`,
        `Abgegeben: **${abgabeCounts.erledigt} / ${abgabeCounts.gesamt}**`,
        `Offen: **${abgabeCounts.offen}**`,
        `Warnphase: **${abgabeCounts.warnphase}**`,
        `Nachholen: **${abgabeCounts.spaeter_abgabe}**`,
      ], true),
      buildInfoField('📦 Zusatz Gesamt', [
        `Entschuldigt: **${abgabeCounts.entschuldigt}**`,
        `Vorausgezahlt: **${abgabeCounts.vorausgezahlt}**`,
        `Zu spät: **${abgabeCounts.zu_spaet}**`,
        `Stress: **${stress.label}** (${stress.score}/100)`,
      ], true),
      buildDashboardSectionField('📦 Einzelne Abgaben'),
      ...abgabeDetailFields,
      buildDashboardSectionField('🧩 Weitere Systeme'),
      ...(await (async () => { const summary = await buildWacheSummary(guild, currentWeek); const open = summary.rows.filter(r => !r.fulfilled && !r.excused).length; const done = summary.rows.filter(r => r.fulfilled).length; const exc = summary.rows.filter(r => r.excused).length; const active = store.wache?.active && !store.wache.active.closed ? store.wache.active : null; return [buildInfoField('🟢 Wache', [`Status: **${summary.cfg.enabled ? 'AN' : 'AUS'}**`, `Pflicht: **${summary.required} min/Woche**`, `Erfüllt: **${done}/${summary.rows.length}**`, `Offen: **${open}** | Entschuldigt: **${exc}**`, active ? `Läuft bis: **${formatDateTime(active.endTs)}**` : 'Aktuell: **keine laufende Wache**'], true)]; })()),
      buildInfoField('⚖️ Sanktionen', [
        `Offen: **${openSanctions.length}**`,
        `Heute fällig: **${sanctionsDueToday}**`,
        `+100k aktiv: **${sanctionsSurcharge}**`,
        `Bloodout: **${sanctionsBloodout}**`,
      ], true),
      buildInfoField('📅 Termine', [
        nextTermSummary,
        ...nextTermAnswers,
      ], false),
      buildInfoField('📋 Abmeldungen', [
        `Aktiv: **${activeAbsences.length}**`,
        `Enden heute: **${absenceEndsToday}**`,
        `Nur Termin: **${termOnlyAbsences}**`,
        `5+ Tage: **${longAbsences}**`,
      ], true),
      buildInfoField('🧠 Risiko', [
        `Abgabe: **${operationalRisk.abgabeAtRisk.length}**`,
        `Sanktion 48h: **${operationalRisk.sanctionAtRisk.length}**`,
        `Keine Antwort 48h: **${operationalRisk.noResponseAtRisk.length}**`,
        `Freigaben offen: **${sanctionsApproval}**`,
      ], true),
      buildInfoField('🔐 System', [
        `Logs: **${getLogChannel(guild) ? 'OK' : '—'}**`,
        `DM-Fehler: **${recentDmFailures}**`,
        `Rollbacks: **${openRollbacks}**`,
        `Attendance offen: **${openAttendanceChecks}**`,
      ], true),
      buildInfoField('🧭 Hinweis', [
        nextTermAdvice,
        `Integrität: **${integrityWarnings}** Hinweis${integrityWarnings === 1 ? '' : 'e'}`,
      ], false),
      buildDashboardSectionField('📈 Auswertung'),
      buildInfoField('🏆 Zuverlässig', buildReliabilityLines(guild, topReliable), true),
      buildInfoField('🚨 Auffällig', problemMembers.length ? problemMembers.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} • Risk ${row.risk}`) : ['—'], true),
    )
    .addFields(buildInfoField('🧾 Letzte Audit-Änderungen', getRecentAuditLines(6), false))
    .setFooter({ text: 'Dashboard • Cache 5 Minuten • automatisch aktualisiert' })
    .setTimestamp(new Date());
  store.config.statsCache[cacheKey] = { value: embed.toJSON(), createdAt: now(), expiresAt: now() + (5 * 60 * 1000) };
  return embed;
}

async function upsertDashboardMessage(guild, options = {}) {
  if (!store.config.settings.dashboardEnabled) return null;
  const channel = getDashboardChannel(guild);
  if (!channel) return null;

  const state = dashboardUpdateState.get(guild.id) || { running: false, lastRun: 0 };
  const minInterval = options.force ? 0 : DASHBOARD_UPDATE_MIN_INTERVAL_MS;
  if (state.running) return null;
  if (Date.now() - Number(state.lastRun || 0) < minInterval) return null;

  state.running = true;
  dashboardUpdateState.set(guild.id, state);
  try {
    const embed = await buildDashboardEmbed(guild);
    const result = await upsertStoredPanelMessage('dashboard', channel, { embeds: [embed], components: buildMainDashboardComponents() });
    state.lastRun = Date.now();
    return result;
  } finally {
    state.running = false;
    dashboardUpdateState.set(guild.id, state);
  }
}
async function sendSmartTermPing(guild, term, stage = 'day') {
  if (!store.config.settings.smartPingEnabled) return;
  const channel = guild?.channels?.cache?.get(store.config.channels.ankuendigungen) || getStatsChannel(guild);
  if (!channel) return;
  const buckets = await getTermStatusBuckets(guild, term);
  if (!buckets.noResponse.length) return;
  const lines = buildPriorityMentionLines(guild, buckets.noResponse, 10);
  const mentionTargets = buckets.noResponse.slice().sort((a, b) => getProblemScoreForUser(guild, b).risk - getProblemScoreForUser(guild, a).risk).slice(0, 10);
  const highRisk = buckets.noResponse.filter(id => getProblemScoreForUser(guild, id).risk >= 60).length;
  const contentPrefix = stage === 'hour' ? '⏰ Noch 1 Stunde bis' : '📅 Noch 1 Tag bis';
  const content = `${contentPrefix} **${term.title}** • ${mentionTargets.map(id => `<@${id}>`).join(' ')}`.trim();
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(stage === 'hour' ? '⏰ Smart-Ping • letzte Erinnerung' : '📅 Smart-Ping • Termin Erinnerung')
    .setDescription(`Es fehlt noch eine Antwort für **${term.title}**.
${formatGermanDateLabelFromString(term.date)} • ${term.time} Uhr`)
    .addFields(
      buildInfoField('Priorität zuerst', lines),
      buildInfoField('🧠 Analyse', [`Keine Antwort: **${buckets.noResponse.length}**`, `Hohe Risiken darunter: **${highRisk}**`], true),
    )
    .setFooter({ text: 'Nur einmal je Phase • kein Doppel-Spam' });
  await safeChannelSend(channel, { content, embeds: [embed] }, 'smartping.send').catch(() => null);
}
function cleanupStaleUiSessions() {
  const nowTs = now();
  let removed = 0;
  for (const [id, session] of Object.entries(store.sessions.attendanceLaunchers || {})) {
    if (nowTs - Number(session.createdAt || 0) > 30 * 60 * 1000) { delete store.sessions.attendanceLaunchers[id]; removed += 1; }
  }
  for (const [id, session] of Object.entries(store.sessions.termBuilders || {})) {
    if (nowTs - Number(session.updatedAt || session.createdAt || 0) > 24 * 60 * 60 * 1000) { delete store.sessions.termBuilders[id]; removed += 1; }
  }
  for (const [id, session] of Object.entries(store.sessions.memberPickers || {})) {
    if (nowTs - Number(session.updatedAt || session.createdAt || 0) > 60 * 60 * 1000) { delete store.sessions.memberPickers[id]; removed += 1; }
  }
  return removed;
}
function runIntegrityAudit() {
  const issues = [];
  for (const sanction of store.sanctions.items || []) {
    if (!sanction.id) issues.push('Sanktion ohne ID');
    if (!sanction.userId) issues.push(`Sanktion ${sanction.id || 'ohne-id'} ohne User`);
  }
  for (const absence of store.absences.items || []) {
    if (absence.active && Number(absence.untilTs || 0) && Number(absence.fromTs || 0) > Number(absence.untilTs || 0)) {
      issues.push(`Abmeldung ${absence.id || 'ohne-id'} mit ungültigem Zeitraum`);
    }
  }
  for (const approval of Object.values(store.sessions.pendingSanctionApprovals || {})) {
    if (approval.resolved) continue;
    if (!approval.userId || !approval.catalogNo) issues.push(`Freigabe ${approval.id || 'ohne-id'} unvollständig`);
  }
  return issues;
}

async function cleanupDeadStoredPanelRefs(guild) {
  if (!guild) return 0;
  let marked = 0;
  for (const [key, ref] of Object.entries(store.config.panelMessages || {})) {
    if (!ref?.channelId || !ref?.messageId) continue;
    const channel = await resolveSystemTextChannel(guild, ref.channelId).catch(() => null);
    const msg = channel ? await channel.messages.fetch(ref.messageId).catch(() => null) : null;
    if (!msg && !ref.missingAt) {
      // Referenz nicht löschen, sonst würde ein späterer Sync die Nachricht neu senden.
      store.config.panelMessages[key] = { ...ref, missingAt: now() };
      marked += 1;
    }
  }
  if (marked) saveAll();
  return marked;
}
function pruneResolvedRuntimeSessions() {
  ensureSessionShape();
  let cleaned = 0;
  const cutoffApprovals = now() - (14 * 24 * 60 * 60 * 1000);
  for (const [id, approval] of Object.entries(store.sessions.pendingSanctionApprovals || {})) {
    if (approval.resolved && Number(approval.resolvedAt || approval.createdAt || 0) < cutoffApprovals) {
      delete store.sessions.pendingSanctionApprovals[id];
      cleaned += 1;
    }
  }
  const cutoffAttendance = now() - (2 * 24 * 60 * 60 * 1000);
  for (const [id, check] of Object.entries(store.sessions.attendanceChecks || {})) {
    if ((check.closed || Number(check.expiresAt || 0) < cutoffAttendance) && Number(check.createdAt || 0) < cutoffAttendance) {
      delete store.sessions.attendanceChecks[id];
      cleaned += 1;
    }
  }
  if (cleaned) saveAll();
  return cleaned;
}
function validateAndRepairStoreData() {
  let repaired = 0;
  for (const sanction of store.sanctions.items || []) {
    if (sanction.catalogNo) sanction.catalogNo = String(sanction.catalogNo).padStart(2, '0');
    if (!Number.isFinite(Number(sanction.amount)) || Number(sanction.amount) < 0) { sanction.amount = 0; repaired += 1; }
    if (sanction.relatedWeek && !sanitizeWeekKey(sanction.relatedWeek)) { sanction.relatedWeek = null; repaired += 1; }
    if (!sanction.id) { sanction.id = uid('san_repair'); repaired += 1; }
  }
  for (const absence of store.absences.items || []) {
    if (Number(absence.fromTs || 0) > Number(absence.untilTs || 0)) {
      const tmp = absence.fromTs;
      absence.fromTs = absence.untilTs;
      absence.untilTs = tmp;
      absence.repairedAt = now();
      repaired += 1;
    }
  }
  for (const [weekKey, week] of Object.entries(store.abgaben.weeks || {})) {
    if (!sanitizeWeekKey(weekKey)) { delete store.abgaben.weeks[weekKey]; repaired += 1; continue; }
    week.categories ||= {};
  }
  for (const [weekKey, week] of Object.entries(store.wache.weeks || {})) {
    if (!sanitizeWeekKey(weekKey)) { delete store.wache.weeks[weekKey]; repaired += 1; continue; }
    week.users ||= {};
    week.sessions ||= [];
  }
  store.config.maintenance.integrity = { lastRunAt: now(), lastRepairCount: repaired };
  if (repaired) saveAll();
  return repaired;
}
async function runMissedCronCatchup(guild) {
  if (!guild) return;
  const d = getTzDate();
  const weekKey = currentWeekKey();
  const day = (d.getDay() + 6) % 7; // Mo=0
  const hour = d.getHours();
  const minute = d.getMinutes();
  if (day >= 0) {
    await runOncePerCronKey(guild, `mondayStart:${weekKey}`, 'catchupMondayStartWeekHandling', async () => mondayStartWeekHandling());
  }
  if (day > 1 || (day === 1 && (hour > 22 || (hour === 22 && minute >= 1)))) {
    const targetWeek = previousWeekKey(weekKey);
    await runOncePerCronKey(guild, `tuesdayAuto:${targetWeek}`, 'catchupTuesdayAutoSanctions', async () => tuesday2201AutoSanctions());
  }
  if (day > 4 || (day === 4 && hour >= 16)) {
    await runOncePerCronKey(guild, `fridayReport:${weekKey}`, 'catchupFridayMissingReport', async () => postWeeklyMissingReportFriday());
  }
}
async function runRecoveryPass(guild) {
  cleanupAbsences();
  ensureWeek(currentWeekKey());
  touchPrepaidStatusForWeek(guild, currentWeekKey());
  const cleanedSessions = cleanupStaleUiSessions();
  const prunedRuntime = pruneResolvedRuntimeSessions();
  const repaired = validateAndRepairStoreData();
  const cleanedPanels = await cleanupDeadStoredPanelRefs(guild);
  const integrityIssues = runIntegrityAudit();
  // WICHTIG: Beim Bot-Start keine Panels/Dashboards automatisch senden.
  // Panels werden nur per Setup-/Panel-Befehl erstellt und danach durch Button-Aktionen editiert.
  await cleanupExpiredAttendanceChecks(guild);
  await processPendingSanctionApprovals();
  // Kein Cron-Catchup beim Start, damit nichts rückwirkend gepostet oder ausgelöst wird.
  await logSystemEvent(guild, '♻️ Recovery abgeschlossen', [
    `Aktive Termine: ${(store.terms.items || []).filter(t => t.kind === 'term' && !t.closed).length}`,
    `Offene Sanktionen: ${store.sanctions.items.filter(x => !x.paid).length}`,
    `Aktive Abmeldungen: ${store.absences.items.filter(x => x.active && x.untilTs > now()).length}`,
    `Bereinigte UI-Sessions: ${cleanedSessions}`,
    `Bereinigte Runtime-Sessions: ${prunedRuntime}`,
    `Tote Panel-Referenzen: ${cleanedPanels}`,
    `Reparierte Datenfelder: ${repaired}`,
    `Integritäts-Hinweise: ${integrityIssues.length}`,
  ], integrityIssues.length ? COLORS.warning : COLORS.info);
  if (integrityIssues.length) {
    await logSystemEvent(guild, '🛡️ Integritätsprüfung', integrityIssues.slice(0, 20), COLORS.warning);
  }
}
async function logSystemEvent(guild, title, lines = [], color = COLORS.info) {
  if (store?.config?.settings?.logSystemEnabled === false) return;
  const description = (Array.isArray(lines) ? lines.filter(Boolean) : [String(lines || '')]).join('\n').slice(0, 4000) || '—';
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setFooter({ text: 'System-Log' });
  const channel = getLogChannel(guild);
  if (!channel) return;
  await safeChannelSend(channel, { embeds: [embed] }, 'system.log.send').catch(() => null);
}

function getConfiguredChannel(guild, key) {
  if (!guild || !key) return null;
  const channelId = store.config.channels?.[key];
  if (!channelId) return null;
  return guild.channels.cache.get(channelId) || null;
}

async function sendLeaderReminderEvent(guild, title, lines = [], color = COLORS.warning) {
  const description = (Array.isArray(lines) ? lines.filter(Boolean) : [String(lines || '')]).join('\n').slice(0, 4000) || '—';
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'Leader Reminder' })
    .setTimestamp(new Date());

  const channel = getConfiguredChannel(guild, 'leader_reminder') || getLogChannel(guild);
  if (!channel) return;
  await safeChannelSend(channel, { embeds: [embed] }, 'leader.reminder.send').catch(() => null);
}

async function emitHealthLog(guild, reason = 'interval') {
  if (!guild) return;
  const lines = [
    `Grund: ${reason}`,
    `Discord-Queue: ${getDiscordQueueSize()} ausstehend`,
    `Member-Cache: ${guild.members?.cache?.size || 0}`,
    `Aktive Termine: ${(store.terms.items || []).filter(t => t.kind === 'term' && !t.closed).length}`,
    `Offene Sanktionen: ${(store.sanctions.items || []).filter(x => !x.paid).length}`,
    `Aktive Abmeldungen: ${(store.absences.items || []).filter(x => x.active && x.untilTs > now()).length}`,
  ];
  await logSystemEvent(guild, '🩺 Health-Log', lines, COLORS.info);
}
async function runRecoverySelfTest(guild) {
  const checks = [];
  try { ensureConfigShape(); ensureSessionShape(); checks.push('Store-Struktur: OK'); } catch (error) { checks.push(`Store-Struktur: FEHLER (${error.message})`); }
  try { for (const file of Object.values(FILES)) readJSON(file, {}); checks.push('Dateien lesbar: OK'); } catch (error) { checks.push(`Dateien lesbar: FEHLER (${error.message})`); }
  const monitoringChannel = await resolveSystemTextChannel(guild, MONITORING_CHANNEL_ID);
  const logChannel = await resolveSystemTextChannel(guild, LOG_CHANNEL_ID);
  const integrityIssues = runIntegrityAudit();
  checks.push(`Monitoring-Kanal: ${monitoringChannel ? 'OK' : 'nicht gefunden'}`);
  checks.push(`Log-Kanal: ${logChannel ? 'OK' : 'nicht gefunden'}`);
  checks.push(`Log-Rechte: ${logChannel && canBotWriteToChannel(logChannel) ? 'OK' : 'fehlen/prüfen'}`);
  checks.push(`Dashboard-Kanal: ${getDashboardChannel(guild) ? 'OK' : 'nicht gesetzt'}`);
  checks.push(`Approval-Kanal: ${guild?.channels?.cache?.get(APPROVAL_CHANNEL_ID) ? 'OK' : 'nicht gefunden'}`);
  checks.push(`Discord-Queue: ${getDiscordQueueSize()} ausstehend`);
  checks.push(`Integritäts-Hinweise: ${integrityIssues.length}`);
  await logSystemEvent(guild, '✅ Recovery-Selbsttest', checks, integrityIssues.length ? COLORS.warning : COLORS.success);
}

function calculateReliabilityForUser(guild, userId) {
  let termCan = 0;
  let termMaybe = 0;
  let termCannot = 0;
  let termAbsent = 0;
  let termNoResponse = 0;
  let termTotal = 0;
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    termTotal += 1;
    const isAutoCan = !!term.autoCanUsers?.[userId];
    const response = term.responses?.[userId];
    const isAbsent = !!getAbsenceAt(userId, term.startTs, 'term') && !isAutoCan;
    const isAutoCannot = !!term.autoCannotUsers?.[userId] && !isAutoCan;
    if (isAutoCan || response === 'can') termCan += 1;
    else if (isAbsent || isAutoCannot) termAbsent += 1;
    else if (response === 'maybe') termMaybe += 1;
    else if (response === 'cannot') termCannot += 1;
    else termNoResponse += 1;
  }
  let abgabeSubmitted = 0;
  let abgabeOpen = 0;
  let abgabeTotal = 0;
  for (const [weekKey, week] of Object.entries(getRecentAbgabeWeeks(4))) {
    for (const category of getEnabledAbgabeKeys()) {
      if (!memberHasAbgabeRole(guild, userId, category)) continue;
      const rows = week.categories?.[category] || {};
      const row = rows[userId];
      if (!row) continue;
      abgabeTotal += 1;
      if (['abgegeben','vorausgezahlt','zu_spaet','teilabgabe'].includes(row.status)) abgabeSubmitted += row.status === 'teilabgabe' ? 0.5 : 1;
      if (['nicht_abgegeben','offen','warnphase','teilabgabe'].includes(row.status)) abgabeOpen += 1;
    }
  }
  const sanctionCount = store.sanctions.items.filter(x => x.userId === userId).length;
  const weightedBase = (termCan * 1) + (termMaybe * 0.6) + (termCannot * 0.25) + (termAbsent * 0.35) + (termNoResponse * 0);
  const termScore = termTotal ? Math.round((weightedBase / termTotal) * 100) : 100;
  const abgabeScore = abgabeTotal ? Math.round((abgabeSubmitted / abgabeTotal) * 100) : 100;
  const sanctionPenalty = getSanctionDecayPenaltyForUser(userId);
  const behavior = getBehaviorPatternForUser(guild, userId);
  const positiveDecayBonus = Math.min(10, Math.floor((termCan + abgabeSubmitted) / 8));
  const score = Math.max(0, Math.min(100, Math.round((termScore * 0.55) + (abgabeScore * 0.45) - sanctionPenalty - behavior.modifier + positiveDecayBonus)));
  return { score, sanctionCount, sanctionPenalty, behaviorModifier: behavior.modifier, behaviorLabels: behavior.labels, termCan, termMaybe, termCannot, termAbsent, termNoResponse, termTotal, abgabeSubmitted, abgabeOpen, abgabeTotal };
}
function getReliabilityLabel(score) {
  const pc = getReliabilityPointConfig();
  const n = Number(score || 0);
  if (n >= pc.veryReliable) return 'sehr zuverlässig';
  if (n >= pc.reliable) return 'zuverlässig';
  if (n >= pc.medium) return 'mittel';
  if (n >= pc.unreliable) return 'auffällig';
  return 'gar nicht zuverlässig';
}
async function buildReliabilityLeaderboard(guild, limit = 5, direction = 'top') {
  await ensureGuildMembersCached(guild);
  const rows = [];
  for (const member of getRelevantGuildMembers(guild)) {
    const stats = calculateReliabilityForUser(guild, member.id);
    rows.push({ userId: member.id, ...stats });
  }
  rows.sort((a, b) => direction === 'top' ? b.score - a.score : a.score - b.score);
  return rows.slice(0, limit);
}
function buildReliabilityLines(guild, rows) {
  if (!rows.length) return ['—'];
  return rows.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} — **${row.score}%** (${getReliabilityLabel(row.score)})`);
}
function getSuggestedLineupLines(guild, ids, limit = 8) {
  if (!ids?.length) return ['Noch keine sichere Empfehlung.'];
  const scored = ids.filter(userId => isRelevantGuildMember(guild, userId)).map(userId => ({ userId, ...calculateReliabilityForUser(guild, userId) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} — ${row.score}%`);
}
async function postTermResultSummary(guild, term) {
  const channel = getStatsChannel(guild);
  if (!channel) return;
  const { can, maybe, cannot, absent, noResponse } = await getTermStatusBuckets(guild, term);
  const sanctionCount = store.sanctions.items.filter(item => item.relatedTermId === term.id).length;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📘 Termin-Auswertung • ${term.title}`)
    .setDescription(`📅 **${formatGermanDateLabelFromString(term.date)}**
🕒 **${term.time} Uhr**`)
    .addFields(
      buildInfoField('📊 Ergebnis', [
        `✅ Kann: **${can.length}**`,
        `🤔 Vielleicht: **${maybe.length}**`,
        `❌ Kann nicht: **${cannot.length}**`,
        `💤 Abgemeldet: **${absent.length}**`,
        `❓ Keine Antwort: **${noResponse.length}**`,
      ], true),
      buildInfoField('📌 Pflicht', [isTermRequired(term) ? '⚠️ Pflichttermin' : '✅ Kein Pflichttermin', isTermRequired(term) ? 'Keine Antwort konnte sanktioniert werden.' : 'Keine Antwort wurde nicht sanktioniert.'], true),
      ...(await (async () => { const summary = await buildWacheSummary(guild, currentWeek); const open = summary.rows.filter(r => !r.fulfilled && !r.excused).length; const done = summary.rows.filter(r => r.fulfilled).length; const exc = summary.rows.filter(r => r.excused).length; const active = store.wache?.active && !store.wache.active.closed ? store.wache.active : null; return [buildInfoField('🟢 Wache', [`Status: **${summary.cfg.enabled ? 'AN' : 'AUS'}**`, `Pflicht: **${summary.required} min/Woche**`, `Erfüllt: **${done}/${summary.rows.length}**`, `Offen: **${open}** | Entschuldigt: **${exc}**`, active ? `Läuft bis: **${formatDateTime(active.endTs)}**` : 'Aktuell: **keine laufende Wache**'], true)]; })()),
      buildInfoField('⚖️ Sanktionen', [isTermRequired(term) ? `Automatisch erstellt: **${sanctionCount}**` : 'Keine Sanktionen, weil kein Pflichttermin.'], true),
    )
    .setFooter({ text: 'Termin-Auswertung' });
  await safeChannelSend(channel, { embeds: [embed] }, 'term.summary.send').catch(() => null);
}
async function processTermReminders() {
  if (!isAutomationEnabled('termReminders') || !isReminderGloballyEnabled('termine')) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  const channel = guild.channels.cache.get(store.config.channels.ankuendigungen);
  const logChannel = getStatsChannel(guild);
  if (!channel && !logChannel) return;
  const reminderMinutes = [...new Set((getSystemControlConfig().reminders.termMinutesBefore || []).map(Number).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => b - a);
  let changed = false;
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term' || term.closed) continue;
    term.remindersSent ||= {};
    const diffMs = Number(term.startTs || 0) - now();
    if (diffMs <= 0) continue;
    const diffMin = Math.ceil(diffMs / 60000);
    for (const minutes of reminderMinutes) {
      const key = `m${minutes}`;
      if (term.remindersSent[key]) continue;
      if (diffMin > minutes || diffMin <= Math.max(0, minutes - 65)) continue;
      const label = minutes >= 1440 ? `${Math.round(minutes / 1440)} Tag(e)` : `${minutes} Minuten`;
      const msg = `📅 Erinnerung: In ca. ${label} startet **${term.title}** (${formatGermanDateLabelFromString(term.date)} • ${term.time} Uhr).`;
      if (channel) await safeChannelSend(channel, { content: msg }, 'term.reminder.send').catch(() => null);
      await sendSmartTermPing(guild, term, key).catch(() => null);
      term.remindersSent[key] = true;
      changed = true;
    }
    if (!term.remindersSent.preview && diffMin <= 30 && diffMin > 0 && isTermRequired(term)) {
      const { noResponse } = await getTermStatusBuckets(guild, term);
      if (noResponse.length && logChannel) {
        const preview = new EmbedBuilder().setColor(COLORS.warning).setTitle(`⚠️ Vorschau • mögliche Termin-Sanktionen`)
          .setDescription(`Ohne Antwort bis Start wären aktuell **${noResponse.length}** Personen betroffen.`)
          .addFields(buildInfoField('Betroffen', [mentionList(noResponse)]))
          .setFooter({ text: 'Vorschau vor Terminstart' });
        await safeChannelSend(logChannel, { embeds: [preview] }, 'preview.log.send').catch(() => null);
      }
      term.remindersSent.preview = true; changed = true;
    }
  }
  if (changed) saveAll();
}

function mentionList(ids) {
  if (!ids.length) return '—';
  const mentions = ids.map(id => `<@${id}>`);
  const maxShown = 35;
  const visible = mentions.slice(0, maxShown).join('\n');
  const hidden = ids.length - Math.min(ids.length, maxShown);
  return hidden > 0 ? `${visible}\n… und ${hidden} weitere` : visible;
}
async function getTermStatusBuckets(guild, term) {
  await syncTermAutoCannot(guild, term);
  const can = [];
  const maybe = [];
  const cannot = [];
  const absent = [];
  const noResponse = [];
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    const response = term.responses?.[member.id];
    const isAutoCan = !!term.autoCanUsers?.[member.id];
    const isAbsent = !!getAbsenceAt(member.id, term.startTs, 'term') && !isAutoCan;
    const isAutoCannot = !!term.autoCannotUsers?.[member.id] && !isAutoCan;
    if (isAutoCan || response === 'can') {
      can.push(member.id);
      continue;
    }
    if (isAbsent || isAutoCannot) {
      absent.push(member.id);
      continue;
    }
    if (response === 'maybe') {
      maybe.push(member.id);
      continue;
    }
    if (response === 'cannot') {
      cannot.push(member.id);
      continue;
    }
    noResponse.push(member.id);
  }
  return { can, maybe, cannot, absent, noResponse };
}
async function buildTermStatusEmbed(guild, term) {
  const { can, maybe, cannot, absent, noResponse } = await getTermStatusBuckets(guild, term);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📊 Status • ${term.title}`)
    .setDescription(`📅 **${formatGermanDateLabelFromString(term.date)}**
🕒 **${term.time} Uhr**
⏳ **${formatRelativeTermCountdown(term.startTs)}**`)
    .addFields(
      buildInfoField(`✅ Kann (${can.length})`, [mentionList(can)]),
      buildInfoField(`🤔 Vielleicht (${maybe.length})`, [mentionList(maybe)]),
      buildInfoField(`❌ Kann nicht (${cannot.length})`, [mentionList(cannot)]),
      buildInfoField(`💤 Abgemeldet (${absent.length})`, [mentionList(absent)]),
      buildInfoField(`❓ Keine Antwort (${noResponse.length})`, [mentionList(noResponse)]),
    )
    .setFooter({ text: 'Termine • Statusübersicht' });
}
async function buildTermLeaderDashboardEmbed(guild, term) {
  // Intern nicht mehr im normalen Terminfluss genutzt. Bleibt als Fallback/Debug-Helfer erhalten.
  const { can, maybe, cannot, absent, noResponse } = await getTermStatusBuckets(guild, term);
  const optimized = getOptimizedTermSuggestion();
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🧠 Leader-Dashboard • ${term.title}`)
    .setDescription(`📅 **${formatGermanDateLabelFromString(term.date)}**
🕒 **${term.time} Uhr**
⏳ **${formatRelativeTermCountdown(term.startTs)}**`)
    .addFields(
      buildInfoField('📊 Kurzstatus', [
        `✅ Kann: **${can.length}**`,
        `🤔 Vielleicht: **${maybe.length}**`,
        `❌ Kann nicht: **${cannot.length}**`,
        `💤 Abgemeldet: **${absent.length}**`,
        `❓ Keine Antwort: **${noResponse.length}**`,
      ], true),
      buildInfoField('🏆 Empfohlene Aufstellung', getSuggestedLineupLines(guild, can), false),
      buildInfoField('🧠 Entscheidungshilfe', [getDecisionHelp(term, { can, maybe, cannot, absent, noResponse })], false),
      buildInfoField('🎯 Optimierter Slot', [optimized ? `${optimized.slot} • Ø ${optimized.avg.toFixed(1)} Zusagen` : 'Noch nicht genug Daten.'], false),
    )
    .setFooter({ text: 'Nur für Leader/Admins • interne Termin-Analyse' });
}

async function buildTermDashboardEmbed(guild) {
  const openTerms = (store.terms.items || [])
    .filter(item => item && item.kind === 'term' && !item.closed && Number(item.startTs || 0) >= now())
    .sort((a, b) => Number(a.startTs || 0) - Number(b.startTs || 0));
  const nextTerm = openTerms[0] || getLatestRelevantTerm();
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📅 Termin-Dashboard')
    .setFooter({ text: `Automatisch aktualisiert • ${new Date().toLocaleTimeString('de-DE', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })} Uhr` })
    .setTimestamp(new Date());

  if (!nextTerm) {
    return embed
      .setDescription('Aktuell ist kein offener Termin geplant.')
      .addFields(buildInfoField('📌 Nächster Termin', ['Keine Daten'], false));
  }

  const { can, maybe, cannot, absent, noResponse } = await getTermStatusBuckets(guild, nextTerm);
  const total = can.length + maybe.length + cannot.length + absent.length + noResponse.length;
  const responseCount = can.length + maybe.length + cannot.length + absent.length;
  const quote = total > 0 ? Math.round((responseCount / total) * 100) : 0;
  const yesQuote = total > 0 ? Math.round((can.length / total) * 100) : 0;

  const upcomingLines = [];
  for (const term of openTerms.slice(1, 5)) {
    upcomingLines.push(`• **${term.title}** — ${formatGermanDateLabelFromString(term.date)}, ${term.time} Uhr (${formatRelativeTermCountdown(term.startTs)})`);
  }

  const optimized = getOptimizedTermSuggestion();
  const lineupLines = getSuggestedLineupLines(guild, can, 5);
  const decisionText = getDecisionHelp(nextTerm, { can, maybe, cannot, absent, noResponse });
  const quoteStatus = yesQuote >= 60 ? '🟢 gut' : yesQuote >= 35 ? '🟡 beobachten' : '🔴 kritisch';

  return embed
    .setDescription([
      `**Nächster Termin:** ${nextTerm.title}`,
      `📅 **${formatGermanDateLabelFromString(nextTerm.date)}**`,
      `🕒 **${nextTerm.time} Uhr**`,
      `⏳ **${formatRelativeTermCountdown(nextTerm.startTs)}**`,
    ].join('\n'))
    .addFields(
      buildInfoField('📊 Live-Status', [
        `✅ Kann: **${can.length}**`,
        `🤔 Vielleicht: **${maybe.length}**`,
        `❌ Kann nicht: **${cannot.length}**`,
        `💤 Abgemeldet: **${absent.length}**`,
        `❓ Offen: **${noResponse.length}**`,
      ], true),
      buildInfoField('📈 Quote', [
        `Antwortquote: **${quote}%**`,
        `Zusagequote: **${yesQuote}%** (${quoteStatus})`,
        `Erfasst: **${responseCount}/${total}**`,
      ], true),
      buildInfoField('🏆 Empfohlene Aufstellung', lineupLines, false),
      buildInfoField('🧠 Entscheidungshilfe', [decisionText], false),
      buildInfoField('🎯 Optimierter Slot', [optimized ? `${optimized.slot} • Ø **${optimized.avg.toFixed(1)}** Zusagen` : 'Noch nicht genug Daten.'], false),
      buildInfoField('📌 Weitere anstehende Termine', upcomingLines.length ? upcomingLines : ['Keine weiteren offenen Termine.'], false),
      buildInfoField('ℹ️ Hinweis', ['Dashboard ist für den Leader-Kanal gedacht und aktualisiert sich automatisch. Bitte rechtzeitig mit ✅ / 🤔 / ❌ reagieren.'], false),
    );
}

async function upsertTermDashboardMessage(guild, channel = null) {
  if (!guild) return null;
  const targetChannelId = channel?.id || store.config.panelMessages?.term_dashboard?.channelId || store.config.channels?.termine;
  if (!targetChannelId) return null;
  const target = channel || guild.channels.cache.get(targetChannelId) || await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!target?.isTextBased?.()) return null;
  return upsertStoredPanelMessage('term_dashboard', target, { embeds: [await buildTermDashboardEmbed(guild)], components: [] });
}

function getLatestRelevantTerm() {
  const terms = (store.terms.items || [])
    .filter(item => item && item.kind === 'term' && !item.closed)
    .sort((a, b) => Number(a.startTs || 0) - Number(b.startTs || 0));
  const upcoming = terms.filter(item => Number(item.startTs || 0) >= now());
  return upcoming[0] || terms[terms.length - 1] || null;
}

function findTermForDashboard(query = '') {
  const raw = String(query || '').trim().toLowerCase();
  const terms = (store.terms.items || []).filter(item => item && item.kind === 'term' && !item.closed);
  if (!raw) return getLatestRelevantTerm();
  return terms.find(item => String(item.id || '').toLowerCase() === raw)
    || terms.find(item => String(item.title || '').toLowerCase().includes(raw))
    || terms.find(item => `${item.date || ''} ${item.time || ''}`.toLowerCase().includes(raw))
    || null;
}

async function refreshAllActiveTermAnnouncements(guild) {
  if (!guild) return;
  for (const term of store.terms.items) {
    if (term.kind !== 'term' || term.closed) continue;
    if (!term.announcementPosted || !term.messageId) continue;
    await updateTermAnnouncementMessage(guild, term);
  }
}
async function syncTermAutoCannot(guild, term) {
  term.responses ||= {};
  term.autoCannotUsers ||= {};
  term.autoCanUsers ||= {};
  await ensureGuildMembersCached(guild);
  let changed = false;
  let totalMembers = 0;
  const alwaysCanIds = new Set(getTermAlwaysCanUserIds(term));
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    totalMembers += 1;
    const userId = member.id;
    const isAlwaysCan = alwaysCanIds.has(userId);
    const absentForTerm = !!getAbsenceAt(userId, term.startTs, 'term');
    const wasAutoCannot = !!term.autoCannotUsers[userId];
    const wasAutoCan = !!term.autoCanUsers[userId];
    if (isAlwaysCan) {
      if (term.responses[userId] !== 'can' || !wasAutoCan || wasAutoCannot) {
        term.responses[userId] = 'can';
        term.autoCanUsers[userId] = true;
        delete term.autoCannotUsers[userId];
        changed = true;
      }
      continue;
    }
    if (wasAutoCan) {
      delete term.autoCanUsers[userId];
      if (term.responses[userId] === 'can') delete term.responses[userId];
      changed = true;
    }
    if (absentForTerm) {
      if (!wasAutoCannot || term.responses[userId] !== 'cannot') {
        term.responses[userId] = 'cannot';
        term.autoCannotUsers[userId] = true;
        changed = true;
      }
      continue;
    }
    if (wasAutoCannot) {
      delete term.autoCannotUsers[userId];
      if (term.responses[userId] === 'cannot') delete term.responses[userId];
      changed = true;
    }
  }
  for (const userId of Object.keys(term.autoCanUsers || {})) {
    if (!alwaysCanIds.has(userId)) {
      delete term.autoCanUsers[userId];
      if (term.responses[userId] === 'can') delete term.responses[userId];
      changed = true;
    }
  }
  if (term.expectedMembers !== totalMembers) {
    term.expectedMembers = totalMembers;
    changed = true;
  }
  if (changed) saveAll();
  return termResponseSummary(term);
}
function buildTermAnnouncementEmbed(term, summary = null) {
  const counts = summary || termResponseSummary(term);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📣 ${term.title}`)
    .setDescription('Status unten wählen.')
    .addFields(
      buildInfoField('📅 Termin', [formatGermanDateLabelFromString(term.date), `${term.time} Uhr`, `⏳ ${formatRelativeTermCountdown(term.startTs)}`], true),
      buildInfoField('📌 Pflicht', [isTermRequired(term) ? '⚠️ Pflichttermin' : '✅ Kein Pflichttermin', isTermRequired(term) ? 'Keine Antwort kann sanktioniert werden.' : 'Keine Antwort wird nicht sanktioniert.'], true),
      buildInfoField('📊 Live Stand', [
        `✅ Kann: **${counts.can}**`,
        `🤔 Vielleicht: **${counts.maybe}**`,
        `❌ Kann nicht: **${counts.cannot}**`,
        `💤 Abgemeldet: **${counts.autoCannot}**`,
        `❓ Offen: **${counts.noResponse}**`,
      ], true),
    )
    .setFooter({ text: 'Termine • Live-Status' });
}

function buildCancelledTermEmbed(term) {
  const cancelledBy = term.cancelledBy ? `<@${term.cancelledBy}>` : 'Leitung';
  const cancelledAt = term.cancelledAt ? formatDateTime(term.cancelledAt) : formatDateTime(now());
  return new EmbedBuilder()
    .setColor(COLORS.danger || 0xed4245)
    .setTitle(`🚫 ABGESAGT • ${term.title || 'Termin'}`)
    .setDescription('Dieser Termin wurde abgesagt. Die Teilnahme-Buttons wurden deaktiviert.')
    .addFields(
      buildInfoField('📅 Ursprünglicher Termin', [formatGermanDateLabelFromString(term.date), term.time ? `${term.time} Uhr` : null].filter(Boolean), true),
      buildInfoField('🧾 Status', [`Abgesagt von: ${cancelledBy}`, `Abgesagt am: ${cancelledAt}`], true),
    )
    .setFooter({ text: 'Termin abgesagt • keine Antworten mehr möglich' });
}
function buildCancelledVoteEmbed(term) {
  const cancelledBy = term.cancelledBy ? `<@${term.cancelledBy}>` : 'Leitung';
  const cancelledAt = term.cancelledAt ? formatDateTime(term.cancelledAt) : formatDateTime(now());
  const options = (term.options || term.voteChoices || []).map((opt, idx) => `${idx + 1}. ${opt}`).filter(Boolean);
  return new EmbedBuilder()
    .setColor(COLORS.danger || 0xed4245)
    .setTitle(`🚫 ABGESAGT • ${term.title || 'Abstimmung'}`)
    .setDescription('Diese Abstimmung wurde abgesagt. Die Abstimmungs-Buttons wurden entfernt.')
    .addFields(
      buildInfoField('📅 Terminbezug', [formatGermanDateLabelFromString(term.date), term.time ? `${term.time} Uhr` : null].filter(Boolean), true),
      buildInfoField('🧾 Status', [`Abgesagt von: ${cancelledBy}`, `Abgesagt am: ${cancelledAt}`], true),
      ...(options.length ? [buildInfoField('📌 Optionen', options, false)] : []),
    )
    .setFooter({ text: 'Abstimmung abgesagt • keine Stimmen mehr möglich' });
}
async function updateTermAnnouncementMessageImmediate(guild, term) {
  if (!term.messageId) return;
  const channel = guild.channels.cache.get(store.config.channels.ankuendigungen);
  if (!channel) return;
  const msg = await withDiscordRetry(() => channel.messages.fetch(term.messageId)).catch(() => null);
  if (!msg) return;
  if (term.cancelled) {
    await safeMessageEdit(msg, { embeds: [buildCancelledTermEmbed(term)], components: [] }, 'term.announcement.cancelled.edit').catch(() => null);
    return;
  }
  const summary = await syncTermAutoCannot(guild, term);
  await safeMessageEdit(msg, { embeds: [buildTermAnnouncementEmbed(term, summary)], components: buildTermActionRows(term) }, 'term.announcement.edit').catch(() => null);
}
async function updateTermAnnouncementMessage(guild, term, immediate = false) {
  if (immediate) return updateTermAnnouncementMessageImmediate(guild, term);
  scheduleTermAnnouncementRefresh(guild, term);
}
async function postTermAnnouncement(guild, term) {
  const channel = guild.channels.cache.get(store.config.channels.ankuendigungen);
  if (!channel) return;
  const summary = await syncTermAutoCannot(guild, term);
  const msg = await safeChannelSend(channel, {
    content: '@everyone',
    allowedMentions: { parse: ['everyone'] },
    embeds: [buildTermAnnouncementEmbed(term, summary)],
    components: buildTermActionRows(term),
  }, 'term.announcement.send').catch(() => null);
  if (!msg) return;
  term.messageId = msg.id;
  term.announcementPosted = true;
  saveAll();
  if (store.config.panelMessages?.term_dashboard?.channelId) await upsertTermDashboardMessage(guild).catch(() => null);
}
async function postVoteMessage(guild, voteTerm) {
  const channel = guild.channels.cache.get(store.config.channels.abstimmungen);
  if (!channel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_pick:${voteTerm.id}:0`).setLabel(voteTerm.options[0]).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_pick:${voteTerm.id}:1`).setLabel(voteTerm.options[1]).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_pick:${voteTerm.id}:2`).setLabel(voteTerm.options[2]).setStyle(ButtonStyle.Primary),
    ...(voteTerm.options[3] ? [new ButtonBuilder().setCustomId(`vote_pick:${voteTerm.id}:3`).setLabel(voteTerm.options[3]).setStyle(ButtonStyle.Secondary)] : []),
  );
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🗳️ Abstimmung • ${voteTerm.title}`)
    .setDescription('Wähle unten eine Option. Der Gewinner wird automatisch in Ankündigungen übernommen.')
    .addFields(
      buildInfoField('📅 Terminbezug', [formatGermanDateLabelFromString(voteTerm.date), `${voteTerm.time} Uhr`], true),
      buildInfoField('📌 Optionen', voteTerm.options.map((opt, idx) => `${idx + 1}. ${opt}`).filter(Boolean), true),
    )
    .setFooter({ text: 'Abstimmungen • automatische Auswertung' });
  const msg = await safeChannelSend(channel, { embeds: [embed], components: [row] }, 'vote.announcement.send').catch(() => null);
  if (!msg) return;
  voteTerm.messageId = msg.id;
  voteTerm.announcementPosted = true;
  saveAll();
}
async function closeVotesAndAnnounceWinners() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  for (const term of store.terms.items) {
    if (term.kind !== 'vote' || term.voteClosed || term.cancelled) continue;
    if (now() < term.startTs) continue;
    const counts = {};
    Object.values(term.votes || {}).forEach(index => {
      counts[index] = (counts[index] || 0) + 1;
    });
    let winnerIndex = 0;
    let winnerCount = -1;
    for (let i = 0; i < term.voteChoices.length; i += 1) {
      const count = counts[i] || 0;
      if (count > winnerCount) {
        winnerCount = count;
        winnerIndex = i;
      }
    }
    term.voteClosed = true;
    term.winner = term.voteChoices[winnerIndex] || term.voteChoices[0] || 'Unbekannt';
    const createdTerm = {
      ...term,
      id: uid('term'),
      kind: 'term',
      type: term.winner,
      title: term.winner,
      required: isTermRequired(term),
      responses: {},
      autoCannotUsers: {},
      expectedMembers: 0,
      announcementPosted: false,
      sourceVoteId: term.id,
      closed: false,
    };
    store.terms.items.push(createdTerm);
    saveAll();
    const announceChannel = guild.channels.cache.get(store.config.channels.ankuendigungen);
    if (announceChannel) {
      await safeChannelSend(announceChannel, { embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle(`🏆 Gewinner der Abstimmung • ${term.title}`).setDescription(`Gewonnen hat: **${term.winner}**`).setFooter({ text: 'Abstimmungen • Ergebnis' })] }, 'vote.winner.send');
    }
    await postTermAnnouncement(guild, createdTerm);
  }
}
async function shouldAutoSanctionTermUser(guild, term, userId) {
  if (!isTermRequired(term)) return false;
  const buckets = await getTermStatusBuckets(guild, term);
  if (!buckets.noResponse.includes(userId)) return false;
  if (getAbsenceAt(userId, term.startTs, 'term')) return false;
  return true;
}

async function processTermSanctions() {
  if (!isAutomationEnabled('termNoResponseSanctions')) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild).catch(() => false);

  for (const term of store.terms.items) {
    if (term.kind !== 'term') continue;
    if (term.closed || term.cancelled || term.sanctionsProcessed) continue;
    if (now() < term.startTs) continue;

    await syncTermAutoCannot(guild, term);
    await updateTermAnnouncementMessage(guild, term);

    const { noResponse } = await getTermStatusBuckets(guild, term);

    if (!isTermRequired(term)) {
      if (noResponse.length) {
        await logSystemEvent(
          guild,
          '📋 Kein Pflichttermin abgeschlossen',
          [`Termin: ${term.title}`, `Keine Antwort: ${noResponse.length}`, 'Keine Sanktionen, weil dieser Termin als „kein Pflichttermin“ erstellt wurde.'],
          COLORS.info,
        );
      }
      term.sanctionsProcessed = true;
      term.closed = true;
      term.closedAt = now();
      saveAll();
      await postTermResultSummary(guild, term);
      continue;
    }

    const termRule = getRuleConfig('termNoResponseSanction');
    if (store.config.settings.autoSanctionsEnabled && noResponse.length && termRule.enabled) {
      for (const userId of noResponse) {
        if (hasConflictingOpenSanction(userId, 'term_no_response', null, null, term.id)) continue;
        await createSanctionApproval(guild, {
          userId,
          source: 'term_no_response',
          reason: `Termin nicht eingehalten / keine Antwort: ${term.title}`,
          catalogNo: termRule.catalogNo || '18',
          penaltyType: termRule.penaltyType || 'Grüngeld',
          amount: Number(termRule.amount || 0),
          relatedTermId: term.id,
          executeAt: now() + (APPROVAL_TIMEOUT_SECONDS * 1000),
        });
      }
    } else if (store.config.settings.autoSanctionsEnabled && noResponse.length) {
      await logSystemEvent(
        guild,
        '📋 Termin ohne Antwort abgeschlossen',
        [`Termin: ${term.title}`, `Keine Antwort: ${noResponse.length}`, 'Termin-Regel ist aktuell AUS.'],
        COLORS.info,
      );
    }

    term.sanctionsProcessed = true;
    term.closed = true;
    term.closedAt = now();
    saveAll();

    await postTermResultSummary(guild, term);
  }
}
// =========================================================
// PANEL BUILDERS
// =========================================================
function abgabePanelEmbed(category, totalMembers, page, totalPages) {
  const cfg = ABGABEN[category];
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(`${cfg.emoji} ${cfg.label} • Abgabe Panel`)
    .setDescription(`Pflichtabgabe pro Woche: **${formatAmount(category, getAbgabeAmount(category))}**`)
    .addFields(
      buildInfoField('🧾 Aktionen', [
        '✅ **Abgegeben** – Pflichtmenge eintragen',
        '➕ **Zusatz** – Pflicht + Extra, Extra wird als Vorauszahlung gespeichert',
        '⏰ **Zu spät** – Nachholung für die letzte Woche',
        '🟡 **Entschuldigt** – manuell als entschuldigt markieren',
        '🗑️ **Löschen** – versehentlichen Eintrag zurücksetzen',
        '📊 **Status** – Übersicht aller Stati ohne Personenwahl',
      ]),
      buildInfoField('👥 Übersicht', [
        `Mitglieder: **${totalMembers}**`,
        `Seite: **${page + 1}/${totalPages}**`,
      ], true),
      buildInfoField('💡 Hinweis', [
        'Vorauszahlungen werden automatisch für die nächste passende Woche verrechnet.',
        'Mit Refresh wird die Rollenliste neu eingelesen.',
      ], true),
    )
    .setFooter({ text: `${cfg.label} • Auswahl & Verwaltung` });
}
function buildMemberSelectOptions(members, selectedUserId) {
  if (!members.length) return [{ label: 'Keine Mitglieder gefunden', value: 'none' }];
  return members.map(member => ({
    label: member.displayName.slice(0, 100),
    value: member.id,
    default: member.id === selectedUserId,
  }));
}
function buildAbgabePanelComponents(guild, category, page = 0, selectedUserId = '') {
  const weekKey = getActiveAbgabeWeekForCategory(guild, category, currentWeekKey());
  // Panel-Auswahl soll immer die AKTUELLE Rollenliste zeigen, nicht den alten Wochen-Snapshot.
  // Sonst bleiben nachträglich geladene/neu hinzugefügte Routenmitglieder unsichtbar.
  // Sanktionen/Reports nutzen weiterhin getRequiredMembersForAbgabe(...) mit Snapshot.
  const members = getMembersForAbgabe(guild, category);
  const pages = chunk(members, 25);
  const safePage = Math.max(0, Math.min(page, Math.max(0, pages.length - 1)));
  const currentPageMembers = pages[safePage] || [];
  const totalPages = Math.max(1, pages.length);
  const sessionId = uid(`abgabe_${category}`);
  store.sessions.abgabePanels[sessionId] = { category, page: safePage, selectedUserId, weekKey };
  saveAll();
  const select = new StringSelectMenuBuilder()
    .setCustomId(`abgabe_select:${sessionId}`)
    .setPlaceholder('Person auswählen')
    .addOptions(buildMemberSelectOptions(currentPageMembers, selectedUserId));
  const baseEmbed = abgabePanelEmbed(category, members.length, safePage, totalPages);
  const lockNotice = buildAbgabeWeekLockNotice(currentWeekKey());
  if (lockNotice) {
    baseEmbed.setDescription(`${lockNotice}\n\nEintragungen gehen aktuell auf **${weekKey}**.`);
  }
  return {
    embeds: [baseEmbed],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:done`).setLabel('✅ Abgegeben').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:partial`).setLabel('➗ Teilabgabe').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:extra`).setLabel('➕ Zusatz').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:late`).setLabel('🕒 Zu spät').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:excused`).setLabel('🫡 Entschuldigt').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:status`).setLabel('📋 Status').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`abgabe_action:${sessionId}:clear`).setLabel('🗑️ Löschen').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`abgabe_page:${sessionId}:prev`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
        new ButtonBuilder().setCustomId(`abgabe_page:${sessionId}:next`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= totalPages - 1),
        new ButtonBuilder().setCustomId(`abgabe_page:${sessionId}:refresh`).setLabel('🔄 Aktualisieren').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}
function buildSanctionPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⚖️ Sanktionen')
    .setDescription([
      'Sanktionen verwalten.',

      '**Angaben**',
      'Mitglied • Katalog • Strafart • Betrag/Menge',
      'optional Grund + Zusatz-Tage',

      '**Automatik**',
      '3 Tage Frist • dann +100.000$ • danach Bloodout-Ankündigung',
    ].join('\n'))
    .setFooter({ text: 'Sanktionen • Übersicht' });
}
function buildAbsencePanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🛫 Abmeldungs Panel')
    .setDescription('Abmeldung verwalten.')
    .addFields(
      buildInfoField('🗓️ Möglichkeiten', [
        'Dauer über Dropdown auswählen',
        'optional einen Grund angeben',
        'eigenes Datum frei setzen',
        'nur für Termin heute abmelden',
      ]),
      buildInfoField('📌 Wichtig', [
        `Ab ${getAbgabeAbsenceExcuseDays()} Tagen bist du für die Woche befreit.`,
        `Unter ${getAbgabeAbsenceExcuseDays()} Tagen greifen Nachhol- und Überfälligkeitsregeln.`,
        'Mit **Status** siehst du aktive Abmeldungen.',
      ]),
    )
    .setFooter({ text: 'Abmeldung • Übersicht' });
}
async function buildAbsenceStatusEmbedAsync(guild, viewerId, isLeader = false) {
  cleanupAbsences();
  await ensureGuildMembersCached(guild);
  const active = store.absences.items.filter(item => item.active && item.untilTs > now());
  const describe = item => {
    const member = guild.members.cache.get(item.userId);
    const name = member ? member.displayName : item.userId;
    const scope = item.appliesTo === 'term_only' ? 'Nur für Termin heute' : 'Normale Abmeldung';
    return [`• **${name}**`, `bis ${formatDueLabel(item.untilTs)}`, `Art: ${scope}`, item.reason ? `Grund: ${item.reason}` : null].filter(Boolean).join(' • ');
  };
  const relevant = isLeader ? active : active.filter(item => item.userId === viewerId);
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(isLeader ? '📋 Aktive Abmeldungen' : '📋 Deine aktive Abmeldung')
    .setDescription(relevant.length ? relevant.map(describe).join('\n') : (isLeader ? 'Aktuell gibt es keine aktiven Abmeldungen.' : 'Du hast aktuell keine aktive Abmeldung.'))
    .setFooter({ text: isLeader ? 'Leader-Ansicht' : 'Eigenansicht' })
    .setTimestamp(new Date());
}
function buildTermPanelEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📣 Termine & Abstimmungen')
    .setDescription('Termine und Abstimmungen verwalten.')
    .addFields(
      buildInfoField('📅 Termine', [
        'Datum bis 2 Wochen im Voraus',
        'Uhrzeiten von 16:00 bis 00:00 in 15-Minuten-Schritten',
        'eigene Termine mit Freitext',
      ], true),
      buildInfoField('🗳️ Abstimmungen', [
        '3 Pflichtoptionen + 1 optionale vierte',
        'Gewinner wird automatisch in Ankündigungen übernommen',
      ], true),
      buildInfoField('👥 Teilnahme', [
        'Mit **Kann / Kann vielleicht / Kann nicht** antworten',
        'Abgemeldete werden automatisch erkannt',
        'Pflichttermin: ohne Antwort und nicht abgemeldet = Sanktion',
        'Kein Pflichttermin: keine Sanktion bei fehlender Antwort',
      ], false),
    )
    .setFooter({ text: 'Termine • übersichtlich & live aktualisiert' });
}

function getDeletableTermsForPanel() {
  const ts = now();
  return (store.terms?.items || [])
    .filter(term => term && !term.deleted && !term.cancelled && !term.closed && !term.voteClosed)
    .filter(term => Number(term.startTs || 0) >= ts - 14 * 24 * 60 * 60 * 1000)
    .sort((a, b) => Number(a.startTs || 0) - Number(b.startTs || 0))
    .slice(0, 25);
}
function buildTermDeleteSelectPayload() {
  const terms = getDeletableTermsForPanel();
  if (!terms.length) {
    return {
      embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle('🗑️ Termin/Abstimmung absagen').setDescription('Es gibt aktuell keinen aktiven Termin und keine aktive Abstimmung zum Absagen.')],
      components: [],
    };
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('term_delete_select')
    .setPlaceholder('Termin oder Abstimmung zum Absagen auswählen')
    .addOptions(terms.map(term => ({
      label: `${term.kind === 'vote' ? 'Abstimmung' : 'Termin'} • ${String(term.title || 'Ohne Titel').slice(0, 70)}`.slice(0, 100),
      description: `${term.date || ''} ${term.time ? `${term.time} Uhr` : ''}`.trim().slice(0, 100) || 'Aktiver Eintrag',
      value: String(term.id),
    })));
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.danger || 0xed4245).setTitle('🗑️ Termin/Abstimmung absagen').setDescription('Wähle unten aus, welcher Eintrag abgesagt werden soll. Die ursprüngliche Nachricht bleibt sichtbar, wird als abgesagt markiert und die Buttons werden entfernt.')],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}
async function deleteTermOrVoteById(guild, termId, deletedById) {
  const term = (store.terms?.items || []).find(item => String(item.id) === String(termId));
  if (!term) return null;

  // Nicht wirklich löschen: Termin/Abstimmung bleibt sichtbar, wird nur als abgesagt markiert.
  term.cancelled = true;
  term.cancelledAt = now();
  term.cancelledBy = deletedById;
  term.cancelReason = 'Manuell über Termin/Abstimmung löschen abgesagt';
  if (term.kind === 'vote') term.voteClosed = true;
  if (term.kind !== 'vote') term.closed = true;

  const channelKey = term.kind === 'vote' ? 'abstimmungen' : 'ankuendigungen';
  const channelId = store.config.channels?.[channelKey];
  const channel = channelId ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)) : null;
  if (channel?.isTextBased?.() && term.messageId) {
    const msg = await withDiscordRetry(() => channel.messages.fetch(term.messageId)).catch(() => null);
    if (msg) {
      const embed = term.kind === 'vote' ? buildCancelledVoteEmbed(term) : buildCancelledTermEmbed(term);
      await safeMessageEdit(msg, { embeds: [embed], components: [] }, 'term.cancel.edit').catch(() => null);
    }
  }

  saveAll();
  if (store.config.panelMessages?.term_dashboard?.channelId) await upsertTermDashboardMessage(guild).catch(() => null);
  return term;
}

function buildMemberPickerResponse(guild, sessionId, page, type) {
  const members = [...guild.members.cache.values()]
    .filter(member => !member.user.bot)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
  const pages = chunk(members, 25);
  const safePage = Math.max(0, Math.min(page, Math.max(0, pages.length - 1)));
  const options = buildMemberSelectOptions(pages[safePage] || [], '');
  const selectId = type === 'sanction' ? `sanction_pick:${sessionId}` : `sanction_paid_pick:${sessionId}`;
  const placeholder = type === 'sanction' ? 'Mitglied für Sanktion wählen' : 'Offene Sanktion wählen';
  if (type === 'sanction_paid') {
    const openSanctions = store.sanctions.items.filter(item => !item.paid && item.status !== 'bezahlt');
    const sanctionPages = chunk(openSanctions.sort((a, b) => b.createdAt - a.createdAt), 25);
    const current = sanctionPages[safePage] || [];
    const sanctionOptions = current.length
      ? current.map(item => ({
          label: `${guild.members.cache.get(item.userId)?.displayName || item.userId} • ${item.catalogNo} • ${item.penaltyType}`.slice(0, 100),
          value: item.id,
        }))
      : [{ label: 'Keine offenen Sanktionen', value: 'none' }];
    return {
      embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Offene Sanktionen').setDescription(`Seite ${safePage + 1}/${Math.max(1, sanctionPages.length)} | ${openSanctions.length} offen`)],
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(selectId).setPlaceholder(placeholder).addOptions(sanctionOptions)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sanction_paid_page:${sessionId}:prev`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
          new ButtonBuilder().setCustomId(`sanction_paid_page:${sessionId}:next`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= Math.max(1, sanctionPages.length) - 1),
          new ButtonBuilder().setCustomId(`sanction_paid_page:${sessionId}:refresh`).setLabel('🔄 Aktualisieren').setStyle(ButtonStyle.Primary),
        ),
      ],
    };
  }
  return {
    embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Mitglied auswählen').setDescription(`Seite ${safePage + 1}/${Math.max(1, pages.length)} | ${members.length} Mitglieder`)],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(selectId).setPlaceholder(placeholder).addOptions(options)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sanction_page:${sessionId}:prev`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
        new ButtonBuilder().setCustomId(`sanction_page:${sessionId}:next`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= Math.max(1, pages.length) - 1),
        new ButtonBuilder().setCustomId(`sanction_page:${sessionId}:refresh`).setLabel('🔄 Aktualisieren').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

async function upsertStoredPanelMessage(panelKey, channel, payload, options = {}) {
  if (!channel) return null;
  store.config.panelMessages ||= {};
  const allowCreate = !!options.allowCreate;
  const nextHash = payloadHash(payload);
  const stored = store.config.panelMessages?.[panelKey];
  let msg = null;
  if (stored?.channelId && stored?.messageId) {
    const oldChannel = channel.guild.channels.cache.get(stored.channelId) || await withDiscordRetry(() => channel.guild.channels.fetch(stored.channelId)).catch(() => null);
    if (oldChannel?.isTextBased?.()) {
      msg = await withDiscordRetry(() => oldChannel.messages.fetch(stored.messageId)).catch(() => null);
    }
  }
  if (msg) {
    if (msg.channelId !== channel.id && !allowCreate) {
      // Automatische Syncs dürfen niemals ein zweites Panel in einem anderen Kanal erzeugen.
      store.config.panelMessages[panelKey] = { ...stored, missingOrMovedAt: now(), wantedChannelId: channel.id, payloadHash: stored?.payloadHash || null };
      saveAll();
      return null;
    } else if (msg.channelId !== channel.id) {
      msg = null;
    } else if (stored?.payloadHash === nextHash) {
      return msg;
    } else {
      const edited = await safeMessageEdit(msg, payload, 'stored.message.edit').catch(() => null);
      if (edited) msg = edited;
    }
  }
  if (!msg) {
    if (!allowCreate) {
      // Wichtig: Panels, Dashboards und Statistik-Nachrichten werden bei Start/Sync nur bearbeitet.
      // Wenn die gespeicherte Discord-Nachricht gelöscht wurde, wird sie NICHT automatisch neu gesendet.
      if (stored) {
        store.config.panelMessages[panelKey] = { ...stored, missingAt: now(), payloadHash: stored?.payloadHash || null };
        saveAll();
      }
      return null;
    }
    msg = await safeChannelSend(channel, payload, 'stored.message.create').catch(() => null);
  }
  if (!msg) return null;
  store.config.panelMessages[panelKey] = { channelId: msg.channel.id, messageId: msg.id, payloadHash: nextHash, updatedAt: now() };
  saveAll();
  return msg;
}
async function syncAllStoredPanels(guild) {
  if (!guild) return;
  const panelTargets = [];
  for (const category of getEnabledAbgabeKeys()) {
    const key = `abgabe_${category}`;
    const stored = store.config.panelMessages?.[key];
    const channelId = stored?.channelId || store.config.channels?.[category];
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    panelTargets.push(upsertStoredPanelMessage(key, channel, buildAbgabePanelComponents(guild, category, 0, '')));
  }
  const simplePanels = [
    ['dashboard', store.config.panelMessages?.dashboard?.channelId || store.config.channels?.dashboard || store.config.channels?.statistik, async () => ({ embeds: [await buildDashboardEmbed(guild)], components: buildMainDashboardComponents() })],
    ['sanktionen', store.config.panelMessages?.sanktionen?.channelId || store.config.channels?.sanktionen, () => ({
      embeds: [buildSanctionPanelEmbed()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('sanction_open').setLabel('⚖️ Ausstellen').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('sanction_mark_paid').setLabel('✅ Bezahlt').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('sanction_catalog').setLabel('📘 Katalog').setStyle(ButtonStyle.Secondary),
        ),
      ],
    })],
    ['abmeldungen', store.config.panelMessages?.abmeldungen?.channelId || store.config.channels?.abmeldungen, () => {
      const select = new StringSelectMenuBuilder()
        .setCustomId('absence_self')
        .setPlaceholder('Dauer wählen')
        .addOptions(ABSENCE_OPTIONS.map(days => ({ label: `${days} ${days === 1 ? 'Tag' : 'Tage'}`, value: String(days) })));
      return {
        embeds: [buildAbsencePanelEmbed()],
        components: [
          new ActionRowBuilder().addComponents(select),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('absence_custom_until').setLabel('🗓️ Eigenes Datum').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('absence_term_today').setLabel('📍 Nur heute').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('absence_status').setLabel('📋 Status').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('absence_stop_self').setLabel('🛑 Stoppen').setStyle(ButtonStyle.Danger),
          ),
        ],
      };
    }],
    ['termine', store.config.panelMessages?.termine?.channelId || store.config.channels?.termine, () => ({
      embeds: [buildTermPanelEmbed()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('term_create').setLabel('📅 Termin erstellen').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('vote_create').setLabel('🗳️ Abstimmung erstellen').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('term_delete_open').setLabel('🗑️ Termin/Abstimmung absagen').setStyle(ButtonStyle.Danger),
        ),
      ],
    })],
    ['leaderpanel', store.config.panelMessages?.leaderpanel?.channelId || store.config.channels?.statistik, async () => ({ embeds: [buildLeaderPanelEmbed(guild)], components: buildLeaderPanelComponents() })],
    ['adminpanel', store.config.panelMessages?.adminpanel?.channelId || store.config.channels?.statistik, async () => ({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() })],
  ];
  if (store.config.panelMessages?.term_dashboard?.channelId) {
    simplePanels.push(['term_dashboard', store.config.panelMessages.term_dashboard.channelId, async () => ({ embeds: [await buildTermDashboardEmbed(guild)], components: [] })]);
  }
  if (store.config.panelMessages?.members_dashboard?.channelId) {
    simplePanels.push(['members_dashboard', store.config.panelMessages.members_dashboard.channelId, async () => ({ embeds: [await buildMembersDashboardEmbed(guild)], components: buildMembersDashboardComponents(guild) })]);
  }
  for (const [key, channelId, builder] of simplePanels) {
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    panelTargets.push(Promise.resolve(builder()).then(payload => upsertStoredPanelMessage(key, channel, payload)));
  }
  await Promise.all(panelTargets);
}
async function syncAllStoredMessages(guild) {
  if (!guild) return;
  await syncAllStoredPanels(guild);
  for (const sanction of store.sanctions.items) {
    if (sanction.publicMessageId) {
      await updateSanctionPublicMessage(guild, sanction);
    }
  }
  await refreshAllActiveTermAnnouncements(guild);
}

async function sendAbgabePanel(channel, category, guild) {
  const payload = buildAbgabePanelComponents(guild, category, 0, '');
  await upsertStoredPanelMessage(`abgabe_${category}`, channel, payload, { allowCreate: true });
}
async function sendSanctionPanel(channel) {
  await upsertStoredPanelMessage('sanktionen', channel, {
    embeds: [buildSanctionPanelEmbed()],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sanction_open').setLabel('➕ Ausstellen').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('sanction_mark_paid').setLabel('✅ Bezahlt').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('sanction_catalog').setLabel('📘 Katalog').setStyle(ButtonStyle.Secondary),
      ),
    ],
  }, { allowCreate: true });
}
async function sendAbsencePanel(channel) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('absence_self')
    .setPlaceholder('Dauer wählen')
    .addOptions(ABSENCE_OPTIONS.map(days => ({ label: `${days} ${days === 1 ? 'Tag' : 'Tage'}`, value: String(days) })));
  await upsertStoredPanelMessage('abmeldungen', channel, {
    embeds: [buildAbsencePanelEmbed()],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('absence_custom_until').setLabel('🗓️ Eigenes Datum').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('absence_term_today').setLabel('📍 Nur heute').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('absence_status').setLabel('📋 Status').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('absence_stop_self').setLabel('🛑 Stoppen').setStyle(ButtonStyle.Danger),
      ),
    ],
  }, { allowCreate: true });
}
async function sendTermPanel(channel) {
  await upsertStoredPanelMessage('termine', channel, {
    embeds: [buildTermPanelEmbed()],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('term_create').setLabel('📅 Termin erstellen').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vote_create').setLabel('🗳️ Abstimmung erstellen').setStyle(ButtonStyle.Primary),
      ),
    ],
  }, { allowCreate: true });
}
async function sendLeaderPanel(channel, guild) {
  await upsertStoredPanelMessage('leaderpanel', channel, { embeds: [buildLeaderPanelEmbed(guild)], components: buildLeaderPanelComponents() }, { allowCreate: true });
}
async function sendAdminPanel(channel) {
  await upsertStoredPanelMessage('adminpanel', channel, { embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() }, { allowCreate: true });
}
// =========================================================
// CHANNEL SETUP
// =========================================================
async function ensureChannel(guild, name) {
  const normalized = normalizeText(name);
  let channel = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name === normalized);
  if (!channel) {
    channel = await guild.channels.create({ name: normalized, type: ChannelType.GuildText });
  }
  return channel;
}
async function setupChannels(guild) {
  const channels = {
    routen: await ensureChannel(guild, ABGABEN.routen.channelName),
    patronen: await ensureChannel(guild, ABGABEN.patronen.channelName),
    schwarzpulver: await ensureChannel(guild, ABGABEN.schwarzpulver.channelName),
    meth: await ensureChannel(guild, ABGABEN.meth.channelName),
    sanktionen: await ensureChannel(guild, 'sanktionen'),
    ausgeteilte: await ensureChannel(guild, 'ausgeteilte-strafen'),
    abmeldungen: await ensureChannel(guild, 'abmeldungen'),
    termine: await ensureChannel(guild, 'termine'),
    ankuendigungen: await ensureChannel(guild, 'ankuendigungen'),
    abstimmungen: await ensureChannel(guild, 'abstimmungen'),
    statistik: await ensureChannel(guild, 'abgaben-statistik'),
  };
  store.config.channels = Object.fromEntries(Object.entries(channels).map(([key, value]) => [key, value.id]));
  saveAll();
  await sendAbgabePanel(channels.routen, 'routen', guild);
  await sendAbgabePanel(channels.patronen, 'patronen', guild);
  await sendAbgabePanel(channels.schwarzpulver, 'schwarzpulver', guild);
  await sendAbgabePanel(channels.meth, 'meth', guild);
  await sendSanctionPanel(channels.sanktionen);
  await sendAbsencePanel(channels.abmeldungen);
  await sendTermPanel(channels.termine);
  return channels;
}
function buildSimpleReportEmbed(title, description, color = 0x2b2d31) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || 'Keine Einträge.')
    .setTimestamp(new Date());
}
async function postWeeklyMissingReportFriday() {
  ensureConfigShape();
  if (!store.config.settings.routeAdminFridayReportEnabled) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  const weekKey = currentWeekKey();
  ensureWeek(weekKey);
  touchPrepaidStatusForWeek(guild, weekKey);
  const lines = [];
  for (const category of getEnabledAbgabeKeys()) {
    const missing = [];
    for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'friday-report' })) {
      if (getActiveAbsence(member.id, 'abgabe')) continue;
      const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
      if (['abgegeben', 'zu_spaet', 'entschuldigt', 'vorausgezahlt'].includes(entry.status)) continue;
      missing.push(`• ${getUserDisplay(guild, member.id)}`);
    }
    lines.push(`**${ABGABEN[category].label}**\n${missing.join('\n') || 'Niemand offen'}`);
  }
  const users = await getRoutenverwaltungUsers(guild);
  const embed = buildSimpleReportEmbed(`Freitagsliste – noch nicht abgegeben (${weekKey})`, lines.join('\n\n'), 0xf1c40f);
  for (const user of users) {
    await sendDM(user, { embeds: [embed] }, { area: 'general', noticeKey: `leader:${Date.now()}` });
  }
}
async function postMondayOverdueReport() {
  ensureConfigShape();
  if (!store.config.settings.routeAdminMondayReportEnabled) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  const oldWeek = previousWeekKey(currentWeekKey());
  ensureWeek(oldWeek);
  const lines = [];
  for (const category of getEnabledAbgabeKeys()) {
    const overdue = [];
    for (const member of getRequiredMembersForAbgabe(guild, category, oldWeek, { reason: 'monday-report' })) {
      const entry = ensureAbgabeEntry(oldWeek, category, member.id);
      if (entry.status !== 'warnphase') continue;
      overdue.push(`• ${getUserDisplay(guild, member.id)}`);
    }
    lines.push(`**${ABGABEN[category].label}**\n${overdue.join('\n') || 'Niemand überfällig'}`);
  }
  const users = await getRoutenverwaltungUsers(guild);
  const embed = buildSimpleReportEmbed(`Montagsliste – überfällige Abgaben (${oldWeek})`, lines.join('\n\n'), 0xe67e22);
  for (const user of users) {
    await sendDM(user, { embeds: [embed] }, { area: 'general', noticeKey: `leader:${Date.now()}` });
  }
}
// =========================================================
// REMINDER / TRANSITIONS
// =========================================================
async function sendAbgabeReminder(stage) {
  if (!shouldRunAbgabeReminderStage(stage)) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  const weekKey = getEffectiveAbgabeWeek(guild, currentWeekKey());
  ensureWeek(weekKey);
  touchPrepaidStatusForWeek(guild, weekKey);
  for (const category of getEnabledAbgabeKeys()) {
    for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'reminder' })) {
      if (getActiveAbsence(member.id, 'abgabe')) continue;
      const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
      if (!['offen', 'warnphase', 'spaeter_abgabe', 'teilabgabe'].includes(entry.status)) continue;
      if (!shouldSendSmartAbgabeReminder(guild, member.id, category, stage)) {
        entry.smartReminderSkipped ||= [];
        const reason = getSmartAbgabeSkipReason(guild, member.id, category, stage);
        entry.smartReminderSkipped.push({ stage, at: isoStringNow(), reason });
        entry.updatedAt = isoStringNow();
        continue;
      }
      let payload = null;
      if (stage === 'thu') payload = buildAbgabeOpenDM(category, 'thu', weekKey);
      if (stage === 'fri') payload = buildAbgabeOpenDM(category, 'fri', weekKey);
      if (stage === 'sun') payload = buildAbgabeOpenDM(category, 'sun', weekKey);
      if (!payload) continue;
      if (!entry.reminders.includes(stage)) {
        const intelligenceLines = getReminderIntelligenceForUser(guild, member.id, category, stage);
        const baseEmbed = payload.embeds?.[0];
        const personalized = baseEmbed ? { embeds: [EmbedBuilder.from(baseEmbed).addFields(buildInfoField('🧠 Einschätzung', intelligenceLines.length ? intelligenceLines : ['Kein besonderes Zusatzrisiko erkannt.'], false))] } : payload;
        await sendDM(member.user, personalized, { area: 'abgaben', noticeKey: `abgabe:${category}:${weekKey}:personalized` });
        entry.reminders.push(stage);
        entry.updatedAt = isoStringNow();
      }
    }
  }
  saveAll();
}

function getAbgabeReminderWindowsForWeek(weekKey) {
  const monday = weekKeyToMondayDate(weekKey);
  const stages = getSystemControlConfig().reminders.abgabeStages || {};
  const enabled = Object.entries(stages)
    .filter(([, s]) => s?.enabled)
    .map(([stage, s]) => {
      const d = new Date(monday);
      d.setDate(d.getDate() + (Number(s.day || 1) - 1));
      d.setHours(Number(s.hour || 0), Number(s.minute || 0), 0, 0);
      return { stage, start: d.getTime() };
    })
    .sort((a, b) => a.start - b.start);
  const windows = {};
  for (let i = 0; i < enabled.length; i += 1) {
    windows[enabled[i].stage] = { start: enabled[i].start, end: enabled[i + 1]?.start || (enabled[i].start + 24 * 60 * 60 * 1000) };
  }
  return windows;
}
async function processAbgabeReminderCatchup() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  const weekKey = getEffectiveAbgabeWeek(guild, currentWeekKey());
  const currentTs = now();
  const windows = getAbgabeReminderWindowsForWeek(weekKey);
  const dueStages = Object.entries(windows)
    .filter(([, window]) => currentTs >= window.start && currentTs < window.end)
    .map(([stage]) => stage);

  if (!dueStages.length) return;

  ensureWeek(weekKey);
  touchPrepaidStatusForWeek(guild, weekKey);
  let sent = 0;
  let skipped = 0;

  for (const stage of dueStages) {
    for (const category of getEnabledAbgabeKeys()) {
      for (const member of getRequiredMembersForAbgabe(guild, category, weekKey, { reason: 'reminder-catchup' })) {
        const entry = getAbgabeStatusForWeek(guild, weekKey, category, member.id);
        if (!['offen', 'warnphase', 'spaeter_abgabe', 'teilabgabe'].includes(entry.status)) { skipped += 1; continue; }
        if (getActiveAbsence(member.id, 'abgabe')) { skipped += 1; continue; }
        if (!shouldSendSmartAbgabeReminder(guild, member.id, category, stage)) {
          entry.smartReminderSkipped ||= [];
          entry.smartReminderSkipped.push({ stage, at: isoStringNow(), reason: getSmartAbgabeSkipReason(guild, member.id, category, stage) });
          entry.updatedAt = isoStringNow();
          skipped += 1;
          continue;
        }

        entry.reminders ||= [];
        if (entry.reminders.includes(stage)) { skipped += 1; continue; }

        let payload = null;
        if (stage === 'thu') payload = buildAbgabeOpenDM(category, 'thu', weekKey);
        if (stage === 'fri') payload = buildAbgabeOpenDM(category, 'fri', weekKey);
        if (stage === 'sun') payload = buildAbgabeOpenDM(category, 'sun', weekKey);
        if (!payload) { skipped += 1; continue; }

        const intelligenceLines = getReminderIntelligenceForUser(guild, member.id, category, stage);
        const baseEmbed = payload.embeds?.[0];
        const personalized = baseEmbed ? { embeds: [EmbedBuilder.from(baseEmbed).addFields(buildInfoField('🧠 Einschätzung', intelligenceLines.length ? intelligenceLines : ['Kein besonderes Zusatzrisiko erkannt.'], false))] } : payload;
        await sendDM(member.user, personalized, { area: 'abgaben', noticeKey: `abgabe:${category}:${weekKey}:personalized` });
        entry.reminders.push(stage);
        entry.updatedAt = isoStringNow();
        sent += 1;
      }
    }
  }

  saveAll();

  if (sent > 0) {
    await sendSystemLog('📩 DM-Nachholung ausgeführt', [
      `Woche: ${weekKey}`,
      `Phasen: ${dueStages.join(', ')}`,
      `Gesendet: ${sent}`,
      `Übersprungen: ${skipped}`,
    ], COLORS.info).catch(() => null);
  }
}

async function mondayStartWeekHandling() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  const newWeek = currentWeekKey();
  const oldWeek = previousWeekKey(newWeek);
  ensureWeek(oldWeek);
  const oldWeekDeadlineTs = getWeeklyReportDeadlineTsForWeek(oldWeek);
  if (oldWeekDeadlineTs && now() < oldWeekDeadlineTs) {
    await sendSystemLog('⏳ Wochenstart verschoben', [
      `Alte Woche: ${oldWeek}`,
      `Neue Woche wäre: ${newWeek}`,
      `Grund: Mindestens eine Abgabe aus ${oldWeek} läuft noch.`,
      `Späteste Frist: ${formatDateTime(oldWeekDeadlineTs)}`,
      'Panels bleiben bis dahin auf der alten Woche. Statistik/Übergang startet erst danach.',
    ], COLORS.warning).catch(() => null);
    saveAll();
    return;
  }
  ensureWeek(newWeek);
  ensureAbgabeRequiredSnapshotsForWeek(guild, oldWeek, 'monday-start-old-week');
  ensureAbgabeRequiredSnapshotsForWeek(guild, newWeek, 'monday-start-new-week');
  touchPrepaidStatusForWeek(guild, oldWeek);
  touchPrepaidStatusForWeek(guild, newWeek);
  for (const category of getEnabledAbgabeKeysForWeek(oldWeek)) {
    for (const member of getRequiredMembersForAbgabe(guild, category, oldWeek, { reason: 'monday-transition' })) {
      const oldEntry = getAbgabeStatusForWeek(guild, oldWeek, category, member.id);
      if (!['offen', 'warnphase', 'spaeter_abgabe'].includes(oldEntry.status)) continue;
      if (isExcusedDueToLateRoleAssignment(member, category, oldWeek)) {
        markExcused(member.id, category, oldWeek, null, 'Rolle ab Mittwoch erhalten');
        continue;
      }
      if (findPrepaymentSource(member.id, category, oldWeek)) {
        oldEntry.status = 'vorausgezahlt';
        continue;
      }
      if (isUserFullyExcusedForWeek(member.id, oldWeek)) {
        markExcused(member.id, category, oldWeek, null, `Mindestens ${getAbgabeAbsenceExcuseDays()} Tage abgemeldet`);
        continue;
      }
      const deadlineAbsence = isUserAbsentOnDeadline(member.id, oldWeek);
      if (deadlineAbsence) {
        markLateRecovery(member.id, category, oldWeek, deadlineAbsence.untilTs);
        continue;
      }
      markWeekOverdue(member.id, category, oldWeek);
      const user = await client.users.fetch(member.id).catch(() => null);
      if (user) {
        await sendDM(user, buildAbgabeOverdueDM(category, oldWeek), { area: 'abgaben', noticeKey: `abgabe:${category}:${oldWeek}:overdue` });
      }
    }
  }
  accumulateMonthFromWeek(oldWeek);
  saveAll();
  await postMondayOverdueReport();
}
async function tuesday2201AutoSanctions() {
  if (!isAutomationEnabled('abgabeAutoSanctions')) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await ensureGuildMembersCached(guild);
  const targetWeek = previousWeekKey(currentWeekKey());
  // Alte Dienstag-22:01-Routine bleibt nur als Zusatz-Scan bestehen.
  // Die tatsächliche Fälligkeit kommt jetzt aus dem Regelpanel: Abgabefrist + Nachfrist-Tage.
  touchAbgabeAutomationWeek(targetWeek);
  for (const category of getEnabledAbgabeKeysForWeek(targetWeek)) {
    for (const member of getRequiredMembersForAbgabe(guild, category, targetWeek, { reason: 'auto-sanction' })) {
      const shouldSanction = await shouldAutoSanctionAbgabeUser(guild, member.id, category, targetWeek);
      if (!shouldSanction) continue;
      await issueAutoAbgabeSanction(guild, member.id, category, targetWeek, `Nachfrist von ${Number(getRuleConfig('abgabeAutoSanction').overdueDays || 0)} Tag(en) verpasst`);
    }
  }
}
async function processFollowUps() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  for (const [weekKey, week] of Object.entries(store.abgaben.weeks)) {
    for (const category of getEnabledAbgabeKeysForWeek(weekKey)) {
      for (const [userId, entry] of Object.entries(week.categories?.[category] || {})) {
        if (!isUserRequiredForAbgabeWeek(guild, userId, category, weekKey, { reason: 'followup' })) {
          if (['offen', 'warnphase', 'spaeter_abgabe', 'nicht_abgegeben', 'teilabgabe'].includes(entry.status)) {
            entry.status = 'entschuldigt';
            entry.note = 'Nicht im Pflicht-Snapshot dieser Woche';
            entry.followUp = null;
            entry.sanctionIssued = false;
            entry.updatedAt = isoStringNow();
          }
          continue;
        }
        getAbgabeStatusForWeek(guild, weekKey, category, userId);
        if (!entry.followUp) continue;
        if (getActiveAbsence(userId, 'abgabe')) continue;
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) continue;
        if (entry.status === 'spaeter_abgabe') {
          if (now() < entry.followUp.firstDueTs) {
            if (now() - (entry.followUp.lastReminderAt || 0) >= 24 * 60 * 60 * 1000) {
              entry.followUp.lastReminderAt = now();
              await sendDM(user, buildAbgabeRecoveryOpenDM(category, weekKey), { area: 'abgaben', noticeKey: `abgabe:${category}:${weekKey}:recovery-open` });
            }
          } else if (now() < entry.followUp.finalDueTs) {
            entry.status = 'warnphase';
            entry.updatedAt = isoStringNow();
            if (now() - (entry.followUp.lastWarningAt || 0) >= 24 * 60 * 60 * 1000) {
              entry.followUp.lastWarningAt = now();
              await sendDM(user, buildAbgabeRecoveryWarningDM(category, weekKey, entry.followUp.finalDueTs), { area: 'abgaben', noticeKey: `abgabe:${category}:${weekKey}:recovery-warning` });
            }
          } else {
            const shouldSanction = await shouldAutoSanctionAbgabeUser(guild, userId, category, weekKey);
            if (shouldSanction) {
              await issueAutoAbgabeSanction(guild, userId, category, weekKey, 'Nachholung nach Abmeldung nicht erledigt');
            }
          }
        } else if (entry.status === 'warnphase') {
          if (now() - (entry.followUp?.lastWarningAt || 0) >= 24 * 60 * 60 * 1000) {
            entry.followUp ||= {};
            entry.followUp.lastWarningAt = now();
            await sendDM(user, buildAbgabeFinalWarningDM(category, weekKey, entry.followUp?.finalDueTs || null), { area: 'abgaben', noticeKey: `abgabe:${category}:${weekKey}:final` });
            saveAll();
          }
        }
      }
    }
  }
  saveAll();
}

// =========================================================
// MODERATION: /clear
// =========================================================
function canUseClearCommand(member) {
  return hasActionPermission(member, 'config_manage') || hasActionPermission(member, 'sanction_approve') || hasActionPermission(member, 'admin');
}
function buildClearConfirmComponents(channelId, amount, allMode) {
  const safeAmount = Math.max(1, Math.min(1000, Number(amount) || 100));
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`clear_confirm:${channelId}:${allMode ? 'all' : 'amount'}:${safeAmount}`)
      .setLabel(allMode ? 'Ja, alle löschbaren löschen' : `Ja, ${safeAmount} löschen`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('clear_cancel')
      .setLabel('Abbrechen')
      .setStyle(ButtonStyle.Secondary),
  )];
}
async function deleteRecentChannelMessages(channel, amount) {
  let remaining = Math.max(1, Math.min(1000, Number(amount) || 100));
  let deletedTotal = 0;
  let before;
  while (remaining > 0) {
    const limit = Math.min(100, remaining);
    const fetched = await channel.messages.fetch({ limit, ...(before ? { before } : {}) }).catch(() => null);
    if (!fetched || fetched.size === 0) break;
    before = fetched.last()?.id;
    const deleted = await channel.bulkDelete(fetched, true).catch(async () => {
      let count = 0;
      for (const msg of fetched.values()) {
        try {
          if (Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000) {
            await msg.delete();
            count += 1;
            await sleep(250);
          }
        } catch (_) {}
      }
      return { size: count };
    });
    deletedTotal += Number(deleted?.size || 0);
    remaining -= fetched.size;
    if (fetched.size < limit) break;
    await sleep(600);
  }
  return deletedTotal;
}
async function deleteAllBulkDeletableChannelMessages(channel, maxSafety = 5000) {
  let deletedTotal = 0;
  let before;
  for (let i = 0; i < Math.ceil(maxSafety / 100); i += 1) {
    const fetched = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!fetched || fetched.size === 0) break;
    before = fetched.last()?.id;
    const fresh = fetched.filter(msg => Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
    if (fresh.size === 0) break;
    const deleted = await channel.bulkDelete(fresh, true).catch(async () => {
      let count = 0;
      for (const msg of fresh.values()) {
        try { await msg.delete(); count += 1; await sleep(250); } catch (_) {}
      }
      return { size: count };
    });
    deletedTotal += Number(deleted?.size || 0);
    if (fetched.size < 100) break;
    await sleep(800);
  }
  return deletedTotal;
}
async function executeClearCommand(interaction, channelId, mode, amount) {
  if (!canUseClearCommand(interaction.member)) {
    return interaction.update({ content: 'Keine Berechtigung.', embeds: [], components: [] }).catch(() => null);
  }
  const channel = interaction.guild?.channels?.cache?.get(channelId) || interaction.channel;
  if (!channel || !channel.messages || typeof channel.bulkDelete !== 'function') {
    return interaction.update({ content: 'Dieser Channel kann nicht geleert werden.', embeds: [], components: [] }).catch(() => null);
  }
  await interaction.update({ content: '🧹 Lösche Nachrichten ...', embeds: [], components: [] }).catch(() => null);
  const deleted = mode === 'all'
    ? await deleteAllBulkDeletableChannelMessages(channel)
    : await deleteRecentChannelMessages(channel, amount);
  await interaction.editReply({ content: `✅ Fertig. Gelöscht: **${deleted}** Nachricht(en) in <#${channel.id}>. Hinweis: Discord erlaubt Bulk-Löschen nur für Nachrichten unter 14 Tagen.` }).catch(() => null);
  try {
    await logSystemEvent(interaction.guild, '🧹 Channel geleert', [
      `Channel: <#${channel.id}>`,
      `Ausgeführt von: <@${interaction.user.id}>`,
      `Modus: ${mode === 'all' ? 'alle löschbaren' : `${amount} Nachrichten`}`,
      `Gelöscht: ${deleted}`,
    ], COLORS.warning);
  } catch (_) {}
}

// =========================================================
// COMMANDS
// =========================================================
const commands = [
  new SlashCommandBuilder().setName('setup-channels').setDescription('Erstellt alle Hauptkanäle und Basis-Panels'),
  new SlashCommandBuilder().setName('clear').setDescription('Löscht Nachrichten im aktuellen Channel')
    .addIntegerOption(option => option.setName('amount').setDescription('Anzahl der letzten Nachrichten, Standard 100').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addBooleanOption(option => option.setName('all').setDescription('Alle löschbaren Nachrichten im Channel löschen').setRequired(false)),
  new SlashCommandBuilder().setName('panel').setDescription('Öffnet oder sendet ein Bot-Panel')
    .addStringOption(option => option.setName('typ').setDescription('Welches Panel? Leer = Übersicht').setRequired(false)
      .addChoices(
        { name: 'Übersicht – alle Panelbereiche', value: 'verwaltung' },
        { name: 'Leader Panel – tägliche Führung', value: 'leader' },
        { name: 'Systemsteuerung – Regeln/Reminder/Automationen', value: 'system' },
        { name: 'Admin Panel – Technik/Design/Rechte', value: 'admin' },
        { name: 'Abgabe: Routen', value: 'abgabe_routen' },
        { name: 'Abgabe: Patronenhülsen', value: 'abgabe_patronen' },
        { name: 'Abgabe: Schwarzpulver', value: 'abgabe_schwarzpulver' },
        { name: 'Abgabe: Methkisten', value: 'abgabe_meth' },
        { name: 'Sanktionen Panel', value: 'sanktionen' },
        { name: 'Sanktionskatalog lesen – öffentlich ohne Buttons', value: 'sanktionskatalog' },
        { name: 'Sanktionskatalog bearbeiten – Leader', value: 'sanktionskatalog_admin' },
        { name: 'Termine Panel', value: 'termine' },
        { name: 'Termin Dashboard', value: 'termin_dashboard' },
        { name: 'Abmeldungen Panel', value: 'abmeldungen' },
        { name: 'Live Dashboard', value: 'dashboard' },
        { name: 'Kasse Dashboard', value: 'kasse' },
        { name: 'Lager Dashboard', value: 'lager_dashboard' },
        { name: 'Lager Eintragungs-Panel', value: 'lager_panel' },
        { name: 'Wache Panel', value: 'wache_panel' },
        { name: 'Wache Dashboard', value: 'wache_dashboard' },
      )),
  new SlashCommandBuilder().setName('set').setDescription('Zentrale Einstellungen für Kanäle, Rechte und Systemwerte')
    .addSubcommand(sc => sc.setName('kanal').setDescription('Setzt einen gespeicherten Kanal')
      .addStringOption(option => option.setName('typ').setDescription('Kanaltyp, z. B. public_link, verify, routen, kasse').setRequired(true).setAutocomplete(true))
      .addChannelOption(option => option.setName('kanal').setDescription('Kanal auswählen').setRequired(true)))
    .addSubcommand(sc => sc.setName('berechtigung').setDescription('Setzt eine Rollenberechtigung')
      .addStringOption(option => option.setName('typ').setDescription('Berechtigungsbereich').setRequired(true)
        .addChoices(
          { name: 'Admin', value: 'admin' },
          { name: 'Sanktionen verwalten', value: 'sanction_manage' },
          { name: 'Sanktionen freigeben', value: 'sanction_approve' },
          { name: 'Abmeldungen verwalten', value: 'absence_manage' },
          { name: 'Anwesenheit/Wache verwalten', value: 'attendance_manage' },
          { name: 'Konfiguration verwalten', value: 'config_manage' },
          { name: 'Dashboard ansehen', value: 'dashboard_view' },
          { name: 'Rollback verwenden', value: 'rollback_manage' },
        ))
      .addRoleOption(option => option.setName('rolle').setDescription('Rolle auswählen').setRequired(true)))
    .addSubcommand(sc => sc.setName('dryrun').setDescription('Aktiviert/deaktiviert den Testmodus')
      .addStringOption(option => option.setName('status').setDescription('Status').setRequired(true)
        .addChoices({ name: 'An', value: 'on' }, { name: 'Aus', value: 'off' }))),
  new SlashCommandBuilder().setName('bericht').setDescription('Erstellt einen Bericht')
    .addStringOption(option => option.setName('typ').setDescription('Berichtstyp').setRequired(true)
      .addChoices({ name: 'Kassenbericht', value: 'kasse' }, { name: 'Lagerbericht', value: 'lager' }))
    .addStringOption(option => option.setName('monat').setDescription('YYYY-MM, leer = aktueller Monat').setRequired(false)),
  new SlashCommandBuilder().setName('abgaben-wochenreport').setDescription('Erstellt den Abgaben-Wochenreport manuell')
    .addStringOption(option => option.setName('woche').setDescription('Beispiel: 2026-W12, leer = letzte Woche').setRequired(false).setAutocomplete(true)),
  new SlashCommandBuilder().setName('abgaben-monatsreport').setDescription('Erstellt den Abgaben-Monatsreport manuell')
    .addStringOption(option => option.setName('monat').setDescription('YYYY-MM, leer = aktueller Monat').setRequired(false)),
  new SlashCommandBuilder().setName('wochenansehen').setDescription('Zeigt die Abgaben einer Woche')
    .addStringOption(option => option.setName('woche').setDescription('Beispiel: 2026-W12').setRequired(true).setAutocomplete(true))
    .addBooleanOption(option => option.setName('privat').setDescription('Nur du siehst es').setRequired(true))
    .addStringOption(option => option.setName('kanal').setDescription('Optional nur eine Kategorie').setRequired(false)
      .addChoices(
        { name: 'Routen', value: 'routen' },
        { name: 'Patronenhülsen', value: 'patronen' },
        { name: 'Schwarzpulver', value: 'schwarzpulver' },
        { name: 'Methkisten', value: 'meth' },
      )),
  new SlashCommandBuilder().setName('abgabenachtragen').setDescription('Trägt eine Abgabe manuell nach')
    .addUserOption(option => option.setName('mitglied').setDescription('Mitglied').setRequired(true))
    .addStringOption(option => option.setName('typ').setDescription('Kategorie').setRequired(true)
      .addChoices(
        { name: 'Routen', value: 'routen' },
        { name: 'Patronenhülsen', value: 'patronen' },
        { name: 'Schwarzpulver', value: 'schwarzpulver' },
        { name: 'Methkisten', value: 'meth' },
      ))
    .addStringOption(option => option.setName('woche').setDescription('Beispiel: 2026-W12').setRequired(true).setAutocomplete(true))
    .addIntegerOption(option => option.setName('menge').setDescription('Gesamtmenge inklusive Pflichtabgabe').setRequired(true)),
  new SlashCommandBuilder().setName('abmeldung-setzen').setDescription('Setzt eine Abmeldung für ein Mitglied')
    .addUserOption(option => option.setName('mitglied').setDescription('Mitglied').setRequired(true))
    .addIntegerOption(option => option.setName('tage').setDescription('Tage').setRequired(true))
    .addStringOption(option => option.setName('grund').setDescription('Optionaler Grund').setRequired(false)),
  new SlashCommandBuilder().setName('abmeldung-loeschen').setDescription('Entfernt aktive Abmeldungen eines Mitglieds')
    .addUserOption(option => option.setName('mitglied').setDescription('Mitglied').setRequired(true)),
  new SlashCommandBuilder().setName('abmeldungen').setDescription('Zeigt aktive Abmeldungen'),
  new SlashCommandBuilder().setName('lagerbestand-loeschen').setDescription('Entfernt den Lagerbestand eines Mitglieds aus dem Dashboard')
    .addUserOption(option => option.setName('mitglied').setDescription('Mitglied').setRequired(true))
    .addStringOption(option => option.setName('grund').setDescription('Optionaler Grund').setRequired(false)),
  new SlashCommandBuilder().setName('sanktion').setDescription('Startet die manuelle Sanktionserstellung'),
  new SlashCommandBuilder().setName('sanktionskatalog').setDescription('Zeigt den Sanktionskatalog'),
  new SlashCommandBuilder().setName('sicherheitsliste').setDescription('Verwaltet Whitelist und Blacklist')
    .addStringOption(option => option.setName('liste').setDescription('Liste').setRequired(true)
      .addChoices({ name: 'Whitelist', value: 'whitelistUserIds' }, { name: 'Blacklist', value: 'blacklistUserIds' }))
    .addStringOption(option => option.setName('aktion').setDescription('Aktion').setRequired(true)
      .addChoices({ name: 'Anzeigen', value: 'show' }, { name: 'Hinzufügen', value: 'add' }, { name: 'Entfernen', value: 'remove' }))
    .addUserOption(option => option.setName('mitglied').setDescription('Mitglied').setRequired(false)),
  new SlashCommandBuilder().setName('rollback-letzte').setDescription('Macht eine letzte Aktion rückgängig')
    .addStringOption(option => option.setName('id').setDescription('Optional: genaue Rollback-ID').setRequired(false)),

  ...require('./familyPhonebookAddon').familyPhonebookCommands(SlashCommandBuilder),
].map(command => command.toJSON());
// =========================================================
// CLIENT
// =========================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});
require('./familyPhonebookAddon').registerFamilyPhonebookAddon(client, {
  DATA_DIR,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
});
// =========================================================
// INTERACTIONS
// =========================================================
client.on('interactionCreate', async interaction => {
  try {
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'inventory_spacer') return;

  if (interaction.isButton && interaction.isButton() && interaction.customId === 'clear_cancel') {
    return interaction.update({ content: '❌ Clear abgebrochen.', embeds: [], components: [] }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('clear_confirm:')) {
    const [, channelId, mode, amountRaw] = interaction.customId.split(':');
    return executeClearCommand(interaction, channelId, mode, Number(amountRaw || 100));
  }

  // FIX: Termin/Abstimmung absagen sofort am Anfang abfangen.
  // Dadurch läuft der Button nicht erst durch andere Handler und Discord bekommt rechtzeitig eine Antwort.
  if (interaction.isButton && interaction.isButton()) {
    const cid = String(interaction.customId || '').toLowerCase();
    const isTermDeleteButton = [
      'term_delete_open',
      'term_delete',
      'delete_term',
      'term_vote_delete',
      'termin_delete',
      'delete_termin',
      'termin_loeschen',
      'termin_löschen',
      'delete_term_vote',
      'term_delete_vote',
    ].includes(cid) || ((cid.includes('term') || cid.includes('termin') || cid.includes('vote') || cid.includes('abstimmung')) && (cid.includes('delete') || cid.includes('loesch') || cid.includes('lösch')));

    if (isTermDeleteButton) {
      if (!hasActionPermission(interaction.member, 'sanction_approve')) {
        return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
      }
      return interaction.reply({ ...buildTermDeleteSelectPayload(), flags: 64 }).catch(error => {
        console.error('TERM_DELETE_OPEN_REPLY_ERROR', error);
        return null;
      });
    }
  }

  // FIX: Auswahl zum Löschen ebenfalls früh beantworten.
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && String(interaction.customId || '').toLowerCase() === 'term_delete_select') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) {
      return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    }
    await interaction.deferReply({ flags: 64 }).catch(() => null);
    const termId = interaction.values?.[0];
    const deleted = await deleteTermOrVoteById(interaction.guild, termId, interaction.user.id);
    if (!deleted) {
      return interaction.editReply({ content: 'Eintrag nicht gefunden oder bereits abgesagt.', embeds: [], components: [] }).catch(() => null);
    }
    return interaction.editReply({ content: `✅ ${deleted.kind === 'vote' ? 'Abstimmung' : 'Termin'} **${deleted.title || 'Ohne Titel'}** wurde abgesagt und bleibt als abgesagt sichtbar.`, embeds: [], components: [] }).catch(() => null);
  }

  if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('dm_ack:')) {
    return interaction.reply({ content: '✅ Danke, wurde als gesehen markiert.', flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('dm_problem:')) {
    const [, area] = interaction.customId.split(':');
    const guild = client.guilds.cache.get(GUILD_ID);
    const channel = getLogChannel(guild);
    if (channel) await safeChannelSend(channel, { embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle('⚠️ DM-Problem gemeldet').addFields(
      buildInfoField('Mitglied', [`<@${interaction.user.id}>`], true),
      buildInfoField('Bereich', [area || 'general'], true),
      buildInfoField('Hinweis', ['Mitglied hat über den DM-Button ein Problem gemeldet.'], false),
    ).setTimestamp(new Date())] }, 'dm.problem.log').catch(() => null);
    return interaction.reply({ content: '⚠️ Problem wurde an die Leitung gemeldet.', flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('sanction_appeal:')) {
    const sanctionId = interaction.customId.split(':')[1];
    const sanction = (store.sanctions.items || []).find(item => item.id === sanctionId);
    if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
    if (!canAppealSanction(sanction)) return interaction.reply({ content: 'Die Einspruchsfrist ist abgelaufen.', flags: 64 });
    const modal = new ModalBuilder().setCustomId(`sanction_appeal_modal:${sanctionId}`).setTitle('Einspruch gegen Sanktion').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Begründung für den Einspruch').setStyle(TextInputStyle.Paragraph).setRequired(true))
    );
    return interaction.showModal(modal);
  }


  // Familienkasse: Dashboard und Buchungen
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'leader_cashbox') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    await upsertCashboxDashboardMessage(interaction.guild, interaction.channel).catch(() => null);
    return interaction.reply({ content: '💰 Kassen-Dashboard wurde in diesem Kanal erstellt/aktualisiert.', flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && ['cashbox_add_income','cashbox_add_expense'].includes(interaction.customId)) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const type = interaction.customId === 'cashbox_add_income' ? 'income' : 'expense';
    return interaction.reply({ content: `${type === 'income' ? '➕ Einnahme' : '➖ Ausgabe'}: Kategorie auswählen.`, components: buildCashboxCategorySelect(type), flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'cashbox_undo_last') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const tx = await undoLastCashboxTransaction(interaction.guild, interaction.user.id).catch(error => { throw error; });
    if (!tx) return interaction.reply({ content: 'Keine Transaktion zum Rückgängig machen gefunden.', flags: 64 }).catch(() => null);
    return interaction.reply({ content: `↩️ Rückgängig gemacht:\n${formatCashboxTxLine(tx, interaction.guild, false)}`, flags: 64 }).catch(() => null);
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId.startsWith('cashbox_select_category:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const type = interaction.customId.split(':')[1] || 'income';
    const category = interaction.values[0] || 'sonstiges';
    if (cashboxCategoryNeedsItemSelect(category)) {
      return interaction.reply({ content: `${getCashboxCategoryLabel(type, category)}: Artikel auswählen.`, components: buildCashboxItemSelect(type, category), flags: 64 }).catch(() => null);
    }
    return interaction.showModal(buildCashboxAmountModal(type, category));
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId.startsWith('cashbox_select_item:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const [, type, category] = interaction.customId.split(':');
    const selectedItem = interaction.values[0] || '';
    return interaction.showModal(buildCashboxAmountModal(type, category, selectedItem));
  }
  if (interaction.isModalSubmit && interaction.isModalSubmit() && interaction.customId.startsWith('cashbox_amount_modal:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const parts = interaction.customId.split(':');
    const [, type, category] = parts;
    const selectedItem = parts[3] ? decodeURIComponent(parts.slice(3).join(':')) : '';
    let tx;
    if (needsWarehouseDetails(type, category)) {
      tx = await addCashboxWarehouseTransaction(interaction.guild, type, category, {
        item: selectedItem || getOptionalModalValue(interaction, 'item') || '',
        quantity: interaction.fields.getTextInputValue('quantity') || '',
        unitPrice: interaction.fields.getTextInputValue('unitPrice') || '',
        reason: getOptionalModalValue(interaction, 'reason') || '',
      }, interaction.user.id).catch(error => { throw error; });
    } else {
      const amount = interaction.fields.getTextInputValue('amount');
      const reason = interaction.fields.getTextInputValue('reason') || '';
      tx = await addCashboxTransaction(interaction.guild, type, category, amount, interaction.user.id, category === 'sonstiges' ? reason : '', { note: category === 'sonstiges' ? '' : reason }).catch(error => { throw error; });
    }
    return interaction.reply({ content: `✅ Eingetragen:\n${formatCashboxTxLine(tx, interaction.guild, false)}\nAktuelle Kasse: **${formatCurrency(store.cashbox.balance)}**`, flags: 64 }).catch(() => null);
  }

  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_transfer') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    await ensureGuildMembersCached(interaction.guild).catch(() => null);
    getWarehouseTransferSession(interaction.user.id);
    saveAll();
    return interaction.reply({ content: '📦 **Familienlager Übergabe**\nSchritt 1/3: Empfänger auswählen.', components: buildWarehouseTransferMemberComponents(interaction.guild, 0), flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('warehouse_transfer_member_page:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const page = Number(interaction.customId.split(':')[1] || 0);
    await ensureGuildMembersCached(interaction.guild).catch(() => null);
    return interaction.update({ content: '📦 **Familienlager Übergabe**\nSchritt 1/3: Empfänger auswählen.', components: buildWarehouseTransferMemberComponents(interaction.guild, page) }).catch(() => null);
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId.startsWith('warehouse_transfer_member_select:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const targetId = interaction.values?.[0];
    if (!targetId || targetId === 'none') return interaction.reply({ content: 'Kein gültiger Empfänger ausgewählt.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    session.targetId = targetId;
    saveAll();
    return interaction.update({ content: `📦 **Familienlager Übergabe**\nEmpfänger: <@${targetId}>\nSchritt 2/3: Artikel auswählen.`, components: buildWarehouseTransferItemComponents(0) }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith('warehouse_transfer_item_page:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const page = Number(interaction.customId.split(':')[1] || 0);
    const session = getWarehouseTransferSession(interaction.user.id);
    return interaction.update({ content: `📦 **Familienlager Übergabe**\nEmpfänger: ${session.targetId ? `<@${session.targetId}>` : '—'}\nSchritt 2/3: Artikel auswählen.`, components: buildWarehouseTransferItemComponents(page) }).catch(() => null);
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId.startsWith('warehouse_transfer_item_select:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const itemKey = interaction.values?.[0];
    const item = getFamilyWarehouseItemByKey(itemKey);
    if (!item || item.kind === 'other') return interaction.reply({ content: 'Ungültiger Artikel.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    if (!session.targetId) return interaction.reply({ content: 'Bitte starte die Übergabe neu und wähle zuerst einen Empfänger.', flags: 64 }).catch(() => null);
    session.itemKey = item.key;
    saveAll();
    return interaction.update({ content: `📦 **Familienlager Übergabe**\nEmpfänger: <@${session.targetId}>\nArtikel: **${item.label}**\nSchritt 3/3: Menge auswählen.`, components: buildWarehouseTransferQuantityComponents() }).catch(() => null);
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId === 'warehouse_transfer_quantity_select') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    const targetId = session.targetId;
    const itemKey = session.itemKey;
    const quantity = Number(interaction.values?.[0] || 0);
    if (!targetId || !itemKey) return interaction.reply({ content: 'Übergabe unvollständig. Bitte nochmal starten.', flags: 64 }).catch(() => null);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) return interaction.reply({ content: 'Menge muss zwischen 1 und 25 sein.', flags: 64 }).catch(() => null);
    session.quantity = quantity;
    const item = getFamilyWarehouseItemByKey(itemKey);
    if (item?.kind === 'weapon') {
      session.unitPrice = getLastWeaponPurchaseUnitPrice(item.key);
      saveAll();
      return interaction.update({ content: buildWeaponTransferPaymentText(session), components: buildWeaponTransferPaymentComponents(session) }).catch(() => null);
    }
    const result = await completeWarehouseTransferToMember(interaction.guild, session, interaction.user.id, { withPayment: false }).catch(error => { throw error; });
    clearWarehouseTransferSession(interaction.user.id);
    return interaction.update({ content: `✅ Übergabe gespeichert: **${result.qty}x ${result.item.label}** an <@${targetId}>.`, components: [] }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_transfer_weapon_pay_confirm') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    const result = await completeWarehouseTransferToMember(interaction.guild, session, interaction.user.id, { withPayment: true, unitPrice: session.unitPrice }).catch(error => { throw error; });
    clearWarehouseTransferSession(interaction.user.id);
    return interaction.update({ content: `✅ Waffen-Übergabe gespeichert und Zahlung erfasst: **${result.qty}x ${result.item.label}** an <@${result.toUserId}> • **+${formatCurrency(result.total)}**`, components: [] }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_transfer_weapon_pay_edit') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    return interaction.showModal(buildWeaponTransferPriceModal(session.unitPrice));
  }
  if (interaction.isModalSubmit && interaction.isModalSubmit() && interaction.customId === 'warehouse_transfer_weapon_price_modal') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    const unitPrice = Math.round(parseNumber(interaction.fields.getTextInputValue('unitPrice')));
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) return interaction.reply({ content: 'Preis pro Stück muss größer als 0 sein.', flags: 64 }).catch(() => null);
    session.unitPrice = unitPrice;
    saveAll();
    return interaction.reply({ content: buildWeaponTransferPaymentText(session), components: buildWeaponTransferPaymentComponents(session), flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_transfer_weapon_no_pay') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const session = getWarehouseTransferSession(interaction.user.id);
    const result = await completeWarehouseTransferToMember(interaction.guild, session, interaction.user.id, { withPayment: false }).catch(error => { throw error; });
    clearWarehouseTransferSession(interaction.user.id);
    return interaction.update({ content: `✅ Waffen-Übergabe ohne Zahlung gespeichert: **${result.qty}x ${result.item.label}** an <@${result.toUserId}>.`, components: [] }).catch(() => null);
  }


  // Familienlager: Mindestbestand, Warnungen und Item-Historie
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_minimum_setup') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    return interaction.reply({ content: 'Für welchen Artikel möchtest du den Mindestbestand einstellen?', components: buildWarehouseItemSelect('warehouse_minimum_select', 'Artikel für Mindestbestand auswählen'), flags: 64 }).catch(() => null);
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId === 'warehouse_minimum_select') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    return interaction.showModal(buildWarehouseMinimumModal(interaction.values[0]));
  }
  if (interaction.isModalSubmit && interaction.isModalSubmit() && interaction.customId.startsWith('warehouse_minimum_modal:')) {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const itemKey = decodeURIComponent(interaction.customId.split(':').slice(1).join(':'));
    const minimum = interaction.fields.getTextInputValue('minimum');
    const result = setFamilyWarehouseMinimum(itemKey, minimum);
    await checkFamilyWarehouseMinimumWarning(interaction.guild, result.item).catch(() => null);
    await upsertCashboxDashboardMessage(interaction.guild).catch(() => null);
    return interaction.reply({ content: `✅ Mindestbestand gesetzt: **${result.item.label}** → **${result.minimum}**`, flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_history_open') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    return interaction.reply({ content: 'Für welchen Artikel möchtest du den Verlauf sehen?', components: buildWarehouseItemSelect('warehouse_history_select', 'Artikel für Verlauf auswählen'), flags: 64 }).catch(() => null);
  }
  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId === 'warehouse_history_select') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    return interaction.reply({ embeds: [buildWarehouseHistoryEmbed(interaction.values[0])], flags: 64 }).catch(() => null);
  }
  if (interaction.isButton && interaction.isButton() && interaction.customId === 'warehouse_warning_toggle') {
    if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 }).catch(() => null);
    const f = ensureFamilyWarehouseShape();
    f.minimumWarningsEnabled = !f.minimumWarningsEnabled;
    saveAll();
    if (f.minimumWarningsEnabled) await checkAllFamilyWarehouseMinimumWarnings(interaction.guild).catch(() => null);
    await upsertCashboxDashboardMessage(interaction.guild).catch(() => null);
    return interaction.reply({ content: `🔔 Mindestbestand-Warnungen sind jetzt **${f.minimumWarningsEnabled ? 'AN' : 'AUS'}**.`, flags: 64 }).catch(() => null);
  }

  // Lagerbestand: eigenen Bestand anzeigen
  if (interaction.isButton && interaction.isButton() && (interaction.customId === 'inventory_show_mine' || interaction.customId === 'inventory_open_modal')) {
    try {
      await replyInventoryPrivateStatus(interaction, '👤 Dein aktueller Lagerbestand:');
    } catch (error) {
      console.error('INVENTORY_SHOW_MINE_ERROR', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler beim Anzeigen deines Lagerbestands.', flags: 64 }).catch(() => null);
      }
    }
    return;
  }



  if (interaction.isButton && interaction.isButton() && interaction.customId === 'inventory_open_modal') {
    await replyInventoryPrivateStatus(interaction, '✅ Dein Bestand:').catch(async error => {
      console.error('INVENTORY_SHOW_ERROR', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler beim Anzeigen vom Lagerbestand.', flags: 64 }).catch(() => null);
      }
    });
    return;
  }

  if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId === 'inventory_select_item') {
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 }).catch(() => null);
      }

      ensureInventoryEditorShape();
      store.sessions.inventoryEditors[interaction.user.id] ||= { selected: 'munition' };
      store.sessions.inventoryEditors[interaction.user.id].selected = interaction.values[0] || 'munition';
      saveAll();

      const content = buildInventoryPrivateStatus(interaction.guild, interaction.user.id);
      await interaction.editReply({ content, embeds: [], components: [] }).catch(() => null);
    } catch (error) {
      console.error('INVENTORY_SELECT_ERROR', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler beim Auswählen.', flags: 64 }).catch(() => null);
      }
    }
    return;
  }

  if (interaction.isButton && interaction.isButton() && ['inventory_dec_10','inventory_dec_5','inventory_dec_2','inventory_dec_1','inventory_inc_1','inventory_inc_2','inventory_inc_5','inventory_inc_10','inventory_reset_selected'].includes(interaction.customId)) {
    const deltaMap = {
      inventory_dec_10: -10,
      inventory_dec_5: -5,
      inventory_dec_2: -2,
      inventory_dec_1: -1,
      inventory_inc_1: 1,
      inventory_inc_2: 2,
      inventory_inc_5: 5,
      inventory_inc_10: 10,
    };

    if (interaction.customId === 'inventory_reset_selected') {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.deferReply({ flags: 64 }).catch(() => null);
        }

        ensureInventoryEditorShape();
        const userId = interaction.user.id;
        store.sessions.inventoryEditors[userId] ||= { selected: 'munition' };
        const selected = store.sessions.inventoryEditors[userId].selected || 'munition';
        const entry = getInventoryEntry(userId);
        setInventoryValue(entry, selected, 0);
        saveAll();

        await interaction.editReply({
          content: `✅ ${getInventoryItemLabel(selected)} wurde zurückgesetzt.\n\n${buildInventoryPrivateStatus(interaction.guild, userId)}`,
          embeds: [],
          components: []
        }).catch(() => null);

        setImmediate(() => {
          updateInventoryListMessage(interaction.guild).catch(error => console.error('INVENTORY_LIST_UPDATE_ERROR', error));
        });
      } catch (error) {
        console.error('INVENTORY_RESET_ERROR', error);
      }
      return;
    }

    await adjustInventorySelected(interaction, deltaMap[interaction.customId]).catch(async error => {
      console.error('INVENTORY_ADJUST_ERROR', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler beim Bearbeiten vom Lagerbestand.', flags: 64 }).catch(() => null);
      }
    });
    return;
  }

  if (interaction.isButton && interaction.isButton() && interaction.customId === 'inventory_refresh_dashboard') {
    await updateInventoryListMessage(interaction.guild).catch(error => console.error('INVENTORY_LIST_UPDATE_ERROR', error));
    await interaction.reply({ content: '✅ Dashboard wurde aktualisiert.', flags: 64 }).catch(() => null);
    return;
  }

  if (interaction.isButton && interaction.isButton() && interaction.customId === 'inventory_save_close') {
    await updateInventoryListMessage(interaction.guild).catch(error => console.error('INVENTORY_LIST_UPDATE_ERROR', error));
    await interaction.reply({ content: '✅ Gespeichert.', flags: 64 }).catch(() => null);
    return;
  }


  if (interaction.isButton?.() && interaction.customId === 'leader_abgabe_temp_shift') {
    try {
      if (!hasActionPermission(interaction.member, 'sanction_approve')) {
        await interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return;
      }
      await interaction.showModal(buildAbgabeTemporaryShiftModal());
    } catch (error) {
      console.error('ABGABE_TEMP_SHIFT_BUTTON_ERROR', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Fehler beim Öffnen der Verschiebung.', flags: 64 }).catch(() => null);
      }
    }
    return;
  }


  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      if ((interaction.commandName === 'wochenansehen' || interaction.commandName === 'abgabenachtragen') && focused.name === 'woche') {
        const choices = getWeekAutocompleteChoices(focused.value);
        return interaction.respond(choices).catch(() => null);
      }
      if (interaction.commandName === 'set' && focused.name === 'typ') {
        const q = String(focused.value || '').toLowerCase();
        const choices = CHANNEL_TYPE_CHOICES
          .filter(([value, name]) => !q || value.toLowerCase().includes(q) || name.toLowerCase().includes(q))
          .slice(0, 25)
          .map(([value, name]) => ({ name, value }));
        return interaction.respond(choices).catch(() => null);
      }
      return interaction.respond([]).catch(() => null);
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'clear') {
        if (!canUseClearCommand(interaction.member)) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const allMode = interaction.options.getBoolean('all') === true;
        const amount = interaction.options.getInteger('amount') || 100;
        if (!interaction.channel || typeof interaction.channel.bulkDelete !== 'function') {
          return interaction.reply({ content: 'Dieser Channel kann nicht geleert werden.', flags: 64 });
        }
        const label = allMode ? 'alle löschbaren Nachrichten' : `die letzten ${amount} Nachrichten`;
        return interaction.reply({
          content: `⚠️ Soll ich wirklich **${label}** in <#${interaction.channelId}> löschen?`,
          components: buildClearConfirmComponents(interaction.channelId, amount, allMode),
          flags: 64,
        });
      }
      if (interaction.commandName === 'setup-channels') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const channels = await setupChannels(interaction.guild);
        return interaction.reply({
          content: Object.entries(channels).map(([key, value]) => `${key}: <#${value.id}>`).join('\n'),
          flags: 64,
        });
      }
      if (interaction.commandName === 'ui-sync') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        await syncAllStoredMessages(interaction.guild);
        return interaction.editReply({ content: 'Gespeicherte Panels und öffentliche Bot-Nachrichten wurden synchronisiert.' });
      }
      if (interaction.commandName === 'panel') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const panelType = interaction.options.getString('typ') || 'verwaltung';
        if (panelType === 'verwaltung') return interaction.reply({ embeds: [buildVerwaltungEmbed()], components: buildVerwaltungComponents() });
        if (panelType === 'leader') return interaction.reply({ embeds: [buildLeaderPanelEmbed()], components: buildLeaderPanelComponents() });
        if (panelType === 'system') return interaction.reply({ embeds: [buildSystemPanelEmbed()], components: buildSystemPanelComponents() });
        if (panelType === 'admin') return interaction.reply({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() });
        if (panelType.startsWith('abgabe_')) {
          const type = panelType.replace('abgabe_', '');
          const channel = interaction.guild.channels.cache.get(store.config.channels[type]) || interaction.channel;
          await sendAbgabePanel(channel, type, interaction.guild);
          return interaction.reply({ content: `Abgabe-Panel für ${ABGABEN[type]?.label || type} gesendet.`, flags: 64 });
        }
        if (panelType === 'sanktionen') { await sendSanctionPanel(interaction.channel); return interaction.reply({ content: 'Sanktions-Panel gesendet.', flags: 64 }); }
        if (panelType === 'sanktionskatalog') { return interaction.reply({ embeds: buildSanctionCatalogPublicEmbeds(), components: [] }); }
        if (panelType === 'sanktionskatalog_admin') { return interaction.reply({ embeds: [buildSanctionCatalogManageEmbed()], components: buildSanctionCatalogDashboardComponents() }); }
        if (panelType === 'termine') { await sendTermPanel(interaction.channel); return interaction.reply({ content: 'Termin-Panel gesendet.', flags: 64 }); }
        if (panelType === 'termin_dashboard') {
          await safeDeferReply(interaction, { flags: 64 });
          const msg = await upsertTermDashboardMessage(interaction.guild, interaction.channel);
          return interaction.editReply({ content: msg ? 'Termin-Dashboard wurde erstellt/aktualisiert.' : 'Termin-Dashboard konnte nicht erstellt werden.' });
        }
        if (panelType === 'abmeldungen') { await sendAbsencePanel(interaction.channel); return interaction.reply({ content: 'Abmeldungs-Panel gesendet.', flags: 64 }); }
        if (panelType === 'dashboard') {
          store.config.channels.dashboard = interaction.channelId;
          await upsertStoredPanelMessage('dashboard', interaction.channel, { embeds: [await buildDashboardEmbed(interaction.guild)], components: buildMainDashboardComponents() }, { allowCreate: true });
          saveAll();
          return interaction.reply({ content: `Live-Dashboard in <#${interaction.channelId}> gesendet/aktualisiert.`, flags: 64 });
        }
        if (panelType === 'kasse') {
          store.config.channels.kasse = interaction.channelId;
          await upsertCashboxDashboardMessage(interaction.guild, interaction.channel);
          saveAll();
          return interaction.reply({ content: `Kassen-Dashboard in <#${interaction.channelId}> aktualisiert.`, flags: 64 });
        }
        if (panelType === 'lager_dashboard') {
          store.config.channels.lagerbestand = interaction.channelId;
          await updateInventoryListMessage(interaction.guild, true, interaction.channel).catch(() => null);
          await upsertCashboxDashboardMessage(interaction.guild, interaction.channel).catch(() => null);
          saveAll();
          return interaction.reply({ content: `Lager-Dashboard in <#${interaction.channelId}> gesendet/aktualisiert.`, flags: 64 });
        }
        if (panelType === 'lager_panel') return interaction.reply({ embeds: [buildInventoryPanelEmbed()], components: buildInventoryPanelComponents() });
        if (panelType === 'wache_panel') {
          await interaction.reply({ embeds: [buildWachePanelEmbed(interaction.guild)], components: buildWachePanelComponents() });
          await sendFreshWacheDashboardBelowPanel(interaction.guild, interaction.channel).catch(error => console.error('WACHE_DASHBOARD_PANEL_SEND_ERROR', error));
          return;
        }
        if (panelType === 'wache_dashboard') {
          await safeDeferReply(interaction, { flags: 64 });
          setWacheConfig({ dashboardChannelId: interaction.channelId });
          await upsertWacheDashboardMessage(interaction.guild, interaction.channel, true);
          return safeReplyOnce(interaction, { content: `Wache Live-Dashboard in <#${interaction.channelId}> gesendet/aktualisiert.` });
        }
        return interaction.reply({ content: 'Unbekanntes Panel.', flags: 64 });
      }
      if (interaction.commandName === 'setup-panel-abgabe') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const type = interaction.options.getString('typ', true);
        const channel = interaction.guild.channels.cache.get(store.config.channels[type]) || interaction.channel;
        await sendAbgabePanel(channel, type, interaction.guild);
        return interaction.reply({ content: `Abgabe-Panel für ${ABGABEN[type].label} gesendet.`, flags: 64 });
      }
      if (interaction.commandName === 'setup-panel-sanktionen') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await sendSanctionPanel(interaction.channel);
        return interaction.reply({ content: 'Sanktions-Panel gesendet.', flags: 64 });
      }
      if (interaction.commandName === 'setup-panel-termine') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await sendTermPanel(interaction.channel);
        return interaction.reply({ content: 'Termin-Panel gesendet.', flags: 64 });
      }
      if (interaction.commandName === 'termin-dashboard') {
        await safeDeferReply(interaction, { flags: 64 });
        const msg = await upsertTermDashboardMessage(interaction.guild, interaction.channel);
        if (!msg) return interaction.editReply({ content: 'Termin-Dashboard konnte nicht erstellt werden.' });
        return interaction.editReply({ content: 'Termin-Dashboard wurde erstellt/aktualisiert und aktualisiert sich automatisch.' });
      }
      if (interaction.commandName === 'setup-panel-abmeldungen') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await sendAbsencePanel(interaction.channel);
        return interaction.reply({ content: 'Abmeldungs-Panel gesendet.', flags: 64 });
      }
      if (interaction.commandName === 'setup-panel-dashboard') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        store.config.channels.dashboard = interaction.channelId;
        const result = await upsertStoredPanelMessage('dashboard', interaction.channel, { embeds: [await buildDashboardEmbed(interaction.guild)], components: buildMainDashboardComponents() }, { allowCreate: true });
        saveAll();
        return interaction.reply({ content: `Dashboard in <#${interaction.channelId}> gesendet oder aktualisiert.`, flags: 64 });
      }

      if (interaction.commandName === 'setup-panel-kasse') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const reportChannel = interaction.options.getChannel('bericht_kanal', false);
        store.config.channels.kasse = interaction.channelId;
        if (reportChannel) store.config.channels.kassenberichte = reportChannel.id;
        await upsertCashboxDashboardMessage(interaction.guild, interaction.channel);
        saveAll();
        return interaction.reply({ content: `Kassen-Dashboard in <#${interaction.channelId}> aktualisiert.${reportChannel ? ` Monatsberichte gehen nach <#${reportChannel.id}>.` : ''}`, flags: 64 });
      }
      if (interaction.commandName === 'setwarnkanal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const warnChannel = interaction.options.getChannel('kanal', false) || interaction.channel;
        const f = ensureFamilyWarehouseShape();
        f.minimumWarningChannelId = warnChannel.id;
        saveAll();
        await upsertCashboxDashboardMessage(interaction.guild).catch(() => null);
        return interaction.reply({ content: `✅ Mindestbestand-Warnkanal gesetzt: <#${warnChannel.id}>.`, flags: 64 });
      }
      if (interaction.commandName === 'kassenbericht') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const monthKey = interaction.options.getString('monat', false) || getMonthKey();
        if (!/^\d{4}-\d{2}$/.test(monthKey)) return interaction.reply({ content: 'Monat muss z. B. 2026-05 sein.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        store.config.channels.kassenberichte ||= interaction.channelId;
        const msg = await postCashboxMonthlyReport(monthKey, { force: true });
        return interaction.editReply({ content: msg ? `Kassenbericht für ${monthKey} wurde gepostet.` : `Kassenbericht für ${monthKey} konnte nicht gepostet werden. Prüfe den Kassenberichte-Kanal und Bot-Rechte.` });
      }
      if (interaction.commandName === 'abgaben-wochenreport') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const weekKey = interaction.options.getString('woche', false) || previousWeekKey(currentWeekKey());
        if (!/^\d{4}-W\d{2}$/.test(weekKey)) return interaction.reply({ content: 'Woche muss z. B. 2026-W12 sein.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const ok = await postManualWeeklyAbgabenReport(interaction.guild, interaction.channel, weekKey);
        return interaction.editReply({ content: ok ? `✅ Abgaben-Wochenreport für ${weekKey} wurde hier gepostet.` : `❌ Abgaben-Wochenreport für ${weekKey} konnte nicht gepostet werden.` });
      }
      if (interaction.commandName === 'abgaben-monatsreport') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const monthKey = interaction.options.getString('monat', false) || getMonthKey();
        if (!/^\d{4}-\d{2}$/.test(monthKey)) return interaction.reply({ content: 'Monat muss z. B. 2026-05 sein.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const ok = await postManualMonthlyAbgabenReport(interaction.guild, interaction.channel, monthKey);
        return interaction.editReply({ content: ok ? `✅ Abgaben-Monatsreport für ${monthKey} wurde hier gepostet.` : `❌ Abgaben-Monatsreport für ${monthKey} konnte nicht gepostet werden.` });
      }
      if (interaction.commandName === 'wochenansehen') {
        const weekKey = interaction.options.getString('woche', true);
        const privat = interaction.options.getBoolean('privat', true);
        const category = interaction.options.getString('kanal');
        await interaction.deferReply({ ephemeral: privat });
        const embeds = await buildStatusEmbeds(interaction.guild, weekKey, category || null);
        return interaction.editReply({ embeds });
      }
      if (interaction.commandName === 'abgabenachtragen') {
        if (!hasActionPermission(interaction.member, 'absence_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const member = interaction.options.getUser('mitglied', true);
        const category = interaction.options.getString('typ', true);
        const weekKey = interaction.options.getString('woche', true);
        const amount = interaction.options.getInteger('menge', true);
        applyAbgabe(member.id, category, amount, weekKey, interaction.user.id, 'zu_spaet', 'Manuell nachgetragen');
        await refreshAbgabeWeekAfterChange(interaction.guild, weekKey, category, 'manual-backfill');
        return interaction.reply({ content: `${member} wurde für ${ABGABEN[category].label} in ${weekKey} nachgetragen und die Statistik wurde aktualisiert.`, flags: 64 });
      }
      if (interaction.commandName === 'abmeldung-setzen') {
        if (!hasActionPermission(interaction.member, 'absence_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const member = interaction.options.getUser('mitglied', true);
        const days = interaction.options.getInteger('tage', true);
        const reason = interaction.options.getString('grund') || '';
        createAbsence(member.id, days, reason, interaction.user.id);
        markAbgabeExcusesForAbsence(interaction.guild, store.absences.items[store.absences.items.length - 1], interaction.user.id);
        await syncUserAcrossTerms(interaction.guild, member.id, { immediate: true });
        return interaction.reply({ content: `${member} ist jetzt ${days} Tage abgemeldet.`, flags: 64 });
      }
      if (interaction.commandName === 'abmeldung-loeschen') {
        if (!hasActionPermission(interaction.member, 'absence_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const member = interaction.options.getUser('mitglied', true);
        const result = removeActiveAbsence(member.id);
        if (result.changed && result.removedItems?.length) recordRollbackAction({ kind: 'absence_removed', userId: member.id, absenceIds: result.removedItems.map(item => item.id) });
        if (result.changed) {
          reopenCurrentWeekAbgabenIfNeeded(interaction.guild, member.id, interaction.user.id);
          await syncUserAcrossTerms(interaction.guild, member.id, { immediate: true });
        }
        return interaction.reply({ content: result.changed ? `Abmeldung von ${member} entfernt.` : 'Keine aktive Abmeldung gefunden.', flags: 64 });
      }
      if (interaction.commandName === 'abmeldungen') {
        cleanupAbsences();
        const active = store.absences.items.filter(item => item.active);
        return interaction.reply({
          content: active.length
            ? active.map(item => `<@${item.userId}> bis ${formatDateTime(item.untilTs)}${item.appliesTo === 'term_only' ? ' | nur Termin heute' : ''}${item.reason ? ` — ${item.reason}` : ''}`).join('\n')
            : 'Keine aktiven Abmeldungen.',
          flags: 64,
        });
      }
      
      
      if (interaction.commandName === 'lager-dashboard') {
        if (!hasActionPermission(interaction.member, 'config_manage')) {
          return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        }

        const msg = await interaction.channel.send({ embeds: [buildInventoryListEmbed(interaction.guild)] });
        ensureInventoryShape();
        store.inventory.listMessage = { channelId: interaction.channel.id, messageId: msg.id, updatedAt: now() };
        store.config.channels.lagerbestand = interaction.channel.id;
        saveAll();

        await interaction.reply({ content: '✅ Lagerbestand-Dashboard wurde hier gepostet und wird ab jetzt automatisch aktualisiert.', flags: 64 });
        return;
      }
      
      if (interaction.commandName === 'lager-panel') {
        if (!hasActionPermission(interaction.member, 'config_manage')) {
          return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        }
        await interaction.reply({ embeds: [buildInventoryPanelEmbed()], components: buildInventoryPanelComponents() });
        return;
      }

      if (interaction.commandName === 'lagerbestand-loeschen') {
        if (!hasActionPermission(interaction.member, 'config_manage')) {
          return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        }
        const member = interaction.options.getUser('mitglied', true);
        const reason = interaction.options.getString('grund') || 'Manuell gelöscht';
        const result = await removeInventoryEntry(interaction.guild, member.id, interaction.user.id, reason);
        return interaction.reply({ content: result.changed ? `✅ Lagerbestand von ${member} wurde entfernt.` : `ℹ️ ${result.message}`, flags: 64 });
      }
      
      if (interaction.commandName === 'set') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'kanal') {
          if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
          const type = interaction.options.getString('typ', true);
          const channel = interaction.options.getChannel('kanal', true);
          if (type === 'minimum_warning') {
            const f = ensureFamilyWarehouseShape();
            f.minimumWarningChannelId = channel.id;
            saveAll();
            await upsertCashboxDashboardMessage(interaction.guild).catch(() => null);
            return interaction.reply({ content: `✅ Mindestbestand-Warnkanal gesetzt: <#${channel.id}>.`, flags: 64 });
          }
          store.config.channels ||= {};
          store.config.channels[type] = channel.id;
          saveAll();
          if (type === 'lagerbestand') await updateInventoryListMessage(interaction.guild).catch(() => null);
          if (type === 'kasse') await upsertCashboxDashboardMessage(interaction.guild, channel).catch(() => null);
          if (['public_link','verify','welcome','phone_list','family_list','phonebook'].includes(type)) {
            await interaction.reply({ content: `✅ Kanal gesetzt: **${getChannelTypeLabel(type)}** → <#${channel.id}>.\nNutze danach bei Bedarf das passende Panel-Kommando erneut, z. B. **/verify-panel**, **/telefonliste**, **/telefonbuch** oder **/familienpanel**.`, flags: 64 });
            return;
          }
          return interaction.reply({ content: `Kanal gesetzt: **${getChannelTypeLabel(type)}** → <#${channel.id}>`, flags: 64 });
        }
        if (sub === 'berechtigung') {
          if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
          const type = interaction.options.getString('typ', true);
          const role = interaction.options.getRole('rolle', true);
          store.config.roles.permissions[type] = [role.id];
          saveAll();
          return interaction.reply({ content: `Berechtigung ${type} gesetzt: <@&${role.id}>`, flags: 64 });
        }
        if (sub === 'dryrun') {
          if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
          store.config.settings.dryRunEnabled = interaction.options.getString('status', true) === 'on';
          saveAll();
          return interaction.reply({ content: `Dry-Run ist jetzt ${store.config.settings.dryRunEnabled ? 'AN' : 'AUS'}.`, flags: 64 });
        }
      }

      if (interaction.commandName === 'bericht') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const type = interaction.options.getString('typ', true);
        const monthKey = interaction.options.getString('monat', false) || getMonthKey();
        if (!/^\d{4}-\d{2}$/.test(monthKey)) return interaction.reply({ content: 'Monat muss z. B. 2026-05 sein.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        if (type === 'kasse') {
          store.config.channels.kassenberichte ||= interaction.channelId;
          const msg = await postCashboxMonthlyReport(monthKey, { force: true });
          return interaction.editReply({ content: msg ? `Kassenbericht für ${monthKey} wurde gepostet.` : `Kassenbericht für ${monthKey} konnte nicht gepostet werden. Prüfe den Kassenberichte-Kanal und Bot-Rechte.` });
        }
        if (type === 'lager') {
          store.config.channels.lagerberichte ||= interaction.channelId;
          const msg = await postWarehouseMonthlyReport(monthKey, { force: true });
          return interaction.editReply({ content: msg ? `Lagerbericht für ${monthKey} wurde gepostet.` : `Lagerbericht für ${monthKey} konnte nicht gepostet werden. Prüfe den Lagerberichte-Kanal und Bot-Rechte.` });
        }
        return interaction.editReply({ content: 'Unbekannter Berichtstyp.' });
      }

      if (interaction.commandName === 'set-kanal') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const type = interaction.options.getString('typ', true);
        const input = interaction.options.getString('kanal', true);
        const channel = resolveChannelByInput(interaction.guild, input);
        if (!channel) return interaction.reply({ content: 'Kanal nicht gefunden.', flags: 64 });
        store.config.channels[type] = channel.id;
        saveAll();
        if (type === 'lagerbestand') await updateInventoryListMessage(interaction.guild).catch(() => null);
        return interaction.reply({ content: `Kanal gesetzt: **${getChannelTypeLabel(type)}** → <#${channel.id}>`, flags: 64 });
      }
      if (interaction.commandName === 'set-berechtigung') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const type = interaction.options.getString('typ', true);
        const role = resolveRoleByInput(interaction.guild, interaction.options.getString('rolle', true));
        if (!role) return interaction.reply({ content: 'Rolle nicht gefunden.', flags: 64 });
        store.config.roles.permissions[type] = [role.id];
        saveAll();
        return interaction.reply({ content: `Berechtigung ${type} gesetzt: <@&${role.id}>`, flags: 64 });
      }
      if (interaction.commandName === 'dry-run') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        store.config.settings.dryRunEnabled = interaction.options.getString('status', true) === 'true';
        saveAll();
        return interaction.reply({ content: `Dry-Run ist jetzt ${store.config.settings.dryRunEnabled ? 'AN' : 'AUS'}.`, flags: 64 });
      }
      if (interaction.commandName === 'sicherheitsliste') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const listKey = interaction.options.getString('liste', true);
        const action = interaction.options.getString('aktion', true);
        const member = interaction.options.getUser('mitglied');
        if (action === 'show') {
          const ids = store.config.safety?.[listKey] || [];
          return interaction.reply({ content: ids.length ? ids.map(id => `<@${id}>`).join('\n').slice(0, 1900) : 'Liste ist leer.', flags: 64 });
        }
        if (!member) return interaction.reply({ content: 'Bitte ein Mitglied angeben.', flags: 64 });
        const changed = action === 'add' ? addSafetyListUser(listKey, member.id) : removeSafetyListUser(listKey, member.id);
        return interaction.reply({ content: changed ? `${member} wurde aktualisiert.` : 'Keine Änderung nötig.', flags: 64 });
      }
      if (interaction.commandName === 'rollback-letzte') {
        if (!hasActionPermission(interaction.member, 'rollback_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const requestedId = interaction.options.getString('id');
        const candidate = requestedId ? getRollbackActionById(requestedId) : (store.sessions.rollbackStack || []).slice().reverse().find(item => !item.used && Number(item.expiresAt || 0) > now());
        if (!candidate) return interaction.reply({ content: 'Kein offener Rollback gefunden.', flags: 64 });
        const result = await applyRollbackAction(interaction.guild, candidate.id, interaction.user.id);
        return interaction.reply({ content: result.message, flags: 64 });
      }
      if (interaction.commandName === 'abgabe-umschalten') {
        if (!hasActionPermission(interaction.member, 'config_manage')) {
          return safeReplyOnce(interaction, { content: 'Keine Berechtigung.', flags: 64 });
        }
        await safeDeferReply(interaction, { flags: 64 });
        const type = interaction.options.getString('typ', true);
        const status = interaction.options.getString('status', true);
        ensureAbgabenEnabledConfig();
        store.config.settings.abgabenEnabled[type] = status === 'on';
        saveAll();
        await syncAllStoredMessages(interaction.guild).catch(() => null);
        return safeReplyOnce(interaction, {
          embeds: [new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle('📦 Abgabeart aktualisiert')
            .setDescription(`${ABGABEN[type]?.label || type} ist jetzt **${status === 'on' ? 'aktiv' : 'deaktiviert'}**.`)
            .addFields(
              { name: 'Aktive Abgaben', value: getEnabledAbgabeKeys().map(key => `• ${ABGABEN[key].label}`).join('\n') || '—' }
            )],
          flags: 64
        });
      }
      if (interaction.commandName === 'wache-panel') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.reply({ embeds: [buildWachePanelEmbed(interaction.guild)], components: buildWachePanelComponents() });
        await sendFreshWacheDashboardBelowPanel(interaction.guild, interaction.channel).catch(error => console.error('WACHE_DASHBOARD_PANEL_SEND_ERROR', error));
        return;
      }
      if (interaction.commandName === 'setup-panel-wache') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        setWacheConfig({ dashboardChannelId: interaction.channelId });
        await upsertWacheDashboardMessage(interaction.guild, interaction.channel, true);
        return safeReplyOnce(interaction, { content: `Wache Live-Dashboard in <#${interaction.channelId}> gesendet/aktualisiert.` });
      }
      if (interaction.commandName === 'wache-status') {
        await safeDeferReply(interaction, { flags: 64 });
        await upsertWacheStatusMessage(interaction.guild, interaction.channel, currentWeekKey());
        return safeReplyOnce(interaction, { content: '✅ Wache-Status wurde aktualisiert.' });
      }
      if (interaction.commandName === 'wache-config') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        const status = interaction.options.getString('status');
        setWacheConfig({
          enabled: status ? status === 'on' : undefined,
          requiredMinutesPerWeek: interaction.options.getInteger('minuten') ?? undefined,
          absenceExcuseDays: interaction.options.getInteger('abmeldetage') ?? undefined,
          sessionMinutes: interaction.options.getInteger('autoende') ?? undefined,
          maxParticipants: interaction.options.getInteger('plaetze') ?? undefined,
          sanctionAmount: interaction.options.getInteger('sanktion') ?? undefined,
          dashboardChannelId: interaction.options.getChannel('dashboard_kanal')?.id ?? undefined,
          reportChannelId: interaction.options.getChannel('bericht_kanal')?.id ?? undefined,
        });
        const reply = await safeReplyOnce(interaction, { content: '✅ Wache-Konfiguration gespeichert. Updates laufen im Hintergrund.', embeds: [buildWachePanelEmbed(interaction.guild)], components: buildWachePanelComponents() });
        runBackgroundDiscordTask(interaction.guild, 'WACHE_CONFIG_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
        });
        return reply;
      }
      if (interaction.commandName === 'abgabe-config') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const type = interaction.options.getString('typ', true);
        const statusRaw = interaction.options.getString('status');
        const amount = interaction.options.getInteger('menge');
        const day = interaction.options.getInteger('tag');
        const timeRaw = interaction.options.getString('uhrzeit');
        const changes = {};
        if (statusRaw) changes.enabled = statusRaw === 'on';
        if (amount != null) changes.amount = amount;
        if (day != null) changes.deadlineDay = day;
        if (timeRaw) {
          const parsed = parseAbgabeTime(timeRaw);
          if (!parsed) return interaction.reply({ content: 'Ungültige Uhrzeit. Nutze HH:MM, z.B. 23:59.', flags: 64 });
          changes.deadlineHour = parsed.hour;
          changes.deadlineMinute = parsed.minute;
        }
        try {
          setAbgabeRuntimeConfig(type, changes);
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
        await syncAllStoredMessages(interaction.guild).catch(() => null);
        return interaction.reply({ embeds: [buildAbgabeConfigEmbed()], components: buildAbgabeConfigComponents(), flags: 64 });
      }
      if (interaction.commandName === 'sanktion') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = uid('sanpick');
        store.sessions.memberPickers[sessionId] = { page: 0, type: 'sanction' };
        saveAll();
        return interaction.reply({ ...buildMemberPickerResponse(interaction.guild, sessionId, 0, 'sanction'), flags: 64 });
      }
      if (interaction.commandName === 'sanktionskatalog') {
        return interaction.reply({ embeds: buildSanctionCatalogPublicEmbeds(), components: [] });
      }
      if (interaction.commandName === 'sanktionskatalog-set') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        try {
          const no = setSanctionCatalogEntry(interaction.options.getString('nummer', true), interaction.options.getString('text', true), interaction.user.id);
          return interaction.reply({ content: `Katalogeintrag **${no}** wurde gespeichert.`, embeds: [buildRulesOverviewEmbed()], flags: 64 });
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
      }
      if (interaction.commandName === 'sanktionskatalog-loeschen') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const noRaw = interaction.options.getString('nummer', true);
        const ok = removeSanctionCatalogEntry(noRaw, interaction.user.id);
        return interaction.reply({ content: ok ? `Katalogeintrag **${String(noRaw).padStart(2,'0')}** wurde abgesagt und bleibt als abgesagt sichtbar.` : 'Eintrag nicht gefunden.', embeds: [buildRulesOverviewEmbed()], flags: 64 });
      }
      if (interaction.commandName === 'regel-config') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const ruleKey = interaction.options.getString('regel', true);
        const status = interaction.options.getString('status');
        const changes = {};
        if (status) changes.enabled = status === 'on';
        const tage = interaction.options.getInteger('tage');
        if (tage != null) {
          if (ruleKey === 'abgabeAutoSanction') changes.overdueDays = tage;
          else if (ruleKey === 'sanctionEscalation') changes.dueDays = tage;
        }
        const bloodoutTage = interaction.options.getInteger('bloodout_tage');
        if (bloodoutTage != null) changes.bloodoutAfterSurchargeDays = bloodoutTage;
        const betrag = interaction.options.getInteger('betrag');
        if (betrag != null) {
          if (ruleKey === 'sanctionEscalation') changes.surchargeAmount = betrag;
          else changes.amount = betrag;
        }
        const katalog = interaction.options.getString('katalog');
        if (katalog) changes.catalogNo = katalog;
        const strafart = interaction.options.getString('strafart');
        if (strafart) changes.penaltyType = strafart;
        try {
          setRuleConfig(ruleKey, changes, interaction.user.id);
          return interaction.reply({ content: 'Regel gespeichert.', embeds: [buildRulesOverviewEmbed()], flags: 64 });
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
      }
      if (interaction.commandName === 'offene-sanktionen') {
        const open = store.sanctions.items.filter(item => !item.paid && item.status !== 'bezahlt').sort((a, b) => b.createdAt - a.createdAt);
        if (!open.length) return interaction.reply({ content: 'Keine offenen Sanktionen.', flags: 64 });
        const lines = open.slice(0, 40).map(item => `• <@${item.userId}> | ${item.catalogNo} | ${item.penaltyType} | ${item.penaltyType === 'Grüngeld' || item.penaltyType === 'Schwarzgeld' ? formatCurrency(item.amount) : item.amount} | Status: ${item.status} | Fällig: ${item.dueAt ? formatDateTime(item.dueAt) : '—'}`);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Offene Sanktionen').setDescription(lines.join('\n').slice(0, 4000))], flags: 64 });
      }
      if (interaction.commandName === 'leader-dm') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung. DM-Einstellungen sind nur im Admin-Panel/Admin-Recht verfügbar.', flags: 64 });
        ensureConfigShape();
        const key = interaction.options.getString('bereich', true);
        const status = interaction.options.getString('status', true) === 'true';
        store.config.settings[key] = status;
        saveAll();
        const labels = {
          leaderReminderDmEnabled: 'Leader-DM-Erinnerungen für Sanktionen',
          fridayMissingReportEnabled: 'Freitagsliste',
          mondayOverdueReportEnabled: 'Montagsliste',
        };
        return interaction.reply({ content: `${labels[key] || key} ist jetzt **${status ? 'aktiviert' : 'deaktiviert'}**.`, flags: 64 });
      }
    }
    if (interaction.isStringSelectMenu()) {

      if (interaction.customId === 'members_dashboard_select' || interaction.customId.startsWith('members_dashboard_select:')) {
        if (!hasActionPermission(interaction.member, 'dashboard_view')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const userId = interaction.values?.[0];
        if (!userId) return interaction.reply({ content: 'Kein Mitglied ausgewählt.', flags: 64 });
        const page = interaction.customId.includes(':') ? Math.max(0, Number(interaction.customId.split(':')[1] || 0)) : 0;
        return interaction.update({ embeds: [buildMemberAnalysisEmbed(interaction.guild, userId)], components: buildMembersDashboardComponents(interaction.guild, page) });
      }
      if (interaction.customId === 'leader_abgabe_config_select') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const category = interaction.values[0];
        return interaction.showModal(buildAbgabeConfigModal(category));
      }
      if (interaction.customId.startsWith('leader_attendance_term:')) {
        const sessionId = interaction.customId.split(':')[1];
        const session = store.sessions.attendanceLaunchers?.[sessionId];
        if (!session || session.userId !== interaction.user.id) return interaction.update({ content: 'Diese Auswahl ist nicht mehr gültig.', embeds: [], components: [] });
        if (!hasLeadership(interaction.member)) return interaction.update({ content: 'Keine Berechtigung.', embeds: [], components: [] });
        const termId = interaction.values[0];
        const term = (store.terms.items || []).find(item => item.id === termId && item.kind === 'term');
        if (!term) return interaction.update({ content: 'Termin nicht gefunden.', embeds: [], components: [] });
        try {
          const check = await createAttendanceCheck(interaction.guild, term, interaction.user.id);
          delete store.sessions.attendanceLaunchers[sessionId];
          saveAll();
          return interaction.update({ content: `Anwesenheitscheck erstellt: <#${check.channelId}>`, embeds: [], components: [] });
        } catch (error) {
          return interaction.update({ content: `Fehler: ${error.message || error}`, embeds: [], components: [] });
        }
      }
      if (interaction.customId.startsWith('attendance_pick:')) {
        const checkId = interaction.customId.split(':')[1];
        const check = store.sessions.attendanceChecks?.[checkId];
        if (!check || check.closed) return interaction.reply({ content: 'Dieser Anwesenheitscheck ist nicht mehr aktiv.', flags: 64 });
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const userId = interaction.values[0];
        if (userId === 'none' || !check.pendingUserIds.includes(userId)) return interaction.reply({ content: 'Bitte ein offenes Mitglied auswählen.', flags: 64 });
        check.selectedUserId = userId;
        saveAll();
        await updateAttendanceCheckMessage(interaction.guild, check);
        return interaction.reply({ content: `${getUserDisplay(interaction.guild, userId)} wurde ausgewählt. Jetzt Status setzen.`, flags: 64 });
      }
      if (interaction.customId === 'absence_self') {
        const days = Number(interaction.values[0]);
        const sessionId = uid('absform');
        store.sessions.absenceForms[sessionId] = { days, type: 'days' };
        saveAll();
        const modal = new ModalBuilder()
          .setCustomId(`absence_days_modal:${sessionId}`)
          .setTitle(`Abmeldung für ${days} ${days === 1 ? 'Tag' : 'Tage'}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Optionaler Grund')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
            )
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId.startsWith('abgabe_select:')) {
        const sessionId = interaction.customId.split(':')[1];
        const state = store.sessions.abgabePanels[sessionId];
        if (!state) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        if (interaction.values[0] === 'none') return interaction.reply({ content: 'Keine Auswahl möglich.', flags: 64 });
        state.selectedUserId = interaction.values[0];
        saveAll();
        return interaction.update(buildAbgabePanelComponents(interaction.guild, state.category, state.page, state.selectedUserId));
      }
      if (interaction.customId.startsWith('pending_approvals_select:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = interaction.customId.split(':')[1];
        const state = store.sessions.pendingApprovalPanel?.[sessionId] || { page: 0 };
        state.selectedId = interaction.values?.[0] || '';
        store.sessions.pendingApprovalPanel ||= {};
        store.sessions.pendingApprovalPanel[sessionId] = state;
        saveAll();
        return interaction.update(buildLeaderPendingApprovalsView(interaction.guild, sessionId, state.page || 0, state.selectedId));
      }
      if (interaction.customId.startsWith('open_sanctions_select:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = interaction.customId.split(':')[1];
        ensureOpenSanctionsSessionShape();
        const state = store.sessions.openSanctions[sessionId] || { page: 0 };
        state.selectedId = interaction.values?.[0] || '';
        store.sessions.openSanctions[sessionId] = state;
        saveAll();
        return interaction.update(buildLeaderOpenSanctionsView(interaction.guild, sessionId, state.page || 0, state.selectedId));
      }
      if (interaction.customId.startsWith('sanction_pick:')) {
        const memberId = interaction.values[0];
        if (memberId === 'none') return interaction.reply({ content: 'Keine Auswahl möglich.', flags: 64 });
        const member = await interaction.guild.members.fetch(memberId);
        const modal = new ModalBuilder()
          .setCustomId(`sanction_modal:${memberId}`)
          .setTitle(`Sanktion für ${member.displayName}`)
          .addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('catalogNo').setLabel('Katalognummer').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('penaltyType').setLabel('Strafart').setPlaceholder('Grüngeld, Schwarzgeld, Eisen, Schwefel, Meth, Bloodout').setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Menge / Betrag').setStyle(TextInputStyle.Short).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Optionaler Grund').setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('extraDays').setLabel('Optionale Zusatz-Tage').setStyle(TextInputStyle.Short).setRequired(false)),
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId.startsWith('sanction_paid_pick:')) {
        const sanctionId = interaction.values[0];
        if (sanctionId === 'none') return interaction.reply({ content: 'Keine offenen Sanktionen vorhanden.', flags: 64 });
        const sanction = markSanctionPaid(sanctionId, interaction.user.id);
        if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
        return interaction.reply({ content: `Sanktion für <@${sanction.userId}> wurde als bezahlt markiert.`, flags: 64 });
      }
      if (interaction.customId === 'term_delete_select') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        const termId = interaction.values?.[0];
        const deleted = await deleteTermOrVoteById(interaction.guild, termId, interaction.user.id);
        if (!deleted) return interaction.editReply({ content: 'Eintrag nicht gefunden oder bereits abgesagt.', embeds: [], components: [] });
        return interaction.editReply({ content: `✅ ${deleted.kind === 'vote' ? 'Abstimmung' : 'Termin'} **${deleted.title || 'Ohne Titel'}** wurde abgesagt und bleibt als abgesagt sichtbar.`, embeds: [], components: [] });
      }
      if (interaction.customId.startsWith('term_type_select:')) {
        const sessionId = interaction.customId.split(':')[1];
        store.sessions.termBuilders[sessionId] ||= {};
        store.sessions.termBuilders[sessionId].type = interaction.values[0];
        saveAll();
        const select = new StringSelectMenuBuilder()
          .setCustomId(`term_date_select:${sessionId}`)
          .setPlaceholder('Datum wählen')
          .addOptions(twoWeeksDateOptions().map(date => ({ label: date, value: date })));
        return interaction.update({
          embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Datum wählen').setDescription(`Gewählt: ${interaction.values[0]}`)],
          components: [new ActionRowBuilder().addComponents(select)],
        });
      }
      if (interaction.customId.startsWith('term_date_select:')) {
        const sessionId = interaction.customId.split(':')[1];
        store.sessions.termBuilders[sessionId] ||= {};
        store.sessions.termBuilders[sessionId].date = interaction.values[0];
        saveAll();
        return interaction.update({
          embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Uhrzeit wählen').setDescription(`Datum: ${interaction.values[0]}`)],
          components: [
            new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`term_time1_select:${sessionId}`).setPlaceholder('16:00 bis 22:00').addOptions(timeOptionsOne().map(time => ({ label: time, value: time })))),
            new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`term_time2_select:${sessionId}`).setPlaceholder('22:15 bis 00:00').addOptions(timeOptionsTwo().map(time => ({ label: time, value: time })))),
          ],
        });
      }
      if (interaction.customId.startsWith('term_time1_select:') || interaction.customId.startsWith('term_time2_select:')) {
        const sessionId = interaction.customId.split(':')[1];
        const builder = store.sessions.termBuilders[sessionId];
        if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        builder.time = interaction.values[0];
        saveAll();
        return interaction.update(buildTermRequirementSelectPayload(sessionId, builder));
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'verwaltung_back') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildVerwaltungEmbed()], components: buildVerwaltungComponents() });
      }
      if (interaction.customId === 'verwaltung_open_leader') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildLeaderPanelEmbed(interaction.guild)], components: buildLeaderPanelComponents() });
      }
      if (interaction.customId === 'verwaltung_open_system') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildSystemPanelEmbed()], components: buildSystemPanelComponents() });
      }
      if (interaction.customId === 'verwaltung_open_admin') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() });
      }
      if (interaction.customId === 'systempanel_refresh' || interaction.customId === 'systempanel_back') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildSystemPanelEmbed()], components: buildSystemPanelComponents() });
      }
      if (interaction.customId === 'systempanel_abgaben') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.reply({ embeds: [buildAbgabeConfigEmbed()], components: buildAbgabeConfigComponents(), flags: 64 });
      }
      if (interaction.customId === 'systempanel_rules') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildRulesOverviewEmbed()], components: buildRulesManagementComponents() });
      }
      if (interaction.customId === 'rules_edit_abgabe') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildRuleAbgabeModal());
      }
      if (interaction.customId === 'rules_edit_term') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildRuleTermModal());
      }
      if (interaction.customId === 'rules_edit_escalation') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildRuleEscalationModal());
      }
      if (interaction.customId === 'rules_catalog_dashboard') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildSanctionCatalogDashboardEmbed()], components: buildSanctionCatalogDashboardComponents() });
      }
      if (interaction.customId === 'rules_catalog_public') {
        return interaction.reply({ embeds: buildSanctionCatalogPublicEmbeds(), components: [] });
      }
      if (interaction.customId === 'rules_catalog_set') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildCatalogSetModal());
      }
      if (interaction.customId === 'rules_catalog_delete') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildCatalogDeleteModal());
      }
      if (interaction.customId === 'systempanel_reminders') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildReminderSettingsEmbed()], components: buildReminderSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_smartping') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildSmartPingSettingsEmbed()], components: buildSmartPingSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_dms') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildDmSystemSettingsEmbed()], components: buildDmSystemSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_automations') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildAutomationSettingsEmbed()], components: buildAutomationSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_cashbox') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildCashboxSystemSettingsEmbed()], components: buildCashboxSystemSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_warehouse') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildWarehouseSystemSettingsEmbed()], components: buildWarehouseSystemSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_wache') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.reply({ embeds: [buildWachePanelEmbed(interaction.guild)], components: buildWachePanelComponents(), flags: 64 });
      }
      if (interaction.customId === 'systempanel_security') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() });
      }
      if (interaction.customId === 'systempanel_reminder_toggle') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const cfg = getSystemControlConfig().reminders;
        setSystemReminderConfig({ enabled: !cfg.enabled }, interaction.user.id);
        return interaction.update({ embeds: [buildReminderSettingsEmbed()], components: buildReminderSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_reminder_edit') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildReminderConfigModal());
      }
      if (interaction.customId === 'systempanel_smartping_toggle') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const cfg = getSystemControlConfig().smartPing;
        setSystemSmartPingConfig({ enabled: !cfg.enabled }, interaction.user.id);
        return interaction.update({ embeds: [buildSmartPingSettingsEmbed()], components: buildSmartPingSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_smartping_edit') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildSmartPingConfigModal());
      }
      if (interaction.customId === 'systempanel_dms_toggle') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const cfg = getSystemDmSettings();
        setSystemDmSettings({ enabled: cfg.enabled === false }, interaction.user.id);
        return interaction.update({ embeds: [buildDmSystemSettingsEmbed()], components: buildDmSystemSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_dms_edit') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildDmSystemConfigModal());
      }
      if (interaction.customId === 'systempanel_automations_toggle') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const cfg = getSystemControlConfig().automations;
        setSystemAutomationConfig({ enabled: !cfg.enabled }, interaction.user.id);
        return interaction.update({ embeds: [buildAutomationSettingsEmbed()], components: buildAutomationSettingsComponents() });
      }
      if (interaction.customId === 'systempanel_automations_edit') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildAutomationConfigModal());
      }
      if (interaction.customId === 'systempanel_cashbox_report_toggle') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const cfg = getSystemControlConfig().automations;
        setSystemAutomationConfig({ cashboxMonthlyReports: !cfg.cashboxMonthlyReports }, interaction.user.id);
        return interaction.update({ embeds: [buildCashboxSystemSettingsEmbed()], components: buildCashboxSystemSettingsComponents() });
      }
      if (interaction.customId === 'leader_leadership_duties_toggle') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        toggleLeadershipDutiesEnabled();
        await interaction.update({ embeds: [buildLeaderPanelEmbed(interaction.guild)], components: buildLeaderPanelComponents() }).catch(() => null);
        runBackgroundDiscordTask(interaction.guild, 'LEADERSHIP_DUTIES_TOGGLE_SYNC', async () => {
          await upsertDashboardMessage(interaction.guild).catch(() => null);
          await upsertWacheDashboardMessage(interaction.guild, null, true).catch(() => null);
        });
        return;
      }
      if (interaction.customId === 'leader_wache_config') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        return refreshWacheLeaderConfigInteraction(interaction);
      }
      if (interaction.customId === 'wache_cfg_toggle') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        const cfg = getWacheConfig();
        setWacheConfig({ enabled: !cfg.enabled });
        const reply = await refreshWacheLeaderConfigInteraction(interaction, `Wache wurde **${!cfg.enabled ? 'aktiviert' : 'deaktiviert'}**. Updates laufen im Hintergrund.`);
        runBackgroundDiscordTask(interaction.guild, 'WACHE_TOGGLE_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
          await upsertWacheDashboardMessage(interaction.guild, null, true).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId === 'wache_cfg_refresh') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        return refreshWacheLeaderConfigInteraction(interaction);
      }
      if (interaction.customId === 'wache_cfg_values') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildWacheValuesModal());
      }
      if (interaction.customId === 'wache_cfg_window') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildWacheWindowModal());
      }
      if (interaction.customId === 'wache_cfg_leadership_duties') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        ensureConfigShape();
        toggleLeadershipDutiesEnabled();
        return refreshWacheLeaderConfigInteraction(interaction, `Leaderschaft-Pflichten sind jetzt **${areLeadershipDutiesEnabled() ? 'AN' : 'AUS'}**.`);
      }
      if (interaction.customId === 'wache_cfg_channels') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildWacheChannelsModal());
      }
      if (interaction.customId === 'wache_config_open') {
        return interaction.reply({ content: 'Wache-Einstellungen sind nur im Leader Panel verfügbar. Dieses öffentliche Panel ist veraltet – bitte mit `/wache-panel` neu senden oder die alte Nachricht löschen.', flags: 64 });
      }
      if (interaction.customId === 'wache_start') {
        await safeDeferReply(interaction, { flags: 64 });
        const result = await startOrJoinWache(interaction.guild, interaction.user.id, true);
        await upsertDashboardMessage(interaction.guild).catch(() => null);
        await upsertWacheDashboardMessage(interaction.guild).catch(() => null);
        return safeReplyOnce(interaction, { content: result.message });
      }
      if (interaction.customId === 'wache_join') {
        await safeDeferReply(interaction, { flags: 64 });
        const result = await startOrJoinWache(interaction.guild, interaction.user.id, false);
        await upsertDashboardMessage(interaction.guild).catch(() => null);
        await upsertWacheDashboardMessage(interaction.guild).catch(() => null);
        return safeReplyOnce(interaction, { content: result.message });
      }
      if (interaction.customId === 'wache_stop') {
        await safeDeferReply(interaction, { flags: 64 });
        const result = await stopWacheForUser(interaction.user.id, 'stop');
        await upsertDashboardMessage(interaction.guild).catch(() => null);
        await upsertWacheDashboardMessage(interaction.guild).catch(() => null);
        return safeReplyOnce(interaction, { content: result.message });
      }
      if (interaction.customId === 'wache_status') {
        await safeDeferReply(interaction, { flags: 64 });
        return safeReplyOnce(interaction, {
          content: '✅ Hier ist dein Wache-Status. Diese Nachricht siehst nur du.',
          embeds: [await buildWacheStatusEmbed(interaction.guild, currentWeekKey())],
        });
      }

      if (interaction.customId === 'dashboard_members_open') {
        if (!hasActionPermission(interaction.member, 'dashboard_view')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        await upsertMembersDashboardMessage(interaction.guild, interaction.channel);
        return interaction.editReply({ content: 'Erweitertes Mitglieder-Dashboard wurde erstellt/aktualisiert.' });
      }
      if (interaction.customId === 'dashboard_refresh_now') {
        if (!hasActionPermission(interaction.member, 'dashboard_view')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        invalidateStatsCache('manual_dashboard_refresh');
        await upsertDashboardMessage(interaction.guild, { force: true });
        return interaction.editReply({ content: 'Dashboard wurde aktualisiert.' });
      }
      if (interaction.customId.startsWith('members_dashboard_page:')) {
        if (!hasActionPermission(interaction.member, 'dashboard_view')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const parts = interaction.customId.split(':');
        const page = Math.max(0, Number(parts[2] || 0));
        await ensureGuildMembersCached(interaction.guild);
        return interaction.update({ embeds: [await buildMembersDashboardEmbed(interaction.guild)], components: buildMembersDashboardComponents(interaction.guild, page) });
      }
      if (interaction.customId.startsWith('members_dashboard_back')) {
        if (!hasActionPermission(interaction.member, 'dashboard_view')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const page = Math.max(0, Number(interaction.customId.split(':')[1] || 0));
        await ensureGuildMembersCached(interaction.guild);
        return interaction.update({ embeds: [await buildMembersDashboardEmbed(interaction.guild)], components: buildMembersDashboardComponents(interaction.guild, page) });
      }
      if (interaction.customId === 'leader_abgabe_config') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.reply({ embeds: [buildAbgabeConfigEmbed()], components: buildAbgabeConfigComponents(), flags: 64 });
      }
      if (interaction.customId === 'leader_refresh_dashboard') {
        await interaction.deferReply({ flags: 64 });
        await upsertDashboardMessage(interaction.guild);
        await sendLeaderPanel(interaction.channel, interaction.guild);
        return interaction.editReply({ content: 'Dashboard und Leader Panel wurden aktualisiert.' });
      }
      if (interaction.customId === 'leader_reports_preview') {
        await interaction.deferReply({ flags: 64 });
        const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('📘 Report-Vorschau').setDescription('Wochen- und Monatsreports sind optisch überarbeitet und werden automatisch im Statistik-Kanal gepostet.').addFields(
          buildInfoField('Wochenreport', ['Top zuverlässig', 'Auffällige Mitglieder', 'Stress-Level'], true),
          buildInfoField('Monatsreport', ['Zusammenfassung', 'Top/Low zuverlässig', 'Detailblöcke'], true),
        );
        return interaction.editReply({ embeds: [embed] });
      }
      if (interaction.customId === 'leader_pending_approvals') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const sessionId = uid('pendingappr');
        return interaction.editReply(buildLeaderPendingApprovalsView(interaction.guild, sessionId, 0, ''));
      }
      if (interaction.customId === 'leader_open_sanctions') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        const sessionId = uid('opensan');
        return interaction.editReply(buildLeaderOpenSanctionsView(interaction.guild, sessionId, 0, ''));
      }
      if (interaction.customId === 'leader_week') {
        await interaction.deferReply({ flags: 64 });
        return interaction.editReply({ embeds: [buildWeeklyBriefEmbed(interaction.guild)] });
      }
      if (interaction.customId === 'leader_stats') {
        await interaction.deferReply({ flags: 64 });
        return interaction.editReply({ embeds: [buildStatsSnapshotEmbed(interaction.guild)] });
      }
      if (interaction.customId === 'leader_attendance_launch') {
        if (!hasActionPermission(interaction.member, 'attendance_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = uid('attendance_launch');
        store.sessions.attendanceLaunchers[sessionId] = { createdAt: now(), userId: interaction.user.id };
        saveAll();
        return interaction.reply(await buildAttendanceTermPickerResponse(interaction.guild, sessionId));
      }
      if (interaction.customId.startsWith('attendance_mark:')) {
        const [, checkId, status] = interaction.customId.split(':');
        const check = store.sessions.attendanceChecks?.[checkId];
        if (!check || check.closed) return interaction.reply({ content: 'Dieser Anwesenheitscheck ist nicht mehr aktiv.', flags: 64 });
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        if (!check.selectedUserId) return interaction.reply({ content: 'Bitte zuerst ein Mitglied auswählen.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        await handleAttendanceStatusDecision(interaction.guild, check, check.selectedUserId, status, interaction.user.id);
        return interaction.editReply({ content: `${getAttendanceStatusText(status)} wurde für <@${check.selectedUserId}> gespeichert.` });
      }
      if (interaction.customId.startsWith('attendance_close:')) {
        const [, checkId] = interaction.customId.split(':');
        const check = store.sessions.attendanceChecks?.[checkId];
        if (!check || check.closed) return interaction.reply({ content: 'Dieser Anwesenheitscheck ist bereits geschlossen.', flags: 64 });
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        check.closed = true;
        check.closedAt = now();
        saveAll();
        const channel = await resolveSystemTextChannel(interaction.guild, check.channelId);
        const msg = channel ? await withDiscordRetry(() => channel.messages.fetch(check.messageId)).catch(() => null) : null;
        if (msg) await msg.delete().catch(() => null);
        return interaction.reply({ content: 'Anwesenheitscheck geschlossen.', flags: 64 });
      }
      if (interaction.customId.startsWith('admin_dm_toggle:')) {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const key = interaction.customId.split(':')[1];
        toggleDmSettingKey(key);
        return interaction.update({ embeds: [buildDmSettingsEmbed()], components: buildDmSettingsComponents() });
      }
      if (interaction.customId === 'admin_dm_back') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() });
      }
      if (interaction.customId.startsWith('admin_toggle:')) {
        const key = interaction.customId.split(':')[1];
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        store.config.settings[key] = !store.config.settings[key];
        saveAll();
        await interaction.update({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() });
        const channel = interaction.guild.channels.cache.get(store.config.panelMessages?.leaderpanel?.channelId || '');
        if (channel) await sendLeaderPanel(channel, interaction.guild);
        return;
      }
      if (interaction.customId === 'admin_appearance_edit') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.showModal(buildAdminAppearanceModal());
      }
      if (interaction.customId === 'admin_appearance_back') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.update({ embeds: [buildAdminPanelEmbed()], components: buildAdminPanelComponents() });
      }
      if (interaction.customId.startsWith('admin_action:')) {
        const action = interaction.customId.split(':')[1];
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        if (action === 'config_help') {
          return interaction.reply({ content: 'Kanäle setzen: `/set-kanal typ:<typ> kanal:<#kanal>`\nFreigaben-Kanal für Auto-Sanktionen: `/set-kanal typ:Freigaben kanal:<#kanal>`\nWache Kanäle: `/wache-config dashboard_kanal:<#kanal> bericht_kanal:<#kanal>`\nRechte setzen: `/set-berechtigung typ:<bereich> rolle:<@rolle>`', flags: 64 });
        }
        if (action === 'appearance') {
          return interaction.reply({ embeds: [buildAdminAppearanceEmbed()], components: buildAdminAppearanceComponents(), flags: 64 });
        }
        await interaction.deferReply({ flags: 64 });
        if (action === 'sync') {
          await syncAllStoredMessages(interaction.guild);
          return interaction.editReply({ content: 'UI und Panels wurden synchronisiert.' });
        }
        if (action === 'recovery') {
          await runRecoveryPass(interaction.guild);
          return interaction.editReply({ content: 'Recovery-Pass abgeschlossen.' });
        }
        if (action === 'pending') {
          return interaction.editReply({ embeds: [await buildPendingApprovalsEmbed(interaction.guild)] });
        }
        if (action === 'rights') {
          return interaction.editReply({ embeds: [buildRightsCheckEmbed(interaction.guild)] });
        }
        if (action === 'test_log') {
          await logSystemEvent(interaction.guild, '🧪 Test Log', [`Ausgelöst von: ${getUserDisplay(interaction.guild, interaction.user.id)}`], COLORS.info);
          return interaction.editReply({ content: 'Test-Log gesendet.' });
        }
        if (action === 'dm_settings') {
          return interaction.editReply({ embeds: [buildDmSettingsEmbed()], components: buildDmSettingsComponents() });
        }
        if (action === 'test_dm') {
          const ok = await sendDM(interaction.user, '🧪 Test-DM vom Kenway Bot', { area: 'general', noticeKey: 'manual-test' });
          return interaction.editReply({ content: ok ? 'Test-DM gesendet.' : 'Test-DM fehlgeschlagen. Prüfe deine DM-Einstellungen.' });
        }
        if (action === 'test_approval') {
          const embed = new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle('⚖️ Test Freigabe')
            .setDescription('Freigabe-Buttons und Interactions reagieren.')
            .setFooter({ text: 'Diagnose • privat' });
          return interaction.editReply({ embeds: [embed] });
        }
        if (action === 'test_attendance') {
          const embed = new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle('📋 Test Anwesenheit')
            .setDescription('Attendance-Launcher und private Interactions reagieren.')
            .setFooter({ text: 'Diagnose • privat' });
          return interaction.editReply({ embeds: [embed] });
        }
      }
      if (interaction.customId.startsWith('pending_approvals_page:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const [, sessionId, action] = interaction.customId.split(':');
        const state = store.sessions.pendingApprovalPanel?.[sessionId] || { page: 0, selectedId: '' };
        if (action === 'prev') state.page = Math.max(0, Number(state.page || 0) - 1);
        if (action === 'next') state.page = Number(state.page || 0) + 1;
        store.sessions.pendingApprovalPanel ||= {};
        store.sessions.pendingApprovalPanel[sessionId] = state;
        saveAll();
        return interaction.update(buildLeaderPendingApprovalsView(interaction.guild, sessionId, state.page || 0, state.selectedId));
      }
      if (interaction.customId.startsWith('pending_approvals_action:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const [, sessionId, action] = interaction.customId.split(':');
        const state = store.sessions.pendingApprovalPanel?.[sessionId] || { page: 0, selectedId: '' };
        await interaction.deferUpdate();
        if (action === 'approve_selected' || action === 'deny_selected') {
          const approval = store.sessions.pendingSanctionApprovals?.[state.selectedId];
          if (approval && !approval.resolved) await finalizeApproval(interaction.guild, approval, action === 'approve_selected', interaction.user.id, action === 'approve_selected' ? 'manual_yes' : 'manual_no');
          state.selectedId = '';
        } else if (action === 'approve_all' || action === 'deny_all') {
          const execute = action === 'approve_all';
          const approvals = Object.values(store.sessions.pendingSanctionApprovals || {}).filter(item => !item.resolved);
          for (const approval of approvals) {
            await finalizeApproval(interaction.guild, approval, execute, interaction.user.id, execute ? 'manual_yes_all' : 'manual_no_all');
          }
          state.selectedId = '';
        }
        store.sessions.pendingApprovalPanel ||= {};
        store.sessions.pendingApprovalPanel[sessionId] = state;
        saveAll();
        return interaction.editReply(buildLeaderPendingApprovalsView(interaction.guild, sessionId, state.page || 0, state.selectedId));
      }
      if (interaction.customId.startsWith('approval_yes:')) {
        const approvalId = interaction.customId.split(':')[1];
        const approval = store.sessions.pendingSanctionApprovals?.[approvalId];
        if (!approval) return interaction.reply({ content: 'Freigabe nicht gefunden.', flags: 64 });
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        await finalizeApproval(interaction.guild, approval, true, interaction.user.id, 'manual_yes');
        return interaction.editReply({ content: `Sanktion für <@${approval.userId}> wurde ausgestellt.` });
      }
      if (interaction.customId.startsWith('approval_no:')) {
        const approvalId = interaction.customId.split(':')[1];
        const approval = store.sessions.pendingSanctionApprovals?.[approvalId];
        if (!approval) return interaction.reply({ content: 'Freigabe nicht gefunden.', flags: 64 });
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await interaction.deferReply({ flags: 64 });
        await finalizeApproval(interaction.guild, approval, false, interaction.user.id, 'manual_no');
        return interaction.editReply({ content: `Sanktion für <@${approval.userId}> wurde gestoppt.` });
      }

      if (interaction.customId.startsWith('open_sanctions_page:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const [, sessionId, action] = interaction.customId.split(':');
        ensureOpenSanctionsSessionShape();
        const state = store.sessions.openSanctions[sessionId] || { page: 0, selectedId: '' };
        if (action === 'prev') state.page = Math.max(0, Number(state.page || 0) - 1);
        if (action === 'next') state.page = Number(state.page || 0) + 1;
        store.sessions.openSanctions[sessionId] = state;
        saveAll();
        return interaction.update(buildLeaderOpenSanctionsView(interaction.guild, sessionId, state.page, state.selectedId));
      }
      if (interaction.customId.startsWith('open_sanctions_action:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const [, sessionId, action] = interaction.customId.split(':');
        ensureOpenSanctionsSessionShape();
        const state = store.sessions.openSanctions[sessionId] || { page: 0, selectedId: '' };
        const sanction = store.sanctions.items.find(item => item.id === state.selectedId);
        if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
        if (action === 'paid') {
          markSanctionPaid(sanction.id, interaction.user.id);
        } else if (action === 'pause') {
          sanction.paused = true;
          sanction.pausedAt = now();
          saveAll();
        } else if (action === 'resume') {
          sanction.paused = false;
          sanction.pausedAt = null;
          saveAll();
        } else if (action === 'delete') {
          sanction.status = 'storniert';
          sanction.paid = true;
          sanction.cancelledAt = now();
          sanction.cancelledBy = interaction.user.id;
          sanction.cancelReason = 'Im Leader Panel gelöscht/storniert';
          reverseSanctionCashboxTransaction(sanction, interaction.user.id, 'Sanktion storniert/gelöscht');
          suppressAutoSanctionFromSanction(sanction, interaction.user.id, 'leader_deleted');
          saveAll();
          state.selectedId = '';
        } else if (action === 'resend') {
          const user = await client.users.fetch(sanction.userId).catch(() => null);
          if (user) await sendDM(user, buildSanctionIssuedDM(interaction.guild, sanction), { area: 'sanktionen', noticeKey: `sanction:${sanction.id}:resend` });
        }
        await updateSanctionPublicMessage(interaction.guild, sanction).catch(() => null);
        return interaction.update(buildLeaderOpenSanctionsView(interaction.guild, sessionId, state.page || 0, state.selectedId));
      }
      if (interaction.customId === 'sanction_open') {
        if (!hasActionPermission(interaction.member, 'sanction_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = uid('sanpick');
        store.sessions.memberPickers[sessionId] = { page: 0, type: 'sanction' };
        saveAll();
        return interaction.reply({ ...buildMemberPickerResponse(interaction.guild, sessionId, 0, 'sanction'), flags: 64 });
      }
      if (interaction.customId.startsWith('sanction_card_paid:')) {
        const sanctionId = interaction.customId.split(':')[1];
        const sanction = markSanctionPaid(sanctionId, interaction.user.id);
        if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
        await updateSanctionPublicMessage(interaction.guild, sanction);
        return interaction.reply({ content: `Sanktion #${String(sanction.id).replace(/^san_?/, '')} wurde als bezahlt markiert.`, flags: 64 });
      }
      if (interaction.customId.startsWith('sanction_card_pause:')) {
        const sanctionId = interaction.customId.split(':')[1];
        const sanction = store.sanctions.items.find(item => item.id === sanctionId);
        if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
        sanction.paused = true;
        sanction.pausedAt = now();
        saveAll();
        await updateSanctionPublicMessage(interaction.guild, sanction);
        return interaction.reply({ content: `Timer für Sanktion #${String(sanction.id).replace(/^san_?/, '')} pausiert.`, flags: 64 });
      }
      if (interaction.customId.startsWith('sanction_card_resume:')) {
        const sanctionId = interaction.customId.split(':')[1];
        const sanction = store.sanctions.items.find(item => item.id === sanctionId);
        if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
        sanction.paused = false;
        sanction.pausedAt = null;
        saveAll();
        await updateSanctionPublicMessage(interaction.guild, sanction);
        return interaction.reply({ content: `Timer für Sanktion #${String(sanction.id).replace(/^san_?/, '')} fortgesetzt.`, flags: 64 });
      }
      if (interaction.customId.startsWith('sanction_card_resend:')) {
        const sanctionId = interaction.customId.split(':')[1];
        const sanction = store.sanctions.items.find(item => item.id === sanctionId);
        if (!sanction) return interaction.reply({ content: 'Sanktion nicht gefunden.', flags: 64 });
        const user = await client.users.fetch(sanction.userId).catch(() => null);
        if (!user) return interaction.reply({ content: 'Mitglied konnte nicht geladen werden.', flags: 64 });
        await sendDM(user, buildSanctionIssuedDM(interaction.guild, sanction), { area: 'sanktionen', noticeKey: `sanction:${sanction.id}:resend` });
        return interaction.reply({ content: `DM für Sanktion #${String(sanction.id).replace(/^san_?/, '')} erneut gesendet.`, flags: 64 });
      }
      if (interaction.customId === 'absence_custom_until') {
        const modal = new ModalBuilder()
          .setCustomId('absence_custom_modal')
          .setTitle('Abmeldung eigener Zeitraum')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('from')
                .setLabel('Von wann? optional, TT.MM.JJJJ HH:MM')
                .setPlaceholder('leer = ab sofort, z.B. 15.05.2026 18:00')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('until')
                .setLabel('Bis wann? TT.MM.JJJJ oder TT.MM.JJJJ HH:MM')
                .setPlaceholder('z.B. 31.03.2026 23:59')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Optionaler Grund')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
            ),
          );
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'absence_term_today') {
        await safeDeferReply(interaction, { flags: 64 });
        try {
          const fullAbsence = getActiveAbsence(interaction.user.id, 'all');
          if (fullAbsence && fullAbsence.appliesTo !== 'term_only') return interaction.editReply({ content: 'Du bist bereits allgemein abgemeldet.' });
          removeActiveAbsence(interaction.user.id);
          const absence = createTodayTermOnlyAbsence(interaction.user.id, 'Nur für Termin heute', interaction.user.id);
          await syncUserAcrossTerms(interaction.guild, interaction.user.id, { immediate: true, forceTodayTermOnly: true });
          await refreshAllActiveTermAnnouncements(interaction.guild);
          return interaction.editReply({ content: `Du bist jetzt bis ${formatDateTime(absence.untilTs)} nur für Termine heute abgemeldet.` });
        } catch (error) {
          console.error('absence_term_today failed', error);
          return interaction.editReply({ content: 'Fehler beim Setzen der Termin-Abmeldung.' });
        }
      }
      if (interaction.customId === 'absence_stop_self') {
        await safeDeferReply(interaction, { flags: 64 });
        try {
          const active = getActiveAbsence(interaction.user.id, 'all') || getActiveAbsence(interaction.user.id, 'term');
          if (!active) return interaction.editReply({ content: 'Du hast aktuell keine aktive Abmeldung.' });
          const result = removeActiveAbsence(interaction.user.id);
          if (result.changed) reopenCurrentWeekAbgabenIfNeeded(interaction.guild, interaction.user.id, interaction.user.id);
          await syncUserAcrossTerms(interaction.guild, interaction.user.id, { immediate: true });
          await refreshAllActiveTermAnnouncements(interaction.guild);
          return interaction.editReply({ content: 'Deine aktive Abmeldung wurde gestoppt.' });
        } catch (error) {
          console.error('absence_stop_self failed', error);
          return interaction.editReply({ content: 'Fehler beim Stoppen der Abmeldung.' });
        }
      }
      if (interaction.customId === 'absence_status') {
        await safeDeferReply(interaction, { flags: 64 });
        try {
          const isLeader = hasLeadership(interaction.member);
          const targetUserId = isLeader ? null : interaction.user.id;
          const embed = await buildAbsenceStatusEmbedAsync(interaction.guild, targetUserId, isLeader);
          return interaction.editReply({ embeds: [embed] });
        } catch (error) {
          console.error('absence_status failed', error);
          return interaction.editReply({ content: 'Fehler bei der Status-Abfrage.' });
        }
      }
      if (interaction.customId === 'sanction_mark_paid') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = uid('sanpaid');
        store.sessions.memberPickers[sessionId] = { page: 0, type: 'sanction_paid' };
        saveAll();
        return interaction.reply({ ...buildMemberPickerResponse(interaction.guild, sessionId, 0, 'sanction_paid'), flags: 64 });
      }
      if (interaction.customId === 'sanction_catalog') {
        const lines = Object.entries(getSanctionCatalog()).sort(([a],[b]) => a.localeCompare(b)).map(([no, text]) => `**${no}** ${text}`);
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle('Sanktionskatalog').setDescription(lines.join('\n'))], flags: 64 });
      }
      if (interaction.customId === 'term_delete_open' || interaction.customId === 'term_delete' || interaction.customId === 'delete_term' || interaction.customId === 'term_vote_delete') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        return interaction.reply({ ...buildTermDeleteSelectPayload(), flags: 64 });
      }
      if (interaction.customId === 'term_create' || interaction.customId === 'vote_create') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const sessionId = uid('termbuild');
        store.sessions.termBuilders[sessionId] = { mode: interaction.customId === 'vote_create' ? 'vote' : 'term' };
        saveAll();
        const select = new StringSelectMenuBuilder()
          .setCustomId(`term_type_select:${sessionId}`)
          .setPlaceholder('Was steht an?')
          .addOptions(TERM_TYPES.map(type => ({ label: type, value: type })));
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x2b2d31).setTitle(interaction.customId === 'vote_create' ? 'Abstimmung erstellen' : 'Termin erstellen').setDescription('Art auswählen')],
          components: [new ActionRowBuilder().addComponents(select)],
          flags: 64,
        });
      }
      if (interaction.customId.startsWith('term_response:')) {
        await safeDeferReply(interaction, { flags: 64 });
        const [, termId, response] = interaction.customId.split(':');
        const term = store.terms.items.find(item => item.id === termId);
        if (!term) return interaction.editReply({ content: 'Termin nicht gefunden.' });
        if (term.cancelled) return interaction.editReply({ content: 'Dieser Termin wurde abgesagt. Antworten sind nicht mehr möglich.' });
        term.responses ||= {};
        term.autoCannotUsers ||= {};
        term.autoCanUsers ||= {};
        const alwaysCanIds = new Set(getTermAlwaysCanUserIds(term));
        const isAlwaysCan = alwaysCanIds.has(interaction.user.id);
        const activeAbsence = getAbsenceAt(interaction.user.id, term.startTs, 'term');
        if (isAlwaysCan) {
          term.responses[interaction.user.id] = 'can';
          term.autoCanUsers[interaction.user.id] = true;
          delete term.autoCannotUsers[interaction.user.id];
          saveAll();
          await updateTermAnnouncementMessage(interaction.guild, term, true);
          return interaction.editReply({ content: 'Du wurdest für diesen Termin automatisch auf „Kann“ gesetzt.' });
        }
        if (response === 'can') {
          if (activeAbsence) removeActiveAbsence(interaction.user.id);
          delete term.autoCannotUsers[interaction.user.id];
          delete term.autoCanUsers[interaction.user.id];
          term.responses[interaction.user.id] = 'can';
          saveAll();
          await syncUserAcrossTerms(interaction.guild, interaction.user.id, { immediate: true });
          await updateTermAnnouncementMessage(interaction.guild, term, true);
          return interaction.editReply({ content: activeAbsence ? 'Gespeichert: Kann. Deine aktive Abmeldung wurde dafür beendet.' : 'Gespeichert: Kann.' });
        }
        if (activeAbsence) {
          term.responses[interaction.user.id] = 'cannot';
          term.autoCannotUsers[interaction.user.id] = true;
          delete term.autoCanUsers[interaction.user.id];
          saveAll();
          await updateTermAnnouncementMessage(interaction.guild, term, true);
          return interaction.editReply({ content: 'Du bist für diesen Termin abgemeldet und wurdest automatisch auf „Abgemeldet“ gesetzt.' });
        }
        delete term.autoCannotUsers[interaction.user.id];
        delete term.autoCanUsers[interaction.user.id];
        term.responses[interaction.user.id] = response;
        saveAll();
        await updateTermAnnouncementMessage(interaction.guild, term, true);
        if (store.config.panelMessages?.term_dashboard?.channelId) await upsertTermDashboardMessage(interaction.guild).catch(() => null);
        return interaction.editReply({ content: `Gespeichert: ${TERM_RESPONSE_MAP[response] || response}` });
      }
      if (interaction.customId.startsWith('term_status:')) {
        await safeDeferReply(interaction, { flags: 64 });
        const [, termId] = interaction.customId.split(':');
        const term = store.terms.items.find(item => item.id === termId);
        if (!term) return interaction.editReply({ content: 'Termin nicht gefunden.' });
        await updateTermAnnouncementMessage(interaction.guild, term, true);
        return interaction.editReply({ embeds: [await buildTermStatusEmbed(interaction.guild, term)] });
      }
      if (interaction.customId.startsWith('term_leader_dashboard:')) {
        await safeDeferReply(interaction, { flags: 64 });
        const [, termId] = interaction.customId.split(':');
        const term = store.terms.items.find(item => item.id === termId);
        if (!term) return interaction.editReply({ content: 'Termin nicht gefunden.' });
        if (!hasLeadership(interaction.member) && !hasActionPermission(interaction.member, 'attendance_manage')) {
          return interaction.editReply({ content: 'Keine Berechtigung. Dieses Dashboard ist nur für Leader/Admins.' });
        }
        await updateTermAnnouncementMessage(interaction.guild, term, true);
        return interaction.editReply({ embeds: [await buildTermLeaderDashboardEmbed(interaction.guild, term)] });
      }
      if (interaction.customId.startsWith('vote_pick:')) {
        const [, voteId, index] = interaction.customId.split(':');
        const vote = store.terms.items.find(item => item.id === voteId && item.kind === 'vote');
        if (!vote || vote.voteClosed || vote.cancelled) return interaction.reply({ content: vote?.cancelled ? 'Diese Abstimmung wurde abgesagt.' : 'Abstimmung geschlossen.', flags: 64 });
        vote.votes ||= {};
        vote.votes[interaction.user.id] = Number(index);
        saveAll();
        return interaction.reply({ content: `Deine Stimme für **${vote.voteChoices[Number(index)]}** wurde gespeichert.`, flags: 64 });
      }
      if (interaction.customId.startsWith('abgabe_page:')) {
        const [, sessionId, action] = interaction.customId.split(':');
        const state = store.sessions.abgabePanels[sessionId];
        if (!state) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        if (action === 'prev') state.page = Math.max(0, state.page - 1);
        if (action === 'next') state.page += 1;
        if (action === 'refresh') {
          state.page = 0;
          await ensureGuildMembersCached(interaction.guild, true);
        }
        saveAll();
        return interaction.update(buildAbgabePanelComponents(interaction.guild, state.category, state.page, state.selectedUserId || ''));
      }
      if (interaction.customId.startsWith('abgabe_action:')) {
        const [, sessionId, action] = interaction.customId.split(':');
        const state = store.sessions.abgabePanels[sessionId];
        if (!state) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        const category = state.category;
        if (action === 'status') {
          await interaction.deferReply({ flags: 64 });
          const embeds = await buildStatusEmbeds(interaction.guild, state.weekKey || getActiveAbgabeWeekForCategory(interaction.guild, category, currentWeekKey()), category);
          return interaction.editReply({ embeds });
        }
        if (!state.selectedUserId) return interaction.reply({ content: 'Bitte zuerst eine Person auswählen.', flags: 64 });
        const userId = state.selectedUserId;
        // Nicht die alte Panel-Session-Woche verwenden: Panels bleiben oft über den Wochenwechsel stehen.
        // Aktuelle Einträge gehen auf die effektive laufende Woche; „Zu spät“ geht immer auf die letzte Kalenderwoche.
        const thisWeek = getActiveAbgabeWeekForCategory(interaction.guild, category, currentWeekKey());
        const lastWeek = previousWeekKey(currentWeekKey());
        if (action === 'done') {
          applyAbgabe(userId, category, getAbgabeAmount(category, thisWeek), thisWeek, interaction.user.id, 'abgegeben', 'Pflichtabgabe');
          await refreshAbgabeWeekAfterChange(interaction.guild, thisWeek, category, 'panel-done');
          return interaction.reply({ content: `<@${userId}> wurde als abgegeben markiert.`, flags: 64 });
        }
        if (action === 'late') {
          applyAbgabe(userId, category, getAbgabeAmount(category, lastWeek), lastWeek, interaction.user.id, 'zu_spaet', 'Nachholung der Vorwoche');
          await refreshAbgabeWeekAfterChange(interaction.guild, lastWeek, category, 'panel-late-last-week');
          return interaction.reply({ content: `<@${userId}> wurde als zu spät für ${lastWeek} markiert und die Statistik wurde aktualisiert.`, flags: 64 });
        }
        if (action === 'excused') {
          markExcused(userId, category, thisWeek, interaction.user.id, 'Manuell entschuldigt');
          await refreshAbgabeWeekAfterChange(interaction.guild, thisWeek, category, 'panel-excused');
          return interaction.reply({ content: `<@${userId}> wurde entschuldigt.`, flags: 64 });
        }
        if (action === 'clear') {
          clearAbgabe(userId, category, thisWeek, interaction.user.id);
          clearAbgabe(userId, category, lastWeek, interaction.user.id);
          await refreshAbgabeWeekAfterChange(interaction.guild, thisWeek, category, 'panel-clear-current');
          await refreshAbgabeWeekAfterChange(interaction.guild, lastWeek, category, 'panel-clear-last');
          return interaction.reply({ content: `Einträge für <@${userId}> wurden zurückgesetzt und die Statistik wurde aktualisiert.`, flags: 64 });
        }
        if (action === 'partial') {
          const modal = new ModalBuilder()
            .setCustomId(`partial_modal:${category}:${userId}:${thisWeek}`)
            .setTitle(`Teilabgabe – ${ABGABEN[category].label}`)
            .addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(`Menge eingeben (Pflicht: ${getAbgabeAmount(category)})`).setStyle(TextInputStyle.Short).setRequired(true))
            );
          return interaction.showModal(modal);
        }
        if (action === 'extra') {
          const modal = new ModalBuilder()
            .setCustomId(`extra_modal:${category}:${userId}:${thisWeek}`)
            .setTitle(`Zusatz – ${ABGABEN[category].label}`)
            .addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Zusätzliche Menge ohne Pflichtabgabe').setStyle(TextInputStyle.Short).setRequired(true))
            );
          return interaction.showModal(modal);
        }
      }
      if (interaction.customId.startsWith('sanction_page:')) {
        const [, sessionId, action] = interaction.customId.split(':');
        const state = store.sessions.memberPickers[sessionId];
        if (!state) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        if (action === 'prev') state.page = Math.max(0, state.page - 1);
        if (action === 'next') state.page += 1;
        if (action === 'refresh') state.page = 0;
        saveAll();
        return interaction.update(buildMemberPickerResponse(interaction.guild, sessionId, state.page, 'sanction'));
      }
      if (interaction.customId.startsWith('sanction_paid_page:')) {
        const [, sessionId, action] = interaction.customId.split(':');
        const state = store.sessions.memberPickers[sessionId];
        if (!state) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        if (action === 'prev') state.page = Math.max(0, state.page - 1);
        if (action === 'next') state.page += 1;
        if (action === 'refresh') state.page = 0;
        saveAll();
        return interaction.update(buildMemberPickerResponse(interaction.guild, sessionId, state.page, 'sanction_paid'));
      }
    }
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId.startsWith('term_required_select:')) {
      const sessionId = interaction.customId.split(':')[1];
      const builder = store.sessions.termBuilders[sessionId];
      if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
      builder.required = interaction.values?.[0] !== 'optional';
      saveAll();
      return continueTermBuilderAfterRequirement(interaction, sessionId);
    }

    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu() && interaction.customId.startsWith('term_trade_item_select:')) {
      const sessionId = interaction.customId.split(':')[1];
      const builder = store.sessions.termBuilders[sessionId];
      if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
      builder.tradeItem = interaction.values[0] || '';
      saveAll();
      return interaction.showModal(buildTermTradeModal(sessionId, builder.type, builder.tradeItem));
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'rules_modal_abgabe') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        try {
          setRuleConfig('abgabeAutoSanction', {
            enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), getRuleConfig('abgabeAutoSanction').enabled),
            overdueDays: Number(interaction.fields.getTextInputValue('overdueDays') || 0),
            catalogNo: interaction.fields.getTextInputValue('catalogNo'),
            amount: Number(String(interaction.fields.getTextInputValue('amount') || '0').replace(/[^0-9]/g, '')),
            penaltyType: interaction.fields.getTextInputValue('penaltyType'),
          }, interaction.user.id);
          return interaction.reply({ content: 'Überfällige-Abgaben-Regel gespeichert.', embeds: [buildRulesOverviewEmbed()], components: buildRulesManagementComponents(), flags: 64 });
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
      }
      if (interaction.customId === 'rules_modal_term') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        try {
          setRuleConfig('termNoResponseSanction', {
            enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), getRuleConfig('termNoResponseSanction').enabled),
            catalogNo: interaction.fields.getTextInputValue('catalogNo'),
            amount: Number(String(interaction.fields.getTextInputValue('amount') || '0').replace(/[^0-9]/g, '')),
            penaltyType: interaction.fields.getTextInputValue('penaltyType'),
          }, interaction.user.id);
          return interaction.reply({ content: 'Termin-Regel gespeichert.', embeds: [buildRulesOverviewEmbed()], components: buildRulesManagementComponents(), flags: 64 });
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
      }
      if (interaction.customId === 'rules_modal_escalation') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        try {
          setRuleConfig('sanctionEscalation', {
            enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), getRuleConfig('sanctionEscalation').enabled),
            dueDays: Number(interaction.fields.getTextInputValue('dueDays') || 0),
            surchargeAmount: Number(String(interaction.fields.getTextInputValue('surchargeAmount') || '0').replace(/[^0-9]/g, '')),
            bloodoutAfterSurchargeDays: Number(interaction.fields.getTextInputValue('bloodoutDays') || 0),
          }, interaction.user.id);
          return interaction.reply({ content: 'Sanktions-Eskalation gespeichert.', embeds: [buildRulesOverviewEmbed()], components: buildRulesManagementComponents(), flags: 64 });
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
      }
      if (interaction.customId === 'rules_modal_catalog_set') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        try {
          const no = setSanctionCatalogEntry(
            interaction.fields.getTextInputValue('number'),
            interaction.fields.getTextInputValue('text'),
            interaction.user.id,
            { severity: interaction.fields.getTextInputValue('severity') }
          );
          return interaction.reply({ content: `Katalogeintrag **${no}** gespeichert.`, embeds: [buildSanctionCatalogDashboardEmbed()], components: buildSanctionCatalogDashboardComponents(), flags: 64 });
        } catch (error) {
          return interaction.reply({ content: `Fehler: ${error.message || error}`, flags: 64 });
        }
      }
      if (interaction.customId === 'rules_modal_catalog_delete') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const noRaw = interaction.fields.getTextInputValue('number');
        const ok = removeSanctionCatalogEntry(noRaw, interaction.user.id);
        return interaction.reply({ content: ok ? `Katalogeintrag **${String(noRaw).padStart(2,'0')}** gelöscht.` : 'Eintrag nicht gefunden.', embeds: [buildRulesOverviewEmbed()], components: buildRulesManagementComponents(), flags: 64 });
      }
      if (interaction.customId === 'admin_appearance_modal') {
        if (!hasActionPermission(interaction.member, 'admin')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const titles = String(interaction.fields.getTextInputValue('titles') || '').split('|').map(x => x.trim());
        setBotAppearance({
          embedColor: interaction.fields.getTextInputValue('embedColor'),
          prefix: interaction.fields.getTextInputValue('prefix'),
          footerText: interaction.fields.getTextInputValue('footerText'),
          dashboardTitle: titles[0],
          cashboxTitle: titles[1],
          leaderPanelTitle: titles[2],
          adminPanelTitle: titles[3],
        }, interaction.user.id);
        await syncAllStoredMessages(interaction.guild).catch(() => null);
        return interaction.reply({ content: 'Design-Einstellungen gespeichert und Panels synchronisiert.', embeds: [buildAdminAppearanceEmbed()], components: buildAdminAppearanceComponents(), flags: 64 });
      }
      if (interaction.customId === 'systempanel_reminder_modal') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const current = getSystemControlConfig().reminders;
        const changes = {
          enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), current.enabled),
          dmEnabled: parseOnOffValue(interaction.fields.getTextInputValue('dm'), current.dmEnabled),
          abgabeStages: parseReminderStageConfig(interaction.fields.getTextInputValue('abgabe'), current.abgabeStages),
          termMinutesBefore: parseCsvNumbers(interaction.fields.getTextInputValue('term'), current.termMinutesBefore).filter(n => n > 0),
          overdueRepeatHours: Math.max(1, Number(parseCsvNumbers(interaction.fields.getTextInputValue('overdue'), [current.overdueRepeatHours || 24])[0] || 24)),
        };
        setSystemReminderConfig(changes, interaction.user.id);
        return interaction.reply({ embeds: [buildReminderSettingsEmbed()], components: buildReminderSettingsComponents(), flags: 64 });
      }
      if (interaction.customId === 'systempanel_smartping_modal') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const current = getSystemControlConfig().smartPing;
        const scores = parseCsvNumbers(interaction.fields.getTextInputValue('scores'), [current.minRisk,current.reliableSkipScore,current.sundayOnlyScore,current.mediumScore]);
        const thresholds = parseCsvNumbers(interaction.fields.getTextInputValue('thresholds'), [current.openAbgabenThreshold,current.sanctionThreshold,current.termNoResponseThreshold]);
        const points = parseCsvNumbers(interaction.fields.getTextInputValue('points'), [current.openAbgabenPenaltyStart ?? 1,current.openAbgabenPenaltyPoints ?? 10,current.termNoResponsePenaltyPoints ?? 6,current.sanctionPenaltyLight ?? 5,current.sanctionPenaltyMedium ?? 12,current.sanctionPenaltyHeavy ?? 22,current.wachePenaltyStart ?? 1,current.wachePenaltyPoints ?? 15,current.wacheRepeatPenaltyPoints ?? 8,current.wachePenaltyHeavyAfter ?? 3]);
        setSystemSmartPingConfig({
          enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), current.enabled),
          activeDays: parseDayList(interaction.fields.getTextInputValue('days'), current.activeDays),
          minRisk: Math.max(0, Math.min(100, Number(scores[0] ?? current.minRisk))),
          reliableSkipScore: Math.max(0, Math.min(100, Number(scores[1] ?? current.reliableSkipScore))),
          sundayOnlyScore: Math.max(0, Math.min(100, Number(scores[2] ?? current.sundayOnlyScore))),
          mediumScore: Math.max(0, Math.min(100, Number(scores[3] ?? current.mediumScore))),
          labelVeryReliable: Math.max(0, Math.min(100, Number(scores[1] ?? current.labelVeryReliable ?? current.reliableSkipScore ?? 90))),
          labelReliable: Math.max(0, Math.min(100, Number(scores[2] ?? current.labelReliable ?? current.sundayOnlyScore ?? 75))),
          labelMedium: Math.max(0, Math.min(100, Number(scores[3] ?? current.labelMedium ?? current.mediumScore ?? 55))),
          labelUnreliable: Math.max(0, Math.min(100, Number(scores[4] ?? current.labelUnreliable ?? 35))),
          openAbgabenThreshold: Math.max(0, Number(thresholds[0] ?? current.openAbgabenThreshold)),
          sanctionThreshold: Math.max(0, Number(thresholds[1] ?? current.sanctionThreshold)),
          termNoResponseThreshold: Math.max(0, Number(thresholds[2] ?? current.termNoResponseThreshold)),
          openAbgabenPenaltyStart: Math.max(0, Number(points[0] ?? current.openAbgabenPenaltyStart ?? 1)),
          openAbgabenPenaltyPoints: Math.max(0, Number(points[1] ?? current.openAbgabenPenaltyPoints ?? 10)),
          termNoResponsePenaltyPoints: Math.max(0, Number(points[2] ?? current.termNoResponsePenaltyPoints ?? 6)),
          sanctionPenaltyLight: Math.max(0, Number(points[3] ?? current.sanctionPenaltyLight ?? 5)),
          sanctionPenaltyMedium: Math.max(0, Number(points[4] ?? current.sanctionPenaltyMedium ?? 12)),
          sanctionPenaltyHeavy: Math.max(0, Number(points[5] ?? current.sanctionPenaltyHeavy ?? 22)),
          wachePenaltyStart: Math.max(0, Number(points[6] ?? current.wachePenaltyStart ?? 1)),
          wachePenaltyPoints: Math.max(0, Number(points[7] ?? current.wachePenaltyPoints ?? 15)),
          wacheRepeatPenaltyPoints: Math.max(0, Number(points[8] ?? current.wacheRepeatPenaltyPoints ?? 8)),
          wachePenaltyHeavyAfter: Math.max(1, Number(points[9] ?? current.wachePenaltyHeavyAfter ?? 3)),
        }, interaction.user.id);
        return interaction.reply({ embeds: [buildSmartPingSettingsEmbed()], components: buildSmartPingSettingsComponents(), flags: 64 });
      }
      if (interaction.customId === 'systempanel_dms_modal') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const current = getSystemDmSettings();
        setSystemDmSettings({
          enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), current.enabled !== false),
          areas: parseDmAreas(interaction.fields.getTextInputValue('areas'), current.areas || {}),
          dailyDedupEnabled: parseOnOffValue(interaction.fields.getTextInputValue('dedup'), current.dailyDedupEnabled !== false),
          buttonsEnabled: parseOnOffValue(interaction.fields.getTextInputValue('buttons'), current.buttonsEnabled !== false),
        }, interaction.user.id);
        return interaction.reply({ embeds: [buildDmSystemSettingsEmbed()], components: buildDmSystemSettingsComponents(), flags: 64 });
      }
      if (interaction.customId === 'systempanel_automations_modal') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const current = getSystemControlConfig().automations;
        let next = { ...current, enabled: parseOnOffValue(interaction.fields.getTextInputValue('enabled'), current.enabled) };
        next = parseAutomationFlags(interaction.fields.getTextInputValue('sanctions'), next);
        next = parseAutomationFlags(interaction.fields.getTextInputValue('reminders'), next);
        next = parseAutomationFlags(interaction.fields.getTextInputValue('reports'), next);
        next = parseAutomationFlags(interaction.fields.getTextInputValue('misc'), next);
        setSystemAutomationConfig(next, interaction.user.id);
        return interaction.reply({ embeds: [buildAutomationSettingsEmbed()], components: buildAutomationSettingsComponents(), flags: 64 });
      }
      if (interaction.customId === 'wache_values_modal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        setWacheConfig({
          requiredMinutesPerWeek: parseNumber(interaction.fields.getTextInputValue('required')),
          absenceExcuseDays: parseNumber(interaction.fields.getTextInputValue('absence')),
          sessionMinutes: parseNumber(interaction.fields.getTextInputValue('session')),
          maxParticipants: parseNumber(interaction.fields.getTextInputValue('places')),
          sanctionAmount: parseNumber(interaction.fields.getTextInputValue('sanction')),
        });
        const reply = await refreshWacheLeaderConfigInteraction(interaction, 'Wache-Werte wurden gespeichert. Updates laufen im Hintergrund.');
        runBackgroundDiscordTask(interaction.guild, 'WACHE_VALUES_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
          await upsertWacheDashboardMessage(interaction.guild, null, true).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId === 'wache_window_modal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        let startHour = parseNumber(interaction.fields.getTextInputValue('startHour'));
        let endHour = parseNumber(interaction.fields.getTextInputValue('endHour'));
        startHour = Math.max(0, Math.min(23, Number(startHour || 14)));
        endHour = Math.max(1, Math.min(24, Number(endHour || 24)));
        if (endHour <= startHour) return safeReplyOnce(interaction, { content: 'End-Stunde muss nach der Start-Stunde liegen. Für 00:00 bitte 24 eintragen.' });
        setWacheConfig({ startHour, endHour });
        const reply = await refreshWacheLeaderConfigInteraction(interaction, 'Wache-Zeitfenster wurde gespeichert.');
        runBackgroundDiscordTask(interaction.guild, 'WACHE_WINDOW_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
          await upsertWacheDashboardMessage(interaction.guild, null, true).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId === 'wache_channels_modal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        const dashboardChannelId = normalizeChannelIdInput(interaction.fields.getTextInputValue('dashboard'));
        const reportChannelId = normalizeChannelIdInput(interaction.fields.getTextInputValue('report'));
        if (dashboardChannelId && !interaction.guild.channels.cache.get(dashboardChannelId)) {
          return safeReplyOnce(interaction, { content: `Dashboard-Kanal nicht gefunden: ${dashboardChannelId}` });
        }
        if (reportChannelId && !interaction.guild.channels.cache.get(reportChannelId)) {
          return safeReplyOnce(interaction, { content: `Berichte-Kanal nicht gefunden: ${reportChannelId}` });
        }
        setWacheConfig({ dashboardChannelId, reportChannelId });
        const reply = await refreshWacheLeaderConfigInteraction(interaction, 'Wache-Kanäle wurden gespeichert. Updates laufen im Hintergrund.');
        runBackgroundDiscordTask(interaction.guild, 'WACHE_CHANNELS_SYNC', async () => {
          await upsertWacheDashboardMessage(interaction.guild, dashboardChannelId ? interaction.guild.channels.cache.get(dashboardChannelId) : null, true).catch(() => null);
          await syncAllStoredMessages(interaction.guild).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId === 'wache_config_modal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const enabledRaw = String(interaction.fields.getTextInputValue('enabled') || '').trim().toLowerCase();
        if (!['an','aus','on','off','aktiv','deaktiviert'].includes(enabledRaw)) return interaction.reply({ content: 'Status muss an oder aus sein.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        setWacheConfig({
          enabled: ['an','on','aktiv'].includes(enabledRaw),
          requiredMinutesPerWeek: parseNumber(interaction.fields.getTextInputValue('required')),
          absenceExcuseDays: parseNumber(interaction.fields.getTextInputValue('absence')),
          sessionMinutes: parseNumber(interaction.fields.getTextInputValue('session')),
          sanctionAmount: parseNumber(interaction.fields.getTextInputValue('sanction')),
        });
        const reply = await safeReplyOnce(interaction, { content: '✅ Wache-Konfiguration gespeichert. Updates laufen im Hintergrund.', embeds: [buildWachePanelEmbed(interaction.guild)], components: buildWachePanelComponents() });
        runBackgroundDiscordTask(interaction.guild, 'WACHE_CONFIG_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId === 'abgabe_absence_days_modal') {
        if (!hasActionPermission(interaction.member, 'config_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const days = parseNumber(interaction.fields.getTextInputValue('days'));
        const next = setAbgabeAbsenceExcuseDays(days, interaction.user.id);
        return interaction.reply({ content: `Abgaben werden jetzt ab **${next} Abmeldetagen/Woche** automatisch entschuldigt.`, embeds: [buildAbgabeConfigEmbed()], components: buildAbgabeConfigComponents(), flags: 64 });
      }
      if (interaction.customId.startsWith('abgabe_config_modal:')) {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const category = interaction.customId.split(':')[1];
        const enabledRaw = String(interaction.fields.getTextInputValue('enabled') || '').trim().toLowerCase();
        const amount = parseNumber(interaction.fields.getTextInputValue('amount'));
        const day = parseAbgabeDay(interaction.fields.getTextInputValue('day'));
        const time = parseAbgabeTime(interaction.fields.getTextInputValue('time'));
        if (!['an','aus','on','off','aktiv','deaktiviert'].includes(enabledRaw)) return interaction.reply({ content: 'Status muss an oder aus sein.', flags: 64 });
        if (!day) return interaction.reply({ content: 'Abgabetag ungültig. Nutze 1-7 oder Montag-Sonntag.', flags: 64 });
        if (!time) return interaction.reply({ content: 'Uhrzeit ungültig. Nutze HH:MM.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        try {
          setAbgabeRuntimeConfig(category, { enabled: ['an','on','aktiv'].includes(enabledRaw), amount, deadlineDay: day, deadlineHour: time.hour, deadlineMinute: time.minute });
          markAbgabeReportsSkipBeforeNow();
        } catch (error) {
          return safeReplyOnce(interaction, { content: `Fehler: ${error.message || error}` });
        }
        const reply = await safeReplyOnce(interaction, { content: '✅ Abgabe-Konfiguration gespeichert. Kein Wochenbericht wurde dadurch ausgelöst. Updates laufen im Hintergrund.', embeds: [buildAbgabeConfigEmbed()], components: buildAbgabeConfigComponents() });
        runBackgroundDiscordTask(interaction.guild, 'ABGABE_CONFIG_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId === 'abgabe_temp_shift_modal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) {
          return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        }

        await safeDeferReply(interaction, { flags: 64 });

        const category = normalizeAbgabeCategoryInput(interaction.fields.getTextInputValue('category'));
        const weekKey = String(interaction.fields.getTextInputValue('week') || '').trim();
        const daysRaw = String(interaction.fields.getTextInputValue('days') || '').trim();
        const days = Number(daysRaw.replace(/[^0-9]/g, ''));

        if (!category) return safeReplyOnce(interaction, { content: 'Abgabe ungültig. Nutze routen, meth, schwarzpulver oder patronen.' });
        if (!/^\d{4}-W\d{2}$/.test(weekKey)) return safeReplyOnce(interaction, { content: 'Woche ungültig. Nutze z. B. 2026-W18.' });
        if (!Number.isInteger(days) || days < 1 || days > 30) return safeReplyOnce(interaction, { content: 'Tage ungültig. Nutze eine Zahl von 1 bis 30.' });

        try {
          setAbgabeTemporaryShiftByDays(category, weekKey, days, interaction.user.id);
        } catch (error) {
          return safeReplyOnce(interaction, { content: `Fehler: ${error.message || error}` });
        }

        const reply = await safeReplyOnce(interaction, {
          content: `✅ ${ABGABEN[category].label} wurde für ${weekKey} um **${days} Tag${days === 1 ? '' : 'e'}** verschoben. Updates laufen im Hintergrund.`,
          embeds: [buildAbgabeConfigEmbed()],
          components: buildAbgabeConfigComponents(),
        });

        runBackgroundDiscordTask(interaction.guild, 'ABGABE_TEMP_SHIFT_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
        });

        return reply;
      }
      if (interaction.customId === 'abgabe_temp_clear_modal') {
        if (!hasActionPermission(interaction.member, 'sanction_approve')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        await safeDeferReply(interaction, { flags: 64 });
        const category = normalizeAbgabeCategoryInput(interaction.fields.getTextInputValue('category'));
        const weekKey = String(interaction.fields.getTextInputValue('week') || '').trim();
        if (!category) return safeReplyOnce(interaction, { content: 'Abgabe ungültig. Nutze routen, meth, schwarzpulver oder patronen.' });
        const removed = clearAbgabeTemporaryOverride(category, weekKey);
        const reply = await safeReplyOnce(interaction, { content: removed ? `✅ Vorübergehende Verschiebung für ${ABGABEN[category].label} in ${weekKey} gelöscht. Updates laufen im Hintergrund.` : 'Es gab dafür keine vorübergehende Verschiebung.', embeds: [buildAbgabeConfigEmbed()], components: buildAbgabeConfigComponents() });
        runBackgroundDiscordTask(interaction.guild, 'ABGABE_TEMP_CLEAR_SYNC', async () => {
          await syncAllStoredMessages(interaction.guild).catch(() => null);
        });
        return reply;
      }
      if (interaction.customId.startsWith('absence_days_modal:')) {
        const sessionId = interaction.customId.split(':')[1];
        const form = store.sessions.absenceForms[sessionId];
        if (!form) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        const days = Number(form.days || 1);
        const reason = String(interaction.fields.getTextInputValue('reason') || '').trim();
        delete store.sessions.absenceForms[sessionId];
        removeActiveAbsence(interaction.user.id);
        const absence = createAbsence(interaction.user.id, days, reason || 'Selbstabmeldung', interaction.user.id);
        markAbgabeExcusesForAbsence(interaction.guild, absence, interaction.user.id);
        await refreshAllActiveTermAnnouncements(interaction.guild);
        await syncUserAcrossTerms(interaction.guild, interaction.user.id, { immediate: true });
        return interaction.reply({ content: `Du bist jetzt bis ${formatDateTime(absence.untilTs)} abgemeldet.${reason ? ` Grund: ${reason}` : ''}`, flags: 64 });
      }
      if (interaction.customId === 'absence_custom_modal') {
        const fromText = String(interaction.fields.getTextInputValue('from') || '').trim();
        const untilText = interaction.fields.getTextInputValue('until');
        const reason = String(interaction.fields.getTextInputValue('reason') || '').trim();
        const fromTs = fromText ? parseGermanUntilInput(fromText) : now();
        const untilTs = parseGermanUntilInput(untilText);
        if (!fromTs) return interaction.reply({ content: 'Ungültiges Von-Datum. Nutze TT.MM.JJJJ oder TT.MM.JJJJ HH:MM', flags: 64 });
        if (!untilTs) return interaction.reply({ content: 'Ungültiges Bis-Datum. Nutze TT.MM.JJJJ oder TT.MM.JJJJ HH:MM', flags: 64 });
        if (untilTs <= now()) return interaction.reply({ content: 'Das Bis-Datum muss in der Zukunft liegen.', flags: 64 });
        if (untilTs <= fromTs) return interaction.reply({ content: 'Das Bis-Datum muss nach dem Von-Datum liegen.', flags: 64 });
        removeActiveAbsence(interaction.user.id);
        const absence = createAbsenceRange(interaction.user.id, fromTs, untilTs, reason || 'Selbstabmeldung eigener Zeitraum', interaction.user.id);
        markAbgabeExcusesForAbsence(interaction.guild, absence, interaction.user.id);
        await refreshAllActiveTermAnnouncements(interaction.guild);
        await syncUserAcrossTerms(interaction.guild, interaction.user.id, { immediate: true });
        return interaction.reply({ content: `Du bist jetzt von ${formatDateTime(absence.startTs)} bis ${formatDateTime(absence.untilTs)} abgemeldet.${reason ? ` Grund: ${reason}` : ''}`, flags: 64 });
      }
      if (interaction.customId.startsWith('sanction_appeal_modal:')) {
        const sanctionId = interaction.customId.split(':')[1];
        const reason = interaction.fields.getTextInputValue('reason');
        const result = await createSanctionAppeal(interaction.guild, sanctionId, interaction.user.id, reason);
        return interaction.reply({ content: result.message, flags: 64 });
      }
      if (interaction.customId.startsWith('partial_modal:')) {
        const [, category, userId, weekFromModal] = interaction.customId.split(':');
        const amount = parseNumber(interaction.fields.getTextInputValue('amount'));
        const targetWeek = weekFromModal || getActiveAbgabeWeekForCategory(interaction.guild, category, currentWeekKey());
        const entry = applyPartialAbgabe(userId, category, amount, targetWeek, interaction.user.id);
        await refreshAbgabeWeekAfterChange(interaction.guild, targetWeek, category, 'modal-partial');
        return interaction.reply({ content: `<@${userId}> Teilabgabe eingetragen: ${formatAmount(category, entry.amount)} / ${formatAmount(category, getAbgabeAmount(category))}.`, flags: 64 });
      }
      if (interaction.customId.startsWith('extra_modal:')) {
        const [, category, userId, weekFromModal] = interaction.customId.split(':');
        const extra = parseNumber(interaction.fields.getTextInputValue('amount'));
        const targetWeek = weekFromModal || getActiveAbgabeWeekForCategory(interaction.guild, category, currentWeekKey());
        addExtraAbgabe(userId, category, extra, targetWeek, interaction.user.id);
        await refreshAbgabeWeekAfterChange(interaction.guild, targetWeek, category, 'modal-extra');
        return interaction.reply({ content: `<@${userId}> hat jetzt ${formatAmount(category, getAbgabeAmount(category))} + ${formatAmount(category, extra)} eingetragen.`, flags: 64 });
      }
      if (interaction.customId.startsWith('sanction_modal:')) {
        if (!hasActionPermission(interaction.member, 'sanction_manage')) return interaction.reply({ content: 'Keine Berechtigung.', flags: 64 });
        const memberId = interaction.customId.split(':')[1];
        const catalogNo = String(interaction.fields.getTextInputValue('catalogNo')).trim().padStart(2, '0');
        const penaltyType = String(interaction.fields.getTextInputValue('penaltyType')).trim();
        const amount = parseNumber(interaction.fields.getTextInputValue('amount'));
        const reason = interaction.fields.getTextInputValue('reason');
        const extraDays = parseNumber(interaction.fields.getTextInputValue('extraDays'));
        if (!SANCTION_CATALOG[catalogNo]) return interaction.reply({ content: 'Ungültige Katalognummer.', flags: 64 });
        if (!SANCTION_TYPES.includes(penaltyType)) return interaction.reply({ content: 'Ungültige Strafart.', flags: 64 });
        if (hasConflictingOpenSanction(memberId, 'manual')) return interaction.reply({ content: 'Für dieses Mitglied existiert bereits eine offene manuelle Sanktion.', flags: 64 });
        if (isUserWhitelisted(memberId)) return interaction.reply({ content: 'Dieses Mitglied steht auf der Whitelist.', flags: 64 });
        const sanction = createSanction({
          userId: memberId,
          issuerId: interaction.user.id,
          catalogNo,
          penaltyType,
          amount,
          extraReason: reason || 'Manuelle Sanktion',
          extraDays,
          source: 'manual',
        });
        await postSanctionPublic(interaction.guild, sanction);
        await sendSanctionIssuedDM(interaction.guild, sanction);
        return interaction.reply({ content: `Sanktion für <@${memberId}> wurde direkt ausgestellt.`, flags: 64 });
      }
      if (interaction.customId.startsWith('term_trade_modal:')) {
        const sessionId = interaction.customId.split(':')[1];
        const builder = store.sessions.termBuilders[sessionId];
        if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        builder.tradeItem = builder.tradeItem || getOptionalModalValue(interaction, 'item') || '';
        builder.tradeQuantity = interaction.fields.getTextInputValue('quantity') || '';
        builder.tradeUnitPrice = interaction.fields.getTextInputValue('unitPrice') || '';
        builder.tradeNote = getOptionalModalValue(interaction, 'note') || '';
        const term = createTermObject(builder, interaction.user.id);
        term.trade = { item: builder.tradeItem, quantity: builder.tradeQuantity, unitPrice: builder.tradeUnitPrice, note: builder.tradeNote };
        // Erst Kasse/Lager buchen. Wenn dabei Geld oder Bestand nicht reicht, wird der Termin nicht halb gespeichert.
        await maybeBookTradeTerm(interaction.guild, term, builder, interaction.user.id).catch(error => { throw error; });
        store.terms.items.push(term);
        delete store.sessions.termBuilders[sessionId];
        saveAll();
        await postTermAnnouncement(interaction.guild, term);
        return interaction.reply({ content: `Termin erstellt: **${term.title}** am ${term.date} um ${term.time} (${getTermRequirementLabel(term)})${term.cashboxTransactionId ? ' und automatisch in Kasse/Lager gebucht.' : ''}`, flags: 64 });
      }
      if (interaction.customId.startsWith('term_custom_modal:')) {
        const sessionId = interaction.customId.split(':')[1];
        const builder = store.sessions.termBuilders[sessionId];
        if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        builder.customTitle = interaction.fields.getTextInputValue('customTitle');
        if (builder.mode === 'vote') {
          const modal = new ModalBuilder()
            .setCustomId(`vote_options_modal:${sessionId}`)
            .setTitle('Abstimmung Optionen')
            .addComponents(
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option1').setLabel('Option 1').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option2').setLabel('Option 2').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option3').setLabel('Option 3').setStyle(TextInputStyle.Short).setRequired(true)),
              new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('option4').setLabel('Option 4 (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
            );
          saveAll();
          return interaction.showModal(modal);
        }
        const term = createTermObject(builder, interaction.user.id);
        store.terms.items.push(term);
        delete store.sessions.termBuilders[sessionId];
        saveAll();
        await postTermAnnouncement(interaction.guild, term);
        return interaction.reply({ content: `Termin erstellt: **${term.title}** am ${term.date} um ${term.time} (${getTermRequirementLabel(term)})`, flags: 64 });
      }
      if (interaction.customId.startsWith('vote_options_modal:')) {
        const sessionId = interaction.customId.split(':')[1];
        const builder = store.sessions.termBuilders[sessionId];
        if (!builder) return interaction.reply({ content: 'Session abgelaufen.', flags: 64 });
        builder.voteChoices = [
          interaction.fields.getTextInputValue('option1'),
          interaction.fields.getTextInputValue('option2'),
          interaction.fields.getTextInputValue('option3'),
          interaction.fields.getTextInputValue('option4'),
        ].map(x => String(x || '').trim()).filter(Boolean);
        const vote = createTermObject(builder, interaction.user.id);
        store.terms.items.push(vote);
        delete store.sessions.termBuilders[sessionId];
        saveAll();
        await postVoteMessage(interaction.guild, vote);
        return interaction.reply({ content: `Abstimmung erstellt: **${vote.title}** (${getTermRequirementLabel(vote)})`, flags: 64 });
      }
    }
  } catch (error) {
    console.error('INTERACTION_ERROR', error);
    try {
      const message = `Fehler: ${error.message}`;
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => null);
      } else if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: message, flags: 64 }).catch(() => null);
      } else if (interaction.replied) {
        await interaction.followUp({ content: message, flags: 64 }).catch(() => null);
      }
    } catch (_) {}
  }
  } catch (error) {
    console.error('INTERACTION_TOPLEVEL_ERROR', error);
    try {
      const message = `Fehler: ${String(error?.message || error).slice(0, 1800)}`;
      if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => null);
      else if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: message, flags: 64 }).catch(() => null);
      else await interaction.followUp({ content: message, flags: 64 }).catch(() => null);
    } catch (_) {}
  }
});
// =========================================================
// CRON
// =========================================================
cron.schedule('0 16 * * 4', () => sendAbgabeReminder('thu'), { timezone: TIMEZONE });
cron.schedule('0 16 * * 5', async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  await sendAbgabeReminder('fri');
  await runOncePerCronKey(guild, `fridayReport:${currentWeekKey()}`, 'postWeeklyMissingReportFriday', async () => postWeeklyMissingReportFriday());
}, { timezone: TIMEZONE });
cron.schedule('0 16 * * 0', () => sendAbgabeReminder('sun'), { timezone: TIMEZONE });
cron.schedule('0 0 * * 1', async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  await runOncePerCronKey(guild, `mondayStart:${currentWeekKey()}`, 'mondayStartWeekHandling', async () => mondayStartWeekHandling());
}, { timezone: TIMEZONE });
cron.schedule('1 22 * * 2', async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  await runOncePerCronKey(guild, `tuesdayAuto:${previousWeekKey(currentWeekKey())}`, 'tuesday2201AutoSanctions', async () => tuesday2201AutoSanctions());
}, { timezone: TIMEZONE });
cron.schedule('0 * * * *', async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (isAutomationEnabled('absenceCleanup')) await runStepSafe(guild, 'cleanupAbsences', async () => cleanupAbsences());
  if (isAutomationEnabled('abgabeReminders')) await runStepSafe(guild, 'processAbgabeReminderCatchup', async () => processAbgabeReminderCatchup());
  if (isAutomationEnabled('abgabeAutoSanctions')) {
    await runStepSafe(guild, 'processFollowUps', async () => processFollowUps());
    await runStepSafe(guild, 'processAbgabeAutoSanctions', async () => processAbgabeAutoSanctions());
  }
  if (isAutomationEnabled('sanctionEscalation') || isAutomationEnabled('sanctionReminders')) await runStepSafe(guild, 'processSanctions', async () => processSanctions());
  if (isAutomationEnabled('termReminders')) await runStepSafe(guild, 'processTermReminders', async () => processTermReminders());
  await runStepSafe(guild, 'closeVotesAndAnnounceWinners', async () => closeVotesAndAnnounceWinners());
  if (isAutomationEnabled('termNoResponseSanctions')) await runStepSafe(guild, 'processTermSanctions', async () => processTermSanctions());
  await runStepSafe(guild, 'processPendingSanctionApprovals', async () => processPendingSanctionApprovals());
  if (isAutomationEnabled('wacheReports')) await runStepSafe(guild, 'processWacheReports', async () => processWacheReports());
  await runStepSafe(guild, 'archiveOldAbgabeWeeks', async () => archiveOldAbgabeWeeks(false));
  await runStepSafe(guild, 'pruneResolvedRuntimeSessions', async () => pruneResolvedRuntimeSessions());
  if (isAutomationEnabled('dataIntegrity')) await runStepSafe(guild, 'validateAndRepairStoreData', async () => validateAndRepairStoreData());
  if (guild) {
    await runStepSafe(guild, 'refreshAllActiveTermAnnouncements', async () => refreshAllActiveTermAnnouncements(guild));
    if (isAutomationEnabled('uiSync')) await runStepSafe(guild, 'upsertDashboardMessage', async () => upsertDashboardMessage(guild));
    if (store.config.panelMessages?.term_dashboard?.channelId) {
      await runStepSafe(guild, 'upsertTermDashboardMessage', async () => upsertTermDashboardMessage(guild));
    }
    if (store.config.panelMessages?.members_dashboard?.channelId) {
      await runStepSafe(guild, 'upsertMembersDashboardMessage', async () => upsertMembersDashboardMessage(guild));
    }
  }
}, { timezone: TIMEZONE });
cron.schedule('* * * * *', async () => { if (isAutomationEnabled('weeklyReports')) await processDynamicWeeklyReport(); if (isAutomationEnabled('wacheReports')) await processWacheReports(); }, { timezone: TIMEZONE });
cron.schedule('59 23 28-31 * *', async () => { const guild = client.guilds.cache.get(GUILD_ID); await runStepSafe(guild, 'monthlyPreBackup', async () => saveAll()); if (isAutomationEnabled('monthlyReports')) await postMonthlyReport(); if (isAutomationEnabled('wacheReports')) await postWacheMonthlyReport(); if (isAutomationEnabled('cashboxMonthlyReports')) await maybePostCashboxMonthlyReport(); if (isAutomationEnabled('warehouseMonthlyReports')) await maybePostWarehouseMonthlyReport(); }, { timezone: TIMEZONE });
// =========================================================
// STARTUP
// =========================================================
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    let changed = false;
    for (const roleId of getTrackedDutyRoleIds()) {
      const hadRole = oldMember.roles.cache.has(roleId);
      const hasRole = newMember.roles.cache.has(roleId);
      if (!hadRole && hasRole) {
        if (setTrackedRoleAssignment(newMember.id, roleId, now(), 'member_role_add')) changed = true;
      }
      if (hadRole && !hasRole) {
        if (removeTrackedRoleAssignment(newMember.id, roleId)) changed = true;
      }
    }
    if (changed) saveAll();
    await refreshAllActiveTermAnnouncements(newMember.guild);
  } catch (error) {
    console.error('GUILD_MEMBER_UPDATE_ERROR', error);
  }
});


// =========================================================
// MEMBER DASHBOARD V3: Trends, Join-Date-Filter, Rankings, Smart Leader Hints
// =========================================================
function getMemberJoinedTsSafe(guild, userId) {
  const member = guild?.members?.cache?.get(String(userId));
  return Number(member?.joinedTimestamp || 0) || 0;
}
function shouldCountEventForMember(guild, userId, ts) {
  const joined = getMemberJoinedTsSafe(guild, userId);
  if (!joined) return true;
  return Number(ts || 0) >= joined;
}
function shouldCountWeekForMember(guild, userId, weekKey) {
  const joined = getMemberJoinedTsSafe(guild, userId);
  if (!joined) return true;
  return endOfWeekTsFromWeekKey(weekKey) >= joined;
}
function memberHadAbgabeRoleForWeek(guild, userId, category, weekKey) {
  const roleIds = getAbgabeParticipantRoleIds(category);
  if (!roleIds.length) return true;
  const member = guild?.members?.cache?.get(String(userId));
  if (!member?.roles?.cache?.some(role => roleIds.includes(String(role.id)))) return false;
  const received = getRoleReceivedTsForCategory(member, category) || getMemberJoinedTsSafe(guild, userId) || 0;
  return !received || received <= endOfWeekTsFromWeekKey(weekKey);
}
function getRecentAbgabeWeeksFrom(baseWeekKey = currentWeekKey(), limit = 4) {
  const all = getAllAbgabeWeeksIncludingArchive();
  const out = {};
  for (const weekKey of getRecentWeekKeys(limit, baseWeekKey)) {
    if (all[weekKey]) out[weekKey] = all[weekKey];
  }
  return out;
}
function getPrevious4WeekBase() {
  let wk = currentWeekKey();
  for (let i = 0; i < 4; i += 1) wk = previousWeekKey(wk);
  return wk;
}
function getTrendArrow(diff) {
  if (diff >= 10) return '⬆️ verbessert sich';
  if (diff <= -10) return '⬇️ verschlechtert sich';
  if (diff >= 4) return '↗️ leicht besser';
  if (diff <= -4) return '↘️ leicht schlechter';
  return '➡️ stabil';
}
function getTrendForUser(guild, userId) {
  const recent = calculateReliabilityForUserWindow(guild, userId, currentWeekKey(), 4);
  const previous = calculateReliabilityForUserWindow(guild, userId, getPrevious4WeekBase(), 4);
  if (!previous.hasData || !recent.hasData) return { label: 'Noch kein belastbarer Trend', diff: 0, recent: recent.score, previous: null };
  const diff = recent.score - previous.score;
  return { label: getTrendArrow(diff), diff, recent: recent.score, previous: previous.score };
}
function calculateReliabilityForUserWindow(guild, userId, baseWeekKey = currentWeekKey(), weekLimit = 4) {
  const weekKeys = getRecentWeekKeys(weekLimit, baseWeekKey);
  const startTs = startOfWeekTsFromWeekKey(weekKeys[weekKeys.length - 1]);
  const endTs = endOfWeekTsFromWeekKey(weekKeys[0]);
  let termCan = 0, termMaybe = 0, termCannot = 0, termAbsent = 0, termNoResponse = 0, termTotal = 0;
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    const termTs = Number(term.startTs || term.createdAt || 0);
    if (!termTs || termTs < startTs || termTs > endTs) continue;
    if (!shouldCountEventForMember(guild, userId, termTs)) continue;
    termTotal += 1;
    const isAutoCan = !!term.autoCanUsers?.[userId];
    const response = term.responses?.[userId];
    const isAbsent = !!getAbsenceAt(userId, termTs, 'term') && !isAutoCan;
    const isAutoCannot = !!term.autoCannotUsers?.[userId] && !isAutoCan;
    if (isAutoCan || response === 'can') termCan += 1;
    else if (isAbsent || isAutoCannot) termAbsent += 1;
    else if (response === 'maybe') termMaybe += 1;
    else if (response === 'cannot') termCannot += 1;
    else termNoResponse += 1;
  }
  let abgabeSubmitted = 0, abgabeOpen = 0, abgabeTotal = 0;
  const all = getAllAbgabeWeeksIncludingArchive();
  for (const weekKey of weekKeys) {
    const week = all[weekKey];
    if (!week || !shouldCountWeekForMember(guild, userId, weekKey)) continue;
    for (const category of getEnabledAbgabeKeys()) {
      if (!memberHadAbgabeRoleForWeek(guild, userId, category, weekKey)) continue;
      const row = week.categories?.[category]?.[userId];
      if (!row) continue;
      abgabeTotal += 1;
      if (['abgegeben','vorausgezahlt','zu_spaet'].includes(row.status)) abgabeSubmitted += 1;
      else if (row.status === 'teilabgabe') abgabeSubmitted += 0.5;
      if (['nicht_abgegeben','offen','warnphase','teilabgabe'].includes(row.status)) abgabeOpen += 1;
    }
  }
  const weightedBase = (termCan * 1) + (termMaybe * 0.6) + (termCannot * 0.25) + (termAbsent * 0.35);
  const termScore = termTotal ? Math.round((weightedBase / termTotal) * 100) : null;
  const abgabeScore = abgabeTotal ? Math.round((abgabeSubmitted / abgabeTotal) * 100) : null;
  const parts = [];
  if (termScore != null) parts.push({ score: termScore, weight: 0.45 });
  if (abgabeScore != null) parts.push({ score: abgabeScore, weight: 0.55 });
  if (!parts.length) return { score: 100, hasData: false, termTotal, abgabeTotal, termNoResponse, abgabeOpen };
  const weightSum = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((sum, p) => sum + p.score * p.weight, 0) / weightSum)));
  return { score, hasData: true, termTotal, abgabeTotal, termNoResponse, abgabeOpen };
}
function getTermStatsForUser(guildOrUserId, maybeUserId) {
  const guild = maybeUserId ? guildOrUserId : null;
  const userId = maybeUserId || guildOrUserId;
  let total = 0, can = 0, maybe = 0, cannot = 0, absent = 0, noResponse = 0;
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    const termTs = Number(term.startTs || term.createdAt || 0);
    if (guild && !shouldCountEventForMember(guild, userId, termTs)) continue;
    total += 1;
    const response = term.responses?.[userId];
    const isAutoCan = !!term.autoCanUsers?.[userId];
    const isAbsent = !!getAbsenceAt(userId, termTs, 'term') && !isAutoCan;
    const isAutoCannot = !!term.autoCannotUsers?.[userId] && !isAutoCan;
    if (isAutoCan || response === 'can') can += 1;
    else if (response === 'maybe') maybe += 1;
    else if (response === 'cannot') cannot += 1;
    else if (isAbsent || isAutoCannot) absent += 1;
    else noResponse += 1;
  }
  return { total, can, maybe, cannot, absent, noResponse };
}
function getAbgabeCategoryStatsForUser(guild, userId, category, weekLimit = 4) {
  const cfg = getAbgabeRuntimeConfig(category);
  if (!cfg.enabled) return { enabled: false, inRole: false, total: 0, submitted: 0, partial: 0, late: 0, open: 0, excused: 0 };
  const member = guild?.members?.cache?.get(String(userId));
  const roleIds = getAbgabeParticipantRoleIds(category);
  if (roleIds.length && !member?.roles?.cache?.some(role => roleIds.includes(String(role.id)))) return { enabled: true, inRole: false, total: 0, submitted: 0, partial: 0, late: 0, open: 0, excused: 0 };
  let total = 0, submitted = 0, partial = 0, late = 0, open = 0, excused = 0;
  for (const [weekKey, week] of Object.entries(getRecentAbgabeWeeks(weekLimit))) {
    if (!shouldCountWeekForMember(guild, userId, weekKey)) continue;
    if (!memberHadAbgabeRoleForWeek(guild, userId, category, weekKey)) continue;
    const row = week.categories?.[category]?.[userId];
    if (!row) continue;
    total += 1;
    const status = String(row.status || 'offen');
    if (['abgegeben','vorausgezahlt'].includes(status)) submitted += 1;
    else if (status === 'teilabgabe') partial += 1;
    else if (status === 'zu_spaet') { submitted += 1; late += 1; }
    else if (status === 'entschuldigt' || status === 'spaeter_abgabe') excused += 1;
    else if (['offen','warnphase','nicht_abgegeben'].includes(status)) open += 1;
    if (isLateAbgabeEntry(weekKey, category, row)) late += 1;
  }
  return { enabled: true, inRole: true, total, submitted, partial, late, open, excused };
}
function getWacheStatsForUser(userId, guild = null) {
  if (!getWacheConfig().enabled) return { enabled: false, weeks: 0, fulfilled: 0, open: 0, minutes: 0 };
  let weeks = 0, fulfilled = 0, open = 0, minutes = 0;
  for (const [weekKey, week] of Object.entries(store.wache?.weeks || {})) {
    if (guild && /^\d{4}-W\d{2}$/.test(weekKey) && !shouldCountWeekForMember(guild, userId, weekKey)) continue;
    const row = week.users?.[userId] || week.members?.[userId];
    if (!row) continue;
    weeks += 1;
    const mins = Number(row.minutes || row.totalMinutes || 0);
    minutes += mins;
    if (row.fulfilled || mins >= Number(getWacheConfig().requiredMinutesPerWeek || 60)) fulfilled += 1;
    else open += 1;
  }
  return { enabled: true, weeks, fulfilled, open, minutes };
}
function getBehaviorPatternForUser(guild, userId) {
  ensureConfigShape();
  if (!userId) return { sundayLastMinute: 0, lateAbgaben: 0, dmDependent: 0, termIgnored: 0, wacheAvoided: 0, modifier: 0, labels: [] };
  if (!store.config.behaviorPatterns || typeof store.config.behaviorPatterns !== 'object') store.config.behaviorPatterns = {};
  const result = { sundayLastMinute: 0, lateAbgaben: 0, dmDependent: 0, termIgnored: 0, wacheAvoided: 0, modifier: 0, labels: [] };
  for (const [weekKey, week] of Object.entries(getRecentAbgabeWeeks(4))) {
    if (!shouldCountWeekForMember(guild, userId, weekKey)) continue;
    for (const category of Object.keys(ABGABEN)) {
      if (!isAbgabeEnabled(category) || !memberHadAbgabeRoleForWeek(guild, userId, category, weekKey)) continue;
      const entry = week.categories?.[category]?.[userId];
      if (!entry) continue;
      if (['abgegeben','zu_spaet','teilabgabe'].includes(entry.status) && isLateAbgabeEntry(weekKey, category, entry)) result.lateAbgaben += 1;
      const ts = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
      if (ts) {
        const d = tsToTzDate(ts);
        const deadline = abgabeDeadlineTsForWeek(weekKey, category);
        if (d.getDay() === 0 && ts >= deadline - (6 * 60 * 60 * 1000) && ts <= deadline) result.sundayLastMinute += 1;
      }
      if ((entry.reminders || []).length && ['abgegeben','zu_spaet','teilabgabe'].includes(entry.status)) result.dmDependent += 1;
    }
  }
  for (const term of store.terms.items || []) {
    if (term.kind !== 'term') continue;
    const termTs = Number(term.startTs || term.createdAt || 0);
    if (!shouldCountEventForMember(guild, userId, termTs)) continue;
    const response = term.responses?.[userId];
    const absent = !!getAbsenceAt(userId, termTs, 'term');
    if (!response && !absent && !term.autoCanUsers?.[userId] && !term.autoCannotUsers?.[userId]) result.termIgnored += 1;
  }
  for (const [weekKey, week] of Object.entries(store.wache?.weeks || {})) {
    if (/^\d{4}-W\d{2}$/.test(weekKey) && !shouldCountWeekForMember(guild, userId, weekKey)) continue;
    const row = week.users?.[userId] || week.members?.[userId];
    if (!row && !getActiveAbsence(userId, 'wache')) result.wacheAvoided += 1;
  }
  if (result.sundayLastMinute >= 3) { result.modifier += 8; result.labels.push('oft letzte Minute'); }
  if (result.lateAbgaben >= 2) { result.modifier += 12; result.labels.push('oft verspätet'); }
  if (result.dmDependent >= 3) { result.modifier += 8; result.labels.push('reagiert oft erst nach DM'); }
  if (result.termIgnored >= 2) { result.modifier += 10; result.labels.push('Termine ignoriert'); }
  if (result.wacheAvoided >= 2) { result.modifier += 8; result.labels.push('Wache auffällig'); }
  store.config.behaviorPatterns[userId] = { ...result, updatedAt: now() };
  return result;
}
function calculateReliabilityForUser(guild, userId) {
  const win = calculateReliabilityForUserWindow(guild, userId, currentWeekKey(), 4);
  const sanctionCount = store.sanctions.items.filter(x => x.userId === userId && x.status !== 'storniert').length;
  const sanctionPenalty = getSanctionDecayPenaltyForUser(userId);
  const behavior = getBehaviorPatternForUser(guild, userId);
  const abgabe = getAbgabeStatsForUser(guild, userId, 4);
  const pc = getReliabilityPointConfig();
  const openAbgabePenalty = getOpenAbgabePointPenalty(abgabe.open);
  const term = getTermStatsForUser(guild, userId);
  const termNoResponsePenalty = Math.round(Number(term.noResponse || 0) * pc.termNoResponsePenalty);
  const wache = getWacheUnfulfilledStatsForUser(userId, 4);
  const wachePenalty = Math.round(Number(wache.penalty || 0));
  const bonus = Math.min(10, Math.floor(((win.termTotal || 0) + (win.abgabeTotal || 0)) / 8));
  const score = Math.max(0, Math.min(100, Math.round((win.hasData ? win.score : 100) - sanctionPenalty - openAbgabePenalty - termNoResponsePenalty - wachePenalty - behavior.modifier + bonus)));
  return {
    score,
    sanctionCount,
    sanctionPenalty,
    openAbgabePenalty,
    termNoResponsePenalty,
    wachePenalty,
    wacheMissed: wache.missed,
    wacheRepeated: wache.repeated,
    wacheLabels: wache.labels,
    behaviorModifier: behavior.modifier,
    behaviorLabels: behavior.labels,
    termCan: term.can,
    termMaybe: term.maybe,
    termCannot: term.cannot,
    termAbsent: term.absent,
    termNoResponse: term.noResponse,
    termTotal: term.total,
    abgabeSubmitted: abgabe.submitted + (abgabe.partial * 0.5),
    abgabeOpen: abgabe.open,
    abgabeTotal: abgabe.total,
    hasData: win.hasData,
  };
}
function buildRankingRows(guild) {
  const members = getRelevantGuildMembers(guild);
  return members.map(member => {
    const userId = member.id;
    const reliability = calculateReliabilityForUser(guild, userId);
    const abgabe = getAbgabeStatsForUser(guild, userId, 4);
    const term = getTermStatsForUser(guild, userId);
    const wache = getWacheStatsForUser(userId, guild);
    const abgabeQuote = abgabe.total ? Math.round(((abgabe.submitted + abgabe.partial * 0.5) / abgabe.total) * 100) : null;
    const termQuote = term.total ? Math.round(((term.can + term.maybe * 0.5) / term.total) * 100) : null;
    const activeScore = Math.round((reliability.score * 0.45) + ((abgabeQuote ?? 100) * 0.25) + ((termQuote ?? 100) * 0.20) + Math.min(100, (wache.minutes || 0)) * 0.10);
    return { userId, reliability, abgabe, term, wache, abgabeQuote, termQuote, activeScore, trend: getTrendForUser(guild, userId) };
  });
}
function formatRanking(guild, rows, valueFn, limit = 5) {
  const picked = rows.slice(0, limit);
  if (!picked.length) return ['—'];
  return picked.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} • ${valueFn(row)}`);
}
function getSmartLeaderHintLines(guild, rows) {
  const hints = [];
  const highRisk = rows.filter(r => getProblemScoreForUser(guild, r.userId).risk >= 85).slice(0, 3);
  for (const r of highRisk) hints.push(`🚨 ${getUserDisplay(guild, r.userId)} sofort beobachten: Risiko ${getProblemScoreForUser(guild, r.userId).risk}.`);
  const worsening = rows.filter(r => r.trend?.diff <= -10).sort((a,b) => a.trend.diff - b.trend.diff).slice(0, 3);
  for (const r of worsening) hints.push(`📉 ${getUserDisplay(guild, r.userId)} verschlechtert sich (${r.trend.diff} Punkte).`);
  const improved = rows.filter(r => r.trend?.diff >= 10).sort((a,b) => b.trend.diff - a.trend.diff).slice(0, 2);
  for (const r of improved) hints.push(`📈 ${getUserDisplay(guild, r.userId)} verbessert sich (+${r.trend.diff} Punkte).`);
  const noAnswer = rows.filter(r => r.term.noResponse >= 3).slice(0, 3);
  for (const r of noAnswer) hints.push(`📅 ${getUserDisplay(guild, r.userId)} ignoriert Termine häufig (${r.term.noResponse} ohne Antwort).`);
  return hints.slice(0, 8).length ? hints.slice(0, 8) : ['Keine akuten Hinweise.'];
}
async function buildMembersDashboardEmbed(guild) {
  await ensureGuildMembersCached(guild);
  const rows = buildRankingRows(guild);
  const topActive = [...rows].sort((a,b) => b.activeScore - a.activeScore);
  const bestAbgaben = [...rows].filter(r => r.abgabeQuote != null && r.abgabe.total >= 2).sort((a,b) => b.abgabeQuote - a.abgabeQuote || b.abgabe.total - a.abgabe.total);
  const bestTerms = [...rows].filter(r => r.termQuote != null && r.term.total >= 1).sort((a,b) => b.termQuote - a.termQuote || b.term.total - a.term.total);
  const mostWache = [...rows].filter(r => r.wache.enabled && r.wache.minutes > 0).sort((a,b) => b.wache.minutes - a.wache.minutes);
  const trends = [...rows].filter(r => r.trend?.previous != null).sort((a,b) => Math.abs(b.trend.diff) - Math.abs(a.trend.diff));
  const problemMembers = await buildProblemMembers(guild, 5);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📊 Erweitertes Mitglieder-Dashboard')
    .setDescription('Analyse pro Person. Vergangene Termine/Abgaben vor Serverbeitritt werden ignoriert. Scores beziehen sich auf die letzten 4 Wochen.')
    .addFields(
      buildInfoField('🏆 Top aktiv', formatRanking(guild, topActive, r => `${r.activeScore}% Aktivität`), true),
      buildInfoField('📦 Beste Abgaben', bestAbgaben.length ? formatRanking(guild, bestAbgaben, r => `${r.abgabeQuote}% • ${r.abgabe.submitted}/${r.abgabe.total}`) : ['Keine Daten'], true),
      buildInfoField('📅 Beste Terminquote', bestTerms.length ? formatRanking(guild, bestTerms, r => `${r.termQuote}% • ${r.term.can}/${r.term.total}`) : ['Keine Daten'], true),
      buildInfoField('🟢 Meiste Wache', mostWache.length ? formatRanking(guild, mostWache, r => `${r.wache.minutes} Min.`) : [getWacheConfig().enabled ? 'Keine Daten' : 'Nicht aktiviert'], true),
      buildInfoField('📈 Trends', trends.length ? formatRanking(guild, trends, r => `${r.trend.label} (${r.trend.diff > 0 ? '+' : ''}${r.trend.diff})`) : ['Noch kein belastbarer Trend'], true),
      buildInfoField('🚨 Höchstes Risiko', problemMembers.length ? problemMembers.map((row, idx) => `${idx + 1}. ${getUserDisplay(guild, row.userId)} • ${getRiskLabel(row.risk)} (${row.risk})`) : ['—'], true),
      buildInfoField('👑 Smart-Leader-Hinweise', getSmartLeaderHintLines(guild, rows), false),
      buildInfoField('ℹ️ Bedienung', ['Wähle unten ein Mitglied aus, um die Detailanalyse zu öffnen.', 'Seitenbuttons nutzen, falls mehr als 25 Mitglieder vorhanden sind.'], false),
    )
    .setFooter({ text: 'Mitglieder Analyse • Join-Date-Filter aktiv • letzte 4 Wochen • Trends gegen vorherige 4 Wochen' })
    .setTimestamp(new Date());
}
function buildMemberAnalysisEmbed(guild, userId) {
  const reliability = calculateReliabilityForUser(guild, userId);
  const problem = getProblemScoreForUser(guild, userId);
  const abgabe = getAbgabeStatsForUser(guild, userId, 4);
  const term = getTermStatsForUser(guild, userId);
  const absence = getAbsenceStatsForUser(userId);
  const wache = getWacheStatsForUser(userId, guild);
  const sanctions = (store.sanctions.items || []).filter(x => x.userId === userId && x.status !== 'storniert');
  const openSanctions = sanctions.filter(x => !x.paid && !['bezahlt','storniert'].includes(x.status)).length;
  const trend = getTrendForUser(guild, userId);
  const recommend = getMemberAnalysisRecommendation(reliability, problem, abgabe, term, absence, wache);
  return new EmbedBuilder()
    .setColor(problem.risk >= 85 ? COLORS.danger : problem.risk >= 60 ? COLORS.warning : COLORS.primary)
    .setTitle(`👤 Mitgliederanalyse • ${getUserDisplay(guild, userId)}`)
    .setDescription([
      `Zuverlässigkeit: **${getReliabilityLabel(reliability.score)}**`,
      formatPercentBar(reliability.score),
      `Risiko: **${getRiskLabel(problem.risk)}**`,
      formatPercentBar(problem.risk),
      `Trend: **${trend.label}**${trend.previous != null ? ` (${trend.previous}% → ${trend.recent}%)` : ''}`,
    ].join('\n'))
    .addFields(
      buildInfoField('📦 Abgaben gesamt (letzte 4 Wochen)', [`Gesamt: **${abgabe.total}**`, `Erledigt: **${abgabe.submitted}**`, `Teilabgaben: **${abgabe.partial}**`, `Offen: **${abgabe.open}**`, `Spät: **${abgabe.late}**`, `Entschuldigt/Nachholen: **${abgabe.excused}**`], true),
      buildInfoField('📦 Abgaben je Bereich', Object.keys(ABGABEN).map(category => formatMemberAbgabeCategoryLine(guild, userId, category)), true),
      buildInfoField('📅 Termine', [`Gesamt: **${term.total}**`, `Kann: **${term.can}**`, `Vielleicht: **${term.maybe}**`, `Kann nicht: **${term.cannot}**`, `Abgemeldet: **${term.absent}**`, `Keine Antwort: **${term.noResponse}**`], true),
      buildInfoField('📋 Abmeldungen', [`Aktiv: **${absence.active}**`, `Anzahl: **${absence.count}**`, `Tage gesamt: **${absence.totalDays}**`, `Tage diesen Monat: **${absence.monthDays}**`], true),
      buildInfoField('🟢 Wache', wache.enabled === false ? ['**Nicht aktiviert**'] : [`Wochen erfasst: **${wache.weeks}**`, `Erfüllt: **${wache.fulfilled}**`, `Offen/nicht erfüllt: **${wache.open}**`, `Minuten gesamt: **${wache.minutes}**`], true),
      buildInfoField('⚖️ Sanktionen', [`Gesamt: **${sanctions.length}**`, `Offen: **${openSanctions}**`, `Decay-Penalty: **${reliability.sanctionPenalty || 0}**`, `Behavior-Modifier: **${reliability.behaviorModifier || 0}**`], true),
      buildInfoField('📈 Trend', [`Aktuell: **${trend.recent}%**`, `Vorher: **${trend.previous == null ? 'zu wenig Daten' : `${trend.previous}%`}**`, `Bewertung: **${trend.label}**`], true),
      buildInfoField('🧠 Muster', reliability.behaviorLabels?.length ? reliability.behaviorLabels : ['Keine starken Muster erkannt.'], true),
      buildInfoField('🧭 Empfehlung', recommend, false),
    )
    .setFooter({ text: 'Detailanalyse • vergangene Daten vor Serverbeitritt ignoriert • Score letzte 4 Wochen' })
    .setTimestamp(new Date());
}


let cashboxWebhookServer = null;

function sendJsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error('Payload zu groß.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function isCashboxWebhookAuthorized(req) {
  if (!CASHBOX_WEBHOOK_SECRET) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerSecret = String(req.headers['x-cashbox-secret'] || '').trim();
  return bearer === CASHBOX_WEBHOOK_SECRET || headerSecret === CASHBOX_WEBHOOK_SECRET;
}

async function handleExternalSaleWebhook(req, res) {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/sale') {
    return sendJsonResponse(res, 404, { ok: false, error: 'Nicht gefunden. Nutze POST /api/sale.' });
  }
  if (!isCashboxWebhookAuthorized(req)) {
    return sendJsonResponse(res, 401, { ok: false, error: 'Nicht autorisiert.' });
  }

  let payload;
  try {
    const raw = await readRequestBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    return sendJsonResponse(res, 400, { ok: false, error: `Ungültiges JSON: ${error.message}` });
  }

  const amount = Number(payload.ourShare ?? payload.our_share_amount ?? payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendJsonResponse(res, 400, { ok: false, error: 'amount/ourShare muss größer als 0 sein.' });
  }

  ensureCashboxShape();
  const externalId = String(payload.sale_id || payload.id || '').trim();
  if (externalId) {
    const existing = store.cashbox.transactions.find(tx => !tx.undone && tx.externalId === externalId);
    if (existing) {
      return sendJsonResponse(res, 200, { ok: true, duplicate: true, transactionId: existing.id, balance: store.cashbox.balance });
    }
  }

  const guild = client.guilds.cache.get(GUILD_ID) || null;
  try {
    const customer = String(payload.customer || '').trim();
    const title = String(payload.title || 'Externer Verkauf').trim();
    const noteParts = [
      externalId ? `sale_id=${externalId}` : '',
      customer ? `Kunde=${customer}` : '',
      payload.quantity ? `Menge=${payload.quantity}` : '',
      payload.total ? `Gesamt=${payload.total}` : '',
      payload.our_share_percent != null ? `Anteil=${payload.our_share_percent}%` : '',
    ].filter(Boolean);
    const tx = await addCashboxTransaction(
      guild,
      'income',
      'verkaufstermin',
      amount,
      String(payload.source || 'python_sales_bot'),
      title,
      { externalId, note: noteParts.join(' | ') }
    );
    if (guild) await upsertCashboxDashboardMessage(guild).catch(error => console.error('CASHBOX_DASHBOARD_UPDATE_ERROR', error));
    return sendJsonResponse(res, 200, { ok: true, transactionId: tx.id, amount: tx.amount, balance: store.cashbox.balance });
  } catch (error) {
    console.error('EXTERNAL_SALE_WEBHOOK_ERROR', error);
    return sendJsonResponse(res, 500, { ok: false, error: String(error.message || error) });
  }
}

function startCashboxWebhookServer() {
  if (cashboxWebhookServer) return;
  cashboxWebhookServer = http.createServer((req, res) => {
    (async () => {
      if (await handleWebSyncWebhook(req, res)) return;
      await handleExternalSaleWebhook(req, res);
    })().catch(error => {
      console.error('CASHBOX_WEBHOOK_SERVER_ERROR', error);
      sendJsonResponse(res, 500, { ok: false, error: 'Interner Serverfehler.' });
    });
  });
  cashboxWebhookServer.listen(CASHBOX_WEBHOOK_PORT, '127.0.0.1', () => {
    console.log(`Cashbox webhook listening on http://127.0.0.1:${CASHBOX_WEBHOOK_PORT}/api/sale`);
  });
}

client.once('clientReady', async () => {
  console.log(`Eingeloggt als ${client.user.tag} | Build ${BOT_BUILD}`);
  startCashboxWebhookServer();
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Slash-Commands registriert.');
  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await runStepSafe(guild, 'ensureGuildMembersCached', async () => ensureGuildMembersCached(guild));
    await runStepSafe(guild, 'seedRoleTrackingForGuild', async () => seedRoleTrackingForGuild(guild));
    if (isAutomationEnabled('dataIntegrity')) await runStepSafe(guild, 'validateAndRepairStoreData', async () => validateAndRepairStoreData());
    if (isAutomationEnabled('wacheReports')) await runStepSafe(guild, 'processWacheReports', async () => processWacheReports());
    await runStepSafe(guild, 'runRecoveryPass', async () => runRecoveryPass(guild));
    await runStepSafe(guild, 'restoreApprovalTimers', async () => restoreApprovalTimers(guild));
    await runStepSafe(guild, 'runRecoverySelfTest', async () => runRecoverySelfTest(guild));
    await runStepSafe(guild, 'cleanupExpiredAttendanceChecks', async () => cleanupExpiredAttendanceChecks(guild));
    await runStepSafe(guild, 'emitHealthLog', async () => emitHealthLog(guild, 'startup'));
  }
  saveAll();
});
process.on('unhandledRejection', async error => {
  const code = error?.code || error?.rawError?.code;
  if (code === 10062 || String(error?.message || '').includes('Unknown interaction')) return;
  console.error('UNHANDLED REJECTION', error);
  try { saveAll(); } catch {}
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) await logSystemEvent(guild, '🚨 Unhandled Rejection', [String(error?.stack || error)], COLORS.danger);
  } catch {}
});
process.on('uncaughtException', async error => {
  const code = error?.code || error?.rawError?.code;
  if (code === 10062 || String(error?.message || '').includes('Unknown interaction')) return;
  console.error('UNCAUGHT EXCEPTION', error);
  try { saveAll(); } catch {}
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) await logSystemEvent(guild, '💥 Uncaught Exception', [String(error?.stack || error)], COLORS.danger);
  } catch {}
});


// =========================================================
// V31: Discord/Web-Sync + Lang-/Kurzwaffen-Munition einheitlich
// =========================================================
function ammoLongV31(entry){ return Math.max(0, Math.round(Number(entry?.langwaffenMunition ?? entry?.munitionLang ?? entry?.longAmmo ?? entry?.langMunition ?? 0) || 0)); }
function ammoShortV31(entry){ return Math.max(0, Math.round(Number(entry?.kurzwaffenMunition ?? entry?.munitionKurz ?? entry?.shortAmmo ?? entry?.kurzMunition ?? entry?.munition ?? 0) || 0)); }
function setAmmoLongV31(entry, value){ const v=Math.max(0,Math.round(Number(value)||0)); entry.langwaffenMunition=v; entry.munitionLang=v; entry.longAmmo=v; }
function setAmmoShortV31(entry, value){ const v=Math.max(0,Math.round(Number(value)||0)); entry.kurzwaffenMunition=v; entry.munitionKurz=v; entry.shortAmmo=v; entry.munition=v; }
function normalizeInventoryEntryV31(entry){
  if(!entry || typeof entry!=='object') entry={};
  entry.weapons ||= {};
  if(!Number.isFinite(Number(entry.leichteWesten))) entry.leichteWesten=0;
  if(!Number.isFinite(Number(entry.schwereWesten))) entry.schwereWesten=Number(entry.westen||0)||0;
  setAmmoLongV31(entry, ammoLongV31(entry));
  setAmmoShortV31(entry, ammoShortV31(entry));
  return entry;
}
function normalizeInventoryStoreV31(){
  ensureInventoryShape?.();
  store.inventory ||= {items:{}};
  store.inventory.items ||= {};
  for(const [uid,entry] of Object.entries(store.inventory.items)) store.inventory.items[uid]=normalizeInventoryEntryV31(entry);
  if(store.inventory.family) normalizeFamilyWarehouseShapeV31();
}
function getInventoryEntry(userId) {
  ensureInventoryShape();
  if (!store.inventory.items[userId]) {
    const weapons = {};
    for (const weapon of INVENTORY_WEAPONS) weapons[weapon] = 0;
    store.inventory.items[userId] = { weapons, leichteWesten:0, schwereWesten:0, langwaffenMunition:0, kurzwaffenMunition:0, munition:0, updatedAt:0 };
  }
  const entry = normalizeInventoryEntryV31(store.inventory.items[userId]);
  for (const weapon of INVENTORY_WEAPONS) if (!Number.isFinite(Number(entry.weapons[weapon]))) entry.weapons[weapon] = 0;
  return entry;
}
function getInventoryValue(entry, key) {
  if (key === 'leichte_westen') return Number(entry.leichteWesten || 0);
  if (key === 'schwere_westen') return Number(entry.schwereWesten || 0);
  if (key === 'langwaffen_munition') return ammoLongV31(entry);
  if (key === 'kurzwaffen_munition' || key === 'munition') return ammoShortV31(entry);
  return Number(entry.weapons?.[key] || 0);
}
function setInventoryValue(entry, key, value) {
  const clean = Math.max(0, Math.round(Number(value || 0)));
  if (key === 'leichte_westen') entry.leichteWesten = clean;
  else if (key === 'schwere_westen') entry.schwereWesten = clean;
  else if (key === 'langwaffen_munition') setAmmoLongV31(entry, clean);
  else if (key === 'kurzwaffen_munition' || key === 'munition') setAmmoShortV31(entry, clean);
  else { entry.weapons ||= {}; entry.weapons[key] = clean; }
  entry.updatedAt = now();
}
function getInventoryItemLabel(key) {
  if (key === 'leichte_westen') return 'Leichte Westen';
  if (key === 'schwere_westen') return 'Schwere Westen';
  if (key === 'langwaffen_munition') return 'Langwaffen-Munition';
  if (key === 'kurzwaffen_munition' || key === 'munition') return 'Kurzwaffen-Munition';
  return key;
}
function buildInventoryPrivateStatus(guild, userId) {
  ensureInventoryEditorShape();
  const entry = getInventoryEntry(userId);
  const selected = store.sessions.inventoryEditors[userId]?.selected || 'kurzwaffen_munition';
  const weapons = INVENTORY_WEAPONS.map(w => Number(entry.weapons?.[w] || 0) > 0 ? `${w}: ${Number(entry.weapons[w])}` : null).filter(Boolean).join(' • ') || 'Keine Waffen';
  return [`**Ausgewählt:** ${getInventoryItemLabel(selected)}`,`**Menge:** ${getInventoryValue(entry, selected)}`,'',`Leichte Westen: **${Number(entry.leichteWesten || 0)}**`,`Schwere Westen: **${Number(entry.schwereWesten || 0)}**`,`Langwaffen-Munition: **${ammoLongV31(entry)}**`,`Kurzwaffen-Munition: **${ammoShortV31(entry)}**`,'',`Waffen: ${weapons}`].join('\n');
}
function buildInventoryEditorEmbed(guild, userId) {
  ensureInventoryEditorShape();
  const entry = getInventoryEntry(userId);
  const selected = store.sessions.inventoryEditors[userId]?.selected || 'kurzwaffen_munition';
  const weapons = INVENTORY_WEAPONS.map(w => Number(entry.weapons?.[w] || 0) > 0 ? `${w}: **${Number(entry.weapons[w])}**` : null).filter(Boolean);
  return new EmbedBuilder().setColor(COLORS.primary).setTitle('📦 Lagerbestand Bedienpanel').setDescription([
    `Ausgewählt: **${getInventoryItemLabel(selected)}**`, `Aktuelle Menge: **${getInventoryValue(entry, selected)}**`, '',
    `🦺 Leichte Westen: **${Number(entry.leichteWesten || 0)}**`, `🛡️ Schwere Westen: **${Number(entry.schwereWesten || 0)}**`,
    `🔫 Langwaffen-Munition: **${ammoLongV31(entry)}**`, `🔫 Kurzwaffen-Munition: **${ammoShortV31(entry)}**`, '',
    weapons.length ? weapons.join('\n') : 'Noch keine Waffen eingetragen.'
  ].join('\n').slice(0,4000));
}
function buildInventoryEditorComponents(userId) {
  ensureInventoryEditorShape();
  const selected = store.sessions.inventoryEditors[userId]?.selected || 'kurzwaffen_munition';
  const baseOptions = [
    { label:'Leichte Westen', value:'leichte_westen', emoji:'🦺' },
    { label:'Schwere Westen', value:'schwere_westen', emoji:'🛡️' },
    { label:'Langwaffen-Munition', value:'langwaffen_munition', emoji:'🔫' },
    { label:'Kurzwaffen-Munition', value:'kurzwaffen_munition', emoji:'🔫' },
  ];
  const weaponOptions = INVENTORY_WEAPONS.map(w => ({ label:w, value:w, emoji:'⚔️' }));
  const options = [...baseOptions, ...weaponOptions].slice(0,25).map(opt => ({...opt, default: opt.value === selected}));
  return [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('inventory_select_item').setPlaceholder('Waffe / Bestand auswählen').addOptions(options)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('inventory_dec_2').setLabel('-2').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('inventory_dec_1').setLabel('-1').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('inventory_reset_selected').setLabel('Zurücksetzen').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('inventory_inc_1').setLabel('+1').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('inventory_inc_2').setLabel('+2').setStyle(ButtonStyle.Secondary)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('inventory_dec_5').setLabel('-5').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('inventory_dec_10').setLabel('-10').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('inventory_spacer').setLabel('ㅤ').setStyle(ButtonStyle.Secondary).setDisabled(true),new ButtonBuilder().setCustomId('inventory_inc_5').setLabel('+5').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('inventory_inc_10').setLabel('+10').setStyle(ButtonStyle.Success)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('inventory_save_close').setLabel('✅ Speichern & schließen').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('inventory_refresh_dashboard').setLabel('🔄 Dashboard aktualisieren').setStyle(ButtonStyle.Secondary)),
  ];
}

function normalizeFamilyWarehouseShapeV31(){
  if(!store.inventory.family || typeof store.inventory.family !== 'object') store.inventory.family = {};
  const f=store.inventory.family;
  f.weapons ||= {};
  if(!Number.isFinite(Number(f.leichteWesten))) f.leichteWesten=0;
  if(!Number.isFinite(Number(f.schwereWesten))) f.schwereWesten=0;
  setAmmoLongV31(f, ammoLongV31(f));
  setAmmoShortV31(f, ammoShortV31(f));
  if(!Array.isArray(f.movements)) f.movements=[];
  f.minimums ||= {};
  if(typeof f.minimumWarningsEnabled !== 'boolean') f.minimumWarningsEnabled=true;
  f.lastMinimumWarnings ||= {};
  f.monthReports ||= {};
  return f;
}
function ensureFamilyWarehouseShape(){
  ensureInventoryShape();
  const f=normalizeFamilyWarehouseShapeV31();
  for(const weapon of INVENTORY_WEAPONS) if(!Number.isFinite(Number(f.weapons[weapon]))) f.weapons[weapon]=0;
  for(const item of getFamilyWarehouseItemOptions()) if(!Number.isFinite(Number(f.minimums[item.key])) || Number(f.minimums[item.key])<0) f.minimums[item.key]=0;
  return f;
}
function getFamilyWarehouseItemOptions(){
  return [
    {key:'langwaffen_munition', label:'Langwaffen-Munition', kind:'munition', emoji:'🔫'},
    {key:'kurzwaffen_munition', label:'Kurzwaffen-Munition', kind:'munition', emoji:'🔫'},
    {key:'leichte_westen', label:'Leichte Westen', kind:'vest', emoji:'🦺'},
    {key:'schwere_westen', label:'Schwere Westen', kind:'vest', emoji:'🛡️'},
    ...INVENTORY_WEAPONS.map(weapon=>({key:weapon,label:weapon,kind:'weapon',emoji:'⚔️'})),
  ];
}
function resolveWarehouseItem(input, fallbackCategory=''){
  const raw=String(input||'').trim(); const norm=normalizeText(raw || fallbackCategory); const fb=String(fallbackCategory||'').toLowerCase();
  if(['langwaffen-munition','langwaffenmunition','lang','langwaffen','longammo','langwaffen_munition'].includes(norm) || fb.includes('langwaffen')) return {key:'langwaffen_munition', label:'Langwaffen-Munition', kind:'munition'};
  if(['kurzwaffen-munition','kurzwaffenmunition','kurz','kurzwaffen','shortammo','kurzwaffen_munition'].includes(norm) || fb.includes('kurzwaffen')) return {key:'kurzwaffen_munition', label:'Kurzwaffen-Munition', kind:'munition'};
  if(['munition','muni','ammo'].includes(norm) || fb.includes('munition')) return {key:'kurzwaffen_munition', label:'Kurzwaffen-Munition', kind:'munition'};
  if(['leichte-westen','leichte-weste','leicht','weste-leicht','westen'].includes(norm)) return {key:'leichte_westen', label:'Leichte Westen', kind:'vest'};
  if(['schwere-westen','schwere-weste','schwer','weste-schwer'].includes(norm) || fb.includes('westen')) return {key:'schwere_westen', label:raw||'Schwere Westen', kind:'vest'};
  const aliases=new Map(); for(const weapon of INVENTORY_WEAPONS) aliases.set(normalizeText(weapon), weapon);
  aliases.set('smg','SMG'); aliases.set('pdw','PDW'); aliases.set('kampf-pdw','Kampf PDW'); aliases.set('karabiner','Karabiner'); aliases.set('ak','AK'); aliases.set('50er','50er'); aliases.set('fuenfziger','50er');
  const weapon=aliases.get(norm) || INVENTORY_WEAPONS.find(w=>normalizeText(w)===norm);
  if(weapon || fb.includes('waffen')) return {key: weapon || raw || 'SMG', label: weapon || raw || 'Waffe', kind:'weapon'};
  return {key:'sonstiges', label:raw||'Sonstiges', kind:'other'};
}
function getFamilyWarehouseValue(item){ const f=ensureFamilyWarehouseShape(); if(item.key==='langwaffen_munition') return ammoLongV31(f); if(item.key==='kurzwaffen_munition' || item.key==='munition') return ammoShortV31(f); if(item.key==='leichte_westen') return Number(f.leichteWesten||0); if(item.key==='schwere_westen') return Number(f.schwereWesten||0); if(item.kind==='weapon') return Number(f.weapons?.[item.key]||0); return 0; }
function setFamilyWarehouseValue(item,value){ const f=ensureFamilyWarehouseShape(); const clean=Math.max(0,Math.round(Number(value)||0)); if(item.key==='langwaffen_munition') setAmmoLongV31(f,clean); else if(item.key==='kurzwaffen_munition' || item.key==='munition') setAmmoShortV31(f,clean); else if(item.key==='leichte_westen') f.leichteWesten=clean; else if(item.key==='schwere_westen') f.schwereWesten=clean; else if(item.kind==='weapon'){ f.weapons ||= {}; f.weapons[item.key]=clean; } }
function formatFamilyWarehouseLines(){
  const f=ensureFamilyWarehouseShape();
  const weapons=INVENTORY_WEAPONS.map(w=>{ const amount=Number(f.weapons?.[w]||0); const min=getFamilyWarehouseMinimum(w); return (amount>0||min>0)?`${w}: ${formatWarehouseAmountWithMinimum(w, amount)}`:null; }).filter(Boolean);
  return [`🔫 Langwaffen-Munition: ${formatWarehouseAmountWithMinimum('langwaffen_munition', ammoLongV31(f))}`,`🔫 Kurzwaffen-Munition: ${formatWarehouseAmountWithMinimum('kurzwaffen_munition', ammoShortV31(f))}`,`🦺 Leichte Westen: ${formatWarehouseAmountWithMinimum('leichte_westen', Number(f.leichteWesten||0))}`,`🛡️ Schwere Westen: ${formatWarehouseAmountWithMinimum('schwere_westen', Number(f.schwereWesten||0))}`,weapons.length?`⚔️ Waffen: ${weapons.join(' • ')}`:'⚔️ Waffen: —',`🔔 Mindestbestand-Warnungen: **${f.minimumWarningsEnabled?'AN':'AUS'}**${f.minimumWarningChannelId?` • <#${f.minimumWarningChannelId}>`:''}`];
}
function needsWarehouseDetails(type, category){ return ['langwaffen_munition_verkauf','kurzwaffen_munition_verkauf','munition_verkauf','waffen_verkauf','westen_verkauf','waffen_kauf','langwaffen_munition_kauf','kurzwaffen_munition_kauf','munitions_kauf','munition_kauf','westen_kauf'].includes(String(category||'')); }
function isAmmoCashboxCategoryV31(category){ return String(category||'').includes('munition'); }
function buildCashboxItemSelect(type, category){
  const isWeapon=isWeaponCashboxCategory(category); const isAmmo=isAmmoCashboxCategoryV31(category);
  const options=isWeapon?INVENTORY_WEAPONS.map(w=>({label:w,value:w})):isAmmo?[{label:'Langwaffen-Munition',value:'langwaffen_munition',emoji:'🔫'},{label:'Kurzwaffen-Munition',value:'kurzwaffen_munition',emoji:'🔫'}]:[{label:'Leichte Westen',value:'leichte_westen',emoji:'🦺'},{label:'Schwere Westen',value:'schwere_westen',emoji:'🛡️'}];
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`cashbox_select_item:${type}:${category}`).setPlaceholder(isWeapon?'Welche Waffe?':isAmmo?'Welche Munition?':'Welche Westen?').addOptions(options.slice(0,25)))];
}
function cashboxCategoryNeedsItemSelect(category){ return isWeaponCashboxCategory(category) || isVestCashboxCategory(category) || isAmmoCashboxCategoryV31(category); }
function buildCashboxAmountModal(type, category, selectedItem=''){
  const catLabel=getCashboxCategoryLabel(type, category); const encodedItem=selectedItem?`:${encodeURIComponent(selectedItem)}`:'';
  const modal=new ModalBuilder().setCustomId(`cashbox_amount_modal:${type}:${category}${encodedItem}`).setTitle(`${type==='income'?'Einnahme':'Ausgabe'} erfassen`);
  if(needsWarehouseDetails(type, category)){
    const rows=[];
    if(!selectedItem) rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item').setLabel('Artikel').setPlaceholder('z. B. Langwaffen-Munition, SMG, Schwere Westen').setStyle(TextInputStyle.Short).setRequired(!String(category).includes('munition'))));
    rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel(isAmmoCashboxCategoryV31(category)?'Schüsse / Menge':'Menge/Stückzahl').setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('unitPrice').setLabel('Preis pro Stück/Schuss').setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(`Notiz optional (${catLabel})`).setStyle(TextInputStyle.Short).setRequired(false)));
    modal.addComponents(...rows); return modal;
  }
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Wie viel Geld? z. B. 3000000').setStyle(TextInputStyle.Short).setRequired(true)));
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(category==='sonstiges'?'Wofür?':`Notiz optional (${catLabel})`).setStyle(TextInputStyle.Short).setRequired(category==='sonstiges')));
  return modal;
}
function getCashboxCategories(type){
  const base = type === 'expense' ? CASHBOX_EXPENSE_CATEGORIES : CASHBOX_INCOME_CATEGORIES;
  const extra = type === 'expense'
    ? [{key:'langwaffen_munition_kauf',label:'Langwaffen-Munition Kauf'},{key:'kurzwaffen_munition_kauf',label:'Kurzwaffen-Munition Kauf'}]
    : [{key:'langwaffen_munition_verkauf',label:'Langwaffen-Munition Verkauf'},{key:'kurzwaffen_munition_verkauf',label:'Kurzwaffen-Munition Verkauf'}];
  const seen=new Set(); return [...extra,...base].filter(x=>x&&x.key&&!seen.has(x.key)&&(seen.add(x.key),true));
}
function getCashboxCategoryLabel(type,key,customReason=''){
  if(key==='sonstiges' && customReason) return customReason;
  const special={langwaffen_munition_verkauf:'Langwaffen-Munition Verkauf',kurzwaffen_munition_verkauf:'Kurzwaffen-Munition Verkauf',langwaffen_munition_kauf:'Langwaffen-Munition Kauf',kurzwaffen_munition_kauf:'Kurzwaffen-Munition Kauf',waffen_uebergabe_zahlung:'Waffen-Übergabe Zahlung',abgabe:'Wochenabgabe',sanktion_bezahlt:'Sanktion bezahlt',term_trade:'Termin Ankauf/Verkauf'};
  return special[key] || getCashboxCategories(type).find(x=>x.key===key)?.label || key || 'Sonstiges';
}
const __reloadAllFromDiskForWebSyncV31 = reloadAllFromDiskForWebSync;
function reloadAllFromDiskForWebSync(){
  const ok=__reloadAllFromDiskForWebSyncV31();
  try { normalizeInventoryStoreV31(); ensureFamilyWarehouseShape(); syncCustomAbgabeTypesIntoAbgaben?.(); } catch(e){ console.error('V31_NORMALIZE_AFTER_SYNC_ERROR', e); }
  return ok;
}
try { normalizeInventoryStoreV31(); } catch(e) { console.error('V31_INITIAL_NORMALIZE_ERROR', e); }

client.login(TOKEN);


// Interner Leader-Reminder Kanal für Auto-Sanktionswarnungen
const LEADER_REMINDER_CHANNEL_KEY = 'leader_reminder';


client.on('guildMemberAdd', async member => {
  try {
    rememberBloodEvent('Bloodin', member, 'Mitglied hat den Server betreten');
    console.log(`BLOODIN_SAVED_FOR_MEMBER ${member.id}`);
  } catch (error) {
    console.error('BLOODIN_GUILD_MEMBER_ADD_ERROR', error);
  }
});

client.on('guildMemberRemove', async member => {
  try {
    rememberBloodEvent('Bloodout', member, 'Mitglied hat den Server verlassen');
    const result = await removeInventoryEntry(member.guild, member.id, 'system', 'Mitglied hat den Server verlassen');
    if (result.changed) console.log(`INVENTORY_REMOVED_FOR_LEFT_MEMBER ${member.id}`);
  } catch (error) {
    console.error('INVENTORY_GUILD_MEMBER_REMOVE_ERROR', error);
  }
});
