let DATA = null;
let current = 'overview';
let token = localStorage.getItem('dashboardToken') || '';
let selectedFamily = null;
let currentMapRegion = 'overview';
let mapPickMode = false;
let socket = null;

const allPages = [
  ['overview','Übersicht','Command Center','overview'],
  ['map','Familienkarte','Interaktive Karte','map'],
  ['families','Familien','PLZ, Schlüssel, Leadership','families'],
  ['phonebook','Telefonbuch','12er / 11er / 10er / RV','phonebook'],
  ['members','Eigene Mitglieder','Nummern & Discord IDs','members'],
  ['abgaben','Abgaben','Wochenstatus bearbeiten','abgaben'],
  ['abgabenStats','Statistiken','Abgaben oder Wache auswerten','abgabenStats'],
  ['sanctions','Ausgeteilte Sanktionen','Strafen & Bloodouts','sanctions'],
  ['blood','Bloodin / Bloodout','Blood-Lifecycle','blood'],
  ['cashbox','Familienkasse','Transaktionen','cashbox'],
  ['trading','Rechner & Ausleihe','Preise, Verkäufe, Fahrzeuge','cashbox'],
  ['inventory','Lager','Waffen, Westen, Munition','inventory'],
  ['terms','Termine','Antworten & Abstimmungen','terms'],
  ['absences','Abmeldungen','aktive/inaktive Abmeldungen','absences'],
  ['config','Monitoring','Stats & aktuelle Woche','config'],
  ['leader_all','Zentrale Verwaltung','Leader Panel · Systemsteuerung · Admin Panel','leader_all']
];
let pages = allPages;
const CENTRAL_PAGE_ID = 'leader_all';
const CENTRAL_PAGE_META = ['leader_all','Zentrale Verwaltung','Leader Panel · Systemsteuerung · Admin Panel','leader_all'];
function normalizePageId(id){ return id === 'settings' ? CENTRAL_PAGE_ID : id; }
function isAdminUser(){ return !!(DATA?.me?.permissions?.roleGroups?.isAdminUser || DATA?.me?.permissions?.actions?.admin || DATA?.me?.permissions?.actions?.dashboardAdmin); }
function authorizedPages(){
  const base = isAdminUser() ? allPages : allPages.filter(p=>mod(p[3]));
  const seen = new Set();
  const out = [];
  for(const raw of base){
    if(!raw) continue;
    const id = normalizePageId(raw[0]);
    if(seen.has(id)) continue;
    seen.add(id);
    out.push(id === CENTRAL_PAGE_ID ? CENTRAL_PAGE_META : raw);
  }
  return out;
}
function syncPages(){ pages = authorizedPages(); return pages; }
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>\"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m]));
const money = n => n === null || n === undefined ? '—' : new Intl.NumberFormat('de-DE').format(Number(n||0)) + ' $';
function compactCardValue(v){
  const s = String(v ?? '');
  const m = s.match(/^([0-9.]+)\s*\$$/);
  if(m){
    const num = Number(m[1].replace(/\./g,''));
    if(Number.isFinite(num) && Math.abs(num) >= 1000000) return new Intl.NumberFormat('de-DE',{maximumFractionDigits:2}).format(num/1000000) + ' Mio. $';
    if(Number.isFinite(num) && Math.abs(num) >= 100000) return new Intl.NumberFormat('de-DE',{maximumFractionDigits:0}).format(num/1000) + ' Tsd. $';
  }
  return s;
}
const dt = v => !v ? '—' : new Date(Number(v) || v).toLocaleString('de-DE');
const short = (s,n=34) => String(s||'').length>n?String(s).slice(0,n-1)+'…':String(s||'');
const q = () => ($('#globalSearch')?.value || '').toLowerCase().trim();
const perms = () => DATA?.me?.permissions || { modules:{}, actions:{} };
const can = k => !!perms().actions?.[k];
const mod = k => !!perms().modules?.[k];
const authHeaders = () => token ? { 'Authorization': 'Bearer '+token, 'Content-Type':'application/json' } : { 'Content-Type':'application/json' };
function toast(msg){ const el=document.createElement('div'); el.className='toast'; el.textContent=msg; document.body.appendChild(el); setTimeout(()=>el.remove(),2800); }
function setTokenAndLoad(){ token=$('#tokenInput').value.trim(); localStorage.setItem('dashboardToken',token); loadPublicAuthInfo();
load(); }
async function logout(){ try{ await fetch('/auth/logout',{method:'POST'}); }catch(_){} localStorage.removeItem('dashboardToken'); location.reload(); }
async function api(path, opts={}){ const res=await fetch(path,{...opts,headers:{...authHeaders(),...(opts.headers||{})}}); if(!res.ok) throw new Error((await res.json().catch(()=>({error:res.statusText}))).error||res.statusText); return res.json(); }
async function loadPublicAuthInfo(){ const el=document.getElementById('publicAuthInfo'); if(el) el.classList.add('hidden'); }
async function load(){ try{ DATA=await api('/api/bootstrap'); window.DATA=DATA; window.ME=DATA?.me; $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); syncPages(); if(!pages.find(p=>p[0]===current)) current=pages[0]?.[0]||'overview'; buildNav(); userBox(); connectSocket(); renderCurrent(); }catch(e){ $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); loadPublicAuthInfo(); if(token) toast('Login/API Fehler: '+e.message); } }
async function refresh(silent=false){ DATA=await api('/api/bootstrap'); window.DATA=DATA; window.ME=DATA?.me; syncPages(); userBox(); renderCurrent(); if(!silent) toast('Daten aktualisiert'); }
function userBox(){ const u=DATA?.me; $('#userBox').innerHTML=u?`<b>${esc(u.serverName||u.displayName||u.globalName||u.username||u.id)}</b><em>${esc(u.accessLabel||'Mitglied')}</em><em>Discord ID:<br>${esc(u.id)}</em>`:''; updateTopControls(); }
function connectSocket(){ if(socket) return; socket=io(); socket.on('connect',()=>{$('#syncState').classList.add('online'); $('#syncState').lastChild.textContent=' online';}); socket.on('disconnect',()=>{$('#syncState').classList.remove('online'); $('#syncState').lastChild.textContent=' offline';}); socket.on('data:update', async ev=>{ await refresh(true); toast('Live-Update: '+ev.type); }); }
function buildNav(){
  const nav=$('#nav'); if(!nav) return;
  nav.innerHTML=(pages||[]).map(p=>`<button class="navbtn ${current===p[0]?'active':''}" onclick="go('${p[0]}')"><span>${icon(p[0])}</span>${esc(p[1])}</button>`).join('');
}
function icon(k){return {overview:'⌂',map:'⌖',families:'◇',phonebook:'☏',members:'♟',abgaben:'◆',abgabenStats:'％',sanctions:'⚖',blood:'◈',cashbox:'$',trading:'🧮',inventory:'▣',terms:'◷',wache:'◉',absences:'☾',config:'📊',settings:'⚙',leader_all:'⚙️'}[k]||'•'}

const searchablePages = new Set(['map','families','phonebook','members','abgaben','sanctions','blood','cashbox','trading','inventory','terms','wache','absences']);
function updateTopControls(){
  const search=$('#globalSearch'), refreshBtn=$('#topRefresh'), add=$('#quickAddFamily'), dl=$('#searchSuggestions');
  if(search){
    const show=searchablePages.has(current);
    search.classList.toggle('hidden', !show);
    search.placeholder = current==='map'||current==='families' ? 'Familie, Kürzel, PLZ oder Kategorie suchen …' : 'Suche in diesem Bereich …';
  }
  if(refreshBtn) refreshBtn.classList.toggle('hidden', current==='overview');
  if(add) add.classList.toggle('hidden', !(can('familiesWrite') && (current==='map' || current==='families')));
  if(dl && DATA){
    const vals=[];
    (DATA.families||[]).forEach(f=>{
      [f.familie,f.kuerzel,f.plz,f.category].forEach(v=>{ if(v) vals.push(String(v)); });
      Object.values(f.contacts||{}).forEach(c=>{ if(c?.name) vals.push(String(c.name)); if(c?.nummer) vals.push(String(c.nummer)); });
    });
    (DATA.members||[]).forEach(m=>[m.nickname,m.phone,m.id].forEach(v=>{ if(v) vals.push(String(v)); }));
    dl.innerHTML=[...new Set(vals.filter(Boolean))].slice(0,350).map(v=>`<option value="${esc(v)}"></option>`).join('');
  }
}
const settingLabels={
  smartPingEnabled:['Intelligente Ping-Erkennung','Erkennt wichtige Erwähnungen und hilft, unnötige Pings zu vermeiden.'],
  autoSanctionsEnabled:['Automatische Sanktionen','Erstellt/prüft Sanktionen automatisch nach Regelwerk.'],
  termRemindersEnabled:['Termin-Erinnerungen','Sendet Erinnerungen für geplante Termine.'],
  decisionHintsEnabled:['Entscheidungs-Hinweise','Gibt Hinweise/Erinnerungen bei offenen Entscheidungen.'],
  leaderReminderDmEnabled:['Leader-DM-Erinnerungen','Schickt Leadern private Erinnerungen.'],
  dashboardEnabled:['Dashboard-Abgaben aktiv','Aktiviert die Abgabenfunktionen im Dashboard.'],
  fridayMissingReportEnabled:['Freitagsbericht: fehlende Abgaben','Meldet freitags fehlende Abgaben.'],
  mondayOverdueReportEnabled:['Montagsbericht: überfällige Abgaben','Meldet montags überfällige Abgaben.'],
  routeAdminFridayReportEnabled:['Wache-Freitagsbericht','Sendet freitags eine Zusammenfassung zur Routenwache.'],
  routeAdminMondayReportEnabled:['Wache-Montagsbericht','Sendet montags eine Zusammenfassung zur Routenwache.'],
  dryRunEnabled:['Testmodus / Dry Run','Aktionen werden getestet, ohne echte Änderungen/Posts auszuführen.'],
  logSystemEnabled:['System-Logs aktiv','Schreibt wichtige Systemaktionen ins Log.'],
  spamProtectionEnabled:['Spam-Schutz','Schützt Befehle und Buttons vor zu häufiger Nutzung.']
};
function niceSettingCard(k,set){ const [title,desc]=settingLabels[k]||[k,'']; return `<label class="card setting-card"><div><div class="label">${esc(title)}</div><p>${esc(desc)}</p></div><input id="set_${k}" type="checkbox" ${set[k]?'checked':''}></label>`; }
function niceKey(k){ return ({routen:'Wache',patronen:'Patronen',schwarzgeld:'Schwarzgeld',meth:'Meth',termine:'Termine',sanktionen:'Sanktionen',ausgeteilt:'Ausgeteilte Sanktionen',abmeldungen:'Abmeldungen',familien:'Familien',cashbox:'Familienkasse',inventory:'Lager'}[k]||String(k).replace(/([A-Z])/g,' $1').replace(/^./,m=>m.toUpperCase())); }

function go(p){
  if(p==='settings') p='leader_all';
  if(p==='leader_all' && typeof window.isLeader==='function' && !window.isLeader()) return toast('Zentrale Verwaltung ist nur für Leaderschaft/Admins.');
  current=p; buildNav(); renderCurrent();
}
function locked(){return '<div class="locked-note">Für diesen Bereich fehlt deiner Discord-Rolle die Berechtigung.</div>'}
function renderCurrent(){
  if(!DATA) return;
  const contentEl = document.getElementById('content');
  if(contentEl){ contentEl.classList.remove('page-leave'); void contentEl.offsetWidth; }
  if(current==='settings') current='leader_all';
  const p=pages.find(x=>x[0]===current)||pages[0];
  if(!p){ $('#content').innerHTML=locked(); return; }
  $('#pageTitle').textContent=p[1];
  $('#pageSubtitle').textContent=p[2];
  updateTopControls();
  let html='';
  if(current==='leader_all') html = typeof window.centralPage==='function' ? window.centralPage() : locked();
  else {
    const fn={overview,map,families,phonebook,members,abgaben,abgabenStats,sanctions,blood,cashbox,trading:tradingPage,inventory,terms,wache,absences,config,dashboard:overview,monitoring:config}[current];
    html=fn?fn():locked();
  }
  $('#content').innerHTML=html;
  afterRender();
}
function filterRows(arr, fields){ const s=q(); if(!s) return arr; return arr.filter(x=>fields.map(f=> typeof f==='function'?f(x):x[f]).join(' ').toLowerCase().includes(s)); }
function cards(obj){ return `<div class="cards">${Object.entries(obj).map(([k,v])=>`<div class="card"><div class="label">${esc(k)}</div><div class="value">${esc(compactCardValue(v))}</div></div>`).join('')}</div>`; }
function group(arr,k){return arr.reduce((a,x)=>((a[x[k]||'—']??=[]).push(x),a),{})}
function simpleTable(head, rows){ return `<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>{ const str = c==null?'':String(c); const safe = /<\/?(span|b|br|button|a|small|em|strong|div|p|input|select|option|label)/i.test(str) ? str : esc(str); return `<td>${safe}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`; }
function overview(){ const s=DATA.stats; const pub=DATA.publicUrl||{}; const famByCat=group(DATA.families||[],'category'); const recentAudit=(DATA.audit?.items||[]).slice(0,8); const upcoming=(DATA.terms?.items||[]).slice(0,8); return `${cards({'Familien':s.families,'Eigene Mitglieder':s.members,'Kassenstand':money(s.cashBalance),'Offene Sanktionen':s.openSanctions,'Termine':s.terms,'Abgabe-Wochen':s.abgabenWeeks,'Lager-User':s.inventoryUsers,'Aktive Abmeldungen':s.absencesActive})}
<div class="panel public-link-panel"><h2>Öffentlicher Dashboard-Link</h2>${pub.url?`<p><a class="public-link" href="${esc(pub.url)}" target="_blank">${esc(pub.url)}</a></p>`:'<p class="muted">Noch kein öffentlicher Link erzeugt. Starte <b>npm run start:public</b>.</p>'}<div class="toolbar"><span class="pill ${pub.status==='online'?'good':'bad'}">${esc(pub.status||'offline')}</span><span class="pill">Aktualisiert: ${dt(pub.updatedAt)}</span></div></div>
<div class="grid"><div class="panel"><h2>Familien nach Kategorie</h2><div class="cards">${Object.entries(famByCat).map(([k,v])=>`<div class="card"><div class="label">${esc(k)}</div><div class="value">${v.length}</div></div>`).join('')}</div><h2>Letzte Termine</h2>${simpleTable(['Titel','Typ','Datum','Antworten'], upcoming.map(t=>[t.title,t.type,`${t.date||''} ${t.time||''}`,Object.keys(t.responses||{}).length]))}</div><div class="panel"><h2>Rollenrechte</h2>${simpleTable(['Bereich','Zugriff'], Object.entries(perms().modules||{}).map(([k,v])=>[k,v?'✅':'—']))}<h2>Audit / Monitoring</h2>${mod('config')?`<div class="timeline">${recentAudit.map(a=>`<div><b>${esc(a.action)}</b><br><span class="muted">${dt(a.at)} • ${esc(a.by)}</span></div>`).join('')||'<p class="muted">Noch keine Web-Aktionen.</p>'}</div>`:'<p class="muted">Monitoring nur für Leaderschaft.</p>'}</div></div>`; }

function map(){
  const fams=filterRows(DATA.families||[], [x=>`${x.familie} ${x.kuerzel} ${x.plz} ${x.category} ${JSON.stringify(x.contacts)}`]);
  const cats=[...new Set((DATA.families||[]).map(f=>f.category))];
  const placements=buildMapPlacements(fams);
  const regions=['overview','county','east','desert','vinewood','central','south','harbor','airport','cayo','galapagos'];
  if(!regions.includes(currentMapRegion)) currentMapRegion='overview';
  const visible=placements.filter(p=>p.map.region===currentMapRegion);
  const selected=(DATA.families||[]).find(f=>f.id===selectedFamily);
  const selectedPlacement=selected?basePlacementForFamily(selected):null;
  const needsRegionJump=selectedPlacement && currentMapRegion!=='overview' && selectedPlacement.region!==currentMapRegion;
  return `<div class="toolbar"><span class="pill gold">${visible.length} Marker in ${esc(regionLabel(currentMapRegion))}</span><span class="pill">${fams.length} Familien gesamt</span>${cats.map(c=>`<button onclick="$('#globalSearch').value='${esc(c)}';renderCurrent()">${esc(c)}</button>`).join('')}<button onclick="$('#globalSearch').value='';renderCurrent()">Alle</button>${regions.map(r=>`<button class="${currentMapRegion===r?'primary':''}" onclick="setMapRegion('${r}')">${esc(regionLabel(r))}</button>`).join('')}${can('familiesWrite')?`<button class="${mapPickMode?'danger':'primary'}" onclick="toggleMapPick()">${mapPickMode?'PLZ-Klickmodus AUS':'PLZ-Position speichern'}</button><span class="pill">Drag & Drop Familien + Klickmodus Nummern</span>`:'<span class="pill">Automatik nach PLZ</span>'}</div><div class="grid map-layout"><div><div class="family-map real-map ${currentMapRegion==='overview'?'overview-map':''}" id="mapBox" style="background-image:url('${mapAssetForRegion(currentMapRegion)}')"><div class="map-overlay"><b>${esc(regionLabel(currentMapRegion))}</b><span>${currentMapRegion==='overview'?'Gesamtkarte – zeigt alle Familien gesammelt an.':(mapPickMode?'Klicke auf die richtige Nummer, gib PLZ ein und sie wird dauerhaft gespeichert.':'Marker landen automatisch auf der PLZ und können hier feinjustiert werden.')}</span></div>${visible.map(marker).join('')}</div><div class="map-footnote">${currentMapRegion==='overview'?'Hinweis: In der Gesamtkarte ist Drag & Drop deaktiviert. Wechsle in einen Bereich für manuelle Feinjustierung.':'Hinweis: Wenn die automatische PLZ-Position nicht perfekt passt, Marker einfach in diesem Bereich verschieben.'}</div></div><div class="panel"><h2>Ausgewählte Familie</h2><div id="mapDetail">${selectedFamily?familyDetailMini((DATA.families||[]).find(f=>f.id===selectedFamily)):'<p class="muted">Klicke auf einen Marker.</p>'}</div>${needsRegionJump?`<div class="map-jump-box"><p class="muted">Die ausgewählte Familie liegt im Bereich <b>${esc(regionLabel(selectedPlacement.region))}</b>.</p><button class="primary" onclick="setMapRegion('${selectedPlacement.region}')">Zum richtigen Kartenbereich springen</button></div>`:''}<hr style="border-color:var(--line)"><h2>PLZ-Positionen</h2>${plzCalibrationList()}<h2>Schnellsuche</h2><div class="mini-list">${fams.slice(0,28).map(f=>{const p=basePlacementForFamily(f);return `<div class="mini-row" onclick="focusFamilyOnMap('${f.id}')"><span><b>${esc(f.familie)}</b><br><em class="muted">${esc(f.category)} • ${esc(f.plz||'—')} • ${esc(f.kuerzel||'-')}</em></span><span class="tag">${esc(regionLabel(p.region))}</span></div>`}).join('')}</div></div></div>`;
}
function setMapRegion(region){ currentMapRegion=region; renderCurrent(); }
function focusFamilyOnMap(id){ selectedFamily=id; const f=(DATA.families||[]).find(x=>x.id===id); if(!f) return; const p=basePlacementForFamily(f); currentMapRegion=p.region||'overview'; renderCurrent(); }
function marker(item){ const f=item.family||item; const l=item.map||placementForFamily(f); const label=f.kuerzel&&f.kuerzel!=='-'?f.kuerzel:f.familie.slice(0,3); return `<div class="marker real-marker ${selectedFamily===f.id?'selected':''}" data-id="${f.id}" style="left:${l.x}%;top:${l.y}%" onclick="selectFamily('${f.id}')"><div class="pin"><span>${esc(label)}</span></div><div class="pin-meta">${esc(cleanPlzLabel(f.plz))}</div><div class="tooltip"><b>${esc(f.familie)}</b><br><span class="muted">${esc(f.category)} • PLZ ${esc(f.plz||'—')} • ${esc(regionLabel(l.region))}</span><br>${contactLine(f)}</div></div>`; }
function afterRender(){ if(current==='map' && can('familiesWrite') && currentMapRegion!=='overview') { enableDrag(); enablePlzPicker(); } }

function toggleMapPick(){ if(currentMapRegion==='overview'){ toast('Bitte zuerst einen Kartenbereich auswählen.'); return; } mapPickMode=!mapPickMode; renderCurrent(); }
function enablePlzPicker(){ const box=$('#mapBox'); if(!box) return; box.addEventListener('click', async e=>{ if(!mapPickMode) return; if(e.target.closest('.marker')) return; const r=box.getBoundingClientRect(); const x=clamp((e.clientX-r.left)/r.width*100,2,98); const y=clamp((e.clientY-r.top)/r.height*100,4,96); const plz=prompt('Welche PLZ/Nummer liegt an dieser Stelle?'); if(!plz) return; await api('/api/map/plz',{method:'POST',body:JSON.stringify({plz:plz.trim(),x,y,region:currentMapRegion})}); toast('PLZ-Position gespeichert: '+plz); mapPickMode=false; await refresh(true); }); }
function plzCalibrationList(){ const entries=Object.entries(DATA.mapLocations?.plz||{}).filter(([_,v])=>!currentMapRegion||currentMapRegion==='overview'||v.region===currentMapRegion).slice(0,24); if(!entries.length) return '<p class="muted">Noch keine manuell gespeicherten Nummernpositionen.</p>'; return `<div class="mini-list plz-list">${entries.map(([plz,l])=>`<div class="mini-row"><span><b>${esc(plz)}</b><br><em class="muted">${esc(regionLabel(l.region))} • ${Number(l.x||0).toFixed(1)} / ${Number(l.y||0).toFixed(1)}</em></span>${can('familiesWrite')?`<button onclick="deletePlzLocation('${esc(plz)}')">Löschen</button>`:''}</div>`).join('')}</div>`; }
async function deletePlzLocation(plz){ if(!confirm('PLZ-Position löschen?')) return; await api('/api/map/plz/'+encodeURIComponent(plz),{method:'DELETE'}); await refresh(true); }

function enableDrag(){ const box=$('#mapBox'); if(!box) return; box.querySelectorAll('.marker').forEach(m=>{ let down=false; m.addEventListener('pointerdown',e=>{down=true;m.classList.add('dragging');m.setPointerCapture(e.pointerId);}); m.addEventListener('pointermove',e=>{ if(!down)return; const r=box.getBoundingClientRect(); const x=Math.max(2,Math.min(98,(e.clientX-r.left)/r.width*100)); const y=Math.max(4,Math.min(96,(e.clientY-r.top)/r.height*100)); m.style.left=x+'%'; m.style.top=y+'%'; }); m.addEventListener('pointerup',async e=>{ if(!down)return; down=false;m.classList.remove('dragging'); const x=parseFloat(m.style.left), y=parseFloat(m.style.top); await api('/api/families/'+m.dataset.id+'/location',{method:'POST',body:JSON.stringify({x,y,label:'',region:currentMapRegion})}); toast('Kartenposition gespeichert'); await refresh(true); }); }); }
function selectFamily(id){ selectedFamily=id; const f=(DATA.families||[]).find(x=>x.id===id); const d=$('#mapDetail'); if(d) d.innerHTML=familyDetailMini(f); else openFamilyDetail(id); }
function familyDetailMini(f){ if(!f) return '<p class="muted">Nicht gefunden</p>'; const base=basePlacementForFamily(f); const p=placementForFamily(f); return `<div class="detail-title"><div><h2>${esc(f.familie)}</h2><p>${esc(f.category)} • ${esc(f.kuerzel||'-')} • PLZ ${esc(f.plz||'—')}</p></div><span class="pill ${String(f.schluessel).toLowerCase().includes('ja')?'good':'bad'}">Schlüssel: ${esc(f.schluessel||'—')}</span></div><div class="toolbar compact-toolbar"><span class="pill gold">Bereich: ${esc(regionLabel(base.region))}</span><span class="pill">Position: ${Number(p.x||0).toFixed(1)} / ${Number(p.y||0).toFixed(1)}</span><span class="pill">Quelle: ${p.manual?'manuell':'PLZ-Automatik'}</span></div><div class="contact-grid">${['12','11','10','rv1','rv2'].map(r=>contactCard(r,f.contacts?.[r])).join('')}</div><p>${esc(f.infos||'Keine Zusatzinfos')}</p><button class="primary" onclick="openFamilyDetail('${f.id}')">Profil öffnen</button> <button onclick="setMapRegion('${base.region}'); selectedFamily='${f.id}'; renderCurrent()">Auf Karte zeigen</button> ${can('familiesWrite')?`<button onclick="openFamilyModal('${f.id}')">Bearbeiten</button>`:''}`; }

function contactLine(f){ return ['12','11','10'].map(r=>f.contacts?.[r]?.name?`(${r}) ${f.contacts[r].name}`:'').filter(Boolean).join(' • ') || 'Keine Führung eingetragen'; }
function contactCard(r,c={}){ const label={rv1:'RV 1',rv2:'RV 2'}[r]||r+'er'; return `<div class="contact"><b>${label}</b><span>${esc(c?.name||'—')}</span><em>${esc(c?.nummer||'')}</em></div>`; }
function families(){ const rows=filterRows(DATA.families||[],[x=>`${x.category} ${x.kuerzel} ${x.familie} ${x.plz} ${x.schluessel} ${x.infos} ${contactLine(x)}`]); return `<div class="section-actions"><div class="toolbar"><span class="pill gold">${rows.length} Familien</span></div>${can('familiesWrite')?'<button class="primary" onclick="openFamilyModal()">+ Familie anlegen</button>':''}</div><div class="table-wrap"><table><thead><tr><th>Kategorie</th><th>Kürzel</th><th>Familie</th><th>PLZ</th><th>Schlüssel</th><th>Führung</th><th>Infos</th><th></th></tr></thead><tbody>${rows.map(f=>`<tr><td>${esc(f.category)}</td><td><b>${esc(f.kuerzel||'-')}</b></td><td>${esc(f.familie)}</td><td>${esc(f.plz||'—')}</td><td>${esc(f.schluessel||'—')}</td><td>${esc(contactLine(f))}</td><td>${esc(f.infos||'')}</td><td><button onclick="openFamilyDetail('${f.id}')">Öffnen</button></td></tr>`).join('')}</tbody></table></div>`; }
function phonebook(){ const rows=filterRows(DATA.families||[],[x=>`${x.familie} ${x.category} ${JSON.stringify(x.contacts)}`]); return `<div class="table-wrap"><table><thead><tr><th>Familie</th><th>12er</th><th>11er</th><th>10er</th><th>RV1</th><th>RV2</th><th></th></tr></thead><tbody>${rows.map(f=>`<tr><td><b>${esc(f.familie)}</b><br><span class="muted">${esc(f.category)} • ${esc(f.kuerzel||'-')}</span></td>${['12','11','10','rv1','rv2'].map(r=>`<td>${esc(f.contacts?.[r]?.name||'—')}<br><span class="muted">${esc(f.contacts?.[r]?.nummer||'')}</span></td>`).join('')}<td>${can('familiesWrite')?`<button onclick="openFamilyModal('${f.id}')">Bearbeiten</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`; }
function members(){ const rows=filterRows(DATA.members||[],[x=>`${x.id} ${x.nickname} ${x.phone}`]); return `<div class="section-actions"><span class="pill gold">${rows.length} Mitglieder</span>${can('membersWrite')?'<button class="primary" onclick="openMemberModal()">+ Mitglied</button>':''}</div><div class="table-wrap"><table><thead><tr><th>Discord ID</th><th>Nickname</th><th>Telefon</th><th></th></tr></thead><tbody>${rows.map(m=>`<tr><td class="code">${esc(m.id)}</td><td>${esc(m.nickname)}</td><td>${esc(m.phone)}</td><td>${can('membersWrite')?`<button onclick="openMemberModal('${m.id}')">Bearbeiten</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`; }
function abgaben(){ if(!DATA.abgaben) return locked(); const weeks=Object.keys(DATA.abgaben?.weeks||{}).sort().reverse(); const week=window.selWeek||weeks[0]; const cats=DATA.abgaben?.weeks?.[week]?.categories||{}; const rows=[]; Object.entries(cats).forEach(([cat,users])=>Object.entries(users||{}).forEach(([uid,a])=>rows.push({week,cat,uid,...a}))); const filt=filterRows(rows,[x=>`${x.week} ${x.cat} ${x.uid} ${x.status} ${x.note}`]); return `<div class="toolbar"><select style="max-width:240px" onchange="window.selWeek=this.value;renderCurrent()">${weeks.map(w=>`<option ${w===week?'selected':''}>${w}</option>`).join('')}</select><span class="pill gold">${filt.length} Einträge</span></div><div class="table-wrap"><table><thead><tr><th>Woche</th><th>Kategorie</th><th>User</th><th>Status</th><th>Betrag</th><th>Notiz</th><th>Update</th></tr></thead><tbody>${filt.map(a=>`<tr><td>${esc(a.week)}</td><td>${esc(a.cat)}</td><td class="code">${esc(a.uid)}</td><td>${badge(a.status)}</td><td>${money(a.amount)}</td><td>${esc(a.note||'')}</td><td>${can('abgabenWrite')?`<button onclick="openAbgabeModal('${a.week}','${a.cat}','${a.uid}')">Ändern</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`; }
function badge(s){ const c=String(s||'').includes('abgegeben')?'good':String(s||'').includes('entschuldigt')?'good':String(s||'').includes('offen')?'bad':'gold'; return `<span class="pill ${c}">${esc(s||'—')}</span>`; }
function abgabenStats(){ const st=DATA.abgabenStats||{weeks:[],totals:{}}; return `${cards({'Gesamt':st.totals.total||0,'Abgegeben':st.totals.abgegeben||0,'Offen':st.totals.offen||0,'Zu spät':st.totals.zuSpaet||0,'Entschuldigt':st.totals.entschuldigt||0,'Warnphase':st.totals.warnphase||0})}${simpleTable(['Woche','Gesamt','Abgegeben','Offen','Zu spät','Entschuldigt','Quote'], st.weeks.map(w=>[w.weekKey,w.total,w.abgegeben,w.offen,w.zuSpaet,w.entschuldigt, w.total?Math.round(w.abgegeben/w.total*100)+'%':'—']))}`; }
function sanctions(){ const rows=filterRows(DATA.sanctions?.items||[],[x=>`${x.id} ${x.userId} ${x.catalogNo} ${x.catalogLabel} ${x.penaltyType} ${x.status} ${x.extraReason}`]); return `<div class="section-actions"><span class="pill gold">${rows.length} Sanktionen</span>${can('sanctionsWrite')?'<span class="pill">Sanktionen verteilen: erlaubt</span>':'<span class="pill">Nur Ansicht</span>'}</div><div class="table-wrap"><table><thead><tr><th>User</th><th>Katalog</th><th>Strafe</th><th>Status</th><th>Erstellt</th><th>Fällig</th><th></th></tr></thead><tbody>${rows.map(s=>`<tr><td class="code">${esc(s.userId)}</td><td><b>${esc(s.catalogNo)}</b><br>${esc(s.catalogLabel)}</td><td>${esc(s.penaltyType)} ${s.amount?money(s.amount):''}</td><td>${badge(s.status|| (s.paid?'bezahlt':'offen'))}</td><td>${dt(s.createdAt)}</td><td>${dt(s.dueAt)}</td><td>${can('sanctionsWrite')?`<button class="success" onclick="markSanctionPaid('${s.id}')">Bezahlt</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`; }
function blood(){ const rows=filterRows(DATA.blood?.items||[],[x=>`${x.type} ${x.userId} ${x.name} ${x.reason} ${x.status}`]); return `<div class="section-actions"><span class="pill gold">${rows.length} Blood-Einträge</span><span class="pill">Bloodouts werden aus Sanktionen übernommen</span></div>${simpleTable(['Typ','User/Name','Grund','Datum','Quelle','Status'], rows.map(b=>[b.type||'Bloodout', b.name||b.userId, b.reason||'', dt(b.at), b.source||'manual', b.status||'']))}`; }
function cashbox(){ if(!DATA.cashbox) return locked(); const tx=filterRows(DATA.cashbox?.transactions||[],[x=>`${x.id} ${x.category} ${x.customReason} ${x.note} ${x.createdBy}`]); return `${cards({'Kassenstand':money(DATA.cashbox?.balance||0),'Transaktionen':tx.length})}<div class="section-actions"><span></span>${can('cashboxWrite')?'<button class="primary" onclick="openCashModal()">+ Transaktion</button>':''}</div><div class="table-wrap"><table><thead><tr><th>Datum</th><th>Typ</th><th>Kategorie</th><th>Betrag</th><th>Grund / Notiz</th><th>Von</th></tr></thead><tbody>${tx.map(t=>`<tr><td>${dt(t.createdAt)}</td><td>${t.type==='expense'?'<span class="pill bad">Ausgabe</span>':'<span class="pill good">Einnahme</span>'}</td><td>${esc(t.category)}</td><td>${money(t.amount)}</td><td>${esc(t.customReason||'')}<br><span class="muted">${esc(t.note||'')}</span></td><td class="code">${esc(t.createdBy)}</td></tr>`).join('')}</tbody></table></div>`; }
function inventory(){ const rows=Object.entries(DATA.inventory?.items||{}).map(([uid,i])=>({uid,...i})); const filt=filterRows(rows,[x=>`${x.uid} ${JSON.stringify(x.weapons)} ${x.munition}`]); const me=DATA.me?.id; return `<div class="table-wrap"><table><thead><tr><th>User</th><th>Waffen</th><th>Westen</th><th>Munition</th><th>Update</th><th></th></tr></thead><tbody>${filt.map(i=>`<tr><td class="code">${esc(i.uid)}</td><td>${Object.entries(i.weapons||{}).filter(([_,v])=>Number(v)>0).map(([k,v])=>`${esc(k)}: <b>${v}</b>`).join('<br>')||'—'}</td><td>Leicht: ${i.leichteWesten||0}<br>Schwer: ${i.schwereWesten||i.westen||0}</td><td>${i.munition||0}</td><td>${dt(i.updatedAt)}</td><td>${i.uid===me?`<button onclick="openInventoryModal('${i.uid}')">Eigenen Bestand bearbeiten</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`; }
function terms(){ const rows=filterRows(DATA.terms?.items||[],[x=>`${x.title} ${x.type} ${x.date} ${x.time} ${JSON.stringify(x.responses)}`]); return `<div class="section-actions"><span class="pill gold">${rows.length} Termine</span>${can('termsCreate')?'<button class="primary" onclick="openTermModal()">+ Termin</button>':'<span class="pill">Nur Ansicht</span>'}</div><div class="table-wrap"><table><thead><tr><th>Titel</th><th>Typ</th><th>Datum</th><th>Antworten</th><th>Status</th></tr></thead><tbody>${rows.map(t=>{const r=t.responses||{};return `<tr><td>${esc(t.title)}</td><td>${esc(t.type)}</td><td>${esc(t.date)} ${esc(t.time)}</td><td><span class="pill good">Kann ${Object.values(r).filter(v=>v==='can').length}</span> <span class="pill gold">Vielleicht ${Object.values(r).filter(v=>v==='maybe').length}</span> <span class="pill bad">Nicht ${Object.values(r).filter(v=>v==='cannot').length}</span></td><td>${t.closed?'geschlossen':'offen'}</td></tr>`}).join('')}</tbody></table></div>`; }
function wache(){ if(!DATA.wache) return locked(); const weeks=Object.keys(DATA.wache?.weeks||{}).sort().reverse(); const rows=weeks.map(w=>{const x=DATA.wache.weeks[w]; return [w,Object.keys(x.users||{}).length,(x.sessions||[]).length,x.weeklyReportPosted?'ja':'nein',x.sanctionsProcessed?'ja':'nein'];}); return simpleTable(['Woche','Teilnehmer','Sessions','Report','Sanktionen'], rows); }
function absences(){ const rows=filterRows(DATA.absences?.items||[],[x=>`${x.userId} ${x.reason} ${x.active}`]); return `<div class="section-actions"><span class="pill gold">${rows.length} Abmeldungen</span>${can('absencesCreate')?'<button class="primary" onclick="openAbsenceModal()">+ Abmeldung</button>':''}</div><div class="table-wrap"><table><thead><tr><th>User</th><th>Von</th><th>Bis</th><th>Tage</th><th>Status</th><th>Grund</th></tr></thead><tbody>${rows.map(a=>`<tr><td class="code">${esc(a.userId)}</td><td>${dt(a.startTs)}</td><td>${dt(a.untilTs)}</td><td>${esc(a.days||'')}</td><td>${a.active?'<span class="pill good">aktiv</span>':'<span class="pill">inaktiv</span>'}</td><td>${esc(a.reason)}</td></tr>`).join('')}</tbody></table></div>`; }
function config(){ if(!DATA.config) return locked(); const c=DATA.config||{}; const channels=Object.entries(c.channels||{}); const rules=c.settings?.rules||{}; return `<div class="grid"><div class="panel"><h2>Channels</h2>${simpleTable(['Name','Discord Channel ID'],channels.map(([k,v])=>[k,v]))}</div><div class="panel"><h2>Regeln</h2><pre class="code" style="white-space:pre-wrap">${esc(JSON.stringify(rules,null,2))}</pre><h2>Audit</h2><div class="timeline">${(DATA.audit?.items||[]).slice(0,18).map(a=>`<div><b>${esc(a.action)}</b><br><span class="muted">${dt(a.at)} • ${esc(a.by)}</span></div>`).join('')}</div></div></div>`; }
function openModal(html){ $('#modalBody').innerHTML=html; $('#modal').classList.remove('hidden'); }
function closeModal(){ $('#modal').classList.add('hidden'); }

function openFamilyDetail(id){ const f=(DATA.families||[]).find(x=>x.id===id); if(!f)return; const base=basePlacementForFamily(f); const p=placementForFamily(f); openModal(`${familyDetailMini(f)}<div class="split"><div class="panel"><h2>Stammdaten</h2>${simpleTable(['Feld','Wert'],[['ID',f.id],['Kategorie',f.category],['Kürzel',f.kuerzel],['PLZ',f.plz],['Schlüssel',f.schluessel],['Datum Info',f.datum_info],['Infos',f.infos]])}</div><div class="panel"><h2>Kartenposition</h2><p>Bereich: <b>${esc(regionLabel(base.region))}</b><br>X: ${Number(p.x||0).toFixed(2)}%<br>Y: ${Number(p.y||0).toFixed(2)}%<br>Quelle: ${p.manual?'manuell gespeichert':'automatisch aus PLZ'}</p><button onclick="setMapRegion('${base.region}');current='map';selectedFamily='${f.id}';closeModal();buildNav();renderCurrent()">Auf Karte anzeigen</button></div></div>`); }
function openFamilyModal(id){ if(!can('familiesWrite')) return toast('Keine Berechtigung.'); const f=id?(DATA.families||[]).find(x=>x.id===id):{contacts:{'12':{},'11':{},'10':{},rv1:{},rv2:{}},location:{x:50,y:50,region:'city'}}; const p=basePlacementForFamily(f); openModal(`<h2>${id?'Familie bearbeiten':'Familie anlegen'}</h2><form id="famForm" class="form-grid"><input name="id" type="hidden" value="${esc(f.id||'')}"><label>Kategorie<input name="category" value="${esc(f.category||'')}" required></label><label>Kürzel<input name="kuerzel" value="${esc(f.kuerzel||'')}"></label><label>Familie<input name="familie" value="${esc(f.familie||'')}" required></label><label>PLZ / Ort<input name="plz" value="${esc(f.plz||'')}"></label><label>Schlüssel<select name="schluessel"><option ${f.schluessel==='Ja'?'selected':''}>Ja</option><option ${f.schluessel==='Nein'?'selected':''}>Nein</option><option ${f.schluessel==='-'?'selected':''}>-</option></select></label><label>Datum Info<input name="datum_info" value="${esc(f.datum_info||'')}"></label><label class="full">Infos<textarea name="infos">${esc(f.infos||'')}</textarea></label>${['12','11','10','rv1','rv2'].map(r=>`<label>${r} Name<input name="${r}_name" value="${esc(f.contacts?.[r]?.name||'')}"></label><label>${r} Nummer<input name="${r}_nummer" value="${esc(f.contacts?.[r]?.nummer||'')}"></label>`).join('')}<label>Kartenbereich<select name="mapRegion">${['city','county','desert','east','cayo'].map(r=>`<option value="${r}" ${p.region===r?'selected':''}>${esc(regionLabel(r))}</option>`).join('')}</select></label><label>PLZ-Automatik Vorschlag<input value="${esc(regionLabel(autoPlacementForFamily(f).region))}" disabled></label><label>X Position<input name="x" type="number" step="0.01" value="${esc(Number(p.x||50).toFixed(2))}"></label><label>Y Position<input name="y" type="number" step="0.01" value="${esc(Number(p.y||50).toFixed(2))}"></label><div class="full"><button class="primary" type="submit">Speichern</button> ${id?`<button type="button" class="danger" onclick="deleteFamily('${id}')">Löschen</button>`:''}</div></form>`); $('#famForm').onsubmit=saveFamily; }
async function saveFamily(e){ e.preventDefault(); const fd=new FormData(e.target); const contacts={}; ['12','11','10','rv1','rv2'].forEach(r=>contacts[r]={name:fd.get(r+'_name'),nummer:fd.get(r+'_nummer')}); const payload={id:fd.get('id')||undefined, category:fd.get('category'), kuerzel:fd.get('kuerzel'), familie:fd.get('familie'), plz:fd.get('plz'), schluessel:fd.get('schluessel'), datum_info:fd.get('datum_info'), infos:fd.get('infos'), contacts, location:{x:Number(fd.get('x')),y:Number(fd.get('y')),region:fd.get('mapRegion')}}; await api('/api/families',{method:'POST',body:JSON.stringify(payload)}); closeModal(); await refresh(true); toast('Familie gespeichert'); }

async function deleteFamily(id){ if(!confirm('Familie wirklich löschen?'))return; await api('/api/families/'+id,{method:'DELETE',body:JSON.stringify({})}); closeModal(); await refresh(true); toast('Familie gelöscht'); }
function openMemberModal(id){ if(!can('membersWrite')) return toast('Keine Berechtigung.'); const m=id?(DATA.members||[]).find(x=>x.id===id):{}; openModal(`<h2>Mitglied</h2><form id="memForm" class="form-grid"><label>Discord ID<input name="id" value="${esc(id||'')}"></label><label>Telefon<input name="phone" value="${esc(m?.phone||'')}"></label><label class="full">Nickname<input name="nickname" value="${esc(m?.nickname||'')}"></label><button class="primary full">Speichern</button></form>`); $('#memForm').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);await api('/api/members/'+fd.get('id'),{method:'POST',body:JSON.stringify({nickname:fd.get('nickname'),phone:fd.get('phone')})});closeModal();await refresh(true);toast('Mitglied gespeichert')}; }
function openCashModal(){ if(!can('cashboxWrite')) return toast('Keine Berechtigung.'); openModal(`<h2>Kasseneintrag</h2><form id="cashForm" class="form-grid"><label>Typ<select name="type"><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select></label><label>Betrag<input name="amount" type="number" required></label><label>Kategorie<input name="category" value="web"></label><label>Grund<input name="customReason" value="Web Eintrag"></label><label class="full">Notiz<textarea name="note"></textarea></label><button class="primary full">Speichern</button></form>`); $('#cashForm').onsubmit=async e=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));await api('/api/cash/transactions',{method:'POST',body:JSON.stringify(o)});closeModal();await refresh(true);toast('Kasse aktualisiert')}; }
async function markSanctionPaid(id){ if(!can('sanctionsWrite')) return toast('Keine Berechtigung.'); await api('/api/sanctions/'+id+'/status',{method:'POST',body:JSON.stringify({paid:true})}); await refresh(true); toast('Sanktion als bezahlt markiert'); }
function openAbgabeModal(week,cat,uid){ if(!can('abgabenWrite')) return toast('Keine Berechtigung.'); openModal(`<h2>Abgabe ändern</h2><form id="abgForm" class="form-grid"><label>Status<select name="status"><option>offen</option><option>abgegeben</option><option>zu_spaet</option><option>entschuldigt</option><option>warnphase</option></select></label><label>Betrag<input name="amount" type="number" value="0"></label><label class="full">Notiz<textarea name="note"></textarea></label><button class="primary full">Speichern</button></form>`); $('#abgForm').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);await api('/api/abgaben/update',{method:'POST',body:JSON.stringify({weekKey:week,category:cat,userId:uid,patch:{status:fd.get('status'),amount:Number(fd.get('amount')),note:fd.get('note')}})});closeModal();await refresh(true);toast('Abgabe gespeichert')}; }
function openTermModal(){ if(!can('termsCreate')) return toast('Keine Berechtigung.'); openModal(`<h2>Termin anlegen</h2><form id="termForm" class="form-grid"><label>Titel<input name="title" required></label><label>Typ<input name="type" value="Aufstellung"></label><label>Datum<input name="date" placeholder="TT.MM.JJJJ"></label><label>Uhrzeit<input name="time" placeholder="20:00"></label><button class="primary full">Speichern</button></form>`); $('#termForm').onsubmit=async e=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));await api('/api/terms',{method:'POST',body:JSON.stringify(o)});closeModal();await refresh(true);toast('Termin gespeichert')}; }
function openAbsenceModal(){ if(!can('absencesCreate')) return toast('Keine Berechtigung.'); openModal(`<h2>Abmeldung anlegen</h2><form id="absForm" class="form-grid"><label>User ID<input name="userId" required value="${esc(DATA.me?.id||'')}"></label><label>Tage<input name="days" type="number" value="5"></label><label class="full">Grund<input name="reason" value="Web-Abmeldung"></label><button class="primary full">Speichern</button></form>`); $('#absForm').onsubmit=async e=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));await api('/api/absences',{method:'POST',body:JSON.stringify(o)});closeModal();await refresh(true);toast('Abmeldung gespeichert')}; }
function openInventoryModal(uid){ if(uid!==DATA.me?.id) return toast('Du darfst nur deinen eigenen Bestand bearbeiten.'); const inv=DATA.inventory?.items?.[uid]||{}; openModal(`<h2>Eigenen Lagerbestand bearbeiten</h2><form id="invForm" class="form-grid"><label>Leichte Westen<input name="leichteWesten" type="number" value="${esc(inv.leichteWesten||0)}"></label><label>Schwere Westen<input name="schwereWesten" type="number" value="${esc(inv.schwereWesten||inv.westen||0)}"></label><label>Munition<input name="munition" type="number" value="${esc(inv.munition||0)}"></label><button class="primary full">Speichern</button></form>`); $('#invForm').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);await api('/api/inventory/'+uid,{method:'POST',body:JSON.stringify({patch:{leichteWesten:Number(fd.get('leichteWesten')),schwereWesten:Number(fd.get('schwereWesten')),munition:Number(fd.get('munition'))}})});closeModal();await refresh(true);toast('Lagerbestand gespeichert')}; }

function mapAssetForRegion(region){ return ({overview:'/maps/overview.jpg',county:'/maps/county.jpg',east:'/maps/east.jpg',desert:'/maps/desert.jpg',vinewood:'/maps/vinewood.jpg',central:'/maps/central.jpg',south:'/maps/south.jpg',harbor:'/maps/harbor.jpg',airport:'/maps/airport.jpg',cayo:'/maps/cayo.jpg',galapagos:'/maps/galapagos.jpg'})[region]||'/maps/overview.jpg'; }
function regionLabel(region){ return ({overview:'Gesamtkarte',county:'County / Paleto',east:'East / Route 15',desert:'Grand Senora / Sandy',vinewood:'Vinewood / Rockford',central:'Innenstadt / Del Perro',south:'South LS / Osten',harbor:'Hafen / Elysian',airport:'Airport',cayo:'Cayo',galapagos:'Galapagos'})[region]||region; }
function cleanPlzLabel(plz){ const raw=String(plz||'').trim(); if(!raw) return '—'; const m=raw.match(/\d{3,5}(?:\s*[\/-]\s*\d{3,5})?/); return m?m[0].replace(/\s+/g,''):short(raw,10); }
function parsePlzValue(raw){ const hits=String(raw||'').match(/\d{3,5}/g); if(!hits||!hits.length) return null; let n=Number(hits[0]); if(n>9999) n=Number(String(n).slice(0,4)); if(!Number.isFinite(n)) return null; return n; }
function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function savedPlzLocationFor(plz){ const key=cleanPlzLabel(plz); const map=DATA?.mapLocations?.plz||{}; if(map[key]) return {...map[key], manualPlz:true, generated:false}; const raw=String(plz||'').trim(); if(map[raw]) return {...map[raw], manualPlz:true, generated:false}; return null; }
function autoPlacementForFamily(f){
  const label=cleanPlzLabel(f?.plz);
  const saved=savedPlzLocationFor(label);
  if(saved) return { region:saved.region||'city', x:Number(saved.x), y:Number(saved.y), manualPlz:true, generated:false, code:parsePlzValue(label) };
  const num=parsePlzValue(f?.plz);
  if(num==null){
    const seed=[...String(f?.id||'x')].reduce((a,c)=>a+c.charCodeAt(0),0);
    return { region:'overview', x:10+(seed%80), y:10+((seed*7)%80), manual:false, generated:true, code:null };
  }
  const code=num;
  const table = numberZoneFor(code);
  const x = table.box.x1 + (table.box.x2-table.box.x1) * table.rx;
  const y = table.box.y1 + (table.box.y2-table.box.y1) * table.ry;
  return { region:table.region, x:clamp(x,2,98), y:clamp(y,4,96), manual:false, generated:true, code };
}
function numberZoneFor(code){
  const c=Number(code);
  const norm=(start,end,region,box)=>{ const t=(c-start)/Math.max(1,end-start); return {region,box,rx:clamp(t,0,1),ry:0.5}; };
  if(c>=862&&c<=888) return norm(862,888,'galapagos',{x1:12,y1:20,x2:88,y2:78});
  if(c>=1000&&c<=1104) return norm(1000,1104,'county',{x1:68,y1:56,x2:94,y2:92});
  if(c>=2000&&c<=2059) return norm(2000,2059,'east',{x1:18,y1:24,x2:86,y2:62});
  if(c>=3000&&c<=3064) return norm(3000,3064,'east',{x1:8,y1:52,x2:86,y2:86});
  if(c>=4000&&c<=4024) return norm(4000,4024,'desert',{x1:40,y1:52,x2:92,y2:70});
  if(c>=5000&&c<=5028) return norm(5000,5028,'desert',{x1:10,y1:20,x2:72,y2:68});
  if(c>=5030&&c<=5064) return norm(5030,5064,'desert',{x1:3,y1:70,x2:12,y2:96});
  if(c>=6000&&c<=6189) return norm(6000,6189,'vinewood',{x1:5,y1:8,x2:92,y2:42});
  if(c>=6190&&c<=6205) return norm(6190,6205,'vinewood',{x1:20,y1:40,x2:60,y2:52});
  if(c>=7000&&c<=7039) return norm(7000,7039,'vinewood',{x1:2,y1:50,x2:30,y2:70});
  if(c>=7040&&c<=7189) return norm(7040,7189,'vinewood',{x1:8,y1:44,x2:74,y2:76});
  if(c>=7190&&c<=7288) return norm(7190,7288,'central',{x1:4,y1:20,x2:78,y2:62});
  if(c>=7289&&c<=7359) return norm(7289,7359,'central',{x1:60,y1:14,x2:96,y2:44});
  if(c>=8000&&c<=8255) return norm(8000,8255,'central',{x1:5,y1:55,x2:92,y2:86});
  if(c>=9000&&c<=9099) return norm(9000,9099,'south',{x1:5,y1:46,x2:40,y2:78});
  if(c>=9100&&c<=9199) return norm(9100,9199,'south',{x1:35,y1:42,x2:66,y2:78});
  if(c>=9200&&c<=9299) return norm(9200,9299,'south',{x1:50,y1:62,x2:80,y2:96});
  if(c>=9300&&c<=9399) return norm(9300,9399,'south',{x1:80,y1:18,x2:98,y2:70});
  if(c>=10000&&c<=10099) return norm(10000,10099,'harbor',{x1:4,y1:20,x2:72,y2:82});
  if(c>=10100&&c<=10140) return norm(10100,10140,'harbor',{x1:72,y1:38,x2:98,y2:68});
  return { region:'overview', box:{x1:10,y1:10,x2:90,y2:90}, rx:(c%100)/99, ry:((Math.floor(c/100))%10)/9 };
}
function overallFromRegionPlacement(p){
  const world = {
    county:{x1:8,y1:4,x2:78,y2:38}, east:{x1:60,y1:28,x2:96,y2:62}, desert:{x1:25,y1:35,x2:78,y2:66}, vinewood:{x1:28,y1:46,x2:66,y2:66}, central:{x1:36,y1:56,x2:78,y2:78}, south:{x1:52,y1:70,x2:88,y2:92}, harbor:{x1:56,y1:76,x2:96,y2:96}, airport:{x1:42,y1:76,x2:58,y2:94}, cayo:{x1:82,y1:72,x2:96,y2:92}, galapagos:{x1:2,y1:70,x2:22,y2:92}, overview:{x1:8,y1:8,x2:92,y2:92}
  }[p.region] || {x1:8,y1:8,x2:92,y2:92};
  return { x: world.x1 + (world.x2-world.x1)*(p.x/100), y: world.y1 + (world.y2-world.y1)*(p.y/100) };
}
function basePlacementForFamily(f){
  const auto = autoPlacementForFamily(f);
  const manual = f?.location && Number.isFinite(Number(f.location.x)) && Number.isFinite(Number(f.location.y)) && !f.location.generated;
  return manual ? { region:f.location.region || auto.region, x:Number(f.location.x), y:Number(f.location.y), manual:true, generated:false } : auto;
}
function placementForFamily(f){
  const base = basePlacementForFamily(f);
  if(currentMapRegion==='overview'){
    const world = overallFromRegionPlacement(base);
    return { ...base, region:'overview', x:world.x, y:world.y, sourceRegion:base.region };
  }
  return base;
}
function buildMapPlacements(families){
  const counts={};
  return (families||[]).map(f=>{
    const base = placementForFamily(f);
    const key = `${base.region}:${cleanPlzLabel(f.plz)}:${Math.round(base.x/4)}:${Math.round(base.y/4)}`;
    const idx = counts[key] || 0; counts[key] = idx + 1;
    const radius = idx * 2.3;
    const x = clamp(base.x + (idx?Math.cos(idx*1.2)*radius:0), 2, 98);
    const y = clamp(base.y + (idx?Math.sin(idx*1.2)*radius:0), 4, 96);
    return { family:f, map:{...base, x, y} };
  });
}

// load() is called once at the very end, after centralPage() is registered.

// ===== Erweiterungen: Web kann Discord-Funktionen steuern =====
// Old Abgaben/Zentrale injection removed: configuration lives only in centralPage().
const _oldSanctions = sanctions;
sanctions = function(){
  const add = can('sanctionsWrite') ? '<button class="primary" onclick="openSanctionCreateModal()">+ Sanktion / Bloodout verteilen</button>' : '';
  return `<div class="section-actions">${add}</div>` + _oldSanctions();
};
function openSanctionCreateModal(){
  openModal(`<h2>Sanktion verteilen</h2><form id="sanCreate" class="form-grid"><label>User Discord ID<input name="userId" required></label><label>Katalog-Nr.<input name="catalogNo" value="WEB"></label><label>Typ<select name="penaltyType"><option>Geldstrafe</option><option>Bloodin</option><option>Bloodout</option></select></label><label>Betrag<input name="amount" type="number" value="0"></label><label class="full">Grund<input name="reason" value="Web-Sanktion"></label><button class="primary full">Verteilen</button></form>`);
  document.getElementById('sanCreate').onsubmit = async e => { e.preventDefault(); const o=Object.fromEntries(new FormData(e.target)); await api('/api/sanctions',{method:'POST',body:JSON.stringify(o)}); closeModal(); await refresh(true); toast('Sanktion erstellt und Discord synchronisiert'); };
}
const _oldWache = wache;
wache = function(){
  const add = mod('wache') ? '<div class="section-actions"><button class="primary" onclick="openWacheSessionModal()">+ Wache-Session nachtragen</button></div>' : '';
  return add + _oldWache();
};
function openWacheSessionModal(){
  openModal(`<h2>Wache-Session nachtragen</h2><form id="wacheForm" class="form-grid"><label>Woche<input name="weekKey" placeholder="2026-W21"></label><label>Minuten<input name="minutes" type="number" value="60"></label><label class="full">Teilnehmer Discord IDs, kommagetrennt<input name="participants" value="${esc(DATA.me?.id||'')}"></label><button class="primary full">Speichern</button></form>`);
  document.getElementById('wacheForm').onsubmit = async e => { e.preventDefault(); const fd=new FormData(e.target); await api('/api/wache/session',{method:'POST',body:JSON.stringify({weekKey:fd.get('weekKey')||undefined,minutes:Number(fd.get('minutes')),participants:String(fd.get('participants')).split(',').map(x=>x.trim()).filter(Boolean)})}); closeModal(); await refresh(true); toast('Wache gespeichert und Discord synchronisiert'); };
}
const _oldConfig = config;
// Legacy Zentrale-Verwaltung renderer removed. Monitoring stays monitoring; leader_all renders only via centralPage().
config = function(){ return _oldConfig(); };

async function saveExpandedCentralSettings(){
  const keys=['smartPingEnabled','autoSanctionsEnabled','termRemindersEnabled','decisionHintsEnabled','leaderReminderDmEnabled','dashboardEnabled','fridayMissingReportEnabled','mondayOverdueReportEnabled','routeAdminFridayReportEnabled','routeAdminMondayReportEnabled','dryRunEnabled','logSystemEnabled','spamProtectionEnabled'];
  const body={}; keys.forEach(k=>{ const el=document.getElementById('set_'+k); if(el) body[k]=el.checked; });
  await api('/api/config/settings',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Zentrale Verwaltung gespeichert');
}


// ===== Familienkarte: echtes Pan/Zoom mit kompletter Karte =====
let familyMapView = { scale: 1, x: 0, y: 0 };
const FAMILY_MAP_MIN_SCALE = 1;
const FAMILY_MAP_MAX_SCALE = 4;
const FAMILY_MAP_ASSET = '/maps/family-overview.png';

mapAssetForRegion = function(region){
  return ({overview:FAMILY_MAP_ASSET,county:'/maps/county.jpg',east:'/maps/east.jpg',desert:'/maps/desert.jpg',vinewood:'/maps/vinewood.jpg',central:'/maps/central.jpg',south:'/maps/south.jpg',harbor:'/maps/harbor.jpg',airport:'/maps/airport.jpg',cayo:'/maps/cayo.jpg',galapagos:'/maps/galapagos.jpg'})[region]||FAMILY_MAP_ASSET;
};

overallFromRegionPlacement = function(p){
  const world = {
    county:{x1:8,y1:4,x2:78,y2:38}, east:{x1:60,y1:28,x2:96,y2:62}, desert:{x1:25,y1:35,x2:78,y2:66},
    vinewood:{x1:28,y1:46,x2:66,y2:66}, central:{x1:36,y1:56,x2:78,y2:78}, south:{x1:52,y1:70,x2:88,y2:92},
    harbor:{x1:56,y1:76,x2:96,y2:96}, airport:{x1:42,y1:76,x2:58,y2:94}, cayo:{x1:82,y1:72,x2:96,y2:92},
    galapagos:{x1:2,y1:70,x2:22,y2:92}, overview:{x1:0,y1:0,x2:100,y2:100}
  }[p.region] || {x1:0,y1:0,x2:100,y2:100};
  return { x: world.x1 + (world.x2-world.x1)*(Number(p.x||0)/100), y: world.y1 + (world.y2-world.y1)*(Number(p.y||0)/100) };
};

function familyMapViewport(){ return document.getElementById('mapViewport'); }
function familyMapStage(){ return document.getElementById('mapStage'); }
function familyMapZoomLabel(){ return document.getElementById('mapZoomLabel'); }
function clampMapScale(v){ return Math.max(FAMILY_MAP_MIN_SCALE, Math.min(FAMILY_MAP_MAX_SCALE, Number(v)||1)); }

function constrainFamilyMapView(){
  const vp = familyMapViewport();
  if(!vp) return;
  const rect = vp.getBoundingClientRect();
  const scaledW = rect.width * familyMapView.scale;
  const scaledH = rect.height * familyMapView.scale;
  if(familyMapView.scale <= 1){
    familyMapView.x = 0;
    familyMapView.y = 0;
  } else {
    const minX = rect.width - scaledW;
    const minY = rect.height - scaledH;
    familyMapView.x = clamp(familyMapView.x, minX, 0);
    familyMapView.y = clamp(familyMapView.y, minY, 0);
  }
}

function applyFamilyMapTransform(){
  const stage = familyMapStage();
  if(!stage) return;
  constrainFamilyMapView();
  stage.style.transform = `translate(${familyMapView.x}px, ${familyMapView.y}px) scale(${familyMapView.scale})`;
  const lbl = familyMapZoomLabel();
  if(lbl) lbl.textContent = Math.round(familyMapView.scale * 100) + '%';
}

function viewportPointToFamilyMapPercent(clientX, clientY){
  const vp = familyMapViewport();
  if(!vp) return {x:50, y:50};
  const rect = vp.getBoundingClientRect();
  const localX = (clientX - rect.left - familyMapView.x) / familyMapView.scale;
  const localY = (clientY - rect.top - familyMapView.y) / familyMapView.scale;
  return {
    x: clamp((localX / rect.width) * 100, 0.3, 99.7),
    y: clamp((localY / rect.height) * 100, 0.3, 99.7)
  };
}

function setFamilyMapScale(nextScale, clientX, clientY){
  const vp = familyMapViewport();
  if(!vp) return;
  const rect = vp.getBoundingClientRect();
  const oldScale = familyMapView.scale;
  const newScale = clampMapScale(nextScale);
  if(newScale === oldScale) return;
  const anchorX = (clientX ?? (rect.left + rect.width/2)) - rect.left;
  const anchorY = (clientY ?? (rect.top + rect.height/2)) - rect.top;
  const worldX = (anchorX - familyMapView.x) / oldScale;
  const worldY = (anchorY - familyMapView.y) / oldScale;
  familyMapView.scale = newScale;
  familyMapView.x = anchorX - worldX * newScale;
  familyMapView.y = anchorY - worldY * newScale;
  applyFamilyMapTransform();
}

window.zoomFamilyMap = function(step){
  const vp = familyMapViewport();
  if(!vp) return;
  const rect = vp.getBoundingClientRect();
  setFamilyMapScale(familyMapView.scale + step, rect.left + rect.width/2, rect.top + rect.height/2);
};

window.resetFamilyMapView = function(centerSelected=false){
  familyMapView.scale = 1;
  familyMapView.x = 0;
  familyMapView.y = 0;
  applyFamilyMapTransform();
  if(centerSelected && selectedFamily) setTimeout(() => centerFamilyOnMap(selectedFamily, 1.8), 0);
};

function centerFamilyOnMap(id, zoom=2){
  const vp = familyMapViewport();
  if(!vp || !id) return;
  const fam = (DATA?.families||[]).find(f => f.id === id);
  if(!fam) return;
  const pos = placementForFamily(fam);
  const rect = vp.getBoundingClientRect();
  familyMapView.scale = clampMapScale(Math.max(familyMapView.scale, zoom));
  familyMapView.x = rect.width / 2 - (pos.x / 100) * rect.width * familyMapView.scale;
  familyMapView.y = rect.height / 2 - (pos.y / 100) * rect.height * familyMapView.scale;
  applyFamilyMapTransform();
  updateSelectedMapMarker();
}

function updateSelectedMapMarker(){
  document.querySelectorAll('#mapStage .marker').forEach(m => {
    m.classList.toggle('selected', !!selectedFamily && m.dataset.id === selectedFamily);
  });
}

selectFamily = function(id){
  selectedFamily = id;
  const fam = (DATA?.families||[]).find(x => x.id === id);
  const d = document.getElementById('mapDetail');
  if(d) d.innerHTML = familyDetailMini(fam); else openFamilyDetail(id);
  updateSelectedMapMarker();
};

focusFamilyOnMap = function(id){
  selectedFamily = id;
  currentMapRegion = 'overview';
  renderCurrent();
  requestAnimationFrame(() => centerFamilyOnMap(id, 2.2));
};

setMapRegion = function(){
  currentMapRegion = 'overview';
  renderCurrent();
};

enablePlzPicker = function(){
  const vp = familyMapViewport();
  if(!vp) return;
  vp.addEventListener('click', async e => {
    if(!mapPickMode) return;
    if(e.target.closest('.marker') || e.target.closest('.map-controls')) return;
    const pt = viewportPointToFamilyMapPercent(e.clientX, e.clientY);
    const plz = prompt('Welche PLZ/Nummer liegt an dieser Stelle?');
    if(!plz) return;
    await api('/api/map/plz', {method:'POST', body:JSON.stringify({plz:plz.trim(), x:pt.x, y:pt.y, region:'overview'})});
    toast('PLZ-Position gespeichert: ' + plz.trim());
    mapPickMode = false;
    await refresh(true);
  });
};

function initInteractiveFamilyMap(){
  const vp = familyMapViewport();
  const stage = familyMapStage();
  if(!vp || !stage || vp.dataset.ready === '1') { applyFamilyMapTransform(); return; }
  vp.dataset.ready = '1';
  applyFamilyMapTransform();

  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.16 : 0.86;
    setFamilyMapScale(familyMapView.scale * factor, e.clientX, e.clientY);
  }, { passive:false });

  let pan = null;
  const endPan = (e) => {
    if(!pan || (e && pan.id !== e.pointerId)) return;
    pan = null;
    vp.classList.remove('panning');
  };
  vp.addEventListener('pointerdown', e => {
    if(e.target.closest('.marker') || e.target.closest('.map-controls')) return;
    pan = { id:e.pointerId, startX:e.clientX, startY:e.clientY, baseX:familyMapView.x, baseY:familyMapView.y };
    vp.classList.add('panning');
    vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', e => {
    if(!pan || pan.id !== e.pointerId) return;
    familyMapView.x = pan.baseX + (e.clientX - pan.startX);
    familyMapView.y = pan.baseY + (e.clientY - pan.startY);
    applyFamilyMapTransform();
  });
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);
  vp.addEventListener('pointerleave', e => { if(pan && pan.id === e.pointerId) endPan(e); });

  stage.querySelectorAll('.marker').forEach(m => {
    let drag = null;
    m.addEventListener('pointerdown', e => {
      e.stopPropagation();
      drag = { id:e.pointerId, startX:e.clientX, startY:e.clientY, moved:false };
      m.setPointerCapture(e.pointerId);
      m.classList.add('dragging');
    });
    m.addEventListener('pointermove', e => {
      if(!drag || drag.id !== e.pointerId) return;
      const moved = Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3;
      drag.moved = drag.moved || moved;
      if(!drag.moved || !can('familiesWrite')) return;
      const pt = viewportPointToFamilyMapPercent(e.clientX, e.clientY);
      m.style.left = pt.x + '%';
      m.style.top = pt.y + '%';
      e.stopPropagation();
    });
    const finishMarkerDrag = async (e) => {
      if(!drag || drag.id !== e.pointerId) return;
      e.stopPropagation();
      const didMove = drag.moved;
      drag = null;
      m.classList.remove('dragging');
      if(didMove && can('familiesWrite')){
        const x = parseFloat(m.style.left);
        const y = parseFloat(m.style.top);
        await api('/api/families/' + m.dataset.id + '/location', {method:'POST', body:JSON.stringify({x, y, label:'', region:'overview'})});
        toast('Kartenposition gespeichert');
        await refresh(true);
      } else {
        selectFamily(m.dataset.id);
      }
    };
    m.addEventListener('pointerup', finishMarkerDrag);
    m.addEventListener('pointercancel', e => { if(drag && drag.id === e.pointerId){ drag = null; m.classList.remove('dragging'); } });
  });

  updateSelectedMapMarker();
  if(selectedFamily) requestAnimationFrame(() => centerFamilyOnMap(selectedFamily, Math.max(1.6, familyMapView.scale)));
}

afterRender = function(){
  if(current === 'map'){
    requestAnimationFrame(() => {
      initInteractiveFamilyMap();
      if(can('familiesWrite')) enablePlzPicker();
    });
  }
};

toggleMapPick = function(){
  mapPickMode = !mapPickMode;
  renderCurrent();
};

map = function(){
  currentMapRegion = 'overview';
  const fams = filterRows(DATA.families||[], [x => `${x.familie} ${x.kuerzel} ${x.plz} ${x.category} ${JSON.stringify(x.contacts)}`]);
  const cats = [...new Set((DATA.families||[]).map(f => f.category).filter(Boolean))];
  const placements = buildMapPlacements(fams);
  const selected = (DATA.families||[]).find(f => f.id === selectedFamily);
  return `
  <div class="toolbar compact-toolbar">
    <span class="pill gold">${placements.length} Marker auf der Karte</span>
    <span class="pill">${fams.length} Familien gesamt</span>
    ${cats.map(c => `<button onclick="document.getElementById('globalSearch').value='${esc(c)}';renderCurrent()">${esc(c)}</button>`).join('')}
    <button onclick="document.getElementById('globalSearch').value='';renderCurrent()">Alle</button>
    ${can('familiesWrite') ? `<button class="${mapPickMode?'danger':'primary'}" onclick="toggleMapPick()">${mapPickMode?'PLZ-Klickmodus AUS':'PLZ-Position speichern'}</button>` : ''}
  </div>
  <div class="grid map-layout">
    <div>
      <div class="family-map family-map-viewport real-map" id="mapViewport">
        <div class="map-controls">
          <button class="map-control-btn" onclick="zoomFamilyMap(0.25)">+</button>
          <button class="map-control-btn" onclick="zoomFamilyMap(-0.25)">−</button>
          <button class="map-control-btn" onclick="resetFamilyMapView(${selected ? 'true' : 'false'})">Reset</button>
          <span id="mapZoomLabel" class="pill gold">100%</span>
        </div>
        <div class="map-overlay"><b>Freie Familienkarte</b><span>Mit dem Mausrad zoomst du rein und raus. Halte die Maustaste auf freier Fläche gedrückt, um die Karte zu verschieben. Marker bleiben an ihrer Position und bewegen sich mit der Karte mit – nur wenn du einen Marker direkt ziehst, änderst du seine Position.</span></div>
        <div class="map-stage" id="mapStage">
          <img class="map-base" src="${FAMILY_MAP_ASSET}" alt="Familienkarte" draggable="false">
          ${placements.map(marker).join('')}
        </div>
      </div>
      <div class="map-footnote">Wenn du nach oben oder in andere Bereiche scrollst bzw. die Karte verschiebst, siehst du nur den gerade sichtbaren Ausschnitt. Familien in Los Santos bleiben also unten außerhalb des Sichtfelds, bis du wieder dorthin navigierst.</div>
    </div>
    <div class="panel">
      <h2>Ausgewählte Familie</h2>
      <div id="mapDetail">${selectedFamily ? familyDetailMini(selected) : '<p class="muted">Klicke auf einen Marker oder nutze die Schnellsuche.</p>'}</div>
      <hr style="border-color:var(--line)">
      <h2>PLZ-Positionen</h2>
      ${plzCalibrationList()}
      <h2>Schnellsuche</h2>
      <div class="mini-list">${fams.slice(0, 40).map(f => { const p = basePlacementForFamily(f); return `<div class="mini-row" onclick="focusFamilyOnMap('${f.id}')"><span><b>${esc(f.familie)}</b><br><em class="muted">${esc(f.category)} • ${esc(f.plz||'—')} • ${esc(f.kuerzel||'-')}</em></span><span class="tag">${esc(regionLabel(p.region))}</span></div>`; }).join('')}</div>
    </div>
  </div>`;
};


// ===== UI-Neustrukturierung: Monitoring = Stats, Einstellungen separat, Namen statt IDs =====
function displayNameForUser(id){
  const s = String(id||'');
  if(!s || s==='—') return '—';
  const member = (DATA.members||[]).find(m => String(m.id)===s || String(m.userId)===s || String(m.discordId)===s);
  if(member) return member.serverName || member.displayName || member.nickname || member.name || member.username || member.globalName || member.phone || s;
  const numEntry = DATA.numbers?.members?.[s] || DATA.phonebook?.members?.[s];
  if(numEntry) return numEntry.nickname || numEntry.name || numEntry.username || numEntry.phone || s;
  const phoneHit = (DATA.members||[]).find(m => String(m.phone||'')===s);
  if(phoneHit) return phoneHit.nickname || phoneHit.name || phoneHit.phone || s;
  return s;
}
function userCell(id){
  const name = displayNameForUser(id);
  const raw = String(id||'');
  return `<b>${esc(name)}</b>${name!==raw?`<br><em class="muted">${esc(raw)}</em>`:''}`;
}
function tsOf(v){ const n=Number(v); if(Number.isFinite(n) && n>1000000000) return n; const d=new Date(v||0).getTime(); return Number.isFinite(d)?d:0; }
function startOfMonthTs(){ const d=new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function startOfWeekTs(){ const d=new Date(); const day=(d.getDay()+6)%7; d.setHours(0,0,0,0); d.setDate(d.getDate()-day); return d.getTime(); }
function monthKeyNow(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function weekKeyNow(){ const d=new Date(); const onejan=new Date(d.getFullYear(),0,1); const week=Math.ceil((((d-onejan)/86400000)+onejan.getDay()+1)/7); return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`; }
function entriesInRange(items, range='month'){
  const now=Date.now();
  const start = range==='week' ? startOfWeekTs() : range==='3m' ? now-90*86400000 : startOfMonthTs();
  return (items||[]).filter(x => {
    const t = tsOf(x.at || x.ts || x.createdAt || x.date || x.updatedAt || x.from || x.startTs);
    return !t || t >= start;
  });
}
function currentRange(){
  return localStorage.getItem('memberStatsRange') || 'month';
}
function setMemberRange(r){ localStorage.setItem('memberStatsRange', r); renderCurrent(); }

function allAbgabeRows(){
  const root = DATA.abgaben || {};
  const rows = [];
  for(const [weekKey, week] of Object.entries(root.weeks || root || {})){
    if(!week || typeof week !== 'object') continue;
    for(const [cat, catObj] of Object.entries(week.categories || week || {})){
      if(!catObj || typeof catObj !== 'object') continue;
      const members = catObj.members || catObj.users || catObj.entries || {};
      for(const [uid, row] of Object.entries(members)){
        if(!row || typeof row !== 'object') continue;
        rows.push({weekKey, category:cat, userId:uid, ...row});
      }
    }
  }
  return rows;
}
function allInventoryRows(){
  return Object.entries(DATA.inventory?.items || {}).map(([uid,row]) => ({userId:uid, ...(row||{})}));
}
function allAbsenceRows(){
  const arr = Array.isArray(DATA.absences?.items) ? DATA.absences.items : Array.isArray(DATA.absences) ? DATA.absences : [];
  return arr.map(a => ({...a, userId:a.userId||a.discordId||a.id}));
}
function allSanctionRows(){
  const arr = Array.isArray(DATA.sanctions?.items) ? DATA.sanctions.items : Array.isArray(DATA.sanctions) ? DATA.sanctions : [];
  return arr.map(a => ({...a, userId:a.userId||a.discordId||a.targetId||a.id}));
}

function monitoringStats(){
  const abg=allAbgabeRows();
  const abs=allAbsenceRows();
  const sanc=allSanctionRows();
  const inv=allInventoryRows();
  const wk = weekKeyNow();
  const weekRows = abg.filter(r => String(r.weekKey||'').includes(wk) || String(r.week||'').includes(wk));
  const submitted = weekRows.filter(r => ['abgegeben','paid','done','erledigt'].includes(String(r.status||'').toLowerCase()) || r.done || r.submitted).length;
  const open = Math.max(0, weekRows.length - submitted);
  const activeAbs = abs.filter(a => String(a.status||'').toLowerCase() !== 'inaktiv' && String(a.status||'').toLowerCase() !== 'closed').length;
  const openSanc = sanc.filter(s => !(s.paid || s.done || String(s.status||'').toLowerCase().includes('bezahlt'))).length;
  const cash = DATA.stats?.cashBalance ?? DATA.cashbox?.balance ?? 0;
  const cfg = DATA.config?.settings || {};
  const abgabenCfg = cfg.abgabenConfig || {};
  const abgabenEnabled = cfg.abgabenEnabled || {};
  const enabledCats = Object.entries(abgabenEnabled).filter(([_,v])=>v!==false).map(([k])=>niceKey(k));
  return `<div class="cards">${[
    ['Aktuelle Woche', wk],
    ['Abgaben diese Woche', `${submitted}/${weekRows.length || 0}`],
    ['Offene Abgaben', open],
    ['Aktive Abmeldungen', activeAbs],
    ['Offene Sanktionen', openSanc],
    ['Lager-User', inv.length],
    ['Kassenstand', money(cash)],
    ['Familien', (DATA.families||[]).length]
  ].map(([k,v])=>`<div class="card"><div class="label">${esc(k)}</div><div class="value smallvalue">${esc(v)}</div></div>`).join('')}</div>
  <div class="grid">
    <div class="panel"><h2>Aktuelle Abgaben-Woche</h2>${weekRows.length?simpleTable(['Name','Art','Status','Betrag/Info'], weekRows.slice(0,80).map(r=>[userCell(r.userId), niceKey(r.category), r.status||'offen', r.amount||r.menge||r.note||'—'])):'<p class="muted">Für diese Woche wurden noch keine Abgaben-Einträge gefunden.</p>'}</div>
    <div class="panel"><h2>Aktuelle Einstellungen</h2>
      <div class="mini-list">
        <div class="mini-row"><span>Aktive Abgabenarten</span><b>${esc(enabledCats.join(', ') || '—')}</b></div>
        ${Object.entries(abgabenCfg).slice(0,8).map(([k,v])=>`<div class="mini-row"><span>${esc(niceKey(k))}</span><b>${esc(v?.amount||v?.menge||'—')} • Frist ${esc(v?.deadlineDay||'—')} ${esc(v?.deadlineHour??'')}:${esc(String(v?.deadlineMinute??'').padStart(2,'0'))}</b></div>`).join('')}
        <div class="mini-row"><span>Auto-Sanktionen</span><b>${cfg.autoSanctionsEnabled?'AN':'AUS'}</b></div>
        <div class="mini-row"><span>Termin-Erinnerungen</span><b>${cfg.termRemindersEnabled?'AN':'AUS'}</b></div>
        <div class="mini-row"><span>Leader-DM</span><b>${cfg.leaderReminderDmEnabled?'AN':'AUS'}</b></div>
      </div>
    </div>
  </div>`;
}

config = function(){
  if(!DATA.config) return locked();
  return monitoringStats();
};

function memberSummaryFor(uid, range='month'){
  const abg=entriesInRange(allAbgabeRows().filter(r=>String(r.userId)===String(uid)), range);
  const abs=entriesInRange(allAbsenceRows().filter(r=>String(r.userId)===String(uid)), range);
  const sanc=entriesInRange(allSanctionRows().filter(r=>String(r.userId)===String(uid)), range);
  const inv=allInventoryRows().find(r=>String(r.userId)===String(uid)) || {};
  const submitted = abg.filter(r => ['abgegeben','paid','done','erledigt'].includes(String(r.status||'').toLowerCase()) || r.done || r.submitted).length;
  const open = Math.max(0, abg.length-submitted);
  const weapons = Object.entries(inv.weapons||inv.waffen||{}).filter(([_,v])=>Number(v)).map(([k,v])=>`${k}: ${v}`).join('<br>') || inv.weaponText || '—';
  return {abg,abs,sanc,inv,submitted,open,weapons};
}
function openMemberDetailStats(uid){
  const range=currentRange();
  const sum=memberSummaryFor(uid, range);
  const label = range==='week'?'diese Woche':range==='3m'?'letzte 3 Monate':'aktueller Monat';
  openModal(`<h2>${esc(displayNameForUser(uid))}</h2><p class="muted">${esc(uid)} • Zeitraum: ${esc(label)}</p>
  <div class="toolbar">
    <button onclick="setMemberRange('month'); closeModal(); openMemberDetailStats('${esc(uid)}')">Aktueller Monat</button>
    <button onclick="setMemberRange('week'); closeModal(); openMemberDetailStats('${esc(uid)}')">Diese Woche</button>
    <button onclick="setMemberRange('3m'); closeModal(); openMemberDetailStats('${esc(uid)}')">3 Monate</button>
  </div>
  ${cards({'Abgaben erledigt':sum.submitted,'Abgaben offen':sum.open,'Abmeldungen':sum.abs.length,'Sanktionen':sum.sanc.length})}
  <div class="grid">
    <div class="panel"><h2>Abgaben-Verlauf</h2>${sum.abg.length?simpleTable(['Woche','Art','Status','Info'], sum.abg.slice(0,80).map(r=>[r.weekKey||r.week||'—',niceKey(r.category),r.status||'offen',r.amount||r.note||'—'])):'<p class="muted">Keine Abgaben in diesem Zeitraum.</p>'}</div>
    <div class="panel"><h2>Lager aktuell</h2><p><b>Waffen</b><br>${sum.weapons}</p><p><b>Westen</b><br>Leicht: ${esc(sum.inv.leichteWesten||0)}<br>Schwer: ${esc(sum.inv.schwereWesten||sum.inv.westen||0)}</p><p><b>Munition</b><br>${esc(sum.inv.munition||0)}</p></div>
    <div class="panel"><h2>Abmeldungen</h2>${sum.abs.length?simpleTable(['Von','Bis','Status','Grund'], sum.abs.slice(0,50).map(a=>[dt(a.from||a.startTs),dt(a.to||a.until||a.endTs),a.status||'—',a.reason||a.grund||'—'])):'<p class="muted">Keine Abmeldungen in diesem Zeitraum.</p>'}</div>
    <div class="panel"><h2>Sanktionen</h2>${sum.sanc.length?simpleTable(['Datum','Typ','Status','Grund'], sum.sanc.slice(0,50).map(s=>[dt(s.at||s.createdAt),s.penaltyType||s.type||'—',s.status||'—',s.reason||'—'])):'<p class="muted">Keine Sanktionen in diesem Zeitraum.</p>'}</div>
  </div>`);
}

const _membersBaseStats = members;
members = function(){
  const range=currentRange();
  const label=range==='week'?'Diese Woche':range==='3m'?'Letzte 3 Monate':'Aktueller Monat';
  const rows=(DATA.members||[]).map(m=>{
    const uid=m.id||m.userId||m.discordId;
    const sum=memberSummaryFor(uid,range);
    return [userCell(uid), m.phone||'—', `${sum.submitted}/${sum.abg.length||0}`, sum.abs.length, sum.sanc.length, `<button onclick="openMemberDetailStats('${esc(uid)}')">Ansehen</button>`];
  });
  return `<div class="toolbar"><span class="pill gold">Standard: aktueller Monat</span><button class="${range==='month'?'primary':''}" onclick="setMemberRange('month')">Aktueller Monat</button><button class="${range==='week'?'primary':''}" onclick="setMemberRange('week')">Diese Woche</button><button class="${range==='3m'?'primary':''}" onclick="setMemberRange('3m')">3 Monate</button><span class="pill">${esc(label)}</span></div>
  <div class="panel"><h2>Mitgliederübersicht</h2>${simpleTable(['Name','Telefon','Abgaben','Abmeldungen','Sanktionen','Details'], rows)}</div>`;
};

inventory = function(){
  const rows=allInventoryRows().map(r=>{
    const weapons=Object.entries(r.weapons||r.waffen||{}).filter(([_,v])=>Number(v)).map(([k,v])=>`${k}: ${v}`).join('<br>') || r.weaponText || '—';
    return [userCell(r.userId), weapons, `Leicht: ${r.leichteWesten||0}<br>Schwer: ${r.schwereWesten||r.westen||0}`, r.munition||0, dt(r.updatedAt||r.lastUpdate||r.at), `<button onclick="openMemberDetailStats('${esc(r.userId)}')">Person</button>`];
  });
  return `<div class="panel"><h2>Lager</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Details'], rows)}</div>`;
};

absences = function(){
  const arr=allAbsenceRows();
  const rows=filterRows(arr,[x=>`${displayNameForUser(x.userId)} ${x.reason||x.grund||''} ${x.status||''}`]).map(a=>[userCell(a.userId), dt(a.from||a.startTs), dt(a.to||a.until||a.endTs), a.days||a.tage||'—', a.status||'—', a.reason||a.grund||'—']);
  const add=can('absencesCreate')?'<button class="primary" onclick="openAbsenceModal()">+ Abmeldung</button>':'';
  return `<div class="toolbar"><span class="pill gold">${rows.length} Abmeldungen</span>${add}</div><div class="panel">${simpleTable(['Name','Von','Bis','Tage','Status','Grund'], rows)}</div>`;
};

// Legacy settings renderer removed: centralPage() is the single source.
async function saveAllAbgabeSettings(){
  for(const k of ['routen','patronen','schwarzpulver','meth']){
    const time=String(document.getElementById(`abg_${k}_time`)?.value||'23:59').split(':');
    await api('/api/config/abgaben',{method:'POST',body:JSON.stringify({category:k,enabled:document.getElementById(`abg_${k}_enabled`)?.checked,amount:Number(document.getElementById(`abg_${k}_amount`)?.value||0),deadlineDay:Number(document.getElementById(`abg_${k}_day`)?.value||7),deadlineHour:Number(time[0]||23),deadlineMinute:Number(time[1]||59)})});
  }
  await refresh(true); toast('Abgaben-Einstellungen gespeichert');
}
async function saveRuleSettings(){
  const body={
    wacheRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),
    routeRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),
    absenceExcusedDays:Number(document.getElementById('rule_absenceExcusedDays')?.value||0),
    excusedAfterDays:Number(document.getElementById('rule_absenceExcusedDays')?.value||0),
    wacheEnabled:document.getElementById('rule_wacheEnabled')?.value==='true',
    reportsEnabled:document.getElementById('rule_reportsEnabled')?.value==='true'
  };
  await api('/api/config/settings',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Wache/Abmeldungs-Regeln gespeichert');
}


// ===== Zeitraumfilter: Monitoring & Mitgliederliste =====
function periodStateKey(scope){ return `dashboardPeriod_${scope||'global'}`; }
function getPeriod(scope='global'){
  const raw = localStorage.getItem(periodStateKey(scope));
  if(raw){
    try { return JSON.parse(raw); } catch(_) {}
  }
  return { mode:'month', from:'', to:'' };
}
function setPeriod(scope, mode){
  const old = getPeriod(scope);
  const next = { ...old, mode };
  localStorage.setItem(periodStateKey(scope), JSON.stringify(next));
  renderCurrent();
}
function setCustomPeriod(scope){
  const old = getPeriod(scope);
  const from = document.getElementById(`${scope}_from`)?.value || old.from || '';
  const to = document.getElementById(`${scope}_to`)?.value || old.to || '';
  localStorage.setItem(periodStateKey(scope), JSON.stringify({ mode:'custom', from, to }));
  renderCurrent();
}
function dateOnly(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function periodBounds(scope='global'){
  const p = getPeriod(scope);
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);
  start.setHours(0,0,0,0);
  end.setHours(23,59,59,999);

  if(p.mode === 'week'){
    const day = (now.getDay()+6)%7;
    start = new Date(now); start.setHours(0,0,0,0); start.setDate(start.getDate()-day);
  } else if(p.mode === 'lastWeek'){
    const day = (now.getDay()+6)%7;
    end = new Date(now); end.setHours(23,59,59,999); end.setDate(end.getDate()-day-1);
    start = new Date(end); start.setHours(0,0,0,0); start.setDate(start.getDate()-6);
  } else if(p.mode === 'month'){
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59,999);
  } else if(p.mode === 'lastMonth'){
    start = new Date(now.getFullYear(), now.getMonth()-1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23,59,59,999);
  } else if(p.mode === '3m'){
    start = new Date(now); start.setHours(0,0,0,0); start.setMonth(start.getMonth()-3);
  } else if(p.mode === '6m'){
    start = new Date(now); start.setHours(0,0,0,0); start.setMonth(start.getMonth()-6);
  } else if(p.mode === '12m'){
    start = new Date(now); start.setHours(0,0,0,0); start.setFullYear(start.getFullYear()-1);
  } else if(p.mode === 'all'){
    start = new Date(0);
    end = new Date(8640000000000000);
  } else if(p.mode === 'custom'){
    start = p.from ? new Date(p.from + 'T00:00:00') : new Date(0);
    end = p.to ? new Date(p.to + 'T23:59:59') : new Date(8640000000000000);
  }
  return { start:start.getTime(), end:end.getTime(), mode:p.mode, from:p.from||'', to:p.to||'' };
}
function periodLabel(scope='global'){
  const b = periodBounds(scope);
  const labels = {
    week:'Diese Woche',
    lastWeek:'Letzte Woche',
    month:'Aktueller Monat',
    lastMonth:'Letzter Monat',
    '3m':'Letzte 3 Monate',
    '6m':'Letzte 6 Monate',
    '12m':'Letztes Jahr',
    all:'Alles',
    custom:'Benutzerdefiniert'
  };
  if(b.mode === 'custom') return `Benutzerdefiniert: ${b.from || 'Start'} bis ${b.to || 'Ende'}`;
  return labels[b.mode] || 'Aktueller Monat';
}
function periodToolbar(scope='global'){
  const p = getPeriod(scope);
  const modes = [
    ['week','Diese Woche'],
    ['lastWeek','Letzte Woche'],
    ['month','Aktueller Monat'],
    ['lastMonth','Letzter Monat'],
    ['3m','3 Monate'],
    ['6m','6 Monate'],
    ['12m','1 Jahr'],
    ['all','Alles']
  ];
  return `<div class="period-toolbar toolbar">
    <span class="pill gold">Zeitraum: ${esc(periodLabel(scope))}</span>
    ${modes.map(([m,l])=>`<button class="${p.mode===m?'primary':''}" onclick="setPeriod('${scope}','${m}')">${esc(l)}</button>`).join('')}
    <div class="custom-period">
      <input id="${scope}_from" type="date" value="${esc(p.from||'')}">
      <span class="muted">bis</span>
      <input id="${scope}_to" type="date" value="${esc(p.to||'')}">
      <button class="${p.mode==='custom'?'primary':''}" onclick="setCustomPeriod('${scope}')">Benutzerdefiniert</button>
    </div>
  </div>`;
}
function itemTimestamp(x){
  return tsOf(x?.at || x?.ts || x?.createdAt || x?.date || x?.updatedAt || x?.from || x?.startTs || x?.weekStart || x?.weekKey || x?.week);
}
function inPeriodItem(x, scope='global'){
  const b = periodBounds(scope);
  const t = itemTimestamp(x);
  if(!t || t < 1000) {
    // Ohne Datum lieber sichtbar lassen, damit Daten nicht verschwinden.
    return true;
  }
  return t >= b.start && t <= b.end;
}
function entriesInSelectedPeriod(items, scope='global'){
  return (items||[]).filter(x => inPeriodItem(x, scope));
}

// vorhandene alte Range-Funktion überschreiben: Mitgliederliste nutzt jetzt denselben Zeitraumfilter
function currentRange(){ return getPeriod('members').mode || 'month'; }
function setMemberRange(mode){ setPeriod('members', mode); }
entriesInRange = function(items, rangeOrScope='members'){
  const scope = ['global','monitoring','members'].includes(rangeOrScope) ? rangeOrScope : 'members';
  return entriesInSelectedPeriod(items, scope);
};

monitoringStats = function(){
  const abgAll = allAbgabeRows();
  const absAll = allAbsenceRows();
  const sancAll = allSanctionRows();
  const inv = allInventoryRows();

  const abg = entriesInSelectedPeriod(abgAll, 'monitoring');
  const abs = entriesInSelectedPeriod(absAll, 'monitoring');
  const sanc = entriesInSelectedPeriod(sancAll, 'monitoring');

  const submitted = abg.filter(r => ['abgegeben','paid','done','erledigt'].includes(String(r.status||'').toLowerCase()) || r.done || r.submitted).length;
  const open = Math.max(0, abg.length - submitted);
  const activeAbs = abs.filter(a => String(a.status||'').toLowerCase() !== 'inaktiv' && String(a.status||'').toLowerCase() !== 'closed').length;
  const openSanc = sanc.filter(s => !(s.paid || s.done || String(s.status||'').toLowerCase().includes('bezahlt'))).length;
  const cash = DATA.stats?.cashBalance ?? DATA.cashbox?.balance ?? 0;
  const cfg = DATA.config?.settings || {};
  const abgabenCfg = cfg.abgabenConfig || {};
  const abgabenEnabled = cfg.abgabenEnabled || {};
  const enabledCats = Object.entries(abgabenEnabled).filter(([_,v])=>v!==false).map(([k])=>niceKey(k));

  const byCat = {};
  abg.forEach(r => { const k = niceKey(r.category || 'Unbekannt'); byCat[k] ||= {total:0, done:0}; byCat[k].total++; if(['abgegeben','paid','done','erledigt'].includes(String(r.status||'').toLowerCase()) || r.done || r.submitted) byCat[k].done++; });

  return `${periodToolbar('monitoring')}
  <div class="cards">${[
    ['Zeitraum', periodLabel('monitoring')],
    ['Abgaben erledigt', `${submitted}/${abg.length || 0}`],
    ['Offene Abgaben', open],
    ['Aktive Abmeldungen', activeAbs],
    ['Offene Sanktionen', openSanc],
    ['Lager-User', inv.length],
    ['Kassenstand', money(cash)],
    ['Familien', (DATA.families||[]).length]
  ].map(([k,v])=>`<div class="card"><div class="label">${esc(k)}</div><div class="value smallvalue">${esc(v)}</div></div>`).join('')}</div>
  <div class="grid">
    <div class="panel"><h2>Abgaben zusammengefasst</h2>${Object.keys(byCat).length?simpleTable(['Art','Erledigt','Gesamt','Offen'], Object.entries(byCat).map(([k,v])=>[k,v.done,v.total,Math.max(0,v.total-v.done)])):'<p class="muted">Keine Abgaben im gewählten Zeitraum.</p>'}</div>
    <div class="panel"><h2>Aktuelle Einstellungen</h2>
      <div class="mini-list">
        <div class="mini-row"><span>Aktive Abgabenarten</span><b>${esc(enabledCats.join(', ') || '—')}</b></div>
        ${Object.entries(abgabenCfg).slice(0,8).map(([k,v])=>`<div class="mini-row"><span>${esc(niceKey(k))}</span><b>${esc(v?.amount||v?.menge||'—')} • Frist ${esc(v?.deadlineDay||'—')} ${esc(v?.deadlineHour??'')}:${esc(String(v?.deadlineMinute??'').padStart(2,'0'))}</b></div>`).join('')}
        <div class="mini-row"><span>Auto-Sanktionen</span><b>${cfg.autoSanctionsEnabled?'AN':'AUS'}</b></div>
        <div class="mini-row"><span>Termin-Erinnerungen</span><b>${cfg.termRemindersEnabled?'AN':'AUS'}</b></div>
        <div class="mini-row"><span>Leader-DM</span><b>${cfg.leaderReminderDmEnabled?'AN':'AUS'}</b></div>
      </div>
    </div>
    <div class="panel"><h2>Abgaben im Zeitraum</h2>${abg.length?simpleTable(['Name','Woche','Art','Status','Info'], abg.slice(0,120).map(r=>[userCell(r.userId), r.weekKey||r.week||'—', niceKey(r.category), r.status||'offen', r.amount||r.menge||r.note||'—'])):'<p class="muted">Keine Einträge im gewählten Zeitraum.</p>'}</div>
    <div class="panel"><h2>Abmeldungen & Sanktionen</h2>
      <h2>Abmeldungen</h2>${abs.length?simpleTable(['Name','Von','Bis','Status'], abs.slice(0,40).map(a=>[userCell(a.userId),dt(a.from||a.startTs),dt(a.to||a.until||a.endTs),a.status||'—'])):'<p class="muted">Keine Abmeldungen.</p>'}
      <h2>Sanktionen</h2>${sanc.length?simpleTable(['Name','Typ','Status','Grund'], sanc.slice(0,40).map(s=>[userCell(s.userId),s.penaltyType||s.type||'—',s.status||'—',s.reason||'—'])):'<p class="muted">Keine Sanktionen.</p>'}
    </div>
  </div>`;
};

config = function(){
  if(!DATA.config) return locked();
  return monitoringStats();
};

memberSummaryFor = function(uid, scope='members'){
  const abg=entriesInSelectedPeriod(allAbgabeRows().filter(r=>String(r.userId)===String(uid)), scope);
  const abs=entriesInSelectedPeriod(allAbsenceRows().filter(r=>String(r.userId)===String(uid)), scope);
  const sanc=entriesInSelectedPeriod(allSanctionRows().filter(r=>String(r.userId)===String(uid)), scope);
  const inv=allInventoryRows().find(r=>String(r.userId)===String(uid)) || {};
  const submitted = abg.filter(r => ['abgegeben','paid','done','erledigt'].includes(String(r.status||'').toLowerCase()) || r.done || r.submitted).length;
  const open = Math.max(0, abg.length-submitted);
  const weapons = Object.entries(inv.weapons||inv.waffen||{}).filter(([_,v])=>Number(v)).map(([k,v])=>`${k}: ${v}`).join('<br>') || inv.weaponText || '—';
  return {abg,abs,sanc,inv,submitted,open,weapons};
};

openMemberDetailStats = function(uid){
  const sum=memberSummaryFor(uid, 'members');
  openModal(`<h2>${esc(displayNameForUser(uid))}</h2><p class="muted">${esc(uid)} • Zeitraum: ${esc(periodLabel('members'))}</p>
  ${periodToolbar('members')}
  ${cards({'Abgaben erledigt':sum.submitted,'Abgaben offen':sum.open,'Abmeldungen':sum.abs.length,'Sanktionen':sum.sanc.length})}
  <div class="grid">
    <div class="panel"><h2>Abgaben-Verlauf</h2>${sum.abg.length?simpleTable(['Woche','Art','Status','Info'], sum.abg.slice(0,100).map(r=>[r.weekKey||r.week||'—',niceKey(r.category),r.status||'offen',r.amount||r.note||'—'])):'<p class="muted">Keine Abgaben in diesem Zeitraum.</p>'}</div>
    <div class="panel"><h2>Lager aktuell</h2><p><b>Waffen</b><br>${sum.weapons}</p><p><b>Westen</b><br>Leicht: ${esc(sum.inv.leichteWesten||0)}<br>Schwer: ${esc(sum.inv.schwereWesten||sum.inv.westen||0)}</p><p><b>Munition</b><br>${esc(sum.inv.munition||0)}</p></div>
    <div class="panel"><h2>Abmeldungen</h2>${sum.abs.length?simpleTable(['Von','Bis','Status','Grund'], sum.abs.slice(0,80).map(a=>[dt(a.from||a.startTs),dt(a.to||a.until||a.endTs),a.status||'—',a.reason||a.grund||'—'])):'<p class="muted">Keine Abmeldungen in diesem Zeitraum.</p>'}</div>
    <div class="panel"><h2>Sanktionen</h2>${sum.sanc.length?simpleTable(['Datum','Typ','Status','Grund'], sum.sanc.slice(0,80).map(s=>[dt(s.at||s.createdAt),s.penaltyType||s.type||'—',s.status||'—',s.reason||'—'])):'<p class="muted">Keine Sanktionen in diesem Zeitraum.</p>'}</div>
  </div>`);
};

members = function(){
  const rows=(DATA.members||[]).map(m=>{
    const uid=m.id||m.userId||m.discordId;
    const sum=memberSummaryFor(uid,'members');
    return [userCell(uid), m.phone||'—', `${sum.submitted}/${sum.abg.length||0}`, sum.abs.length, sum.sanc.length, `<button onclick="openMemberDetailStats('${esc(uid)}')">Ansehen</button>`];
  });
  return `${periodToolbar('members')}
  <div class="panel"><h2>Mitgliederübersicht</h2><p class="muted">Standard ist aktueller Monat. Oben kannst du Woche, Monat, 3/6/12 Monate, alles oder einen eigenen Zeitraum wählen.</p>${simpleTable(['Name','Telefon','Abgaben','Abmeldungen','Sanktionen','Details'], rows)}</div>`;
};

// Branding: Redirect-Hinweis auf Loginseite ausblenden
function hidePublicRedirectBox(){ const el=document.getElementById('publicAuthInfo'); if(el){ el.classList.add('hidden'); el.style.display='none'; } }
setInterval(hidePublicRedirectBox, 1000);


// ===== Final UI Fix: saubere Tabellen, Namen, Einstellungen/Kanäle =====
function stripHtmlBreaks(v){
  return String(v ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\\n/g, '\n')
    .trim();
}
function nl(v){ return esc(stripHtmlBreaks(v)).replace(/\n/g,'<br>'); }
function shortId(id){
  const s=String(id||'');
  return s.length>14 ? `${s.slice(0,6)}…${s.slice(-4)}` : s;
}
function lookupNameDeep(obj, id){
  if(!obj || typeof obj !== 'object') return null;
  const sid=String(id||'');
  if(obj[sid]){
    const x=obj[sid];
    if(typeof x === 'string') return x;
    return x.nickname || x.name || x.username || x.globalName || x.displayName || x.phone || null;
  }
  if(Array.isArray(obj)){
    for(const x of obj){
      if(!x || typeof x !== 'object') continue;
      if([x.id,x.userId,x.discordId,x.discord_id,x.memberId,x.phone,x.nummer].map(String).includes(sid)){
        return x.nickname || x.name || x.username || x.globalName || x.displayName || x.phone || x.nummer || null;
      }
    }
  } else {
    for(const x of Object.values(obj)){
      if(!x || typeof x !== 'object') continue;
      if([x.id,x.userId,x.discordId,x.discord_id,x.memberId,x.phone,x.nummer].map(String).includes(sid)){
        return x.nickname || x.name || x.username || x.globalName || x.displayName || x.phone || x.nummer || null;
      }
      for(const c of Object.values(x.contacts||{})){
        if(c && [c.id,c.userId,c.discordId,c.nummer,c.phone].map(String).includes(sid)){
          return c.name || c.nickname || c.nummer || c.phone || null;
        }
      }
    }
  }
  return null;
}
displayNameForUser = function(id){
  const raw=String(id||'').replace(/[<@!>]/g,'').trim();
  if(!raw) return '—';
  const sources=[DATA?.members, DATA?.numbers?.members, DATA?.numbers, DATA?.phonebook?.members, DATA?.phonebook, DATA?.families, DATA?.familiesBoard, DATA?.families_board];
  for(const src of sources){
    const found=lookupNameDeep(src, raw);
    if(found) return String(found);
  }
  return raw;
};
userCell = function(id){
  const raw=String(id||'').replace(/[<@!>]/g,'').trim();
  const name=displayNameForUser(raw);
  if(!raw) return '—';
  return `<div class="person-cell"><b>${esc(name)}</b>${name!==raw?`<em>${esc(shortId(raw))}</em>`:''}</div>`;
};
function moneyFull(n){ return n === null || n === undefined ? '—' : new Intl.NumberFormat('de-DE').format(Number(n||0)) + ' $'; }

// Abgaben: keine Einstellungsbox mehr hier, nur Daten
abgaben = function(){
  const root=DATA.abgaben||{};
  const rows=allAbgabeRows ? allAbgabeRows() : [];
  const filtered=filterRows(rows,[r=>`${displayNameForUser(r.userId)} ${r.weekKey||''} ${r.category||''} ${r.status||''}`]);
  const byWeek=[...new Set(filtered.map(r=>r.weekKey||r.week).filter(Boolean))].slice(0,12);
  return `<div class="toolbar"><span class="pill gold">${filtered.length} Einträge</span>${byWeek.map(w=>`<button onclick="document.getElementById('globalSearch').value='${esc(w)}';renderCurrent()">${esc(w)}</button>`).join('')}<button onclick="goModule('leader_all');openCentralSection('system','abgaben')">Abgaben einstellen</button></div>
  <div class="panel"><h2>Abgaben</h2>${filtered.length?simpleTable(['Name','Woche','Art','Status','Betrag / Info'], filtered.slice(0,250).map(r=>[
    userCell(r.userId),
    r.weekKey||r.week||'—',
    niceKey(r.category||'—'),
    r.status||'offen',
    r.amount||r.menge||r.note||'—'
  ])):'<p class="muted">Keine Abgaben gefunden.</p>'}</div>`;
};

// Lager: echte Zeilen statt <br>-Text
inventory = function(){
  const rows=allInventoryRows().map(r=>{
    const weapons = Object.entries(r.weapons||r.waffen||{}).filter(([_,v])=>Number(v)).map(([k,v])=>`${k}: ${v}`).join('\n') || stripHtmlBreaks(r.weaponText||r.weaponsText||'—');
    return [userCell(r.userId), nl(weapons), `Leicht: ${esc(r.leichteWesten||0)}<br>Schwer: ${esc(r.schwereWesten||r.westen||0)}`, r.munition||0, dt(r.updatedAt||r.lastUpdate||r.at), `<button onclick="openMemberDetailStats('${esc(r.userId)}')">Person</button>`];
  });
  return `<div class="panel"><h2>Lager</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Details'], rows)}</div>`;
};

// Abmeldungen: breitere Namen/Datumsfelder
absences = function(){
  const arr=allAbsenceRows();
  const rows=filterRows(arr,[x=>`${displayNameForUser(x.userId)} ${x.reason||x.grund||''} ${x.status||''}`]).map(a=>[
    userCell(a.userId),
    dt(a.from||a.startTs||a.createdAt),
    dt(a.to||a.until||a.untilTs||a.endTs),
    a.days||a.tage||'—',
    a.status||((a.active===false)?'inaktiv':'aktiv'),
    a.reason||a.grund||'—'
  ]);
  const add=can('absencesCreate')?'<button class="primary" onclick="openAbsenceModal()">+ Abmeldung</button>':'';
  return `<div class="toolbar"><span class="pill gold">${rows.length} Abmeldungen</span>${add}</div><div class="panel">${simpleTable(['Name','Von','Bis','Tage','Status','Grund'], rows)}</div>`;
};

// Kasse: Namen und Betrag sauber
cashbox = function(){
  const tx=DATA.cashbox?.transactions||[];
  const balance=DATA.cashbox?.balance ?? DATA.stats?.cashBalance ?? 0;
  const rows=filterRows(tx,[t=>`${t.type||''} ${t.category||''} ${t.customReason||''} ${t.note||''} ${displayNameForUser(t.createdBy||t.by||t.userId)}`]).slice(0,250).map(t=>[
    dt(t.createdAt||t.at),
    t.type==='expense'?'Ausgabe':'Einnahme',
    t.category||'—',
    moneyFull(t.amount||0),
    nl(`${t.customReason||''}${t.note?'\n'+t.note:''}`),
    userCell(t.createdBy||t.by||t.userId||'')
  ]);
  return `${cards({'Kassenstand':moneyFull(balance),'Transaktionen':tx.length})}<div class="section-actions">${can('cashboxWrite')?'<button class="primary" onclick="openCashModal()">+ Transaktion</button>':''}</div><div class="panel">${simpleTable(['Datum','Typ','Kategorie','Betrag','Grund / Notiz','Von'], rows)}</div>`;
};

// Einstellungen: Kanäle wirklich speichern
/* legacy settings renderer removed: centralPage() is the single source. */
async function saveChannelSettings(){
  const channels={};
  document.querySelectorAll('[data-channel-key]').forEach(el=>channels[el.dataset.channelKey]=el.value.trim());
  await api('/api/config/channels',{method:'POST',body:JSON.stringify({channels})});
  await refresh(true);
  toast('Kanäle gespeichert');
}


// ===== Rollen & Web-Berechtigungen in Einstellungen =====
const rolePermissionLabels = {
  admin:'Admin / alles',
  sanction_manage:'Sanktionen verwalten',
  sanction_approve:'Sanktionen freigeben',
  absence_manage:'Abmeldungen verwalten',
  attendance_manage:'Anwesenheit/Wache verwalten',
  config_manage:'Einstellungen bearbeiten',
  dashboard_view:'Dashboard ansehen',
  rollback_manage:'Rollback/Rückgängig'
};
const webModuleLabels = {
  overview:'Übersicht',
  map:'Familienkarte',
  families:'Familien',
  phonebook:'Telefonbuch',
  members:'Mitglieder',
  abgaben:'Abgaben',
  abgabenStats:'Statistiken',
  sanctions:'Sanktionen',
  blood:'Bloodin/out',
  cashbox:'Familienkasse',
  inventory:'Lager',
  terms:'Termine',
  wache:'Wache',
  absences:'Abmeldungen',
  config:'Monitoring/Einstellungen'
};
function idsToText(v){ return Array.isArray(v)?v.join('\n'):String(v||''); }
function splitRoleIdsText(v){ return String(v||'').split(/[,\n ]+/).map(x=>x.trim()).filter(Boolean); }
function guildRolesList(){ return (Array.isArray(DATA?.guildRoles)?DATA.guildRoles:[]).filter(r=>r && r.id && r.name !== '@everyone'); }
function roleNameById(id){ const r=guildRolesList().find(x=>String(x.id)===String(id)); return r ? r.name : String(id||''); }
function roleOption(r, selectedIds=[]){ const sel=(selectedIds||[]).map(String).includes(String(r.id))?' selected':''; return `<option value="${esc(r.id)}"${sel}>${esc(r.name)} — ${esc(r.id)}</option>`; }
function roleMultiSelect(id, selectedIds=[]){ const roles=guildRolesList(); return `<select id="${esc(id)}" multiple size="8">${roles.map(r=>roleOption(r, selectedIds)).join('')}</select><small class="muted">Mehrfachauswahl: ⌘/Strg gedrückt halten.</small>`; }
function selectedRoleIds(id){ return Array.from(document.getElementById(id)?.selectedOptions||[]).map(o=>o.value).filter(Boolean); }
const rolePermissionLabelsClean = {
  admin:'Admin / alles',
  dashboard_view:'Dashboard ansehen',
  config_manage:'Einstellungen bearbeiten',
  sanction_manage:'Sanktionen verwalten',
  sanction_approve:'Sanktionen freigeben',
  absence_manage:'Abmeldungen verwalten',
  attendance_manage:'Wache/Anwesenheit verwalten',
  rollback_manage:'Rollback / Rückgängig'
};
function rolePermissionPanelClean(){
  const roles=DATA.config?.roles||{};
  const perms=roles.permissions||{};
  const keys=['admin','dashboard_view','config_manage','sanction_manage','sanction_approve','absence_manage','attendance_manage','rollback_manage'];
  const roleRows=guildRolesList().map(r=>[esc(r.name), `<span class="code">${esc(r.id)}</span>`, r.managed?'Bot/System':'Normal']);
  return `<div class="panel settings-section full-panel"><h2>Rollen & Rechte</h2>
    <p class="muted">Oben siehst du eindeutig, welche Discord-Rolle welche ID hat. Unten wählst du Rollen per Auswahlfeld aus — keine IDs mehr manuell eintippen.</p>
    <div class="panel"><h3>Discord-Rollen / IDs</h3>${roleRows.length?simpleTable(['Rolle','Discord-Rollen-ID','Typ'], roleRows):'<p class="muted">Keine Rollen vom Discord-Server geladen. Prüfe Bot-Token/Guild-ID.</p>'}</div>
    <div class="roles-grid">
      <label>Leadership-Rollen${roleMultiSelect('role_leadership', roles.leadership)}</label>
      <label>Routenverwaltung-Rollen${roleMultiSelect('role_routenverwaltung', roles.routenverwaltung)}</label>
      ${keys.map(k=>`<label>${esc(rolePermissionLabelsClean[k])}${roleMultiSelect('perm_'+k, perms[k])}</label>`).join('')}
      <label class="full">Admin-User-IDs<textarea id="role_adminUserIds" placeholder="Discord User IDs">${esc(idsToText(roles.adminUserIds || ['447008003170762753']))}</textarea></label>
    </div>
    <button class="primary" onclick="saveRolesPermissions()">Rollen & Berechtigungen speichern</button>
  </div>`;
}
async function saveRolesPermissions(){
  const keys=['admin','dashboard_view','config_manage','sanction_manage','sanction_approve','absence_manage','attendance_manage','rollback_manage'];
  const body={roles:{adminUserIds:splitRoleIdsText(document.getElementById('role_adminUserIds')?.value),leadership:selectedRoleIds('role_leadership'),routenverwaltung:selectedRoleIds('role_routenverwaltung')},permissions:{}};
  keys.forEach(k=>body.permissions[k]=selectedRoleIds('perm_'+k));
  await api('/api/config/roles-permissions',{method:'POST',body:JSON.stringify(body)});
  await refresh(true);
  toast('Rollen & Berechtigungen gespeichert');
}
async function saveChannelSettings(){
  const channels={};
  document.querySelectorAll('[data-channel-key]').forEach(el=>channels[el.dataset.channelKey]=el.value.trim());
  await api('/api/config/channels',{method:'POST',body:JSON.stringify({channels})});
  await refresh(true);
  toast('Kanäle gespeichert');
}
async function saveRuleSettingsClean(){
  const body={
    abgabeExcusedAfterDays:Number(document.getElementById('rule_abgabeExcusedAfterDays')?.value||0),
    absenceExcusedDays:Number(document.getElementById('rule_absenceExcusedDays')?.value||0),
    excusedAfterDays:Number(document.getElementById('rule_absenceExcusedDays')?.value||0),
    abgabeShiftDays:Number(document.getElementById('rule_abgabeShiftDays')?.value||0),
    statistikShiftDays:Number(document.getElementById('rule_statistikShiftDays')?.value||0),
    reportShiftDays:Number(document.getElementById('rule_statistikShiftDays')?.value||0),
    wacheRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),
    routeRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),
    wacheEnabled:document.getElementById('rule_wacheEnabled')?.value==='true',
    reportsEnabled:document.getElementById('rule_reportsEnabled')?.value==='true'
  };
  await api('/api/config/rules',{method:'POST',body:JSON.stringify(body)});
  await refresh(true);
  toast('Regeln gespeichert');
}

/* legacy settings renderer removed: centralPage() is the single source. */
/* legacy settings renderer removed: centralPage() is the single source. */
saveAllAbgabeSettings = async function(){
  for(const k of ['routen','patronen','schwarzpulver','meth']){
    const time=String(document.getElementById(`abg_${k}_time`)?.value||'23:59').split(':');
    await api('/api/config/abgaben',{method:'POST',body:JSON.stringify({
      category:k,
      enabled:document.getElementById(`abg_${k}_enabled`)?.checked,
      amount:Number(document.getElementById(`abg_${k}_amount`)?.value||0),
      deadlineDay:Number(document.getElementById(`abg_${k}_day`)?.value||7),
      deadlineHour:Number(time[0]||23),
      deadlineMinute:Number(time[1]||59)
    })});
  }
  await refresh(true);
  toast('Abgaben-Einstellungen gespeichert');
};

saveRuleSettingsClean = async function(){
  const body={
    abgabeExcusedAfterDays:Number(document.getElementById('rule_abgabeExcusedAfterDays')?.value||0),
    absenceExcusedDays:Number(document.getElementById('rule_absenceExcusedDays')?.value||0),
    excusedAfterDays:Number(document.getElementById('rule_absenceExcusedDays')?.value||0),
    wacheRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),
    routeRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),
    wacheEnabled:document.getElementById('rule_wacheEnabled')?.value==='true',
    reportsEnabled:document.getElementById('rule_reportsEnabled')?.value==='true'
  };
  await api('/api/config/rules',{method:'POST',body:JSON.stringify(body)});
  await refresh(true);
  toast('Regeln gespeichert');
};


// ===== Wochen-Detailansichten für Wache + Abgaben =====
let SELECTED_WACHE_WEEK = null;
let SELECTED_ABGABE_WEEK = null;

function isoWeekKeyFromDateLike(v){
  const s=String(v||'').trim();
  if(!s) return '';
  const direct=s.match(/(\d{4})-?W(\d{1,2})/i);
  if(direct) return `${direct[1]}-W${String(direct[2]).padStart(2,'0')}`;
  const d=new Date(s);
  if(isNaN(d)) return '';
  const date=new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum=date.getUTCDay()||7;
  date.setUTCDate(date.getUTCDate()+4-dayNum);
  const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo=Math.ceil((((date-yearStart)/86400000)+1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}
function weekMonday(weekKey){
  const m=String(weekKey||'').match(/^(\d{4})-W(\d{2})$/);
  if(!m) return null;
  const year=Number(m[1]), week=Number(m[2]);
  const jan4=new Date(Date.UTC(year,0,4));
  const day=jan4.getUTCDay()||7;
  const monday=new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate()-day+1+(week-1)*7);
  return monday;
}
function dateKey(d){
  if(!d || isNaN(d)) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function dayLabelFromIndex(i){
  return ['Mo','Di','Mi','Do','Fr','Sa','So'][i] || '';
}
function timeRangeForEntry(e){
  const start=e.start || e.from || e.startAt || e.startTs || e.createdAt || e.at || '';
  const end=e.end || e.to || e.endAt || e.endTs || e.until || '';
  const fmt=(x)=>{
    if(!x) return '';
    const d=new Date(x);
    if(!isNaN(d)) return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const m=String(x).match(/(\d{1,2})[:.](\d{2})/);
    return m?`${String(m[1]).padStart(2,'0')}:${m[2]}`:String(x);
  };
  const a=fmt(start), b=fmt(end);
  if(a && b) return `${a}–${b}`;
  return a || b || '—';
}
function durationForEntry(e){
  const mins=Number(e.minutes||e.durationMinutes||e.dauerMinuten||e.duration||0);
  if(!mins) return '';
  const h=Math.floor(mins/60), m=mins%60;
  if(h && m) return `${h}h ${m}m`;
  if(h) return `${h}h`;
  return `${m}m`;
}
function collectWacheRows(){
  const raw=[];
  const push=(x)=>{ if(x && typeof x==='object') raw.push(x); };

  if(Array.isArray(DATA.wache)) DATA.wache.forEach(push);
  if(Array.isArray(DATA.wache?.entries)) DATA.wache.entries.forEach(push);
  if(Array.isArray(DATA.wache?.sessions)) DATA.wache.sessions.forEach(push);
  if(Array.isArray(DATA.sessions)) DATA.sessions.forEach(push);
  if(Array.isArray(DATA.sessions?.entries)) DATA.sessions.entries.forEach(push);
  if(Array.isArray(DATA.sessions?.sessions)) DATA.sessions.sessions.forEach(push);

  // If sessions are grouped by id/object
  for(const src of [DATA.wache, DATA.sessions]){
    if(src && typeof src==='object' && !Array.isArray(src)){
      for(const v of Object.values(src)){
        if(Array.isArray(v)) v.forEach(push);
        else if(v && typeof v==='object' && (v.userId || v.memberId || v.start || v.from || v.weekKey)) push(v);
      }
    }
  }

  return raw.map(e=>{
    const start=e.start || e.from || e.startAt || e.startTs || e.createdAt || e.at || e.date || '';
    const d=new Date(start);
    const wk=e.weekKey || e.week || isoWeekKeyFromDateLike(start);
    const dk=e.dateKey || (!isNaN(d)?dateKey(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))):'');
    return {...e, _weekKey:wk, _dateKey:dk, _userId:e.userId||e.memberId||e.discordId||e.discord_id||e.id};
  }).filter(e=>e._weekKey);
}
function collectAbgabeRows(){
  const rows=(typeof allAbgabeRows==='function'?allAbgabeRows():[]);
  return rows.map(r=>({
    ...r,
    _weekKey:r.weekKey || r.week || isoWeekKeyFromDateLike(r.createdAt||r.at||r.deadline||r.date),
    _userId:r.userId||r.memberId||r.discordId||r.discord_id||r.id
  })).filter(r=>r._weekKey);
}
function uniqueSortedWeeks(rows){
  return [...new Set(rows.map(r=>r._weekKey).filter(Boolean))].sort().reverse();
}
function weekChooser(kind, weeks, selected){
  if(!selected && weeks.length) selected=weeks[0];
  const fn=kind==='wache'?'selectWacheWeek':'selectAbgabeWeek';
  return `<div class="week-chips">${weeks.slice(0,20).map(w=>`<button class="${w===selected?'active':''}" onclick="${fn}('${esc(w)}')">${esc(w)}</button>`).join('')}</div>`;
}
function selectWacheWeek(w){
  SELECTED_WACHE_WEEK=w;
  renderCurrent();
}
function selectAbgabeWeek(w){
  SELECTED_ABGABE_WEEK=w;
  renderCurrent();
}
function wacheWeekDetail(rows, weekKey){
  const monday=weekMonday(weekKey);
  const byDay={};
  for(let i=0;i<7;i++){
    const d=new Date(monday || Date.now());
    if(monday) d.setUTCDate(monday.getUTCDate()+i);
    byDay[i]=[];
  }
  for(const e of rows.filter(x=>x._weekKey===weekKey)){
    let idx=0;
    if(e._dateKey && monday){
      const dd=new Date(e._dateKey+'T00:00:00Z');
      idx=Math.round((dd-monday)/86400000);
      if(idx<0||idx>6) idx=0;
    } else {
      const st=new Date(e.start || e.from || e.startAt || e.startTs || e.createdAt || e.at || '');
      idx=isNaN(st)?0:((st.getDay()+6)%7);
    }
    byDay[idx].push(e);
  }
  const cells=[];
  for(let i=0;i<7;i++){
    const date=monday?`<small>${dateKey(new Date(monday.getTime()+i*86400000))}</small>`:'';
    const items=byDay[i].length?byDay[i].map(e=>{
      const name=displayNameForUser(e._userId);
      const range=timeRangeForEntry(e);
      const dur=durationForEntry(e);
      return `<div class="dienst-entry"><b>${esc(name)}</b><span>${esc(range)}${dur?' · '+esc(dur):''}</span></div>`;
    }).join(''):'<span class="muted">Keine Dienste</span>';
    cells.push(`<td><div class="day-head">${dayLabelFromIndex(i)} ${date}</div>${items}</td>`);
  }
  return `<div class="panel full-panel"><h2>Wache Woche ${esc(weekKey)}</h2><div class="table-wrap week-table-wrap"><table class="week-table"><thead><tr>${[0,1,2,3,4,5,6].map(i=>`<th>${dayLabelFromIndex(i)}</th>`).join('')}</tr></thead><tbody><tr>${cells.join('')}</tr></tbody></table></div></div>`;
}
function abgabeStatusFlags(r){
  const status=String(r.status||'').toLowerCase();
  const submitted=Boolean(r.submitted || r.done || r.paid || r.abgegeben || ['done','paid','abgegeben','erledigt','ok'].includes(status));
  const excused=Boolean(r.excused || r.entschuldigt || ['excused','entschuldigt','abgemeldet'].includes(status));
  const warning=Boolean(r.warning || r.warnphase || r.warned || ['warning','warnphase','warnung'].includes(status));
  const sanctioned=Boolean(r.sanctioned || r.sanktioniert || r.sanctionId || ['sanctioned','sanktioniert'].includes(status));
  return {submitted, excused, warning, sanctioned};
}
function yn(v){ return v?'<span class="yes">Ja</span>':'<span class="no">Nein</span>'; }
function abgabeWeekDetail(rows, weekKey){
  const weekRows=rows.filter(x=>x._weekKey===weekKey);
  const grouped=new Map();
  for(const r of weekRows){
    const key=normalizeLookupId(r._userId || r.userId || '') || JSON.stringify(r).slice(0,20);
    if(!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const tableRows=[];
  for(const [uid, list] of grouped.entries()){
    const flags=list.reduce((acc,r)=>{
      const f=abgabeStatusFlags(r);
      acc.submitted ||= f.submitted;
      acc.excused ||= f.excused;
      acc.warning ||= f.warning;
      acc.sanctioned ||= f.sanctioned;
      return acc;
    },{submitted:false,excused:false,warning:false,sanctioned:false});
    const cats=[...new Set(list.map(r=>niceKey(r.category||r.type||r.art||'Abgabe')))].join(', ');
    const statuses=[...new Set(list.map(r=>niceKey(r.status||'offen')))].join(', ');
    tableRows.push([
      userCell(uid),
      esc(cats),
      yn(flags.submitted),
      yn(flags.excused),
      yn(flags.warning),
      yn(flags.sanctioned),
      esc(statuses)
    ]);
  }
  tableRows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return `<div class="panel full-panel"><h2>Abgaben Woche ${esc(weekKey)}</h2>${tableRows.length?simpleTable(['Name','Art','Abgegeben','Entschuldigt','Warnphase','Sanktioniert','Status'], tableRows):'<p class="muted">Keine Abgaben für diese Woche gefunden.</p>'}</div>`;
}

// Override Wache page with weekly drilldown
wache = function(){
  const rows=collectWacheRows();
  const weeks=uniqueSortedWeeks(rows);
  if(!SELECTED_WACHE_WEEK || !weeks.includes(SELECTED_WACHE_WEEK)) SELECTED_WACHE_WEEK=weeks[0]||null;
  const summaryRows=weeks.map(w=>{
    const wr=rows.filter(r=>r._weekKey===w);
    const people=new Set(wr.map(r=>normalizeLookupId(r._userId)).filter(Boolean));
    const mins=wr.reduce((s,r)=>s+Number(r.minutes||r.durationMinutes||r.dauerMinuten||0),0);
    return [`<button class="linkbtn" onclick="selectWacheWeek('${esc(w)}')">${esc(w)}</button>`, esc(wr.length), esc(people.size), mins?esc(Math.round(mins/60*10)/10+'h'):'—'];
  });
  return `<div class="toolbar"><span class="pill gold">${weeks.length} Wochen</span></div>
    <div class="panel"><h2>Wache nach Wochen</h2><p class="muted">Klicke auf eine Woche, dann siehst du Montag bis Sonntag mit allen Diensten.</p>${weekChooser('wache',weeks,SELECTED_WACHE_WEEK)}${simpleTable(['Woche','Dienste','Personen','Stunden'],summaryRows)}</div>
    ${SELECTED_WACHE_WEEK?wacheWeekDetail(rows,SELECTED_WACHE_WEEK):''}`;
};

// Override Abgaben page with weekly drilldown
abgaben = function(){
  const rows=collectAbgabeRows();
  const weeks=uniqueSortedWeeks(rows);
  if(!SELECTED_ABGABE_WEEK || !weeks.includes(SELECTED_ABGABE_WEEK)) SELECTED_ABGABE_WEEK=weeks[0]||null;
  const summaryRows=weeks.map(w=>{
    const wr=rows.filter(r=>r._weekKey===w);
    const flags=wr.map(abgabeStatusFlags);
    const submitted=flags.filter(f=>f.submitted).length;
    const excused=flags.filter(f=>f.excused).length;
    const warning=flags.filter(f=>f.warning).length;
    const sanctioned=flags.filter(f=>f.sanctioned).length;
    return [`<button class="linkbtn" onclick="selectAbgabeWeek('${esc(w)}')">${esc(w)}</button>`, esc(wr.length), esc(submitted), esc(excused), esc(warning), esc(sanctioned)];
  });
  return `<div class="toolbar"><span class="pill gold">${weeks.length} Wochen</span><button onclick="goModule('leader_all');openCentralSection('system','abgaben')">Abgaben einstellen</button></div>
    <div class="panel"><h2>Abgaben nach Wochen</h2><p class="muted">Klicke auf eine Woche, dann siehst du pro Person abgegeben/nicht abgegeben, entschuldigt, Warnphase und sanktioniert.</p>${weekChooser('abgabe',weeks,SELECTED_ABGABE_WEEK)}${simpleTable(['Woche','Einträge','Abgegeben','Entschuldigt','Warnphase','Sanktioniert'],summaryRows)}</div>
    ${SELECTED_ABGABE_WEEK?abgabeWeekDetail(rows,SELECTED_ABGABE_WEEK):''}`;
};


// ===== Discord-like Abgaben-Wochenansicht + Web-Eintragung =====
function abgabeFlagEmoji(kind, value){
  if(kind==='submitted') return value ? '✅' : '❌';
  if(kind==='sanctioned') return value ? '✔️' : '—';
  if(kind==='warning') return value ? '⏰' : '—';
  if(kind==='excused') return value ? '🟡' : '—';
  if(kind==='prepaid') return value ? '🟦' : '—';
  return value ? '✔️' : '—';
}
function abgabeHumanStatus(r){
  const f=abgabeStatusFlags2(r);
  if(f.prepaid) return 'Vorausgezahlt';
  if(f.excused) return 'Entschuldigt';
  if(f.submitted) return 'Abgegeben';
  if(f.warning) return 'Warnphase';
  if(f.sanctioned) return 'Sanktioniert';
  return 'Nicht abgegeben';
}
function abgabeStatusFlags2(r){
  const status=String(r.status||r.state||'').toLowerCase();
  const text=String(`${r.status||''} ${r.note||''} ${r.reason||''}`).toLowerCase();
  return {
    submitted:Boolean(r.submitted || r.done || r.paid || r.abgegeben || ['done','paid','abgegeben','erledigt','ok'].includes(status)),
    excused:Boolean(r.excused || r.entschuldigt || ['excused','entschuldigt','abgemeldet'].includes(status) || text.includes('tage')),
    warning:Boolean(r.warning || r.warnphase || r.warned || ['warning','warnphase','warnung','nachholung','late'].includes(status)),
    sanctioned:Boolean(r.sanctioned || r.sanktioniert || r.sanctionId || ['sanctioned','sanktioniert'].includes(status)),
    prepaid:Boolean(r.prepaid || r.vorausgezahlt || ['prepaid','vorausgezahlt','vorauszahlung'].includes(status) || text.includes('voraus'))
  };
}
function abgabeWeekGrouped(rows, weekKey){
  const weekRows=rows.filter(x=>x._weekKey===weekKey);
  const grouped=new Map();
  for(const r of weekRows){
    const uid=normalizeLookupId(r._userId || r.userId || r.memberId || '');
    const key=uid || (r.name || JSON.stringify(r).slice(0,18));
    if(!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const people=[];
  for(const [uid,list] of grouped.entries()){
    const flags=list.reduce((acc,r)=>{
      const f=abgabeStatusFlags2(r);
      acc.submitted ||= f.submitted;
      acc.excused ||= f.excused;
      acc.warning ||= f.warning;
      acc.sanctioned ||= f.sanctioned;
      acc.prepaid ||= f.prepaid;
      return acc;
    },{submitted:false,excused:false,warning:false,sanctioned:false,prepaid:false});
    const amount=list.find(x=>Number(x.amount||x.menge))?.amount || list.find(x=>Number(x.menge))?.menge || '';
    const category=[...new Set(list.map(r=>niceKey(r.category||r.type||r.art||'Abgabe')))].join(', ');
    const rawStatus=[...new Set(list.map(r=>niceKey(r.status||'offen')))].join(', ');
    let group='missing';
    if(flags.prepaid) group='prepaid';
    else if(flags.excused) group='excused';
    else if(flags.submitted) group='submitted';
    else if(flags.warning) group='warning';
    else if(flags.sanctioned) group='sanctioned';
    people.push({uid,list,flags,amount,category,rawStatus,group,name:displayNameForUser(uid)});
  }
  people.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  return people;
}
function discordLikeGroup(title, emoji, list, empty='—'){
  return `<div class="discord-group"><h3>${emoji} ${esc(title)} <span>(${list.length})</span></h3>${
    list.length ? list.map(p=>`<div class="discord-line">• <b>${esc(p.name)}</b>${p.amount?` — ${esc(typeof moneyFull==='function'?moneyFull(p.amount):money(p.amount))}`:''}${p.rawStatus && p.rawStatus!=='Offen'?` <small>(${esc(p.rawStatus)})</small>`:''}</div>`).join('') : `<div class="muted">${empty}</div>`
  }</div>`;
}
function abgabeWeekDetail(rows, weekKey){
  const people=abgabeWeekGrouped(rows, weekKey);
  const submitted=people.filter(p=>p.group==='submitted');
  const excused=people.filter(p=>p.group==='excused');
  const warning=people.filter(p=>p.group==='warning');
  const prepaid=people.filter(p=>p.group==='prepaid');
  const sanctioned=people.filter(p=>p.group==='sanctioned');
  const missing=people.filter(p=>p.group==='missing');

  const simpleRows=people.map(p=>[
    userCell(p.uid),
    esc(p.category||'—'),
    abgabeFlagEmoji('submitted', p.flags.submitted || p.flags.prepaid),
    abgabeFlagEmoji('warning', p.flags.warning),
    abgabeFlagEmoji('excused', p.flags.excused),
    abgabeFlagEmoji('prepaid', p.flags.prepaid),
    abgabeFlagEmoji('sanctioned', p.flags.sanctioned),
    `<select onchange="quickSetAbgabeStatus('${esc(p.uid)}','${esc(weekKey)}',this.value)">
      <option value="">ändern...</option>
      <option value="abgegeben">✅ Abgegeben</option>
      <option value="warnphase">⏰ Warnphase</option>
      <option value="entschuldigt">🟡 Entschuldigt</option>
      <option value="vorausgezahlt">🟦 Vorausgezahlt</option>
      <option value="sanktioniert">✔️ Sanktioniert</option>
      <option value="offen">❌ Nicht abgegeben</option>
    </select>`
  ]);

  return `<div class="panel full-panel"><div class="week-detail-head"><div><h2>Abgaben Woche ${esc(weekKey)}</h2><p class="muted">Wie im Discord: Wer hat abgegeben, wer ist in Warnphase/Nachholung, wer ist entschuldigt, wer hat vorausgezahlt und wer fehlt.</p></div><button class="primary" onclick="openAbgabeEntryModal('${esc(weekKey)}')">+ Abgabe eintragen</button></div>
    <div class="discord-abgabe-board">
      ${discordLikeGroup('Noch offen', '🚩', missing)}
      ${discordLikeGroup('Abgegeben', '✅', submitted)}
      ${discordLikeGroup('Entschuldigt', '🟡', excused)}
      ${discordLikeGroup('Warnphase / Nachholung', '🟠', warning)}
      ${discordLikeGroup('Vorausgezahlt', '🟦', prepaid)}
      ${discordLikeGroup('Sanktioniert', '❌', sanctioned)}
    </div>
    <h3 class="subhead">Kurz-Tabelle</h3>
    ${simpleTable(['Name','Art','Abgegeben','Warnphase','Entschuldigt','Vorausgezahlt','Sanktioniert','Aktion'], simpleRows)}
  </div>`;
}
function collectKnownMembersForAbgabe(){
  const out=new Map();
  const add=(id,name)=>{
    id=normalizeLookupId(id);
    if(!id) return;
    out.set(id, name || displayNameForUser(id));
  };
  const arrays=[
    ...(Array.isArray(DATA?.members)?DATA.members:[]),
    ...(Array.isArray(DATA?.phonebook)?DATA.phonebook:[]),
    ...(Array.isArray(DATA?.phonebook?.items)?DATA.phonebook.items:[]),
    ...(Array.isArray(DATA?.numbers)?DATA.numbers:[]),
    ...(Array.isArray(DATA?.numbers?.members)?DATA.numbers.members:[])
  ];
  arrays.forEach(x=>{
    if(!x || typeof x!=='object') return;
    add(x.userId||x.discordId||x.discord_id||x.id||x.memberId, x.nickname||x.displayName||x.name||x.username||x.rpName||x.charName);
  });
  for(const src of [DATA?.numbers, DATA?.phonebook, DATA?.membersById, DATA?.users]){
    if(src && typeof src==='object' && !Array.isArray(src)){
      Object.entries(src).forEach(([id,x])=>{
        if(typeof x==='string') add(id,x);
        else if(x && typeof x==='object') add(id,x.nickname||x.displayName||x.name||x.username||x.rpName||x.charName);
      });
    }
  }
  // Also from current abgabe rows
  collectAbgabeRows().forEach(r=>add(r._userId));
  return [...out.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1])));
}
function openAbgabeEntryModal(weekKey){
  const members=collectKnownMembersForAbgabe();
  const cats=['routen','patronen','schwarzpulver','meth'];
  modal(`<h2>Abgabe eintragen</h2>
    <div class="form-grid">
      <label>Woche<input id="manual_abg_week" value="${esc(weekKey||SELECTED_ABGABE_WEEK||'')}"></label>
      <label>Person<select id="manual_abg_user">${members.map(([id,name])=>`<option value="${esc(id)}">${esc(name)} — ${esc(shortDiscordId(id))}</option>`).join('')}</select></label>
      <label>Art<select id="manual_abg_category">${cats.map(k=>`<option value="${esc(k)}">${esc(niceKey(k))}</option>`).join('')}</select></label>
      <label>Betrag / Menge<input id="manual_abg_amount" type="number" value="0"></label>
      <label>Status<select id="manual_abg_status">
        <option value="abgegeben">✅ Abgegeben</option>
        <option value="warnphase">⏰ Warnphase</option>
        <option value="entschuldigt">🟡 Entschuldigt</option>
        <option value="vorausgezahlt">🟦 Vorausgezahlt</option>
        <option value="sanktioniert">✔️ Sanktioniert</option>
        <option value="offen">❌ Nicht abgegeben</option>
      </select></label>
      <label>Notiz<input id="manual_abg_note" placeholder="optional"></label>
    </div>
    <div class="modal-actions"><button onclick="closeModal()">Abbrechen</button><button class="primary" onclick="saveManualAbgabeEntry()">Speichern</button></div>`);
}
async function saveManualAbgabeEntry(){
  const body={
    weekKey:document.getElementById('manual_abg_week')?.value.trim(),
    userId:document.getElementById('manual_abg_user')?.value,
    category:document.getElementById('manual_abg_category')?.value,
    amount:Number(document.getElementById('manual_abg_amount')?.value||0),
    status:document.getElementById('manual_abg_status')?.value,
    note:document.getElementById('manual_abg_note')?.value||''
  };
  await api('/api/abgaben/manual-web',{method:'POST',body:JSON.stringify(body)});
  closeModal();
  await refresh(true);
  SELECTED_ABGABE_WEEK=body.weekKey;
  renderCurrent();
  toast('Abgabe eingetragen');
}
async function quickSetAbgabeStatus(userId, weekKey, status){
  if(!status) return;
  const cats=['routen','patronen','schwarzpulver','meth'];
  const category=prompt('Für welche Abgabe? routen / patronen / schwarzpulver / meth', cats[0]) || cats[0];
  await api('/api/abgaben/manual-web',{method:'PATCH',body:JSON.stringify({userId,weekKey,category,status})});
  await refresh(true);
  SELECTED_ABGABE_WEEK=weekKey;
  renderCurrent();
  toast('Status geändert');
}

// Override Abgaben page summary to match Discord groups
abgaben = function(){
  const rows=collectAbgabeRows();
  const weeks=uniqueSortedWeeks(rows);
  if(!SELECTED_ABGABE_WEEK || !weeks.includes(SELECTED_ABGABE_WEEK)) SELECTED_ABGABE_WEEK=weeks[0]||null;
  const summaryRows=weeks.map(w=>{
    const people=abgabeWeekGrouped(rows,w);
    return [
      `<button class="linkbtn" onclick="selectAbgabeWeek('${esc(w)}')">${esc(w)}</button>`,
      esc(people.length),
      esc(people.filter(p=>p.group==='submitted').length),
      esc(people.filter(p=>p.group==='warning').length),
      esc(people.filter(p=>p.group==='excused').length),
      esc(people.filter(p=>p.group==='prepaid').length),
      esc(people.filter(p=>p.group==='missing').length)
    ];
  });
  return `<div class="toolbar"><span class="pill gold">${weeks.length} Wochen</span><button class="primary" onclick="openAbgabeEntryModal('${esc(SELECTED_ABGABE_WEEK||'')}')">+ Abgabe eintragen</button><button onclick="goModule('leader_all');openCentralSection('system','abgaben')">Abgaben einstellen</button></div>
    <div class="panel"><h2>Abgaben nach Wochen</h2><p class="muted">Klicke auf eine Woche. Dann siehst du die gleiche Logik wie im Discord-Post.</p>${weekChooser('abgabe',weeks,SELECTED_ABGABE_WEEK)}${simpleTable(['Woche','Personen','✅ Abgegeben','⏰ Warnphase','🟡 Entschuldigt','🟦 Vorausgezahlt','❌ Offen'],summaryRows)}</div>
    ${SELECTED_ABGABE_WEEK?abgabeWeekDetail(rows,SELECTED_ABGABE_WEEK):''}`;
};




/* ===== SINGLE SOURCE CENTRAL UI - do not add more central renderers below this block ===== */
(function(){
  'use strict';
  const CENTRAL = 'leader_all';
  const DEFAULT_ABGABE_KEYS = ['patronen','schwarzgeld','meth'];
  function customization(){ return DATA?.config?.settings?.customization || {}; }
  function abgabeTypeList(){ const custom = customization().abgabeTypes || []; const seen = new Set(); const arr=[]; for(const k of DEFAULT_ABGABE_KEYS){ seen.add(k); arr.push({key:k,label:NAMES[k]||k,active:true,includeInStats:true}); } for(const t of custom){ if(!t?.key) continue; if(seen.has(t.key)){ Object.assign(arr.find(x=>x.key===t.key), t); } else { seen.add(t.key); arr.push(t); } } return arr; }
  function abgabeKeys(){ return abgabeTypeList().filter(t=>t.active!==false).map(t=>t.key); }
  function labelFor(path, fallback){ const labels=customization().labels||{}; return labels[path] || fallback; }
  const DAYS = {1:'Montag',2:'Dienstag',3:'Mittwoch',4:'Donnerstag',5:'Freitag',6:'Samstag',7:'Sonntag'};
  const NAMES = {routenwache:'Wache', patronen:'Patronen', schwarzgeld:'Schwarzgeld', meth:'Meth'};
  window.centralTab = window.centralTab || 'leader';
  window.centralSection = window.centralSection || 'dashboard';

  const E = window.esc || (s => String(s ?? '').replace(/[&<>\"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[m])));
  const N = k => NAMES[k] || (typeof niceKey === 'function' ? niceKey(k) : k);
  const isAdmin = () => !!(DATA?.me?.permissions?.roleGroups?.isAdminUser || DATA?.me?.permissions?.actions?.admin || DATA?.me?.permissions?.actions?.dashboardAdmin || DATA?.me?.permissions?.actions?.adminPanelWrite);
  const isLeader = () => isAdmin() || !!(DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.modules?.leader_all || DATA?.me?.permissions?.actions?.leaderPanelWrite || DATA?.me?.permissions?.actions?.configWrite);
  const apiCall = (path, opts={}) => api(path, opts);

  function isoWeekKey(d=new Date()){
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
  }
  function weeksList(){
    const set = new Set([isoWeekKey()]);
    try { Object.keys(DATA?.abgaben?.weeks || {}).forEach(w => set.add(w)); } catch(_){ }
    try { Object.keys(DATA?.config?.settings?.abgabenTemporaryOverrides || {}).forEach(w => set.add(w)); } catch(_){ }
    return [...set].filter(Boolean).sort().reverse().slice(0,16);
  }

  function top(){
    return `<div class="central-topbar"><div><h2>⚙️ Zentrale Verwaltung</h2><p>Leader Panel · Systemsteuerung · Admin Panel</p></div><button onclick="refresh()">Aktualisieren</button></div>`;
  }
  window.historyBackCentral = function(){
    if(window.centralSection && window.centralSection !== 'dashboard'){ window.centralSection='dashboard'; return renderCurrent(); }
    go('overview');
  };
  window.setCentralTab = function(tab){
    if(tab === 'admin' && !isAdmin()) return toast('Admin Panel ist nur für Admins.');
    window.centralTab = tab;
    window.centralSection = tab === 'leader' ? 'dashboard' : tab === 'system' ? 'system' : 'members';
    renderCurrent();
  };
  window.openCentralSection = function(tab, section){
    if(tab === 'admin' && !isAdmin()) return toast('Admin Panel ist nur für Admins.');
    window.centralTab = tab;
    window.centralSection = section || (tab === 'leader' ? 'dashboard' : tab);
    renderCurrent();
  };

  function tabButton(tab,label,desc){
    return `<button class="central-tab ${window.centralTab===tab?'active':''}" onclick="setCentralTab('${tab}')"><b>${label}</b><span>${desc}</span></button>`;
  }
  function centralTabs(){
    return `<div class="central-tabs clean-three-tabs">
      ${tabButton('leader','Leader Panel','Abgaben, Wache, Sanktionen, Freigaben')}
      ${tabButton('system','Systemsteuerung','Reminder, Smart Ping, Automatik, Sicherheit')}
      ${tabButton('admin','Admin Panel','Mitglieder, Rollen, Kanäle, Logs')}
    </div>`;
  }
  function centralPage(){
    if(!isLeader()) return locked();
    const body = window.centralTab === 'admin' ? adminPanel() : window.centralTab === 'system' ? systemPanel() : leaderPanel();
    return `<div class="central-page single-source-ui">${top()}${centralTabs()}${body}</div>`;
  }

  function subActions(items){ return `<div class="central-subactions">${items.map(([tab,sec,label])=>`<button class="${window.centralSection===sec?'active':''}" onclick="openCentralSection('${tab}','${sec}')">${label}</button>`).join('')}</div>`; }
  function panel(title, desc, content){ return `<section class="central-panel"><div class="central-panel-head"><div><h2>${title}</h2>${desc?`<p>${desc}</p>`:''}</div></div>${content}</section>`; }

  function leaderPanel(){
    const buttons = subActions([['leader','dashboard','Übersicht'],['leader','abgaben','Abgaben'],['leader','abgabeTypes','Abgabearten verwalten'],['leader','wache','Wache'],['leader','sanctions','Sanktionen & Freigaben'],['leader','blood','Blood in/out']]);
    let content = '';
    if(window.centralSection === 'abgaben') content = abgabenCentral();
    else if(window.centralSection === 'abgabeTypes') content = customizationStudio('abgaben');
    else if(window.centralSection === 'wache') content = panel('🟢 Wache','Wache einstellen und Pflichtzeit konfigurieren.', typeof wacheCentral === 'function' ? wacheCentral() : (typeof wache === 'function' ? wache() : '<p>Keine Wache-Funktion gefunden.</p>'));
    else if(window.centralSection === 'sanctions') content = sanctionsCentral();
    else if(window.centralSection === 'blood') content = panel('◇ Blood in/out','Blood-Protokoll und Aktionen.', typeof blood === 'function' ? blood() : '<p>Keine Blood-Funktion gefunden.</p>');
    else content = leaderDashboard();
    return `${buttons}${content}`;
  }

  function leaderDashboard(){
    const st = DATA?.stats || {};
    const cfg = DATA?.config?.settings?.abgabenConfig || {};
    const en = DATA?.config?.settings?.abgabenEnabled || {};
    return panel('Leader Panel','Alles Wichtige in einer kompakten Übersicht.', `<div class="central-overview-row smart-fit">
      <button class="overview-card danger" onclick="openCentralSection('leader','sanctions')"><span>Offene Sanktionen</span><b>${E(st.openSanctions ?? 0)}</b></button>
      <button class="overview-card" onclick="openCentralSection('leader','abgaben')"><span>Abgaben</span><b>Regeln</b></button>
      <button class="overview-card" onclick="openCentralSection('leader','abgabeTypes')"><span>Abgabearten</span><b>${abgabeKeys().filter(k=>en[k]!==false).length}</b><small>Erstellen · Löschen · Statistik</small></button>
      <button class="overview-card" onclick="openCentralSection('leader','wache')"><span>Wache</span><b>${DATA?.config?.settings?.wacheEnabled===false?'AUS':'AN'}</b></button>
      <button class="overview-card" onclick="openCentralSection('leader','blood')"><span>Blood in/out</span><b>Öffnen</b></button>
    </div><div class="compact-list">${abgabeKeys().map(k=>{const c=cfg[k]||{}; return `<div><span>${E(N(k))}</span><b>${en[k]!==false?'AN':'AUS'} · ${E(c.amount||0)} · ${E(DAYS[Number(c.deadlineDay||7)]||'So')} ${String(c.deadlineHour??23).padStart(2,'0')}:${String(c.deadlineMinute??59).padStart(2,'0')}</b></div>`;}).join('')}</div>`);
  }

  function abgabenCentral(){
    return panel('📦 Abgaben','Hier werden nur die Abgabe-Regeln eingestellt. Eintragen läuft im normalen Bereich „Abgaben“.', `<div class="central-inline-actions"><button class="primary" onclick="saveAbgabenRules()">Abgaben-Regeln speichern</button><button onclick="goModule('abgaben')">Zu Abgaben wechseln</button></div>${abgabeRules()}`);
  }

  function abgabenDiscordPanel(){
    const en = DATA?.config?.settings?.abgabenEnabled || {};
    const active = abgabeKeys().filter(k=>en[k]!==false);
    const week = window.abgabePanelWeek || isoWeekKey();
    const options = active.map(k=>`<option value="${E(k)}">${E(N(k))}</option>`).join('');
    return `<div class="discord-action-panel"><h3>Abgabe-Panel</h3><p class="muted">Nur aktive Abgabearten werden gelistet. „Zu spät“ gilt automatisch für die vorherige Woche.</p><div class="abgabe-fields"><label>Art<select id="discord_abgabe_cat">${options}</select></label><label>Woche<input id="discord_abgabe_week" value="${E(week)}"></label><label>User-ID<input id="discord_abgabe_user" value="${E(DATA?.me?.id||'')}"></label></div><div class="central-inline-actions"><button class="primary" onclick="setDiscordAbgabeStatus('abgegeben')">Abgegeben</button><button onclick="setDiscordAbgabeStatus('entschuldigt')">Entschuldigt</button><button onclick="setDiscordAbgabeStatus('delete')">Löschen</button><button onclick="setDiscordAbgabeStatus('zusatz')">Zusatz</button><button class="danger-btn" onclick="setDiscordAbgabeStatus('zuspaet')">Zu spät</button></div></div>`;
  }
  window.setDiscordAbgabeStatus = async function(status){
    const category=document.getElementById('discord_abgabe_cat')?.value;
    const userId=document.getElementById('discord_abgabe_user')?.value;
    let weekKey=document.getElementById('discord_abgabe_week')?.value || isoWeekKey();
    if(status==='zuspaet') weekKey = previousIsoWeekKey(weekKey);
    if(!category || !userId) return toast('Bitte Art und User-ID angeben.');
    if(status==='delete') await apiCall('/api/abgaben/update',{method:'POST',body:JSON.stringify({weekKey,category,userId,patch:{status:'gelöscht',note:'gelöscht über Web-Panel'}})});
    else await apiCall('/api/abgaben/update',{method:'POST',body:JSON.stringify({weekKey,category,userId,patch:{status,note:'Web-Panel'}})});
    await refresh(true); toast('Abgabe aktualisiert');
  };
  function previousIsoWeekKey(w){
    const m=String(w||'').match(/^(\d{4})-W(\d{2})$/); if(!m) return w;
    const d=new Date(Date.UTC(Number(m[1]),0,1+(Number(m[2])-1)*7)); d.setUTCDate(d.getUTCDate()-7); return isoWeekKey(d);
  }
  function canManageWache(){ return isLeader() || !!(DATA?.me?.permissions?.actions?.attendanceManage || DATA?.me?.permissions?.actions?.configWrite || DATA?.me?.permissions?.roleGroups?.isRouteManagement || DATA?.me?.permissions?.roleGroups?.isRouteManagementLead); }
  function wacheCentral(){
    const set=DATA?.config?.settings||{}; const manage=canManageWache();
    const cfg=`<div class="settings-grid compact-settings"><label class="card setting-card"><div><div class="label">Wache aktiv</div><p>Aktiviert die wöchentliche Pflichtzeit.</p></div><input id="rule_wacheEnabled" type="checkbox" ${set.wacheEnabled!==false?'checked':''} ${manage?'':'disabled'}></label><label class="card setting-card"><div><div class="label">Pflichtzeit pro Woche</div><p>Minuten, nicht Menge.</p></div><input id="rule_wacheMinutes" type="number" value="${E(set.wacheRequiredMinutes||set.routeRequiredMinutes||0)}" ${manage?'':'disabled'}></label></div>${manage?'<button class="primary" onclick="saveWacheRulesOnly()">Wache-Regeln speichern</button>':'<div class="locked-note">Nur Leaderschaft, Routenverwaltung und Routenverwaltung-Leitung dürfen anpassen.</div>'}`;
    return cfg + `<div class="nested-module">${typeof wache === 'function' ? wache() : '<p>Keine Wache-Funktion gefunden.</p>'}</div>`;
  }
  window.saveWacheRulesOnly = async function(){
    if(!canManageWache()) return toast('Keine Berechtigung.');
    const body={wacheEnabled:!!document.getElementById('rule_wacheEnabled')?.checked,wacheRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),routeRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0)};
    await apiCall('/api/config/settings',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Wache-Regeln gespeichert');
  };

  window.toggleAbgabenList = function(){ window.showAbgabenList = !window.showAbgabenList; renderCurrent(); };
  function abgabeRules(){
    const cfg = DATA?.config?.settings?.abgabenConfig || {};
    const en = DATA?.config?.settings?.abgabenEnabled || {};
    const overrides = DATA?.config?.settings?.abgabenTemporaryOverrides || {};
    const weeks = weeksList(); const week = window.shiftWeek || weeks[0] || isoWeekKey(); window.shiftWeek = week;
    return `<div class="shift-week-row"><label>Woche<select onchange="window.shiftWeek=this.value;renderCurrent()">${weeks.map(w=>`<option value="${E(w)}" ${w===week?'selected':''}>${E(w)}</option>`).join('')}</select></label><span>+7 Tage ist doppelte Abgabe, Betrag bleibt änderbar.</span></div><div class="abgabe-rule-grid">${abgabeKeys().map(k=>{
      const c=cfg[k]||{}; const o=(overrides[week]||{})[k]||{}; const base=Number(c.amount||0); const preAmount=Number(o.amountOverride || (o.shiftDays===7 ? base*2 : base)); const time=`${String(c.deadlineHour??23).padStart(2,'0')}:${String(c.deadlineMinute??59).padStart(2,'0')}`;
      return `<article class="abgabe-rule-card"><div class="abgabe-card-title"><h3>${E(N(k))}</h3><label><input id="abg_${k}_enabled" type="checkbox" ${en[k]!==false?'checked':''}> aktiv</label></div><div class="abgabe-fields"><label>Betrag/Menge<input id="abg_${k}_amount" type="number" value="${E(base)}"></label><label>Frist-Tag<select id="abg_${k}_day">${[1,2,3,4,5,6,7].map(d=>`<option value="${d}" ${Number(c.deadlineDay||7)===d?'selected':''}>${DAYS[d]}</option>`).join('')}</select></label><label>Uhrzeit<input id="abg_${k}_time" type="time" value="${time}"></label></div><div class="abgabe-move-box"><div><b>Einmalig verschieben</b><small>${o.shiftDays?`Aktiv: +${E(o.shiftDays)} Tag(e)${o.doubleAbgabe?' / doppelte Abgabe':''}`:'Keine aktive Verschiebung'}</small></div><div class="move-buttons"><button onclick="setTempShift('${k}',1)">+1 Tag</button><button onclick="setTempShift('${k}',2)">+2 Tage</button><button class="primary" onclick="setTempShift('${k}',7)">+7 doppelt</button></div><div class="move-custom"><label>Tage<input id="move_${k}_days" type="number" min="1" max="30" value="${E(o.shiftDays||1)}"></label><label>Betrag/Menge<input id="move_${k}_amount" type="number" value="${E(preAmount)}"></label><button onclick="saveTempShift('${k}')">Speichern</button><button class="danger-btn" onclick="clearTempShift('${k}')">Löschen</button></div></div></article>`;
    }).join('')}</div>`;
  }
  function abgabeListBlock(){
    if(!window.showAbgabenList) return '';
    return `<div class="nested-module">${typeof abgaben === 'function' ? abgaben() : '<p>Keine Abgabenliste gefunden.</p>'}</div>`;
  }
  window.setTempShift = function(cat, days){
    const d=document.getElementById(`move_${cat}_days`); if(d) d.value=String(days);
    const amount=document.getElementById(`move_${cat}_amount`); const base=Number(document.getElementById(`abg_${cat}_amount`)?.value||0);
    if(amount && Number(days)===7) amount.value=String(base*2);
    saveTempShift(cat);
  };
  window.saveTempShift = async function(cat){
    const week = window.shiftWeek || isoWeekKey();
    const days = Number(document.getElementById(`move_${cat}_days`)?.value || 1);
    const amount = Number(document.getElementById(`move_${cat}_amount`)?.value || 0);
    await apiCall('/api/config/abgaben/temporary-shift',{method:'POST',body:JSON.stringify({category:cat,weekKey:week,days,amount})});
    await refresh(true); toast('Verschiebung gespeichert');
  };
  window.clearTempShift = async function(cat){
    const week = window.shiftWeek || isoWeekKey();
    await apiCall('/api/config/abgaben/temporary-clear',{method:'POST',body:JSON.stringify({category:cat,weekKey:week})});
    await refresh(true); toast('Verschiebung gelöscht');
  };
  window.saveAbgabenRules = async function(){
    for(const k of abgabeKeys()){
      const [h,m] = String(document.getElementById(`abg_${k}_time`)?.value || '23:59').split(':');
      await apiCall('/api/config/abgaben',{method:'POST',body:JSON.stringify({category:k,enabled:!!document.getElementById(`abg_${k}_enabled`)?.checked,amount:Number(document.getElementById(`abg_${k}_amount`)?.value||0),deadlineDay:Number(document.getElementById(`abg_${k}_day`)?.value||7),deadlineHour:Number(h||23),deadlineMinute:Number(m||59)})});
    }
    await refresh(true); toast('Abgaben-Regeln gespeichert');
  };

  function sanctionsCentral(){
    return panel('⚠️ Sanktionen & Freigaben','Beim Löschen werden auch gespeicherte Discord-Nachrichten aus „Ausgeteilte Strafen“ gelöscht, soweit IDs vorhanden sind.', `<div class="central-inline-actions"><button class="danger-btn" onclick="deleteAllOpenSanctionsFull()">Alle offenen Sanktionen löschen</button></div>${typeof sanctions === 'function' ? sanctions() : '<p>Keine Sanktionen-Funktion gefunden.</p>'}`);
  }
  window.deleteAllOpenSanctionsFull = async function(){
    if(!confirm('Alle offenen Sanktionen löschen und Discord-Nachrichten entfernen?')) return;
    const r = await apiCall('/api/sanctions/delete-open',{method:'POST',body:JSON.stringify({deleteMessages:true,deleteDms:true})});
    await refresh(true); toast(`Offene Sanktionen gelöscht: ${r.count||0}`);
  };

  function systemPanel(){
    const set=DATA?.config?.settings||{};
    if(window.centralSection === 'statsConfig') return customizationStudio('stats');
    if(window.centralSection === 'textsConfig') return customizationStudio('texts');
    if(window.centralSection === 'messagesConfig') return customizationStudio('messages');
    const sysButtons = subActions([['system','system','System'],['system','messagesConfig','Nachrichten & Embeds'],['system','statsConfig','Statistiken konfigurieren'],['system','textsConfig','Texte/Labels']]);
    const keys=['smartPingEnabled','autoSanctionsEnabled','termRemindersEnabled','decisionHintsEnabled','leaderReminderDmEnabled','fridayMissingReportEnabled','mondayOverdueReportEnabled','routeAdminFridayReportEnabled','routeAdminMondayReportEnabled','dashboardEnabled','reportsEnabled','dryRunEnabled','logSystemEnabled','spamProtectionEnabled'];
    return sysButtons + panel('⚙️ Systemsteuerung','Globale Bot-Steuerung. Nachrichten, Embeds, Texte und Statistiken sind über die Buttons oben erreichbar.', `<div class="settings-grid compact-settings smart-fit">${keys.map(k=>typeof niceSettingCard==='function'?niceSettingCard(k,set):`<label>${E(k)}<input id="set_${k}" type="checkbox" ${set[k]?'checked':''}></label>`).join('')}</div><button class="primary" onclick="saveSystemSettingsOnly()">Systemsteuerung speichern</button>`);
  }
  function customizationStudio(mode='all'){
    const c=customization(); const labels=c.labels||{}; const templates=c.templates||{}; const abTypes=abgabeTypeList(); const cards=c.statCards||[];
    const templateNames=['bloodin','bloodout','abgabe','sanktion'];
    const preview=(key)=>{ const t=templates[key]||{}; const sample={name:'RDF | Beispiel',userId:'123456789',date:new Date().toLocaleString('de-DE'),reason:'Beispiel-Grund',category:'Patronen',status:'abgegeben',week:isoWeekKey(),amount:'150'}; const fill=x=>String(x||'').replace(/\{(\w+)\}/g,(_,p)=>sample[p]??''); return `<div class="embed-preview" style="border-left:4px solid ${E(t.color||'#d4af37')}"><h3>${E(fill(t.title||key))}</h3><p>${E(fill(t.message||''))}</p>${(t.fields||[]).map(f=>`<div><b>${E(fill(f.name))}</b><br>${E(fill(f.value))}</div>`).join('')}</div>`; };
    const textBlock = `<div class="panel"><h2>Texte / Labels</h2><p class="muted">Alle wichtigen UI-Texte zentral ändern.</p><div class="form-grid smart-form">
          ${['overviewTitle','overviewSubtitle','inventoryOwnTitle','abgabenTitle','statisticsTitle','bloodTitle'].map(k=>`<label>${E(k)}<input id="lbl_${k}" value="${E(labels[k]||'')}"></label>`).join('')}
          <button class="primary full" onclick="saveCustomLabels()">Labels speichern</button>
        </div></div>`;
    const statBlock = `<div class="panel"><h2>Statistik-Karten</h2><p class="muted">Bestimme, welche Karten angezeigt werden und wie sie heißen. Quelle z. B. stats.families, stats.members, stats.cashBalance, stats.openSanctions, stats.absencesActive, stats.inventoryUsers.</p><div id="statCardEditor">${cards.map((x,i)=>`<div class="mini-editor smart-mini"><input id="stat_${i}_label" value="${E(x.label||'')}"><input id="stat_${i}_source" value="${E(x.source||'')}"><label><input id="stat_${i}_visible" type="checkbox" ${x.visible!==false?'checked':''}> sichtbar</label></div>`).join('')}</div><div class="central-inline-actions"><button onclick="addStatCard()">+ Karte</button><button class="primary" onclick="saveStatCards()">Statistiken speichern</button></div></div>`;
    const abgabeBlock = `<div class="panel"><h2>Abgabearten erstellen/löschen</h2><p class="muted">Hier neue Arten anlegen, bestehende bearbeiten, löschen/deaktivieren und in Statistiken einbinden.</p><div class="form-grid smart-form"><label>Key<input id="newAbg_key" placeholder="z_b_eisen"></label><label>Name<input id="newAbg_label" placeholder="Eisenabgaben"></label><label>Emoji<input id="newAbg_emoji" value="📦"></label><label>Einheit<input id="newAbg_unit" placeholder="Stück / $ / Kisten"></label><label>Rollen-ID<input id="newAbg_roleId"></label><label>Channel-Name<input id="newAbg_channelName"></label><label>Pflichtmenge<input id="newAbg_amount" type="number" value="0"></label><label><input id="newAbg_stats" type="checkbox" checked> in Statistik einbinden</label><button class="primary full" onclick="saveAbgabeType()">Abgabeart speichern/erstellen</button></div>${simpleTable(['Key','Name','Statistik','Aktion'], abTypes.map(t=>[t.key,t.label||t.key,t.includeInStats===false?'—':'✅',`<button onclick="editAbgabeType('${E(t.key)}')">Bearbeiten</button> <button class="danger-btn" onclick="deleteAbgabeType('${E(t.key)}')">Löschen</button>`]))}</div>`;
    const messageBlock = `<div class="grid two-col smart-fit">${templateNames.map(key=>{ const t=templates[key]||{}; return `<div class="panel"><h2>${E(key)} Embed/Nachricht</h2><div class="form-grid smart-form"><label>Titel<input id="tpl_${key}_title" value="${E(t.title||'')}"></label><label>Farbe<input id="tpl_${key}_color" value="${E(t.color||'#d4af37')}"></label><label class="full">Nachricht<textarea id="tpl_${key}_message">${E(t.message||'')}</textarea></label><label class="full">Felder JSON<textarea id="tpl_${key}_fields">${E(JSON.stringify(t.fields||[],null,2))}</textarea></label><label><input id="tpl_${key}_enabled" type="checkbox" ${t.enabled!==false?'checked':''}> aktiv</label><label><input id="tpl_${key}_embed" type="checkbox" ${t.embed!==false?'checked':''}> als Embed</label><button class="primary full" onclick="saveTemplate('${key}')">Template speichern</button></div><h3>Vorschau</h3>${preview(key)}</div>`; }).join('')}</div>`;
    let content = '';
    let title = '🧩 Anpassungs-Zentrale';
    let desc = 'Texte, Embeds, Abgabearten, Statistik-Karten und Anzeigen zentral bearbeiten. Platzhalter: {name}, {userId}, {date}, {reason}, {category}, {status}, {week}, {amount}.';
    if(mode==='abgaben'){ title='📦 Abgabearten verwalten'; desc='Abgabearten erstellen, bearbeiten, löschen/deaktivieren und in Statistiken einbinden.'; content=abgabeBlock; }
    else if(mode==='messages'){ title='💬 Nachrichten & Embeds'; desc='Bloodin/Bloodout und weitere Bot-Nachrichten mit Live-Vorschau bearbeiten.'; content=messageBlock; }
    else if(mode==='stats'){ title='📊 Statistiken konfigurieren'; desc='Auswählen, welche Statistik-Karten angezeigt werden und wie sie heißen.'; content=statBlock; }
    else if(mode==='texts'){ title='🏷️ Texte & Labels'; desc='Oberflächentexte und wichtige Labels zentral ändern.'; content=textBlock; }
    else { content = `<div class="grid two-col smart-fit">${textBlock}${statBlock}</div>${abgabeBlock}${messageBlock}`; }
    return panel(title, desc, content);
  }
  window.saveCustomLabels=async function(){ const labels={}; ['overviewTitle','overviewSubtitle','inventoryOwnTitle','abgabenTitle','statisticsTitle','bloodTitle'].forEach(k=>labels[k]=document.getElementById('lbl_'+k)?.value||''); await apiCall('/api/config/customization',{method:'POST',body:JSON.stringify({labels})}); await refresh(true); toast('Labels gespeichert'); };
  window.saveTemplate=async function(key){ let fields=[]; try{ fields=JSON.parse(document.getElementById(`tpl_${key}_fields`)?.value||'[]'); }catch(e){ return toast('Felder JSON ist ungültig'); } const templates={}; templates[key]={title:document.getElementById(`tpl_${key}_title`)?.value||'', color:document.getElementById(`tpl_${key}_color`)?.value||'#d4af37', message:document.getElementById(`tpl_${key}_message`)?.value||'', fields, enabled:!!document.getElementById(`tpl_${key}_enabled`)?.checked, embed:!!document.getElementById(`tpl_${key}_embed`)?.checked}; await apiCall('/api/config/customization',{method:'POST',body:JSON.stringify({templates})}); await refresh(true); toast('Template gespeichert'); };
  window.saveAbgabeType=async function(){ const body={key:document.getElementById('newAbg_key')?.value,label:document.getElementById('newAbg_label')?.value,emoji:document.getElementById('newAbg_emoji')?.value,unit:document.getElementById('newAbg_unit')?.value,roleId:document.getElementById('newAbg_roleId')?.value,channelName:document.getElementById('newAbg_channelName')?.value,amount:Number(document.getElementById('newAbg_amount')?.value||0),includeInStats:!!document.getElementById('newAbg_stats')?.checked,active:true}; await apiCall('/api/config/abgaben/types',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Abgabeart gespeichert'); };
  window.editAbgabeType=function(key){ const t=abgabeTypeList().find(x=>x.key===key)||{}; ['key','label','emoji','unit','roleId','channelName'].forEach(k=>{ const el=document.getElementById('newAbg_'+k); if(el) el.value=t[k]||''; }); document.getElementById('newAbg_key').value=t.key||key; document.getElementById('newAbg_stats').checked=t.includeInStats!==false; };
  window.deleteAbgabeType=async function(key){ if(!confirm('Abgabeart löschen/deaktivieren?')) return; await apiCall('/api/config/abgaben/types/'+encodeURIComponent(key),{method:'DELETE'}); await refresh(true); toast('Abgabeart gelöscht'); };
  window.addStatCard=function(){ const c=customization(); c.statCards ||= []; c.statCards.push({label:'Neue Karte',source:'stats.members',visible:true}); renderCurrent(); };
  window.saveStatCards=async function(){ const existing=customization().statCards||[]; const statCards=existing.map((x,i)=>({key:x.key||('custom_'+i),label:document.getElementById(`stat_${i}_label`)?.value||x.label||'',source:document.getElementById(`stat_${i}_source`)?.value||x.source||'',visible:!!document.getElementById(`stat_${i}_visible`)?.checked,order:i})); await apiCall('/api/config/customization',{method:'POST',body:JSON.stringify({statCards})}); await refresh(true); toast('Statistik-Karten gespeichert'); };

  window.saveSystemSettingsOnly = async function(){
    const body={}; ['smartPingEnabled','autoSanctionsEnabled','termRemindersEnabled','decisionHintsEnabled','leaderReminderDmEnabled','fridayMissingReportEnabled','mondayOverdueReportEnabled','routeAdminFridayReportEnabled','routeAdminMondayReportEnabled','dashboardEnabled','reportsEnabled','dryRunEnabled','logSystemEnabled','spamProtectionEnabled'].forEach(k=>{ const el=document.getElementById('set_'+k); if(el) body[k]=!!el.checked; });
    await apiCall('/api/config/settings',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Systemsteuerung gespeichert');
  };

  function adminPanel(){
    if(!isAdmin()) return panel('Admin Panel','Nur Admins dürfen diesen Bereich ändern.', '<div class="locked-note">Nur Admins.</div>');
    const buttons = subActions([['admin','members','Mitglieder'],['admin','roles','Rollen/Rechte'],['admin','messagesConfig','Nachrichten & Embeds'],['admin','channels','Kanäle'],['admin','logs','Logs/Diagnose'],['admin','resetCenter','Reset-Zentrale']]);
    let body='';
    if(window.centralSection === 'roles') body = rolesPanel();
    else if(window.centralSection === 'messagesConfig') body = customizationStudio('messages');
    else if(window.centralSection === 'channels') body = channelsPanel();
    else if(window.centralSection === 'logs') body = logsPanel();
    else if(window.centralSection === 'resetCenter') body = resetAdminPanelV29();
    else body = membersAdminPanel();
    return `${buttons}${body}`;
  }

  function resetAdminPanelV29(){
    if(!isAdmin()) return panel('Reset-Zentrale','Nur Admins dürfen diesen Bereich nutzen.', '<div class="locked-note">Nur Admins.</div>');
    return panel('🧹 Reset-Zentrale','Nur im Admin Panel. Setzt Bewegungsdaten zurück, aber keine Rollen, keine Rechte, kein Design und keine Einstellungen.', `<div class="admin-reset-clean"><p class="muted">Öffne die Reset-Auswahl nur, wenn wirklich Daten geleert werden sollen. Vorher wird serverseitig ein Backup erstellt.</p><button class="danger-btn" onclick="openResetCenterV27()">Reset-Auswahl öffnen</button></div>`);
  }

  function displayMember(m){ return m.serverName || m.displayName || m.nickname || m.globalName || m.username || m.id || '—'; }
  function membersAdminPanel(){
    const rows=(DATA?.members||[]).slice().sort((a,b)=>displayMember(a).localeCompare(displayMember(b))).slice(0,250);
    return panel('👥 Mitgliederverwaltung','Profile löschen, kicken, bannen und Rollen bearbeiten.', `<div class="member-admin-list">${rows.map(m=>`<div class="member-admin-row"><div><b>${E(displayMember(m))}</b><small>${E(m.id||'')}</small></div><div class="member-admin-actions"><button onclick="openMemberModal('${E(m.id)}')">Profil</button><button onclick="openRoleModal('${E(m.id)}')">Rollen</button><button class="danger-btn" onclick="deleteMemberProfile('${E(m.id)}')">Profil löschen</button><button class="danger-btn" onclick="kickMember('${E(m.id)}')">Kick</button><button class="danger-btn" onclick="banMember('${E(m.id)}')">Ban</button></div></div>`).join('') || '<p>Keine Mitglieder gefunden.</p>'}</div>`);
  }
  window.deleteMemberProfile = async function(id){ if(!confirm('Web-Profil dieses Mitglieds löschen?')) return; await apiCall('/api/members/'+encodeURIComponent(id),{method:'DELETE'}); await refresh(true); toast('Profil gelöscht'); };
  window.kickMember = async function(id){ const reason=prompt('Grund für Kick?','Kick durch Web-Dashboard'); if(reason===null) return; await apiCall('/api/discord/members/'+encodeURIComponent(id)+'/kick',{method:'POST',body:JSON.stringify({reason})}); await refresh(true); toast('Mitglied gekickt'); };
  window.banMember = async function(id){ const reason=prompt('Grund für Ban?','Ban durch Web-Dashboard'); if(reason===null) return; const del=confirm('Nachrichten der letzten 24 Stunden löschen?'); await apiCall('/api/discord/members/'+encodeURIComponent(id)+'/ban',{method:'POST',body:JSON.stringify({reason,deleteMessageSeconds:del?86400:0})}); await refresh(true); toast('Mitglied gebannt'); };
  window.openRoleModal = function(id){ const m=(DATA?.members||[]).find(x=>String(x.id)===String(id))||{}; const currentRoles=(m.roles||[]).map(String); const currentRows=currentRoles.map(r=>[esc(roleNameById(r)), `<span class="code">${esc(r)}</span>`]); openModal(`<h2>Rollen bearbeiten</h2><p class="muted">Für ${esc(m.serverName||m.nickname||id)} kannst du Rollen jetzt auswählen statt IDs einzutragen.</p><div class="panel"><h3>Aktuelle Rollen</h3>${currentRows.length?simpleTable(['Rolle','ID'],currentRows):'<p class="muted">Keine Rollen geladen.</p>'}</div><form id="roleForm" class="form-grid"><label>Rolle hinzufügen${roleMultiSelect('role_add',[])}</label><label>Rolle entfernen${roleMultiSelect('role_remove',currentRoles)}</label><button class="primary full">Speichern</button></form>`); document.getElementById('roleForm').onsubmit=async e=>{e.preventDefault(); const add=selectedRoleIds('role_add'); const remove=selectedRoleIds('role_remove'); if(!add.length&&!remove.length) return toast('Keine Rolle ausgewählt.'); await apiCall('/api/discord/members/'+encodeURIComponent(id)+'/roles',{method:'POST',body:JSON.stringify({add,remove})}); closeModal(); await refresh(true); toast('Rollen geändert');}; };
  function rolesPanel(){ return panel('Rollen/Rechte','Welche Rolle ist welche ID und welche Rolle darf was.', typeof rolePermissionPanelClean === 'function' ? rolePermissionPanelClean() : '<p>Konfiguration nicht gefunden.</p>'); }
  function channelsPanel(){ const ch=DATA?.config?.channels||{}; return panel('Kanäle','Discord-Kanäle und IDs.', `<div class="compact-list">${Object.entries(ch).map(([k,v])=>`<div><span>${E(k)}</span><b>${E(v)}</b></div>`).join('')||'<p>Keine Kanäle gefunden.</p>'}</div>`); }
  function logsPanel(){ const items=DATA?.audit?.items||[]; return panel('Logs / Diagnose','Letzte Aktionen.', `<div class="timeline">${items.slice(0,30).map(a=>`<div><b>${E(a.action)}</b><br><span class="muted">${typeof dt==='function'?dt(a.at):E(a.at)} · ${E(a.by)}</span></div>`).join('')||'<p>Keine Logs.</p>'}</div>`); }

  window.centralPage = centralPage;
  window.abgabenDiscordPanel = abgabenDiscordPanel;
  window.abgabeRules = abgabeRules;
  window.isLeader = isLeader;
  window.isAdmin = isAdmin;
})();


/* ===== UX cleanup requested 2026-06-10: Statistiken, Wache, Lager, Abmeldungen ===== */
(function(){
  function myId(){ return DATA?.me?.id; }
  function leaderCanEditInventory(){ return !!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser); }
  function invRows(){ return (typeof allInventoryRows==='function'?allInventoryRows():Object.entries(DATA?.inventory?.items||{}).map(([userId,i])=>({userId,...i}))); }
  function weaponLines(r){ return Object.entries(r.weapons||r.waffen||{}).filter(([_,v])=>Number(v)).map(([k,v])=>`${esc(k)}: ${esc(v)}`).join('<br>') || '—'; }
  inventory = function(){
    const own=invRows().find(r=>String(r.userId)===String(myId())) || {userId:myId(), weapons:{}, leichteWesten:0, schwereWesten:0, munition:0};
    const family=DATA?.inventory?.family || {};
    const canAll=leaderCanEditInventory();
    const rows=invRows().filter(r=>canAll || String(r.userId)===String(myId())).map(r=>[
      userCell(r.userId), weaponLines(r), `Leicht: ${esc(r.leichteWesten||0)}<br>Schwer: ${esc(r.schwereWesten||r.schwer||r.westen||0)}`, esc(r.munition||0), esc(dt(r.updatedAt||r.lastUpdate||r.at)),
      (canAll || String(r.userId)===String(myId())) ? `<button onclick="openInventoryModal('${esc(r.userId)}')">Bearbeiten</button>` : '—'
    ]);
    return `${cards({'Eigene Munition':own.munition||0,'Eigene leichte Westen':own.leichteWesten||0,'Eigene schwere Westen':own.schwereWesten||own.westen||0})}<div class="panel"><h2>${canAll?'Lager aller Mitglieder':'Mein Lager'}</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Aktion'], rows)}</div><div class="panel"><h2>Familien-Lager</h2>${simpleTable(['Waffen','Westen','Munition'], [[weaponLines(family), `Leicht: ${esc(family.leichteWesten||0)}<br>Schwer: ${esc(family.schwereWesten||family.westen||0)}`, esc(family.munition||0)]])}</div>`;
  };
  openInventoryModal = function(uid){
    if(String(uid)!==String(myId()) && !leaderCanEditInventory()) return toast('Du darfst nur dein eigenes Lager bearbeiten.');
    const inv=DATA.inventory?.items?.[uid]||{};
    openModal(`<h2>${String(uid)===String(myId())?'Eigenes Lager bearbeiten':'Lager bearbeiten'}</h2><form id="invForm" class="form-grid"><label>Leichte Westen<input name="leichteWesten" type="number" value="${esc(inv.leichteWesten||0)}"></label><label>Schwere Westen<input name="schwereWesten" type="number" value="${esc(inv.schwereWesten||inv.westen||0)}"></label><label>Munition<input name="munition" type="number" value="${esc(inv.munition||0)}"></label><button class="primary full">Speichern</button></form>`);
    $('#invForm').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);await api('/api/inventory/'+uid,{method:'POST',body:JSON.stringify({patch:{leichteWesten:Number(fd.get('leichteWesten')),schwereWesten:Number(fd.get('schwereWesten')),munition:Number(fd.get('munition'))}})});closeModal();await refresh(true);toast('Lager gespeichert')};
  };
  absences = function(){
    const arr=typeof allAbsenceRows==='function'?allAbsenceRows():DATA.absences?.items||[];
    const active=arr.filter(a=>a.active!==false && String(a.status||'').toLowerCase()!=='inaktiv');
    const expired=arr.filter(a=>!active.includes(a));
    const add=can('absencesCreate')?'<button class="primary" onclick="openAbsenceModal()">+ Abmeldung</button>':'';
    const table=list=>simpleTable(['Name','Von','Bis','Tage','Grund'], list.map(a=>[userCell(a.userId),dt(a.from||a.startTs||a.createdAt),dt(a.to||a.until||a.untilTs||a.endTs),a.days||a.tage||'—',a.reason||a.grund||'—']));
    return `<div class="toolbar"><span class="pill gold">${active.length} aktiv</span><span class="pill">${expired.length} abgelaufen</span>${add}</div><div class="grid2"><div class="panel"><h2>Aktive Abmeldungen</h2>${active.length?table(active):'<p class="muted">Keine aktiven Abmeldungen.</p>'}</div><div class="panel"><h2>Abgelaufene Abmeldungen</h2>${expired.length?table(expired):'<p class="muted">Keine abgelaufenen Abmeldungen.</p>'}</div></div>`;
  };
  openAbsenceModal = function(){
    if(!can('absencesCreate')) return toast('Keine Berechtigung.');
    openModal(`<h2>Abmeldung anlegen</h2><form id="absForm" class="form-grid"><label>User ID<input name="userId" required value="${esc(DATA.me?.id||'')}"></label><label>Ab wann?<input name="startDate" type="date" value="${new Date().toISOString().slice(0,10)}"></label><label>Tage<input name="days" type="number" value="5"></label><label class="full">Grund<input name="reason" value="Web-Abmeldung"></label><button class="primary full">Speichern</button></form>`);
    $('#absForm').onsubmit=async e=>{e.preventDefault();const o=Object.fromEntries(new FormData(e.target));await api('/api/absences',{method:'POST',body:JSON.stringify(o)});closeModal();await refresh(true);toast('Abmeldung gespeichert')};
  };
  abgabenStats = function(){
    const mode=window.statsMode||'abgaben';
    const switcher=`<div class="toolbar"><button class="${mode==='abgaben'?'primary':''}" onclick="window.statsMode='abgaben';renderCurrent()">Abgaben</button><button class="${mode==='wache'?'primary':''}" onclick="window.statsMode='wache';renderCurrent()">Wache</button></div>`;
    if(mode==='wache'){
      const weeks=Object.keys(DATA.wache?.weeks||{}).sort().reverse();
      const rows=weeks.map(w=>{const x=DATA.wache.weeks[w]||{}; const mins=Object.values(x.users||{}).reduce((a,u)=>a+Number(u.totalMinutes||0),0); return [`<button class="linkbtn" onclick="selectWacheWeek('${esc(w)}')">${esc(w)}</button>`,Object.keys(x.users||{}).length,(x.sessions||[]).length,Math.round(mins/60*10)/10+'h'];});
      return switcher+`<div class="panel"><h2>Wache-Statistiken</h2><p class="muted">Klicke in eine Woche, um Details zu sehen.</p>${simpleTable(['Woche','Personen','Sessions','Stunden'], rows)}</div>${window.SELECTED_WACHE_WEEK&&typeof wacheWeekDetail==='function'?wacheWeekDetail(typeof collectWacheRows==='function'?collectWacheRows():[],window.SELECTED_WACHE_WEEK):''}`;
    }
    const st=DATA.abgabenStats||{weeks:[],totals:{}};
    return switcher+`${cards({'Gesamt':st.totals.total||0,'Abgegeben':st.totals.abgegeben||0,'Offen':st.totals.offen||0,'Zu spät':st.totals.zuSpaet||0,'Entschuldigt':st.totals.entschuldigt||0,'Warnphase':st.totals.warnphase||0})}<div class="panel"><h2>Abgaben-Statistiken</h2>${simpleTable(['Woche','Gesamt','Abgegeben','Offen','Zu spät','Entschuldigt','Quote'], (st.weeks||[]).map(w=>[`<button class="linkbtn" onclick="selectAbgabeWeek('${esc(w.weekKey)}')">${esc(w.weekKey)}</button>`,w.total,w.abgegeben,w.offen,w.zuSpaet,w.entschuldigt, w.total?Math.round(w.abgegeben/w.total*100)+'%':'—']))}</div>${window.SELECTED_ABGABE_WEEK&&typeof abgabeWeekDetail==='function'?abgabeWeekDetail(typeof collectAbgabeRows==='function'?collectAbgabeRows():[],window.SELECTED_ABGABE_WEEK):''}`;
  };
})();


/* ===== V9 final cleanup: overview lager, cashbox, abgaben location, roles UX ===== */
(function(){
  function vid(){ return DATA?.me?.id; }
  function isBoss(){ return !!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser); }
  function invList(){ return Object.entries(DATA?.inventory?.items||{}).map(([userId,i])=>({userId,...i})); }
  function wLines(obj){ return Object.entries(obj?.weapons||obj?.waffen||{}).filter(([_,v])=>Number(v)>0).map(([k,v])=>`${esc(k)}: ${esc(v)}`).join('<br>') || '—'; }
  function myInv(){ return (DATA?.inventory?.items||{})[vid()] || {}; }
  const oldOverview = overview;
  overview = function(){
    const own=myInv();
    const ownBlock = `<div class="panel own-lager-overview"><h2>Mein Lager</h2><div class="cards"><div class="card"><div class="label">Eigene Waffen</div><div class="value small-value">${wLines(own)}</div></div><div class="card"><div class="label">Eigene Munition</div><div class="value small-value">Langwaffen: ${esc(own.langwaffenMunition||own.munitionLang||0)}<br>Kurzwaffen: ${esc(own.kurzwaffenMunition||own.munitionKurz||own.munition||0)}</div></div><div class="card"><div class="label">Eigene Westen</div><div class="value small-value">Leicht: ${esc(own.leichteWesten||0)}<br>Schwer: ${esc(own.schwereWesten||own.westen||0)}</div></div></div><button onclick="goModule('inventory')">Lager öffnen</button></div>`;
    return ownBlock + oldOverview();
  };

  inventory = function(){
    const own=invList().find(r=>String(r.userId)===String(vid())) || {userId:vid(), weapons:{}, leichteWesten:0, schwereWesten:0, munition:0};
    const family=DATA?.inventory?.family || {};
    const canAll=isBoss();
    const rows=invList().filter(r=>canAll || String(r.userId)===String(vid())).map(r=>[
      userCell(r.userId), wLines(r), `Leicht: ${esc(r.leichteWesten||0)}<br>Schwer: ${esc(r.schwereWesten||r.schwer||r.westen||0)}`, esc(r.munition||0), esc(dt(r.updatedAt||r.lastUpdate||r.at)),
      (canAll || String(r.userId)===String(vid())) ? `<button onclick="openInventoryModal('${esc(r.userId)}')">Bearbeiten</button>` : '—'
    ]);
    return `<div class="panel own-lager-overview"><h2>${esc(DATA?.me?.username||DATA?.me?.displayName||'Mein')} – eigenes Lager</h2><div class="cards"><div class="card"><div class="label">Waffen</div><div class="value small-value">${wLines(own)}</div></div><div class="card"><div class="label">Munition</div><div class="value">${esc(own.munition||0)}</div></div><div class="card"><div class="label">Westen</div><div class="value small-value">Leicht: ${esc(own.leichteWesten||0)}<br>Schwer: ${esc(own.schwereWesten||own.westen||0)}</div></div></div></div><div class="panel"><h2>${canAll?'Lager aller Mitglieder':'Mein Lager bearbeiten'}</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Aktion'], rows)}</div><div class="panel"><h2>Familien-Lager</h2>${simpleTable(['Waffen','Westen','Munition'], [[wLines(family), `Leicht: ${esc(family.leichteWesten||0)}<br>Schwer: ${esc(family.schwereWesten||family.westen||0)}`, esc(family.munition||0)]])}</div>`;
  };

  cashbox = function(){
    if(!DATA.cashbox) return locked();
    const tx=filterRows(DATA.cashbox?.transactions||[],[x=>`${x.id} ${x.category} ${x.customReason} ${x.note} ${x.createdBy}`]);
    const family=DATA?.inventory?.family || {};
    const invTx=(DATA?.inventory?.transactions||DATA?.inventory?.history||[]).slice(0,80);
    const cashRows=tx.map(t=>[dt(t.createdAt), t.type==='expense'?'<span class="pill bad">Ausgabe</span>':'<span class="pill good">Einnahme</span>', t.category, money(t.amount), `${esc(t.customReason||'')}<br><span class="muted">${esc(t.note||'')}</span>`, `<span class="code">${esc(t.createdBy||'')}</span>`]);
    const invRows=invTx.map(t=>[dt(t.createdAt||t.at||t.time), t.type||t.action||'Lager', userCell(t.userId||t.memberId||t.by), t.item||t.weapon||t.category||'—', t.amount||t.count||t.delta||'—', t.note||t.reason||'—']);
    return `${cards({'Kassenstand':money(DATA.cashbox?.balance||0),'Kassen-Transaktionen':tx.length,'Familien-Munition':family.munition||0})}<div class="section-actions"><span></span>${can('cashboxWrite')?'<button class="primary" onclick="openCashModal()">+ Geld-Transaktion</button>':''}</div><div class="panel"><h2>Familien-Lager</h2>${simpleTable(['Waffen','Westen','Munition'], [[wLines(family), `Leicht: ${esc(family.leichteWesten||0)}<br>Schwer: ${esc(family.schwereWesten||family.westen||0)}`, esc(family.munition||0)]])}</div><div class="grid2"><div class="panel"><h2>Geld-Transaktionen</h2>${cashRows.length?simpleTable(['Datum','Typ','Kategorie','Betrag','Grund / Notiz','Von'], cashRows):'<p class="muted">Keine Geld-Transaktionen vorhanden.</p>'}</div><div class="panel"><h2>Waffen-/Lager-Transaktionen</h2>${invRows.length?simpleTable(['Datum','Typ','Person','Artikel','Menge','Notiz'], invRows):'<p class="muted">Noch keine Lager-Transaktionen gespeichert.</p>'}</div></div>`;
  };

  abgaben = function(){
    const rows=typeof collectAbgabeRows==='function'?collectAbgabeRows():[];
    const weeks=typeof uniqueSortedWeeks==='function'?uniqueSortedWeeks(rows):[...new Set(rows.map(r=>r.weekKey||r.week).filter(Boolean))].sort().reverse();
    if(!SELECTED_ABGABE_WEEK || !weeks.includes(SELECTED_ABGABE_WEEK)) SELECTED_ABGABE_WEEK=weeks[0]||isoWeekKey();
    const summaryRows=weeks.map(w=>{ const people=typeof abgabeWeekGrouped==='function'?abgabeWeekGrouped(rows,w):rows.filter(r=>(r.weekKey||r.week)===w); return [`<button class="linkbtn" onclick="selectAbgabeWeek('${esc(w)}')">${esc(w)}</button>`, esc(people.length), esc(people.filter(p=>p.group==='submitted'||p.status==='abgegeben').length), esc(people.filter(p=>p.group==='warning'||p.status==='warnphase').length), esc(people.filter(p=>p.group==='excused'||p.status==='entschuldigt').length), esc(people.filter(p=>p.group==='prepaid').length), esc(people.filter(p=>p.group==='missing'||p.status==='offen').length)]; });
    const panel = (typeof window.abgabenDiscordPanel==='function' && can('abgabenWrite')) ? `<div class="panel">${window.abgabenDiscordPanel()}</div>` : '';
    return `${panel}<div class="toolbar"><span class="pill gold">${weeks.length} Wochen</span><button class="primary" onclick="openAbgabeEntryModal('${esc(SELECTED_ABGABE_WEEK||'')}')">+ Abgabe eintragen</button><button onclick="goModule('leader_all');openCentralSection('leader','abgaben')">Abgaben-Regeln</button></div><div class="panel"><h2>Abgaben nach Wochen</h2><p class="muted">Klicke auf eine Woche. Dann siehst du die gleiche Logik wie im Discord-Post.</p>${typeof weekChooser==='function'?weekChooser('abgabe',weeks,SELECTED_ABGABE_WEEK):''}${simpleTable(['Woche','Personen','✅ Abgegeben','⏰ Warnphase','🟡 Entschuldigt','🟦 Vorausgezahlt','❌ Offen'],summaryRows)}</div>${SELECTED_ABGABE_WEEK&&typeof abgabeWeekDetail==='function'?abgabeWeekDetail(rows,SELECTED_ABGABE_WEEK):''}`;
  };

  function roleSelectOne(id, selectedIds=[], onlyCurrent=false){
    const current = new Set((selectedIds||[]).map(String));
    const roles = (typeof guildRolesList==='function'?guildRolesList():[]).filter(r=>onlyCurrent ? current.has(String(r.id)) : !current.has(String(r.id)));
    return `<select id="${esc(id)}"><option value="">Bitte Rolle auswählen …</option>${roles.map(r=>`<option value="${esc(r.id)}">${esc(r.name)} — ${esc(r.id)}</option>`).join('')}</select>`;
  }
  window.openRoleModal = function(id){
    const m=(DATA?.members||[]).find(x=>String(x.id)===String(id))||{};
    const currentRoles=(m.roles||[]).map(String);
    const currentRows=currentRoles.map(r=>[esc(roleNameById(r)), `<span class="code">${esc(r)}</span>`]);
    openModal(`<h2>Rollen bearbeiten</h2><p class="muted">${esc(m.serverName||m.nickname||id)}: Wähle einfach eine Rolle zum Hinzufügen oder Entfernen.</p><div class="panel"><h3>Aktuelle Rollen</h3>${currentRows.length?simpleTable(['Rolle','ID'],currentRows):'<p class="muted">Keine Rollen geladen.</p>'}</div><form id="roleForm" class="form-grid"><label>Rolle hinzufügen${roleSelectOne('role_add_one',currentRoles,false)}</label><label>Rolle entfernen${roleSelectOne('role_remove_one',currentRoles,true)}</label><button class="primary full">Rollen speichern</button></form>`);
    document.getElementById('roleForm').onsubmit=async e=>{e.preventDefault(); const add=[document.getElementById('role_add_one')?.value].filter(Boolean); const remove=[document.getElementById('role_remove_one')?.value].filter(Boolean); if(!add.length&&!remove.length) return toast('Keine Rolle ausgewählt.'); await apiCall('/api/discord/members/'+encodeURIComponent(id)+'/roles',{method:'POST',body:JSON.stringify({add,remove})}); closeModal(); await refresh(true); toast('Rollen geändert');};
  };
})();

// Boot uses the canonical page list only; no legacy navigation/renderer can re-add settings or duplicate leader_all.
syncPages();
load();


/* ===== V10 cache-safe cleanup: Abgaben route, Wache settings, Lager edit UX ===== */
(function(){
  window.goModule = function(page){ go(page); };

  function myUserId(){ return String(DATA?.me?.id||''); }
  function memberName(id){ return displayNameForUser(id); }
  function invItems(){ return DATA?.inventory?.items || {}; }
  function invRowsV10(){ return Object.entries(invItems()).map(([userId,row])=>({userId,...(row||{})})); }
  function canEditAllInventoryV10(){ return !!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser); }
  function weaponEditorHtml(inv){
    const keys = ['Kampf PDW','Karabiner','Gusenberg','Pistole','Schwere Pistole','50er','SMG'];
    const w = inv?.weapons || inv?.waffen || {};
    return keys.map(k=>`<label>${esc(k)}<input name="weapon_${esc(k)}" type="number" min="0" value="${esc(w[k]||0)}"></label>`).join('');
  }
  function weaponLinesV10(obj){ return Object.entries(obj?.weapons||obj?.waffen||{}).filter(([_,v])=>Number(v)>0).map(([k,v])=>`${esc(k)}: ${esc(v)}`).join('<br>') || '—'; }

  window.openInventoryModal = function(uid){
    uid = String(uid||myUserId());
    if(uid!==myUserId() && !canEditAllInventoryV10()) return toast('Du darfst nur dein eigenes Lager bearbeiten.');
    const inv = invItems()[uid] || {};
    openModal(`<h2>${uid===myUserId()?'Eigenes Lager bearbeiten':'Lager bearbeiten'}</h2><p class="muted">${esc(memberName(uid))}</p><form id="invForm" class="form-grid"><h3 class="full">Waffen</h3>${weaponEditorHtml(inv)}<h3 class="full">Westen & Munition</h3><label>Leichte Westen<input name="leichteWesten" type="number" min="0" value="${esc(inv.leichteWesten||0)}"></label><label>Schwere Westen<input name="schwereWesten" type="number" min="0" value="${esc(inv.schwereWesten||inv.westen||0)}"></label><label>Munition<input name="munition" type="number" min="0" value="${esc(inv.munition||0)}"></label><button class="primary full">Speichern</button></form>`);
    document.getElementById('invForm').onsubmit=async e=>{
      e.preventDefault(); const fd=new FormData(e.target); const weapons={};
      for(const [k,v] of fd.entries()) if(String(k).startsWith('weapon_')) weapons[String(k).slice(7)] = Number(v||0);
      const patch={weapons, leichteWesten:Number(fd.get('leichteWesten')||0), schwereWesten:Number(fd.get('schwereWesten')||0), munition:Number(fd.get('munition')||0)};
      await api('/api/inventory/'+encodeURIComponent(uid),{method:'POST',body:JSON.stringify({patch})}); closeModal(); await refresh(true); toast('Lager gespeichert');
    };
  };

  inventory = function(){
    const own = invItems()[myUserId()] || {};
    const canAll = canEditAllInventoryV10();
    const family = DATA?.inventory?.family || {};
    const rows = invRowsV10().filter(r=>canAll || String(r.userId)===myUserId()).map(r=>[
      userCell(r.userId), weaponLinesV10(r), `Leicht: ${esc(r.leichteWesten||0)}<br>Schwer: ${esc(r.schwereWesten||r.schwer||r.westen||0)}`, esc(r.munition||0), esc(dt(r.updatedAt||r.lastUpdate||r.at)), `<button onclick="openInventoryModal('${esc(r.userId)}')">Bearbeiten</button>`
    ]);
    return `<div class="panel own-lager-overview"><div class="section-actions"><h2>${esc(memberName(myUserId()))} – eigenes Lager</h2><button class="primary" onclick="openInventoryModal('${esc(myUserId())}')">Eigenes Lager bearbeiten</button></div><div class="cards"><div class="card"><div class="label">Waffen</div><div class="value small-value">${weaponLinesV10(own)}</div></div><div class="card"><div class="label">Munition</div><div class="value">${esc(own.munition||0)}</div></div><div class="card"><div class="label">Westen</div><div class="value small-value">Leicht: ${esc(own.leichteWesten||0)}<br>Schwer: ${esc(own.schwereWesten||own.westen||0)}</div></div></div></div><div class="panel"><h2>${canAll?'Lager aller Mitglieder':'Mein Lager'}</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Aktion'], rows)}</div><div class="panel"><h2>Familien-Lager</h2>${simpleTable(['Waffen','Westen','Munition'], [[weaponLinesV10(family), `Leicht: ${esc(family.leichteWesten||0)}<br>Schwer: ${esc(family.schwereWesten||family.westen||0)}`, esc(family.munition||0)]])}</div>`;
  };

  abgaben = function(){
    const rows = typeof collectAbgabeRows==='function' ? collectAbgabeRows() : [];
    const weeks = (typeof uniqueSortedWeeks==='function' ? uniqueSortedWeeks(rows) : [...new Set(rows.map(r=>r.weekKey||r.week).filter(Boolean))].sort().reverse());
    const fallbackWeek = (typeof isoWeekKey==='function' ? isoWeekKey() : new Date().getFullYear()+'-W01');
    if(!SELECTED_ABGABE_WEEK || (weeks.length && !weeks.includes(SELECTED_ABGABE_WEEK))) SELECTED_ABGABE_WEEK=weeks[0]||fallbackWeek;
    const summaryRows = weeks.map(w=>{ const people = typeof abgabeWeekGrouped==='function' ? abgabeWeekGrouped(rows,w) : rows.filter(r=>(r.weekKey||r.week)===w); return [`<button class="linkbtn" onclick="selectAbgabeWeek('${esc(w)}')">${esc(w)}</button>`, esc(people.length), esc(people.filter(p=>p.group==='submitted'||p.status==='abgegeben').length), esc(people.filter(p=>p.group==='warning'||p.status==='warnphase').length), esc(people.filter(p=>p.group==='excused'||p.status==='entschuldigt').length), esc(people.filter(p=>p.group==='prepaid').length), esc(people.filter(p=>p.group==='missing'||p.status==='offen').length)]; });
    const panel = (typeof window.abgabenDiscordPanel==='function' && can('abgabenWrite')) ? `<div class="panel">${window.abgabenDiscordPanel()}</div>` : '';
    return `${panel}<div class="toolbar"><span class="pill gold">${esc(weeks.length)} Wochen</span>${can('abgabenWrite')?`<button class="primary" onclick="openAbgabeEntryModal('${esc(SELECTED_ABGABE_WEEK||fallbackWeek)}')">+ Abgabe eintragen</button>`:''}<button onclick="go('leader_all');openCentralSection('leader','abgaben')">Abgaben-Regeln</button></div><div class="panel"><h2>Abgaben nach Wochen</h2><p class="muted">Klicke auf eine Woche, um Details zu öffnen.</p>${weeks.length && typeof weekChooser==='function'?weekChooser('abgabe',weeks,SELECTED_ABGABE_WEEK):'<p class="muted">Noch keine Abgabe-Wochen vorhanden.</p>'}${weeks.length?simpleTable(['Woche','Personen','✅ Abgegeben','⏰ Warnphase','🟡 Entschuldigt','🟦 Vorausgezahlt','❌ Offen'],summaryRows):''}</div>${SELECTED_ABGABE_WEEK&&weeks.length&&typeof abgabeWeekDetail==='function'?abgabeWeekDetail(rows,SELECTED_ABGABE_WEEK):''}`;
  };

  const oldRenderCurrentV10 = renderCurrent;
  renderCurrent = function(){
    try { oldRenderCurrentV10(); }
    catch(e){ console.error(e); document.getElementById('content').innerHTML = `<div class="locked-note"><b>Dieser Bereich konnte nicht geladen werden.</b><br>${esc(e.message||e)}</div>`; }
  };
})();


/* ===== V11 Lager UX: Übersicht -> Lagerseite, links Bestand, rechts hinzufügen ===== */
(function(){
  function myUserIdV11(){ return String(DATA?.me?.id||''); }
  function canEditAllInventoryV11(){ return !!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser); }
  function invItemsV11(){ return DATA?.inventory?.items || {}; }
  function invV11(uid){ return invItemsV11()[String(uid||myUserIdV11())] || {}; }
  function mNameV11(uid){ return (typeof displayNameForUser==='function'?displayNameForUser(uid):uid); }
  const weaponNamesV11 = ['Kampf PDW','Karabiner','Gusenberg','Pistole','Schwere Pistole','50er','SMG'];
  function numV11(v){ return Math.max(0, Number(v||0)); }
  function ammoLongV11(i){ return numV11(i.langwaffenMunition ?? i.munitionLang ?? i.longAmmo ?? 0); }
  function ammoShortV11(i){ return numV11(i.kurzwaffenMunition ?? i.munitionKurz ?? i.shortAmmo ?? i.munition ?? 0); }
  function weaponLinesV11(obj){ return Object.entries(obj?.weapons||obj?.waffen||{}).filter(([_,v])=>Number(v)>0).map(([k,v])=>`${esc(k)}: ${esc(v)}`).join('<br>') || '—'; }
  function ownCardsV11(uid){
    const i=invV11(uid);
    return `<div class="cards"><div class="card"><div class="label">Waffen</div><div class="value small-value">${weaponLinesV11(i)}</div></div><div class="card"><div class="label">Westen</div><div class="value small-value">Leicht: ${esc(i.leichteWesten||0)}<br>Schwer: ${esc(i.schwereWesten||i.westen||0)}</div></div><div class="card"><div class="label">Munition</div><div class="value small-value">Langwaffen: ${esc(ammoLongV11(i))}<br>Kurzwaffen: ${esc(ammoShortV11(i))}</div></div></div>`;
  }
  function storagePatchFromForm(fd, current){
    const patch={weapons:{...(current.weapons||current.waffen||{})}};
    const type=String(fd.get('type')||'weapon');
    const qty=numV11(fd.get('qty'));
    const mode=String(fd.get('mode')||'add');
    const delta=mode==='remove' ? -qty : qty;
    function addKey(key){ patch[key]=Math.max(0,numV11(current[key])+delta); }
    if(type==='weapon'){
      const w=String(fd.get('weaponName')||'').trim();
      if(!w) throw new Error('Bitte Waffe auswählen.');
      patch.weapons[w]=Math.max(0,numV11(patch.weapons[w])+delta);
    } else if(type==='schwereWesten') addKey('schwereWesten');
    else if(type==='leichteWesten') addKey('leichteWesten');
    else if(type==='langwaffenMunition') addKey('langwaffenMunition');
    else if(type==='kurzwaffenMunition') addKey('kurzwaffenMunition');
    return patch;
  }
  window.saveInventoryQuickV11 = async function(uid){
    uid=String(uid||myUserIdV11());
    if(uid!==myUserIdV11() && !canEditAllInventoryV11()) return toast('Du darfst nur dein eigenes Lager bearbeiten.');
    const form=document.getElementById('lagerQuickForm');
    const fd=new FormData(form);
    try{
      const patch=storagePatchFromForm(fd, invV11(uid));
      await api('/api/inventory/'+encodeURIComponent(uid),{method:'POST',body:JSON.stringify({patch})});
      await refresh(true); toast('Lager aktualisiert');
    }catch(e){ toast(e.message||'Eingabe prüfen'); }
  };
  window.openInventoryModal = function(uid){
    uid=String(uid||myUserIdV11());
    if(uid!==myUserIdV11() && !canEditAllInventoryV11()) return toast('Du darfst nur dein eigenes Lager bearbeiten.');
    const inv=invV11(uid);
    const weaponInputs=weaponNamesV11.map(k=>`<label>${esc(k)}<input name="weapon_${esc(k)}" type="number" min="0" value="${esc((inv.weapons||{})[k]||0)}"></label>`).join('');
    openModal(`<h2>${uid===myUserIdV11()?'Eigenes Lager bearbeiten':'Lager bearbeiten'}</h2><p class="muted">${esc(mNameV11(uid))}</p><form id="invForm" class="form-grid"><h3 class="full">Waffen</h3>${weaponInputs}<h3 class="full">Westen</h3><label>Leichte Westen<input name="leichteWesten" type="number" min="0" value="${esc(inv.leichteWesten||0)}"></label><label>Schwere Westen<input name="schwereWesten" type="number" min="0" value="${esc(inv.schwereWesten||inv.westen||0)}"></label><h3 class="full">Munition</h3><label>Langwaffen Munition<input name="langwaffenMunition" type="number" min="0" value="${esc(ammoLongV11(inv))}"></label><label>Kurzwaffen Munition<input name="kurzwaffenMunition" type="number" min="0" value="${esc(ammoShortV11(inv))}"></label><button class="primary full">Speichern</button></form>`);
    document.getElementById('invForm').onsubmit=async e=>{e.preventDefault(); const fd=new FormData(e.target); const weapons={}; for(const [k,v] of fd.entries()) if(String(k).startsWith('weapon_')) weapons[String(k).slice(7)] = numV11(v); const patch={weapons, leichteWesten:numV11(fd.get('leichteWesten')), schwereWesten:numV11(fd.get('schwereWesten')), langwaffenMunition:numV11(fd.get('langwaffenMunition')), kurzwaffenMunition:numV11(fd.get('kurzwaffenMunition'))}; await api('/api/inventory/'+encodeURIComponent(uid),{method:'POST',body:JSON.stringify({patch})}); closeModal(); await refresh(true); toast('Lager gespeichert'); };
  };
  inventory = function(){
    const me=myUserIdV11(), canAll=canEditAllInventoryV11();
    const rows=Object.entries(invItemsV11()).filter(([uid])=>canAll||String(uid)===me).map(([uid,i])=>[userCell(uid), weaponLinesV11(i), `Leicht: ${esc(i.leichteWesten||0)}<br>Schwer: ${esc(i.schwereWesten||i.westen||0)}`, `Lang: ${esc(ammoLongV11(i))}<br>Kurz: ${esc(ammoShortV11(i))}`, esc(dt(i.updatedAt||i.lastUpdate||i.at)), `<button onclick="openInventoryModal('${esc(uid)}')">Bearbeiten</button>`]);
    const options=weaponNamesV11.map(w=>`<option value="${esc(w)}">${esc(w)}</option>`).join('');
    return `<div class="grid2"><div class="panel"><h2>Mein Lager</h2><p class="muted">${esc(mNameV11(me))}</p>${ownCardsV11(me)}<button onclick="openInventoryModal('${esc(me)}')">Bestand direkt bearbeiten</button></div><div class="panel"><h2>Sachen hinzufügen / entfernen</h2><p class="muted">Wähle Kategorie, Menge und ob es hinzugefügt oder entfernt werden soll.</p><form id="lagerQuickForm" class="form-grid" onsubmit="event.preventDefault();saveInventoryQuickV11('${esc(me)}')"><label>Aktion<select name="mode"><option value="add">Hinzufügen</option><option value="remove">Entfernen</option></select></label><label>Kategorie<select name="type"><option value="weapon">Waffe</option><option value="schwereWesten">Schwere Westen</option><option value="leichteWesten">Leichte Westen</option><option value="langwaffenMunition">Langwaffen Munition</option><option value="kurzwaffenMunition">Kurzwaffen Munition</option></select></label><label>Waffe<select name="weaponName">${options}</select></label><label>Menge<input name="qty" type="number" min="1" value="1"></label><button class="primary full">Speichern</button></form></div></div><div class="panel"><h2>${canAll?'Lager aller Mitglieder':'Mein Lager Verlauf'}</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Aktion'], rows)}</div>`;
  };
})();

/* ===== V12: vollständige Waffenliste + Abgabe-Panel mit Personenauswahl ===== */
(function(){
  const INVENTORY_WEAPONS_V12 = [
    'SMG','Mini SMG','PDW','Kampf PDW','Maschinenpistole','Karabiner','Karabiner MK2','Spezialkarabiner','Spezi','ADV','Advanced Rifle','Kompaktgewehr','Sturmgewehr','AK','Gusenberg','Sniper','Schweres Scharfschützengewehr','MG','Combat MG','Pumpgun','Schwere Schrotflinte','Abgesägte Schrotflinte',
    'Pistole','Pistole MK2','50er','AP-Pistole','Kampfpistole','Schwere Pistole','Vintage Pistole','SNS Pistole','Revolver','Taser',
    'Baseballschläger','Machete','Springmesser','Messer','Schlagring','Schlagstock','Brecheisen'
  ];
  function myUserIdV12(){ return String(DATA?.me?.id||''); }
  function canEditAllInventoryV12(){ return !!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser); }
  function invItemsV12(){ return DATA?.inventory?.items || {}; }
  function invV12(uid){ return invItemsV12()[String(uid||myUserIdV12())] || {}; }
  function mNameV12(uid){ return (typeof displayNameForUser==='function'?displayNameForUser(uid):uid); }
  function numV12(v){ return Math.max(0, Number(v||0)); }
  function ammoLongV12(i){ return numV12(i.langwaffenMunition ?? i.munitionLang ?? i.longAmmo ?? 0); }
  function ammoShortV12(i){ return numV12(i.kurzwaffenMunition ?? i.munitionKurz ?? i.shortAmmo ?? i.munition ?? 0); }
  function allWeaponNamesV12(){
    const set = new Set(INVENTORY_WEAPONS_V12);
    for(const i of Object.values(invItemsV12())) Object.keys(i?.weapons||i?.waffen||{}).forEach(w=>w&&set.add(w));
    if(DATA?.inventory?.family?.weapons) Object.keys(DATA.inventory.family.weapons).forEach(w=>w&&set.add(w));
    return [...set];
  }
  function weaponLinesV12(obj){
    const w = obj?.weapons||obj?.waffen||{};
    return allWeaponNamesV12().filter(k=>Number(w[k])>0).map(k=>`${esc(k)}: ${esc(w[k])}`).join('<br>') || '—';
  }
  function ownCardsV12(uid){
    const i=invV12(uid);
    return `<div class="cards"><div class="card"><div class="label">Waffen</div><div class="value small-value">${weaponLinesV12(i)}</div></div><div class="card"><div class="label">Westen</div><div class="value small-value">Leicht: ${esc(i.leichteWesten||0)}<br>Schwer: ${esc(i.schwereWesten||i.westen||0)}</div></div><div class="card"><div class="label">Munition</div><div class="value small-value">Langwaffen: ${esc(ammoLongV12(i))}<br>Kurzwaffen: ${esc(ammoShortV12(i))}</div></div></div>`;
  }
  function storagePatchFromFormV12(fd, current){
    const patch={weapons:{...(current.weapons||current.waffen||{})}};
    const type=String(fd.get('type')||'weapon');
    const qty=numV12(fd.get('qty'));
    const mode=String(fd.get('mode')||'add');
    const delta=mode==='remove' ? -qty : qty;
    function addKey(key){ patch[key]=Math.max(0,numV12(current[key])+delta); }
    if(type==='weapon'){
      const custom=String(fd.get('customWeaponName')||'').trim();
      const selected=String(fd.get('weaponName')||'').trim();
      const w=custom || selected;
      if(!w) throw new Error('Bitte Waffe auswählen oder eintragen.');
      patch.weapons[w]=Math.max(0,numV12(patch.weapons[w])+delta);
    } else if(type==='schwereWesten') addKey('schwereWesten');
    else if(type==='leichteWesten') addKey('leichteWesten');
    else if(type==='langwaffenMunition') addKey('langwaffenMunition');
    else if(type==='kurzwaffenMunition') addKey('kurzwaffenMunition');
    return patch;
  }
  window.saveInventoryQuickV11 = async function(uid){
    uid=String(uid||myUserIdV12());
    if(uid!==myUserIdV12() && !canEditAllInventoryV12()) return toast('Du darfst nur dein eigenes Lager bearbeiten.');
    const form=document.getElementById('lagerQuickForm');
    const fd=new FormData(form);
    try{
      const patch=storagePatchFromFormV12(fd, invV12(uid));
      await api('/api/inventory/'+encodeURIComponent(uid),{method:'POST',body:JSON.stringify({patch})});
      await refresh(true); toast('Lager aktualisiert');
    }catch(e){ toast(e.message||'Eingabe prüfen'); }
  };
  window.openInventoryModal = function(uid){
    uid=String(uid||myUserIdV12());
    if(uid!==myUserIdV12() && !canEditAllInventoryV12()) return toast('Du darfst nur dein eigenes Lager bearbeiten.');
    const inv=invV12(uid);
    const names=allWeaponNamesV12();
    const weaponInputs=names.map(k=>`<label>${esc(k)}<input name="weapon_${esc(k)}" type="number" min="0" value="${esc((inv.weapons||inv.waffen||{})[k]||0)}"></label>`).join('');
    openModal(`<h2>${uid===myUserIdV12()?'Eigenes Lager bearbeiten':'Lager bearbeiten'}</h2><p class="muted">${esc(mNameV12(uid))}</p><form id="invForm" class="form-grid"><h3 class="full">Waffen</h3>${weaponInputs}<h3 class="full">Westen</h3><label>Leichte Westen<input name="leichteWesten" type="number" min="0" value="${esc(inv.leichteWesten||0)}"></label><label>Schwere Westen<input name="schwereWesten" type="number" min="0" value="${esc(inv.schwereWesten||inv.westen||0)}"></label><h3 class="full">Munition</h3><label>Langwaffen Munition<input name="langwaffenMunition" type="number" min="0" value="${esc(ammoLongV12(inv))}"></label><label>Kurzwaffen Munition<input name="kurzwaffenMunition" type="number" min="0" value="${esc(ammoShortV12(inv))}"></label><button class="primary full">Speichern</button></form>`);
    document.getElementById('invForm').onsubmit=async e=>{e.preventDefault(); const fd=new FormData(e.target); const weapons={}; for(const [k,v] of fd.entries()) if(String(k).startsWith('weapon_')) weapons[String(k).slice(7)] = numV12(v); const patch={weapons, leichteWesten:numV12(fd.get('leichteWesten')), schwereWesten:numV12(fd.get('schwereWesten')), langwaffenMunition:numV12(fd.get('langwaffenMunition')), kurzwaffenMunition:numV12(fd.get('kurzwaffenMunition'))}; await api('/api/inventory/'+encodeURIComponent(uid),{method:'POST',body:JSON.stringify({patch})}); closeModal(); await refresh(true); toast('Lager gespeichert'); };
  };
  inventory = function(){
    const me=myUserIdV12(), canAll=canEditAllInventoryV12();
    const rows=Object.entries(invItemsV12()).filter(([uid])=>canAll||String(uid)===me).map(([uid,i])=>[userCell(uid), weaponLinesV12(i), `Leicht: ${esc(i.leichteWesten||0)}<br>Schwer: ${esc(i.schwereWesten||i.westen||0)}`, `Lang: ${esc(ammoLongV12(i))}<br>Kurz: ${esc(ammoShortV12(i))}`, esc(dt(i.updatedAt||i.lastUpdate||i.at)), `<button onclick="openInventoryModal('${esc(uid)}')">Bearbeiten</button>`]);
    const options=allWeaponNamesV12().map(w=>`<option value="${esc(w)}">${esc(w)}</option>`).join('');
    return `<div class="grid2"><div class="panel"><h2>Mein Lager</h2><p class="muted">${esc(mNameV12(me))}</p>${ownCardsV12(me)}<button onclick="openInventoryModal('${esc(me)}')">Bestand direkt bearbeiten</button></div><div class="panel"><h2>Sachen hinzufügen / entfernen</h2><p class="muted">Wähle Kategorie, Menge und ob es hinzugefügt oder entfernt werden soll. Fehlt eine Waffe, trage sie bei „Andere Waffe“ ein.</p><form id="lagerQuickForm" class="form-grid" onsubmit="event.preventDefault();saveInventoryQuickV11('${esc(me)}')"><label>Aktion<select name="mode"><option value="add">Hinzufügen</option><option value="remove">Entfernen</option></select></label><label>Kategorie<select name="type"><option value="weapon">Waffe</option><option value="schwereWesten">Schwere Westen</option><option value="leichteWesten">Leichte Westen</option><option value="langwaffenMunition">Langwaffen Munition</option><option value="kurzwaffenMunition">Kurzwaffen Munition</option></select></label><label>Waffe<select name="weaponName">${options}</select></label><label>Andere Waffe<input name="customWeaponName" placeholder="falls nicht in der Liste"></label><label>Menge<input name="qty" type="number" min="1" value="1"></label><button class="primary full">Speichern</button></form></div></div><div class="panel"><h2>${canAll?'Lager aller Mitglieder':'Mein Lager Verlauf'}</h2>${simpleTable(['Name','Waffen','Westen','Munition','Update','Aktion'], rows)}</div>`;
  };

  function memberOptionsForAbgabeV12(){
    const members = (typeof collectKnownMembersForAbgabe==='function') ? collectKnownMembersForAbgabe() : [];
    if(!members.length && DATA?.me?.id) return `<option value="${esc(DATA.me.id)}">${esc(displayNameForUser(DATA.me.id))} — ${esc(shortDiscordId(DATA.me.id))}</option>`;
    return members.map(([id,name])=>`<option value="${esc(id)}">${esc(name)} — ${esc(shortDiscordId(id))}</option>`).join('');
  }
  window.abgabenDiscordPanel = function(){
    const en = DATA?.config?.settings?.abgabenEnabled || {};
    const active = abgabeKeys().filter(k=>en[k]!==false);
    const week = window.abgabePanelWeek || isoWeekKey();
    const options = active.map(k=>`<option value="${E(k)}">${E(N(k))}</option>`).join('');
    return `<div class="discord-action-panel"><h3>Abgabe-Panel</h3><p class="muted">Wähle zuerst die Person aus. Nur aktive Abgabearten werden gelistet. „Zu spät“ gilt automatisch für die vorherige Woche.</p><div class="abgabe-fields"><label>Person<select id="discord_abgabe_user">${memberOptionsForAbgabeV12()}</select></label><label>Art<select id="discord_abgabe_cat">${options}</select></label><label>Woche<input id="discord_abgabe_week" value="${E(week)}"></label></div><div class="central-inline-actions"><button class="primary" onclick="setDiscordAbgabeStatus('abgegeben')">Abgegeben</button><button onclick="setDiscordAbgabeStatus('entschuldigt')">Entschuldigt</button><button onclick="setDiscordAbgabeStatus('delete')">Löschen</button><button onclick="setDiscordAbgabeStatus('zusatz')">Zusatz</button><button class="danger-btn" onclick="setDiscordAbgabeStatus('zuspaet')">Zu spät</button></div></div>`;
  };
})();


/* V14 customization center helpers */
(function(){
  const oldCards = window.customStatCards;
  window.customStatCards = function(){
    const c = DATA?.config?.settings?.customization || {}; const cards = c.statCards || [];
    const byPath = (obj,path)=>String(path||'').split('.').filter(Boolean).reduce((a,k)=>a&&a[k]!==undefined?a[k]:undefined,obj);
    return cards.filter(x=>x.visible!==false).sort((a,b)=>(a.order||0)-(b.order||0)).map(x=>({label:x.label,value:byPath(DATA,x.source) ?? '—',suffix:x.suffix||''}));
  };
})();

/* V17: Abgabearten verständlich machen: Teilnehmer-Rollen statt technische Rollen-ID */
(function(){
  function safeEsc(v){ return (typeof esc === 'function' ? esc(v) : String(v ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))); }
  function roles(){ return (typeof guildRolesList === 'function' ? guildRolesList() : (DATA?.guildRoles || [])).filter(r=>r && r.id && r.name !== '@everyone'); }
  function abTypes(){ return (typeof abgabeTypeList === 'function' ? abgabeTypeList() : []); }
  function typeByKey(key){ return abTypes().find(t=>String(t.key)===String(key)) || {}; }
  function selectedRolesForType(t){ return (Array.isArray(t.participantRoleIds) && t.participantRoleIds.length ? t.participantRoleIds : (Array.isArray(t.roleIds) && t.roleIds.length ? t.roleIds : (t.roleId ? [t.roleId] : []))).map(String).filter(Boolean); }
  function roleNames(ids){ const rs=roles(); return (ids||[]).map(id=>rs.find(r=>String(r.id)===String(id))?.name || id).join(', ') || 'Alle Mitglieder'; }
  function roleChecklist(id, selected=[]){ const sel=new Set((selected||[]).map(String)); const list=roles(); if(!list.length) return '<p class="muted">Keine Discord-Rollen geladen.</p>'; return `<div id="${safeEsc(id)}" class="role-check-grid">${list.map(r=>`<label class="role-check"><input type="checkbox" value="${safeEsc(r.id)}" ${sel.has(String(r.id))?'checked':''}><span>${safeEsc(r.name)}</span></label>`).join('')}</div><small class="muted">Diese Rollen bestimmen, welche Personen bei dieser Abgabeart auswählbar sind. Keine Auswahl = alle Mitglieder.</small>`; }
  function checkedRoleIds(id){ return Array.from(document.querySelectorAll(`#${CSS.escape(id)} input[type="checkbox"]:checked`)).map(x=>x.value).filter(Boolean); }
  function memberRoles(m){ return (m?.roles || m?.roleIds || m?.discordRoles || []).map(String); }
  function memberMatchesType(m, typeKey){ const t=typeByKey(typeKey); const ids=selectedRolesForType(t); if(!ids.length) return true; const mroles=memberRoles(m); return ids.some(id=>mroles.includes(String(id))); }
  function knownMembers(){ const arr=Array.isArray(DATA?.members)?DATA.members:[]; const byId=new Map(); arr.forEach(m=>{ const id=String(m.id||m.userId||m.discordId||'').trim(); if(id) byId.set(id,m); }); if(DATA?.me?.id && !byId.has(String(DATA.me.id))) byId.set(String(DATA.me.id), {id:DATA.me.id, nickname:DATA.me.name, roles:DATA.me.roles||[]}); return Array.from(byId.values()); }
  function memberOptionList(typeKey){ const list=knownMembers().filter(m=>memberMatchesType(m,typeKey)); if(!list.length) return '<option value="">Keine passende Person mit Teilnehmer-Rolle gefunden</option>'; return list.map(m=>{ const id=String(m.id||m.userId||m.discordId); const name=(typeof displayNameForUser==='function'?displayNameForUser(id):(m.serverName||m.nickname||id)); const short=(typeof shortDiscordId==='function'?shortDiscordId(id):id); return `<option value="${safeEsc(id)}">${safeEsc(name)} — ${safeEsc(short)}</option>`; }).join(''); }

  window.updateAbgabePersonOptionsV17 = function(){ const cat=document.getElementById('discord_abgabe_cat')?.value; const userSel=document.getElementById('discord_abgabe_user'); const hint=document.getElementById('abgabe_role_hint'); if(userSel) userSel.innerHTML=memberOptionList(cat); if(hint){ const ids=selectedRolesForType(typeByKey(cat)); const count=knownMembers().filter(m=>memberMatchesType(m,cat)).length; hint.textContent = `Teilnehmer-Rolle: ${roleNames(ids)} · auswählbare Personen: ${count}`; } };

  window.abgabenDiscordPanel = function(){
    const en = DATA?.config?.settings?.abgabenEnabled || {};
    const active = (typeof abgabeKeys==='function'?abgabeKeys():abTypes().map(t=>t.key)).filter(k=>en[k]!==false);
    const week = window.abgabePanelWeek || (typeof isoWeekKey==='function'?isoWeekKey():'');
    const options = active.map(k=>`<option value="${safeEsc(k)}">${safeEsc(typeof N==='function'?N(k):(typeByKey(k).label||k))}</option>`).join('');
    const first = active[0] || '';
    const ids = selectedRolesForType(typeByKey(first));
    const count = knownMembers().filter(m=>memberMatchesType(m,first)).length;
    setTimeout(()=>window.updateAbgabePersonOptionsV17?.(), 0);
    return `<div class="discord-action-panel"><h3>Abgabe-Panel</h3><p class="muted">Erst Abgabeart wählen, dann zeigt die Personenliste nur Mitglieder mit der passenden Teilnehmer-Rolle.</p><div class="abgabe-fields"><label>Abgabeart<select id="discord_abgabe_cat" onchange="updateAbgabePersonOptionsV17()">${options}</select></label><label>Person<select id="discord_abgabe_user">${memberOptionList(first)}</select></label><label>Woche<input id="discord_abgabe_week" value="${safeEsc(week)}"></label></div><p id="abgabe_role_hint" class="muted">Teilnehmer-Rolle: ${safeEsc(roleNames(ids))} · auswählbare Personen: ${count}</p><div class="central-inline-actions"><button class="primary" onclick="setDiscordAbgabeStatus('abgegeben')">Abgegeben</button><button onclick="setDiscordAbgabeStatus('entschuldigt')">Entschuldigt</button><button onclick="setDiscordAbgabeStatus('delete')">Löschen</button><button onclick="setDiscordAbgabeStatus('zusatz')">Zusatz</button><button class="danger-btn" onclick="setDiscordAbgabeStatus('zuspaet')">Zu spät</button></div></div>`;
  };

  window.customizationStudio = function(mode='all'){
    const c=DATA?.config?.settings?.customization || {}; const labels=c.labels||{}; const templates=c.templates||{}; const cards=c.statCards||[]; const ab=abTypes();
    const textsBlock = `<div class="panel"><h2>Texte & Namen</h2><p class="muted">Hier benennst du sichtbare Bereiche um. Keine technischen Schlüssel nötig.</p><div class="form-grid smart-form"><label>Übersicht – Titel<input id="lbl_overviewTitle" value="${safeEsc(labels.overviewTitle||'Übersicht')}"></label><label>Übersicht – Untertitel<input id="lbl_overviewSubtitle" value="${safeEsc(labels.overviewSubtitle||'Command Center')}"></label><label>Eigenes Lager – Titel<input id="lbl_inventoryOwnTitle" value="${safeEsc(labels.inventoryOwnTitle||'Mein Lager')}"></label><label>Abgaben – Titel<input id="lbl_abgabenTitle" value="${safeEsc(labels.abgabenTitle||'Abgaben')}"></label><label>Statistiken – Titel<input id="lbl_statisticsTitle" value="${safeEsc(labels.statisticsTitle||'Statistiken')}"></label><label>Bloodin/out – Titel<input id="lbl_bloodTitle" value="${safeEsc(labels.bloodTitle||'Blood in/out')}"></label><button class="primary full" onclick="saveCustomLabels()">Texte speichern</button></div></div>`;
    const tplKeys=[['bloodin','Blood-In Nachricht'],['bloodout','Blood-Out Nachricht'],['abgabe','Abgabe-Nachricht'],['sanktion','Sanktions-Nachricht']];
    const tplBlock = `<div class="panel"><h2>Nachrichten & Embeds</h2><p class="muted">Nachrichten werden bearbeitet, nicht neu gespammt. Vorschau zeigt dir, wie es ungefähr aussieht.</p>${tplKeys.map(([key,label])=>{ const t=templates[key]||{}; return `<details class="config-details"><summary>${safeEsc(label)}</summary><div class="form-grid smart-form"><label>Aktiv <input id="tpl_${key}_enabled" type="checkbox" ${t.enabled!==false?'checked':''}></label><label>Als Embed <input id="tpl_${key}_embed" type="checkbox" ${t.embed!==false?'checked':''}></label><label>Titel<input id="tpl_${key}_title" value="${safeEsc(t.title||label)}"></label><label>Farbe<input id="tpl_${key}_color" type="color" value="${safeEsc(t.color||'#d4af37')}"></label><label class="full">Nachricht<textarea id="tpl_${key}_message">${safeEsc(t.message||'')}</textarea></label><label class="full">Felder / Embed-Zeilen<textarea id="tpl_${key}_fields">${safeEsc(JSON.stringify(t.fields||[],null,2))}</textarea></label><div class="preview-box full"><b>Vorschau</b><p>${safeEsc((t.message||'').replaceAll('{name}','Fenasi Kerim').replaceAll('{week}','2026-W24').replaceAll('{category}','Patronen').replaceAll('{status}','abgegeben').replaceAll('{amount}','150'))||'Keine Nachricht eingetragen.'}</p></div><button class="primary full" onclick="saveTemplate('${key}')">${safeEsc(label)} speichern</button></div></details>`; }).join('')}</div>`;
    const rows = ab.map(t=>{ const ids=selectedRolesForType(t); return [safeEsc(t.label||t.key), safeEsc(roleNames(ids)), t.includeInStats===false?'Nein':'Ja', t.active===false?'Inaktiv':'Aktiv', `<button onclick="editAbgabeType('${safeEsc(t.key)}')">Bearbeiten</button> <button class="danger-btn" onclick="deleteAbgabeType('${safeEsc(t.key)}')">Löschen</button>`]; });
    const abgabeBlock = `<div class="panel"><h2>Abgabearten verwalten</h2><p class="muted">Die Teilnehmer-Rollen bestimmen, wer im Abgabe-Panel auswählbar ist. Beispiel: Routenabgabe → Rolle „Routen“ → nur Personen mit dieser Rolle werden angezeigt.</p><div class="form-grid smart-form"><label>Name der Abgabeart<input id="newAbg_label" placeholder="z. B. Patronen"></label><label>Kürzel wird automatisch erzeugt<input id="newAbg_key" placeholder="optional, z. B. patronen"></label><label>Emoji<input id="newAbg_emoji" value="📦"></label><label>Einheit<input id="newAbg_unit" placeholder="Stück / $ / Kisten"></label><label>Pflichtmenge<input id="newAbg_amount" type="number" value="0"></label><label>Discord-Kanal<input id="newAbg_channelName" placeholder="z. B. patronen-abgabe"></label><div class="full"><h3>Wer muss diese Abgabe leisten?</h3>${roleChecklist('newAbg_participantRoles', [])}</div><label><input id="newAbg_stats" type="checkbox" checked> in Statistik anzeigen</label><button class="primary full" onclick="saveAbgabeType()">Abgabeart speichern / erstellen</button></div><h3>Vorhandene Abgabearten</h3>${typeof simpleTable==='function'?simpleTable(['Abgabeart','Teilnehmer-Rollen','Statistik','Status','Aktion'], rows):''}</div>`;
    const sourceOptions=[['stats.families','Familienzahl'],['stats.members','Mitgliederzahl'],['stats.cashBalance','Kassenstand'],['stats.openSanctions','Offene Sanktionen'],['stats.absencesActive','Aktive Abmeldungen'],['stats.inventoryUsers','Lager-User']];
    const statsBlock = `<div class="panel"><h2>Statistik-Karten</h2><p class="muted">Wähle, welche Karten sichtbar sind und wie sie heißen.</p><div class="stat-config-list">${cards.map((x,i)=>`<div class="stat-config-row"><label>Titel<input id="stat_${i}_label" value="${safeEsc(x.label||'')}"></label><label>Datenquelle<select id="stat_${i}_source">${sourceOptions.map(([v,l])=>`<option value="${safeEsc(v)}" ${String(x.source)===v?'selected':''}>${safeEsc(l)}</option>`).join('')}<option value="${safeEsc(x.source||'')}" selected>${safeEsc(x.source||'Eigene Quelle')}</option></select></label><label class="checkline"><input id="stat_${i}_visible" type="checkbox" ${x.visible!==false?'checked':''}> sichtbar</label></div>`).join('')}</div><div class="central-inline-actions"><button onclick="addStatCard()">+ Karte</button><button class="primary" onclick="saveStatCards()">Statistiken speichern</button></div></div>`;
    let title='Anpassungs-Zentrale', desc='Alle anpassbaren Bereiche verständlich bearbeiten.'; let content=textsBlock+tplBlock+abgabeBlock+statsBlock;
    if(mode==='abgaben'){ title='Abgabearten verwalten'; desc='Teilnehmer-Rollen, Pflichtmenge, Statistik und aktive Abgaben.'; content=abgabeBlock; }
    if(mode==='messages'){ title='Nachrichten & Embeds'; desc='Bloodin/Bloodout, Panels und Meldungen mit Vorschau bearbeiten.'; content=tplBlock; }
    if(mode==='stats'){ title='Statistiken konfigurieren'; desc='Karten, Reihenfolge, Namen und Datenquellen.'; content=statsBlock; }
    if(mode==='texts'){ title='Texte & Labels'; desc='Sichtbare Begriffe in der Oberfläche umbenennen.'; content=textsBlock; }
    return `<div class="panel full-panel"><h2>🧩 ${safeEsc(title)}</h2><p class="muted">${safeEsc(desc)}</p>${content}</div>`;
  };

  window.saveAbgabeType = async function(){
    const label=(document.getElementById('newAbg_label')?.value||'').trim();
    const rawKey=(document.getElementById('newAbg_key')?.value||label).trim();
    const participantRoleIds=checkedRoleIds('newAbg_participantRoles');
    const body={key:rawKey,label,emoji:document.getElementById('newAbg_emoji')?.value||'📦',unit:document.getElementById('newAbg_unit')?.value||'',participantRoleIds,roleIds:participantRoleIds,roleId:participantRoleIds[0]||'',channelName:document.getElementById('newAbg_channelName')?.value||'',amount:Number(document.getElementById('newAbg_amount')?.value||0),includeInStats:!!document.getElementById('newAbg_stats')?.checked,active:true};
    if(!body.label) return toast('Bitte Name der Abgabeart eintragen.');
    await apiCall('/api/config/abgaben/types',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Abgabeart gespeichert');
  };
  window.editAbgabeType=function(key){ const t=typeByKey(key); ['key','label','emoji','unit','channelName'].forEach(k=>{ const el=document.getElementById('newAbg_'+k); if(el) el.value=t[k]||''; }); const amount=DATA?.config?.settings?.abgabenConfig?.[key]?.amount ?? t.amount ?? 0; const a=document.getElementById('newAbg_amount'); if(a) a.value=amount; const s=document.getElementById('newAbg_stats'); if(s) s.checked=t.includeInStats!==false; const selected=new Set(selectedRolesForType(t)); document.querySelectorAll('#newAbg_participantRoles input').forEach(i=>i.checked=selected.has(String(i.value))); };
})();

/* V18: Klare Embed-/Nachrichten-Erstellung mit Farbauswahl, Kanalziel und Markdown-Helfern */
(function(){
  function H(v){ return (typeof esc === 'function' ? esc(v) : String(v ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))); }
  function customization(){ return DATA?.config?.settings?.customization || {}; }
  function channels(){ const c=DATA?.config?.channels||{}; return Object.entries(c).filter(([k,v])=>v).map(([key,id])=>({key,id,label:key})); }
  const palette=[['#d4af37','Gold'],['#22c55e','Grün'],['#ef4444','Rot'],['#3b82f6','Blau'],['#a855f7','Lila'],['#f97316','Orange'],['#eab308','Gelb'],['#64748b','Grau']];
  const standardTemplates=[['bloodin','Blood-In Nachricht'],['bloodout','Blood-Out Nachricht'],['abgabe','Abgabe-Nachricht'],['sanktion','Sanktions-Nachricht'],['panel','Allgemeines Panel / Embed']];
  function fillSample(text){ const sample={name:'RDF | Fenasi Kerim',userId:'447008003170762753',date:new Date().toLocaleString('de-DE'),reason:'Beispiel-Grund',category:'Patronen',status:'abgegeben',week:(typeof isoWeekKey==='function'?isoWeekKey():'2026-W24'),amount:'150',members:'30'}; return String(text||'').replace(/\{(\w+)\}/g,(_,p)=>sample[p]??`{${p}}`); }
  function markdownToPreview(text){ return H(fillSample(text))
    .replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>')
    .replace(/\*([^*]+)\*/g,'<i>$1</i>')
    .replace(/__([^_]+)__/g,'<u>$1</u>')
    .replace(/^\s*-\s+(.+)$/gm,'• $1')
    .replace(/\n/g,'<br>'); }
  function colorPicker(id, value){ const val=value||'#d4af37'; return `<div class="color-picker-v18" data-color-target="${H(id)}">${palette.map(([hex,name])=>`<button type="button" class="color-dot-v18" title="${H(name)}" style="background:${H(hex)}" onclick="setColorV18('${H(id)}','${H(hex)}')" aria-label="${H(name)}"></button>`).join('')}<input id="${H(id)}" type="color" value="${H(val)}" oninput="refreshEmbedPreviewV18()"></div>`; }
  function toolbar(target){ return `<div class="editor-toolbar-v18"><button type="button" onclick="insertMarkdownV18('${H(target)}','bold')"><b>B</b></button><button type="button" onclick="insertMarkdownV18('${H(target)}','italic')"><i>I</i></button><button type="button" onclick="insertMarkdownV18('${H(target)}','underline')"><u>U</u></button><button type="button" onclick="insertMarkdownV18('${H(target)}','bullet')">• Liste</button><button type="button" onclick="insertMarkdownV18('${H(target)}','numbered')">1. Liste</button><button type="button" onclick="insertMarkdownV18('${H(target)}','line')">Trennlinie</button></div>`; }
  function channelSelect(id, selected=''){ const ch=channels(); return `<select id="${H(id)}"><option value="">Kein Kanal / nur speichern</option>${ch.map(c=>`<option value="${H(c.id)}" ${String(selected)===String(c.id)?'selected':''}># ${H(c.label)}</option>`).join('')}</select>`; }
  function previewBox(prefix, t={}){ return `<div class="discord-preview-v18" id="${H(prefix)}_preview"><div class="discord-preview-title-v18" style="border-left-color:${H(t.color||'#d4af37')}">${H(fillSample(t.title||'Vorschau'))}</div><div class="discord-preview-body-v18">${markdownToPreview(t.message||'Hier erscheint die Vorschau deiner Nachricht.')}</div></div>`; }
  function messageEditor(key,label,t={}){ const prefix=`tpl_${key}`; return `<details class="config-details message-details-v18" open><summary>${H(label)}</summary><div class="message-editor-v18"><div class="form-grid smart-form"><label>Nachrichten-Titel<input id="${H(prefix)}_title" value="${H(t.title||label)}" oninput="refreshEmbedPreviewV18('${H(key)}')"></label><label>Zielkanal${channelSelect(`${prefix}_channel`, t.channelId||t.channel||'')}</label><label>Farbe auswählen${colorPicker(`${prefix}_color`, t.color||'#d4af37')}</label><label><input id="${H(prefix)}_enabled" type="checkbox" ${t.enabled!==false?'checked':''}> aktiv</label><label><input id="${H(prefix)}_embed" type="checkbox" ${t.embed!==false?'checked':''}> als Embed anzeigen</label><label><input id="${H(prefix)}_editOnly" type="checkbox" ${t.editOnly!==false?'checked':''}> vorhandene Nachricht nur bearbeiten</label><div class="full"><label>Text</label>${toolbar(`${prefix}_message`)}<textarea id="${H(prefix)}_message" class="rich-textarea-v18" oninput="refreshEmbedPreviewV18('${H(key)}')">${H(t.message||'')}</textarea><small class="muted">Formatierung wie in Discord: **fett**, *kursiv*, __unterstrichen__, - Liste, 1. Liste. Platzhalter: {name}, {date}, {week}, {category}, {status}, {amount}, {members}.</small></div><button class="primary full" onclick="saveTemplateV18('${H(key)}')">Speichern</button></div>${previewBox(prefix,t)}</div></details>`; }
  function newEmbedCreator(){ return `<div class="panel create-embed-v18"><h2>➕ Neues Embed / Panel erstellen</h2><p class="muted">Für feste Discord-Nachrichten wie Philosophie, Regeln, Info-Panel oder Statistiken. Ziel: einmal erstellen, danach nur noch bearbeiten.</p><div class="form-grid smart-form"><label>Name intern<input id="newEmbed_key" placeholder="z. B. philosophie"></label><label>Überschrift<input id="newEmbed_title" placeholder="Philosophie"></label><label>Zielkanal${channelSelect('newEmbed_channel','')}</label><label>Farbe auswählen${colorPicker('newEmbed_color','#d4af37')}</label><label><input id="newEmbed_embed" type="checkbox" checked> als Embed</label><label><input id="newEmbed_editOnly" type="checkbox" checked> nach Erstellung nur bearbeiten</label><div class="full"><label>Text</label>${toolbar('newEmbed_message')}<textarea id="newEmbed_message" class="rich-textarea-v18" oninput="refreshNewEmbedPreviewV18()" placeholder="Schreibe hier deinen Text ...\n\n- Aufzählung\n- Noch ein Punkt\n\n1. Erster Punkt\n2. Zweiter Punkt"></textarea></div><button class="primary full" onclick="addCustomEmbedV18()">Embed speichern</button></div><h3>Vorschau</h3>${previewBox('newEmbed',{title:'Philosophie',message:'Dein Text erscheint hier.',color:'#d4af37'})}</div>`; }
  function messagesStudio(){ const c=customization(); const templates=c.templates||{}; const customKeys=Object.keys(templates).filter(k=>!['bloodin','bloodout','abgabe','sanktion'].includes(k)); const editors=standardTemplates.map(([k,l])=>messageEditor(k,l,templates[k]||{})).join('') + customKeys.map(k=>messageEditor(k, templates[k]?.title || k, templates[k]||{})).join(''); return `<div class="panel full-panel"><h2>💬 Nachrichten & Embeds</h2><p class="muted">Hier bearbeitest du Blood-In/Blood-Out, Panels und eigene Embeds. Farben wählst du per Klick. Nachrichten werden gespeichert und bestehende Discord-Nachrichten sollen bearbeitet werden, nicht jedes Mal neu gesendet.</p>${newEmbedCreator()}<div class="message-list-v18">${editors}</div></div>`; }
  const prevStudio = window.customizationStudio;
  window.customizationStudio = function(mode='all'){
    if(mode==='messages') return messagesStudio();
    if(mode==='all'){
      const rest = typeof prevStudio === 'function' ? prevStudio('all') : '';
      return messagesStudio() + rest;
    }
    return typeof prevStudio === 'function' ? prevStudio(mode) : messagesStudio();
  };
  window.setColorV18=function(id,color){ const el=document.getElementById(id); if(el){ el.value=color; el.dispatchEvent(new Event('input',{bubbles:true})); } refreshEmbedPreviewV18(); refreshNewEmbedPreviewV18(); };
  window.insertMarkdownV18=function(id,type){ const el=document.getElementById(id); if(!el) return; const start=el.selectionStart||0, end=el.selectionEnd||0; const selected=el.value.slice(start,end) || (type==='bullet'?'Listenpunkt':type==='numbered'?'Erster Punkt':'Text'); let insert=selected; if(type==='bold') insert=`**${selected}**`; if(type==='italic') insert=`*${selected}*`; if(type==='underline') insert=`__${selected}__`; if(type==='bullet') insert=selected.split('\n').map(x=>`- ${x.replace(/^[-\d.\s]+/,'')}`).join('\n'); if(type==='numbered') insert=selected.split('\n').map((x,i)=>`${i+1}. ${x.replace(/^[-\d.\s]+/,'')}`).join('\n'); if(type==='line') insert='\n────────────\n'; el.value=el.value.slice(0,start)+insert+el.value.slice(end); el.focus(); el.dispatchEvent(new Event('input',{bubbles:true})); };
  window.refreshEmbedPreviewV18=function(key){ const keys=key?[key]:Object.keys(customization().templates||{}).concat(['bloodin','bloodout','abgabe','sanktion','panel']); keys.forEach(k=>{ const prefix=`tpl_${k}`; const box=document.getElementById(`${prefix}_preview`); if(!box) return; const title=document.getElementById(`${prefix}_title`)?.value||'Vorschau'; const msg=document.getElementById(`${prefix}_message`)?.value||''; const color=document.getElementById(`${prefix}_color`)?.value||'#d4af37'; box.innerHTML=`<div class="discord-preview-title-v18" style="border-left-color:${H(color)}">${H(fillSample(title))}</div><div class="discord-preview-body-v18">${markdownToPreview(msg||'Keine Nachricht eingetragen.')}</div>`; }); };
  window.refreshNewEmbedPreviewV18=function(){ const box=document.getElementById('newEmbed_preview'); if(!box) return; const title=document.getElementById('newEmbed_title')?.value||'Vorschau'; const msg=document.getElementById('newEmbed_message')?.value||''; const color=document.getElementById('newEmbed_color')?.value||'#d4af37'; box.innerHTML=`<div class="discord-preview-title-v18" style="border-left-color:${H(color)}">${H(fillSample(title))}</div><div class="discord-preview-body-v18">${markdownToPreview(msg||'Keine Nachricht eingetragen.')}</div>`; };
  window.saveTemplateV18=async function(key){ const prefix=`tpl_${key}`; const templates={}; templates[key]={title:document.getElementById(`${prefix}_title`)?.value||'', color:document.getElementById(`${prefix}_color`)?.value||'#d4af37', message:document.getElementById(`${prefix}_message`)?.value||'', fields:[], channelId:document.getElementById(`${prefix}_channel`)?.value||'', enabled:!!document.getElementById(`${prefix}_enabled`)?.checked, embed:!!document.getElementById(`${prefix}_embed`)?.checked, editOnly:!!document.getElementById(`${prefix}_editOnly`)?.checked}; await apiCall('/api/config/customization',{method:'POST',body:JSON.stringify({templates})}); await refresh(true); toast('Nachricht/Embed gespeichert'); };
  window.addCustomEmbedV18=async function(){ const title=(document.getElementById('newEmbed_title')?.value||'').trim(); const raw=(document.getElementById('newEmbed_key')?.value||title).trim().toLowerCase().replace(/[^a-z0-9_\-]/g,'_'); if(!raw || !title) return toast('Bitte Name und Überschrift eintragen.'); const key=`custom_${raw}`; const templates={}; templates[key]={title, color:document.getElementById('newEmbed_color')?.value||'#d4af37', message:document.getElementById('newEmbed_message')?.value||'', fields:[], channelId:document.getElementById('newEmbed_channel')?.value||'', enabled:true, embed:!!document.getElementById('newEmbed_embed')?.checked, editOnly:!!document.getElementById('newEmbed_editOnly')?.checked, kind:'customPanel'}; await apiCall('/api/config/customization',{method:'POST',body:JSON.stringify({templates})}); await refresh(true); toast('Neues Embed gespeichert'); };
})();


function tradingData(){ const d=DATA?.trading||{}; return { products:d.products||{}, vehicles:d.vehicles||{}, loans:d.loans||[] }; }
function activeEntries(obj){ return Object.values(obj||{}).filter(x=>x.active!==false); }
function tradingPage(){
  const t=tradingData(); const products=activeEntries(t.products); const vehicles=activeEntries(t.vehicles); const loanRows=(t.loans||[]).filter(x=>x.status!=='zurueck').slice(0,80);
  const firstVehicle = vehicles[0] || {}; const firstProduct = products[0] || {};
  const pOpts=products.map(p=>`<option value="${esc(p.key)}" data-price="${Number(p.price||0)}">${esc(p.name)} (${money(p.price||0)})</option>`).join('');
  const vOpts=vehicles.map(v=>`<option value="${esc(v.key)}" data-cap="${Number(v.capacity||0)}">${esc(v.name)} (${Number(v.capacity||0)} Platz)</option>`).join('');
  return `<div class="grid"><div class="panel"><h2>🧮 Verkaufsrechner</h2><p class="muted">Preise sind anpassbar. Das Preisfeld zeigt immer direkt den zuletzt gespeicherten Zahlenwert.</p><form id="tradeCalc" class="form-grid"><label>Produkt<select name="product">${pOpts}</select></label><label>Menge<input name="amount" type="number" value="0" min="0"></label><label>Einzelpreis<input id="calcPrice" type="number" value="${Number(firstProduct.price||0)}"></label><label>Gesamt<input id="calcTotal" disabled></label></form><h2>Preise bearbeiten</h2>${can('configWrite')?`<div class="table-wrap"><table><thead><tr><th>Produkt</th><th>Preis</th><th>Aktiv</th><th></th></tr></thead><tbody>${Object.values(t.products).map(p=>`<tr><td><input id="prod_name_${esc(p.key)}" value="${esc(p.name)}"></td><td><input id="prod_price_${esc(p.key)}" type="number" value="${Number(p.price||0)}"></td><td><input id="prod_active_${esc(p.key)}" type="checkbox" ${p.active!==false?'checked':''}></td><td><button onclick="saveTradingProduct('${esc(p.key)}')">Speichern</button></td></tr>`).join('')}</tbody></table></div><div class="toolbar"><input id="newProdName" placeholder="Neues Produkt"><input id="newProdPrice" type="number" placeholder="Preis"><button class="primary" onclick="addTradingProduct()">+ Produkt</button></div>`:'<p class="muted">Preise nur für Berechtigte bearbeitbar.</p>'}</div>
  <div class="panel"><h2>🚚 Ausgeliehene Fahrzeuge</h2><p class="muted">Menge ist standardmäßig immer voll. Preis zeigt direkt den zuletzt gespeicherten Wert und kann überschrieben werden.</p><form id="loanForm" class="form-grid"><label>Fahrzeug<select name="vehicleKey">${vOpts}</select></label><label>Inhalt<select name="productKey">${pOpts}</select></label><label>Von<input name="from" placeholder="von wem"></label><label>An<input name="to" placeholder="an wen"></label><label>Menge/Inhalt<input name="amount" type="number" min="0" value="${Number(firstVehicle.capacity||0)}"></label><label>Preis pro Stück<input name="price" type="number" min="0" value="${Number(firstProduct.price||0)}"></label><label class="full">Notiz<input name="note" placeholder="z.B. voll, halbvoll, Treffpunkt"></label><button class="primary full">Ausleihe speichern</button></form>${simpleTable(['Fahrzeug','Von → An','Inhalt','Preis','Wert','Status','Aktion'], loanRows.map(l=>[l.vehicleName,`${esc(l.from)} → ${esc(l.to)}`,`${esc(l.amount)} ${esc(l.productName)}`,money(l.price ?? 0),money(l.value||0),l.status,`<button onclick="closeTradingLoan('${esc(l.id)}')">Zurück</button>`]))}<h2>Fahrzeugtypen</h2>${can('configWrite')?`<div class="cards">${Object.values(t.vehicles).map(v=>`<div class="card"><div class="label"><input id="veh_name_${esc(v.key)}" value="${esc(v.name)}"></div><input id="veh_cap_${esc(v.key)}" type="number" value="${Number(v.capacity||0)}"><label><input id="veh_active_${esc(v.key)}" type="checkbox" ${v.active!==false?'checked':''}> aktiv</label><button onclick="saveTradingVehicle('${esc(v.key)}')">Speichern</button></div>`).join('')}</div><div class="toolbar"><input id="newVehName" placeholder="Neues Fahrzeug"><input id="newVehCap" type="number" placeholder="Platz"><button onclick="addTradingVehicle()">+ Fahrzeug</button></div>`:''}</div></div>`;
}
function updateTradeCalc(){ const t=tradingData(); const f=document.getElementById('tradeCalc'); if(!f) return; const p=t.products[f.product.value]||{}; const priceEl=document.getElementById('calcPrice'); if(document.activeElement!==priceEl) priceEl.value=Number(p.price||0); document.getElementById('calcTotal').value=money(Number(f.amount.value||0)*Number(priceEl.value||0)); }
async function saveTradingProduct(key){ await api('/api/trading/config',{method:'POST',body:JSON.stringify({type:'product',key,name:document.getElementById('prod_name_'+key).value,price:Number(document.getElementById('prod_price_'+key).value||0),active:document.getElementById('prod_active_'+key).checked})}); await refresh(true); toast('Produkt gespeichert'); }
async function addTradingProduct(){ const n=document.getElementById('newProdName').value; await api('/api/trading/config',{method:'POST',body:JSON.stringify({type:'product',name:n,price:Number(document.getElementById('newProdPrice').value||0),active:true})}); await refresh(true); }
async function saveTradingVehicle(key){ await api('/api/trading/config',{method:'POST',body:JSON.stringify({type:'vehicle',key,name:document.getElementById('veh_name_'+key).value,capacity:Number(document.getElementById('veh_cap_'+key).value||0),active:document.getElementById('veh_active_'+key).checked})}); await refresh(true); toast('Fahrzeug gespeichert'); }
async function addTradingVehicle(){ await api('/api/trading/config',{method:'POST',body:JSON.stringify({type:'vehicle',name:document.getElementById('newVehName').value,capacity:Number(document.getElementById('newVehCap').value||0),active:true})}); await refresh(true); }
async function closeTradingLoan(id){ await api('/api/trading/loans',{method:'POST',body:JSON.stringify({id,status:'zurueck'})}); await refresh(true); toast('Ausleihe geschlossen'); }

document.addEventListener('input', e=>{ if(e.target.closest?.('#tradeCalc')) updateTradeCalc(); });
function updateLoanDefaults(e){ const f=document.getElementById('loanForm'); if(!f) return; if(!e || e.target?.name==='vehicleKey'){ const cap=f.vehicleKey?.selectedOptions?.[0]?.dataset?.cap; if(cap!==undefined) f.amount.value=Number(cap||0); } if(!e || e.target?.name==='productKey'){ const price=f.productKey?.selectedOptions?.[0]?.dataset?.price; if(price!==undefined) f.price.value=Number(price||0); } }
document.addEventListener('change', e=>{ if(e.target.closest?.('#tradeCalc')) updateTradeCalc(); if(e.target.closest?.('#loanForm')) updateLoanDefaults(e); });
document.addEventListener('submit', async e=>{ if(e.target.id==='loanForm'){ e.preventDefault(); const o=Object.fromEntries(new FormData(e.target)); await api('/api/trading/loans',{method:'POST',body:JSON.stringify(o)}); await refresh(true); toast('Ausleihe gespeichert'); }});


/* ===== V21 Clean UI overhaul: map, inventory, settings readability ===== */
(function(){
  const H = (v)=> typeof esc==='function' ? esc(v ?? '') : String(v ?? '').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function compactName(f){ return f?.familie || f?.name || 'Unbenannt'; }
  function familySearchInput(){
    return `<div class="clean-search"><input id="familyMapSearch" placeholder="Familie, Kürzel oder PLZ suchen …" value="${H(q())}" oninput="document.getElementById('globalSearch').value=this.value;renderCurrent()"><button onclick="document.getElementById('globalSearch').value='';renderCurrent()">Zurücksetzen</button></div>`;
  }
  function cleanFamilyList(fams){
    const shown = fams.slice(0,10);
    return `<div class="clean-family-list">${shown.map(f=>{ const p=basePlacementForFamily(f); return `<button class="family-hit" onclick="focusFamilyOnMap('${H(f.id)}')"><span><b>${H(compactName(f))}</b><small>${H(f.category||'')} · ${H(f.plz||'—')} · ${H(f.kuerzel||'-')}</small></span><em>${H(regionLabel(p.region))}</em></button>`; }).join('') || '<p class="muted">Keine Familie gefunden.</p>'}${fams.length>10?`<p class="muted small-note">${fams.length-10} weitere Treffer – Suche genauer eingrenzen.</p>`:''}</div>`;
  }
  map = function(){
    currentMapRegion = 'overview';
    const fams = filterRows(DATA.families||[], [x => `${x.familie} ${x.kuerzel} ${x.plz} ${x.category} ${JSON.stringify(x.contacts)}`]);
    const placements = buildMapPlacements(fams);
    const selected = (DATA.families||[]).find(f => f.id === selectedFamily);
    return `<div class="clean-map-page">
      <div class="clean-map-head">
        <div><h2>Familienkarte</h2><p class="muted">Ziehe die Karte, zoome mit dem Mausrad und verschiebe Marker direkt per Drag & Drop.</p></div>
        <div class="clean-map-actions"><span class="pill gold">${placements.length} Marker</span>${can('familiesWrite') ? `<button class="${mapPickMode?'danger':'primary'}" onclick="toggleMapPick()">${mapPickMode?'PLZ speichern beenden':'PLZ-Position speichern'}</button>` : ''}</div>
      </div>
      <div class="clean-map-grid">
        <section class="clean-map-card">
          <div class="family-map family-map-viewport real-map clean-map-viewport" id="mapViewport">
            <div class="map-controls clean-map-controls">
              <button class="map-control-btn" onclick="zoomFamilyMap(0.25)">+</button>
              <button class="map-control-btn" onclick="zoomFamilyMap(-0.25)">−</button>
              <button class="map-control-btn" onclick="resetFamilyMapView(${selected ? 'true' : 'false'})">Reset</button>
              <span id="mapZoomLabel" class="pill gold">100%</span>
            </div>
            <div class="map-stage" id="mapStage"><img class="map-base" src="${FAMILY_MAP_ASSET}" alt="Familienkarte" draggable="false">${placements.map(marker).join('')}</div>
          </div>
          <p class="map-help">Tipp: freie Fläche ziehen = Karte bewegen. Marker ziehen = Position speichern.</p>
        </section>
        <aside class="clean-side-panel">
          <h3>Familie finden</h3>${familySearchInput()}
          <h3>Treffer</h3>${cleanFamilyList(fams)}
          <h3>Auswahl</h3><div id="mapDetail" class="clean-selection">${selectedFamily ? familyDetailMini(selected) : '<p class="muted">Noch nichts ausgewählt.</p>'}</div>
        </aside>
      </div>
    </div>`;
  };

  function itemChips(obj){
    const entries=Object.entries(obj||{}).filter(([_,v])=>Number(v)>0);
    return entries.length ? entries.map(([k,v])=>`<span class="item-chip"><b>${H(k)}</b>${H(v)}</span>`).join('') : '<span class="muted">Keine Einträge</span>';
  }
  function invObj(uid){ return (DATA?.inventory?.items||{})[String(uid||DATA?.me?.id||'')] || {}; }
  function n(v){ return Math.max(0, Number(v||0)); }
  function longAmmo(i){ return n(i.langwaffenMunition ?? i.munitionLang ?? i.longAmmo ?? 0); }
  function shortAmmo(i){ return n(i.kurzwaffenMunition ?? i.munitionKurz ?? i.shortAmmo ?? i.munition ?? 0); }
  function allWeaponsClean(){
    const base=['SMG','Mini SMG','PDW','Kampf PDW','Maschinenpistole','Karabiner','Karabiner MK2','Spezialkarabiner','Advanced Rifle','Kompaktgewehr','Sturmgewehr','Gusenberg','Sniper','MG','Combat MG','Pumpgun','Pistole','Pistole MK2','50er','AP-Pistole','Kampfpistole','Schwere Pistole','Vintage Pistole','SNS Pistole','Revolver','Taser','Baseballschläger','Machete','Springmesser','Messer','Schlagring'];
    const set=new Set(base); Object.values(DATA?.inventory?.items||{}).forEach(i=>Object.keys(i?.weapons||i?.waffen||{}).forEach(w=>w&&set.add(w))); return [...set];
  }
  function cleanInventorySummary(uid){
    const i=invObj(uid); const w=i.weapons||i.waffen||{};
    return `<div class="inventory-summary-clean"><div class="summary-box wide"><span>Waffen</span><div class="chip-cloud">${itemChips(w)}</div></div><div class="summary-box"><span>Westen</span><strong>Leicht ${H(i.leichteWesten||0)}</strong><strong>Schwer ${H(i.schwereWesten||i.westen||0)}</strong></div><div class="summary-box"><span>Munition</span><strong>Lang ${H(longAmmo(i))}</strong><strong>Kurz ${H(shortAmmo(i))}</strong></div></div>`;
  }
  inventory = function(){
    const me=String(DATA?.me?.id||''); const canAll=!!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser);
    const rows=Object.entries(DATA?.inventory?.items||{}).filter(([uid])=>canAll||String(uid)===me).map(([uid,i])=>[userCell(uid), `<div class="chip-cloud compact">${itemChips(i.weapons||i.waffen||{})}</div>`, `Leicht ${H(i.leichteWesten||0)} · Schwer ${H(i.schwereWesten||i.westen||0)}`, `Lang ${H(longAmmo(i))} · Kurz ${H(shortAmmo(i))}`, `<button onclick="openInventoryModal('${H(uid)}')">Bearbeiten</button>`]);
    const options=allWeaponsClean().map(w=>`<option value="${H(w)}">${H(w)}</option>`).join('');
    return `<div class="clean-inventory-page">
      <div class="clean-page-title"><h2>Lager</h2><p class="muted">Links siehst du deinen Bestand. Rechts kannst du schnell hinzufügen oder entfernen.</p></div>
      <div class="inventory-clean-grid">
        <section class="panel clean-panel"><h3>Mein Lager</h3><p class="muted">${H(typeof displayNameForUser==='function'?displayNameForUser(me):me)}</p>${cleanInventorySummary(me)}<button onclick="openInventoryModal('${H(me)}')">Komplett bearbeiten</button></section>
        <section class="panel clean-panel"><h3>Schnell ändern</h3><form id="lagerQuickForm" class="clean-form" onsubmit="event.preventDefault();saveInventoryQuickV11('${H(me)}')"><label>Aktion<select name="mode"><option value="add">Hinzufügen</option><option value="remove">Entfernen</option></select></label><label>Kategorie<select name="type"><option value="weapon">Waffe</option><option value="schwereWesten">Schwere Westen</option><option value="leichteWesten">Leichte Westen</option><option value="langwaffenMunition">Langwaffen Munition</option><option value="kurzwaffenMunition">Kurzwaffen Munition</option></select></label><label>Waffe<select name="weaponName">${options}</select></label><label>Andere Waffe<input name="customWeaponName" placeholder="Nur wenn sie fehlt"></label><label>Menge<input name="qty" type="number" min="1" value="1"></label><button class="primary">Speichern</button></form></section>
      </div>
      <section class="panel clean-panel"><h3>${canAll?'Lager aller Mitglieder':'Mein Lager'}</h3>${simpleTable(['Name','Waffen','Westen','Munition','Aktion'], rows)}</section>
    </div>`;
  };

  function humanSettingName(k){ return ({smartPingEnabled:'Smart Ping',autoSanctionsEnabled:'Automatische Sanktionen',termRemindersEnabled:'Termin-Erinnerungen',decisionHintsEnabled:'Entscheidungs-Hinweise',leaderDmRemindersEnabled:'Leader-DM-Erinnerungen',fridayReportEnabled:'Freitagsbericht',mondayReportEnabled:'Montagsbericht',wacheFridayReportEnabled:'Wache-Freitagsbericht',wacheMondayReportEnabled:'Wache-Montagsbericht',dashboardAbgabenEnabled:'Dashboard-Abgaben',reportsEnabled:'Berichte aktiv',dryRun:'Testmodus / Dry Run',systemLogsEnabled:'System-Logs',spamProtectionEnabled:'Spam-Schutz'})[k] || String(k).replace(/([A-Z])/g,' $1').replace(/^./,m=>m.toUpperCase()); }
  function humanSettingDesc(k){ return ({reportsEnabled:'Schaltet automatische Berichte gesammelt ein oder aus.',dryRun:'Testet Abläufe ohne echte Änderungen oder Posts.',systemLogsEnabled:'Schreibt wichtige Systemaktionen ins Log.',spamProtectionEnabled:'Schützt Buttons/Befehle vor zu häufiger Nutzung.'})[k] || ''; }
  if(typeof settingsPanel === 'function'){
    const oldSettingsPanel=settingsPanel;
    settingsPanel=function(){
      const html=oldSettingsPanel();
      return html.replace(/<b>([^<]+)<\/b><p>([^<]*)<\/p>/g,(m,k,d)=>`<b>${H(humanSettingName(k))}</b><p>${H(humanSettingDesc(k)||d)}</p>`);
    };
  }
})();

/* ===== V25 requested fixes: relative map zoom, clean abgaben workflow, synced inventory display, switch toggles ===== */
(function(){
  const H = (v)=> typeof esc==='function' ? esc(v ?? '') : String(v ?? '').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const DEFAULT_MAP_SCALE_V25 = 1.25;

  function currentIsoWeekV25(d=new Date()){
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2,'0')}`;
  }
  function previousIsoWeekV25(w=currentIsoWeekV25()){
    const m=String(w||'').match(/^(\d{4})-W(\d{2})$/);
    if(!m) return w;
    const simple = new Date(Date.UTC(Number(m[1]),0,1+(Number(m[2])-1)*7));
    simple.setUTCDate(simple.getUTCDate()-7);
    return currentIsoWeekV25(simple);
  }

  // Map: technisch 125%, aber als Standard = 100% anzeigen.
  const oldApply = typeof applyFamilyMapTransform === 'function' ? applyFamilyMapTransform : null;
  applyFamilyMapTransform = function(){
    const stage = typeof familyMapStage === 'function' ? familyMapStage() : document.getElementById('mapStage');
    if(!stage) return;
    if(typeof constrainFamilyMapView === 'function') constrainFamilyMapView();
    stage.style.transform = `translate(${familyMapView.x}px, ${familyMapView.y}px) scale(${familyMapView.scale})`;
    const lbl = typeof familyMapZoomLabel === 'function' ? familyMapZoomLabel() : document.getElementById('mapZoomLabel');
    if(lbl) lbl.textContent = Math.round((familyMapView.scale / DEFAULT_MAP_SCALE_V25) * 100) + '%';
  };
  const oldResetMap = window.resetFamilyMapView;
  window.resetFamilyMapView = function(centerSelected=false){
    familyMapView.scale = DEFAULT_MAP_SCALE_V25;
    familyMapView.x = 0;
    familyMapView.y = 0;
    applyFamilyMapTransform();
    if(centerSelected && selectedFamily) setTimeout(() => centerFamilyOnMap(selectedFamily, Math.max(DEFAULT_MAP_SCALE_V25, 1.8)), 0);
  };
  const oldAfterRenderV25 = typeof afterRender === 'function' ? afterRender : null;
  afterRender = function(){
    if(current === 'map' && (!familyMapView || familyMapView.scale === 1)) {
      familyMapView.scale = DEFAULT_MAP_SCALE_V25;
      familyMapView.x = 0;
      familyMapView.y = 0;
    }
    if(oldAfterRenderV25) oldAfterRenderV25();
    if(current === 'map') setTimeout(applyFamilyMapTransform, 0);
  };

  // Helpers Abgabearten / Rollen / Mitglieder
  function abgabeTypeListV25(){
    const settings = DATA?.config?.settings || {};
    const cfg = settings.abgabenConfig || {};
    const enabled = settings.abgabenEnabled || {};
    const custom = settings.customization?.abgabeTypes || [];
    const labels = {routen:'Routen', patronen:'Patronen', schwarzgeld:'Schwarzgeld', schwarzpulver:'Schwarzpulver', meth:'Meth'};
    const map = new Map();
    ['routen','patronen','schwarzgeld','schwarzpulver','meth', ...Object.keys(cfg), ...Object.keys(enabled)].forEach(k=>{
      if(!k) return; map.set(k, {key:k, label:labels[k]||niceKey?.(k)||k, active:enabled[k]!==false, participantRoleIds:[]});
    });
    custom.forEach(t=>{ if(t?.key) map.set(String(t.key), {...(map.get(String(t.key))||{}), ...t, active:t.active!==false && enabled[String(t.key)]!==false}); });
    return [...map.values()].filter(t=>t.active!==false);
  }
  function typeByKeyV25(key){ return abgabeTypeListV25().find(t=>String(t.key)===String(key)) || {key, label: niceKey?.(key)||key}; }
  function selectedRolesForTypeV25(t){ return (Array.isArray(t?.participantRoleIds)&&t.participantRoleIds.length?t.participantRoleIds:(Array.isArray(t?.roleIds)&&t.roleIds.length?t.roleIds:(t?.roleId?[t.roleId]:[]))).map(String).filter(Boolean); }
  function roleNameV25(id){
    try{ if(typeof roleNameById==='function') return roleNameById(id); }catch(_){ }
    const r=(typeof guildRolesList==='function'?guildRolesList():DATA?.guildRoles||[]).find(x=>String(x.id)===String(id));
    return r?.name || id;
  }
  function roleNamesV25(ids){ return (ids||[]).map(roleNameV25).join(', ') || 'Alle Mitglieder'; }
  function memberIdV25(m){ return String(m?.id || m?.userId || m?.discordId || m?.discord_id || '').trim(); }
  function memberRolesV25(m){ return (m?.roles || m?.roleIds || m?.discordRoles || []).map(String); }
  function knownMembersV25(){
    const byId = new Map();
    (Array.isArray(DATA?.members)?DATA.members:[]).forEach(m=>{ const id=memberIdV25(m); if(id) byId.set(id,m); });
    if(DATA?.me?.id && !byId.has(String(DATA.me.id))) byId.set(String(DATA.me.id), {id:DATA.me.id, roles:DATA.me.roles||[], nickname:DATA.me.name||DATA.me.username});
    collectAbgabeRows?.().forEach(r=>{ const id=String(r._userId||r.userId||'').trim(); if(id && !byId.has(id)) byId.set(id,{id}); });
    return [...byId.values()];
  }
  function memberMatchesTypeV25(m, typeKey){
    const roles=selectedRolesForTypeV25(typeByKeyV25(typeKey));
    if(!roles.length) return true;
    const own=memberRolesV25(m);
    return roles.some(r=>own.includes(String(r)));
  }
  function eligibleMembersV25(typeKey){ return knownMembersV25().filter(m=>memberMatchesTypeV25(m,typeKey)).sort((a,b)=>String(displayNameForUser(memberIdV25(a))).localeCompare(String(displayNameForUser(memberIdV25(b))))); }
  function memberOptionsV25(typeKey){
    const list=eligibleMembersV25(typeKey);
    if(!list.length) return '<option value="">Keine passende Person gefunden</option>';
    return list.map(m=>{ const id=memberIdV25(m); const short=(typeof shortDiscordId==='function'?shortDiscordId(id):id.slice(0,6)+'…'+id.slice(-4)); return `<option value="${H(id)}">${H(displayNameForUser(id))} — ${H(short)}</option>`; }).join('');
  }
  function abgabeStatusForV25(category, weekKey, userId){
    const rows = typeof collectAbgabeRows==='function' ? collectAbgabeRows() : [];
    const row = rows.find(r=>String(r._weekKey||r.weekKey||r.week)===String(weekKey) && String(r.category||r.type||r.art)===String(category) && String(r._userId||r.userId)===String(userId));
    if(!row) return {label:'Offen', cls:'bad', raw:null};
    const f = typeof abgabeStatusFlags2==='function' ? abgabeStatusFlags2(row) : {};
    if(f.prepaid) return {label:'Vorausgezahlt', cls:'good', raw:row};
    if(f.excused) return {label:'Entschuldigt', cls:'warn', raw:row};
    if(f.submitted) return {label:'Abgegeben', cls:'good', raw:row};
    if(f.warning) return {label:'Zu spät / Warnphase', cls:'warn', raw:row};
    if(f.sanctioned) return {label:'Sanktioniert', cls:'bad', raw:row};
    if(String(row.status||'').toLowerCase().includes('gelöscht')) return {label:'Gelöscht', cls:'muted', raw:row};
    return {label: row.status ? niceKey(row.status) : 'Offen', cls:'bad', raw:row};
  }
  function updateAbgabeHintV25(){
    const cat=document.getElementById('discord_abgabe_cat_v25')?.value;
    const person=document.getElementById('discord_abgabe_user_v25');
    const hint=document.getElementById('abgabe_role_hint_v25');
    if(person) person.innerHTML = memberOptionsV25(cat);
    const roles=selectedRolesForTypeV25(typeByKeyV25(cat));
    const count=eligibleMembersV25(cat).length;
    if(hint) hint.textContent = `Teilnehmer-Rolle: ${roleNamesV25(roles)} · auswählbare Personen: ${count}`;
    const list=document.getElementById('abgabe_current_week_list_v25');
    if(list) list.innerHTML = abgabeCurrentWeekListV25(cat);
  }
  window.updateAbgabeHintV25 = updateAbgabeHintV25;

  function abgabeActionPanelV25(){
    const types=abgabeTypeListV25();
    const first=types[0]?.key || '';
    const currentWeek=currentIsoWeekV25();
    const opts=types.map(t=>`<option value="${H(t.key)}">${H(t.label||niceKey?.(t.key)||t.key)}</option>`).join('');
    return `<section class="panel abgabe-clean-panel"><div class="abgabe-clean-head"><div><h2>Abgabe-Panel</h2><p class="muted">Aktuelle Woche ist automatisch aktiv. Bei „Zu spät“ wird automatisch die vorherige Woche genutzt.</p></div><span class="pill gold">${H(currentWeek)}</span></div>
      <div class="abgabe-clean-form">
        <label>Abgabeart<select id="discord_abgabe_cat_v25" onchange="updateAbgabeHintV25()">${opts}</select></label>
        <label>Person<select id="discord_abgabe_user_v25">${memberOptionsV25(first)}</select></label>
      </div>
      <p id="abgabe_role_hint_v25" class="muted">Teilnehmer-Rolle: ${H(roleNamesV25(selectedRolesForTypeV25(typeByKeyV25(first))))} · auswählbare Personen: ${eligibleMembersV25(first).length}</p>
      <div class="abgabe-action-row"><button class="primary" onclick="setDiscordAbgabeStatusV25('abgegeben')">Abgegeben</button><button onclick="setDiscordAbgabeStatusV25('entschuldigt')">Entschuldigt</button><button onclick="setDiscordAbgabeStatusV25('zusatz')">Zusatz</button><button class="danger-btn" onclick="setDiscordAbgabeStatusV25('zuspaet')">Zu spät</button><button onclick="setDiscordAbgabeStatusV25('delete')">Löschen</button></div>
    </section>`;
  }
  function abgabeCurrentWeekListV25(category){
    const cat = category || document.getElementById('discord_abgabe_cat_v25')?.value || abgabeTypeListV25()[0]?.key || '';
    const week=currentIsoWeekV25();
    const members=eligibleMembersV25(cat);
    if(!cat) return '<p class="muted">Keine aktive Abgabeart gefunden.</p>';
    if(!members.length) return '<p class="muted">Keine Mitglieder für diese Teilnehmer-Rolle gefunden.</p>';
    const rows=members.map(m=>{ const id=memberIdV25(m); const s=abgabeStatusForV25(cat,week,id); return [userCell(id), `<span class="pill ${s.cls==='good'?'good':s.cls==='warn'?'warn':'bad'}">${H(s.label)}</span>`, H(week), s.raw?.updatedAt ? dt(s.raw.updatedAt) : '—']; });
    return simpleTable(['Mitglied','Status','Woche','Update'], rows);
  }
  window.setDiscordAbgabeStatusV25 = async function(status){
    const category=document.getElementById('discord_abgabe_cat_v25')?.value;
    const userId=document.getElementById('discord_abgabe_user_v25')?.value;
    if(!category || !userId) return toast('Bitte Abgabeart und Person auswählen.');
    const weekKey = status==='zuspaet' ? previousIsoWeekV25(currentIsoWeekV25()) : currentIsoWeekV25();
    const patch = status==='delete' ? {status:'gelöscht', note:'gelöscht über Web-Panel'} : {status, note:'Web-Panel'};
    await api('/api/abgaben/update',{method:'POST',body:JSON.stringify({weekKey,category,userId,patch})});
    await refresh(true);
    toast(status==='delete' ? 'Eintrag gelöscht' : `${displayNameForUser(userId)} als ${status} eingetragen`);
  };

  abgaben = function(){
    const rows = typeof collectAbgabeRows==='function' ? collectAbgabeRows() : [];
    const currentWeek=currentIsoWeekV25();
    const types=abgabeTypeListV25();
    const currentCat=document.getElementById('discord_abgabe_cat_v25')?.value || types[0]?.key || '';
    const weekRows = rows.filter(r=>String(r._weekKey||r.weekKey||r.week)===currentWeek);
    return `${can('abgabenWrite') ? abgabeActionPanelV25() : ''}
      <section class="panel abgabe-week-panel"><div class="abgabe-clean-head"><div><h2>Aktuelle Woche</h2><p class="muted">Hier siehst du direkt, wer für die ausgewählte Abgabeart schon eingetragen ist und wer noch offen ist.</p></div><span class="pill gold">${H(currentWeek)}</span></div><div id="abgabe_current_week_list_v25">${abgabeCurrentWeekListV25(currentCat)}</div></section>
      <section class="panel"><h2>Letzte Abgabe-Einträge</h2>${weekRows.length ? simpleTable(['Name','Art','Status','Update'], weekRows.slice(-60).reverse().map(r=>[userCell(r._userId||r.userId), H(niceKey(r.category||r.type||r.art||'')), `<span class="pill">${H(r.status||'offen')}</span>`, r.updatedAt?dt(r.updatedAt):'—'])) : '<p class="muted">Für die aktuelle Woche gibt es noch keine Einträge.</p>'}</section>`;
  };

  // Lager: eine einzige Anzeige-Logik für oben und unten + Lang/Kurz-Felder stabilisieren.
  function invV25(uid){ return (DATA?.inventory?.items||{})[String(uid||DATA?.me?.id||'')] || {}; }
  function intV25(v){ return Math.max(0, Number(v||0)); }
  function longAmmoV25(i){ return intV25(i.langwaffenMunition ?? i.munitionLang ?? i.longAmmo ?? i.langMunition ?? 0); }
  function shortAmmoV25(i){ return intV25(i.kurzwaffenMunition ?? i.munitionKurz ?? i.shortAmmo ?? i.kurzMunition ?? i.munition ?? 0); }
  function weaponChipsV25(obj){ const entries=Object.entries(obj?.weapons||obj?.waffen||{}).filter(([_,v])=>Number(v)>0); return entries.length?entries.map(([k,v])=>`<span class="item-chip"><b>${H(k)}</b>${H(v)}</span>`).join(''):'<span class="muted">Keine Waffen</span>'; }
  function inventorySummaryV25(uid){ const i=invV25(uid); return `<div class="inventory-summary-clean"><div class="summary-box wide"><span>Waffen</span><div class="chip-cloud">${weaponChipsV25(i)}</div></div><div class="summary-box"><span>Westen</span><strong>Leicht ${H(i.leichteWesten||0)}</strong><strong>Schwer ${H(i.schwereWesten||i.westen||0)}</strong></div><div class="summary-box"><span>Munition</span><strong>Lang ${H(longAmmoV25(i))}</strong><strong>Kurz ${H(shortAmmoV25(i))}</strong></div></div>`; }
  const oldSaveQuickV25 = window.saveInventoryQuickV11;
  window.saveInventoryQuickV11 = async function(uid){
    uid=String(uid||DATA?.me?.id||'');
    const form=document.getElementById('lagerQuickForm');
    if(!form) return oldSaveQuickV25 ? oldSaveQuickV25(uid) : null;
    const fd=new FormData(form);
    const type=String(fd.get('type')||'');
    const mode=String(fd.get('mode')||'add');
    const qty=Math.max(1,Number(fd.get('qty')||1));
    const cur=JSON.parse(JSON.stringify(invV25(uid)||{}));
    cur.weapons ||= {};
    const delta=mode==='remove'?-qty:qty;
    if(type==='weapon'){
      const w=String(fd.get('customWeaponName')||fd.get('weaponName')||'').trim(); if(!w) return toast('Bitte Waffe auswählen.');
      cur.weapons[w]=Math.max(0, intV25(cur.weapons[w])+delta);
    } else if(type==='schwereWesten') cur.schwereWesten=Math.max(0,intV25(cur.schwereWesten||cur.westen)+delta);
    else if(type==='leichteWesten') cur.leichteWesten=Math.max(0,intV25(cur.leichteWesten)+delta);
    else if(type==='langwaffenMunition') cur.langwaffenMunition=cur.munitionLang=cur.longAmmo=Math.max(0,longAmmoV25(cur)+delta);
    else if(type==='kurzwaffenMunition') cur.kurzwaffenMunition=cur.munitionKurz=cur.shortAmmo=cur.munition=Math.max(0,shortAmmoV25(cur)+delta);
    await api('/api/inventory/'+encodeURIComponent(uid),{method:'POST',body:JSON.stringify({patch:cur})});
    await refresh(true); toast('Lager aktualisiert');
  };
  const oldInventoryV25 = inventory;
  inventory = function(){
    const me=String(DATA?.me?.id||'');
    const canAll=!!(DATA?.me?.permissions?.actions?.inventoryWriteAny || DATA?.me?.permissions?.roleGroups?.isLeadership || DATA?.me?.permissions?.roleGroups?.isAdminUser);
    const rows=Object.entries(DATA?.inventory?.items||{}).filter(([uid])=>canAll||String(uid)===me).map(([uid,i])=>[userCell(uid), `<div class="chip-cloud compact">${weaponChipsV25(i)}</div>`, `Leicht ${H(i.leichteWesten||0)} · Schwer ${H(i.schwereWesten||i.westen||0)}`, `Lang ${H(longAmmoV25(i))} · Kurz ${H(shortAmmoV25(i))}`, `<button onclick="openInventoryModal('${H(uid)}')">Bearbeiten</button>`]);
    const weapons = (typeof allWeaponsClean==='function'?allWeaponsClean():['SMG','Kampf PDW','Karabiner','Gusenberg','Pistole','50er']).map(w=>`<option value="${H(w)}">${H(w)}</option>`).join('');
    return `<div class="clean-inventory-page"><div class="clean-page-title"><h2>Lager</h2><p class="muted">Bestand und Schnelländerung sind jetzt dieselbe Datenquelle.</p></div><div class="inventory-clean-grid"><section class="panel clean-panel"><h3>Mein Lager</h3><p class="muted">${H(displayNameForUser(me))}</p>${inventorySummaryV25(me)}<button onclick="openInventoryModal('${H(me)}')">Komplett bearbeiten</button></section><section class="panel clean-panel"><h3>Schnell ändern</h3><form id="lagerQuickForm" class="clean-form" onsubmit="event.preventDefault();saveInventoryQuickV11('${H(me)}')"><label>Aktion<select name="mode"><option value="add">Hinzufügen</option><option value="remove">Entfernen</option></select></label><label>Kategorie<select name="type"><option value="weapon">Waffe</option><option value="schwereWesten">Schwere Westen</option><option value="leichteWesten">Leichte Westen</option><option value="langwaffenMunition">Langwaffen Munition</option><option value="kurzwaffenMunition">Kurzwaffen Munition</option></select></label><label>Waffe<select name="weaponName">${weapons}</select></label><label>Andere Waffe<input name="customWeaponName" placeholder="Nur wenn sie fehlt"></label><label>Menge<input name="qty" type="number" min="1" value="1"></label><button class="primary">Speichern</button></form></section></div><section class="panel clean-panel"><h3>${canAll?'Lager aller Mitglieder':'Mein Lager'}</h3>${simpleTable(['Name','Waffen','Westen','Munition','Aktion'], rows)}</section></div>`;
  };

  // Systemsteuerung als Schalter-Liste statt großer Checkbox-Kästen.
  const settingTitlesV25 = {smartPingEnabled:'Intelligente Ping-Erkennung',autoSanctionsEnabled:'Automatische Sanktionen',termRemindersEnabled:'Termin-Erinnerungen',decisionHintsEnabled:'Entscheidungs-Hinweise',leaderDmRemindersEnabled:'Leader-DM-Erinnerungen',fridayReportEnabled:'Freitagsbericht: fehlende Abgaben',mondayReportEnabled:'Montagsbericht: überfällige Abgaben',wacheFridayReportEnabled:'Wache-Freitagsbericht',wacheMondayReportEnabled:'Wache-Montagsbericht',dashboardAbgabenEnabled:'Dashboard-Abgaben aktiv',reportsEnabled:'Reports aktiv',dryRun:'Testmodus / Dry Run',systemLogsEnabled:'System-Logs aktiv',spamProtectionEnabled:'Spam-Schutz'};
  const settingDescV25 = {smartPingEnabled:'Erkennt wichtige Erwähnungen und vermeidet unnötige Pings.',autoSanctionsEnabled:'Prüft Sanktionen automatisch nach Regelwerk.',termRemindersEnabled:'Sendet Erinnerungen für geplante Termine.',decisionHintsEnabled:'Gibt Hinweise bei offenen Entscheidungen.',leaderDmRemindersEnabled:'Schickt Leadern private Erinnerungen.',reportsEnabled:'Schaltet automatische Berichte gesammelt ein oder aus.',dryRun:'Testet Abläufe ohne echte Änderungen oder Posts.'};
  niceSettingCard = function(k,set){
    const title=settingTitlesV25[k] || String(k).replace(/([A-Z])/g,' $1').replace(/^./,m=>m.toUpperCase());
    const desc=settingDescV25[k] || '';
    return `<label class="setting-switch-row"><span><b>${H(title)}</b>${desc?`<small>${H(desc)}</small>`:''}</span><input id="set_${H(k)}" type="checkbox" ${set[k]?'checked':''}><i></i></label>`;
  };
})();


/* ===== V26: Clean bars, live wache, reports, approvals ===== */
(function(){
  const H = typeof esc==='function' ? esc : (v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])));
  function weekKeyNow(){ return typeof currentIsoWeekV25==='function' ? currentIsoWeekV25() : new Date().toISOString().slice(0,10); }
  function settingNum(...keys){ const s=DATA?.config?.settings||{}; for(const k of keys){ if(s[k]!=null && s[k]!=='' && !Number.isNaN(Number(s[k]))) return Number(s[k]); } return 0; }
  function excusedDaysText(){ const d=settingNum('abgabeExcusedAfterDays','absenceExcusedDays','excusedAfterDays'); return d>0?`Ab ${d} Abmeldetag${d===1?'':'en'} entschuldigt.`:'Entschuldigt-Regel noch nicht gesetzt.'; }
  function wacheExcusedText(){ const d=settingNum('wacheExcusedAfterDays','absenceExcusedDays','excusedAfterDays'); return d>0?`Ab ${d} Abmeldetag${d===1?'':'en'} entschuldigt.`:'Entschuldigt-Regel noch nicht gesetzt.'; }
  function patchTopBars(){
    document.querySelectorAll('.central-subactions,.central-tabs,.sub-actions,.toolbar').forEach(el=>el.classList.add('v26-sticky-actions'));
  }
  const oldRenderCurrentV26 = window.renderCurrent;
  if(typeof oldRenderCurrentV26==='function') window.renderCurrent = function(){ const r=oldRenderCurrentV26.apply(this,arguments); setTimeout(patchTopBars,0); return r; };

  // Systemsteuerung: Schalter statt große Kästchen bleibt, aber kompaktere Zeilen.
  const oldNiceSettingCardV26 = window.niceSettingCard;
  window.niceSettingCard = function(k,set){
    const title=(typeof settingTitlesV25!=='undefined'&&settingTitlesV25[k]) || (typeof humanSettingName==='function'?humanSettingName(k):String(k));
    const desc=(typeof settingDescV25!=='undefined'&&settingDescV25[k]) || (typeof humanSettingDesc==='function'?humanSettingDesc(k):'');
    return `<label class="v26-switch-line"><span><b>${H(title)}</b>${desc?`<small>${H(desc)}</small>`:''}</span><input id="set_${H(k)}" type="checkbox" ${set[k]?'checked':''}><i></i></label>`;
  };

  // Abgaben: Wochenauswahl weg, Entschuldigt-Regel anzeigen, Liste immer aktuell.
  function abgabeTypesV26(){ return typeof abgabeTypeListV25==='function' ? abgabeTypeListV25() : Object.entries(DATA?.config?.abgabeTypes||{}).map(([key,t])=>({key,...t})); }
  function abgabePanelV26(){
    const types=abgabeTypesV26(); const first=types[0]?.key || ''; const opts=types.map(t=>`<option value="${H(t.key)}">${H(t.label||niceKey?.(t.key)||t.key)}</option>`).join(''); const cw=weekKeyNow();
    const members = (typeof memberOptionsV25==='function') ? memberOptionsV25(first) : '';
    const roleHint = (typeof selectedRolesForTypeV25==='function' && typeof typeByKeyV25==='function' && typeof roleNamesV25==='function') ? roleNamesV25(selectedRolesForTypeV25(typeByKeyV25(first))) : 'Alle Mitglieder';
    const count = typeof eligibleMembersV25==='function' ? eligibleMembersV25(first).length : 0;
    return `<section class="panel v26-abgabe-panel"><div class="v26-panel-head"><div><h2>Abgabe eintragen</h2><p class="muted">Aktuelle Woche: <b>${H(cw)}</b>. „Zu spät“ wird automatisch für die Vorwoche eingetragen. ${H(excusedDaysText())}</p></div></div>
      <div class="v26-form-row"><label>Abgabeart<select id="discord_abgabe_cat_v25" onchange="updateAbgabeHintV25&&updateAbgabeHintV25()">${opts}</select></label><label>Person<select id="discord_abgabe_user_v25">${members}</select></label></div>
      <p id="abgabe_role_hint_v25" class="muted">Teilnehmer-Rolle: ${H(roleHint)} · auswählbare Personen: ${count}</p>
      <div class="v26-action-pills"><button class="primary" onclick="setDiscordAbgabeStatusV25('abgegeben')">Abgegeben</button><button onclick="setDiscordAbgabeStatusV25('entschuldigt')">Entschuldigt</button><button onclick="setDiscordAbgabeStatusV25('zusatz')">Zusatz</button><button class="danger-btn" onclick="setDiscordAbgabeStatusV25('zuspaet')">Zu spät</button><button onclick="setDiscordAbgabeStatusV25('delete')">Löschen</button></div>
    </section>`;
  }
  const oldAbgabenV26 = window.abgaben || abgaben;
  window.abgaben = abgaben = function(){
    const types=abgabeTypesV26(); const cat=document.getElementById('discord_abgabe_cat_v25')?.value || types[0]?.key || ''; const current=weekKeyNow();
    const list = typeof abgabeCurrentWeekListV25==='function' ? abgabeCurrentWeekListV25(cat) : '<p class="muted">Keine Daten.</p>';
    return `${(typeof can==='function'?can('abgabenWrite'):true) ? abgabePanelV26() : ''}<section class="panel v26-week-list"><div class="v26-panel-head"><div><h2>Aktuelle Wochenliste</h2><p class="muted">Direkt nach dem Eintragen aktualisiert sich diese Liste.</p></div><span class="pill gold">${H(current)}</span></div><div id="abgabe_current_week_list_v25">${list}</div></section>`;
  };

  const oldSetAbgabeV26 = window.setDiscordAbgabeStatusV25;
  if(typeof oldSetAbgabeV26==='function') window.setDiscordAbgabeStatusV25 = async function(status){ await oldSetAbgabeV26(status); setTimeout(()=>{ try{ const cat=document.getElementById('discord_abgabe_cat_v25')?.value; const el=document.getElementById('abgabe_current_week_list_v25'); if(el && typeof abgabeCurrentWeekListV25==='function') el.innerHTML=abgabeCurrentWeekListV25(cat); }catch(e){} },50); };

  // Wache live: starten/beenden + aktive Wachen anzeigen. Dazu Einstellung für entschuldigt ab Tage.
  function activeWacheRowsV26(){
    const active=DATA?.wache?.active||{}; const rows=Object.values(active).map(x=>[userCell(x.userId), x.startTs?dt(x.startTs):'—', x.source||'web']);
    return rows.length ? simpleTable(['Person','Seit','Quelle'], rows) : '<p class="muted">Gerade ist keine aktive Wache gestartet.</p>';
  }
  window.startWacheWebV26 = async function(uid){ await api('/api/wache/start',{method:'POST',body:JSON.stringify({userId:uid||DATA?.me?.id})}); await refresh(true); toast('Wache gestartet'); };
  window.endWacheWebV26 = async function(uid){ await api('/api/wache/end',{method:'POST',body:JSON.stringify({userId:uid||DATA?.me?.id})}); await refresh(true); toast('Wache beendet'); };
  function wacheLiveV26(){
    const myId=DATA?.me?.id; const isActive=!!DATA?.wache?.active?.[myId];
    return `<section class="panel v26-live-wache"><div class="v26-panel-head"><div><h2>Live-Wache</h2><p class="muted">Wie im Discord: Wache direkt im Web starten und beenden. ${H(wacheExcusedText())}</p></div><span class="pill ${isActive?'good':'bad'}">${isActive?'läuft':'inaktiv'}</span></div><div class="v26-action-pills"><button class="primary" onclick="startWacheWebV26()">Wache starten</button><button onclick="endWacheWebV26()">Wache beenden</button></div><h3>Aktive Wachen</h3>${activeWacheRowsV26()}</section>`;
  }
  const oldWacheCentralV26 = window.wacheCentral;
  window.wacheCentral = function(){
    const set=DATA?.config?.settings||{}; const manage=typeof canManageWache==='function'?canManageWache():true;
    const cfg=`<section class="panel"><h2>Wache-Regeln</h2><p class="muted">${H(wacheExcusedText())}</p><div class="v26-form-row"><label>Wache aktiv<select id="rule_wacheEnabled" ${manage?'':'disabled'}><option value="true" ${set.wacheEnabled!==false?'selected':''}>Ein</option><option value="false" ${set.wacheEnabled===false?'selected':''}>Aus</option></select></label><label>Pflichtzeit pro Woche<input id="rule_wacheMinutes" type="number" value="${H(set.wacheRequiredMinutes||set.routeRequiredMinutes||0)}" ${manage?'':'disabled'}></label><label>Entschuldigt ab Tagen<input id="rule_wacheExcusedDays" type="number" value="${H(settingNum('wacheExcusedAfterDays','absenceExcusedDays','excusedAfterDays'))}" ${manage?'':'disabled'}></label></div>${manage?'<button class="primary" onclick="saveWacheRulesOnlyV26()">Wache-Regeln speichern</button>':'<p class="muted">Keine Berechtigung.</p>'}</section>`;
    return wacheLiveV26()+cfg+`<section class="panel">${typeof wache==='function'?wache():''}</section>`;
  };
  window.saveWacheRulesOnlyV26 = async function(){
    const body={wacheEnabled:document.getElementById('rule_wacheEnabled')?.value==='true',wacheRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),routeRequiredMinutes:Number(document.getElementById('rule_wacheMinutes')?.value||0),wacheExcusedAfterDays:Number(document.getElementById('rule_wacheExcusedDays')?.value||0)};
    await api('/api/config/settings',{method:'POST',body:JSON.stringify(body)}); await refresh(true); toast('Wache-Regeln gespeichert');
  };

  // Berichte für Kasse/Lager.
  function currentMonthV26(){ return new Date().toISOString().slice(0,7); }
  window.loadMonthlyReportV26 = async function(){
    const m=document.getElementById('report_month_v26')?.value || currentMonthV26();
    const r=await api('/api/reports/monthly?month='+encodeURIComponent(m));
    const tx=(r.cash?.transactions||[]).map(x=>[x.createdAt?dt(x.createdAt):'—', H(x.type||''), H(x.category||''), H(x.amount||0), H(x.customReason||x.note||'')]);
    const inv=(r.inventory?.familyHistory||[]).concat(r.inventory?.userHistory||[]).map(x=>[x.at?dt(x.at):'—', H(x.action||''), x.userId?userCell(x.userId):'Familienlager', H(x.itemName||x.itemType||''), H(x.quantity||'')]);
    const html=`<div class="v26-report-grid"><div class="summary-box"><span>Einnahmen</span><strong>${H(r.cash?.income||0)} $</strong></div><div class="summary-box"><span>Ausgaben</span><strong>${H(r.cash?.expense||0)} $</strong></div><div class="summary-box"><span>Netto</span><strong>${H(r.cash?.net||0)} $</strong></div></div><h3>Kassen-Transaktionen</h3>${tx.length?simpleTable(['Datum','Typ','Kategorie','Betrag','Grund'],tx):'<p class="muted">Keine Kassen-Transaktionen.</p>'}<h3>Lager-Bewegungen</h3>${inv.length?simpleTable(['Datum','Aktion','Person','Item','Menge'],inv):'<p class="muted">Keine Lager-Bewegungen.</p>'}`;
    const out=document.getElementById('monthly_report_result_v26'); if(out) out.innerHTML=html;
  };
  const oldCashboxV26 = window.cashbox || cashbox;
  window.cashbox = cashbox = function(){
    const base = oldCashboxV26 ? oldCashboxV26() : '';
    return `<section class="panel v26-reports"><div class="v26-panel-head"><div><h2>Berichte</h2><p class="muted">Monatsbericht für Kasse, Lager-Bewegungen und Waren Ein-/Ausgang.</p></div></div><div class="v26-form-row"><label>Monat<input id="report_month_v26" type="month" value="${H(currentMonthV26())}"></label><button class="primary" onclick="loadMonthlyReportV26()">Bericht laden</button></div><div id="monthly_report_result_v26"></div></section>${base}`;
  };

  // Freigaben für Sanktionen.
  function approvalItemsV26(){ return (DATA?.sanctions?.items||[]).filter(x=>{ const st=String(x.status||'').toLowerCase(); if(x.paid||['bezahlt','gelöscht','geloescht','storniert','abgelehnt','rejected','approved','freigegeben'].includes(st)) return false; return x.needsApproval===true || x.approvalStatus==='pending' || ['auto','abgabe_auto','term_auto'].includes(String(x.source||'').toLowerCase()) || !x.approvalStatus; }); }
  window.sanctionApprovalActionV26 = async function(action,id){ const ids=id?[id]:approvalItemsV26().map(x=>x.id); if(!ids.length) return toast('Keine offenen Freigaben.'); await api('/api/sanctions/approvals',{method:'POST',body:JSON.stringify({action,ids})}); await refresh(true); toast(action==='approve'?'Freigabe akzeptiert':'Freigabe abgelehnt'); };
  function approvalsPanelV26(){
    const items=approvalItemsV26();
    const rows=items.map(x=>[userCell(x.userId), H(x.catalogLabel||x.extraReason||x.reason||'Sanktion'), H(x.penaltyType||''), H(x.amount||0), `<button class="primary" onclick="sanctionApprovalActionV26('approve','${H(x.id)}')">Ausstellen</button> <button class="danger-btn" onclick="sanctionApprovalActionV26('reject','${H(x.id)}')">Ablehnen</button>`]);
    return `<section class="panel"><div class="v26-panel-head"><div><h2>Sanktions-Freigaben</h2><p class="muted">Nur Leaderschaft sieht diese Freigaben. Du kannst einzeln oder gesammelt entscheiden.</p></div><span class="pill gold">${items.length} offen</span></div><div class="v26-action-pills"><button class="primary" onclick="sanctionApprovalActionV26('approve')">Alle akzeptieren</button><button class="danger-btn" onclick="sanctionApprovalActionV26('reject')">Alle ablehnen</button></div>${rows.length?simpleTable(['Person','Grund','Art','Betrag','Aktion'],rows):'<p class="muted">Keine offenen Sanktions-Freigaben.</p>'}</section>`;
  }

  // Central tabs: Subleisten immer sichtbar + Freigaben/Live-Wache ergänzen.
  const oldOpenCentralSectionV26 = window.openCentralSection;
  window.openCentralSection = function(tab,section){ if(oldOpenCentralSectionV26) return oldOpenCentralSectionV26(tab,section); window.centralTab=tab; window.centralSection=section; renderCurrent(); };
  const oldCentralPageV26 = window.centralPage;
  window.centralPage = function(){
    let html = oldCentralPageV26 ? oldCentralPageV26() : '';
    if(window.centralTab==='leader'){
      html=html.replace("openCentralSection(\'leader\',\'wache\')\">Wache", "openCentralSection(\'leader\',\'wacheLive\')\">Live-Wache</button><button onclick=\"openCentralSection(\'leader\',\'wache\')\">Wache");
      html=html.replace("openCentralSection(\'leader\',\'sanctions\')\">Sanktionen & Freigaben", "openCentralSection(\'leader\',\'sanctions\')\">Sanktionen</button><button onclick=\"openCentralSection(\'leader\',\'approvals\')\">Freigaben");
      if(window.centralSection==='wacheLive') html = html.replace(/<section class="panel[\s\S]*?<\/section>\s*$/m, wacheLiveV26());
      if(window.centralSection==='approvals') html = html.replace(/<section class="panel[\s\S]*?<\/section>\s*$/m, approvalsPanelV26());
    }
    setTimeout(patchTopBars,0); return html;
  };

  // Wenn centralPage-Replacement zu grob ist, fange sections nach Render ab.
  document.addEventListener('click', e=>{ const t=e.target; if(t && t.matches && t.matches('button')) setTimeout(patchTopBars,0); }, true);
})();


/* ===== V27: saubere Kasse, Reset-Zentrale, Kurz/Lang-Munition ===== */
(function(){
  const H = typeof esc==='function' ? esc : (v)=>String(v??'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const num = v => Math.max(0, Number(v||0));
  const cashItemGroups = {
    income: [
      ['munition_verkauf','Munition Verkauf'], ['waffen_verkauf','Waffen Verkauf'], ['westen_verkauf','Westen Verkauf'], ['sonstiges','Sonstiges']
    ],
    expense: [
      ['waffen_kauf','Waffen Kauf'], ['munition_kauf','Munitions Kauf'], ['westen_kauf','Westen Kauf'], ['routen_einkauf','Routen Einkauf'], ['sonstiges','Sonstiges']
    ]
  };
  const cashItems = {
    munition_verkauf: [['langwaffen_munition','Langwaffen Munition'], ['kurzwaffen_munition','Kurzwaffen Munition'], ['sonstiges','Sonstige Munition']],
    munition_kauf: [['langwaffen_munition','Langwaffen Munition'], ['kurzwaffen_munition','Kurzwaffen Munition'], ['sonstiges','Sonstige Munition']],
    waffen_verkauf: [['waffe','Waffe'], ['karabiner','Karabiner'], ['smg','SMG'], ['pistole','Pistole'], ['sonstiges','Sonstiges']],
    waffen_kauf: [['waffe','Waffe'], ['karabiner','Karabiner'], ['smg','SMG'], ['pistole','Pistole'], ['sonstiges','Sonstiges']],
    westen_verkauf: [['leichte_weste','Leichte Weste'], ['schwere_weste','Schwere Weste']],
    westen_kauf: [['leichte_weste','Leichte Weste'], ['schwere_weste','Schwere Weste']],
    routen_einkauf: [['routen','Routen']],
    sonstiges: [['sonstiges','Sonstiges']]
  };
  function opts(list, sel=''){ return (list||[]).map(([v,l])=>`<option value="${H(v)}" ${String(v)===String(sel)?'selected':''}>${H(l)}</option>`).join(''); }
  window.updateCashCategoryV27 = function(){
    const type=document.getElementById('cash_type_v27')?.value || 'income';
    const cat=document.getElementById('cash_category_v27');
    if(cat) cat.innerHTML = opts(cashItemGroups[type]||cashItemGroups.income, cat.value);
    updateCashItemV27();
  };
  window.updateCashItemV27 = function(){
    const cat=document.getElementById('cash_category_v27')?.value || 'sonstiges';
    const item=document.getElementById('cash_item_v27');
    if(item) item.innerHTML = opts(cashItems[cat]||cashItems.sonstiges, item.value);
  };
  window.calcCashAmountV27 = function(){
    const q=num(document.getElementById('cash_qty_v27')?.value);
    const p=num(document.getElementById('cash_price_v27')?.value);
    const amount=document.getElementById('cash_amount_v27');
    if(amount && q && p) amount.value = String(Math.round(q*p));
  };
  window.openCashModal = function(){
    if(typeof can==='function' && !can('cashboxWrite')) return toast('Keine Berechtigung.');
    const modal = `<h2>Kasseneintrag</h2><p class="muted">Wähle Einnahme/Ausgabe, was gekauft/verkauft wurde und trage Menge sowie Preis ein. Bei Munition sind Kurz- und Langwaffen-Munition getrennt.</p><form id="cashFormV27" class="form-grid v27-cash-form">
      <label>Typ<select id="cash_type_v27" name="type" onchange="updateCashCategoryV27()"><option value="income">Einnahme</option><option value="expense">Ausgabe</option></select></label>
      <label>Kategorie<select id="cash_category_v27" name="category" onchange="updateCashItemV27()"></select></label>
      <label>Was genau?<select id="cash_item_v27" name="itemType"></select></label>
      <label>Menge / Schüsse<input id="cash_qty_v27" name="quantity" type="number" min="0" step="1" value="1" oninput="calcCashAmountV27()"></label>
      <label>Preis pro Stück<input id="cash_price_v27" name="unitPrice" type="number" min="0" step="1" value="0" oninput="calcCashAmountV27()"></label>
      <label>Gesamtbetrag<input id="cash_amount_v27" name="amount" type="number" min="0" step="1" required></label>
      <label class="full">Notiz<textarea name="note" placeholder="Optional: wer/warum/wofür"></textarea></label>
      <button class="primary full">Speichern</button>
    </form>`;
    openModal(modal); updateCashCategoryV27(); calcCashAmountV27();
    document.getElementById('cashFormV27').onsubmit = async e=>{
      e.preventDefault(); const fd=new FormData(e.target); const type=fd.get('type'); const cat=fd.get('category'); const item=fd.get('itemType');
      const catLabel=(cashItemGroups[type]||[]).find(x=>x[0]===cat)?.[1] || cat;
      const itemLabel=(cashItems[cat]||[]).find(x=>x[0]===item)?.[1] || item;
      await api('/api/cash/transactions',{method:'POST',body:JSON.stringify({
        type, category:catLabel, itemType:item, itemName:itemLabel, quantity:Number(fd.get('quantity')||0), unitPrice:Number(fd.get('unitPrice')||0), amount:Number(fd.get('amount')||0), customReason:catLabel, note:fd.get('note')||''
      })});
      closeModal(); await refresh(true); toast('Kasse aktualisiert');
    };
  };

  function txRowsV27(tx){ return tx.map(t=>[dt(t.createdAt||t.at), t.type==='expense'?'<span class="pill bad">Ausgabe</span>':'<span class="pill good">Einnahme</span>', H(t.category||'—'), H(t.itemName||t.itemType||'—'), H(t.quantity||'—'), t.unitPrice?money(t.unitPrice):'—', money(t.amount||0), H(t.note||t.customReason||'')]); }
  const oldCashboxV27 = window.cashbox || cashbox;
  window.cashbox = cashbox = function(){
    if(!DATA.cashbox) return locked();
    const tx=filterRows(DATA.cashbox?.transactions||[],[x=>`${x.id} ${x.category} ${x.itemName} ${x.itemType} ${x.customReason} ${x.note} ${x.createdBy}`]);
    const balance=DATA.cashbox?.balance||0;
    const report = `<section class="panel v26-reports"><div class="v26-panel-head"><div><h2>Berichte</h2><p class="muted">Monatsbericht für Kasse, Lager-Bewegungen und Waren Ein-/Ausgang.</p></div></div><div class="v26-form-row"><label>Monat<input id="report_month_v26" type="month" value="${new Date().toISOString().slice(0,7)}"></label><button class="primary" onclick="loadMonthlyReportV26&&loadMonthlyReportV26()">Bericht laden</button></div><div id="monthly_report_result_v26"></div></section>`;
    return `${report}${cards({'Kassenstand':money(balance),'Transaktionen':tx.length})}<div class="section-actions"><span></span>${(typeof can==='function'&&can('cashboxWrite'))?'<button class="primary" onclick="openCashModal()">+ Transaktion</button>':''}</div><div class="panel"><h2>Transaktionen</h2>${tx.length?simpleTable(['Datum','Typ','Kategorie','Artikel','Menge','Preis','Betrag','Notiz'], txRowsV27(tx)):'<p class="muted">Keine Transaktionen vorhanden.</p>'}</div>`;
  };

  window.openResetCenterV27 = function(){
    if(typeof isAdmin==='function' && !isAdmin()) return toast('Nur Admins dürfen Daten zurücksetzen.');
    const items=[['wache','Wachestatistik'],['abgaben','Abgabenstatistik'],['sanctions','Sanktionen'],['absences','Abmeldungen'],['inventory','Lager'],['cashbox','Familienkasse'],['trading','Rechner/Ausleihe'],['blood','Bloodin/Bloodout']];
    openModal(`<h2>Zurücksetzen</h2><p class="muted">Setzt ausgewählte Bereiche auf 0/leer. Einstellungen, Rollen und Layout bleiben erhalten. Vorher werden automatisch Backups im data/backups-Ordner geschrieben.</p><form id="resetFormV27" class="reset-list-v27">${items.map(([k,l])=>`<label><input type="checkbox" name="target" value="${H(k)}"> ${H(l)}</label>`).join('')}<button class="danger-btn full">Ausgewählte Bereiche zurücksetzen</button></form>`);
    document.getElementById('resetFormV27').onsubmit=async e=>{e.preventDefault(); const targets=[...e.target.querySelectorAll('input[name="target"]:checked')].map(x=>x.value); if(!targets.length) return toast('Nichts ausgewählt.'); if(!confirm('Wirklich zurücksetzen? Diese Daten werden geleert.')) return; await api('/api/admin/reset-data',{method:'POST',body:JSON.stringify({targets})}); closeModal(); await refresh(true); toast('Zurückgesetzt');};
  };
  // Reset-Zentrale wird bewusst NICHT global in die Zentrale Verwaltung injiziert.
  // Sie ist ausschließlich im Admin Panel erreichbar.
})();


/* ===== V32: Statistik-/Berichts-Steuerung im Web ===== */
(function(){
  const H = typeof esc==='function' ? esc : (v)=>String(v??'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const pad2 = n => String(Math.max(0, Number(n||0))).padStart(2,'0');
  function settings(){ return DATA?.config?.settings || {}; }
  function reportSettings(){
    const s=settings(); const r=s.reportSettings||{};
    return {
      weeklyReportsEnabled: typeof r.weeklyReportsEnabled==='boolean'?r.weeklyReportsEnabled:(s.reportsEnabled!==false),
      monthlyReportsEnabled: typeof r.monthlyReportsEnabled==='boolean'?r.monthlyReportsEnabled:true,
      waitForLatestAbgabeDeadline: typeof r.waitForLatestAbgabeDeadline==='boolean'?r.waitForLatestAbgabeDeadline:true,
      abgabeShiftMode: r.abgabeShiftMode || ((r.waitForLatestAbgabeDeadline===false)?'split_due':'wait_latest'),
      weeklyReportHour: Number(r.weeklyReportHour ?? s.weeklyReportHour ?? 12),
      weeklyReportMinute: Number(r.weeklyReportMinute ?? s.weeklyReportMinute ?? 0),
      monthlyReportDay: Number(r.monthlyReportDay ?? s.monthlyReportDay ?? 1),
      monthlyReportHour: Number(r.monthlyReportHour ?? s.monthlyReportHour ?? 12),
      monthlyReportMinute: Number(r.monthlyReportMinute ?? s.monthlyReportMinute ?? 0)
    };
  }
  function switchLine(id,label,desc,checked){ return `<label class="v32-switch"><span><b>${H(label)}</b><small>${H(desc||'')}</small></span><input id="${H(id)}" type="checkbox" ${checked?'checked':''}><i></i></label>`; }
  function reportSettingsPanelV32(){
    const r=reportSettings(); const time=`${pad2(r.weeklyReportHour)}:${pad2(r.weeklyReportMinute)}`; const mtime=`${pad2(r.monthlyReportHour)}:${pad2(r.monthlyReportMinute)}`;
    return `<section class="panel v32-report-settings"><div class="v32-head"><div><h2>📊 Statistik & Berichte</h2><p class="muted">Steuert, ob Statistiken automatisch verschickt werden und wie verschobene Abgaben behandelt werden.</p></div></div>
      <div class="v32-settings-list">
        ${switchLine('v32_weekly_enabled','Wochenstatistik automatisch senden','Wenn aus, werden keine automatischen Abgabe-Wochenberichte gepostet.',r.weeklyReportsEnabled)}
        ${switchLine('v32_monthly_enabled','Monatsberichte automatisch senden','Kassen-/Lager-/Monatsberichte automatisch erstellen.',r.monthlyReportsEnabled)}
      </div>
      <div class="v32-card"><h3>Verschobene Abgaben</h3><p class="muted">Was soll passieren, wenn z. B. eine Abgabeart einmalig verschoben wurde?</p>
        <label class="v32-radio"><input type="radio" name="v32_shift_mode" value="wait_latest" ${r.abgabeShiftMode!=='split_due'?'checked':''}> <span><b>Auf späteste Abgabe warten</b><small>Eine gemeinsame Statistik erst senden, wenn alle aktiven/verschobenen Abgabearten fällig sind.</small></span></label>
        <label class="v32-radio"><input type="radio" name="v32_shift_mode" value="split_due" ${r.abgabeShiftMode==='split_due'?'checked':''}> <span><b>Nicht verschobene schon senden</b><small>Fällige Abgaben werden schon ausgewertet; verschobene Abgaben aktualisieren später im Hintergrund.</small></span></label>
      </div>
      <div class="v32-card v32-time-grid"><label>Uhrzeit Wochenstatistik<input id="v32_weekly_time" type="time" value="${H(time)}"></label><label>Monatsbericht am Tag<input id="v32_monthly_day" type="number" min="1" max="28" value="${H(r.monthlyReportDay)}"></label><label>Uhrzeit Monatsbericht<input id="v32_monthly_time" type="time" value="${H(mtime)}"></label></div>
      <button class="primary" onclick="saveReportSettingsV32()">Statistik-Einstellungen speichern</button>
    </section>`;
  }
  window.saveReportSettingsV32 = async function(){
    const [wh,wm]=(document.getElementById('v32_weekly_time')?.value||'12:00').split(':').map(Number);
    const [mh,mm]=(document.getElementById('v32_monthly_time')?.value||'12:00').split(':').map(Number);
    const mode=document.querySelector('input[name="v32_shift_mode"]:checked')?.value || 'wait_latest';
    const body={
      weeklyReportsEnabled:!!document.getElementById('v32_weekly_enabled')?.checked,
      monthlyReportsEnabled:!!document.getElementById('v32_monthly_enabled')?.checked,
      abgabeShiftMode:mode,
      waitForLatestAbgabeDeadline:mode!=='split_due',
      weeklyReportHour:Number.isFinite(wh)?wh:12,
      weeklyReportMinute:Number.isFinite(wm)?wm:0,
      monthlyReportDay:Number(document.getElementById('v32_monthly_day')?.value||1),
      monthlyReportHour:Number.isFinite(mh)?mh:12,
      monthlyReportMinute:Number.isFinite(mm)?mm:0
    };
    await api('/api/config/report-settings',{method:'POST',body:JSON.stringify(body)});
    await refresh(true);
    toast('Statistik-Einstellungen gespeichert');
  };

  const oldCentralV32 = window.centralPage;
  window.centralPage = function(){
    let html = oldCentralV32 ? oldCentralV32() : '';
    if(window.centralTab==='system'){
      // Button ergänzen, falls er noch nicht existiert.
      if(!html.includes("openCentralSection('system','reportSettings')")){
        html = html.replace(/(<button[^>]+openCentralSection\('system','statsConfig'\)[\s\S]*?<\/button>)/, `$1<button onclick="openCentralSection('system','reportSettings')">Berichte planen</button>`);
      }
      if(window.centralSection==='reportSettings'){
        // Inhalt ersetzen, Top-Buttons aber behalten.
        const firstPanel = html.search(/<section class="panel|<div class="panel/);
        if(firstPanel >= 0) html = html.slice(0, firstPanel) + reportSettingsPanelV32();
        else html += reportSettingsPanelV32();
      }
    }
    return html;
  };
})();

/* ===== V33: Familienkasse mit Familien-Lager, Artikel-Auswahl und saubere Admin-Aktionen ===== */
(function(){
  const H = (v)=>String(v??'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const N = (v)=>Number(v||0).toLocaleString('de-DE');
  function famInv(){ return DATA?.inventory?.family || {}; }
  function weaponChips(obj){
    const w=obj?.weapons||{}; const rows=Object.entries(w).filter(([,v])=>Number(v)>0);
    return rows.length ? rows.map(([k,v])=>`<span class="mini-chip">${H(k)} <b>${H(v)}</b></span>`).join('') : '<span class="muted">Keine Waffen</span>';
  }
  function familyInventoryBoxV33(){
    const f=famInv();
    const longAmmo=Number(f.langwaffenMunition ?? f.munitionLang ?? f.longAmmo ?? 0);
    const shortAmmo=Number(f.kurzwaffenMunition ?? f.munitionKurz ?? f.shortAmmo ?? f.munition ?? 0);
    return `<section class="panel v33-family-stock"><div class="v33-head-row"><div><h2>Familien-Lager</h2><p class="muted">Aktueller Bestand aus derselben Datenquelle wie Discord/Web-Lager.</p></div>${can('cashboxWrite')?'<button onclick="openFamilyInventoryModalV33()">Familien-Lager bearbeiten</button>':''}</div>
      <div class="v33-stock-grid">
        <div class="v33-stock-card"><span>Waffen</span><div class="chip-wrap">${weaponChips(f)}</div></div>
        <div class="v33-stock-card"><span>Westen</span><strong>Leicht ${N(f.leichteWesten||0)}</strong><strong>Schwer ${N(f.schwereWesten||f.westen||0)}</strong></div>
        <div class="v33-stock-card"><span>Munition</span><strong>Langwaffen ${N(longAmmo)}</strong><strong>Kurzwaffen ${N(shortAmmo)}</strong></div>
      </div></section>`;
  }
  function cashTxRowsV33(tx){
    return tx.map(t=>[
      typeof dt==='function'?dt(t.createdAt):new Date(t.createdAt||Date.now()).toLocaleString('de-DE'),
      t.type==='expense'?'<span class="pill bad">Ausgabe</span>':'<span class="pill good">Einnahme</span>',
      H(t.category||''),
      H(t.itemName||t.itemType||''),
      H(t.quantity||''),
      t.unitPrice?`${N(t.unitPrice)} $`:'—',
      typeof money==='function'?money(t.amount||0):`${N(t.amount||0)} $`,
      H(t.customReason||t.note||'')
    ]);
  }
  window.cashbox = function(){
    if(!DATA.cashbox) return typeof locked==='function'?locked():'<p>Keine Berechtigung.</p>';
    const tx=(DATA.cashbox?.transactions||[]).filter(t=>!t.undone);
    const balance=DATA.cashbox?.balance ?? DATA.stats?.cashBalance ?? 0;
    const report = `<section class="panel v26-reports"><div class="v26-panel-head"><div><h2>Berichte</h2><p class="muted">Monatsbericht für Kasse, Lager-Bewegungen und Waren Ein-/Ausgang.</p></div></div><div class="v26-form-row"><label>Monat<input id="report_month_v26" type="month" value="${new Date().toISOString().slice(0,7)}"></label><button class="primary" onclick="loadMonthlyReportV26&&loadMonthlyReportV26()">Bericht laden</button></div><div id="monthly_report_result_v26"></div></section>`;
    const action = can('cashboxWrite') ? '<button class="primary" onclick="openCashModal()">+ Transaktion</button>' : '';
    return `${report}${familyInventoryBoxV33()}${typeof cards==='function'?cards({'Kassenstand':money(balance),'Transaktionen':tx.length}):''}<div class="section-actions"><span></span>${action}</div><div class="panel"><h2>Transaktionen</h2>${tx.length?simpleTable(['Datum','Typ','Kategorie','Artikel','Menge','Preis','Betrag','Notiz'], cashTxRowsV33(tx)):'<p class="muted">Keine Transaktionen vorhanden.</p>'}</div>`;
  };
  const expenseCats=['Waffen Kauf','Kurzwaffen-Munition Kauf','Langwaffen-Munition Kauf','Leichte Westen Kauf','Schwere Westen Kauf','Routen Einkauf','Sonstiges'];
  const incomeCats=['Waffen Verkauf','Kurzwaffen-Munition Verkauf','Langwaffen-Munition Verkauf','Leichte Westen Verkauf','Schwere Westen Verkauf','Sonstiges'];
  const weapons=['Kampf PDW','Karabiner','Gusenberg','Pistole','Schwere Pistole','50er','SMG','Bullpup Rifle','Advanced Rifle','Pumpgun','Sawn-Off Shotgun','Spezialkarabiner','Sniper','Andere Waffe'];
  function catOptions(type){ return (type==='expense'?expenseCats:incomeCats).map(x=>`<option>${H(x)}</option>`).join(''); }
  function inferItemType(category){
    const c=String(category||'').toLowerCase();
    if(c.includes('kurzwaffen')) return 'kurzwaffenMunition';
    if(c.includes('langwaffen')) return 'langwaffenMunition';
    if(c.includes('leichte westen')) return 'leichteWeste';
    if(c.includes('schwere westen')) return 'schwereWeste';
    if(c.includes('waffen')) return 'weapon';
    return 'custom';
  }
  function updateCashArticleFields(){
    const type=document.getElementById('cash_type_v33')?.value||'income';
    const catSel=document.getElementById('cash_category_v33');
    if(catSel){ const old=catSel.value; catSel.innerHTML=catOptions(type); if([...catSel.options].some(o=>o.value===old)) catSel.value=old; }
    const cat=catSel?.value||''; const itemType=inferItemType(cat);
    const itemBox=document.getElementById('cash_item_box_v33');
    const custom=document.getElementById('cash_custom_item_v33');
    if(!itemBox) return;
    if(itemType==='weapon') itemBox.innerHTML=`<label>Waffe<select id="cash_item_v33">${weapons.map(w=>`<option>${H(w)}</option>`).join('')}</select></label>`;
    else if(itemType==='kurzwaffenMunition') itemBox.innerHTML='<label>Artikel<input id="cash_item_v33" value="Kurzwaffen-Munition"></label>';
    else if(itemType==='langwaffenMunition') itemBox.innerHTML='<label>Artikel<input id="cash_item_v33" value="Langwaffen-Munition"></label>';
    else if(itemType==='leichteWeste') itemBox.innerHTML='<label>Artikel<input id="cash_item_v33" value="Leichte Weste"></label>';
    else if(itemType==='schwereWeste') itemBox.innerHTML='<label>Artikel<input id="cash_item_v33" value="Schwere Weste"></label>';
    else itemBox.innerHTML='<label>Artikel<input id="cash_item_v33" placeholder="z. B. Reparatur, Fahrzeug, Sonstiges"></label>';
    if(custom) custom.style.display = itemType==='weapon' ? '' : 'none';
    updateCashTotalV33();
  }
  function updateCashTotalV33(){
    const q=Number(document.getElementById('cash_qty_v33')?.value||0);
    const p=Number(document.getElementById('cash_price_v33')?.value||0);
    const total=Math.max(0,q*p); const amount=document.getElementById('cash_amount_v33');
    if(amount && total>0) amount.value=String(total);
    const prev=document.getElementById('cash_total_preview_v33'); if(prev) prev.textContent=(typeof money==='function'?money(Number(amount?.value||total||0)):`${N(Number(amount?.value||total||0))} $`);
  }
  window.updateCashArticleFields = updateCashArticleFields;
  window.updateCashTotalV33 = updateCashTotalV33;
  window.openCashModal = function(){
    if(!can('cashboxWrite')) return toast('Keine Berechtigung.');
    openModal(`<h2>Kasseneintrag</h2><p class="muted">Wähle Einnahme/Ausgabe, Kategorie und den konkreten Artikel. Kauf/Verkauf synchronisiert auf Wunsch direkt das Familien-Lager.</p>
      <form id="cashFormV33" class="form-grid">
        <label>Typ<select id="cash_type_v33" name="type" onchange="updateCashArticleFields()"><option value="income">Einnahme / Verkauf</option><option value="expense">Ausgabe / Kauf</option></select></label>
        <label>Kategorie<select id="cash_category_v33" name="category" onchange="updateCashArticleFields()">${catOptions('income')}</select></label>
        <div id="cash_item_box_v33"></div>
        <label id="cash_custom_item_v33">Andere Waffe<input id="cash_other_weapon_v33" placeholder="nur falls nicht in Liste"></label>
        <label>Menge / Schüsse<input id="cash_qty_v33" name="quantity" type="number" min="0" step="1" value="1" oninput="updateCashTotalV33()"></label>
        <label>Stückpreis<input id="cash_price_v33" name="unitPrice" type="number" min="0" step="1" value="0" oninput="updateCashTotalV33()"></label>
        <label>Betrag<input id="cash_amount_v33" name="amount" type="number" min="0" step="1" value="0" oninput="updateCashTotalV33()"></label>
        <label class="switch-row"><span>Familien-Lager mitsynchronisieren</span><input id="cash_sync_inv_v33" type="checkbox" checked><i></i></label>
        <label class="full">Notiz<textarea name="note" placeholder="optional"></textarea></label>
        <div class="full muted">Gesamt: <b id="cash_total_preview_v33">0 $</b></div>
        <button class="primary full">Speichern</button>
      </form>`);
    updateCashArticleFields();
    document.getElementById('cashFormV33').onsubmit=async e=>{
      e.preventDefault();
      const type=document.getElementById('cash_type_v33').value;
      const category=document.getElementById('cash_category_v33').value;
      const itemType=inferItemType(category);
      let itemName=document.getElementById('cash_item_v33')?.value || '';
      const other=document.getElementById('cash_other_weapon_v33')?.value?.trim();
      if(itemType==='weapon' && other) itemName=other;
      const body={ type, category, itemType, itemName, quantity:Number(document.getElementById('cash_qty_v33').value||0), unitPrice:Number(document.getElementById('cash_price_v33').value||0), amount:Number(document.getElementById('cash_amount_v33').value||0), note:e.target.note.value||'', syncInventory:!!document.getElementById('cash_sync_inv_v33').checked, inventoryAction:type==='expense'?'buy':'sell' };
      await api('/api/cash/transactions',{method:'POST',body:JSON.stringify(body)});
      closeModal(); await refresh(true); toast('Transaktion gespeichert');
    };
  };
  window.openFamilyInventoryModalV33 = function(){
    const f=famInv(); const w=f.weapons||{};
    const weaponText=Object.entries(w).map(([k,v])=>`${k}: ${v}`).join('\n');
    openModal(`<h2>Familien-Lager bearbeiten</h2><form id="familyInventoryFormV33" class="form-grid"><label class="full">Waffen je Zeile: Name: Menge<textarea id="fam_weapons_v33" rows="7">${H(weaponText)}</textarea></label><label>Leichte Westen<input id="fam_light_v33" type="number" value="${H(f.leichteWesten||0)}"></label><label>Schwere Westen<input id="fam_heavy_v33" type="number" value="${H(f.schwereWesten||f.westen||0)}"></label><label>Langwaffen-Munition<input id="fam_long_v33" type="number" value="${H(f.langwaffenMunition||f.munitionLang||0)}"></label><label>Kurzwaffen-Munition<input id="fam_short_v33" type="number" value="${H(f.kurzwaffenMunition||f.munitionKurz||f.munition||0)}"></label><button class="primary full">Speichern</button></form>`);
    document.getElementById('familyInventoryFormV33').onsubmit=async e=>{e.preventDefault(); const weapons={}; String(document.getElementById('fam_weapons_v33').value||'').split(/\n+/).forEach(line=>{ const m=line.split(':'); if(m[0]) weapons[m[0].trim()]=Number(m.slice(1).join(':').trim()||0); }); const patch={weapons, leichteWesten:Number(document.getElementById('fam_light_v33').value||0), schwereWesten:Number(document.getElementById('fam_heavy_v33').value||0), langwaffenMunition:Number(document.getElementById('fam_long_v33').value||0), kurzwaffenMunition:Number(document.getElementById('fam_short_v33').value||0)}; await api('/api/inventory/family',{method:'POST',body:JSON.stringify({patch})}); closeModal(); await refresh(true); toast('Familien-Lager gespeichert'); };
  };
  // Profil löschen mit sichtbarer Bestätigung und Fehlermeldung, statt still nichts zu tun.
  window.deleteMemberProfile = async function(id){
    const name=(DATA?.members||[]).find(m=>String(m.id)===String(id));
    if(!confirm(`Web-Profil wirklich löschen?\n\n${(name&&(name.serverName||name.nickname||name.username))||id}\n\nDiscord-Mitglied bleibt erhalten.`)) return;
    try{ await api('/api/members/'+encodeURIComponent(id),{method:'DELETE'}); await refresh(true); toast('Profil gelöscht'); }
    catch(e){ toast('Profil konnte nicht gelöscht werden: '+(e.message||e)); }
  };
})();

/* ===== V34: stabile System-Leiste, Berichteseite, Abgaben-Auswahl + Wochenliste ===== */
(function(){
  const H = (v)=>String(v??'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const get = (obj,path,fb)=>path.split('.').reduce((a,k)=>a&&a[k],obj) ?? fb;
  function isoWeekV34(d=new Date()){
    const date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
    const day=date.getUTCDay()||7; date.setUTCDate(date.getUTCDate()+4-day);
    const y0=new Date(Date.UTC(date.getUTCFullYear(),0,1));
    const w=Math.ceil((((date-y0)/86400000)+1)/7);
    return `${date.getUTCFullYear()}-W${String(w).padStart(2,'0')}`;
  }
  function prevWeekV34(w=isoWeekV34()){
    const m=String(w).match(/^(\d{4})-W(\d{2})$/); if(!m) return w;
    const d=new Date(Date.UTC(Number(m[1]),0,1+(Number(m[2])-1)*7)); d.setUTCDate(d.getUTCDate()-7);
    return isoWeekV34(d);
  }
  function nice(k){ return (typeof niceKey==='function'?niceKey(k):String(k||'').replace(/[-_]/g,' ').replace(/^./,m=>m.toUpperCase())); }
  function activeAbgabeTypesV34(){
    const s=DATA?.config?.settings||{};
    const cfg=s.abgabenConfig||{}; const en=s.abgabenEnabled||{};
    const custom=s.customization?.abgabeTypes || DATA?.config?.customization?.abgabeTypes || [];
    const labels={routen:'Routen',patronen:'Patronen',schwarzpulver:'Schwarzpulver',schwarzgeld:'Schwarzgeld',meth:'Meth'};
    const map=new Map();
    [...Object.keys(cfg),...Object.keys(en)].forEach(k=>{ if(k) map.set(k,{key:k,label:labels[k]||nice(k),active:en[k]!==false,participantRoleIds:[]}); });
    custom.forEach(t=>{ if(t?.key) map.set(String(t.key),{...(map.get(String(t.key))||{}),...t,active:t.active!==false && en[String(t.key)]!==false}); });
    // Fallback, damit Select nie leer bleibt.
    if(!map.size){ ['patronen','schwarzpulver','meth','routen'].forEach(k=>map.set(k,{key:k,label:labels[k],active:true,participantRoleIds:[]})); }
    return [...map.values()].filter(t=>t.active!==false);
  }
  window.activeAbgabeTypesV34 = activeAbgabeTypesV34;
  function abgabeTypeV34(key){ return activeAbgabeTypesV34().find(t=>String(t.key)===String(key)) || activeAbgabeTypesV34()[0] || {key:'patronen',label:'Patronen'}; }
  function roleIdsForType(t){ return (Array.isArray(t?.participantRoleIds)&&t.participantRoleIds.length?t.participantRoleIds:(Array.isArray(t?.roleIds)&&t.roleIds.length?t.roleIds:(t?.roleId?[t.roleId]:[]))).map(String).filter(Boolean); }
  function roleName(id){ const r=(DATA?.guildRoles||DATA?.roles||[]).find(x=>String(x.id)===String(id)); return r?.name||id; }
  function displayName(uid){ try{return typeof displayNameForUser==='function'?displayNameForUser(uid):uid;}catch(_){return uid;} }
  function memberId(m){ return String(m?.id||m?.userId||m?.discordId||m?.discord_id||'').trim(); }
  function memberRoles(m){ return (m?.roles||m?.roleIds||m?.discordRoles||[]).map(String); }
  function allKnownMembersV34(){
    const by=new Map();
    (Array.isArray(DATA?.members)?DATA.members:[]).forEach(m=>{ const id=memberId(m); if(id) by.set(id,m); });
    if(DATA?.me?.id && !by.has(String(DATA.me.id))) by.set(String(DATA.me.id),{id:DATA.me.id,roles:DATA.me.roles||[]});
    return [...by.values()];
  }
  function eligibleMembersV34(typeKey){
    const t=abgabeTypeV34(typeKey); const roles=roleIdsForType(t);
    let list=allKnownMembersV34();
    if(roles.length) list=list.filter(m=>roles.some(r=>memberRoles(m).includes(r)));
    return list.sort((a,b)=>String(displayName(memberId(a))).localeCompare(String(displayName(memberId(b))),'de'));
  }
  function abgabeRowsV34(){
    const rows=[]; const root=DATA?.abgaben||{};
    for(const [weekKey,week] of Object.entries(root.weeks||{})){
      for(const [cat,catObj] of Object.entries(week?.categories||{})){
        const users=catObj?.users||catObj?.members||catObj?.entries||catObj||{};
        for(const [uid,row] of Object.entries(users||{})) if(row&&typeof row==='object') rows.push({weekKey,category:cat,userId:uid,_weekKey:weekKey,_userId:uid,...row});
      }
    }
    (root.entries||[]).forEach(e=>rows.push({weekKey:e.weekKey||e.week,category:e.category||e.type,userId:e.userId||e.memberId,_weekKey:e.weekKey||e.week,_userId:e.userId||e.memberId,...e}));
    return rows.filter(r=>r._weekKey&&r.category&&r._userId);
  }
  window.collectAbgabeRows = abgabeRowsV34;
  function statusInfo(row){
    const s=String(row?.status||'').toLowerCase();
    if(!row) return ['Offen','bad'];
    if(['abgegeben','paid','done','erledigt'].includes(s)||row.submitted||row.paid) return ['Abgegeben','good'];
    if(['entschuldigt','excused','abgemeldet'].includes(s)||row.excused) return ['Entschuldigt','warn'];
    if(['zuspaet','zu spät','late'].includes(s)||row.late) return ['Zu spät','bad'];
    if(['zusatz','extra'].includes(s)||row.extra) return ['Zusatz','gold'];
    if(['gelöscht','delete','deleted'].includes(s)) return ['Gelöscht','muted'];
    return [row.status||'Offen',''];
  }
  function weekListV34(cat){
    const week=isoWeekV34(); const members=eligibleMembersV34(cat); const rows=abgabeRowsV34();
    const table=members.map(m=>{ const uid=memberId(m); const r=rows.find(x=>String(x._weekKey)===week && String(x.category)===String(cat) && String(x._userId)===uid); const [label,cls]=statusInfo(r); return [displayName(uid), `<span class="pill ${cls}">${H(label)}</span>`, r?.updatedAt?(typeof dt==='function'?dt(r.updatedAt):new Date(r.updatedAt).toLocaleString('de-DE')):'—']; });
    if(!members.length) return '<p class="muted">Keine Mitglieder passend zur Teilnehmer-Rolle gefunden.</p>';
    return simpleTable(['Mitglied','Status','Update'], table);
  }
  function updateAbgabeSelectsV34(){
    const cat=document.getElementById('abgabe_cat_v34')?.value || activeAbgabeTypesV34()[0]?.key || '';
    const p=document.getElementById('abgabe_person_v34'); if(p) p.innerHTML=eligibleMembersV34(cat).map(m=>`<option value="${H(memberId(m))}">${H(displayName(memberId(m)))}</option>`).join('') || '<option value="">Keine Person gefunden</option>';
    const t=abgabeTypeV34(cat); const roles=roleIdsForType(t); const hint=document.getElementById('abgabe_hint_v34'); if(hint) hint.textContent=`Teilnehmer-Rolle: ${roles.length?roles.map(roleName).join(', '):'Alle Mitglieder'} · auswählbare Personen: ${eligibleMembersV34(cat).length}`;
    const list=document.getElementById('abgabe_weeklist_v34'); if(list) list.innerHTML=weekListV34(cat);
  }
  window.updateAbgabeSelectsV34 = updateAbgabeSelectsV34;
  window.setAbgabeStatusV34 = async function(status){
    const cat=document.getElementById('abgabe_cat_v34')?.value; const userId=document.getElementById('abgabe_person_v34')?.value;
    if(!cat || !userId) return toast('Bitte Abgabeart und Person auswählen.');
    const weekKey = status==='zuspaet' ? prevWeekV34() : isoWeekV34();
    const realStatus = status==='delete'?'gelöscht':status;
    await api('/api/abgaben/update',{method:'POST',body:JSON.stringify({weekKey,category:cat,userId,patch:{status:realStatus,note:'Web-Panel'},by:'web'})});
    await refresh(true); toast(`✅ ${displayName(userId)} als ${realStatus} eingetragen`);
  };
  window.abgaben = abgaben = function(){
    const types=activeAbgabeTypesV34(); const cat=types[0]?.key||''; const s=DATA?.config?.settings||{}; const days=Number(s.abgabeExcusedAfterDays??s.absenceExcusedDays??s.excusedAfterDays??0);
    const opts=types.map(t=>`<option value="${H(t.key)}">${H(t.label||nice(t.key))}</option>`).join('');
    return `<section class="panel v34-abgabe-entry"><h2>Abgabe eintragen</h2><p class="muted">Aktuelle Woche: <b>${H(isoWeekV34())}</b>. „Zu spät“ wird automatisch für die Vorwoche eingetragen. ${days?`Entschuldigt ab ${days} Abmeldetag${days===1?'':'en'}.`:'Entschuldigt-Regel noch nicht gesetzt.'}</p>
      <div class="v34-abgabe-grid"><label>Abgabeart<select id="abgabe_cat_v34" onchange="updateAbgabeSelectsV34()">${opts}</select></label><label>Person<select id="abgabe_person_v34"></select></label></div><p id="abgabe_hint_v34" class="muted"></p>
      <div class="v34-actions"><button class="primary" onclick="setAbgabeStatusV34('abgegeben')">Abgegeben</button><button onclick="setAbgabeStatusV34('entschuldigt')">Entschuldigt</button><button onclick="setAbgabeStatusV34('zusatz')">Zusatz</button><button class="danger-btn" onclick="setAbgabeStatusV34('zuspaet')">Zu spät</button><button onclick="setAbgabeStatusV34('delete')">Löschen</button></div>
    </section><section class="panel"><h2>Aktuelle Wochenliste</h2><p class="muted">Zeigt für die ausgewählte Abgabeart alle Personen: abgegeben, offen, entschuldigt usw.</p><div id="abgabe_weeklist_v34">${weekListV34(cat)}</div></section><script>setTimeout(updateAbgabeSelectsV34,0)</script>`;
  };
  function switchLine(id,title,desc,checked){ return `<label class="v34-switch"><span><b>${H(title)}</b>${desc?`<small>${H(desc)}</small>`:''}</span><input id="${H(id)}" type="checkbox" ${checked?'checked':''}><i></i></label>`; }
  function systemSettingsPanelV34(){ const s=DATA?.config?.settings||{}; const map=[['smartPingEnabled','Intelligente Ping-Erkennung','vermeidet unnötige Pings'],['autoSanctionsEnabled','Automatische Sanktionen','prüft Sanktionen automatisch'],['termRemindersEnabled','Termin-Erinnerungen','sendet Erinnerungen'],['decisionHintsEnabled','Entscheidungs-Hinweise','Hinweise bei offenen Entscheidungen'],['leaderReminderDmEnabled','Leader-DM-Erinnerungen','private Erinnerungen'],['fridayMissingReportEnabled','Freitagsbericht fehlende Abgaben','meldet freitags fehlende Abgaben'],['mondayOverdueReportEnabled','Montagsbericht überfällige Abgaben','meldet montags überfällige Abgaben'],['reportsEnabled','Berichte aktiv','globale Berichtsfunktion'],['dryRunEnabled','Testmodus / Dry Run','keine echten Änderungen/Posts'],['logSystemEnabled','System-Logs aktiv','schreibt wichtige Aktionen ins Log'],['spamProtectionEnabled','Spam-Schutz','schützt vor zu häufiger Nutzung']]; return `<section class="panel"><h2>⚙️ Systemsteuerung</h2><p class="muted">Globale Bot-Schalter.</p><div class="v34-switch-list">${map.map(([k,t,d])=>switchLine('set_'+k,t,d,s[k]===true || (s[k]!==false && ['smartPingEnabled','autoSanctionsEnabled','termRemindersEnabled'].includes(k)))).join('')}</div><button class="primary" onclick="saveSettings()">Systemsteuerung speichern</button></section>`; }
  function reportPanelV34(){ const r=DATA?.config?.settings?.reportSettings||DATA?.config?.reportSettings||{}; const wh=String(r.weeklyReportHour??DATA?.config?.settings?.weeklyReportHour??12).padStart(2,'0'); const wm=String(r.weeklyReportMinute??DATA?.config?.settings?.weeklyReportMinute??0).padStart(2,'0'); const mh=String(r.monthlyReportHour??DATA?.config?.settings?.monthlyReportHour??12).padStart(2,'0'); const mm=String(r.monthlyReportMinute??DATA?.config?.settings?.monthlyReportMinute??0).padStart(2,'0'); const md=Number(r.monthlyReportDay??DATA?.config?.settings?.monthlyReportDay??1); const mode=String(r.abgabeShiftMode|| (r.waitForLatestAbgabeDeadline===false?'split_due':'wait_latest'));
    return `<section class="panel"><h2>📊 Berichte planen</h2><p class="muted">Hier stellst du ein, ob und wann Statistiken automatisch verschickt werden.</p><div class="v34-switch-list">${switchLine('v34_weekly','Wochenstatistik automatisch senden','Abgaben-Wochenbericht automatisch posten.',r.weeklyReportsEnabled!==false)}${switchLine('v34_monthly','Monatsberichte automatisch senden','Kasse/Lager/Monat automatisch berichten.',r.monthlyReportsEnabled!==false)}</div><div class="v34-card"><h3>Verschobene Abgaben</h3><label><input type="radio" name="v34_shift" value="wait_latest" ${mode!=='split_due'?'checked':''}> Auf späteste Abgabe warten</label><label><input type="radio" name="v34_shift" value="split_due" ${mode==='split_due'?'checked':''}> Nicht verschobene schon senden, verschobene später aktualisieren</label></div><div class="v34-abgabe-grid"><label>Uhrzeit Wochenstatistik<input id="v34_weekly_time" type="time" value="${wh}:${wm}"></label><label>Monatsbericht Tag<input id="v34_month_day" type="number" min="1" max="28" value="${H(md)}"></label><label>Uhrzeit Monatsbericht<input id="v34_month_time" type="time" value="${mh}:${mm}"></label></div><button class="primary" onclick="saveReportsV34()">Berichte speichern</button></section>`; }
  window.saveReportsV34 = async function(){ const [wh,wm]=(document.getElementById('v34_weekly_time')?.value||'12:00').split(':').map(Number); const [mh,mm]=(document.getElementById('v34_month_time')?.value||'12:00').split(':').map(Number); const mode=document.querySelector('input[name="v34_shift"]:checked')?.value||'wait_latest'; await api('/api/config/report-settings',{method:'POST',body:JSON.stringify({weeklyReportsEnabled:!!document.getElementById('v34_weekly')?.checked,monthlyReportsEnabled:!!document.getElementById('v34_monthly')?.checked,abgabeShiftMode:mode,waitForLatestAbgabeDeadline:mode!=='split_due',weeklyReportHour:wh,weeklyReportMinute:wm,monthlyReportDay:Number(document.getElementById('v34_month_day')?.value||1),monthlyReportHour:mh,monthlyReportMinute:mm})}); await refresh(true); toast('Berichte gespeichert'); };
  function statsPanelV34(){ return `<section class="panel"><h2>📊 Statistiken konfigurieren</h2><p class="muted">Welche Statistik-Karten angezeigt werden und wie sie heißen.</p><button onclick="addStatCard&&addStatCard()">+ Karte</button><button class="primary" onclick="saveCustomization&&saveCustomization()">Statistiken speichern</button></section>`; }
  const oldCentralV34=window.centralPage;
  window.centralPage=function(){
    if(window.centralTab!=='system') return oldCentralV34?oldCentralV34():'';
    const top=`<div class="central-topbar"><div><h2>⚙️ Zentrale Verwaltung</h2><p>Leader Panel · Systemsteuerung · Admin Panel</p></div><button onclick="refresh()">Aktualisieren</button></div>`;
    const tabs=`<div class="central-tabs clean-three-tabs"><button class="central-tab" onclick="setCentralTab('leader')"><b>Leader Panel</b><span>Abgaben, Wache, Sanktionen, Freigaben</span></button><button class="central-tab active" onclick="setCentralTab('system')"><b>Systemsteuerung</b><span>Reminder, Smart Ping, Automatik, Sicherheit</span></button><button class="central-tab" onclick="setCentralTab('admin')"><b>Admin Panel</b><span>Mitglieder, Rollen, Kanäle, Logs</span></button></div>`;
    const sec=window.centralSection||'system';
    const actions=`<div class="central-subactions v34-subactions"><button class="${sec==='system'?'active':''}" onclick="openCentralSection('system','system')">System</button><button class="${sec==='templates'?'active':''}" onclick="openCentralSection('system','templates')">Nachrichten & Embeds</button><button class="${sec==='statsConfig'?'active':''}" onclick="openCentralSection('system','statsConfig')">Statistiken konfigurieren</button><button class="${sec==='reportSettings'?'active':''}" onclick="openCentralSection('system','reportSettings')">Berichte planen</button><button class="${sec==='labels'?'active':''}" onclick="openCentralSection('system','labels')">Texte/Labels</button></div>`;
    let content=systemSettingsPanelV34();
    if(sec==='reportSettings') content=reportPanelV34();
    else if(sec==='statsConfig') content=statsPanelV34();
    else if(sec==='templates' && typeof customizationStudio==='function') content=customizationStudio('templates');
    else if(sec==='labels' && typeof customizationStudio==='function') content=customizationStudio('labels');
    return `<div class="central-page single-source-ui v34-central">${top}${tabs}${actions}${content}</div>`;
  };
})();

/* ===== V35 Übersicht + Zentrale Verwaltung Cleanup ===== */
(function(){
  const H = (x)=> typeof esc === 'function' ? esc(x) : String(x ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  function safeDt(x){ try { return typeof dt === 'function' ? dt(x) : String(x||''); } catch(_) { return String(x||''); } }
  function nextTerms(limit=5){
    const now = new Date();
    return (DATA?.terms?.items || [])
      .map(t=>({ ...t, _ts: Date.parse(`${t.date||''}T${t.time||'00:00'}`) || Date.parse(t.date||'') || 0 }))
      .filter(t=>!t._ts || t._ts >= now.getTime()-3600000)
      .sort((a,b)=>(a._ts||0)-(b._ts||0))
      .slice(0,limit);
  }
  function miniOverviewMap(){
    try{
      const fams=(DATA?.families||[]).slice(0,200);
      const placements = typeof buildMapPlacements === 'function' ? buildMapPlacements(fams) : [];
      const marks = placements.filter(p=>p?.map?.region==='overview').slice(0,90).map(p=>{
        const f=p.family||{}; const x=Number(p.map.x||p.x||50), y=Number(p.map.y||p.y||50);
        return `<button class="ov-map-dot" title="${H(f.familie||f.name||'Familie')}" style="left:${x}%;top:${y}%" onclick="go('map');setTimeout(()=>focusFamilyOnMap&&focusFamilyOnMap('${H(f.id||'')}'),50)">${H(f.kuerzel||'')}</button>`;
      }).join('');
      return `<div class="panel ov-map-panel"><div class="ov-panel-head"><h2>Familienkarte</h2><button onclick="go('map')">Karte öffnen</button></div><div class="ov-map" style="background-image:url('${typeof mapAssetForRegion==='function'?mapAssetForRegion('overview'):'/maps/overview.jpg'}')">${marks}</div></div>`;
    } catch(e){ return ''; }
  }
  overview = function(){
    const s=DATA?.stats||{}; const pub=DATA?.publicUrl||{}; const famByCat= typeof group==='function' ? group(DATA?.families||[],'category') : {};
    const terms=nextTerms(5);
    const termRows=terms.map(t=>[t.title||'—',t.type||'—',`${t.date||''} ${t.time||''}`,Object.keys(t.responses||{}).length]);
    return `${typeof cards==='function'?cards({'Familien':s.families,'Eigene Mitglieder':s.members,'Kassenstand':money(s.cashBalance),'Offene Sanktionen':s.openSanctions,'Termine':s.terms,'Abgabe-Wochen':s.abgabenWeeks,'Lager-User':s.inventoryUsers,'Aktive Abmeldungen':s.absencesActive}):''}
      <div class="panel public-link-panel"><h2>Öffentlicher Dashboard-Link</h2>${pub.url?`<p><a class="public-link" href="${H(pub.url)}" target="_blank">${H(pub.url)}</a></p>`:'<p class="muted">Noch kein öffentlicher Link erzeugt.</p>'}<div class="toolbar"><span class="pill ${pub.status==='online'?'good':'bad'}">${H(pub.status||'offline')}</span><span class="pill">Aktualisiert: ${safeDt(pub.updatedAt)}</span></div></div>
      <div class="overview-v35-grid">
        <div>${miniOverviewMap()}</div>
        <div class="panel ov-side-panel"><h2>Familien nach Kategorie</h2><div class="ov-chip-grid">${Object.entries(famByCat).map(([k,v])=>`<div class="ov-chip"><span>${H(k)}</span><b>${v.length}</b></div>`).join('')}</div><h2>Nächste Termine</h2>${typeof simpleTable==='function'?simpleTable(['Titel','Typ','Datum','Antworten'], termRows):''}</div>
      </div>`;
  };

  function rolesAuditPanelV35(){
    const mods=DATA?.me?.permissions?.modules || (typeof perms==='function' ? (perms().modules||{}) : {});
    const audit=(DATA?.audit?.items||[]).slice(0,24);
    return `<section class="panel"><h2>🛡️ Rollenrechte & Audit</h2><p class="muted">Rollenrechte und Monitoring sind jetzt in der Zentralen Verwaltung, nicht mehr auf der Übersicht.</p><div class="overview-v35-grid"><div><h3>Rollenrechte</h3>${typeof simpleTable==='function'?simpleTable(['Bereich','Zugriff'],Object.entries(mods).map(([k,v])=>[k,v?'✅':'—'])):''}</div><div><h3>Audit / Monitoring</h3><div class="timeline compact-audit">${audit.map(a=>`<div><b>${H(a.action)}</b><br><span class="muted">${safeDt(a.at)} · ${H(a.by)}</span></div>`).join('')||'<p class="muted">Noch keine Aktionen.</p>'}</div></div></div></section>`;
  }

  const previousCentralV35 = window.centralPage;
  window.centralPage = function(){
    // Admin-Bereich bekommt einen klaren eigenen Reiter für Rollenrechte + Audit.
    if(window.centralTab==='admin' && window.centralSection==='rightsAudit'){
      const top=`<div class="central-topbar"><div><h2>⚙️ Zentrale Verwaltung</h2><p>Leader Panel · Systemsteuerung · Admin Panel</p></div><button onclick="refresh()">Aktualisieren</button></div>`;
      const tabs=`<div class="central-tabs clean-three-tabs"><button class="central-tab" onclick="setCentralTab('leader')"><b>Leader Panel</b><span>Abgaben, Wache, Sanktionen, Freigaben</span></button><button class="central-tab" onclick="setCentralTab('system')"><b>Systemsteuerung</b><span>Reminder, Smart Ping, Automatik, Sicherheit</span></button><button class="central-tab active" onclick="setCentralTab('admin')"><b>Admin Panel</b><span>Mitglieder, Rollen, Kanäle, Logs</span></button></div>`;
      const actions=`<div class="central-subactions v35-subactions"><button onclick="openCentralSection('admin','members')">Mitglieder</button><button onclick="openCentralSection('admin','roles')">Rollen/Rechte</button><button class="active" onclick="openCentralSection('admin','rightsAudit')">Rollenrechte & Audit</button><button onclick="openCentralSection('admin','messagesConfig')">Nachrichten & Embeds</button><button onclick="openCentralSection('admin','channels')">Kanäle</button><button onclick="openCentralSection('admin','logs')">Logs/Diagnose</button><button onclick="openCentralSection('admin','resetCenter')">Reset-Zentrale</button></div>`;
      return `<div class="central-page single-source-ui v35-central">${top}${tabs}${actions}${rolesAuditPanelV35()}</div>`;
    }
    const html = previousCentralV35 ? previousCentralV35() : '';
    // Füge den neuen Reiter auch in bestehenden Admin-Subactions ein, ohne andere Tabs zu verändern.
    if(window.centralTab==='admin' && html && !html.includes("rightsAudit")){
      return html.replace(/(<div class="central-subactions[^>]*>)/, `$1<button class="${window.centralSection==='rightsAudit'?'active':''}" onclick="openCentralSection('admin','rightsAudit')">Rollenrechte & Audit</button>`);
    }
    return html;
  };
})();
