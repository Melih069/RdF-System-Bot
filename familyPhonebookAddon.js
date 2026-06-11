const fs = require('fs');
const path = require('path');

function registerFamilyPhonebookAddon(client, h) {
  const {
    DATA_DIR,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
  } = h;

  const FILE_NUMBERS = path.join(DATA_DIR, 'numbers.json');
  const FILE_PHONEBOOK = path.join(DATA_DIR, 'phonebook.json');
  const FILE_FAMILIES = path.join(DATA_DIR, 'families_board.json');
  const FILE_CONFIG = path.join(DATA_DIR, 'config.json');
  const BACKUP_DIR = path.join(DATA_DIR, 'backups');
  const EMBED_COLOR = 0xD4AF37;
  const CATEGORY_ORDER = ['Kartell', 'Mafia', 'Syndikat', 'Gang', 'MC', 'Bauer'];
  const FAMILY_PAGE_SIZE = 18;

  const env = name => String(process.env[name] || '').trim();
  const idEnv = (...names) => names.map(env).find(Boolean) || '';
  function configData() {
    const data = readJson(FILE_CONFIG, { channels: {}, settings: {}, roles: {} });
    if (!data.channels || typeof data.channels !== 'object') data.channels = {};
    return data;
  }
  function channelId(key, ...envNames) {
    const cfg = configData();
    return String(cfg.channels?.[key] || idEnv(...envNames) || '').trim();
  }
  function verifyChannelId() { return channelId('verify', 'VERIFY_CHANNEL_ID'); }
  function welcomeChannelId() { return channelId('welcome', 'WELCOME_CHANNEL_ID'); }
  function phoneListChannelId() { return channelId('phone_list', 'PHONE_CHANNEL_ID'); }
  function familyListChannelId() { return channelId('family_list', 'FAMILY_LIST_CHANNEL_ID'); }
  function phonebookChannelId() { return channelId('phonebook', 'PHONEBOOK_CHANNEL_ID'); }

  function readConfigForWrite() {
    const data = readJson(FILE_CONFIG, { channels: {}, panelMessages: {}, settings: {}, roles: {} });
    if (!data.channels || typeof data.channels !== 'object') data.channels = {};
    if (!data.panelMessages || typeof data.panelMessages !== 'object') data.panelMessages = {};
    return data;
  }

  function getPanelMessageId(key) {
    const cfg = readConfigForWrite();
    return String(cfg.panelMessages?.[key]?.messageId || '').trim();
  }

  function savePanelMessageId(key, channelIdValue, messageId) {
    const cfg = readConfigForWrite();
    cfg.panelMessages[key] = {
      ...(cfg.panelMessages[key] || {}),
      channelId: String(channelIdValue || ''),
      messageId: String(messageId || ''),
      updatedAt: Date.now(),
    };
    writeJson(FILE_CONFIG, cfg);
  }

  const FAMILY_ROLE_ID = idEnv('VERIFY_ROLE_ID', 'FAMILY_ROLE_ID');
  const FAMILY_NAME = env('FAMILY_NAME') || 'Reyes del Fuego';
  const NAME_PREFIX_RAW = env('NAME_PREFIX') || 'RdF |';
  const NAME_PREFIX = NAME_PREFIX_RAW.endsWith('|') ? `${NAME_PREFIX_RAW} ` : `${NAME_PREFIX_RAW} | `;
  const BOT_PREFIX = env('BOT_PREFIX') || '!';
  const LEADER_IDS = new Set([
    ...String(process.env.LEADER_ROLE_IDS || '').split(','),
    ...String(process.env.LEADERSHIP_ROLE_IDS || '').split(','),
  ].map(x => x.trim()).filter(Boolean));

  function readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(fallback));
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error('[familyPhonebookAddon] JSON read error', file, err);
      return JSON.parse(JSON.stringify(fallback));
    }
  }

  function writeJson(file, data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      if (fs.existsSync(file)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(file, path.join(BACKUP_DIR, `${path.basename(file)}.${stamp}.bak`));
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('[familyPhonebookAddon] JSON write error', file, err);
      return false;
    }
  }

  function numbersData() {
    const data = readJson(FILE_NUMBERS, { members: {}, phone_message_id: null });
    if (!data.members || typeof data.members !== 'object') data.members = {};
    if (!('phone_message_id' in data)) data.phone_message_id = null;
    return data;
  }
  function phonebookData() {
    const data = readJson(FILE_PHONEBOOK, { message_id: null, last_query: '', families: {} });
    if (!data.families || typeof data.families !== 'object') data.families = {};
    if (!('message_id' in data)) data.message_id = null;
    if (!('last_query' in data)) data.last_query = '';
    return data;
  }
  function familiesData() {
    const data = readJson(FILE_FAMILIES, { families: {}, message_id: null, page_index: 0, search_query: '' });
    if (!data.families || typeof data.families !== 'object') data.families = {};
    for (const cat of CATEGORY_ORDER) if (!Array.isArray(data.families[cat])) data.families[cat] = [];
    if (!('message_id' in data)) data.message_id = null;
    if (!('page_index' in data)) data.page_index = 0;
    if (!('search_query' in data)) data.search_query = '';
    return data;
  }

  const clean = (s, n = 80) => String(s || '').trim().slice(0, n);
  const cleanNick = s => clean(s, 32);
  const cleanPhone = s => clean(s, 24);
  const isLeader = member => !!member?.roles?.cache?.some(r => LEADER_IDS.has(r.id));
  const requireLeader = async interaction => {
    if (isLeader(interaction.member)) return true;
    await interaction.reply({ content: 'Keine Berechtigung. Diese Funktion ist nur für Leaderschaft.', flags: 64 }).catch(() => null);
    return false;
  };

  async function getTextChannel(id) {
    if (!id) return null;
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return null;
    return ch;
  }

  async function findExistingBotPanel(channel, matcher) {
    if (!channel || typeof matcher !== 'function') return null;
    // Discord kann keine unbegrenzte Suche nach Bot-Nachrichten. 100 reicht aber meistens,
    // damit nach einem Neustart die alte Panel-Nachricht editiert wird statt neu zu senden.
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!recent) return null;
    return recent.find(m => m.author?.id === client.user?.id && matcher(m)) || null;
  }

  async function safeUpsert(channel, messageId, payload, options = {}) {
    if (!channel) return null;
    const panelKey = options.panelKey || '';
    const fallbackMessageId = panelKey ? getPanelMessageId(panelKey) : '';
    const ids = [...new Set([String(messageId || '').trim(), fallbackMessageId].filter(Boolean))];
    for (const id of ids) {
      const msg = await channel.messages.fetch(id).catch(() => null);
      if (msg) {
        const edited = await msg.edit(payload).catch(err => {
          console.error(`[familyPhonebookAddon] edit failed for ${panelKey || id}`, err?.message || err);
          return null;
        });
        if (edited) {
          if (panelKey) savePanelMessageId(panelKey, channel.id, edited.id);
          return edited;
        }
      }
    }

    const found = await findExistingBotPanel(channel, options.matcher).catch(() => null);
    if (found) {
      const edited = await found.edit(payload).catch(err => {
        console.error(`[familyPhonebookAddon] edit fallback failed for ${panelKey || 'panel'}`, err?.message || err);
        return null;
      });
      if (edited) {
        if (panelKey) savePanelMessageId(panelKey, channel.id, edited.id);
        return edited;
      }
    }

    const sent = await channel.send(payload).catch(err => { console.error('[familyPhonebookAddon] send failed', err); return null; });
    if (sent && panelKey) savePanelMessageId(panelKey, channel.id, sent.id);
    return sent;
  }

  function phoneListEmbed() {
    const data = numbersData();
    const members = data.members || {};
    const entries = Object.values(members).sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || ''), 'de'));
    const embed = new EmbedBuilder().setColor(EMBED_COLOR).setTitle(`${FAMILY_NAME} Telefonnummern`);
    if (!entries.length) {
      embed.setDescription('_Noch keine Nummern eingetragen._');
      embed.setFooter({ text: 'Mitglieder mit Nummer: 0' });
      return embed;
    }
    let description = entries.map(entry => `**${entry.nickname || 'Unbekannt'}** — \`${entry.phone || 'Keine Nummer'}\``).join('\n');
    if (description.length > 4000) description = `${description.slice(0, 4000)}\n_gekürzt..._`;
    embed.setDescription(description);
    embed.setFooter({ text: `Mitglieder mit Nummer: ${entries.length}` });
    return embed;
  }

  async function updatePhoneListMessage() {
    const channel = await getTextChannel(phoneListChannelId());
    if (!channel) return null;
    const data = numbersData();
    const msg = await safeUpsert(channel, data.phone_message_id, { embeds: [phoneListEmbed()], components: [] }, {
      panelKey: 'phone_list',
      matcher: m => m.embeds?.[0]?.title === `${FAMILY_NAME} Telefonnummern`,
    });
    if (msg && String(data.phone_message_id || '') !== String(msg.id)) {
      data.phone_message_id = msg.id;
      writeJson(FILE_NUMBERS, data);
    }
    return msg;
  }

  function verifyPanelEmbed() {
    return new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${FAMILY_NAME} Verifizierung`)
      .setDescription(
        'Klicke auf den Button und trage **Vorname**, **Nachname** und deine **Ingame Telefonnummer** ein.\n\n' +
        `Dein Nickname wird automatisch zu:\n**${NAME_PREFIX}Vorname Nachname**`
      )
      .setFooter({ text: `${FAMILY_NAME} Rollensystem` });
  }

  function verifyPanelComponents() {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('kan_verify_open').setStyle(ButtonStyle.Success).setLabel('Verifizieren')
    )];
  }
  async function upsertVerifyPanel() {
    const channel = await getTextChannel(verifyChannelId());
    if (!channel) return null;
    return safeUpsert(channel, getPanelMessageId('verify_panel'), { embeds: [verifyPanelEmbed()], components: verifyPanelComponents() }, {
      panelKey: 'verify_panel',
      matcher: m => m.embeds?.[0]?.title?.includes('Verifizierung'),
    });
  }

  function familyRowsForCategory(data, category) {
    return Array.isArray(data.families?.[category]) ? data.families[category] : [];
  }

  function parseLeaderLine(line) {
    const m = String(line || '').trim().match(/^\((12|11|10)\)\s*(.*)$/);
    return m ? { rank: m[1], name: m[2].trim() } : null;
  }

  function makeFamilyBlock(entry) {
    const leadership = Array.isArray(entry.leadership) ? entry.leadership : [];
    let leader12 = '—', leader11 = '—', leader10 = '—';
    for (const line of leadership) {
      const parsed = parseLeaderLine(line);
      if (!parsed) continue;
      if (parsed.rank === '12') leader12 = parsed.name || '—';
      if (parsed.rank === '11') leader11 = parsed.name || '—';
      if (parsed.rank === '10') leader10 = parsed.name || '—';
    }
    return [
      `PLZ: ${entry.plz || '—'}`,
      `Schlüssel: ${entry.schluessel || '—'}`,
      `12: ${leader12}`,
      `11: ${leader11}`,
      `10: ${leader10}`,
      `Datum: ${entry.datum_info || '—'}`,
      `Info: ${entry.infos || '—'}`,
    ].join('\n');
  }

  function buildFamilyPages(data) {
    const pages = [];
    for (const category of CATEGORY_ORDER) {
      const entries = familyRowsForCategory(data, category);
      const total = Math.max(1, Math.ceil(entries.length / FAMILY_PAGE_SIZE));
      for (let i = 0; i < total; i++) {
        pages.push({
          category,
          page_num: i + 1,
          page_total: total,
          entries: entries.slice(i * FAMILY_PAGE_SIZE, i * FAMILY_PAGE_SIZE + FAMILY_PAGE_SIZE),
        });
      }
    }
    for (const [category, entries] of Object.entries(data.families || {})) {
      if (CATEGORY_ORDER.includes(category) || !Array.isArray(entries)) continue;
      const total = Math.max(1, Math.ceil(entries.length / FAMILY_PAGE_SIZE));
      for (let i = 0; i < total; i++) {
        pages.push({ category, page_num: i + 1, page_total: total, entries: entries.slice(i * FAMILY_PAGE_SIZE, i * FAMILY_PAGE_SIZE + FAMILY_PAGE_SIZE) });
      }
    }
    return pages;
  }

  function makeFamilyPageEmbed(page) {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`${page.category} Kontakte`)
      .setDescription(`Übersicht aller Familien in **${page.category}**`)
      .setFooter({ text: `${page.category} Seite ${page.page_num}/${page.page_total}` });

    if (!page.entries.length) {
      embed.setDescription('_Keine Familien vorhanden._');
      return embed;
    }

    page.entries.forEach((entry, idx) => {
      const kuerzel = (entry.kuerzel || '-').trim() || '-';
      const familie = (entry.familie || 'Unbekannt').trim() || 'Unbekannt';
      embed.addFields({ name: `${kuerzel} | ${familie}`, value: makeFamilyBlock(entry).slice(0, 1024), inline: true });
      if ((idx + 1) % 3 === 0) embed.addFields({ name: ' ', value: ' ', inline: false });
    });
    const remainder = page.entries.length % 3;
    if (remainder !== 0) {
      for (let i = 0; i < 3 - remainder; i++) embed.addFields({ name: ' ', value: ' ', inline: true });
    }
    return embed;
  }

  function getCategoryStartPageIndex(pages, category) {
    const idx = pages.findIndex(p => p.category === category);
    return idx >= 0 ? idx : 0;
  }

  function getNextCategory(current) {
    const idx = CATEGORY_ORDER.indexOf(current);
    return CATEGORY_ORDER[(idx >= 0 ? idx + 1 : 0) % CATEGORY_ORDER.length];
  }

  function findFamilyMatches(query) {
    const data = familiesData();
    const q = clean(query, 80).toLowerCase();
    const results = [];
    for (const [category, entries] of Object.entries(data.families || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const text = `${category} ${entry.kuerzel || ''} ${entry.familie || ''} ${entry.plz || ''} ${entry.schluessel || ''} ${(entry.leadership || []).join(' ')} ${entry.infos || ''}`.toLowerCase();
        if (!q || text.includes(q)) results.push({ category, ...entry });
      }
    }
    return results;
  }

  function makeFamilySearchEmbed(query, matches) {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`Suche: ${query}`)
      .setDescription('Suchergebnisse in der Familienliste')
      .setFooter({ text: `${matches.length} Treffer${matches.length > 12 ? ' | erste 12 angezeigt' : ''}` });
    if (!matches.length) {
      embed.setDescription('_Keine Treffer gefunden._');
      embed.setFooter({ text: 'Suche' });
      return embed;
    }
    let description = matches.slice(0, 12).map(entry => {
      const kuerzel = (entry.kuerzel || '-').trim() || '-';
      const familie = (entry.familie || 'Unbekannt').trim() || 'Unbekannt';
      return `**${kuerzel} | ${familie}**\n${makeFamilyBlock(entry)}\nKategorie: ${entry.category}`;
    }).join('\n\n');
    if (description.length > 4000) description = `${description.slice(0, 4000)}\n\n_Weitere Treffer gekürzt..._`;
    embed.setDescription(description);
    return embed;
  }

  function buildFamilyBoardPayload(search = null) {
    const data = familiesData();
    if (search !== null) {
      const query = clean(search, 80);
      return { embeds: [makeFamilySearchEmbed(query, findFamilyMatches(query))], components: [familyBoardRow(true)] };
    }
    const pages = buildFamilyPages(data);
    if (!pages.length) pages.push({ category: 'Familien', page_num: 1, page_total: 1, entries: [] });
    data.page_index = Math.min(Math.max(Number(data.page_index || 0), 0), pages.length - 1);
    writeJson(FILE_FAMILIES, data);
    return { embeds: [makeFamilyPageEmbed(pages[data.page_index])], components: [familyBoardRow(false)] };
  }

  function familyBoardRow(searchMode = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('kan_family_prev').setStyle(ButtonStyle.Secondary).setLabel('⬅️ Vorherige Seite').setDisabled(searchMode),
      new ButtonBuilder().setCustomId('kan_family_category').setStyle(ButtonStyle.Primary).setLabel('📂 Kategorie').setDisabled(searchMode),
      new ButtonBuilder().setCustomId('kan_family_search').setStyle(ButtonStyle.Success).setLabel('🔎 Suche'),
      new ButtonBuilder().setCustomId('kan_family_home').setStyle(ButtonStyle.Primary).setLabel('🏠 Home'),
      new ButtonBuilder().setCustomId('kan_family_next').setStyle(ButtonStyle.Secondary).setLabel('➡️ Nächste Seite').setDisabled(searchMode),
    );
  }

  async function upsertFamilyBoardMessage(channelOverride = null) {
    const data = familiesData();
    const channel = channelOverride || await getTextChannel(familyListChannelId());
    if (!channel) return null;
    const msg = await safeUpsert(channel, data.message_id, buildFamilyBoardPayload(), {
      panelKey: 'family_board',
      matcher: m => String(m.embeds?.[0]?.title || '').includes('Kontakte') || String(m.embeds?.[0]?.title || '').includes('Familien-Kontaktliste'),
    });
    if (msg && String(data.message_id || '') !== String(msg.id)) {
      data.message_id = msg.id;
      writeJson(FILE_FAMILIES, data);
    }
    return msg;
  }

  function findPhonebookFamilies(data, query = '') {
    const q = clean(query, 80).toLowerCase();
    return Object.entries(data.families || {}).filter(([key, f]) => {
      const text = `${key} ${f.category || ''} ${f.kuerzel || ''} ${f.familie || ''} ${JSON.stringify(f)}`.toLowerCase();
      return !q || text.includes(q);
    });
  }

  function formatPhonebookSlot(entry, slot) {
    const item = entry?.[slot] || {};
    const name = String(item.name || '').trim() || '-';
    const nummer = String(item.nummer || '').trim();
    return nummer ? `${name} — \`${nummer}\`` : name;
  }

  function buildPhonebookPayload(query = null) {
    const data = phonebookData();
    if (query !== null) data.last_query = clean(query, 80);
    writeJson(FILE_PHONEBOOK, data);
    const matches = findPhonebookFamilies(data, data.last_query);
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(data.last_query ? `Telefonbuch Suche: ${data.last_query}` : 'Telefonbuch')
      .setDescription('Telefonnummern nach Familien. Suche über den Button unten.');

    if (!matches.length) {
      embed.setDescription('_Keine Treffer gefunden._');
      embed.setFooter({ text: 'Telefonbuch' });
      return { embeds: [embed], components: [phonebookRow()] };
    }

    for (const [, entry] of matches.slice(0, 12)) {
      const kuerzel = (entry.kuerzel || '-').trim() || '-';
      const familie = (entry.familie || 'Unbekannt').trim() || 'Unbekannt';
      const category = (entry.category || '-').trim() || '-';
      const value = [
        `**12:** ${formatPhonebookSlot(entry, '12')}`,
        `**11:** ${formatPhonebookSlot(entry, '11')}`,
        `**10:** ${formatPhonebookSlot(entry, '10')}`,
        `**RV1:** ${formatPhonebookSlot(entry, 'rv1')}`,
        `**RV2:** ${formatPhonebookSlot(entry, 'rv2')}`,
        `**Kategorie:** ${category}`,
      ].join('\n');
      embed.addFields({ name: `${kuerzel} | ${familie}`, value: value.slice(0, 1024), inline: true });
    }
    embed.setFooter({ text: `${Math.min(matches.length, 12)} Treffer angezeigt${matches.length > 12 ? ` • ${matches.length} gesamt` : ''}` });
    return { embeds: [embed], components: [phonebookRow()] };
  }

  function phonebookRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('kan_phonebook_search').setStyle(ButtonStyle.Success).setLabel('🔎 Familie suchen'),
      new ButtonBuilder().setCustomId('kan_phonebook_home').setStyle(ButtonStyle.Primary).setLabel('🏠 Telefonbuch')
    );
  }

  async function upsertPhonebookMessage(channelOverride = null, query = null) {
    const data = phonebookData();
    const channel = channelOverride || await getTextChannel(phonebookChannelId());
    if (!channel) return null;
    const msg = await safeUpsert(channel, data.message_id, buildPhonebookPayload(query), {
      panelKey: 'phonebook',
      matcher: m => String(m.embeds?.[0]?.title || '').includes('Telefonbuch'),
    });
    if (msg && String(data.message_id || '') !== String(msg.id)) {
      data.message_id = msg.id;
      writeJson(FILE_PHONEBOOK, data);
    }
    return msg;
  }

  function phonebookKey(category, kuerzel, familie) {
    return `${clean(category, 30) || '-'}:${clean(kuerzel, 30) || '-'}:${clean(familie, 80)}`;
  }
  function findPhonebookKeyByFamily(data, familie) {
    const q = clean(familie, 80).toLowerCase();
    return Object.keys(data.families || {}).find(k => k.toLowerCase() === q || String(data.families[k]?.familie || '').toLowerCase() === q || String(data.families[k]?.kuerzel || '').toLowerCase() === q) || null;
  }

  async function handleVerifySubmit(interaction) {
    const ingame = cleanNick(interaction.fields.getTextInputValue('kan_verify_name'));
    const phone = cleanPhone(interaction.fields.getTextInputValue('kan_verify_phone'));
    if (!ingame || !phone) return interaction.reply({ content: 'Bitte Name und Telefonnummer eintragen.', flags: 64 });
    const nickname = `${NAME_PREFIX}${ingame}`.slice(0, 32);
    const member = interaction.member;
    const warnings = [];
    if (FAMILY_ROLE_ID) await member.roles.add(FAMILY_ROLE_ID).catch(err => warnings.push(`Rolle konnte nicht vergeben werden: ${err.message}`));
    await member.setNickname(nickname).catch(err => warnings.push(`Nickname konnte nicht geändert werden: ${err.message}`));
    const data = numbersData();
    data.members[interaction.user.id] = { nickname, phone };
    writeJson(FILE_NUMBERS, data);
    await updatePhoneListMessage().catch(() => null);
    // Keine öffentliche Extra-Nachricht nach der Verifizierung.
    // Blood-In/Willkommen läuft ausschließlich über die eine Embed-Nachricht beim Serverbeitritt.
    return interaction.reply({ content: `✅ Verifiziert als **${nickname}** mit Nummer **${phone}**.${warnings.length ? `\n⚠️ ${warnings.join('\n')}` : ''}`, flags: 64 });
  }

  function buildSearchModal(kind) {
    const modal = new ModalBuilder().setCustomId(kind === 'family' ? 'kan_family_search_modal' : 'kan_phonebook_search_modal').setTitle(kind === 'family' ? 'Familie suchen' : 'Telefonbuch suchen');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('query').setLabel('Suchbegriff').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
    ));
    return modal;
  }

  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isButton?.()) {
        const id = interaction.customId;
        if (id === 'kan_verify_open') {
          const modal = new ModalBuilder().setCustomId('kan_verify_submit').setTitle('Verifizierung');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('kan_verify_name').setLabel('Ingame-Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('kan_verify_phone').setLabel('Telefonnummer').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(24))
          );
          return interaction.showModal(modal);
        }
        if (id === 'kan_family_prev' || id === 'kan_family_next' || id === 'kan_family_home' || id === 'kan_family_category') {
          const data = familiesData();
          const pages = buildFamilyPages(data);
          if (id === 'kan_family_home') { data.search_query = ''; data.page_index = 0; }
          if (id === 'kan_family_prev') data.page_index = (Number(data.page_index || 0) - 1 + pages.length) % pages.length;
          if (id === 'kan_family_next') data.page_index = (Number(data.page_index || 0) + 1) % pages.length;
          if (id === 'kan_family_category') {
            const current = pages[Math.min(Math.max(Number(data.page_index || 0), 0), pages.length - 1)]?.category || CATEGORY_ORDER[0];
            data.page_index = getCategoryStartPageIndex(pages, getNextCategory(current));
          }
          writeJson(FILE_FAMILIES, data);
          return interaction.update(buildFamilyBoardPayload());
        }
        if (id === 'kan_family_search') return interaction.showModal(buildSearchModal('family'));
        if (id === 'kan_phonebook_search') return interaction.showModal(buildSearchModal('phonebook'));
        if (id === 'kan_phonebook_home') return interaction.update(buildPhonebookPayload(''));
      }
      if (interaction.isModalSubmit?.()) {
        if (interaction.customId === 'kan_verify_submit') return handleVerifySubmit(interaction);
        if (interaction.customId === 'kan_family_search_modal') {
          const q = clean(interaction.fields.getTextInputValue('query'), 80);
          return interaction.update ? interaction.update(buildFamilyBoardPayload(q)) : interaction.reply({ ...buildFamilyBoardPayload(q), flags: 64 });
        }
        if (interaction.customId === 'kan_phonebook_search_modal') {
          const q = clean(interaction.fields.getTextInputValue('query'), 80);
          return interaction.reply({ ...buildPhonebookPayload(q), flags: 64 });
        }
      }
      if (interaction.isChatInputCommand?.()) {
        const cmd = interaction.commandName;
        if (cmd === 'verify-panel') {
          if (!await requireLeader(interaction)) return;
          await upsertVerifyPanel();
          return interaction.reply({ content: '✅ Verifizierungs-Panel wurde erstellt/aktualisiert.', flags: 64 });
        }
        if (cmd === 'telefonliste') {
          if (!await requireLeader(interaction)) return;
          await updatePhoneListMessage();
          return interaction.reply({ content: '✅ Mitglieder-Telefonliste wurde aktualisiert.', flags: 64 });
        }
        if (cmd === 'telefonbuch') {
          await upsertPhonebookMessage(interaction.channel, '');
          return interaction.reply({ content: '✅ Telefonbuch wurde gesendet/aktualisiert.', flags: 64 });
        }
        if (cmd === 'familienpanel') {
          await upsertFamilyBoardMessage(interaction.channel);
          return interaction.reply({ content: '✅ Familienpanel wurde gesendet/aktualisiert.', flags: 64 });
        }
        if (cmd === 'phonebook_set') {
          if (!await requireLeader(interaction)) return;
          const familie = interaction.options.getString('familie', true);
          const slot = interaction.options.getString('slot', true).toLowerCase();
          const name = clean(interaction.options.getString('name', true), 60);
          const nummer = cleanPhone(interaction.options.getString('nummer') || '');
          if (!['12','11','10','rv1','rv2'].includes(slot)) return interaction.reply({ content: 'Slot muss 12, 11, 10, rv1 oder rv2 sein.', flags: 64 });
          const data = phonebookData();
          const key = findPhonebookKeyByFamily(data, familie);
          if (!key) return interaction.reply({ content: 'Familie nicht gefunden. Nutze /phonebook_addfamily.', flags: 64 });
          data.families[key][slot] = { name, nummer };
          writeJson(FILE_PHONEBOOK, data);
          await upsertPhonebookMessage(null, data.last_query).catch(() => null);
          return interaction.reply({ content: `✅ ${data.families[key].familie} • ${slot} gespeichert.`, flags: 64 });
        }
        if (cmd === 'phonebook_delete') {
          if (!await requireLeader(interaction)) return;
          const familie = interaction.options.getString('familie', true);
          const slot = interaction.options.getString('slot', true).toLowerCase();
          const data = phonebookData();
          const key = findPhonebookKeyByFamily(data, familie);
          if (!key || !data.families[key]?.[slot]) return interaction.reply({ content: 'Eintrag nicht gefunden.', flags: 64 });
          data.families[key][slot] = { name: '', nummer: '' };
          writeJson(FILE_PHONEBOOK, data);
          await upsertPhonebookMessage(null, data.last_query).catch(() => null);
          return interaction.reply({ content: `✅ ${data.families[key].familie} • ${slot} gelöscht.`, flags: 64 });
        }
        if (cmd === 'phonebook_addfamily') {
          if (!await requireLeader(interaction)) return;
          const familie = clean(interaction.options.getString('familie', true), 80);
          const kuerzel = clean(interaction.options.getString('kuerzel') || '-', 20);
          const category = clean(interaction.options.getString('category') || '-', 30);
          const data = phonebookData();
          const key = phonebookKey(category, kuerzel, familie);
          data.families[key] = data.families[key] || { category, kuerzel, familie, '12': {name:'', nummer:''}, '11': {name:'', nummer:''}, '10': {name:'', nummer:''}, rv1: {name:'', nummer:''}, rv2: {name:'', nummer:''} };
          writeJson(FILE_PHONEBOOK, data);
          await upsertPhonebookMessage(null, data.last_query).catch(() => null);
          return interaction.reply({ content: `✅ Familie **${familie}** im Telefonbuch angelegt.`, flags: 64 });
        }
        if (cmd === 'family_add') {
          if (!await requireLeader(interaction)) return;
          const category = clean(interaction.options.getString('category', true), 30);
          const entry = {
            kuerzel: clean(interaction.options.getString('kuerzel', true), 20),
            familie: clean(interaction.options.getString('familie', true), 80),
            plz: clean(interaction.options.getString('plz') || '', 30),
            schluessel: clean(interaction.options.getString('schluessel') || '-', 20),
            leadership: [interaction.options.getString('leadership12'), interaction.options.getString('leadership11'), interaction.options.getString('leadership10')].filter(Boolean).map(x => clean(x, 80)),
            datum_info: clean(interaction.options.getString('datum_info') || '', 30),
            infos: clean(interaction.options.getString('infos') || '', 120),
          };
          const data = familiesData();
          data.families[category] ||= [];
          data.families[category].push(entry);
          writeJson(FILE_FAMILIES, data);
          await upsertFamilyBoardMessage().catch(() => null);
          return interaction.reply({ content: `✅ Familie **${entry.familie}** wurde hinzugefügt.`, flags: 64 });
        }
        if (cmd === 'family_edit') {
          if (!await requireLeader(interaction)) return;
          const category = clean(interaction.options.getString('category', true), 30);
          const kuerzel = clean(interaction.options.getString('kuerzel', true), 20).toLowerCase();
          const feld = clean(interaction.options.getString('feld', true), 30);
          const wert = clean(interaction.options.getString('wert', true), 200);
          const data = familiesData();
          const entry = (data.families[category] || []).find(e => String(e.kuerzel || '').toLowerCase() === kuerzel || String(e.familie || '').toLowerCase() === kuerzel);
          if (!entry) return interaction.reply({ content: 'Familie nicht gefunden.', flags: 64 });
          if (feld === 'leadership') entry.leadership = wert.split('|').map(x => clean(x, 80)).filter(Boolean);
          else if (['kuerzel','familie','plz','schluessel','datum_info','infos'].includes(feld)) entry[feld] = wert;
          else return interaction.reply({ content: 'Feld erlaubt: kuerzel, familie, plz, schluessel, leadership, datum_info, infos.', flags: 64 });
          writeJson(FILE_FAMILIES, data);
          await upsertFamilyBoardMessage().catch(() => null);
          return interaction.reply({ content: `✅ **${entry.familie}** wurde aktualisiert.`, flags: 64 });
        }
        if (cmd === 'family_delete') {
          if (!await requireLeader(interaction)) return;
          const category = clean(interaction.options.getString('category', true), 30);
          const kuerzel = clean(interaction.options.getString('kuerzel', true), 20).toLowerCase();
          const data = familiesData();
          const before = (data.families[category] || []).length;
          data.families[category] = (data.families[category] || []).filter(e => String(e.kuerzel || '').toLowerCase() !== kuerzel && String(e.familie || '').toLowerCase() !== kuerzel);
          writeJson(FILE_FAMILIES, data);
          await upsertFamilyBoardMessage().catch(() => null);
          return interaction.reply({ content: before !== data.families[category].length ? '✅ Familie gelöscht.' : 'Familie nicht gefunden.', flags: 64 });
        }
      }
    } catch (err) {
      console.error('[familyPhonebookAddon] interaction error', err);
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `Fehler: ${err.message || err}`, flags: 64 }).catch(() => null);
      }
    }
  });

  client.on('messageCreate', async message => {
    try {
      if (!message.guild || message.author.bot || !message.content?.startsWith(BOT_PREFIX)) return;
      if (!isLeader(message.member)) return;
      const [name, ...rest] = message.content.slice(BOT_PREFIX.length).trim().split(/\s+/);
      if (!['importnumbers', 'removenumbers'].includes(String(name || '').toLowerCase())) return;
      const body = rest.join(' ');
      if (!body) return message.reply('Bitte Einträge anhängen. Format pro Zeile: `@User | Name | Nummer` oder `UserID | Name | Nummer`.');
      const data = numbersData();
      const lines = body.split(/\n|;/).map(x => x.trim()).filter(Boolean);
      let changed = 0;
      for (const line of lines) {
        const parts = line.split('|').map(x => x.trim());
        const idMatch = line.match(/(\d{16,22})/);
        if (!idMatch) continue;
        const id = idMatch[1];
        if (name.toLowerCase() === 'removenumbers') {
          if (data.members[id]) { delete data.members[id]; changed++; }
        } else {
          const nickRaw = parts[1] || line.replace(id, '').split(/\s{2,}/)[0] || 'Unbekannt';
          const phone = parts[2] || '';
          const nickname = nickRaw.startsWith(NAME_PREFIX_RAW) ? cleanNick(nickRaw) : `${NAME_PREFIX}${cleanNick(nickRaw)}`.slice(0, 32);
          data.members[id] = { nickname, phone: cleanPhone(phone) };
          changed++;
        }
      }
      writeJson(FILE_NUMBERS, data);
      await updatePhoneListMessage().catch(() => null);
      await message.reply(`✅ ${changed} Einträge verarbeitet.`).catch(() => null);
    } catch (err) { console.error('[familyPhonebookAddon] message command error', err); }
  });

  const recentWelcomeEmbeds = new Map();
  client.on('guildMemberAdd', async member => {
    const ch = await getTextChannel(welcomeChannelId());
    if (!ch) return;

    // Genau eine öffentliche Blood-In/Willkommensnachricht.
    // Schutz gegen doppelte Events/mehrfach gestartete Handler im selben Prozess.
    const last = recentWelcomeEmbeds.get(member.id) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    recentWelcomeEmbeds.set(member.id, Date.now());

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`Willkommen bei ${FAMILY_NAME}`)
      .setDescription(`<@${member.id}> ist dem Server beigetreten.`)
      .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) || null)
      .setFooter({ text: `${FAMILY_NAME} Rollensystem` })
      .setTimestamp();

    ch.send({ embeds: [embed] }).catch(() => null);
  });

  client.on('guildMemberRemove', async member => {
    const data = numbersData();
    if (data.members[member.id]) {
      delete data.members[member.id];
      writeJson(FILE_NUMBERS, data);
      await updatePhoneListMessage().catch(() => null);
    }
  });

  client.once('clientReady', async () => {
    if (verifyChannelId()) await upsertVerifyPanel().catch(err => console.error('[familyPhonebookAddon] verify panel startup error', err));
    if (phoneListChannelId()) await updatePhoneListMessage().catch(err => console.error('[familyPhonebookAddon] phone list startup error', err));
    if (familyListChannelId()) await upsertFamilyBoardMessage().catch(err => console.error('[familyPhonebookAddon] family board startup error', err));
    if (phonebookChannelId()) await upsertPhonebookMessage().catch(err => console.error('[familyPhonebookAddon] phonebook startup error', err));
    console.log('[familyPhonebookAddon] Verifizierung/Familien/Telefonbuch aktiv.');
  });
}

const familyPhonebookCommands = SlashCommandBuilder => [
  new SlashCommandBuilder().setName('verify-panel').setDescription('Verifizierungs-Panel senden oder aktualisieren'),
  new SlashCommandBuilder().setName('telefonliste').setDescription('Interne Mitglieder-Telefonliste aktualisieren'),
  new SlashCommandBuilder().setName('telefonbuch').setDescription('Telefonbuch senden oder aktualisieren'),
  new SlashCommandBuilder().setName('familienpanel').setDescription('Familien-Kontaktliste senden oder aktualisieren'),
  new SlashCommandBuilder().setName('phonebook_set').setDescription('Telefonbuch-Eintrag setzen oder bearbeiten')
    .addStringOption(o => o.setName('familie').setDescription('Familienname oder Kürzel').setRequired(true))
    .addStringOption(o => o.setName('slot').setDescription('12, 11, 10, rv1 oder rv2').setRequired(true).addChoices({name:'12er',value:'12'},{name:'11er',value:'11'},{name:'10er',value:'10'},{name:'RV 1',value:'rv1'},{name:'RV 2',value:'rv2'}))
    .addStringOption(o => o.setName('name').setDescription('Name').setRequired(true))
    .addStringOption(o => o.setName('nummer').setDescription('Telefonnummer').setRequired(false)),
  new SlashCommandBuilder().setName('phonebook_delete').setDescription('Telefonbuch-Slot löschen')
    .addStringOption(o => o.setName('familie').setDescription('Familienname oder Kürzel').setRequired(true))
    .addStringOption(o => o.setName('slot').setDescription('12, 11, 10, rv1 oder rv2').setRequired(true).addChoices({name:'12er',value:'12'},{name:'11er',value:'11'},{name:'10er',value:'10'},{name:'RV 1',value:'rv1'},{name:'RV 2',value:'rv2'})),
  new SlashCommandBuilder().setName('phonebook_addfamily').setDescription('Neue Familie im Telefonbuch anlegen')
    .addStringOption(o => o.setName('familie').setDescription('Familienname').setRequired(true))
    .addStringOption(o => o.setName('kuerzel').setDescription('Kürzel').setRequired(false))
    .addStringOption(o => o.setName('category').setDescription('Kategorie').setRequired(false)),
  new SlashCommandBuilder().setName('family_add').setDescription('Neue Familie zur Kontaktliste hinzufügen')
    .addStringOption(o => o.setName('category').setDescription('Kategorie').setRequired(true))
    .addStringOption(o => o.setName('kuerzel').setDescription('Kürzel').setRequired(true))
    .addStringOption(o => o.setName('familie').setDescription('Familienname').setRequired(true))
    .addStringOption(o => o.setName('plz').setDescription('PLZ/Standort').setRequired(false))
    .addStringOption(o => o.setName('schluessel').setDescription('Schlüsselstatus').setRequired(false))
    .addStringOption(o => o.setName('leadership12').setDescription('(12) Name').setRequired(false))
    .addStringOption(o => o.setName('leadership11').setDescription('(11) Name').setRequired(false))
    .addStringOption(o => o.setName('leadership10').setDescription('(10) Name').setRequired(false))
    .addStringOption(o => o.setName('datum_info').setDescription('Datum/Info').setRequired(false))
    .addStringOption(o => o.setName('infos').setDescription('Zusatzinfos').setRequired(false)),
  new SlashCommandBuilder().setName('family_edit').setDescription('Bestehende Familie bearbeiten')
    .addStringOption(o => o.setName('category').setDescription('Kategorie').setRequired(true))
    .addStringOption(o => o.setName('kuerzel').setDescription('Kürzel oder Familienname').setRequired(true))
    .addStringOption(o => o.setName('feld').setDescription('Feld').setRequired(true).addChoices(
      {name:'Kürzel',value:'kuerzel'},{name:'Familie',value:'familie'},{name:'PLZ',value:'plz'},{name:'Schlüssel',value:'schluessel'},{name:'Leadership',value:'leadership'},{name:'Datum Info',value:'datum_info'},{name:'Infos',value:'infos'}))
    .addStringOption(o => o.setName('wert').setDescription('Neuer Wert; Leadership mit | trennen').setRequired(true)),
  new SlashCommandBuilder().setName('family_delete').setDescription('Familie aus der Kontaktliste löschen')
    .addStringOption(o => o.setName('category').setDescription('Kategorie').setRequired(true))
    .addStringOption(o => o.setName('kuerzel').setDescription('Kürzel oder Familienname').setRequired(true)),
];

module.exports = { registerFamilyPhonebookAddon, familyPhonebookCommands };
