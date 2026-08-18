/* ════════════════════════════════════════════════════════════════
   Blütenpfad · App-Logik
   ════════════════════════════════════════════════════════════════ */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  user: null,
  finds: [],
  config: { plantnet: false, insect: false, fish: false },
  gps: null, draft: null, queue: [], queueTotal: 0,
  map: null, cluster: null, detailMaps: [], walkLayer: null,
};

const SP = window.SPECIES || [];
const spById = {}, spByName = {}, spBySci = {};
SP.forEach(s => {
  spById[s.id] = s; spByName[s.name.toLowerCase()] = s; spBySci[s.sci.toLowerCase()] = s;
  const g = s.sci.split(' ')[0].toLowerCase(); if (!(g in spBySci)) spBySci[g] = s;
});
// Gesperrte Dex-Karten: einheitliche ausgegraute Emoji-Silhouette je Kategorie
// (Pflanze=Klee 🍀, Insekt=Schmetterling 🦋), via CSS brightness(0) flach gemacht.
const silhouetteFor = (cat) => `<span class="dc-sil">${cat === 'insect' ? '🦋' : '🍀'}</span>`;

const CATS = {
  plant:  { label: 'Pflanzen', one: 'Pflanze', emoji: '🌿', q: 'Welche Pflanze ist das?' },
  insect: { label: 'Insekten', one: 'Insekt',  emoji: '🐛', q: 'Welches Insekt ist das?' },
  fish:   { label: 'Fische',   one: 'Fisch',   emoji: '🐟', q: 'Welcher Fisch ist das?' },
};
// MVP zeigt nur Pflanzen + Insekten; Fische bleiben Kategorie im Datenmodell (siehe /api/config).
const isVisibleCat = (cat) => cat !== 'fish' || state.config.fish === true;
const spOfCat = (cat) => SP.filter(s => s.cat === cat);
// Auto-Erkennung pro Kategorie (Pl@ntNet vs. Kindwise insect.id), abgeleitet aus /api/config.
const autoIdEnabled = (cat) => (cat === 'plant' && !!state.config.plantnet) || (cat === 'insect' && !!state.config.insect);
const autoIdSrcLabel = (cat) => cat === 'insect' ? 'insect.id' : 'Pl@ntNet';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }) : '–';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';

// ── Monate / Rarität ───────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTH_NUM = { Jan: 1, Feb: 2, 'Mär': 3, Mrz: 3, Apr: 4, Mai: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Okt: 10, Nov: 11, Dez: 12 };
function parseRange(str) {
  if (!str) return null;
  const p = str.split(/[–\-]/).map(s => s.trim());
  const a = MONTH_NUM[p[0]], b = MONTH_NUM[p[p.length - 1]];
  return (a && b) ? [a, b] : null;
}
function inRange(range, m) { if (!range) return false; const [a, b] = range; return a <= b ? (m >= a && m <= b) : (m >= a || m <= b); }
const curMonth = () => new Date().getMonth() + 1;
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const RARITY = { 1: { label: 'häufig', color: '#82ad52' }, 2: { label: 'verbreitet', color: '#6e8fd6' }, 3: { label: 'selten', color: '#a48fd0' }, 4: { label: 'sehr selten', color: '#e9a94e' } };
function rarityGems(r, muted) {
  r = r || 1; const c = muted ? '' : RARITY[r].color; let s = '';
  for (let i = 1; i <= 4; i++) s += `<i class="gem${i <= r ? ' on' : ''}"${(i <= r && c) ? ` style="background:${c};border-color:${c}"` : ''}></i>`;
  return `<span class="gems" title="${RARITY[r].label}">${s}</span>`;
}
function yearTimeline(sp) {
  const cm = curMonth();
  const primary = sp.cat === 'plant' ? parseRange(sp.bloom) : parseRange(sp.season);
  const secondary = (sp.cat === 'plant' && sp.kind === 'wild') ? parseRange(sp.seed) : null;
  let cells = '';
  for (let m = 1; m <= 12; m++) {
    const cls = ['ym'];
    if (inRange(primary, m)) cls.push('bloom');
    if (secondary && inRange(secondary, m)) cls.push('seed');
    if (m === cm) cls.push('now');
    const style = inRange(primary, m) ? `background-color:${sp.color}` : '';
    cells += `<div class="${cls.join(' ')}"><b style="${style}"></b><span>${MONTHS[m - 1][0]}</span></div>`;
  }
  const primLabel = sp.cat === 'plant' ? 'Blüte' : (sp.cat === 'fish' ? 'Saison' : 'Aktiv');
  const leg = `<span><i class="d bloom" style="background:${sp.color}"></i> ${primLabel}</span>`
    + (secondary ? `<span><i class="d seed"></i> Samen</span>` : '')
    + `<span><i class="d now"></i> jetzt</span>`;
  return `<div class="timeline">${cells}</div><div class="tl-legend">${leg}</div>`;
}

function matchSpecies(sci) {
  if (!sci) return null;
  const s = sci.toLowerCase().trim();
  return spBySci[s] || spBySci[s.split(' ')[0]] || null;
}
function curatedOf(f) {
  if (f.speciesId && spById[f.speciesId]) return spById[f.speciesId];
  if (f.speciesName && spByName[f.speciesName.toLowerCase()]) return spByName[f.speciesName.toLowerCase()];
  if (f.speciesSci) { const m = matchSpecies(f.speciesSci); if (m) return m; }
  return null;
}
function metaFor(f) { return curatedOf(f) || { emoji: (CATS[f.category] || CATS.plant).emoji, color: '#9bbf6a', seed: null }; }
const displayName = (f) => f.speciesName || 'Unbestimmt';
// „NEU!" nur am Kalendertag der Erst-Entdeckung (frühestes createdAt aller Funde dieser Art).
const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
function discoveredToday(finds) {
  let first = Infinity;
  for (const f of finds) { const t = new Date(f.createdAt || f.takenAt).getTime(); if (t < first) first = t; }
  return first !== Infinity && sameDay(first, Date.now());
}
const located = (f) => f.lat != null && f.lng != null && !(f.lat === 0 && f.lng === 0);
const habChips = (sp) => (sp.habitats || []).map(h => `<span class="hab">${h}</span>`).join('') || '<span class="muted">—</span>';

// ── GBIF Verbreitung (übliches Vorkommen) ──────────────────────
const gbifCache = {};
async function gbifKey(sci) {
  if (sci in gbifCache) return gbifCache[sci];
  try {
    const r = await fetch('https://api.gbif.org/v1/species/match?name=' + encodeURIComponent(sci)).then(x => x.json());
    const k = r && (r.usageKey || r.speciesKey) ? (r.usageKey || r.speciesKey) : null;
    gbifCache[sci] = k; return k;
  } catch (_) { gbifCache[sci] = null; return null; }
}
function gbifLayer(key) {
  return L.tileLayer('https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?srs=EPSG:3857&taxonKey=' + key + '&style=classic.poly&bin=hex&hexPerTile=28', { opacity: 0.7 });
}

// ── Auth ───────────────────────────────────────────────────────
let authMode = 'login';
const authEl = $('#auth'), appEl = $('#app');
function showAuth() { authEl.hidden = false; appEl.hidden = true; }
function hideAuth() { authEl.hidden = true; appEl.hidden = false; }
function setUser(u) {
  state.user = u;
  $('#acct-ini').textContent = (u.name || u.email || '🙂').trim().charAt(0).toUpperCase() || '🙂';
  $('#acct-name').textContent = u.name || u.email;
}
$$('#auth-seg .seg-btn').forEach(b => b.onclick = () => {
  authMode = b.dataset.mode;
  $$('#auth-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  $$('.reg-only').forEach(e => e.hidden = authMode !== 'register');
  $('#auth-submit').textContent = authMode === 'register' ? 'Konto erstellen 🌱' : "Los geht's 🌿";
  $('#auth-hint').textContent = authMode === 'register' ? 'Schon ein Konto? Tippe oben auf „Anmelden".' : 'Noch kein Konto? Tippe oben auf „Registrieren".';
  $('#auth-pass').setAttribute('autocomplete', authMode === 'register' ? 'new-password' : 'current-password');
  $('#auth-err').hidden = true;
});
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim(), password = $('#auth-pass').value, name = $('#auth-name').value.trim();
  const err = $('#auth-err'); err.hidden = true;
  const btn = $('#auth-submit'); const lbl = btn.textContent; btn.disabled = true; btn.textContent = '…';
  try {
    const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, name }) });
    const data = await r.json();
    if (r.ok && data.pending) { showAuthPending(data.email || email, data.devVerifyUrl); }       // Registrierung → E-Mail bestätigen
    else if (r.status === 403 && data.error === 'email_not_verified') { showAuthPending(data.email || email, null); }  // Login einer unbestätigten Adresse
    else if (!r.ok) { err.textContent = data.error || 'Fehlgeschlagen'; err.hidden = false; }
    else { setUser(data); hideAuth(); await loadAll(); ensureGeo(); handleHash(); }
  } catch (_) { err.textContent = 'Server nicht erreichbar'; err.hidden = false; }
  btn.disabled = false; btn.textContent = lbl;
};

// ── E-Mail-Bestätigung: Pending-Panel ──────────────────────────
let pendingEmail = null;
function showAuthPending(email, devUrl) {
  pendingEmail = email;
  $('#ap-email').textContent = email;
  $('#auth-err').hidden = true;
  ['#auth-seg', '#auth-form', '#auth-hint', '.auth-legal-note'].forEach(s => $$(s).forEach(el => el.hidden = true));
  const dl = $('#ap-devlink');
  if (devUrl) { dl.href = devUrl; dl.textContent = '🔑 Test-Modus: hier direkt bestätigen'; dl.hidden = false; }
  else dl.hidden = true;
  $('#ap-resend-state').hidden = true;
  $('#auth-pending').hidden = false;
}
function hideAuthPending() {
  $('#auth-pending').hidden = true;
  $('#auth-seg').hidden = false;
  $('#auth-form').hidden = false;
  $('#auth-hint').hidden = false;
  $$('.auth-legal-note').forEach(el => el.hidden = false);
  $$('.reg-only').forEach(el => el.hidden = authMode !== 'register');
}
$('#ap-back').onclick = () => {
  hideAuthPending();
  authMode = 'login';
  $$('#auth-seg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === 'login'));
  $('#auth-submit').textContent = "Los geht's 🌿";
};
$('#ap-resend').onclick = async () => {
  if (!pendingEmail) return;
  const btn = $('#ap-resend'); const lbl = btn.textContent; btn.disabled = true; btn.textContent = '…';
  const st = $('#ap-resend-state');
  try {
    const r = await fetch('/api/auth/resend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: pendingEmail }) });
    const data = await r.json().catch(() => ({}));
    const dl = $('#ap-devlink');
    if (data.devVerifyUrl) { dl.href = data.devVerifyUrl; dl.textContent = '🔑 Test-Modus: hier direkt bestätigen'; dl.hidden = false; }
    st.textContent = '✓ Mail erneut verschickt — schau ins Postfach.'; st.hidden = false;
  } catch (_) { st.textContent = '⚠️ Konnte nicht senden — später nochmal.'; st.hidden = false; }
  btn.disabled = false; btn.textContent = lbl;
};
$('#acct-btn').onclick = (e) => { e.stopPropagation(); $('#acct-menu').hidden = !$('#acct-menu').hidden; };
document.addEventListener('click', (e) => { const m = $('#acct-menu'); if (m && !m.hidden && !$('.acct').contains(e.target)) m.hidden = true; });
$('#logout-btn').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null; state.finds = []; $('#acct-menu').hidden = true; showAuth();
};

// ── Datenfluss ─────────────────────────────────────────────────
async function loadAll() {
  try {
    const [finds, cfg, stats] = await Promise.all([
      fetch('/api/finds').then(r => r.json()),
      fetch('/api/config').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
    ]);
    state.finds = Array.isArray(finds) ? finds : []; state.config = cfg;
    renderStats(stats); renderProgress(); renderRecent(); renderCollection();
    refreshCoop(); harvestNudge();
    if (state.map) { if (mapMode === 'pins') renderMarkers(); else setMapMode(mapMode); }
  } catch (e) { console.error(e); toast('⚠️ Server nicht erreichbar'); }
}
function renderStats(s) { $('#stat-total').textContent = s.total; $('#stat-species').textContent = s.species; $('#stat-harvest').textContent = s.toHarvest; }
// Stat-Boxen klickbar: führen in Sammlung mit passender Voreinstellung.
$$('#stats .stat').forEach(b => b.onclick = () => {
  const k = b.dataset.stat;
  if (k === 'species') { collectionMode = 'dex'; }
  else if (k === 'total') { collectionMode = 'time'; }
  else if (k === 'harvest') {
    curCat = 'plant'; collectionMode = 'time'; openOnly = true;
    $$('#cat-seg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.cat === 'plant'));
    $('#journal-openonly').classList.add('on');
  }
  $$('#collection-mode .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === collectionMode));
  go('collection');
});
// Wildblume ist nur dann „zu ernten", wenn unharvested + kuratierte Wildart + Saatzeit deckt aktuellen Monat.
function isHarvestableNow(f) {
  if (f.harvested || !f.favorite) return false;
  const sp = curatedOf(f);
  if (!sp || sp.cat !== 'plant' || sp.kind !== 'wild' || !sp.seed) return false;
  return inRange(parseRange(sp.seed), curMonth());
}
// Sanfter Wieder-Besuch-Hinweis: einmal pro Session, wenn gemerkte Pflanzen gerade Samen tragen.
let harvestNudgeShown = false;
function harvestNudge() {
  if (harvestNudgeShown) return;
  const ripe = state.finds.filter(isHarvestableNow);
  if (!ripe.length) return;
  harvestNudgeShown = true;
  const n = new Set(ripe.map(f => { const c = curatedOf(f); return c ? c.id : f.id; })).size;
  setTimeout(() => toast(`🌰 ${n} ${n === 1 ? 'gemerkte Art trägt' : 'gemerkte Arten tragen'} jetzt Samen – Zeit für einen Spaziergang!`), 1500);
}
function discoveredMap() { const m = {}; state.finds.forEach(f => { const c = curatedOf(f); if (c) (m[c.id] ||= []).push(f); }); return m; }
function renderProgress() {
  const disc = discoveredMap();
  const visibleSp = SP.filter(s => isVisibleCat(s.cat));
  const visibleIds = new Set(visibleSp.map(s => s.id));
  const haveCur = Object.keys(disc).filter(id => visibleIds.has(id)).length;
  // Benannte eigene Funde außerhalb des Katalogs zählen mit — die Sammlung wächst kontinuierlich.
  const customKeys = new Set();
  state.finds.forEach(f => {
    const cat = f.category || 'plant';
    if (!isVisibleCat(cat) || curatedOf(f) || !f.speciesName) return;
    customKeys.add(cat + ':' + f.speciesName.toLowerCase());
  });
  const have = haveCur + customKeys.size;
  const total = visibleSp.length + customKeys.size;
  const pct = total ? Math.round((have / total) * 100) : 0;
  $('#dex-have').textContent = have; $('#dex-total').textContent = total; $('#dex-fill').style.width = pct + '%';
  const ready = SP.filter(w => w.cat === 'plant' && w.kind === 'wild' && disc[w.id] && inRange(parseRange(w.seed), curMonth()) && disc[w.id].some(f => !f.harvested && f.favorite)).length;
  $('#dex-sub').innerHTML = have === 0 ? 'Noch nichts entdeckt – auf in die Natur! 🌿'
    : `${pct}% gesammelt${ready ? ` · <b class="ready-txt">🌰 ${ready} jetzt erntereif</b>` : ''}`;
}

// ── Navigation ─────────────────────────────────────────────────
function go(view) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'map') { window.scrollTo({ top: 0 }); ensureMap(); }
  else if (view === 'profile') { loadProfile(); refreshCoop(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  else { if (view === 'collection') renderCollection(); if (view === 'collect') refreshCoop(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}
$$('.tab').forEach(t => t.onclick = () => go(t.dataset.view));
$$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

// ── Geolocation ────────────────────────────────────────────────
const HTTPS_ORIGIN = 'https://' + location.hostname + ':8069';
function ensureGeo() {
  if (!window.isSecureContext || !('geolocation' in navigator)) {
    const chip = $('#gps-chip'); chip.hidden = false; chip.className = 'gps-chip off';
    $('#gps-text').textContent = 'Live-GPS → hier für HTTPS tippen'; chip.style.cursor = 'pointer';
    chip.onclick = () => { location.href = HTTPS_ORIGIN + location.pathname; };
    return;
  }
  gpsChip('searching', 'Standort wird gesucht…');
  navigator.geolocation.watchPosition(
    (pos) => { state.gps = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }; gpsChip('on', `Standort bereit · ±${Math.round(pos.coords.accuracy)} m`); },
    (err) => gpsChip('off', err.code === 1 ? 'GPS nicht erlaubt' : 'Standort nicht verfügbar'),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
}
function gpsChip(cls, text) { const chip = $('#gps-chip'); chip.hidden = false; chip.className = 'gps-chip ' + cls; $('#gps-text').textContent = text; }

// ── EXIF & Thumbs ──────────────────────────────────────────────
async function readExif(file) {
  try {
    const ex = await exifr.parse(file, { gps: true, pick: ['latitude', 'longitude', 'DateTimeOriginal', 'CreateDate'] });
    return { lat: ex && ex.latitude != null ? ex.latitude : null, lng: ex && ex.longitude != null ? ex.longitude : null,
      takenAt: ex && (ex.DateTimeOriginal || ex.CreateDate) ? new Date(ex.DateTimeOriginal || ex.CreateDate).toISOString() : null };
  } catch (_) { return { lat: null, lng: null, takenAt: null }; }
}
async function makeThumb(file, max = 520) {
  try {
    let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.82));
  } catch (e) { return null; }
}

// ── Erfassen-Sheet ─────────────────────────────────────────────
const sheet = $('#sheet');
$('#btn-capture').onclick = () => { ensureGeo(); $('#file-capture').value = ''; $('#file-capture').click(); };
$('#btn-import').onclick = () => { $('#file-import').value = ''; $('#file-import').click(); };
$('#file-capture').onchange = async (e) => { const f = e.target.files[0]; if (f) await startDraftFromFile(f, 'capture'); };
$('#file-import').onchange = async (e) => { const files = [...e.target.files]; if (!files.length) return; state.queue = files; state.queueTotal = files.length; nextFromQueue(); };
async function nextFromQueue() { if (!state.queue.length) return; await startDraftFromFile(state.queue.shift(), 'import'); }

$('#btn-crop').onclick = async () => {
  const d = state.draft;
  if (!d) return;
  // Quelle: bei neuem Fund das File aus dem Picker, bei Bearbeitung das Server-Foto.
  let sourceBlob;
  if (d.file) {
    sourceBlob = d.file;
  } else if (d.mode === 'edit' && d.id) {
    try { sourceBlob = await fetch(d.photoUrl).then(r => { if (!r.ok) throw new Error('photo'); return r.blob(); }); }
    catch (_) { toast('⚠️ Foto konnte nicht geladen werden'); return; }
  } else return;

  const cropped = await openCrop(sourceBlob);
  if (!cropped) return;

  if (d.mode === 'edit' && d.id) {
    const thumb = await makeThumb(cropped);
    const fd = new FormData();
    fd.append('photo', cropped, 'photo.jpg');
    if (thumb) fd.append('thumb', thumb, 'thumb.jpg');
    try {
      const r = await fetch('/api/finds/' + d.id + '/photo', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('upload');
      d.photoUrl = '/media/finds/' + d.id + '/photo?v=' + Date.now();
      $('#sheet-photo').src = d.photoUrl;
      toast('✓ Ausschnitt aktualisiert');
    } catch (_) { toast('⚠️ Upload fehlgeschlagen'); }
  } else {
    URL.revokeObjectURL(d.photoUrl);
    d.file = cropped;
    d.photoUrl = URL.createObjectURL(cropped);
    $('#sheet-photo').src = d.photoUrl;
    if (autoIdEnabled(d.category) && d.mode === 'new') autoIdentify();
  }
};

async function startDraftFromFile(file, kind) {
  const ex = await readExif(file);
  let lat = ex.lat, lng = ex.lng, accuracy = null, gpsSource = ex.lat != null ? 'exif' : null;
  if (kind === 'capture' && state.gps) { lat = state.gps.lat; lng = state.gps.lng; accuracy = state.gps.accuracy; gpsSource = 'live'; }
  state.draft = { mode: 'new', category: 'plant', file, photoUrl: URL.createObjectURL(file),
    lat, lng, accuracy, gpsSource, takenAt: ex.takenAt || new Date().toISOString(),
    speciesId: null, speciesName: null, speciesSci: null, speciesSrc: null, confidence: null, notes: '' };
  openSheet();
}

function openSheet() {
  const d = state.draft;
  $('#sheet-title').textContent = d.mode === 'edit' ? 'Eintrag bearbeiten' : 'Neue Entdeckung';
  $('#sheet-photo').src = d.photoUrl;
  $('#btn-crop').hidden = !(d.file || (d.mode === 'edit' && d.id));
  $('#sheet-notes').value = d.notes || '';
  $('#species-search').value = ''; $('#species-custom').value = '';
  $$('#sheet-cat .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === d.category));
  const qb = $('#queue-badge');
  if (state.queueTotal > 1) { qb.hidden = false; qb.textContent = `${state.queueTotal - state.queue.length} / ${state.queueTotal}`; } else qb.hidden = true;
  updateSheetLocDisplay(d);
  applyCatToSheet();
  if (d.speciesName) $('#species-custom').value = spByName[d.speciesName.toLowerCase()] ? '' : d.speciesName;
  sheet.hidden = false; document.body.style.overflow = 'hidden';
  if (d.mode === 'new' && autoIdEnabled(d.category) && !d.speciesName) autoIdentify();
}
function applyCatToSheet() {
  const d = state.draft;
  $('#sheet-species-label').textContent = CATS[d.category].q;
  // Auto-Erkennung im New-Mode (nutzt das hochgeladene File) ODER Edit-Mode (nutzt das Server-Foto).
  const canAuto = autoIdEnabled(d.category) && (d.mode === 'new' || (d.mode === 'edit' && d.id));
  $('#btn-auto').hidden = !canAuto;
  hideSuggest();
  buildChips($('#species-search').value);
}
$$('#sheet-cat .seg-btn').forEach(b => b.onclick = () => {
  if (!state.draft) return;
  state.draft.category = b.dataset.cat;
  $$('#sheet-cat .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  // Artwahl zurücksetzen (Liste wechselt)
  state.draft.speciesId = state.draft.speciesName = state.draft.speciesSci = state.draft.speciesSrc = null; state.draft.confidence = null;
  $('#species-search').value = ''; $('#species-custom').value = '';
  applyCatToSheet();
  if (autoIdEnabled(state.draft.category) && state.draft.mode === 'new') autoIdentify();
});
function kindHint(d) { return d.file ? 'Kein Standort im Foto – beim direkten Knipsen GPS erlauben, oder Foto aus der Galerie nutzen.' : 'Kein Standort gespeichert.'; }
function updateSheetLocDisplay(d) {
  const loc = $('#sheet-loc');
  if (d.lat != null && located(d)) {
    loc.className = 'loc-row';
    let src = 'aus Foto (EXIF)';
    if (d.gpsSource === 'live') src = `Live-GPS · ±${Math.round(d.accuracy || 0)} m`;
    else if (d.gpsSource === 'manual') src = 'manuell gesetzt';
    $('#sheet-loc-text').textContent = `📍 ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)} — ${src}`;
  } else { loc.className = 'loc-row warn'; $('#sheet-loc-text').textContent = kindHint(d); }
}
function closeSheet() {
  sheet.hidden = true; document.body.style.overflow = '';
  if (state.draft && state.draft.photoUrl && state.draft.mode === 'new') URL.revokeObjectURL(state.draft.photoUrl);
  state.draft = null; state.queue = []; state.queueTotal = 0;
}
$('#sheet-close').onclick = closeSheet;
$('.sheet-backdrop').onclick = closeSheet;

// ── Standort-Picker (Leaflet-Karte für manuelles Setzen) ────────
let locMap = null, locMarker = null, locCallback = null;
function openLocPicker(initial, cb) {
  locCallback = cb;
  $('#loc-picker').hidden = false;
  document.body.style.overflow = 'hidden';
  if (!locMap) {
    locMap = L.map('loc-map', { zoomControl: true });
    tileLayer().addTo(locMap);
    locMap.on('click', e => placeLocPin(e.latlng));
  }
  if (locMarker) { locMap.removeLayer(locMarker); locMarker = null; }
  $('#loc-coords').textContent = 'Tippe auf die Karte um einen Punkt zu setzen';
  $('#loc-coords').classList.remove('has');
  $('#loc-confirm').disabled = true;
  if (initial) {
    locMap.setView(initial, 16);
    placeLocPin({ lat: initial[0], lng: initial[1] });
  } else if (state.gps) {
    locMap.setView([state.gps.lat, state.gps.lng], 15);
  } else {
    locMap.setView([51, 10.5], 6);
  }
  setTimeout(() => locMap.invalidateSize(), 90);
}
function placeLocPin(latlng) {
  if (locMarker) locMap.removeLayer(locMarker);
  locMarker = L.marker([latlng.lat, latlng.lng], { draggable: true }).addTo(locMap);
  locMarker.on('dragend', () => updateLocCoords(locMarker.getLatLng()));
  updateLocCoords(latlng);
}
function updateLocCoords(latlng) {
  $('#loc-coords').textContent = `📍 ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  $('#loc-coords').classList.add('has');
  $('#loc-confirm').disabled = false;
}
function closeLocPicker() {
  $('#loc-picker').hidden = true;
  // Sheet bleibt offen, also Body-Scroll lock dortiger Logik überlassen.
  document.body.style.overflow = 'hidden';
  locCallback = null;
}
$('#loc-cancel').onclick = closeLocPicker;
$('#loc-confirm').onclick = () => {
  if (!locMarker || !locCallback) return;
  const ll = locMarker.getLatLng();
  const cb = locCallback;
  closeLocPicker();
  cb({ lat: ll.lat, lng: ll.lng });
};
$('#loc-locate').onclick = () => {
  if (state.gps) {
    locMap.setView([state.gps.lat, state.gps.lng], 17);
    placeLocPin({ lat: state.gps.lat, lng: state.gps.lng });
  } else {
    locMap.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true });
    locMap.once('locationfound', e => placeLocPin(e.latlng));
    locMap.once('locationerror', () => toast('Standort nicht verfügbar'));
  }
};
$('#sheet-loc-set').onclick = () => {
  const d = state.draft; if (!d) return;
  const init = (d.lat != null && d.lng != null && located(d)) ? [d.lat, d.lng] : null;
  openLocPicker(init, ({ lat, lng }) => {
    d.lat = lat; d.lng = lng; d.gpsSource = 'manual'; d.accuracy = null;
    updateSheetLocDisplay(d);
  });
};

// ── Crop-Overlay (Instagram-Style 1:1 Pinch+Pan) ────────────────
// Math-Notation: tx/ty in stage-display-px ab Stage-Zentrum.
// s = Skalierung relativ zur Baseline k (= Cover-Fit-Faktor f/min(iw,ih)).
// Total-Display-Skalierung = k * s. Pan/Pinch werden zuerst angewandt,
// dann hart aufs Frame-Limit geklammt (kein Rubberband).
async function openCrop(file) {
  const ov = $('#crop-overlay'), stage = $('#crop-stage'), img = $('#crop-img'), frame = $('#crop-frame'), hint = $('#crop-hint');
  const url = URL.createObjectURL(file);
  try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); }
  catch (_) { URL.revokeObjectURL(url); return null; }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) { URL.revokeObjectURL(url); return null; }

  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  // Frame-Größe = kleinere Stage-Dim minus Padding
  const r = stage.getBoundingClientRect();
  const fSize = Math.max(80, Math.min(r.width, r.height) - 32);
  frame.style.width = frame.style.height = fSize + 'px';
  const k = fSize / Math.min(iw, ih);

  let s = 1, tx = 0, ty = 0;
  const MIN_S = 1, MAX_S = 8;

  img.style.width = iw + 'px';
  img.style.height = ih + 'px';
  function apply() {
    img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${k * s})`;
  }
  function clampPan() {
    const halfW = (iw * k * s - fSize) / 2;
    const halfH = (ih * k * s - fSize) / 2;
    tx = Math.max(-halfW, Math.min(halfW, tx));
    ty = Math.max(-halfH, Math.min(halfH, ty));
  }
  apply();

  const pointers = new Map();
  let pinch = null;
  let hintGone = false;
  const killHint = () => { if (!hintGone) { hintGone = true; hint.classList.add('gone'); } };
  const hintTimer = setTimeout(killHint, 3500);

  function pinchStart() {
    const [a, b] = [...pointers.values()];
    const dx = b.x - a.x, dy = b.y - a.y;
    const rect = stage.getBoundingClientRect();
    pinch = {
      dist: Math.max(1, Math.hypot(dx, dy)),
      mx: (a.x + b.x) / 2 - rect.left - rect.width / 2,
      my: (a.y + b.y) / 2 - rect.top - rect.height / 2,
      s0: s, tx0: tx, ty0: ty,
    };
  }

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size === 2) pinchStart();
    else pinch = null;
  }
  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    const prev = pointers.get(e.pointerId);
    const next = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, next);
    killHint();
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const newS = Math.max(MIN_S, Math.min(MAX_S, pinch.s0 * (dist / pinch.dist)));
      // Pinch-Mittelpunkt bleibt stabil in Bild-Koordinaten
      const offX = (pinch.mx - pinch.tx0) / (k * pinch.s0);
      const offY = (pinch.my - pinch.ty0) / (k * pinch.s0);
      s = newS;
      tx = pinch.mx - offX * (k * s);
      ty = pinch.my - offY * (k * s);
      clampPan(); apply();
    } else if (pointers.size === 1) {
      tx += next.x - prev.x;
      ty += next.y - prev.y;
      clampPan(); apply();
    }
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 2) pinchStart(); // Re-Baseline für Restpaar
  }
  function onWheel(e) {
    e.preventDefault();
    killHint();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    const newS = Math.max(MIN_S, Math.min(MAX_S, s * factor));
    if (newS === s) return;
    const offX = (mx - tx) / (k * s);
    const offY = (my - ty) / (k * s);
    s = newS;
    tx = mx - offX * (k * s);
    ty = my - offY * (k * s);
    clampPan(); apply();
  }
  function onKey(e) { if (e.key === 'Escape') finish(null); }

  let resolveFn;
  const result = new Promise(res => { resolveFn = res; });

  function finish(value) {
    clearTimeout(hintTimer);
    stage.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    stage.removeEventListener('wheel', onWheel);
    document.removeEventListener('keydown', onKey);
    $('#crop-x').onclick = null;
    $('#crop-cancel').onclick = null;
    $('#crop-confirm').onclick = null;
    ov.hidden = true;
    URL.revokeObjectURL(url);
    img.removeAttribute('src');
    img.style.transform = '';
    hint.classList.remove('gone');
    pointers.clear();
    resolveFn(value);
  }

  async function confirm() {
    const scale = k * s;
    // Crop-Rechteck in Image-Pixel-Koords:
    // Frame-Topleft relativ zum Stage-Zentrum: (-f/2, -f/2)
    // Image-Topleft relativ zum Stage-Zentrum: (tx - iw*scale/2, ty - ih*scale/2)
    const sx = (-fSize / 2 - (tx - iw * scale / 2)) / scale;
    const sy = (-fSize / 2 - (ty - ih * scale / 2)) / scale;
    const ssz = fSize / scale;
    const out = Math.min(Math.round(ssz), 1920);
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { try { bmp = await createImageBitmap(file); } catch (_) { finish(null); return; } }
    const cv = document.createElement('canvas');
    cv.width = out; cv.height = out;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, ssz, ssz, 0, 0, out, out);
    bmp.close && bmp.close();
    const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.85));
    finish(blob);
  }

  $('#crop-x').onclick = () => finish(null);
  $('#crop-cancel').onclick = () => finish(null);
  $('#crop-confirm').onclick = confirm;
  stage.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKey);

  return result;
}

function buildChips(filter) {
  const wrap = $('#species-chips'); wrap.innerHTML = '';
  const cat = state.draft ? state.draft.category : 'plant';
  const f = (filter || '').trim().toLowerCase();
  const list = spOfCat(cat).filter(w => !f || w.name.toLowerCase().includes(f) || w.sci.toLowerCase().includes(f));
  list.forEach(w => {
    const c = document.createElement('button');
    c.className = 'chip' + (state.draft && state.draft.speciesId === w.id ? ' sel' : '');
    c.innerHTML = `<span class="sw" style="background:${w.color}"></span>${w.emoji} ${w.name}`;
    if (state.draft && state.draft.speciesId === w.id) c.style.background = w.color;
    c.onclick = () => selectSpecies(w);
    wrap.appendChild(c);
  });
  if (!list.length) wrap.innerHTML = '<p class="empty-mini">Nichts gefunden – tipp den Namen unten ein 👇</p>';
}
function selectSpecies(w) {
  const d = state.draft;
  d.speciesId = w.id; d.speciesName = w.name; d.speciesSci = w.sci; d.speciesSrc = 'manual'; d.confidence = null;
  $('#species-custom').value = ''; hideSuggest(); buildChips($('#species-search').value);
}
$('#species-search').oninput = (e) => buildChips(e.target.value);
$('#species-custom').oninput = (e) => {
  const v = e.target.value.trim(); const d = state.draft;
  if (v) { d.speciesId = null; d.speciesName = v; d.speciesSci = null; d.speciesSrc = 'manual'; d.confidence = null; hideSuggest(); }
  else if (d.speciesSrc === 'manual' && !spById[d.speciesId]) d.speciesName = null;
  $$('.chip.sel').forEach(c => { c.classList.remove('sel'); c.style.background = ''; });
};

// Live-Erkennung (Pl@ntNet bei Pflanzen, Kindwise insect.id bei Insekten)
$('#btn-auto').onclick = () => autoIdentify({ force: true });
async function autoIdentify(opts = {}) {
  const d = state.draft;
  if (!d || !autoIdEnabled(d.category)) return;
  if (d.mode === 'new' && !d.file) return;
  if (d.mode === 'edit' && !d.id) return;
  const mine = d, cat = d.category, src = autoIdSrcFor(cat); showSuggest('loading');
  try {
    let r;
    if (d.mode === 'edit') {
      const j = await fetch('/api/finds/' + d.id + '/identify', { method: 'POST' }).then(x => x.ok ? x.json() : null).catch(() => null);
      if (j && j.speciesName) r = { name: j.speciesName, sci: j.speciesSci, confidence: j.confidence };
    } else {
      const fd = new FormData(); fd.append('photo', d.file, 'photo.jpg');
      r = await fetch('/api/identify?cat=' + cat, { method: 'POST', body: fd }).then(x => x.json()).catch(() => null);
    }
    if (state.draft !== mine || mine.category !== cat) return;
    // Auto-Trigger (z. B. beim Sheet-Öffnen) respektiert manuelle Wahl.
    // Explizite Klicks (opts.force = true) überschreiben.
    if (!opts.force && mine.speciesSrc === 'manual' && mine.speciesName) { hideSuggest(); return; }
    if (r && r.name) applySuggestion(r, cat, src); else showSuggest('none');
  } catch (_) { if (state.draft === mine) showSuggest('error'); }
}
function autoIdSrcFor(cat) { return cat === 'insect' ? 'insect.id' : 'plantnet'; }
function applySuggestion(r, cat, src) {
  const d = state.draft;
  d.confidence = (typeof r.confidence === 'number') ? r.confidence : null;
  const m = matchSpecies(r.sci) || (r.name && spByName[r.name.toLowerCase()]);
  if (m && m.cat === cat) { d.speciesId = m.id; d.speciesName = m.name; d.speciesSci = m.sci; d.speciesSrc = src; $('#species-custom').value = ''; buildChips($('#species-search').value); }
  else { d.speciesId = null; d.speciesName = r.name; d.speciesSci = r.sci || null; d.speciesSrc = src; $('#species-custom').value = r.name; }
  showSuggest('result', r, (m && m.cat === cat) ? m : null, cat);
}
function showSuggest(kind, r, m, cat) {
  const el = $('#species-suggest'); el.hidden = false; el.className = 'suggest';
  if (kind === 'loading') { el.classList.add('loading'); el.innerHTML = `<span class="spinner dark"></span> erkenne Art …`; return; }
  if (kind === 'none') { el.classList.add('miss'); el.innerHTML = `🔍 Keine sichere Erkennung – wähle die Art selbst.`; return; }
  if (kind === 'error') { el.classList.add('miss'); el.innerHTML = `⚠️ Erkennung nicht erreichbar – manuell wählen.`; return; }
  const pct = r.confidence != null ? Math.round(r.confidence * 100) : null;
  const srcLabel = autoIdSrcLabel(cat || 'plant');
  const fallbackEm = cat === 'insect' ? '🦋' : '🌼';
  el.classList.add('ok');
  el.innerHTML = `<span class="sg-em">${m ? m.emoji : fallbackEm}</span><span class="sg-txt"><b>${escapeHtml(m ? m.name : r.name)}</b>${pct != null ? ` <i class="sg-conf">${pct}%</i>` : ''}<small>✨ Vorschlag von ${srcLabel} · bestätige oder korrigiere</small></span>`;
}
function hideSuggest() { const el = $('#species-suggest'); el.hidden = true; el.innerHTML = ''; }

$('#sheet-save').onclick = async () => {
  const d = state.draft; if (!d) return;
  d.notes = $('#sheet-notes').value.trim();
  const btn = $('#sheet-save'); btn.disabled = true; const lbl = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> speichert…';
  try {
    if (d.mode === 'edit') {
      await fetch('/api/finds/' + d.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speciesId: d.speciesId, speciesName: d.speciesName, speciesSci: d.speciesSci, speciesSrc: d.speciesSrc,
          notes: d.notes,
          lat: d.lat, lng: d.lng, gpsSource: d.gpsSource, accuracy: d.accuracy,
        }) });
    } else {
      const thumb = await makeThumb(d.file);
      const fd = new FormData();
      fd.append('photo', d.file, 'photo.jpg');
      if (thumb) fd.append('thumb', thumb, 'thumb.jpg');
      fd.append('meta', JSON.stringify({ category: d.category, lat: d.lat, lng: d.lng, accuracy: d.accuracy, gpsSource: d.gpsSource, takenAt: d.takenAt,
        speciesId: d.speciesId, speciesName: d.speciesName, speciesSci: d.speciesSci, speciesSrc: d.speciesSrc,
        confidence: d.confidence, notes: d.notes, autoIdentify: autoIdEnabled(d.category) }));
      const resp = await fetch('/api/finds', { method: 'POST', body: fd }).then(x => x.json()).catch(() => null);
      d._progression = resp && resp.progression;
    }
    bloom(d.speciesName ? metaFor(d).emoji : CATS[d.category].emoji);
    const name = d.speciesName || CATS[d.category].one;
    await loadAll();
    if (d._progression) playProgression(d._progression);
    btn.innerHTML = lbl; btn.disabled = false;
    if (state.queue.length) { toast(`✓ ${name} · noch ${state.queue.length}`); const hadUrl = d.photoUrl; sheet.hidden = true; await nextFromQueue(); if (hadUrl) URL.revokeObjectURL(hadUrl); }
    else { toast(`🌼 ${name} in die Sammlung eingetragen`); closeSheet(); }
  } catch (e) { console.error(e); toast('⚠️ Speichern fehlgeschlagen'); btn.innerHTML = lbl; btn.disabled = false; }
};

// ── Recent ─────────────────────────────────────────────────────
function renderRecent() {
  const strip = $('#recent-strip');
  const visible = state.finds.filter(f => isVisibleCat(f.category || 'plant'));
  if (!visible.length) { strip.innerHTML = '<p class="empty-mini">Noch nichts entdeckt – los geht\'s! 🌼</p>'; return; }
  strip.innerHTML = '';
  visible.slice(0, 12).forEach(f => {
    const el = document.createElement('button'); el.className = 'rec';
    el.innerHTML = `<img src="${f.thumb}" loading="lazy" alt=""><span>${metaFor(f).emoji} ${displayName(f)}</span>`;
    el.onclick = () => openDetail(f.id); strip.appendChild(el);
  });
}

// ── Saisonrückblick „Dein Natur-Jahr" ──────────────────────────
const recap = $('#recap');
$$('[data-close]', recap).forEach(b => b.onclick = () => { recap.hidden = true; document.body.style.overflow = ''; });
$('#btn-recap').onclick = () => openRecap();
function recapData(year) {
  const fs = state.finds.filter(f => { const d = new Date(f.takenAt || f.createdAt); return !isNaN(d) && d.getFullYear() === year && isVisibleCat(f.category || 'plant'); });
  const monthCounts = Array(12).fill(0), speciesCount = {}, habitatCount = {};
  let plant = 0, insect = 0, first = null, last = null;
  fs.forEach(f => {
    const d = new Date(f.takenAt || f.createdAt);
    monthCounts[d.getMonth()]++;
    if (!first || d < first.d) first = { d, f };
    if (!last || d > last.d) last = { d, f };
    const cat = f.category || 'plant';
    if (cat === 'plant') plant++; else if (cat === 'insect') insect++;
    const sp = curatedOf(f);
    const key = sp ? sp.id : 'name:' + (f.speciesName || '?').toLowerCase();
    if (!speciesCount[key]) speciesCount[key] = { n: 0, label: sp ? sp.name : (f.speciesName || 'Unbestimmt'), emoji: sp ? sp.emoji : (CATS[cat] || CATS.plant).emoji, sp };
    speciesCount[key].n++;
    if (sp && sp.habitats) sp.habitats.forEach(h => habitatCount[h] = (habitatCount[h] || 0) + 1);
  });
  const favSpecies = Object.values(speciesCount).sort((a, b) => b.n - a.n)[0] || null;
  const favHabitat = Object.entries(habitatCount).sort((a, b) => b[1] - a[1])[0] || null;
  return {
    year, total: fs.length, uniqueSpecies: Object.keys(speciesCount).length, monthCounts,
    favSpecies, favHabitat, walks: deriveWalks(fs).length, plant, insect, first, last,
    maxMonth: Math.max(...monthCounts, 1),
  };
}
function openRecap() {
  // Blütenpfad gibt es seit 2026 — kein Jahres-Wechsler, immer das laufende Jahr (mind. 2026).
  const year = Math.max(2026, new Date().getFullYear());
  const d = recapData(year);
  let inner;
  if (d.total < 3) {
    inner = `<p class="recap-empty">Sammle ein paar Funde in ${year}, dann gibt's hier deinen Rückblick. 🌱</p>`;
  } else {
    const maxBar = d.maxMonth;
    const bars = d.monthCounts.map((c, i) =>
      `<div class="rc-bar"><span class="rc-bar-fill" style="height:${Math.max(3, Math.round(c / maxBar * 100))}%"></span><b>${MONTHS[i][0]}</b></div>`).join('');
    const tile = (emoji, val, label) => `<div class="rc-tile"><span class="rc-em">${emoji}</span><b>${val}</b><span>${label}</span></div>`;
    inner = `
      <div class="rc-tiles">
        ${tile('🌸', d.total, d.total === 1 ? 'Fund' : 'Funde')}
        ${tile('📖', d.uniqueSpecies, 'Arten')}
        ${tile('🥾', d.walks, d.walks === 1 ? 'Spaziergang' : 'Spaziergänge')}
      </div>
      <div class="rc-section">
        <h4>Dein Sammel-Jahr</h4>
        <div class="rc-months">${bars}</div>
      </div>
      <div class="rc-cards">
        ${d.favSpecies ? `<div class="rc-fav"><span class="rc-fav-em">${d.favSpecies.emoji}</span><div><b>Lieblingsart</b><span>${escapeHtml(d.favSpecies.label)} · ${d.favSpecies.n}×</span></div></div>` : ''}
        ${d.favHabitat ? `<div class="rc-fav"><span class="rc-fav-em">🌾</span><div><b>Lieblingsort</b><span>${escapeHtml(d.favHabitat[0])}</span></div></div>` : ''}
        <div class="rc-fav"><span class="rc-fav-em">🌿</span><div><b>Pflanzen & Insekten</b><span>${d.plant} Pflanzen · ${d.insect} Insekten</span></div></div>
        ${d.first ? `<div class="rc-fav"><span class="rc-fav-em">🌱</span><div><b>Erster Fund ${year}</b><span>${escapeHtml(displayName(d.first.f))} · ${fmtDate(d.first.f.takenAt || d.first.f.createdAt)}</span></div></div>` : ''}
      </div>`;
  }
  $('#recap-body').innerHTML = `
    <div class="recap-hero">
      <div class="recap-hero-art" aria-hidden="true">🍂🌻🌸🍃</div>
      <h2>Dein Natur-Jahr</h2>
      <p class="recap-sub">${year}</p>
    </div>
    <div class="recap-content">${inner}</div>`;
  recap.hidden = false; document.body.style.overflow = 'hidden';
}

// ── Sammel-Runde (Co-op-Lobby) ─────────────────────────────────
state.coop = null;
let coopPollTimer = null;
async function refreshCoop() {
  try {
    const r = await fetch('/api/coop/current').then(x => x.json());
    state.coop = (r && r.active) ? r : null;
  } catch (_) { /* offline → letzten Stand behalten */ }
  renderCoop(); scheduleCoopPoll();
}
function scheduleCoopPoll() {
  clearTimeout(coopPollTimer);
  if (state.coop) coopPollTimer = setTimeout(refreshCoop, 20000); // nur pollen, wenn Runde aktiv
}
function coopTimeLeft(endsAt) {
  const ms = new Date(endsAt) - Date.now();
  if (ms <= 0) return 'endet bald';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `noch ${h} h ${m} min` : `noch ${m} min`;
}
function coopAvatars(members) {
  return `<div class="coop-avatars">${members.map(m => `<span class="coop-av" title="${escapeAttr(m.name)} · Lv ${m.level}">${m.avatar || '🌱'}</span>`).join('')}</div>`;
}
function coopQuestRows(quests) {
  return quests.map(q => `
    <div class="coop-q${q.done ? ' done' : ''}">
      <span class="coop-q-em">${q.emoji}</span>
      <div class="coop-q-main">
        <div class="coop-q-top"><b>${escapeHtml(q.name)}</b><span>${q.progress}/${q.target}${q.done ? ' ✓' : ''}</span></div>
        <div class="coop-q-bar"><span style="width:${Math.min(100, Math.round(q.progress / q.target * 100))}%"></span></div>
      </div>
    </div>`).join('');
}
function renderCoop() {
  const banner = $('#coop-banner'), panel = $('#coop-panel');
  const c = state.coop;
  if (!c) {
    if (banner) banner.hidden = true;
    if (panel) {
      panel.innerHTML = `
        <p class="coop-intro">Trefft ihr euch zum Spaziergang? Startet eine gemeinsame Runde für <b>Bonus-XP</b> und Crew-Quests – z. B. eine Art, die <i>alle</i> scannen. 🌿</p>
        <div class="coop-actions"><button class="btn btn-primary" id="coop-start" type="button">🌼 Runde starten</button></div>
        <div class="coop-join">
          <input id="coop-code" maxlength="6" placeholder="Code (z. B. K7M2QX)" autocapitalize="characters" autocomplete="off">
          <button class="btn btn-soft" id="coop-join-btn" type="button">Beitreten</button>
        </div>
        <p class="coop-err" id="coop-err" hidden></p>`;
      $('#coop-start').onclick = coopStart;
      $('#coop-join-btn').onclick = coopJoin;
      const inp = $('#coop-code'); inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
    }
    return;
  }
  if (banner) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="coop-banner-top">
        <span class="coop-badge">🌼 +${c.bonusPct}% XP</span>
        ${coopAvatars(c.members)}
        <span class="coop-time">⏳ ${coopTimeLeft(c.endsAt)}</span>
      </div>
      ${(c.syncing && c.syncing.length) ? `<div class="coop-sync">${c.syncing.map(s => `<span class="coop-sync-chip">${s.emoji} ${escapeHtml(s.name)} <b>${s.have}/${s.need}</b></span>`).join('')}</div>` : ''}
      <div class="coop-banner-quests">${coopQuestRows(c.quests)}</div>`;
  }
  if (panel) {
    panel.innerHTML = `
      <div class="coop-codebox">
        <span class="coop-code-label">Code zum Beitreten</span>
        <b class="coop-code-val">${c.code}</b>
      </div>
      ${coopAvatars(c.members)}
      <p class="coop-members-names">${c.members.map(m => `${m.avatar || '🌱'} ${escapeHtml(m.name)}`).join(' · ')}</p>
      ${(c.recent && c.recent.length) ? `<div class="coop-recent"><b>Zuletzt in der Crew</b>${c.recent.slice(0, 5).map(r => `<span>${r.emoji} ${escapeHtml(r.name)} <i>· ${escapeHtml(r.by)}</i></span>`).join('')}</div>` : ''}
      <button class="btn btn-soft" id="coop-leave" type="button">${c.isHost ? '🏁 Runde beenden' : '👋 Runde verlassen'}</button>`;
    $('#coop-leave').onclick = coopLeave;
  }
}
async function coopPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Fehlgeschlagen');
  return data;
}
async function coopStart() {
  try { const r = await coopPost('/api/coop/rounds'); state.coop = r.active ? r : null; renderCoop(); scheduleCoopPoll(); toast('🌼 Sammel-Runde gestartet!'); }
  catch (e) { toast('⚠️ ' + e.message); }
}
async function coopJoin() {
  const code = ($('#coop-code') ? $('#coop-code').value : '').trim();
  const err = $('#coop-err');
  if (code.length !== 6) { if (err) { err.textContent = 'Bitte 6-stelligen Code eingeben.'; err.hidden = false; } return; }
  try { const r = await coopPost('/api/coop/rounds/join', { code }); state.coop = r.active ? r : null; renderCoop(); scheduleCoopPoll(); toast('🌿 Runde beigetreten!'); }
  catch (e) { if (err) { err.textContent = e.message; err.hidden = false; } }
}
async function coopLeave() {
  const host = state.coop && state.coop.isHost;
  if (!confirm(host ? 'Runde für alle beenden?' : 'Runde verlassen?')) return;
  try { await coopPost('/api/coop/rounds/leave'); state.coop = null; renderCoop(); scheduleCoopPoll(); toast(host ? 'Runde beendet.' : 'Runde verlassen.'); }
  catch (e) { toast('⚠️ ' + e.message); }
}

// ── Sammlung ───────────────────────────────────────────────────
let curCat = 'plant', collectionMode = 'dex', openOnly = false;
$$('#cat-seg .seg-btn').forEach(b => b.onclick = () => { curCat = b.dataset.cat; $$('#cat-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b)); renderCollection(); });
$$('#collection-mode .seg-btn').forEach(b => b.onclick = () => { collectionMode = b.dataset.mode; $$('#collection-mode .seg-btn').forEach(x => x.classList.toggle('active', x === b)); renderCollection(); });
$('#dex-search').oninput = () => { if (collectionMode === 'dex') renderDex(); };
$('#journal-openonly').onclick = () => { openOnly = !openOnly; $('#journal-openonly').classList.toggle('on', openOnly); renderTime(); };

function renderCollection() {
  $('#dex-controls').hidden = collectionMode !== 'dex';
  $('#time-controls').hidden = collectionMode !== 'time';
  // „nur zu ernten" macht nur bei Pflanzen Sinn — Insekten kann man nicht ernten.
  const showHarvestToggle = collectionMode === 'time' && curCat === 'plant';
  $('#journal-openonly').hidden = !showHarvestToggle;
  if (!showHarvestToggle && openOnly) { openOnly = false; $('#journal-openonly').classList.remove('on'); }
  if (collectionMode === 'dex') renderDex(); else renderTime();
}
function renderDex() {
  const cat = curCat, filter = ($('#dex-search').value || '').trim().toLowerCase();
  const finds = state.finds.filter(f => (f.category || 'plant') === cat);
  const byCur = {}, byCustom = {};
  finds.forEach(f => { const c = curatedOf(f); if (c) (byCur[c.id] ||= []).push(f); else { const k = (f.speciesName || 'Unbestimmt').toLowerCase(); (byCustom[k] ||= { name: f.speciesName || 'Unbestimmt', named: !!f.speciesName, finds: [] }).finds.push(f); } });
  // benannte Custom-Arten zählen als entdeckt — Zähler UND Nenner wachsen mit; „Unbestimmt" zählt nicht als Art.
  const customNamed = Object.values(byCustom).filter(g => g.named).length;
  const discovered = Object.keys(byCur).length + customNamed;
  const total = spOfCat(cat).length + customNamed;
  $('#dex-legend').innerHTML = `<span class="dl-count">${discovered} / ${total} entdeckt</span>`;
  const match = (w) => !filter || w.name.toLowerCase().includes(filter) || w.sci.toLowerCase().includes(filter) || (w.habitats || []).some(h => h.toLowerCase().includes(filter));
  const cm = curMonth();
  let cards = spOfCat(cat).filter(match).map(w => {
    const fs = byCur[w.id];
    if (!fs) return `<button class="dex-card lock" data-lock="1"><div class="dc-thumb">${silhouetteFor(w.cat)}</div><div class="dc-name">???</div><div class="dc-meta">${rarityGems(w.rarity, true)}</div></button>`;
    const newest = fs[0];
    const isNew = discoveredToday(fs);
    const ready = w.cat === 'plant' && w.kind === 'wild' && inRange(parseRange(w.seed), cm) && fs.some(x => !x.harvested && x.favorite);
    return `<button class="dex-card have" data-sp="${w.id}" style="--c:${w.color}"><div class="dc-thumb"><img src="${newest.thumb}" loading="lazy" alt=""><span class="dc-em">${w.emoji}</span></div>${isNew ? '<span class="dc-new">NEU!</span>' : ''}${ready ? '<span class="dc-ready" title="jetzt erntereif">🌰</span>' : ''}<div class="dc-name">${w.name}</div><div class="dc-meta">${rarityGems(w.rarity)}<span class="dc-count">×${fs.length}</span></div></button>`;
  });
  // eigene, nicht-kuratierte Funde dieser Kategorie als vollwertige Sammlungs-Karten
  Object.values(byCustom).forEach(g => {
    if (filter && !g.name.toLowerCase().includes(filter)) return;
    const newest = g.finds[0];
    const isNew = g.named && discoveredToday(g.finds);
    cards.push(`<button class="dex-card have custom" data-cust="${escapeAttr(g.name)}" style="--c:#9bbf6a"><div class="dc-thumb"><img src="${newest.thumb}" loading="lazy" alt=""><span class="dc-em">${CATS[cat].emoji}</span></div>${isNew ? '<span class="dc-new">NEU!</span>' : ''}<div class="dc-name">${escapeHtml(g.name)}</div><div class="dc-meta"><span class="dc-count">×${g.finds.length}</span></div></button>`);
  });
  $('#collection-body').innerHTML = `<div class="dex-grid">${cards.join('') || '<p class="empty">Keine Art gefunden.</p>'}</div>`;
  $$('.dex-card.have:not(.custom)', $('#collection-body')).forEach(c => c.onclick = () => openSpeciesView(spById[c.dataset.sp]));
  $$('.dex-card.custom', $('#collection-body')).forEach(c => c.onclick = () => openCustom(c.dataset.cust));
  $$('.dex-card.lock', $('#collection-body')).forEach(c => c.onclick = () => toast('🌿 Noch nicht entdeckt – finde sie draußen!'));
}
function findCard(f) {
  const m = metaFor(f);
  const badge = (f.category === 'plant' && f.favorite) ? (f.harvested ? '<span class="badge harvest">✓ geerntet</span>' : '<span class="badge open">🌰 Samen offen</span>') : '';
  const loc = located(f) ? `📍 ${fmtDate(f.takenAt)}` : `<span class="no-loc">⚠ kein Ort</span>`;
  return `<div class="find" data-id="${f.id}"><div class="ph"><img src="${f.thumb}" loading="lazy" alt="">${badge}</div><div class="body"><div class="nm">${m.emoji} ${displayName(f)}</div><div class="meta">${loc}</div></div></div>`;
}
function renderTime() {
  const body = $('#collection-body');
  let finds = state.finds.filter(f => (f.category || 'plant') === curCat);
  if (openOnly && curCat === 'plant') finds = finds.filter(isHarvestableNow);
  if (!finds.length) { body.innerHTML = '<p class="empty">Noch nichts hier.<br>Auf den Blütenpfad! 🌸</p>'; return; }
  body.innerHTML = `<div class="grid">${finds.map(findCard).join('')}</div>`;
  $$('.find', body).forEach(c => c.onclick = () => openDetail(c.dataset.id));
}

// ── Steckbrief ─────────────────────────────────────────────────
const detail = $('#detail');
$$('[data-close]', detail).forEach(b => b.onclick = closeDetail);
function closeDetail() { detail.hidden = true; document.body.style.overflow = ''; state.detailMaps.forEach(m => { try { m.remove(); } catch (_) {} }); state.detailMaps = []; }

function steckRows(sp, ready, seedNow) {
  if (sp.cat === 'plant') {
    let r = `<div class="st-row"><span class="st-k"><i class="st-ic">🌸</i> Blütezeit</span><span class="st-v">${sp.bloom || '–'}</span></div>${yearTimeline(sp)}`;
    if (sp.kind === 'wild') r += `<div class="st-sep"></div><div class="st-row${ready ? ' ready' : ''}" title="Nur kleine Mengen, nur wo erlaubt, niemals geschützte Arten oder Schutzgebiete."><span class="st-k"><i class="st-ic">🌰</i> Samenreife</span><span class="st-v">${sp.seed || '–'}${ready ? ' <i class="seed-now">jetzt erntereif</i>' : (seedNow ? ' <i class="seed-soft">Saison</i>' : '')}</span></div>${sp.kind === 'wild' ? '<p class="st-disclaimer">🌱 <b>Sammeln nur mit Bedacht.</b> Kleine Mengen, nur wo erlaubt, niemals geschützte Arten oder Schutzgebiete. <a href="/naturschutz.html" target="_blank" rel="noopener">Mehr erfahren →</a></p>' : ''}`;
    return r + `<div class="st-sep"></div><div class="hab-row"><span class="st-k"><i class="st-ic">📍</i> Vorkommen</span><div class="habs">${habChips(sp)}</div></div>`;
  }
  if (sp.cat === 'insect') {
    return `<div class="st-row"><span class="st-k"><i class="st-ic">🗓️</i> Flugzeit</span><span class="st-v">${sp.season || '–'}</span></div>${yearTimeline(sp)}<div class="st-sep"></div><div class="st-row"><span class="st-k"><i class="st-ic">🕑</i> Unterwegs</span><span class="st-v">${sp.active || 'Tag'}</span></div><div class="st-sep"></div><div class="hab-row"><span class="st-k"><i class="st-ic">📍</i> Lebensraum</span><div class="habs">${habChips(sp)}</div></div>`;
  }
  return `<div class="st-row"><span class="st-k"><i class="st-ic">🗓️</i> Saison</span><span class="st-v">${sp.season || '–'}</span></div>${yearTimeline(sp)}<div class="st-sep"></div><div class="st-row"><span class="st-k"><i class="st-ic">📏</i> Größe</span><span class="st-v">${sp.size || '–'}</span></div><div class="st-sep"></div><div class="hab-row"><span class="st-k"><i class="st-ic">🌊</i> Gewässer</span><div class="habs">${habChips(sp)}</div></div>`;
}

function openSpeciesView(sp) {
  if (!sp) return;
  const finds = state.finds.filter(f => { const c = curatedOf(f); return c && c.id === sp.id; });
  renderSteckbrief({ sp, name: sp.name, sci: sp.sci, cat: sp.cat, color: sp.color, emoji: sp.emoji, rarity: sp.rarity, finds });
}
function openCustom(name) {
  const finds = state.finds.filter(f => !curatedOf(f) && (f.speciesName || 'Unbestimmt').toLowerCase() === name.toLowerCase());
  const f0 = finds[0] || {};
  renderSteckbrief({ sp: null, name: f0.speciesName || 'Unbestimmt', sci: f0.speciesSci || '', cat: f0.category || 'plant', color: '#9bbf6a', emoji: CATS[f0.category || 'plant'].emoji, rarity: null, finds });
}
function renderSteckbrief(o) {
  const cm = curMonth();
  const seedNow = o.sp && o.sp.cat === 'plant' && o.sp.kind === 'wild' && inRange(parseRange(o.sp.seed), cm);
  const ready = seedNow && o.finds.some(f => !f.harvested && f.favorite);
  const newest = o.finds[0];
  const locFinds = o.finds.filter(f => located(f));
  $('#detail-body').innerHTML = `
    <div class="sp-hero${newest ? ' has-img' : ''}" style="--c:${o.color}">
      ${newest ? `<img src="${newest.photo}" alt="">` : ''}
      <div class="sp-emblem">${o.emoji}</div><div class="veil"></div>
    </div>
    <div class="detail-main">
      <div class="sp-titlerow">
        <div><h2 class="detail-title">${escapeHtml(o.name)}</h2><p class="detail-sci">${o.sci ? escapeHtml(o.sci) : '<span class="muted">unbestimmt</span>'}</p></div>
        ${o.rarity ? `<div class="sp-rare">${rarityGems(o.rarity)}<span class="rare-lbl" style="color:${RARITY[o.rarity].color}">${RARITY[o.rarity].label}</span></div>` : `<div class="sp-rare"><span class="cat-pill">${CATS[o.cat].emoji} ${CATS[o.cat].one}</span></div>`}
      </div>
      ${o.rarity && o.rarity >= 3 ? `<div class="naturschutz-warn"><strong>🌿 Selten oder geschützt.</strong> Bitte nicht entnehmen und Fundort nicht öffentlich teilen. <a href="/naturschutz.html" target="_blank" rel="noopener">Warum?</a></div>` : ''}
      ${o.sp ? `<div class="steck">${steckRows(o.sp, ready, seedNow)}</div>` : ''}
      ${o.sci ? `<div class="sp-finds-head"><h3>🌍 Übliches Vorkommen</h3></div><div class="detail-mini-map" id="gbif-map"></div><p class="gbif-note">Verbreitung weltweit (GBIF-Beobachtungen)</p>` : ''}
      <div class="sp-finds-head"><h3>🌱 Deine Funde</h3><span class="cnt">${o.finds.length}×</span></div>
      ${locFinds.length ? `<div class="detail-mini-map" id="finds-map"></div>` : (o.finds.length ? '<div class="detail-note">Für diese Art ist noch kein Standort gespeichert.</div>' : '<p class="empty-mini">Noch keine eigenen Funde.</p>')}
      ${o.finds.length ? `<div class="sp-thumbs">${o.finds.map(f => `<button class="spt" data-fid="${f.id}"><img src="${f.thumb}" loading="lazy" alt="">${f.harvested ? '<i class="spt-done">✓</i>' : ''}<span>${fmtDate(f.takenAt)}</span></button>`).join('')}</div>` : ''}
    </div>`;
  detail.hidden = false; document.body.style.overflow = 'hidden';

  // GBIF-Verbreitungskarte
  if (o.sci) gbifKey(o.sci).then(key => {
    const el = document.getElementById('gbif-map'); if (!el || !key) { if (el && !key) el.innerHTML = '<div class="map-empty">keine Verbreitungsdaten</div>'; return; }
    const gm = L.map('gbif-map', { zoomControl: false, attributionControl: false, scrollWheelZoom: false }).setView([46, 14], 2);
    tileLayer().addTo(gm); gbifLayer(key).addTo(gm); state.detailMaps.push(gm);
    setTimeout(() => gm.invalidateSize(), 60);
  });
  // Eigene Funde
  if (locFinds.length) setTimeout(() => {
    const fm = L.map('finds-map', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false });
    tileLayer().addTo(fm); const pts = [];
    locFinds.forEach(f => { L.marker([f.lat, f.lng], { icon: pinIcon(f) }).addTo(fm); pts.push([f.lat, f.lng]); });
    pts.length === 1 ? fm.setView(pts[0], 15) : fm.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    state.detailMaps.push(fm); setTimeout(() => fm.invalidateSize(), 60);
  }, 60);

  $$('.spt', detail).forEach(b => b.onclick = () => openDetail(b.dataset.fid));
  // Tap aufs Hero-Foto öffnet Lightbox mit Swipe durch alle Funde dieser Art.
  if (o.finds.length) {
    const heroImg = $('.sp-hero img', detail);
    if (heroImg) heroImg.onclick = () => openLightbox(o.finds.map(f => f.photo), 0);
  }
}

// ── Fund-Detail ────────────────────────────────────────────────
function openDetail(id) {
  const f = state.finds.find(x => x.id === id); if (!f) return;
  const m = metaFor(f), cur = curatedOf(f), cat = f.category || 'plant';
  const hasLoc = located(f);
  const accel = f.gpsSource === 'live' ? `±${Math.round(f.accuracy || 0)} m · Live` : (f.gpsSource === 'exif' ? 'aus Foto' : '–');
  const conf = f.speciesSrc === 'plantnet' && f.confidence ? ` · ${Math.round(f.confidence * 100)}% Pl@ntNet` : '';
  // kategoriespezifisches Info-Feld
  let infoField = `<div class="info"><div class="k">Kategorie</div><div class="v">${CATS[cat].emoji} ${CATS[cat].one}</div></div>`;
  if (cur && cat === 'plant' && cur.kind === 'wild') infoField = `<div class="info"><div class="k">Samenreife</div><div class="v">🌰 ${cur.seed}</div></div>`;
  else if (cur && cat === 'plant') infoField = `<div class="info"><div class="k">Blütezeit</div><div class="v">🌸 ${cur.bloom}</div></div>`;
  else if (cur && cat === 'insect') infoField = `<div class="info"><div class="k">Flugzeit</div><div class="v">🦋 ${cur.season}</div></div>`;
  else if (cur && cat === 'fish') infoField = `<div class="info"><div class="k">Saison</div><div class="v">🎣 ${cur.season}</div></div>`;
  const isPlant = cat === 'plant';
  // Status/Ernte nur für „gemerkte" Pflanzen — sonst bleibt die Sammlung übersichtlich.
  const showHarvest = isPlant && !!f.favorite;
  const favBtn = isPlant ? `<button class="btn btn-soft sm fav-toggle${f.favorite ? ' on' : ''}" data-act="fav">${f.favorite ? '❤️ Samen gemerkt' : '🤍 Samen merken'}</button>` : '';
  const statusBtn = !showHarvest ? '' : (f.harvested ? `<button class="btn btn-soft sm" data-act="unharvest">↺ wieder offen</button>` : `<button class="btn btn-honey sm" data-act="harvest">🌰 Samen geerntet</button>`);
  // „erkennen" ist jetzt im Bearbeiten-Panel — nicht in der Detail-Ansicht.
  const idBtn = '';

  $('#detail-body').innerHTML = `
    <div class="detail-hero"><img src="${f.photo}" alt=""><div class="veil"></div></div>
    <div class="detail-main">
      <div class="sp-titlerow">
        <div><h2 class="detail-title">${m.emoji} ${displayName(f)}</h2>${f.speciesSci ? `<p class="detail-sci">${escapeHtml(f.speciesSci)}${conf}</p>` : ''}</div>
        ${cur ? `<div class="sp-rare">${rarityGems(cur.rarity)}</div>` : `<div class="sp-rare"><span class="cat-pill">${CATS[cat].emoji}</span></div>`}
      </div>
      <div class="info-grid">
        <div class="info"><div class="k">Gefunden</div><div class="v">${fmtTime(f.takenAt)}</div></div>
        ${showHarvest ? `<div class="info"><div class="k">Status</div><div class="v">${f.harvested ? '✅ geerntet' : '⏳ offen'}</div></div>` : `<div class="info"><div class="k">Genauigkeit</div><div class="v">${accel}</div></div>`}
        ${infoField}
        ${showHarvest ? `<div class="info"><div class="k">Genauigkeit</div><div class="v">${accel}</div></div>` : ''}
        ${f.notes ? `<div class="info full"><div class="k">Notiz</div><div class="v" style="font-weight:400">${escapeHtml(f.notes)}</div></div>` : ''}
      </div>
      ${hasLoc ? `<div class="detail-mini-map" id="mini-map"></div>` : `<div class="detail-note">Für diesen Fund ist kein Standort gespeichert.</div>`}
      <div class="detail-actions">
        ${favBtn}
        ${statusBtn}
        ${cur ? `<button class="btn btn-soft sm" data-act="steck">📖 Steckbrief</button>` : ''}
        ${hasLoc ? `<button class="btn btn-soft sm" data-act="map">🗺️ auf Karte</button>` : ''}
        ${idBtn}
        <button class="btn btn-soft sm" data-act="edit">✏️ bearbeiten</button>
        <button class="btn btn-danger sm" data-act="del">🗑️</button>
      </div>
    </div>`;
  detail.hidden = false; document.body.style.overflow = 'hidden';
  if (hasLoc) setTimeout(() => {
    const mm = L.map('mini-map', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false }).setView([f.lat, f.lng], 16);
    tileLayer().addTo(mm); L.marker([f.lat, f.lng], { icon: pinIcon(f) }).addTo(mm); state.detailMaps.push(mm); setTimeout(() => mm.invalidateSize(), 60);
  }, 60);
  $$('[data-act]', detail).forEach(b => b.onclick = () => detailAction(b.dataset.act, f));
}
async function detailAction(act, f) {
  if (act === 'fav') {
    const next = !f.favorite;
    await fetch('/api/finds/' + f.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: next }) }).catch(() => {});
    if (next) bloom('🌰');
    toast(next ? '🌰 zur Samenliste gemerkt' : 'von der Samenliste entfernt');
    await loadAll();
    state.detailMaps.forEach(m => { try { m.remove(); } catch (_) {} }); state.detailMaps = [];
    openDetail(f.id);
  } else if (act === 'harvest' || act === 'unharvest') {
    const resp = await fetch('/api/finds/' + f.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harvested: act === 'harvest' }) }).then(x => x.json()).catch(() => null);
    if (act === 'harvest') { bloom('🌰'); toast('🌰 als geerntet markiert'); } else toast('↺ wieder offen');
    await loadAll(); closeDetail();
    if (resp && resp.progression) playProgression(resp.progression);
  } else if (act === 'steck') { const c = curatedOf(f); if (c) { closeDetail(); setTimeout(() => openSpeciesView(c), 60); } }
  else if (act === 'map') { closeDetail(); go('map'); setTimeout(() => { if (state.map) state.map.setView([f.lat, f.lng], 17); openPopupFor(f.id); }, 350); }
  else if (act === 'edit') {
    closeDetail();
    state.draft = { mode: 'edit', id: f.id, category: f.category || 'plant', photoUrl: f.photo, lat: f.lat, lng: f.lng, accuracy: f.accuracy, gpsSource: f.gpsSource, takenAt: f.takenAt, speciesId: f.speciesId, speciesName: f.speciesName, speciesSci: f.speciesSci, speciesSrc: f.speciesSrc, confidence: f.confidence, notes: f.notes || '' };
    openSheet();
  } else if (act === 'identify') {
    toast('✨ frage Pl@ntNet…');
    const r = await fetch('/api/finds/' + f.id + '/identify', { method: 'POST' }).then(x => x.json()).catch(() => null);
    if (r && r.speciesName) { await loadAll(); toast('✓ erkannt: ' + r.speciesName); openDetail(f.id); } else toast('⚠️ keine Erkennung');
  } else if (act === 'del') {
    if (!confirm('Diesen Eintrag wirklich löschen?')) return;
    await fetch('/api/finds/' + f.id, { method: 'DELETE' }); toast('gelöscht'); await loadAll(); closeDetail();
  }
}

// ── Karte ──────────────────────────────────────────────────────
function tileLayer() { return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; CARTO' }); }
function pinIcon(f) { const m = metaFor(f); return L.divIcon({ className: '', iconSize: [38, 38], iconAnchor: [19, 36], popupAnchor: [0, -34], html: `<div class="flower-pin${f.harvested ? ' done' : ''}" style="background:${m.color}"><span>${m.emoji}</span></div>` }); }
let mapFilter = 'all';
$$('#map-filter .seg-btn').forEach(b => b.onclick = () => { mapFilter = b.dataset.filter; $$('#map-filter .seg-btn').forEach(x => x.classList.toggle('active', x === b)); renderMarkers(); });
$('#btn-locate').onclick = () => { if (!state.map) return; state.map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true }); state.map.once('locationerror', () => toast('Standort nicht verfügbar')); };

// ── Spaziergänge: aus Funden abgeleitete Sessions als Pfad auf der Karte ──
let mapMode = 'pins', activeWalkId = null, walksCache = [];
const WALK_GAP_MS = 90 * 60 * 1000, WALK_GAP_KM = 2; // neuer Spaziergang bei >90 min ODER >2 km Lücke
function walkSpeciesKey(f) { const sp = curatedOf(f); return (sp && sp.id) || (f.speciesName ? 'name:' + f.speciesName.toLowerCase() : 'find:' + f.id); }
function deriveWalks(finds) {
  const pts = finds.filter(f => located(f) && (f.takenAt || f.createdAt))
    .map(f => ({ f, ts: new Date(f.takenAt || f.createdAt).getTime() }))
    .filter(p => !isNaN(p.ts)).sort((a, b) => a.ts - b.ts);
  const groups = []; let cur = null;
  for (const p of pts) {
    if (cur) {
      const last = cur[cur.length - 1];
      const gapMs = p.ts - last.ts, gapKm = haversineKm(last.f.lat, last.f.lng, p.f.lat, p.f.lng);
      if (gapMs > WALK_GAP_MS || gapKm > WALK_GAP_KM) cur = null;
    }
    if (!cur) { cur = []; groups.push(cur); }
    cur.push(p);
  }
  return groups.map(g => {
    const fs = g.map(p => p.f), startTs = g[0].ts, endTs = g[g.length - 1].ts;
    let distM = 0;
    for (let i = 1; i < g.length; i++) distM += haversineKm(g[i - 1].f.lat, g[i - 1].f.lng, g[i].f.lat, g[i].f.lng) * 1000;
    return { id: 'w' + startTs, startTs, endTs, finds: fs, distM: Math.round(distM), nSpecies: new Set(fs.map(walkSpeciesKey)).size };
  }).reverse(); // neueste zuerst
}
function setMapMode(mode) {
  if (!state.map) return;
  mapMode = mode;
  $$('#map-mode .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  const walks = mode === 'walks';
  $('#map-filter').hidden = walks; $('#btn-locate').hidden = walks; $('#walk-bar').hidden = !walks;
  if (walks) {
    if (state.cluster && state.map.hasLayer(state.cluster)) state.map.removeLayer(state.cluster);
    walksCache = deriveWalks(state.finds);
    renderWalkPicker();
    if (walksCache.length) selectWalk((activeWalkId && walksCache.some(w => w.id === activeWalkId)) ? activeWalkId : walksCache[0].id);
    else { clearWalkLayer(); $('#walk-head').innerHTML = '<span class="walk-empty">Noch keine Spaziergänge mit Standort – geh raus und sammle! 🌿</span>'; }
  } else {
    clearWalkLayer();
    if (state.cluster && !state.map.hasLayer(state.cluster)) state.map.addLayer(state.cluster);
    renderMarkers();
  }
  setTimeout(fitMap, 60);
}
function renderWalkPicker() {
  $('#walk-chips').innerHTML = walksCache.map(w => {
    const lbl = new Date(w.startTs).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
    return `<button class="walk-chip${w.id === activeWalkId ? ' active' : ''}" data-walk="${w.id}"><b>${lbl}</b><span>${w.finds.length} 🌸</span></button>`;
  }).join('') || '';
  $$('#walk-chips .walk-chip').forEach(c => c.onclick = () => selectWalk(c.dataset.walk));
}
function selectWalk(id) {
  const w = walksCache.find(x => x.id === id); if (!w) return;
  activeWalkId = id;
  $$('#walk-chips .walk-chip').forEach(c => c.classList.toggle('active', c.dataset.walk === id));
  const d0 = new Date(w.startTs), d1 = new Date(w.endTs);
  const dateStr = d0.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'long' });
  const t0 = d0.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const t1 = d1.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const dist = w.distM >= 1000 ? (w.distM / 1000).toFixed(1) + ' km' : w.distM + ' m';
  const timeStr = w.finds.length > 1 ? `${t0}–${t1}` : t0;
  $('#walk-head').innerHTML = `<b>${dateStr}</b><span>${w.finds.length} Funde · ${w.nSpecies} Arten · ${timeStr}${w.distM ? ' · ~' + dist : ''}</span>`;
  renderWalk(w);
}
function clearWalkLayer() { if (state.walkLayer && state.map) { state.map.removeLayer(state.walkLayer); state.walkLayer = null; } }
function walkStopIcon(n, f) {
  return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16], html: `<div class="walk-stop" style="background:${metaFor(f).color}"><span>${n}</span></div>` });
}
function renderWalk(w) {
  clearWalkLayer();
  if (!state.map) return;
  state.walkLayer = L.layerGroup().addTo(state.map);
  const latlngs = w.finds.map(f => [f.lat, f.lng]);
  if (latlngs.length > 1) {
    L.polyline(latlngs, { color: '#a9d27f', weight: 12, opacity: .45, lineCap: 'round', lineJoin: 'round' }).addTo(state.walkLayer);
    L.polyline(latlngs, { color: '#5f8a39', weight: 5, opacity: .95, lineCap: 'round', lineJoin: 'round', dashArray: '1 10' }).addTo(state.walkLayer);
  }
  w.finds.forEach((f, i) => {
    const mk = L.marker([f.lat, f.lng], { icon: walkStopIcon(i + 1, f) });
    mk.bindPopup(`<div class="pop"><img src="${f.thumb}" alt=""><b>${metaFor(f).emoji} ${displayName(f)}</b><small>Stopp ${i + 1} · ${fmtTime(f.takenAt || f.createdAt)}</small><button class="btn btn-soft sm" onclick="window.__openDetail('${f.id}')">Details</button></div>`);
    state.walkLayer.addLayer(mk);
  });
  if (latlngs.length) state.map.fitBounds(latlngs, { padding: [55, 55], maxZoom: 16 });
}
$$('#map-mode .seg-btn').forEach(b => b.onclick = () => setMapMode(b.dataset.mode));

function fitMap() {
  const el = $('#map'); if (!el) return;
  const mainPB = parseFloat(getComputedStyle($('main')).paddingBottom) || 0;
  const bodyPB = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const top = el.getBoundingClientRect().top;
  el.style.height = Math.max(240, Math.round(window.innerHeight - top - mainPB - bodyPB - 8)) + 'px';
  if (state.map) state.map.invalidateSize();
}
function ensureMap() {
  if (state.map) { setTimeout(fitMap, 60); return; }
  fitMap();
  state.map = L.map('map', { zoomControl: true }).setView([51.0, 10.0], 6);
  tileLayer().addTo(state.map);
  state.cluster = L.markerClusterGroup({ maxClusterRadius: 45, showCoverageOnHover: false });
  state.map.addLayer(state.cluster); renderMarkers(); setTimeout(fitMap, 60);
}
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(fitMap, 150); });
window.addEventListener('orientationchange', () => setTimeout(fitMap, 300));
const markerIndex = {};
function renderMarkers() {
  if (!state.cluster) return;
  state.cluster.clearLayers(); for (const k in markerIndex) delete markerIndex[k];
  let withLoc = state.finds.filter(f => located(f) && isVisibleCat(f.category || 'plant'));
  if (mapFilter !== 'all') withLoc = withLoc.filter(f => (f.category || 'plant') === mapFilter);
  const bounds = [];
  withLoc.forEach(f => {
    const mk = L.marker([f.lat, f.lng], { icon: pinIcon(f) });
    mk.bindPopup(`<div class="pop"><img src="${f.thumb}" alt=""><b>${metaFor(f).emoji} ${displayName(f)}</b><small>${fmtDate(f.takenAt)}${f.harvested ? ' · ✓ geerntet' : ''}</small><button class="btn btn-soft sm" onclick="window.__openDetail('${f.id}')">Details</button></div>`);
    state.cluster.addLayer(mk); markerIndex[f.id] = mk; bounds.push([f.lat, f.lng]);
  });
  if (bounds.length) state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
}
function openPopupFor(id) { const mk = markerIndex[id]; if (mk) state.cluster.zoomToShowLayer(mk, () => mk.openPopup()); }
window.__openDetail = openDetail;

// ── Bloom & Toast ──────────────────────────────────────────────
function bloom(emoji) {
  const b = $('#bloom'); b.hidden = false; b.innerHTML = `<div class="big-flower">${emoji}</div>`;
  const petals = ['🌸', '🌼', '🌿', '🍃', '🦋', '✨'];
  for (let i = 0; i < 14; i++) { const p = document.createElement('span'); p.className = 'petal-burst'; p.textContent = petals[i % petals.length];
    const ang = (Math.PI * 2 * i) / 14, dist = 90 + Math.random() * 90;
    p.style.setProperty('--tx', Math.cos(ang) * dist + 'px'); p.style.setProperty('--ty', Math.sin(ang) * dist + 'px');
    p.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg'); p.style.left = '50%'; p.style.top = '50%'; b.appendChild(p); }
  setTimeout(() => { b.hidden = true; b.innerHTML = ''; }, 1050);
}
let toastT;
function toast(msg) { const t = $('#toast'); t.hidden = false; t.textContent = msg; requestAnimationFrame(() => t.classList.add('show')); clearTimeout(toastT); toastT = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.hidden = true, 400); }, 2600); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

// ── Deep-Links ─────────────────────────────────────────────────
function handleHash() {
  const h = location.hash || '';
  if (h.startsWith('#art/')) { go('collection'); const sp = spById[h.slice(5)]; if (sp) setTimeout(() => openSpeciesView(sp), 60); }
  else if (h.startsWith('#fund/')) setTimeout(() => openDetail(h.slice(6)), 60);
  else if (['collection', 'map', 'collect'].includes(h.replace('#', ''))) go(h.replace('#', ''));
}

// ── Profil / XP / Achievements / Quests ────────────────────────
$('.profile-avatar').onclick = () => openAvatarPicker();

// DSGVO-Aktionen
$('#btn-export').onclick = () => {
  // Browser lädt /api/me/export als JSON-Attachment herunter (Content-Disposition: attachment).
  const a = document.createElement('a');
  a.href = '/api/me/export';
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  toast('📥 Export wird heruntergeladen');
};
$('#btn-delete-account').onclick = () => {
  $('#delete-confirm').hidden = false;
  document.body.style.overflow = 'hidden';
};
$$('#delete-confirm [data-close]').forEach(el => el.onclick = () => {
  $('#delete-confirm').hidden = true;
  document.body.style.overflow = '';
});
$('#btn-delete-confirm').onclick = async () => {
  const btn = $('#btn-delete-confirm');
  const lbl = btn.textContent;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> löscht…';
  try {
    const r = await fetch('/api/me', { method: 'DELETE' });
    if (!r.ok) throw new Error('delete failed');
    $('#delete-confirm').hidden = true;
    document.body.style.overflow = '';
    state.user = null; state.finds = [];
    toast('Konto vollständig gelöscht.');
    setTimeout(() => { window.location.href = '/'; }, 900);
  } catch (_) {
    toast('⚠️ Löschen fehlgeschlagen');
    btn.disabled = false; btn.textContent = lbl;
  }
};

async function loadProfile() {
  const body = $('#view-profile');
  try {
    const [p, q, f] = await Promise.all([
      fetch('/api/profile').then(r => r.ok ? r.json() : null),
      fetch('/api/quests').then(r => r.ok ? r.json() : null),
      fetch('/api/friends').then(r => r.ok ? r.json() : null),
    ]);
    if (p) renderProfile(p);
    if (q) renderQuests(q);
    if (f) renderFriendsCard(f);
  } catch (e) { console.error('[profile]', e); }
}

function renderProfile(p) {
  state.currentAvatar = p.avatar || null;
  state.profileAchievements = p.achievements;
  $('#profile-emoji').textContent = p.avatar || p.levelTitle.emoji || '🌱';
  $('#profile-name').textContent = p.name;
  $('#profile-title').textContent = `Lv ${p.level} · ${p.levelTitle.name}`;
  // Für die Freunde-Bestenliste (eigener Eintrag/Rang).
  state.me = { name: p.name, avatar: p.avatar || null, level: p.level, levelTitle: p.levelTitle };
  const span = Math.max(1, (p.nextLevelXp - p.prevLevelXp));
  const pct = p.isMaxLevel ? 100 : Math.max(0, Math.min(100, Math.round(100 * (p.xp - p.prevLevelXp) / span)));
  const fill = $('#xp-fill'); fill.style.width = pct + '%';
  fill.classList.toggle('max', !!p.isMaxLevel);
  $('#xp-current').textContent = p.xp;
  $('#xp-next').textContent = p.isMaxLevel ? '★ Max' : p.nextLevelXp;

  // Achievements
  const grid = $('#achievement-grid'); grid.innerHTML = '';
  const unlocked = p.achievements.filter(a => a.unlocked).length;
  $('#achievement-count').textContent = `${unlocked} / ${p.achievements.length}`;
  p.achievements.forEach((a, i) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'badge-tile ' + (a.unlocked ? 'unlocked' : 'locked');
    tile.title = a.unlocked ? `${a.name} — ${a.desc}` : '??? — noch nicht freigeschaltet';
    tile.innerHTML = `<div class="badge-emoji">${a.unlocked ? a.emoji : '🔒'}</div>
      <div class="badge-name">${a.unlocked ? escapeHtml(a.name) : '???'}</div>
      <div class="badge-xp">+${a.xp} XP</div>`;
    if (a.unlocked) tile.onclick = () => showAchievementDetail(state.profileAchievements[i]);
    grid.appendChild(tile);
  });

  // Saison-Abzeichen (jahresgestempelt)
  const sb = p.seasonalBadges || [];
  const sbWrap = $('#season-badges');
  if (sbWrap) {
    if (sb.length) { sbWrap.hidden = false; sbWrap.innerHTML = `<h4 class="season-badge-title">🏅 Saison-Abzeichen</h4><div class="season-badge-row">${sb.map(b => `<span class="season-badge" title="Ganze ${escapeAttr(b.name)}-Saison abgeschlossen">${b.emoji} ${escapeHtml(b.name)}</span>`).join('')}</div>`; }
    else sbWrap.hidden = true;
  }

}

function navFromProfileStat(target) {
  const setSeg = (sel, val) => $$(sel + ' .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === val || x.dataset.cat === val));
  switch (target) {
    case 'col-time':         collectionMode = 'time'; setSeg('#collection-mode', 'time'); go('collection'); break;
    case 'col-dex':          collectionMode = 'dex';  setSeg('#collection-mode', 'dex');  go('collection'); break;
    case 'col-plant-dex':    curCat = 'plant';  collectionMode = 'dex';  setSeg('#cat-seg', 'plant');  setSeg('#collection-mode', 'dex');  go('collection'); break;
    case 'col-insect-dex':   curCat = 'insect'; collectionMode = 'dex';  setSeg('#cat-seg', 'insect'); setSeg('#collection-mode', 'dex');  go('collection'); break;
    case 'col-plant-time':   curCat = 'plant';  collectionMode = 'time'; setSeg('#cat-seg', 'plant');  setSeg('#collection-mode', 'time'); go('collection'); break;
    case 'map':              go('map'); break;
  }
}

function questIcon(qu) {
  if (qu.kind === 'category' && qu.category === 'insect') return '🐝';
  if (qu.kind === 'category' && qu.category === 'plant')  return '🌷';
  if (qu.kind === 'plant_wild')          return '🌸';
  if (qu.kind === 'plant_bloom_match')   return '🌼';
  if (qu.kind === 'harvest')             return '🌰';
  if (qu.kind === 'unique_species')      return '📖';
  if (qu.kind === 'distinct_species')    return '📖';
  if (qu.kind === 'new_species')         return '✨';
  if (qu.kind === 'distinct_locations')  return '📍';
  if (qu.kind === 'rare')                return '✨';
  if (qu.kind === 'any_in_season')       return '🌿';
  if (qu.kind === 'any')                 return '🌿';
  return '🎯';
}

function fmtCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'läuft ab';
  const mins = Math.floor(ms / 6e4), h = Math.floor(mins / 60), d = Math.floor(h / 24);
  if (d >= 1) return `noch ${d} ${d === 1 ? 'Tag' : 'Tage'}`;
  if (h >= 1) return `noch ${h} Std`;
  return `noch ${Math.max(1, mins)} Min`;
}

// ── Quests als segmentierte „Aufgabentafel" (Heute / Woche / Saison) ──
const questState = { data: null, active: 'daily' };

// Kompakter Fortschritts-Ring (conic-gradient); Akzentfarbe erbt vom Panel via var(--accent).
function questRing(done, total) {
  const pct = total ? Math.round(100 * done / total) : 0;
  const full = total > 0 && done >= total;
  return `<div class="qring${full ? ' full' : ''}" style="--p:${pct}" aria-hidden="true">
    <span class="qring-val">${full ? '✓' : `<b>${done}</b><i>/${total}</i>`}</span></div>`;
}

function questCard(qu) {
  const pct = qu.target ? Math.max(0, Math.min(100, Math.round(100 * qu.progress / qu.target))) : 0;
  const done = qu.completed || !!qu.completedAt;
  return `<div class="qa-card${done ? ' done' : ''}">
    <div class="qa-emoji">${questIcon(qu)}</div>
    <div class="qa-body"><p class="qa-name">${escapeHtml(qu.name)}</p>
      <div class="qa-bar"><div class="qa-bar-fill" style="width:${done ? 100 : pct}%"></div></div></div>
    <div class="qa-count">${done ? '<span class="qa-seal">✓</span>' : `<b>${qu.progress}</b><span>/${qu.target}</span>`}</div>
  </div>`;
}

// Tages-/Wochen-Panel: Ring-Kopf + Countdown, offene Quests zuerst.
function periodicPanel(type, title, icon, data) {
  const quests = (data && data.quests) || [];
  const total = quests.length;
  const done = quests.filter(x => x.completed).length;
  const allDone = total > 0 && done >= total;
  const cd = data && data.resetAt ? fmtCountdown(data.resetAt) : '';
  let body;
  if (!total) {
    body = `<p class="empty-mini">Gerade keine Aufgaben — neue erscheinen automatisch. 🌿</p>`;
  } else {
    const sorted = [...quests].sort((a, b) => (a.completed ? 1 : 0) - (b.completed ? 1 : 0));
    body = `<div class="qa-list">${sorted.map(questCard).join('')}</div>`;
    if (allDone) body += `<div class="qpanel-done"><span>🎉</span> ${type === 'daily' ? 'Alles für heute geschafft!' : 'Wochenziel komplett — stark!'}</div>`;
  }
  return `<div class="qpanel qpanel-${type}">
    <div class="qpanel-head">
      ${questRing(done, total)}
      <div class="qpanel-meta">
        <p class="qpanel-title">${icon} ${title}</p>
        <p class="qpanel-sub">${total ? `${done} von ${total} erledigt` : 'bereit'}${cd ? ` · <span class="qcd">⏳ ${cd}</span>` : ''}</p>
      </div>
    </div>${body}</div>`;
}

// Saison-Panel: Ring + Set-Name/Zeitraum, offene Karten, erledigte als Chips, Hinweise.
function seasonPanel(s) {
  if (!s || !s.activeSet) {
    return `<div class="qpanel qpanel-season"><p class="empty-mini">Gerade ist kein Saison-Set aktiv. Schau bald wieder vorbei. 🌿</p></div>`;
  }
  const set = s.activeSet;
  const fmt = (mmdd) => { const [m, d] = mmdd.split('-'); return `${parseInt(d, 10)}.${parseInt(m, 10)}.`; };
  const completed = s.quests.filter(x => x.completedAt);
  const active = s.quests.filter(x => !x.completedAt);
  const total = s.totalQuests || s.quests.length;
  const done = s.completedCount != null ? s.completedCount : completed.length;
  const allDone = done && done === total;
  let body = '';
  if (active.length) body += `<div class="qa-list">${active.map(questCard).join('')}</div>`;
  if (completed.length) body += `<p class="qpanel-label">🏆 Geschafft</p>
    <div class="qc-row">${completed.map(qu => `<span class="qc-chip"><span class="qc-ico">${questIcon(qu)}</span>${escapeHtml(qu.name)}<span class="qc-check">✓</span></span>`).join('')}</div>`;
  if (s.hiddenCount > 0) {
    const word = s.hiddenCount === 1 ? 'Aufgabe wartet' : 'Aufgaben warten';
    body += `<div class="quest-locked-hint"><span class="qlh-ico">🌱</span><span class="qlh-txt">Noch ${s.hiddenCount} ${word} — schließe deine aktuellen ab, damit die nächste auftaucht.</span></div>`;
  } else if (allDone) {
    body += `<div class="quest-locked-hint quest-complete"><span class="qlh-ico">🏆</span><span class="qlh-txt">Ganze Saison abgeschlossen — du hast dir das Saison-Abzeichen verdient! 🏅</span></div>`;
  }
  return `<div class="qpanel qpanel-season">
    <div class="qpanel-head">
      ${questRing(done, total)}
      <div class="qpanel-meta">
        <p class="qpanel-title">${set.emoji} ${escapeHtml(set.name)}</p>
        <p class="qpanel-sub">${fmt(set.from)}–${fmt(set.to)} · ${done}/${total} Aufgaben</p>
      </div>
    </div>${body || '<p class="empty-mini">Bald geht\'s los — mach deinen ersten Fund! 🌱</p>'}</div>`;
}

// Done/Total je Segment für die Pips im Reiter.
function questSegSummary() {
  const q = questState.data || {};
  const per = (d) => d ? { done: (d.quests || []).filter(x => x.completed).length, total: (d.quests || []).length } : null;
  let season = null;
  if (q.season && q.season.activeSet) season = { done: q.season.completedCount || 0, total: q.season.totalQuests || 0 };
  else if (q.activeSet) season = { done: q.completedCount || 0, total: q.totalQuests || 0 };
  return { daily: per(q.daily), weekly: per(q.weekly), season };
}

function questPip(s) {
  if (!s || !s.total) return '';
  const full = s.done >= s.total;
  return `<span class="qseg-pip${full ? ' full' : ''}">${full ? '✓' : `${s.done}/${s.total}`}</span>`;
}

function renderQuestSeg() {
  const seg = $('#quest-seg');
  const sum = questSegSummary();
  const q = questState.data || {};
  const seasonIco = (q.season && q.season.activeSet && q.season.activeSet.emoji) || '🌸';
  const defs = [
    ['daily', '☀️', 'Heute', sum.daily],
    ['weekly', '📅', 'Woche', sum.weekly],
    ['season', seasonIco, 'Saison', sum.season],
  ];
  seg.innerHTML = defs.map(([key, ico, lbl, s]) =>
    `<button class="qseg-btn${questState.active === key ? ' active' : ''}" type="button" data-seg="${key}">
       <span class="qseg-ico">${ico}</span><span class="qseg-lbl">${lbl}</span>${questPip(s)}
     </button>`).join('');
  $$('#quest-seg .qseg-btn').forEach(b => b.onclick = () => {
    if (questState.active === b.dataset.seg) return;
    questState.active = b.dataset.seg;
    renderQuestSeg();
    renderQuestPanel();
  });
}

function renderQuestPanel() {
  const q = questState.data || {};
  let html;
  if (questState.active === 'weekly') html = periodicPanel('weekly', 'Diese Woche', '📅', q.weekly);
  else if (questState.active === 'season') {
    html = seasonPanel(q.season || { activeSet: q.activeSet || null, quests: q.quests || [], totalQuests: q.totalQuests, completedCount: q.completedCount, hiddenCount: q.hiddenCount });
  } else html = periodicPanel('daily', 'Heutige Aufgaben', '☀️', q.daily);
  $('#quest-list').innerHTML = html;
}

function renderQuests(q) {
  questState.data = q;
  const periodic = !!(q && (q.daily || q.weekly));
  const seg = $('#quest-seg');
  if (periodic) {
    seg.hidden = false;
    if (!['daily', 'weekly', 'season'].includes(questState.active)) questState.active = 'daily';
    renderQuestSeg();
  } else {
    seg.hidden = true;
    questState.active = 'season';
  }
  renderQuestPanel();
}

function showLevelUp(level, title) {
  const el = $('#level-up');
  $('#lvl-emoji').textContent = title.emoji || '🌿';
  $('#lvl-num').textContent = String(level);
  $('#lvl-title').textContent = title.name || 'Naturfreund:in';
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2400);
}

let _achToastT;
function showAchievementUnlock(ach) {
  let el = $('#ach-toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'ach-toast'; el.className = 'ach-toast';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="ach-toast-emoji">${ach.emoji}</div>
    <div class="ach-toast-body">
      <div class="ach-toast-eyebrow">🏆 Errungenschaft</div>
      <p class="ach-toast-name">${escapeHtml(ach.name)}</p>
      <p class="ach-toast-xp">+${ach.xp} XP · ${escapeHtml(ach.desc)}</p>
    </div>`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(_achToastT);
  _achToastT = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.hidden = true, 400); }, 2800);
}

function levelTitleClient(lv) {
  const titles = [[1,'🌱','Spaziergänger:in'],[5,'🌿','Naturfreund:in'],[10,'🌸','Sammler:in'],[15,'🐝','Bestäuber-Kenner:in'],[20,'🌻','Wildblumen-Expert:in'],[25,'⭐','Naturmeister:in']];
  let cur = titles[0];
  for (const t of titles) if (lv >= t[0]) cur = t;
  return { emoji: cur[1], name: cur[2] };
}

function playProgression(p) {
  if (!p) return;
  if (p.coop) { if (p.coop.bonusXp) setTimeout(() => toast(`🌼 Sammel-Runde: +${p.coop.bonusXp} Bonus-XP (+${p.coop.bonusPct}%)`), 700); refreshCoop(); }
  // Erst Tages-/Wochenaufgaben-Toasts, dann Achievements, dann Level-Up, zuletzt Saison-Abzeichen.
  const pc = Array.isArray(p.periodicCompleted) ? p.periodicCompleted : [];
  pc.forEach((c, i) => setTimeout(() => toast(`✓ ${c.period === 'daily' ? 'Tagesaufgabe' : 'Wochenaufgabe'}: ${c.name} · +${c.xp} XP`), 500 + i * 1300));
  const unlocked = Array.isArray(p.unlocked) ? p.unlocked : [];
  const base = 900 + pc.length * 1300;
  const levelUp = p.levelAfter > p.levelBefore;
  unlocked.forEach((a, i) => setTimeout(() => showAchievementUnlock(a), base + i * 1500));
  if (levelUp) {
    const t = levelTitleClient(p.levelAfter);
    setTimeout(() => showLevelUp(p.levelAfter, t), base + unlocked.length * 1500);
  }
  if (p.seasonBadge) {
    setTimeout(() => toast(`🏅 Saison-Abzeichen freigeschaltet: ${p.seasonBadge.name}!`), base + (unlocked.length + (levelUp ? 1 : 0)) * 1500 + 400);
  }
}

// ── Avatar-Picker · Achievement-Detail · Lightbox ──────────────
const AVATAR_OPTIONS = ['🌱','🌿','🌸','🌼','🌷','🌹','🌻','🌺','💐','🍀','🦋','🐝','🐞','🦗','🐜','🐛','🌳','🌲','🐣','🍄','💮','🐌'];

function openAvatarPicker() {
  const cur = state.currentAvatar;
  const grid = $('#ap-grid');
  grid.innerHTML = AVATAR_OPTIONS.map(em => `<button type="button" class="${em === cur ? 'sel' : ''}" data-em="${em}">${em}</button>`).join('');
  $$('#ap-grid button').forEach(b => b.onclick = async () => {
    const em = b.dataset.em;
    closeAvatarPicker();
    try {
      const r = await fetch('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: em }) });
      if (!r.ok) throw new Error('save failed');
      state.currentAvatar = em;
      $('#profile-emoji').textContent = em;
      toast('✓ Avatar geändert');
    } catch (_) { toast('⚠️ Speichern fehlgeschlagen'); }
  });
  $('#avatar-picker').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeAvatarPicker() {
  $('#avatar-picker').hidden = true;
  document.body.style.overflow = '';
}
$$('#avatar-picker [data-close]').forEach(el => el.onclick = closeAvatarPicker);

function showAchievementDetail(a) {
  if (!a || !a.unlocked) return;
  $('#ad-emoji').textContent = a.emoji;
  $('#ad-name').textContent = a.name;
  $('#ad-desc').textContent = a.desc;
  $('#ad-xp').textContent = `+${a.xp} XP`;
  const d = a.unlockedAt ? new Date(a.unlockedAt) : null;
  $('#ad-date').textContent = d ? `freigeschaltet am ${d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}` : 'freigeschaltet';
  $('#ach-detail').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeAchievementDetail() {
  $('#ach-detail').hidden = true;
  document.body.style.overflow = 'hidden'; // Profil-Tab bleibt eh aktiv
  setTimeout(() => { if ($('#ach-detail').hidden) document.body.style.overflow = ''; }, 50);
}
$$('#ach-detail [data-close]').forEach(el => el.onclick = closeAchievementDetail);

// Lightbox: swipeable photo gallery
let lbPhotos = [], lbIndex = 0, lbScrollT;
function openLightbox(photos, startIndex) {
  if (!photos || !photos.length) return;
  lbPhotos = photos;
  lbIndex = Math.max(0, Math.min(photos.length - 1, startIndex || 0));
  const track = $('#lb-track');
  track.innerHTML = photos.map(p => `<img src="${p}" alt="" draggable="false" />`).join('');
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  // Initial scroll to selected index
  requestAnimationFrame(() => {
    track.scrollLeft = lbIndex * track.clientWidth;
    updateLightboxUI();
  });
  track.onscroll = () => {
    clearTimeout(lbScrollT);
    lbScrollT = setTimeout(() => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (i !== lbIndex && i >= 0 && i < lbPhotos.length) { lbIndex = i; updateLightboxUI(); }
    }, 80);
  };
}
function updateLightboxUI() {
  $('#lb-counter').textContent = `${lbIndex + 1} / ${lbPhotos.length}`;
  $('#lb-prev').disabled = lbIndex <= 0;
  $('#lb-next').disabled = lbIndex >= lbPhotos.length - 1;
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lb-track').innerHTML = '';
  $('#lb-track').onscroll = null;
  lbPhotos = []; lbIndex = 0;
  // Detail-Modal/Sheet darüber — Scroll bleibt locked solange offen
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    if (sheet.hidden && detail.hidden) document.body.style.overflow = '';
  }, 30);
}
$('#lb-close').onclick = closeLightbox;
$('#lb-prev').onclick = () => {
  if (lbIndex > 0) { lbIndex--; $('#lb-track').scrollTo({ left: lbIndex * $('#lb-track').clientWidth, behavior: 'smooth' }); updateLightboxUI(); }
};
$('#lb-next').onclick = () => {
  if (lbIndex < lbPhotos.length - 1) { lbIndex++; $('#lb-track').scrollTo({ left: lbIndex * $('#lb-track').clientWidth, behavior: 'smooth' }); updateLightboxUI(); }
};

// ── Freunde ────────────────────────────────────────────────────
const friendsState = { code: null, friends: [], incoming: [], outgoing: [] };
const avatarFor = (b) => b.avatar || (b.levelTitle && b.levelTitle.emoji) || '🌱';

// Bestenliste = ich + Freunde, nach Level sortiert, mit Rang.
function buildLeaderboard(friends) {
  const me = state.me || {};
  const entries = [{ me: true, name: me.name || 'Du', avatar: me.avatar || null, level: me.level || 1, levelTitle: me.levelTitle || levelTitleClient(me.level || 1) }];
  for (const b of friends) entries.push({ me: false, userId: b.userId, name: b.name, avatar: b.avatar, level: b.level, levelTitle: b.levelTitle });
  entries.sort((a, b) => b.level - a.level || String(a.name).localeCompare(String(b.name)));
  entries.forEach((e, i) => e.rank = i + 1);
  return entries;
}
const RANK_MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
function fbRow(e) {
  const medal = RANK_MEDAL[e.rank] || `<span class="fb-rank-n">${e.rank}</span>`;
  const title = e.levelTitle ? e.levelTitle.name : '';
  const lv = `Lv ${e.level}${title ? ` · ${escapeHtml(title)}` : ''}`;
  const inner = `<span class="fb-rank">${medal}</span>
    <span class="fb-av">${avatarFor(e)}</span>
    <div class="fb-info"><p class="fb-name">${escapeHtml(e.name)}${e.me ? ' <span class="fb-you">Du</span>' : ''}</p>
      <p class="fb-lv">${lv}</p></div>`;
  return e.me
    ? `<div class="fb-row me">${inner}</div>`
    : `<button class="fb-row" type="button" data-uid="${e.userId}">${inner}<span class="fb-go">→</span></button>`;
}

function renderFriendsCard(f) {
  friendsState.code = f.code;
  friendsState.friends = f.friends || [];
  friendsState.incoming = f.incoming || [];
  friendsState.outgoing = f.outgoing || [];
  const inc = friendsState.incoming.length;
  const badge = $('#friends-badge');
  if (inc) { badge.hidden = false; badge.textContent = inc; } else badge.hidden = true;

  const friends = friendsState.friends;
  let html = '';
  if (inc) {
    html += `<button class="fb-requests" type="button" data-act="manage">
      <span class="fb-req-ico">📨</span>
      <span class="fb-req-txt"><b>${inc} neue Anfrage${inc > 1 ? 'n' : ''}</b><i>Tippen zum Annehmen</i></span>
      <span class="fb-req-go">→</span></button>`;
  }
  if (!friends.length) {
    html += `<div class="fb-empty">
      <div class="fb-empty-ico">🌱</div>
      <p class="fb-empty-txt">Noch keine Wanderfreunde — teile deinen Code und sammelt gemeinsam!</p>
      <div class="fb-code-mini">${escapeHtml(friendsState.code || '····-····')}</div>
      <button class="btn btn-primary sm" type="button" data-act="manage">Freunde hinzufügen</button>
    </div>`;
  } else {
    const entries = buildLeaderboard(friends);
    const meEntry = entries.find(e => e.me);
    const meOut = meEntry && meEntry.rank > 3;
    html += `<div class="fb-list">` + entries.slice(0, 3).map(fbRow).join('')
      + (meOut ? `<div class="fb-sep" aria-hidden="true"></div>` + fbRow(meEntry) : '')
      + `</div>`;
    html += `<button class="btn btn-soft sm fb-manage" type="button" data-act="manage">🤝 Alle Freunde &amp; Code</button>`;
  }
  $('#friends-board').innerHTML = html;
  $$('#friends-board .fb-row[data-uid]').forEach(r => r.onclick = () => openFriendProfile(r.dataset.uid));
  $$('#friends-board [data-act="manage"]').forEach(b => b.onclick = () => openFriendsOverlay());
}

$('#fo-close').onclick = () => closeFriendsOverlay();
function openFriendsOverlay() {
  $('#friends-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#fo-add-msg').hidden = true;
  refreshFriends();
}
function closeFriendsOverlay() {
  $('#friends-overlay').hidden = true;
  if ($('#friend-profile').hidden) document.body.style.overflow = '';
}
async function refreshFriends() {
  try {
    const f = await fetch('/api/friends').then(r => r.ok ? r.json() : null);
    if (!f) return;
    renderFriendsCard(f);
    renderFriendsOverlay(f);
  } catch (_) {}
}

function friendRow(b, actions) {
  return `<div class="fo-friend" data-uid="${b.userId}">
    <span class="fo-friend-av">${avatarFor(b)}</span>
    <div class="fo-friend-info">
      <p class="fo-friend-name">${escapeHtml(b.name)}</p>
      <p class="fo-friend-lv">Lv ${b.level} · ${escapeHtml(b.levelTitle ? b.levelTitle.name : '')}</p>
    </div>
    <div class="fo-friend-actions">${actions}</div>
  </div>`;
}
function renderFriendsOverlay(f) {
  $('#fo-code').textContent = f.code || '····-····';
  const inWrap = $('#fo-incoming-wrap');
  if (f.incoming.length) {
    inWrap.hidden = false;
    $('#fo-incoming').innerHTML = f.incoming.map(b => friendRow(b,
      `<button class="btn btn-primary sm" data-act="accept" data-fid="${b.friendshipId}">✓ Annehmen</button>
       <button class="btn btn-soft sm" data-act="decline" data-fid="${b.friendshipId}">✕</button>`)).join('');
  } else inWrap.hidden = true;
  const outWrap = $('#fo-outgoing-wrap');
  if (f.outgoing.length) {
    outWrap.hidden = false;
    $('#fo-outgoing').innerHTML = f.outgoing.map(b => friendRow(b,
      `<button class="btn btn-soft sm" data-act="cancel" data-fid="${b.friendshipId}">zurückziehen</button>`)).join('');
  } else outWrap.hidden = true;
  $('#fo-friend-count').textContent = f.friends.length ? `(${f.friends.length})` : '';
  $('#fo-friends').innerHTML = f.friends.length
    ? buildLeaderboard(f.friends).map(fbRow).join('')
    : '<p class="empty-mini">Noch keine Freunde — teile deinen Code! 🌿</p>';
  $$('#fo-incoming [data-act], #fo-outgoing [data-act]').forEach(btn =>
    btn.onclick = (e) => { e.stopPropagation(); friendAction(btn.dataset.act, btn.dataset.fid); });
  $$('#fo-friends .fb-row[data-uid]').forEach(row => row.onclick = () => openFriendProfile(row.dataset.uid));
}

async function friendAction(act, fid) {
  const url = act === 'accept' ? '/api/friends/' + fid + '/accept' : '/api/friends/' + fid;
  const method = act === 'accept' ? 'POST' : 'DELETE';
  try {
    const r = await fetch(url, { method });
    if (!r.ok) throw new Error();
    toast(act === 'accept' ? '🌿 Freund hinzugefügt!' : act === 'decline' ? 'Anfrage abgelehnt' : 'Anfrage zurückgezogen');
    refreshFriends();
  } catch (_) { toast('⚠️ Hat nicht geklappt'); }
}

$('#fo-add-btn').onclick = () => addFriendByCode();
$('#fo-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFriendByCode(); } });
async function addFriendByCode() {
  const input = $('#fo-add-input');
  const code = input.value.trim();
  const msg = $('#fo-add-msg'); msg.hidden = true; msg.className = 'fo-add-msg';
  if (!code) return;
  const btn = $('#fo-add-btn'); btn.disabled = true;
  try {
    const r = await fetch('/api/friends/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { msg.textContent = data.error || 'Hat nicht geklappt'; msg.classList.add('err'); msg.hidden = false; }
    else {
      input.value = '';
      const who = data.friend ? data.friend.name : '';
      msg.textContent = data.status === 'accepted' ? `🌿 Ihr seid jetzt Freunde${who ? ' mit ' + who : ''}!` : `✓ Anfrage gesendet${who ? ' an ' + who : ''}.`;
      msg.classList.add('ok'); msg.hidden = false;
      refreshFriends();
    }
  } catch (_) { msg.textContent = '⚠️ Server nicht erreichbar'; msg.classList.add('err'); msg.hidden = false; }
  btn.disabled = false;
}

$('#fo-copy').onclick = async () => {
  const code = friendsState.code || $('#fo-code').textContent;
  try { await navigator.clipboard.writeText(code); toast('📋 Code kopiert'); }
  catch (_) { toast('Dein Code: ' + code); }
};
if (navigator.share) {
  $('#fo-share').hidden = false;
  $('#fo-share').onclick = async () => {
    const code = friendsState.code || $('#fo-code').textContent;
    try { await navigator.share({ title: 'Blütenpfad', text: `Add mich bei Blütenpfad! Mein Freundescode: ${code}` }); } catch (_) {}
  };
}

// ── Freund-Profil-Modal ────────────────────────────────────────
const friendProfileEl = $('#friend-profile');
$$('#friend-profile [data-close]').forEach(el => el.onclick = closeFriendProfile);
function closeFriendProfile() {
  friendProfileEl.hidden = true;
  document.body.style.overflow = $('#friends-overlay').hidden ? '' : 'hidden';
}
async function openFriendProfile(userId) {
  friendProfileEl.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#fp-body').innerHTML = '<p class="empty-mini">Lade Profil…</p>';
  try {
    const p = await fetch('/api/friends/' + userId + '/profile').then(r => r.ok ? r.json() : null);
    if (!p) { $('#fp-body').innerHTML = '<p class="empty-mini">Profil nicht verfügbar.</p>'; return; }
    renderFriendProfile(p);
  } catch (_) { $('#fp-body').innerHTML = '<p class="empty-mini">Konnte nicht laden.</p>'; }
}
// Baut aus den Funden eines Freundes eine Sammlungs-Ansicht (Arten-Karten mit Fotos).
function fpCollection(finds) {
  if (!finds || !finds.length) return '<p class="empty-mini">Noch keine Funde in der Sammlung.</p>';
  const groups = { plant: {}, insect: {}, _custom: {} };
  finds.forEach(f => {
    const cat = f.category || 'plant';
    const c = curatedOf(f);
    if (c) { (groups[c.cat] ||= {}); (groups[c.cat][c.id] ||= { sp: c, finds: [] }).finds.push(f); }
    else { const k = cat + ':' + (f.speciesName || 'Unbestimmt').toLowerCase(); (groups._custom[k] ||= { name: f.speciesName || 'Unbestimmt', cat, finds: [] }).finds.push(f); }
  });
  const card = (emoji, name, fs) => {
    const photos = fs.map(f => f.photo);
    return `<button class="fp-col-card" type="button" data-photos="${escapeAttr(JSON.stringify(photos))}">
      <div class="fp-col-thumb"><img src="${fs[0].thumb}" loading="lazy" alt=""><span class="fp-col-em">${emoji}</span>${fs.length > 1 ? `<span class="fp-col-badge">×${fs.length}</span>` : ''}</div>
      <div class="fp-col-nm">${escapeHtml(name)}</div></button>`;
  };
  let html = '';
  for (const [cat, label] of [['plant', '🌿 Pflanzen'], ['insect', '🐛 Insekten']]) {
    const g = groups[cat]; if (!g || !Object.keys(g).length) continue;
    const cards = Object.values(g).map(e => card(e.sp.emoji, e.sp.name, e.finds));
    html += `<p class="fp-col-label">${label} <span class="muted">${cards.length}</span></p><div class="fp-col-grid">${cards.join('')}</div>`;
  }
  const cust = Object.values(groups._custom);
  if (cust.length) {
    const cards = cust.map(e => card((CATS[e.cat] || CATS.plant).emoji, e.name, e.finds));
    html += `<p class="fp-col-label">Weitere <span class="muted">${cards.length}</span></p><div class="fp-col-grid">${cards.join('')}</div>`;
  }
  return html;
}
function renderFriendProfile(p) {
  const span = Math.max(1, p.nextLevelXp - p.prevLevelXp);
  const pct = p.isMaxLevel ? 100 : Math.max(0, Math.min(100, Math.round(100 * (p.xp - p.prevLevelXp) / span)));
  const s = p.stats || {};
  const statCells = [
    ['Funde', s.totalFinds || 0], ['Arten', s.uniqueSpecies || 0], ['Wildblumen', s.wildflowerFinds || 0],
    ['Insekten', s.insectFinds || 0], ['Ernten', s.harvestCount || 0], ['Orte', s.distinctPlaces || 0],
    ['Jahreszeiten', `${s.seasonsCovered || 0} / 4`], ['Quests', `${s.questsCompleted || 0} / ${s.totalQuests || 0}`],
  ];
  const dexBar = (label, emoji, d) => {
    const dp = d && d.total ? Math.round(100 * d.have / d.total) : 0;
    return `<div class="fp-dex-row"><span class="fp-dex-k">${emoji} ${label}</span><div class="fp-dex-bar"><div class="fp-dex-fill" style="width:${dp}%"></div></div><span class="fp-dex-v">${d ? d.have : 0}/${d ? d.total : 0}</span></div>`;
  };
  const ach = p.achievementsUnlocked || [];
  const badges = p.seasonalBadges || [];
  const since = p.friendsSince ? fmtDate(p.friendsSince) : null;
  $('#fp-body').innerHTML = `
    <div class="fp-hero">
      <div class="fp-avatar">${p.avatar || (p.levelTitle && p.levelTitle.emoji) || '🌱'}</div>
      <h2 class="fp-name">${escapeHtml(p.name)}</h2>
      <p class="fp-title">Lv ${p.level} · ${escapeHtml(p.levelTitle ? p.levelTitle.name : '')}</p>
      <div class="xp-bar"><div class="xp-fill${p.isMaxLevel ? ' max' : ''}" style="width:${pct}%"></div></div>
      <p class="xp-label"><b>${p.xp}</b> / ${p.isMaxLevel ? '★ Max' : p.nextLevelXp} XP</p>
    </div>
    ${badges.length ? `<div class="fp-section"><h3>🏅 Saison-Abzeichen</h3><div class="fp-badge-row">${badges.map(b => `<span class="fp-badge">${b.emoji} ${escapeHtml(b.name)}</span>`).join('')}</div></div>` : ''}
    <div class="fp-section">
      <h3>📖 Sammlung</h3>
      ${dexBar('Pflanzen', '🌿', p.dex && p.dex.plant)}
      ${dexBar('Insekten', '🐛', p.dex && p.dex.insect)}
      <p class="fp-col-hint">Tippe eine Art für die Fotos 📸</p>
      ${fpCollection(p.finds)}
    </div>
    <div class="fp-section">
      <h3>📊 Statistik</h3>
      <div class="stat-grid">${statCells.map(c => `<div class="stat-cell"><b>${c[1]}</b><span>${c[0]}</span></div>`).join('')}</div>
    </div>
    <div class="fp-section">
      <h3>🏆 Errungenschaften <span class="muted">${ach.length} / ${p.achievementsTotal}</span></h3>
      ${ach.length ? `<div class="fp-ach-grid">${ach.map(a => `<div class="fp-ach" title="${escapeAttr(a.name + ' — ' + a.desc)}"><span class="fp-ach-em">${a.emoji}</span><span class="fp-ach-nm">${escapeHtml(a.name)}</span></div>`).join('')}</div>` : '<p class="empty-mini">Noch keine Errungenschaften.</p>'}
    </div>
    ${since ? `<p class="fp-since">🌱 Befreundet seit ${since}</p>` : ''}
    <button class="btn btn-soft sm fp-remove" type="button" data-fid="${p.friendshipId}" data-name="${escapeAttr(p.name)}">Freund entfernen</button>`;
  $$('.fp-col-card', friendProfileEl).forEach(btn => btn.onclick = () => {
    try { const photos = JSON.parse(btn.dataset.photos || '[]'); if (photos.length) openLightbox(photos, 0); } catch (_) {}
  });
  const rm = $('.fp-remove', friendProfileEl);
  if (rm) rm.onclick = async () => {
    if (!confirm(`${rm.dataset.name} wirklich aus deinen Freunden entfernen?`)) return;
    try {
      const r = await fetch('/api/friends/' + rm.dataset.fid, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      toast('Freund entfernt'); closeFriendProfile(); refreshFriends();
    } catch (_) { toast('⚠️ Hat nicht geklappt'); }
  };
}

// ── Start ──────────────────────────────────────────────────────
$('#capture-hint').innerHTML = window.isSecureContext
  ? 'Standort wird beim Knipsen automatisch metergenau erfasst.'
  : 'Tipp: Unterwegs mit der Kamera-App knipsen & hier importieren – der Standort steckt im Foto. Für Live-GPS die <b>HTTPS-Version</b> öffnen.';
// Rückkehr vom Verifizierungs-Link (?verified=1|expired) auswerten + URL säubern.
function handleVerifiedQuery() {
  const p = new URLSearchParams(location.search);
  const v = p.get('verified');
  if (!v) return;
  p.delete('verified');
  const clean = location.pathname + (p.toString() ? '?' + p.toString() : '') + location.hash;
  history.replaceState(null, '', clean);
  if (v === '1') setTimeout(() => toast('🌱 E-Mail bestätigt — willkommen!'), 400);
  else if (v === 'expired') setTimeout(() => toast('⚠️ Link abgelaufen — bitte neu anfordern.'), 400);
}
(async () => {
  handleVerifiedQuery();
  try {
    const r = await fetch('/api/me');
    if (r.ok) { setUser(await r.json()); hideAuth(); await loadAll(); ensureGeo(); handleHash(); }
    else showAuth();
  } catch (_) { showAuth(); }
})();
})();
