/* ════════════════════════════════════════════════════════════════
   Blütenpfad · Verwaltung — Desktop-Dashboard-Logik (CSP-konform, keine Inline-Scripts)
   ════════════════════════════════════════════════════════════════ */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const SP = window.SPECIES || [];
const spByName = {}, spBySci = {};
SP.forEach(s => {
  spByName[(s.name || '').toLowerCase()] = s;
  if (s.sci) { spBySci[s.sci.toLowerCase()] = s; const g = s.sci.split(' ')[0].toLowerCase(); if (!(g in spBySci)) spBySci[g] = s; }
});
const CAT_EMOJI = { plant: '🌿', insect: '🐛', fish: '🐟' };
const LEVEL_EMOJI = [[1, '🌱'], [5, '🌿'], [10, '🌸'], [15, '🐝'], [20, '🌻'], [25, '⭐']];
const RARITY_COLOR = { 1: '#82ad52', 2: '#6e8fd6', 3: '#a48fd0', 4: '#e9a94e' };
function levelEmoji(lv) { let e = '🌱'; for (const [n, em] of LEVEL_EMOJI) if (lv >= n) e = em; return e; }
function spMeta(name, sci) {
  let m = sci ? (spBySci[String(sci).toLowerCase()] || spBySci[String(sci).toLowerCase().split(' ')[0]]) : null;
  if (!m && name) m = spByName[String(name).toLowerCase()];
  return m || null;
}
function emojiFor(name, sci, cat) { const m = spMeta(name, sci); return (m && m.emoji) || CAT_EMOJI[cat] || '🌱'; }
const avatarFor = (u) => u.avatar || levelEmoji(u.level || 1);
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }) : '–';
function fmtRel(iso) {
  if (!iso) return '–';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (d <= 0) return 'heute'; if (d === 1) return 'gestern';
  if (d < 30) return `vor ${d} T`; if (d < 365) return `vor ${Math.floor(d / 30)} Mon`;
  return `vor ${Math.floor(d / 365)} J`;
}
function rarityGems(r) {
  r = r || 0; let s = '';
  for (let i = 1; i <= 4; i++) { const on = i <= r; const c = on ? RARITY_COLOR[r] : ''; s += `<i class="gem"${c ? ` style="background:${c}"` : ''}></i>`; }
  return `<span class="gems">${s}</span>`;
}
function questIcon(q) {
  if (q.kind === 'category' && q.category === 'insect') return '🐝';
  if (q.kind === 'category' && q.category === 'plant') return '🌷';
  if (q.kind === 'plant_wild') return '🌸';
  if (q.kind === 'plant_bloom_match') return '🌼';
  if (q.kind === 'harvest') return '🌰';
  if (q.kind === 'unique_species') return '📖';
  if (q.kind === 'distinct_locations') return '📍';
  if (q.kind === 'rare') return '✨';
  if (q.kind === 'any_in_season') return '🌿';
  return '🎯';
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; requestAnimationFrame(() => t.classList.add('show')); clearTimeout(toastT); toastT = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.hidden = true, 320); }, 2600); }

async function api(method, path, body) {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

// ── Auth ───────────────────────────────────────────────────────
function showGate(note) {
  $('#panel').hidden = true; $('#gate').hidden = false;
  if (note) { $('#gate-note').textContent = note; $('#gate-note').hidden = false; }
}
function showPanel() { $('#gate').hidden = true; $('#panel').hidden = false; }
$('#gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('#gate-user').value.trim(), password = $('#gate-pass').value;
  const err = $('#gate-err'); err.hidden = true;
  const btn = $('#gate-submit'); btn.disabled = true; const lbl = btn.textContent; btn.textContent = '…';
  const r = await api('POST', '/api/admin/login', { user, password });
  if (r.ok) { $('#gate-pass').value = ''; showPanel(); $('#who').textContent = r.data.user || ''; loadAll(); }
  else if (r.status === 503) { err.textContent = 'Admin-Panel ist nicht konfiguriert.'; err.hidden = false; }
  else { err.textContent = (r.data && r.data.error) || 'Login fehlgeschlagen'; err.hidden = false; }
  btn.disabled = false; btn.textContent = lbl;
});
$('#btn-logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout'); location.reload(); });
$('#btn-refresh').addEventListener('click', () => { loadAll(); if (catLoaded) loadCatalog(); if (questsLoaded) loadQuests(); });

// ── Navigation ─────────────────────────────────────────────────
$$('.sb-link').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
function switchView(v) {
  $$('.sb-link').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  $$('.adm-view').forEach(x => { x.hidden = x.id !== 'view-' + v; });
  if (v === 'catalog' && !catLoaded) loadCatalog();
  if (v === 'quests' && !questsLoaded) loadQuests();
  $('.main').scrollTo({ top: 0 });
}

// ── Übersicht ──────────────────────────────────────────────────
let allUsers = [], sortKey = 'lastActivity', sortDir = -1;
async function loadAll() {
  const [s, u] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/users')]);
  if (s.status === 401 || u.status === 401) { showGate(); return; }
  if (s.ok) renderStats(s.data);
  if (u.ok) { allUsers = u.data.users || []; renderUsers(); }
}
function renderStats(s) {
  const tiles = [
    { cls: 'accent-leaf', emoji: '🧍', num: s.users, label: 'Nutzer', sub: `${s.verified} verifiziert` },
    { cls: '', emoji: '✨', num: s.active7, label: 'Aktiv · 7 Tage', sub: `${s.active30} in 30 Tagen` },
    { cls: 'accent-honey', emoji: '🌼', num: s.totalFinds, label: 'Funde gesamt', sub: `🌿 ${s.plantFinds} · 🐛 ${s.insectFinds}` },
    { cls: 'accent-corn', emoji: '📖', num: s.distinctSpecies, label: 'Arten entdeckt', sub: `+${s.newWeek} neue Nutzer (7T)` },
  ];
  $('#stat-row').innerHTML = tiles.map((t, i) => `
    <div class="stat-tile ${t.cls}" style="animation-delay:${i * 0.05}s"><span class="st-emoji">${t.emoji}</span>
      <div class="st-num">${t.num}</div><div class="st-label">${t.label}</div><div class="st-sub">${t.sub}</div></div>`).join('');

  // 14-Tage-Diagramm
  const fbd = s.findsByDay || [];
  const maxD = Math.max(1, ...fbd.map(d => d.count));
  $('#fc-hint').textContent = `${fbd.reduce((a, d) => a + d.count, 0)} Funde`;
  $('#finds-chart').innerHTML = fbd.map((d, i) => {
    const h = Math.round(100 * d.count / maxD);
    return `<div class="daycol${i === fbd.length - 1 ? ' today' : ''}" title="${d.day}: ${d.count} Funde">
      <span class="dc-n">${d.count || ''}</span>
      <div class="dc-bar" style="height:${Math.max(d.count ? 6 : 2, h)}%"></div>
      <span class="dc-lbl">${parseInt(d.day.slice(8, 10), 10)}.</span></div>`;
  }).join('');

  // Top-Arten
  const top = s.topSpecies || [];
  const maxC = Math.max(1, ...top.map(t => t.count));
  $('#top-species').innerHTML = top.length ? top.map(t => `
    <div class="bar-row"><span class="bar-key"><span class="be">${emojiFor(t.name, null, t.cat)}</span>${escapeHtml(t.name)}</span>
      <div class="bar-track"><div class="bar-fill ${t.cat === 'insect' ? 'insect' : ''}" style="width:${Math.round(100 * t.count / maxC)}%"></div></div>
      <span class="bar-val">${t.count}</span></div>`).join('') : '<p class="empty">Noch keine Funde.</p>';

  // Level-Verteilung
  const dist = s.levelDist || {};
  const levels = Object.keys(dist).map(Number).sort((a, b) => a - b);
  const maxL = Math.max(1, ...levels.map(l => dist[l]));
  $('#ld-hint').textContent = `${levels.length} Stufe${levels.length !== 1 ? 'n' : ''}`;
  $('#level-dist').innerHTML = levels.length ? levels.map(l => `
    <div class="bar-row"><span class="bar-key"><span class="be">${levelEmoji(l)}</span>Lv ${l}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(100 * dist[l] / maxL)}%"></div></div>
      <span class="bar-val">${dist[l]}</span></div>`).join('') : '<p class="empty">Noch keine Daten.</p>';

  // Aktivitätsfeed
  const act = s.recentActivity || [];
  $('#activity-feed').innerHTML = act.length ? act.map(a => `
    <div class="act-item"><span class="act-av">${a.avatar || '🌱'}</span><span class="act-em">${a.emoji}</span>
      <span class="act-text"><b>${escapeHtml(a.user)}</b> entdeckte <span class="act-sp">${escapeHtml(a.species)}</span></span>
      <span class="act-time">${fmtRel(a.at)}</span></div>`).join('') : '<p class="empty">Noch keine Aktivität.</p>';

  // Kennzahlen + Split
  const coop = s.coop || { active: 0, participants: 0, total: 0 };
  $('#mini-stats').innerHTML = [
    ['✅', s.verified, 'Verifiziert'], ['🆕', s.newWeek, 'Neu (7 T)'],
    ['🤝', s.friendships, 'Freundschaften'], ['🗓️', s.active30, 'Aktiv (30 T)'],
    ['🌼', coop.active, 'Sammel-Runden aktiv'], ['🚶', coop.participants, 'Crew unterwegs'],
  ].map(([e, v, l]) => `<div class="mini"><b>${e} ${v}</b><span>${l}</span></div>`).join('');
  const pf = s.plantFinds || 0, inf = s.insectFinds || 0, tot = pf + inf;
  $('#sp-plant').textContent = pf; $('#sp-insect').textContent = inf;
  $('#split-fill').style.width = (tot ? Math.round(100 * pf / tot) : 50) + '%';
}

// Nutzer-Tabelle
$('#user-search').addEventListener('input', renderUsers);
$$('#view-overview .utable th[data-sort]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'name') ? 1 : -1; }
  renderUsers();
}));
function renderUsers() {
  const q = $('#user-search').value.trim().toLowerCase();
  let list = allUsers.filter(u => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  list.sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === 'name') { av = (a.name || a.email || '').toLowerCase(); bv = (b.name || b.email || '').toLowerCase(); }
    if (sortKey === 'emailVerified') { av = av ? 1 : 0; bv = bv ? 1 : 0; }
    if (av < bv) return -sortDir; if (av > bv) return sortDir; return 0;
  });
  $$('#view-overview .utable th[data-sort]').forEach(th => { th.classList.toggle('sorted', th.dataset.sort === sortKey); th.classList.toggle('asc', th.dataset.sort === sortKey && sortDir === 1); });
  $('#user-count').textContent = allUsers.length;
  $('#user-empty').hidden = list.length > 0;
  $('#user-rows').innerHTML = list.map(u => `
    <tr data-id="${u.id}">
      <td><div class="u-cell"><span class="u-av">${avatarFor(u)}</span><span style="min-width:0"><span class="u-name">${escapeHtml(u.name || '—')}</span><br><span class="u-mail">${escapeHtml(u.email)}</span></span></div></td>
      <td class="num"><span class="lvl-chip">${u.level}</span></td>
      <td class="num">${u.totalFinds}</td><td class="num">${u.uniqueSpecies}</td>
      <td class="num">${u.plantCount}</td><td class="num">${u.insectCount}</td><td class="num">${u.friends}</td>
      <td><span class="dim">${fmtRel(u.lastActivity)}</span></td>
      <td class="num"><span class="tick${u.emailVerified ? '' : ' no'}">${u.emailVerified ? '✓' : '–'}</span></td>
    </tr>`).join('');
  $$('#user-rows tr').forEach(tr => tr.addEventListener('click', () => openUser(tr.dataset.id)));
}

// ── Arten-Katalog ──────────────────────────────────────────────
let catalog = [], catLoaded = false, catFilter = 'all', catSort = 'name', catDir = 1;
const KIND_LABEL = { wild: 'Wildblume', garten: 'Garten' };
const catCategory = (s) => s.cat === 'insect' ? 'Insekt' : (KIND_LABEL[s.kind] || 'Pflanze');
const catPeriod = (s) => s.cat === 'plant' ? (s.bloom || '–') : (s.season || '–');
async function loadCatalog() {
  const r = await api('GET', '/api/admin/catalog');
  if (r.status === 401) { showGate(); return; } if (!r.ok) return;
  catalog = r.data.species || []; catLoaded = true;
  $('#cat-summary').textContent = `${r.data.total} Arten freischaltbar · 🌿 ${r.data.totals.plant} Pflanzen · 🐛 ${r.data.totals.insect} Insekten · ${r.data.discovered} schon mind. 1× entdeckt`;
  renderCatalog();
}
$('#cat-search').addEventListener('input', renderCatalog);
$$('#cat-filter .pill').forEach(b => b.addEventListener('click', () => {
  catFilter = b.dataset.cat; $$('#cat-filter .pill').forEach(x => x.classList.toggle('active', x === b)); renderCatalog();
}));
$$('#view-catalog .utable th[data-sort]').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  if (catSort === k) catDir = -catDir; else { catSort = k; catDir = (k === 'name' || k === 'cat' || k === 'period' || k === 'habitats') ? 1 : -1; }
  renderCatalog();
}));
function renderCatalog() {
  const q = $('#cat-search').value.trim().toLowerCase();
  let list = catalog.filter(s => {
    if (catFilter === 'plant' && s.cat !== 'plant') return false;
    if (catFilter === 'insect' && s.cat !== 'insect') return false;
    if (catFilter === 'undiscovered' && s.finds > 0) return false;
    if (q && !(s.name.toLowerCase().includes(q) || (s.sci || '').toLowerCase().includes(q) || (s.habitats || []).some(h => h.toLowerCase().includes(q)))) return false;
    return true;
  });
  list.sort((a, b) => {
    let av, bv;
    if (catSort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    else if (catSort === 'cat') { av = catCategory(a); bv = catCategory(b); }
    else if (catSort === 'period') { av = catPeriod(a); bv = catPeriod(b); }
    else if (catSort === 'habitats') { av = (a.habitats || []).join(); bv = (b.habitats || []).join(); }
    else { av = a[catSort] || 0; bv = b[catSort] || 0; }
    if (av < bv) return -catDir; if (av > bv) return catDir; return 0;
  });
  $$('#view-catalog .utable th[data-sort]').forEach(th => { th.classList.toggle('sorted', th.dataset.sort === catSort); th.classList.toggle('asc', th.dataset.sort === catSort && catDir === 1); });
  $('#cat-count').textContent = catalog.length;
  $('#cat-empty').hidden = list.length > 0;
  $('#cat-rows').innerHTML = list.map(s => `
    <tr data-id="${s.id}" class="${s.finds === 0 ? 'undisc' : ''}">
      <td><div class="u-cell"><span class="c-em" style="--c:${s.color || '#9bbf6a'}">${s.emoji || '🌱'}</span>
        <span style="min-width:0"><span class="u-name">${escapeHtml(s.name)}</span><br><span class="u-mail" style="font-style:italic">${escapeHtml(s.sci || '')}</span></span></div></td>
      <td><span class="cat-badge ${s.cat}">${s.cat === 'insect' ? '🐛' : '🌿'} ${catCategory(s)}</span></td>
      <td class="num">${rarityGems(s.rarity)}</td>
      <td class="dim">${escapeHtml(catPeriod(s))}</td>
      <td><span class="habs">${escapeHtml((s.habitats || []).join(', ') || '–')}</span></td>
      <td class="num">${s.finds}</td><td class="num">${s.users}</td>
    </tr>`).join('');
  $$('#cat-rows tr').forEach(tr => tr.addEventListener('click', () => openSpecies(tr.dataset.id)));
}

// ── Quests-Übersicht ───────────────────────────────────────────
let questsLoaded = false;
const fmtMmdd = (mmdd) => { const [m, d] = (mmdd || '').split('-'); return `${parseInt(d, 10)}.${parseInt(m, 10)}.`; };
async function loadQuests() {
  const r = await api('GET', '/api/admin/quests');
  if (r.status === 401) { showGate(); return; } if (!r.ok) return;
  questsLoaded = true; renderQuests(r.data);
}
function renderQuests(d) {
  const sets = d.sets || [];
  $('#quests-body').innerHTML = sets.map(set => {
    const active = set.code === d.activeSetCode;
    return `<section class="card qset${active ? ' active' : ''}">
      <div class="card-head">
        <h2>${set.emoji} ${escapeHtml(set.name)}${active ? '<span class="live-pill">aktiv</span>' : ''}</h2>
        <span class="card-hint">${fmtMmdd(set.from)}–${fmtMmdd(set.to)} · ${set.totalQuests} Quests · ${set.setCompletedBy}× komplett</span>
      </div>
      <div class="q-list">${set.quests.map(q => `
        <div class="q-row" data-code="${q.code}">
          <span class="q-ico">${questIcon(q)}</span>
          <span class="q-name">${escapeHtml(q.name)} <span class="q-target">Ziel ${q.target}</span></span>
          <span class="q-stat"><b>✓ ${q.completedBy}</b><span>${q.inProgress} dabei</span></span>
        </div>`).join('')}</div>
    </section>`;
  }).join('') || '<p class="empty">Keine Quest-Sets definiert.</p>';
  $$('#quests-body .q-row').forEach(row => row.addEventListener('click', () => openQuest(row.dataset.code)));
}

// ════════════════════════════════ Drill-down-Drawer ════════════════════════════════
const drawer = $('#drawer');
let drawerStack = [];
$$('#drawer [data-close]').forEach(el => el.addEventListener('click', closeDrawer));
$('#drawer-back').addEventListener('click', drawerBack);
function closeDrawer() { drawer.hidden = true; drawerStack = []; document.body.style.overflow = ''; }
function drawerBack() { drawerStack.pop(); if (drawerStack.length) renderDrawerTop(); else closeDrawer(); }
function pushDrawer(state) { drawerStack.push(state); drawer.hidden = false; document.body.style.overflow = 'hidden'; renderDrawerTop(); }
const openUser = (id) => pushDrawer({ type: 'user', id });
const openSpecies = (id) => pushDrawer({ type: 'species', id });
const openQuest = (code) => pushDrawer({ type: 'quest', code });
function renderDrawerTop() {
  const s = drawerStack[drawerStack.length - 1];
  $('#drawer-back').hidden = drawerStack.length < 2;
  $('.drawer').scrollTop = 0;
  $('#drawer-body').innerHTML = '<div class="dr-hero"><p class="dr-name" style="color:var(--ink)">Lade…</p></div>';
  if (s.type === 'user') renderUserDrawer(s.id);
  else if (s.type === 'species') renderSpeciesDrawer(s.id);
  else if (s.type === 'quest') renderQuestDrawer(s.code);
}

async function renderUserDrawer(id) {
  const r = await api('GET', '/api/admin/users/' + id);
  if (r.status === 401) { closeDrawer(); showGate(); return; }
  if (!r.ok) { $('#drawer-body').innerHTML = '<div class="dr-hero"><p class="dr-name" style="color:var(--ink)">Nicht gefunden</p></div>'; return; }
  const u = r.data;
  const plants = u.species.filter(s => s.cat === 'plant'), insects = u.species.filter(s => s.cat === 'insect');
  const others = u.species.filter(s => s.cat !== 'plant' && s.cat !== 'insect');
  const spGroup = (label, arr) => arr.length ? `<p class="sp-cat-label">${label} (${arr.length})</p><div class="sp-list">${arr.map(s => `
    <div class="sp-item${s.curated && s.id ? ' link' : ''}"${s.curated && s.id ? ` data-sp="${s.id}"` : ''}><span class="sp-em">${emojiFor(s.name, s.sci, s.cat)}</span>
      <span class="sp-info"><span class="sp-nm">${escapeHtml(s.name)}${s.rarity ? rarityGems(s.rarity) : ''}</span>${s.sci ? `<span class="sp-sci">${escapeHtml(s.sci)}</span>` : ''}</span>
      <span class="sp-count">×${s.count}${s.harvested ? ` · 🌰${s.harvested}` : ''}</span></div>`).join('')}</div>` : '';
  $('#drawer-body').innerHTML = `
    <div class="dr-hero forest">
      <div class="dr-av">${avatarFor(u)}</div>
      <h2 class="dr-name">${escapeHtml(u.name || '—')}</h2>
      <p class="dr-mail">${escapeHtml(u.email)}</p>
      <div class="dr-badges">
        <span class="dr-badge">${levelEmoji(u.level)} Lv ${u.level} · ${escapeHtml(u.levelTitle ? u.levelTitle.name : '')}</span>
        <span class="dr-badge">${u.xp} XP</span>
        <span class="dr-badge">${u.emailVerified ? '✓ verifiziert' : '✗ unbestätigt'}</span>
      </div>
    </div>
    <div class="dr-section"><h3>📋 Konto</h3><div class="dr-meta">
      <div class="m"><b>${fmtDate(u.createdAt)}</b><span>registriert</span></div>
      <div class="m"><b>${fmtRel(u.lastActivity)}</b><span>letzte Aktivität</span></div>
      <div class="m"><b>${u.totalFinds}</b><span>Funde (${u.locatedFinds} verortet)</span></div>
      <div class="m"><b>${u.uniqueSpecies}</b><span>versch. Arten</span></div>
      <div class="m"><b>${u.friends}</b><span>Freunde</span></div>
      <div class="m"><b>${u.questsCompleted}</b><span>Quests</span></div>
    </div></div>
    ${u.achievements.length ? `<div class="dr-section"><h3>🏆 Errungenschaften <span class="muted">${u.achievements.length} / ${u.achievementsTotal}</span></h3>
      <div class="ach-grid">${u.achievements.map(a => `<span class="ach-pill">${a.emoji} ${escapeHtml(a.name)}</span>`).join('')}</div></div>` : ''}
    <div class="dr-section"><h3>📖 Gescannte Arten <span class="muted">${u.species.length}</span></h3>
      ${u.species.length ? (spGroup('🌿 Pflanzen', plants) + spGroup('🐛 Insekten', insects) + spGroup('Sonstige', others)) : '<p class="empty">Noch nichts gescannt.</p>'}</div>
    <div class="dr-actions">
      <div class="row"><button class="btn btn-primary sm" id="dr-verify">${u.emailVerified ? '✗ Verifizierung aufheben' : '✓ Als verifiziert markieren'}</button></div>
      <div class="danger-zone"><p>⚠️ Konto unwiderruflich löschen (inkl. aller Funde, Fotos, Freundschaften).</p>
        <button class="btn btn-danger sm" id="dr-delete">🗑️ Konto löschen</button></div>
    </div>`;
  $$('#drawer-body .sp-item.link').forEach(el => el.addEventListener('click', () => openSpecies(el.dataset.sp)));
  $('#dr-verify').addEventListener('click', async () => {
    const rr = await api('PATCH', '/api/admin/users/' + u.id, { emailVerified: !u.emailVerified });
    if (rr.ok) { toast(u.emailVerified ? 'Verifizierung aufgehoben' : '✓ Als verifiziert markiert'); renderDrawerTop(); loadAll(); } else toast('⚠️ Konnte nicht ändern');
  });
  $('#dr-delete').addEventListener('click', async () => {
    if (!confirm(`Konto „${u.name || u.email}" wirklich endgültig löschen?`)) return;
    const rr = await api('DELETE', '/api/admin/users/' + u.id);
    if (rr.ok) { toast(`Konto gelöscht (${rr.data.deletedFinds} Funde)`); closeDrawer(); loadAll(); if (catLoaded) loadCatalog(); } else toast('⚠️ Löschen fehlgeschlagen');
  });
}

async function renderSpeciesDrawer(id) {
  const r = await api('GET', '/api/admin/species/' + id);
  if (r.status === 401) { closeDrawer(); showGate(); return; }
  if (!r.ok) { $('#drawer-body').innerHTML = '<div class="dr-hero"><p class="dr-name" style="color:var(--ink)">Nicht gefunden</p></div>'; return; }
  const s = r.data;
  const period = s.cat === 'plant' ? (s.bloom || '–') : (s.season || '–');
  const periodLabel = s.cat === 'plant' ? '🌸 Blüte' : '🗓️ Flugzeit';
  $('#drawer-body').innerHTML = `
    <div class="dr-hero" style="border-bottom:2px solid var(--border)">
      <div class="dr-av tile" style="border-color:${s.color || '#cfe3ac'}">${s.emoji || '🌱'}</div>
      <h2 class="dr-name" style="color:var(--ink)">${escapeHtml(s.name)}</h2>
      <p class="dr-sci" style="color:var(--ink-soft)">${escapeHtml(s.sci || '')}</p>
      <div class="dr-badges">
        <span class="dr-badge">${s.cat === 'insect' ? '🐛 Insekt' : (KIND_LABEL[s.kind] || 'Pflanze')}</span>
        ${s.rarity ? `<span class="dr-badge">${rarityGems(s.rarity)}</span>` : ''}
        <span class="dr-badge">${periodLabel}: ${escapeHtml(period)}</span>
      </div>
    </div>
    <div class="dr-section"><h3>🌍 Verbreitung in der App</h3><div class="dr-meta">
      <div class="m"><b>${s.totalFinds}</b><span>Funde gesamt</span></div>
      <div class="m"><b>${s.users}</b><span>Nutzer mit Fund</span></div>
    </div></div>
    ${(s.habitats && s.habitats.length) ? `<div class="dr-section"><h3>📍 Vorkommen</h3><div class="hab-chips">${s.habitats.map(h => `<span class="hab-chip">${escapeHtml(h)}</span>`).join('')}</div></div>` : ''}
    <div class="dr-section" style="padding-bottom:28px"><h3>👥 Entdeckt von <span class="muted">${s.discoverers.length} Nutzer</span></h3>
      ${s.discoverers.length ? s.discoverers.map(d => `
        <div class="dd-row" data-uid="${d.userId}"><span class="dd-av">${avatarFor(d)}</span>
          <span class="dd-info"><span class="dd-name">${escapeHtml(d.name)}</span><span class="dd-sub">Lv ${d.level} · zuletzt ${fmtRel(d.lastAt)}</span></span>
          <span class="dd-val">×${d.finds}${d.harvested ? ` · 🌰${d.harvested}` : ''}</span></div>`).join('')
        : '<p class="empty">Diese Art hat noch niemand entdeckt.</p>'}</div>`;
  $$('#drawer-body .dd-row').forEach(el => el.addEventListener('click', () => openUser(el.dataset.uid)));
}

async function renderQuestDrawer(code) {
  const r = await api('GET', '/api/admin/quests/' + code);
  if (r.status === 401) { closeDrawer(); showGate(); return; }
  if (!r.ok) { $('#drawer-body').innerHTML = '<div class="dr-hero"><p class="dr-name" style="color:var(--ink)">Nicht gefunden</p></div>'; return; }
  const q = r.data;
  $('#drawer-body').innerHTML = `
    <div class="dr-hero forest">
      <div class="dr-av tile">${questIcon(q)}</div>
      <h2 class="dr-name">${escapeHtml(q.name)}</h2>
      <p class="dr-sci">${q.setEmoji} ${escapeHtml(q.setName)}</p>
      <div class="dr-badges"><span class="dr-badge">Ziel: ${q.target}</span>
        <span class="dr-badge">✓ ${q.completed.length} geschafft</span>
        <span class="dr-badge">${q.inProgress.length} dabei</span></div>
    </div>
    <div class="dr-section"><h3>🏆 Abgeschlossen <span class="muted">${q.completed.length}</span></h3>
      ${q.completed.length ? q.completed.map(d => `
        <div class="dd-row" data-uid="${d.userId}"><span class="dd-av">${avatarFor(d)}</span>
          <span class="dd-info"><span class="dd-name">${escapeHtml(d.name)}</span><span class="dd-sub">Lv ${d.level}</span></span>
          <span class="dd-val">${fmtDate(d.completedAt)}</span></div>`).join('')
        : '<p class="empty">Noch niemand abgeschlossen.</p>'}</div>
    <div class="dr-section" style="padding-bottom:28px"><h3>⏳ In Arbeit <span class="muted">${q.inProgress.length}</span></h3>
      ${q.inProgress.length ? q.inProgress.map(d => `
        <div class="dd-row" data-uid="${d.userId}"><span class="dd-av">${avatarFor(d)}</span>
          <span class="dd-info"><span class="dd-name">${escapeHtml(d.name)}</span><span class="dd-sub">Lv ${d.level}</span></span>
          <span class="dd-prog"><span class="pb"><span class="pf" style="width:${Math.round(100 * d.progress / d.target)}%"></span></span><small>${d.progress}/${d.target}</small></span></div>`).join('')
        : '<p class="empty">Niemand gerade dabei.</p>'}</div>`;
  $$('#drawer-body .dd-row').forEach(el => el.addEventListener('click', () => openUser(el.dataset.uid)));
}

// ── Start ──────────────────────────────────────────────────────
(async () => {
  const me = await api('GET', '/api/admin/me');
  if (me.ok) { showPanel(); $('#who').textContent = me.data.user || ''; loadAll(); }
  else if (me.status === 503) showGate('Hinweis: ADMIN_USER und ADMIN_PASSWORD in /etc/bluetenpfad.env setzen, um das Panel zu aktivieren.');
  else showGate();
})();
})();
