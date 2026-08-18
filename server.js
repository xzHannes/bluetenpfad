'use strict';
/*
 * Blütenpfad — cozy Natur-Sammel-App (vorm. Streifzug)
 * ----------------------------------------------------
 * Express-Backend. Fotos liegen unter WB_MEDIA_DIR (Default /mnt/media/wildblumen
 * — historisch; Produktion nutzt /var/lib/bluetenpfad), Metadaten in SQLite,
 * GPS aus EXIF als Fallback, Pflanzen-Auto-ID via Pl@ntNet. Multi-User
 * (eigene Accounts, getrennte Sammlungen), Kategorien: Pflanze / Insekt / Fisch.
 *
 * Listener:
 *   - HTTP  WB_HTTP_PORT  (Default 8068)
 *   - HTTPS WB_HTTPS_PORT (Default 8069; 0 oder fehlende Zertifikate → aus)
 * Auf der Produktion lauscht Node nur auf 127.0.0.1:8068 hinter Caddy
 * (TRUST_PROXY=1).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const exifr = require('exifr');
const mailer = require('./lib/mailer');

// ── Konfiguration ──────────────────────────────────────────────
const HTTPS_PORT = Number(process.env.WB_HTTPS_PORT ?? 8069);
const HTTP_PORT = Number(process.env.WB_HTTP_PORT || 8068);
const HOST = process.env.WB_HOST || '0.0.0.0';
const APP_DIR = __dirname;
const MEDIA_DIR = process.env.WB_MEDIA_DIR || '/mnt/media/wildblumen';
// DATA_DIR: per ENV überschreibbar; Default ist APP_DIR/data (Dev), VPS nutzt /var/lib/bluetenpfad/data.
const DATA_DIR = process.env.WB_DATA_DIR || path.join(APP_DIR, 'data');
const CERT_DIR = process.env.WB_CERT_DIR || path.join(APP_DIR, 'certs');
const UPLOAD_DIR = path.join(MEDIA_DIR, 'uploads');
const THUMB_DIR = path.join(MEDIA_DIR, 'thumbs');
const PLANTNET_KEY = process.env.PLANTNET_API_KEY || '';
// Kindwise insect.id (optional, freischaltend für Insekten-Auto-Erkennung). Siehe ADR-015.
const INSECT_ID_KEY = process.env.INSECT_ID_API_KEY || '';
const SESSION_DAYS = 60;
const IS_PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
// Erlaubte Origins für Same-Origin/CSRF-Schutz bei mutierenden Routen.
// Default deckt Public-Domain, LAN und localhost ab; per ENV erweiterbar (Komma-getrennt).
const DEFAULT_ALLOWED = [
  'https://bluetenpfad.de',
  'https://www.bluetenpfad.de',
  'http://bluetenpfad.de',
  'http://www.bluetenpfad.de',
];
const EXTRA_ORIGINS = (process.env.WB_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED, ...EXTRA_ORIGINS]);
// Basis-URL für Verifizierungs-Links in Mails. Wenn nicht gesetzt, wird sie aus
// dem Request abgeleitet (Proto + Host) — funktioniert in Dev/LAN/Prod ohne Extra-Config.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const EMAIL_VERIFY_HOURS = 24;
// E-Mail-Bestätigung ist standardmäßig AUS (Registrierung loggt direkt ein wie zuvor).
// Erst mit EMAIL_VERIFICATION=1 + gesetztem SMTP geht das Verifizierungs-Gate scharf.
const EMAIL_VERIFICATION = process.env.EMAIL_VERIFICATION === '1' || process.env.EMAIL_VERIFICATION === 'true';

// ── Admin-Panel-Konfiguration ──────────────────────────────────
// Credentials liegen in der ENV (chmod-600-Datei, nie im Repo). Ohne ADMIN_USER +
// (ADMIN_PASSWORD | ADMIN_PASSWORD_HASH) ist das Admin-Panel komplett deaktiviert.
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_DAYS = 7;
// Optionale IP-Allowlist (Komma-getrennt). Gesetzt → nur diese IPs erreichen /api/admin/*.
const ADMIN_ALLOWED_IPS = new Set(
  (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
);

for (const d of [DATA_DIR, MEDIA_DIR, UPLOAD_DIR, THUMB_DIR]) fs.mkdirSync(d, { recursive: true });

// ── Datenbank ──────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'wildblumen.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS finds (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, taken_at TEXT,
    photo TEXT NOT NULL, thumb TEXT,
    lat REAL, lng REAL, accuracy REAL, gps_source TEXT,
    species_id TEXT, species_name TEXT, species_sci TEXT, species_src TEXT, confidence REAL,
    notes TEXT, harvested INTEGER NOT NULL DEFAULT 0, harvested_at TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  );
`);
// idempotente Migration: neue Spalten an finds anhängen
const findCols = db.prepare('PRAGMA table_info(finds)').all().map(c => c.name);
if (!findCols.includes('user_id')) db.exec('ALTER TABLE finds ADD COLUMN user_id TEXT');
if (!findCols.includes('category')) db.exec("ALTER TABLE finds ADD COLUMN category TEXT NOT NULL DEFAULT 'plant'");
// favorite: Pflanze ist auf der Samenliste — nur diese zeigen Ernte-Hinweise.
if (!findCols.includes('favorite')) db.exec('ALTER TABLE finds ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');

// Indizes (idempotent)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_finds_user ON finds(user_id);
  CREATE INDEX IF NOT EXISTS idx_finds_user_cat ON finds(user_id, category);
  CREATE INDEX IF NOT EXISTS idx_finds_user_taken ON finds(user_id, taken_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
`);

// XP + Achievements + Quests — idempotente Migration
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('xp')) db.exec('ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('level')) db.exec('ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1');
// progression_v steuert Re-Backfill bei Semantik-Wechsel (z. B. taken_at → created_at).
if (!userCols.includes('progression_v')) db.exec('ALTER TABLE users ADD COLUMN progression_v INTEGER NOT NULL DEFAULT 0');
// Avatar (Emoji) für Profil-Anzeige; null = default basierend auf Level-Titel.
if (!userCols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');

// E-Mail-Verifizierung — idempotente Migration.
// Beim erstmaligen Hinzufügen der Spalte werden ALLE bereits existierenden User
// als verifiziert markiert (grandfathering), damit Bestandskonten + Live-App nicht
// ausgesperrt werden. Neue Registrierungen starten mit email_verified=0.
if (!userCols.includes('email_verified')) {
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE users SET email_verified = 1');
}

// Friend-Code (Pokémon-GO-Stil) — eindeutig pro User, für bestehende User backfillen.
if (!userCols.includes('friend_code')) db.exec('ALTER TABLE users ADD COLUMN friend_code TEXT');

db.exec(`
  CREATE TABLE IF NOT EXISTS email_verifications (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_emailverif_user ON email_verifications(user_id);
  CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL,
    addressee_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    responded_at TEXT,
    UNIQUE(requester_id, addressee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_friend_req ON friendships(requester_id);
  CREATE INDEX IF NOT EXISTS idx_friend_addr ON friendships(addressee_id);
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    label TEXT
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS achievements (
    user_id TEXT NOT NULL,
    code TEXT NOT NULL,
    unlocked_at TEXT NOT NULL,
    PRIMARY KEY(user_id, code)
  );
  CREATE TABLE IF NOT EXISTS quest_progress (
    user_id TEXT NOT NULL,
    quest_code TEXT NOT NULL,
    set_code TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    target INTEGER NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(user_id, quest_code)
  );
  CREATE INDEX IF NOT EXISTS idx_ach_user ON achievements(user_id);
  CREATE INDEX IF NOT EXISTS idx_quest_user ON quest_progress(user_id);
  CREATE TABLE IF NOT EXISTS periodic_quests (
    user_id TEXT NOT NULL,
    period_key TEXT NOT NULL,
    quest_code TEXT NOT NULL,
    kind TEXT NOT NULL,
    category TEXT,
    target INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    PRIMARY KEY(user_id, period_key, quest_code)
  );
  CREATE INDEX IF NOT EXISTS idx_periodic_user ON periodic_quests(user_id, period_key);
  CREATE TABLE IF NOT EXISTS coop_rounds (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    host_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    bonus_pct INTEGER NOT NULL DEFAULT 20
  );
  CREATE TABLE IF NOT EXISTS coop_members (
    round_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY(round_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS coop_scans (
    round_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    species_key TEXT NOT NULL,
    species_name TEXT,
    emoji TEXT,
    category TEXT,
    find_id TEXT,
    scanned_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_coop_members_user ON coop_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_coop_scans_round ON coop_scans(round_id, species_key);
`);

// Kuratierte Arten — Single Source of Truth ist public/species.js (window.SPECIES).
// Server liest die Datei und evaluiert sie in einem isolierten Scope.
const SPECIES_LIST = (() => {
  try {
    const src = fs.readFileSync(path.join(APP_DIR, 'public', 'species.js'), 'utf-8');
    const fakeWin = {};
    new Function('window', src)(fakeWin);
    return Array.isArray(fakeWin.SPECIES) ? fakeWin.SPECIES : [];
  } catch (e) { console.error('[species] load failed:', e.message); return []; }
})();
const SPECIES_BY_ID = {};
const SPECIES_BY_SCI = {};
const SPECIES_BY_NAME = {};
for (const s of SPECIES_LIST) {
  SPECIES_BY_ID[s.id] = s;
  if (s.name) SPECIES_BY_NAME[s.name.toLowerCase()] = s;
  if (s.sci) {
    const lc = s.sci.toLowerCase();
    SPECIES_BY_SCI[lc] = s;
    const genus = lc.split(' ')[0];
    if (!SPECIES_BY_SCI[genus]) SPECIES_BY_SCI[genus] = s;
  }
}
console.log(`[species] loaded ${SPECIES_LIST.length} kuratierte Arten`);

function curatedOfRow(r) {
  if (!r) return null;
  if (r.species_id && SPECIES_BY_ID[r.species_id]) return SPECIES_BY_ID[r.species_id];
  if (r.species_name && SPECIES_BY_NAME[String(r.species_name).toLowerCase()]) return SPECIES_BY_NAME[String(r.species_name).toLowerCase()];
  if (r.species_sci) {
    const lc = String(r.species_sci).toLowerCase();
    if (SPECIES_BY_SCI[lc]) return SPECIES_BY_SCI[lc];
    const genus = lc.split(' ')[0];
    if (SPECIES_BY_SCI[genus]) return SPECIES_BY_SCI[genus];
  }
  return null;
}

// ── XP / Level / Achievements / Quests ─────────────────────────
const LEVEL_CAP = 25;
const LEVEL_TITLES = [
  [1,  '🌱', 'Spaziergänger:in'],
  [5,  '🌿', 'Naturfreund:in'],
  [10, '🌸', 'Sammler:in'],
  [15, '🐝', 'Bestäuber-Kenner:in'],
  [20, '🌻', 'Wildblumen-Expert:in'],
  [25, '⭐', 'Naturmeister:in'],
];
const xpThreshold = (lv) => lv <= 1 ? 0 : Math.floor(15 * lv * (lv + 4));
function computeLevel(xp) {
  for (let lv = LEVEL_CAP; lv >= 1; lv--) if (xp >= xpThreshold(lv)) return lv;
  return 1;
}
function levelTitleFor(lv) {
  let cur = LEVEL_TITLES[0];
  for (const t of LEVEL_TITLES) if (lv >= t[0]) cur = t;
  return { emoji: cur[1], name: cur[2] };
}

const ACHIEVEMENTS = [
  { code: 'first_find',         name: 'Erster Schritt',          desc: 'Dein erster Fund.',                       emoji: '🌱', xp: 50,  check: s => s.totalFinds        >= 1 },
  { code: 'five_species',       name: 'Sammler-Einstieg',        desc: '5 verschiedene Arten entdeckt.',           emoji: '🌼', xp: 100, check: s => s.uniqueSpecies     >= 5 },
  { code: 'ten_species',        name: 'Naturfreund:in',          desc: '10 verschiedene Arten entdeckt.',          emoji: '🌿', xp: 150, check: s => s.uniqueSpecies     >= 10 },
  { code: 'twentyfive_species', name: 'Botanikus',               desc: '25 verschiedene Arten entdeckt.',          emoji: '🌷', xp: 250, check: s => s.uniqueSpecies     >= 25 },
  { code: 'wildflower_friend',  name: 'Wildblumen-Freund:in',    desc: '10 Wildblumen-Funde.',                     emoji: '🌻', xp: 100, check: s => s.wildflowerFinds   >= 10 },
  { code: 'pollinator',         name: 'Bestäuber-Beobachter:in', desc: '5 Insekten gesichtet.',                    emoji: '🐝', xp: 100, check: s => s.insectFinds       >= 5 },
  { code: 'first_seed',         name: 'Erntehelfer:in',          desc: 'Erste Samen geerntet.',                    emoji: '🌰', xp: 75,  check: s => s.harvestCount      >= 1 },
  { code: 'rare_find',          name: 'Glückspilz',              desc: 'Eine seltene Art (★★★) entdeckt.',         emoji: '✨', xp: 150, check: s => s.rareFinds         >= 1 },
  { code: 'all_seasons',        name: 'Alle Jahreszeiten',       desc: 'Funde in Frühling, Sommer, Herbst, Winter.', emoji: '🍂', xp: 200, check: s => s.seasonsCovered  >= 4 },
  { code: 'cartographer',       name: 'Kartograph:in',           desc: 'Funde an 3 verschiedenen Orten (>500 m).', emoji: '📍', xp: 150, check: s => s.distinctPlaces    >= 3 },
  { code: 'first_quest',        name: 'Aufbruch',                desc: 'Erste Quest abgeschlossen.',               emoji: '🎯', xp: 100, check: s => s.questsCompleted   >= 1 },
  { code: 'season_master',      name: 'Saison-Meister:in',       desc: 'Ein ganzes Saison-Set abgeschlossen.',     emoji: '🏆', xp: 300, check: s => s.seasonSetsCompleted >= 1 },
];

// Saisonale Quest-Sets — pro Saison ~10 Quests in progressiver Schwierigkeit.
// Quests werden nach und nach freigeschaltet (siehe `visibleQuestsForSet`):
// max 3 aktive Quests gleichzeitig sichtbar, abgeschlossene bleiben sichtbar,
// alle weiteren sind „🔒 noch verborgen" bis die offenen abgehakt werden.
// Quest-Codes sind PERMANENT: gerade vergebene Quest-Codes nie umbenennen.
const QUEST_SETS = [
  { code: 'spring', name: 'Frühlings-Streifzug', emoji: '🌷', from: '03-01', to: '05-31',
    quests: [
      { code: 'spring_any_3',       name: '3 Funde im Frühling',          target: 3,  kind: 'any_in_season' },
      { code: 'spring_insects_3',   name: '3 Insekten beobachten',        target: 3,  kind: 'category', category: 'insect' },
      { code: 'spring_blooms_5',    name: '5 Frühblüher entdecken',       target: 5,  kind: 'plant_bloom_match', months: ['Mär','Apr','Mai'] },
      { code: 'spring_wild_3',      name: '3 Wildpflanzen finden',        target: 3,  kind: 'plant_wild' },
      { code: 'spring_species_8',   name: '8 verschiedene Arten',         target: 8,  kind: 'unique_species' },
      { code: 'spring_places_2',    name: 'Funde an 2 Orten',             target: 2,  kind: 'distinct_locations' },
      { code: 'spring_any_15',      name: '15 Funde insgesamt',           target: 15, kind: 'any_in_season' },
      { code: 'spring_rare_1',      name: 'Eine seltene Art (★★★)',       target: 1,  kind: 'rare' },
      { code: 'spring_insects_10',  name: '10 Insekten',                  target: 10, kind: 'category', category: 'insect' },
      { code: 'spring_species_20',  name: '20 verschiedene Arten',        target: 20, kind: 'unique_species' },
    ]},
  { code: 'summer', name: 'Sommer-Streifzug', emoji: '🌻', from: '06-01', to: '08-31',
    quests: [
      { code: 'summer_any_3',         name: '3 Funde im Sommer',          target: 3,  kind: 'any_in_season' },
      { code: 'summer_pollinators_5', name: '5 Bestäuber sichten',        target: 5,  kind: 'category', category: 'insect' },
      { code: 'summer_blooms_8',      name: '8 Sommerblüher',             target: 8,  kind: 'plant_bloom_match', months: ['Jun','Jul','Aug'] },
      { code: 'summer_wild_4',        name: '4 Wildpflanzen',             target: 4,  kind: 'plant_wild' },
      { code: 'summer_species_12',    name: '12 verschiedene Arten',      target: 12, kind: 'unique_species' },
      { code: 'summer_places_3',      name: 'Funde an 3 Orten',           target: 3,  kind: 'distinct_locations' },
      { code: 'summer_any_25',        name: '25 Funde insgesamt',         target: 25, kind: 'any_in_season' },
      { code: 'summer_rare_2',        name: '2 seltene Arten',            target: 2,  kind: 'rare' },
      { code: 'summer_insects_15',    name: '15 Insekten',                target: 15, kind: 'category', category: 'insect' },
      { code: 'summer_species_30',    name: '30 verschiedene Arten',      target: 30, kind: 'unique_species' },
    ]},
  { code: 'autumn', name: 'Herbst-Streifzug', emoji: '🍂', from: '09-01', to: '11-30',
    quests: [
      { code: 'autumn_any_3',         name: '3 Funde im Herbst',          target: 3,  kind: 'any_in_season' },
      { code: 'autumn_wild_3',        name: '3 Wildpflanzen finden',      target: 3,  kind: 'plant_wild' },
      { code: 'autumn_harvest_3',     name: '3 Samen ernten',             target: 3,  kind: 'harvest' },
      { code: 'autumn_species_8',     name: '8 verschiedene Arten',       target: 8,  kind: 'unique_species' },
      { code: 'autumn_places_3',      name: 'Funde an 3 Orten',           target: 3,  kind: 'distinct_locations' },
      { code: 'autumn_any_15',        name: '15 Funde im Herbst',         target: 15, kind: 'any_in_season' },
      { code: 'autumn_harvest_8',     name: '8 Samen ernten',             target: 8,  kind: 'harvest' },
      { code: 'autumn_rare_1',        name: 'Eine seltene Art (★★★)',     target: 1,  kind: 'rare' },
      { code: 'autumn_wild_8',        name: '8 Wildpflanzen',             target: 8,  kind: 'plant_wild' },
      { code: 'autumn_species_18',    name: '18 verschiedene Arten',      target: 18, kind: 'unique_species' },
    ]},
  { code: 'winter', name: 'Winter-Streifzug', emoji: '❄️', from: '12-01', to: '02-28',
    quests: [
      { code: 'winter_any_1',         name: 'Dein Winter-Streifzug — 1 Fund', target: 1,  kind: 'any_in_season' },
      { code: 'winter_any_3',         name: '3 Funde im Winter',          target: 3,  kind: 'any_in_season' },
      { code: 'winter_species_3',     name: '3 verschiedene Arten',       target: 3,  kind: 'unique_species' },
      { code: 'winter_any_6',         name: '6 Funde im Winter',          target: 6,  kind: 'any_in_season' },
      { code: 'winter_places_2',      name: 'Funde an 2 Orten',           target: 2,  kind: 'distinct_locations' },
      { code: 'winter_species_8',     name: '8 verschiedene Arten',       target: 8,  kind: 'unique_species' },
    ]},
];

function isInSeasonWindow(set, dateLike) {
  const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
  if (isNaN(d.getTime())) return false;
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (set.from <= set.to) return mmdd >= set.from && mmdd <= set.to;
  return mmdd >= set.from || mmdd <= set.to; // Winter wrap
}
function activeQuestSet(dateLike = new Date()) {
  for (const s of QUEST_SETS) if (isInSeasonWindow(s, dateLike)) return s;
  return null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function countDistinctPlaces(coords, minKm) {
  const clusters = [];
  for (const [lat, lng] of coords) {
    if (lat == null || lng == null) continue;
    let unique = true;
    for (const c of clusters) { if (haversineKm(lat, lng, c[0], c[1]) < minKm) { unique = false; break; } }
    if (unique) clusters.push([lat, lng]);
  }
  return clusters.length;
}

function userStats(userId) {
  const finds = db.prepare('SELECT * FROM finds WHERE user_id=? ORDER BY datetime(created_at) ASC').all(userId);
  const speciesKeys = new Set();
  const seasons = new Set();
  const places = [];
  let wildflowerFinds = 0, insectFinds = 0, harvestCount = 0, rareFinds = 0;
  for (const f of finds) {
    const sp = curatedOfRow(f);
    const key = (sp && sp.id) || (f.species_name && `name:${f.species_name.toLowerCase()}`) || null;
    if (key) speciesKeys.add(key);
    if (f.category === 'insect') insectFinds++;
    if (f.harvested) harvestCount++;
    if (sp && sp.kind === 'wild') wildflowerFinds++;
    if (sp && sp.rarity >= 3) rareFinds++;
    // „Jahreszeit, in der du die App benutzt hast" — wir nehmen created_at, nicht taken_at,
    // sonst zählt ein importiertes Foto aus 2023 als „Aktivität im Sommer".
    if (f.created_at) {
      const m = new Date(f.created_at).getMonth() + 1;
      seasons.add(m <= 2 || m === 12 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn');
    }
    if (f.lat != null && f.lng != null) places.push([f.lat, f.lng]);
  }
  const questsCompleted = db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE user_id=? AND completed_at IS NOT NULL').get(userId).n;
  let seasonSetsCompleted = 0;
  for (const set of QUEST_SETS) {
    const done = db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE user_id=? AND set_code=? AND completed_at IS NOT NULL').get(userId, set.code).n;
    if (done >= set.quests.length) seasonSetsCompleted++;
  }
  const totalQuests = QUEST_SETS.reduce((sum, s) => sum + s.quests.length, 0);
  return {
    totalFinds: finds.length, uniqueSpecies: speciesKeys.size,
    insectFinds, wildflowerFinds, harvestCount, rareFinds,
    seasonsCovered: seasons.size,
    distinctPlaces: countDistinctPlaces(places, 0.5),
    questsCompleted, seasonSetsCompleted,
    totalQuests,
  };
}

function grantXp(userId, delta) {
  if (!delta) return null;
  const u = db.prepare('SELECT xp, level FROM users WHERE id=?').get(userId);
  if (!u) return null;
  const newXp = (u.xp || 0) + delta;
  const after = computeLevel(newXp);
  db.prepare('UPDATE users SET xp=?, level=? WHERE id=?').run(newXp, after, userId);
  return { xp: newXp, levelBefore: u.level || 1, levelAfter: after, delta };
}

function checkAchievements(userId) {
  const stats = userStats(userId);
  const have = new Set(db.prepare('SELECT code FROM achievements WHERE user_id=?').all(userId).map(r => r.code));
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.code)) continue;
    if (a.check(stats)) {
      db.prepare('INSERT OR IGNORE INTO achievements(user_id, code, unlocked_at) VALUES(?,?,?)').run(userId, a.code, nowIso());
      grantXp(userId, a.xp);
      unlocked.push({ code: a.code, name: a.name, desc: a.desc, emoji: a.emoji, xp: a.xp });
    }
  }
  return unlocked;
}

function ensureQuestRows(userId, set) {
  for (const q of set.quests) {
    db.prepare('INSERT OR IGNORE INTO quest_progress(user_id, quest_code, set_code, progress, target) VALUES(?,?,?,?,?)')
      .run(userId, q.code, set.code, 0, q.target);
  }
}

// Inkrementelle Quest-Kinds: pro Fund-Match +1 Progress.
function findMatchesQuest(q, find, sp) {
  switch (q.kind) {
    case 'any_in_season':       return true;
    case 'category':            return find.category === q.category;
    case 'plant_wild':          return find.category === 'plant' && sp && sp.kind === 'wild';
    case 'plant_bloom_match':   return find.category === 'plant' && sp && (q.months || []).some(m => (sp.bloom || '').includes(m));
    case 'harvest':             return false;  // separater Pfad via progressHarvestQuest
    default:                    return false;  // recompute-kinds werden anders behandelt
  }
}

// Recompute-Quest-Kinds: state wird aus allen In-Season-Funden frisch berechnet.
function recomputeQuestProgress(userId, q, set) {
  const allFinds = db.prepare('SELECT * FROM finds WHERE user_id=? ORDER BY datetime(created_at) ASC').all(userId);
  const inSeason = allFinds.filter(f => isInSeasonWindow(set, f.created_at));
  switch (q.kind) {
    case 'unique_species': {
      const keys = new Set();
      for (const f of inSeason) {
        const sp = curatedOfRow(f);
        const key = (sp && sp.id) || (f.species_name && `name:${f.species_name.toLowerCase()}`) || null;
        if (key) keys.add(key);
      }
      return Math.min(keys.size, q.target);
    }
    case 'distinct_locations': {
      const coords = inSeason.filter(f => f.lat != null && f.lng != null).map(f => [f.lat, f.lng]);
      return Math.min(countDistinctPlaces(coords, 0.5), q.target);
    }
    case 'rare': {
      let count = 0;
      for (const f of inSeason) {
        const sp = curatedOfRow(f);
        if (sp && sp.rarity >= 3) count++;
      }
      return Math.min(count, q.target);
    }
    default: return 0;
  }
}

function progressQuestForFind(userId, find, asOfDate) {
  // Bestimmt das Set anhand des Find-Datums (Real-Time = jetzt; Backfill = created_at).
  const set = activeQuestSet(asOfDate);
  if (!set) return { progressed: [], setCompletedNow: false, set: null };
  if (!isInSeasonWindow(set, asOfDate)) return { progressed: [], setCompletedNow: false, set };
  ensureQuestRows(userId, set);
  const sp = curatedOfRow(find);
  const progressed = [];
  const recomputeKinds = new Set(['unique_species', 'distinct_locations', 'rare']);
  for (const q of set.quests) {
    const row = db.prepare('SELECT * FROM quest_progress WHERE user_id=? AND quest_code=?').get(userId, q.code);
    if (row.completed_at) continue;
    let newProgress;
    if (recomputeKinds.has(q.kind)) {
      newProgress = recomputeQuestProgress(userId, q, set);
    } else if (findMatchesQuest(q, find, sp)) {
      newProgress = Math.min(row.progress + 1, row.target);
    } else {
      continue;
    }
    if (newProgress <= row.progress) continue;
    const completed = newProgress >= row.target;
    db.prepare('UPDATE quest_progress SET progress=?, completed_at=? WHERE user_id=? AND quest_code=?')
      .run(newProgress, completed ? nowIso() : null, userId, q.code);
    progressed.push({ code: q.code, name: q.name, progress: newProgress, target: q.target, justCompleted: completed });
  }
  // Set komplett?
  const done = db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE user_id=? AND set_code=? AND completed_at IS NOT NULL').get(userId, set.code).n;
  const setCompletedNow = progressed.some(p => p.justCompleted) && done >= set.quests.length;
  return { progressed, setCompletedNow, set };
}

// Sichtbarkeit: alle abgeschlossenen + max 3 aktive offene; Rest „verborgen".
// `kind` und `category` werden an den Client durchgereicht, damit dort thematische
// Icons gewählt werden können (🐝 für Insekten-Quests, 🌼 für Blüten, 📍 für Orte, …).
function visibleQuestsForSet(userId, set) {
  ensureQuestRows(userId, set);
  const rows = db.prepare('SELECT quest_code, progress, target, completed_at FROM quest_progress WHERE user_id=? AND set_code=?').all(userId, set.code);
  const byCode = Object.fromEntries(rows.map(r => [r.quest_code, r]));
  const MAX_ACTIVE = 3;
  let activeShown = 0;
  let hiddenCount = 0;
  const visible = [];
  for (const q of set.quests) {
    const row = byCode[q.code] || { progress: 0, target: q.target, completed_at: null };
    const base = { code: q.code, name: q.name, kind: q.kind, category: q.category || null, progress: row.progress, target: row.target };
    if (row.completed_at) {
      visible.push({ ...base, completedAt: row.completed_at });
    } else if (activeShown < MAX_ACTIVE) {
      visible.push({ ...base, completedAt: null });
      activeShown++;
    } else {
      hiddenCount++;
    }
  }
  return { visible, total: set.quests.length, completed: rows.filter(r => r.completed_at).length, hiddenCount };
}

function progressHarvestQuest(userId, asOfDate) {
  const set = activeQuestSet(asOfDate);
  if (!set) return { progressed: [], setCompletedNow: false, set: null };
  if (!isInSeasonWindow(set, asOfDate)) return { progressed: [], setCompletedNow: false, set };
  ensureQuestRows(userId, set);
  const progressed = [];
  for (const q of set.quests) {
    if (q.kind !== 'harvest') continue;
    const row = db.prepare('SELECT * FROM quest_progress WHERE user_id=? AND quest_code=?').get(userId, q.code);
    if (row.completed_at) continue;
    const newProgress = Math.min(row.progress + 1, row.target);
    const completed = newProgress >= row.target;
    db.prepare('UPDATE quest_progress SET progress=?, completed_at=? WHERE user_id=? AND quest_code=?')
      .run(newProgress, completed ? nowIso() : null, userId, q.code);
    progressed.push({ code: q.code, name: q.name, progress: newProgress, target: q.target, justCompleted: completed });
  }
  const done = db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE user_id=? AND set_code=? AND completed_at IS NOT NULL').get(userId, set.code).n;
  const setCompletedNow = progressed.some(p => p.justCompleted) && done >= set.quests.length;
  return { progressed, setCompletedNow, set };
}

function isNewSpeciesForUser(userId, find) {
  // Find ist bereits in DB. Schau, ob das die einzige ist mit diesem Species-Schlüssel.
  const sp = curatedOfRow(find);
  if (sp && sp.id) {
    const n = db.prepare('SELECT COUNT(*) n FROM finds WHERE user_id=? AND species_id=?').get(userId, sp.id).n;
    return n <= 1;  // 1 = der gerade neue Fund
  }
  if (find.species_name) {
    const n = db.prepare('SELECT COUNT(*) n FROM finds WHERE user_id=? AND species_name=? AND (species_id IS NULL OR species_id = ?)').get(userId, find.species_name, find.species_id || '').n;
    return n <= 1;
  }
  return false;
}

// Zentrale Progression-Funktion: applies XP + Quests + Achievements für einen neuen oder geupdateten Fund.
// `event` kann 'new_find' oder 'harvest' sein.
function applyFindProgression(userId, find, event = 'new_find', asOfDate = new Date()) {
  let totalDelta = 0;
  if (event === 'new_find') {
    totalDelta += 10;
    if (isNewSpeciesForUser(userId, find)) totalDelta += 30;
  }
  // Quest-Progress
  const questResult = event === 'harvest'
    ? progressHarvestQuest(userId, asOfDate)
    : progressQuestForFind(userId, find, asOfDate);
  for (const p of questResult.progressed) if (p.justCompleted) totalDelta += 50;
  if (questResult.setCompletedNow) totalDelta += 500;
  const xpResult = grantXp(userId, totalDelta) || { xp: 0, levelBefore: 1, levelAfter: 1, delta: 0 };
  // Saison komplett → jahresgestempeltes Badge (z. B. „Frühling '26"); im Backfill mit Fund-Jahr.
  let seasonBadge = null;
  if (questResult.setCompletedNow && questResult.set) seasonBadge = grantSeasonBadge(userId, questResult.set, asOfDate);
  // Achievements (grantXp pro Unlock passiert intern)
  const unlocked = checkAchievements(userId);
  const finalUser = db.prepare('SELECT xp, level FROM users WHERE id=?').get(userId) || { xp: 0, level: 1 };
  return {
    xpDelta: totalDelta + unlocked.reduce((a, b) => a + b.xp, 0),
    levelBefore: xpResult.levelBefore,
    levelAfter: finalUser.level,
    xp: finalUser.xp,
    unlocked,
    questsProgressed: questResult.progressed,
    seasonSetCompleted: questResult.setCompletedNow,
    seasonBadge,
  };
}

// Curated-aware Erntereife-Zählung: nur unharvested Wildpflanzen, deren Samen-Zeitraum
// den aktuellen Monat überdeckt. Fallback auf 0 bei Custom-Pflanzen ohne kurierte Daten.
const MONTH_NUM = { 'Jan':1,'Feb':2,'Mär':3,'Mrz':3,'Apr':4,'Mai':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Okt':10,'Nov':11,'Dez':12 };
function isMonthInGermanRange(rangeStr, m) {
  if (!rangeStr) return false;
  const parts = String(rangeStr).split(/[–\-]/).map(s => s.trim());
  const a = MONTH_NUM[parts[0]], b = MONTH_NUM[parts[parts.length - 1]];
  if (!a || !b) return false;
  return a <= b ? (m >= a && m <= b) : (m >= a || m <= b);
}
function countToHarvest(userId) {
  const finds = db.prepare("SELECT * FROM finds WHERE user_id=? AND harvested=0 AND favorite=1 AND category='plant'").all(userId);
  const m = new Date().getMonth() + 1;
  let n = 0;
  for (const f of finds) {
    const sp = curatedOfRow(f);
    if (!sp || sp.kind !== 'wild' || !sp.seed) continue;
    if (isMonthInGermanRange(sp.seed, m)) n++;
  }
  return n;
}

// Backfill / Re-Backfill: läuft, wenn `users.progression_v` < aktueller Version.
// Bei Schema-/Semantik-Änderung Version bumpen — alle betroffenen User werden gewipet
// und mit der neuen Logik chronologisch (via created_at) durchgerechnet.
const PROGRESSION_V = 4;
function backfillProgression() {
  const users = db.prepare('SELECT id FROM users WHERE progression_v < ?').all(PROGRESSION_V);
  for (const u of users) {
    const finds = db.prepare('SELECT * FROM finds WHERE user_id=? ORDER BY datetime(created_at) ASC').all(u.id);
    // Wipe vorhandenen Progression-State (idempotent, falls vorher v1 lief)
    db.prepare('UPDATE users SET xp = 0, level = 1 WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM achievements WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM quest_progress WHERE user_id = ?').run(u.id);
    let unlockedTotal = 0;
    for (const f of finds) {
      // Bewusst created_at, nicht taken_at — Quest-Set richtet sich danach, wann
      // der Fund in der App eingetragen wurde („deine Aktivität diese Saison").
      const asOf = new Date(f.created_at);
      const r = applyFindProgression(u.id, f, 'new_find', asOf);
      unlockedTotal += r.unlocked.length;
      if (f.harvested && f.harvested_at) {
        const r2 = applyFindProgression(u.id, f, 'harvest', new Date(f.harvested_at));
        unlockedTotal += r2.unlocked.length;
      }
    }
    db.prepare('UPDATE users SET progression_v = ? WHERE id = ?').run(PROGRESSION_V, u.id);
    const final = db.prepare('SELECT xp, level FROM users WHERE id=?').get(u.id);
    console.log(`[backfill v${PROGRESSION_V}] user=${u.id} finds=${finds.length} → xp=${final.xp} lv=${final.level} achievements=${unlockedTotal}`);
  }
}

// ── Saison-Abschluss-Badges (jahresgestempelt, z. B. „Frühling '26") ────
const SEASON_NAMES = { spring: 'Frühling', summer: 'Sommer', autumn: 'Herbst', winter: 'Winter' };
const SEASON_BADGE_EMOJI = { spring: '🌷', summer: '🌻', autumn: '🍂', winter: '❄️' };
function grantSeasonBadge(userId, set, asOfDate) {
  const year = (asOfDate instanceof Date ? asOfDate : new Date(asOfDate)).getFullYear();
  const code = `season_${set.code}_${year}`;
  const had = db.prepare('SELECT 1 FROM achievements WHERE user_id=? AND code=?').get(userId, code);
  db.prepare('INSERT OR IGNORE INTO achievements(user_id, code, unlocked_at) VALUES(?,?,?)').run(userId, code, nowIso());
  if (had) return null;
  return { code, season: set.code, year, name: `${SEASON_NAMES[set.code] || set.code} '${String(year).slice(2)}`, emoji: SEASON_BADGE_EMOJI[set.code] || '🏅' };
}
function seasonalBadgesFor(userId) {
  const rows = db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id=?').all(userId);
  const out = [];
  for (const r of rows) {
    const m = r.code.match(/^season_(spring|summer|autumn|winter)_(\d{4})$/);
    if (!m) continue;
    out.push({ code: r.code, season: m[1], year: m[2], name: `${SEASON_NAMES[m[1]]} '${m[2].slice(2)}`, emoji: SEASON_BADGE_EMOJI[m[1]], earnedAt: r.unlocked_at });
  }
  return out.sort((a, b) => String(b.earnedAt).localeCompare(String(a.earnedAt)));
}

// ── Daily- / Weekly-Quests ─────────────────────────────────────
// Recompute-basiert (kein inkrementeller Drift): Fortschritt wird aus den Funden im
// jeweiligen Zeitfenster frisch berechnet. Läuft NUR für Echtzeit-Funde, nicht im Backfill.
const DAILY_POOL = [
  { code: 'd_any_1', name: 'Mach heute deinen ersten Fund', target: 1, kind: 'any' },
  { code: 'd_any_3', name: '3 Funde heute', target: 3, kind: 'any' },
  { code: 'd_species_2', name: '2 verschiedene Arten heute', target: 2, kind: 'distinct_species' },
  { code: 'd_plant_2', name: '2 Pflanzen heute entdecken', target: 2, kind: 'category', category: 'plant' },
  { code: 'd_insect_1', name: 'Ein Insekt heute beobachten', target: 1, kind: 'category', category: 'insect' },
  { code: 'd_new_1', name: 'Eine neue Art für die Sammlung', target: 1, kind: 'new_species' },
];
const WEEKLY_POOL = [
  { code: 'w_any_8', name: '8 Funde diese Woche', target: 8, kind: 'any' },
  { code: 'w_species_6', name: '6 verschiedene Arten diese Woche', target: 6, kind: 'distinct_species' },
  { code: 'w_plant_5', name: '5 Pflanzen diese Woche', target: 5, kind: 'category', category: 'plant' },
  { code: 'w_insect_3', name: '3 Insekten diese Woche', target: 3, kind: 'category', category: 'insect' },
  { code: 'w_new_3', name: '3 neue Arten entdecken', target: 3, kind: 'new_species' },
  { code: 'w_harvest_2', name: '2 Samen ernten', target: 2, kind: 'harvest' },
  { code: 'w_places_2', name: 'Funde an 2 verschiedenen Orten', target: 2, kind: 'distinct_locations' },
];
const PERIODIC_BY_CODE = {};
for (const q of [...DAILY_POOL, ...WEEKLY_POOL]) PERIODIC_BY_CODE[q.code] = q;
const DAILY_COUNT = 3, WEEKLY_COUNT = 3, DAILY_XP = 20, WEEKLY_XP = 60;

function isoWeek(monday) {
  const thursday = new Date(monday.getTime() + 3 * 864e5);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 864e5 / 7) + 1;
  return { year, week };
}
function dayPeriod(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = d.toISOString(), end = new Date(d.getTime() + 864e5).toISOString();
  return { key: 'd:' + start.slice(0, 10), start, end, resetAt: end };
}
function weekPeriod(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - dow * 864e5);
  const start = monday.toISOString(), end = new Date(monday.getTime() + 7 * 864e5).toISOString();
  const { year, week } = isoWeek(monday);
  return { key: `w:${year}-W${String(week).padStart(2, '0')}`, start, end, resetAt: end };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function pickFromPool(pool, count, seedStr) {
  const idx = pool.map((_, i) => i);
  let seed = hashStr(seedStr);
  const rng = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, count).map(i => pool[i]);
}
function ensurePeriodicQuests(userId, now = new Date()) {
  for (const [pool, count, period] of [[DAILY_POOL, DAILY_COUNT, dayPeriod(now)], [WEEKLY_POOL, WEEKLY_COUNT, weekPeriod(now)]]) {
    const n = db.prepare('SELECT COUNT(*) n FROM periodic_quests WHERE user_id=? AND period_key=?').get(userId, period.key).n;
    if (n > 0) continue;
    for (const q of pickFromPool(pool, count, period.key + ':' + userId.slice(0, 8))) {
      db.prepare('INSERT OR IGNORE INTO periodic_quests(user_id,period_key,quest_code,kind,category,target,progress) VALUES(?,?,?,?,?,?,0)')
        .run(userId, period.key, q.code, q.kind, q.category || null, q.target);
    }
  }
}
function recomputePeriodic(userId, row, period) {
  const all = db.prepare('SELECT * FROM finds WHERE user_id=?').all(userId);
  const inWindow = all.filter(f => f.created_at >= period.start && f.created_at < period.end);
  switch (row.kind) {
    case 'any': return inWindow.length;
    case 'category': return inWindow.filter(f => (f.category || 'plant') === row.category).length;
    case 'distinct_species': {
      const keys = new Set();
      for (const f of inWindow) { const sp = curatedOfRow(f); const k = (sp && sp.id) || (f.species_name && 'n:' + f.species_name.toLowerCase()); if (k) keys.add(k); }
      return keys.size;
    }
    case 'new_species': {
      // Arten, deren ALLERERSTER Fund des Users in diesem Zeitfenster liegt.
      const firstAt = {};
      for (const f of all) {
        const sp = curatedOfRow(f); const k = (sp && sp.id) || (f.species_name && 'n:' + f.species_name.toLowerCase()); if (!k) continue;
        if (!firstAt[k] || f.created_at < firstAt[k]) firstAt[k] = f.created_at;
      }
      return Object.values(firstAt).filter(t => t >= period.start && t < period.end).length;
    }
    case 'harvest':
      return all.filter(f => f.harvested && f.harvested_at && f.harvested_at >= period.start && f.harvested_at < period.end).length;
    case 'distinct_locations': {
      const coords = inWindow.filter(f => f.lat != null && f.lng != null).map(f => [f.lat, f.lng]);
      return countDistinctPlaces(coords, 0.5);
    }
    default: return 0;
  }
}
// Aktualisiert die laufenden Daily/Weekly-Quests (Recompute + XP für neu abgeschlossene). Echtzeit only.
function refreshPeriodicQuests(userId, now = new Date()) {
  ensurePeriodicQuests(userId, now);
  const dp = dayPeriod(now), wp = weekPeriod(now);
  const rows = db.prepare('SELECT * FROM periodic_quests WHERE user_id=? AND (period_key=? OR period_key=?)').all(userId, dp.key, wp.key);
  const completedNow = [];
  let xpGain = 0;
  for (const row of rows) {
    const period = row.period_key.startsWith('d:') ? dp : wp;
    const np = Math.min(recomputePeriodic(userId, row, period), row.target);
    const done = np >= row.target;
    if (np !== row.progress || (done && !row.completed_at)) {
      db.prepare('UPDATE periodic_quests SET progress=?, completed_at=? WHERE user_id=? AND period_key=? AND quest_code=?')
        .run(np, done ? (row.completed_at || nowIso()) : null, userId, row.period_key, row.quest_code);
      if (done && !row.completed_at) {
        const isDaily = row.period_key.startsWith('d:');
        xpGain += isDaily ? DAILY_XP : WEEKLY_XP;
        const t = PERIODIC_BY_CODE[row.quest_code] || {};
        completedNow.push({ code: row.quest_code, name: t.name || row.quest_code, period: isDaily ? 'daily' : 'weekly', xp: isDaily ? DAILY_XP : WEEKLY_XP });
      }
    }
  }
  if (xpGain) grantXp(userId, xpGain);
  return completedNow;
}
function periodicQuestsView(userId, period) {
  const rows = db.prepare('SELECT * FROM periodic_quests WHERE user_id=? AND period_key=?').all(userId, period.key);
  return {
    resetAt: period.resetAt,
    quests: rows.map(r => { const t = PERIODIC_BY_CODE[r.quest_code] || {}; return { code: r.quest_code, name: t.name || r.quest_code, kind: r.kind, category: r.category, progress: r.progress, target: r.target, completed: !!r.completed_at }; }),
  };
}

// ── Helfer: Auth / Cookies / Passwörter ────────────────────────
const nowIso = () => new Date().toISOString();

// ── Friend-Codes ───────────────────────────────────────────────
// 8 Zeichen aus einem eindeutigen Alphabet (ohne I/L/O/0/1 — verwechslungssicher).
// Gespeichert wird die rohe 8er-Form; Anzeige als XXXX-XXXX.
const FC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function rawFriendCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += FC_ALPHABET[bytes[i] % FC_ALPHABET.length];
  return out;
}
function generateUniqueFriendCode() {
  for (let i = 0; i < 20; i++) {
    const code = rawFriendCode();
    if (!db.prepare('SELECT 1 FROM users WHERE friend_code=?').get(code)) return code;
  }
  // Extrem unwahrscheinlich; als Fallback länger machen.
  return rawFriendCode() + rawFriendCode().slice(0, 4);
}
const formatFriendCode = (raw) => raw ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
const normalizeFriendCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function backfillFriendCodes() {
  const rows = db.prepare('SELECT id FROM users WHERE friend_code IS NULL').all();
  for (const r of rows) {
    db.prepare('UPDATE users SET friend_code=? WHERE id=?').run(generateUniqueFriendCode(), r.id);
  }
  if (rows.length) console.log(`[friend-code] backfilled ${rows.length} user(s)`);
  // Eindeutigkeit auch auf DB-Ebene absichern (erst nach Backfill, sonst Kollision mit NULLs).
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friendcode ON users(friend_code)'); } catch (_) {}
}

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function hashPw(pw) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(pw, salt, 64); return salt.toString('hex') + ':' + h.toString('hex'); }
function verifyPw(pw, stored) {
  try {
    const [s, h] = String(stored).split(':');
    const hash = Buffer.from(h, 'hex');
    const test = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
    return test.length === hash.length && crypto.timingSafeEqual(test, hash);
  } catch (_) { return false; }
}
function parseCookies(req) {
  const out = {}; const c = req.headers.cookie; if (!c) return out;
  c.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(token, userId, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 864e5).toISOString());
  // Gelegenheits-Cleanup abgelaufener Sessions (kein Hot-Path, daher hier ok).
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); } catch (_) {}
  return token;
}
function userFromReq(req) {
  const t = parseCookies(req).sid; if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(t);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(t); return null; }
  return db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id) || null;
}
function isSecureReq(req) {
  // hinter Caddy: req.secure spiegelt X-Forwarded-Proto, wenn trust proxy aktiv
  return req.secure === true || req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
}
function setSid(req, res, token) {
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureReq(req),
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
}

// ── Admin-Auth (getrennt von User-Sessions) ────────────────────
const adminConfigured = () => !!(ADMIN_USER && (ADMIN_PASSWORD || ADMIN_PASSWORD_HASH));
function verifyAdminPassword(input) {
  input = String(input || '');
  if (ADMIN_PASSWORD_HASH) return verifyPw(input, ADMIN_PASSWORD_HASH);
  if (ADMIN_PASSWORD) {
    // konstante Länge + konstante Zeit (kein Längen-Leak).
    const a = crypto.createHash('sha256').update(input).digest();
    const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}
function createAdminSession(label) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO admin_sessions(token,created_at,expires_at,label) VALUES(?,?,?,?)')
    .run(token, new Date(now).toISOString(), new Date(now + ADMIN_SESSION_DAYS * 864e5).toISOString(), label || null);
  try { db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(new Date().toISOString()); } catch (_) {}
  return token;
}
function adminFromReq(req) {
  const t = parseCookies(req).bp_admin; if (!t) return null;
  const s = db.prepare('SELECT * FROM admin_sessions WHERE token=?').get(t);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) { db.prepare('DELETE FROM admin_sessions WHERE token=?').run(t); return null; }
  return s;
}
function adminIpOk(req) {
  if (ADMIN_ALLOWED_IPS.size === 0) return true;
  return ADMIN_ALLOWED_IPS.has(req.ip);
}
function setAdminCookie(req, res, token) {
  res.cookie('bp_admin', token, {
    httpOnly: true, sameSite: 'strict', secure: isSecureReq(req),
    maxAge: ADMIN_SESSION_DAYS * 864e5, path: '/',
  });
}
function requireAdmin(req, res, next) {
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin-Panel ist nicht konfiguriert.' });
  if (!adminIpOk(req)) return res.status(403).json({ error: 'Zugriff von dieser IP nicht erlaubt.' });
  if (!adminFromReq(req)) return res.status(401).json({ error: 'nicht als Admin angemeldet' });
  next();
}

// ── Express ────────────────────────────────────────────────────
const app = express();
if (TRUST_PROXY) app.set('trust proxy', 'loopback');

// Helmet mit Blütenpfad-CSP (Leaflet inline-style, GBIF, CartoCDN, Google Fonts erlaubt).
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: [
        "'self'", 'data:', 'blob:',
        'https://*.basemaps.cartocdn.com',
        'https://tile.openstreetmap.org',
        'https://*.tile.openstreetmap.org',
        'https://api.gbif.org',
        'https://tile.gbif.org',
      ],
      connectSrc: [
        "'self'",
        'https://api.gbif.org',
        'https://tile.gbif.org',
      ],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

app.use(express.json({ limit: '2mb' }));

// Admin-Bereich: nie cachen, nie indexieren (gilt für /admin*, /admin.js/.css, /api/admin*).
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});

// Statische App-Shell (frontend), aber NICHT mehr /uploads + /thumbs.
app.use(express.static(path.join(APP_DIR, 'public'), { extensions: ['html'] }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// User aus Session auflösen, an req hängen.
app.use((req, res, next) => { const u = userFromReq(req); req.user = u || null; req.userId = u ? u.id : null; next(); });
function requireAuth(req, res, next) { if (!req.userId) return res.status(401).json({ error: 'nicht angemeldet' }); next(); }

// ── CSRF/Origin-Check für mutierende Routen ────────────────────
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!MUTATING.has(req.method)) return next();
  // Health/Status sind GET-only; alles unterhalb /api/* + reine POSTs gilt.
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';
  // Default: Same-Origin oder bekannte Allowlist.
  const hostHdr = req.get('host') || '';
  const sameOriginCandidates = [
    `http://${hostHdr}`,
    `https://${hostHdr}`,
  ];
  const candidate = origin || (referer ? new URL(referer).origin : '');
  if (!candidate) {
    // Manche Clients (curl ohne Header) schicken nichts. Nur strikt sein, wenn Cookie da ist:
    // ohne Origin und ohne Referer ist's also "CLI-Style" — erlaubt, sofern kein Browser-Kontext.
    return next();
  }
  if (sameOriginCandidates.includes(candidate) || ALLOWED_ORIGINS.has(candidate)) return next();
  // LAN-Dev: 192.168.* / 10.* / 127.0.0.1 / localhost / *.local
  try {
    const u = new URL(candidate);
    if (
      u.hostname === 'localhost' ||
      u.hostname.endsWith('.local') ||
      /^127\./.test(u.hostname) ||
      /^192\.168\./.test(u.hostname) ||
      /^10\./.test(u.hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(u.hostname)
    ) return next();
  } catch (_) {}
  return res.status(403).json({ error: 'Origin abgelehnt' });
});

// ── Rate-Limits ────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,                   // 20 Auth-Versuche pro IP / 15 Min
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche. Bitte später nochmal probieren.' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,                   // 10 Registrations pro IP / Stunde
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Registrierungen von dieser IP. Bitte später nochmal probieren.' },
});
const identifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,                   // 60 Pl@ntNet-Calls / Stunde / IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Erkennungs-Limit erreicht. Bitte später erneut.' },
});
const friendReqLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,                   // 40 Freundes-Code-Versuche / 15 Min / IP (Anti-Enumeration)
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte kurz warten.' },
});
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,                    // 5 Admin-Login-Versuche / 15 Min / IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche. Bitte später erneut.' },
});

// ── Foto-Auslieferung mit Ownership-Check ──────────────────────
function findByIdForUser(req) {
  const r = db.prepare('SELECT * FROM finds WHERE id=?').get(req.params.id);
  if (!r) return null;
  if (r.user_id === req.userId) return r;
  // Bestätigte Freunde dürfen die Fotos der Sammlung sehen (Koordinaten liefert dieser Endpoint ohnehin nicht).
  if (r.user_id && acceptedFriendship(req.userId, r.user_id)) return r;
  return null;   // sonst 404, nicht 403, gegen Enumeration
}
function streamMedia(res, absPath) {
  if (!absPath || !fs.existsSync(absPath)) return res.status(404).end();
  // Kurzer Cache: Fotos können nachträglich gecroppt werden, der Browser soll innerhalb
  // einer Minute die neue Version sehen ohne dass wir Cache-Buster überall einbauen müssen.
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(absPath);
}
function safeJoin(base, name) {
  // hartes Pfad-Traversal-Verbot: erlaubte Namen sind UUID + optional _t / .jpg
  if (!name || typeof name !== 'string') return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return null;
  return resolved;
}
app.get('/media/finds/:id/photo', requireAuth, (req, res) => {
  const r = findByIdForUser(req);
  if (!r) return res.status(404).json({ error: 'nicht gefunden' });
  return streamMedia(res, safeJoin(UPLOAD_DIR, r.photo));
});
app.get('/media/finds/:id/thumb', requireAuth, (req, res) => {
  const r = findByIdForUser(req);
  if (!r) return res.status(404).json({ error: 'nicht gefunden' });
  if (r.thumb) return streamMedia(res, safeJoin(THUMB_DIR, r.thumb));
  return streamMedia(res, safeJoin(UPLOAD_DIR, r.photo));
});
// Alte /uploads + /thumbs Routen: Auth-Wall (Backwards-kompatibel, aber geschützt).
function legacyMedia(req, res, baseDir) {
  if (!req.userId) return res.status(401).json({ error: 'nicht angemeldet' });
  const filename = req.params[0] || '';
  const abs = safeJoin(baseDir, filename);
  if (!abs) return res.status(400).json({ error: 'ungültiger Pfad' });
  // Owner-Check über den Find-Namen (UUID-prefix vor .jpg / _t.jpg)
  const m = filename.match(/^([0-9a-fA-F-]{8,})(_t)?\.[a-zA-Z0-9]+$/);
  const findId = m ? m[1] : null;
  if (!findId) return res.status(404).end();
  const r = db.prepare('SELECT user_id FROM finds WHERE id=?').get(findId);
  if (!r || r.user_id !== req.userId) return res.status(404).end();
  return streamMedia(res, abs);
}
app.get(/^\/uploads\/(.+)$/, (req, res) => legacyMedia(req, res, UPLOAD_DIR));
app.get(/^\/thumbs\/(.+)$/,  (req, res) => legacyMedia(req, res, THUMB_DIR));

// Row → Frontend-Find. URLs zeigen jetzt auf den geschützten Endpoint.
const rowToFind = (r) => ({
  id: r.id, createdAt: r.created_at, takenAt: r.taken_at, category: r.category || 'plant',
  photo: `/media/finds/${r.id}/photo`,
  thumb: `/media/finds/${r.id}/thumb`,
  lat: r.lat, lng: r.lng, accuracy: r.accuracy, gpsSource: r.gps_source,
  speciesId: r.species_id, speciesName: r.species_name, speciesSci: r.species_sci,
  speciesSrc: r.species_src, confidence: r.confidence,
  notes: r.notes, harvested: !!r.harvested, harvestedAt: r.harvested_at,
  favorite: !!r.favorite,
});

// ── Pl@ntNet ───────────────────────────────────────────────────
async function identifyWithPlantNet(buffer, filename) {
  if (!PLANTNET_KEY) return null;
  try {
    const form = new FormData();
    form.append('organs', 'flower');
    form.append('images', new Blob([buffer]), filename || 'photo.jpg');
    const url = `https://my-api.plantnet.org/v2/identify/all?include-related-images=false&no-reject=false&lang=de&api-key=${PLANTNET_KEY}`;
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) return null;
    const data = await res.json();
    const top = data.results && data.results[0];
    if (!top) return null;
    const common = (top.species.commonNames && top.species.commonNames[0]) || top.species.scientificNameWithoutAuthor;
    return { name: common, sci: top.species.scientificNameWithoutAuthor, confidence: top.score };
  } catch (e) { console.error('[plantnet]', e.message); return null; }
}

// ── Kindwise insect.id ─────────────────────────────────────────
// JSON-API mit base64-Bildern; Response-Shape: data.result.classification.suggestions[].
// Falls Kindwise das Schema später ändert, Anpassung hier — Aufrufer-Vertrag bleibt
// { name, sci, confidence } (analog zu Pl@ntNet).
async function identifyWithInsectId(buffer, _filename) {
  if (!INSECT_ID_KEY) return null;
  try {
    const b64 = buffer.toString('base64');
    const url = 'https://insect.kindwise.com/api/v1/identification?details=common_names,taxonomy&language=de';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': INSECT_ID_KEY },
      body: JSON.stringify({ images: [`data:image/jpeg;base64,${b64}`] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[insect.id] HTTP', res.status, body.slice(0, 300));
      return null;
    }
    const data = await res.json();
    // Wenn Kindwise sagt „das ist gar kein Insekt", keinen Vorschlag zurückgeben.
    const isIns = data && data.result && data.result.is_insect;
    if (isIns && isIns.binary === false) return null;
    const top = data && data.result && data.result.classification && data.result.classification.suggestions && data.result.classification.suggestions[0];
    if (!top) return null;
    const sci = top.name || null;
    const common = (top.details && Array.isArray(top.details.common_names) && top.details.common_names[0]) || sci;
    return { name: common, sci, confidence: top.probability };
  } catch (e) { console.error('[insect.id]', e.message); return null; }
}

// Kategoriebasierter Dispatcher
async function identifyByCat(category, buffer, filename) {
  if (category === 'plant') return identifyWithPlantNet(buffer, filename);
  if (category === 'insect') return identifyWithInsectId(buffer, filename);
  return null;
}
function identifySrcFor(category) {
  if (category === 'plant') return 'plantnet';
  if (category === 'insect') return 'insect.id';
  return null;
}
function identifyEnabledFor(category) {
  if (category === 'plant') return !!PLANTNET_KEY;
  if (category === 'insect') return !!INSECT_ID_KEY;
  return false;
}

// ── E-Mail-Verifizierung ───────────────────────────────────────
function baseUrlFor(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  const proto = isSecureReq(req) ? 'https' : (req.protocol || 'http');
  const host = req.get('host') || 'localhost';
  return `${proto}://${host}`;
}
// Erzeugt (frisches) Token, verschickt die Verifizierungs-Mail bzw. fällt auf einen
// loggbaren Link zurück, wenn kein SMTP konfiguriert ist. Gibt im Fallback die URL
// zurück (devUrl), sonst null.
async function issueVerification(user, req) {
  db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO email_verifications(token,user_id,email,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(token, user.id, user.email, new Date(now).toISOString(), new Date(now + EMAIL_VERIFY_HOURS * 3600e3).toISOString());
  const url = `${baseUrlFor(req)}/verify?token=${token}`;
  if (mailer.isConfigured()) {
    const { subject, text, html } = mailer.verificationEmail(user.name, url);
    try {
      await mailer.sendMail({ to: user.email, subject, text, html });
      return null;
    } catch (err) {
      console.error('[mailer] send failed:', err.message);
      // Versand fehlgeschlagen: Link wenigstens loggen, damit nichts verloren geht.
      console.log(`[verify] (Versand fehlgeschlagen) Link für ${user.email}: ${url}`);
      return null;
    }
  }
  // Kein SMTP konfiguriert → Dev-/Fallback-Modus: Link loggen UND an den Client geben,
  // damit niemand ausgesperrt wird, solange noch kein Mailserver hinterlegt ist.
  console.log(`[verify] SMTP nicht konfiguriert — Bestätigungslink für ${user.email}:\n  ${url}`);
  return url;
}

// ── Auth-API ───────────────────────────────────────────────────
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  const e = String(email || '').trim().toLowerCase();
  if (!e || !/.+@.+\..+/.test(e)) return res.status(400).json({ error: 'Bitte eine gültige E-Mail angeben' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Passwort braucht mind. 6 Zeichen' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(e)) return res.status(409).json({ error: 'Diese E-Mail ist schon registriert' });
  const first = db.prepare('SELECT COUNT(*) n FROM users').get().n === 0;
  const id = crypto.randomUUID();
  const displayName = (name || '').trim() || e.split('@')[0];
  // Bei deaktivierter Verifizierung gilt das Konto sofort als verifiziert (Verhalten wie früher).
  const verified = EMAIL_VERIFICATION ? 0 : 1;
  db.prepare('INSERT INTO users(id,email,name,pass_hash,created_at,email_verified,friend_code) VALUES(?,?,?,?,?,?,?)')
    .run(id, e, displayName, hashPw(password), nowIso(), verified, generateUniqueFriendCode());
  if (first) db.prepare('UPDATE finds SET user_id=? WHERE user_id IS NULL').run(id); // erste Registrierung übernimmt herrenlose Funde
  if (!EMAIL_VERIFICATION) {
    // Verifizierung aus → direkt einloggen wie bisher.
    setSid(req, res, createSession(id));
    return res.json({ id, email: e, name: displayName });
  }
  // Verifizierung an → KEIN Auto-Login: erst nach Bestätigung wird eine Session erstellt.
  const devUrl = await issueVerification({ id, email: e, name: displayName }, req);
  res.json({ pending: true, email: e, name: displayName, devVerifyUrl: devUrl });
});
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!u || !verifyPw(password || '', u.pass_hash)) return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });
  if (EMAIL_VERIFICATION && !u.email_verified) return res.status(403).json({ error: 'email_not_verified', email: u.email });
  setSid(req, res, createSession(u.id));
  res.json({ id: u.id, email: u.email, name: u.name });
});
// Verifizierungs-Link aus der Mail: Token einlösen, einloggen, in die App leiten.
app.get('/verify', (req, res) => {
  const token = String(req.query.token || '');
  const row = token ? db.prepare('SELECT * FROM email_verifications WHERE token=?').get(token) : null;
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    if (row) db.prepare('DELETE FROM email_verifications WHERE token=?').run(token);
    return res.redirect('/?verified=expired');
  }
  db.prepare('UPDATE users SET email_verified=1 WHERE id=?').run(row.user_id);
  db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(row.user_id);
  setSid(req, res, createSession(row.user_id));
  res.redirect('/?verified=1');
});
// Bestätigungsmail erneut anfordern. Keine Existenz-Leaks → immer ok.
app.post('/api/auth/resend', authLimiter, async (req, res) => {
  const e = String((req.body || {}).email || '').trim().toLowerCase();
  let devUrl = null;
  if (e && /.+@.+\..+/.test(e)) {
    const u = db.prepare('SELECT id, email, name, email_verified FROM users WHERE email=?').get(e);
    if (u && !u.email_verified) devUrl = await issueVerification(u, req);
  }
  res.json({ ok: true, devVerifyUrl: devUrl });
});
app.post('/api/auth/logout', (req, res) => {
  const t = parseCookies(req).sid; if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  // alle abgelaufenen Sessions mit-purgen
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()); } catch (_) {}
  res.clearCookie('sid', { path: '/' }); res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'nicht angemeldet' });
  res.json({
    id: req.user.id, email: req.user.email, name: req.user.name,
    emailVerified: !!req.user.email_verified,
    friendCode: formatFriendCode(req.user.friend_code),
  });
});

// DSGVO Art. 20 — strukturiertes JSON-Export aller eigenen Daten.
app.get('/api/me/export', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, email, name, avatar, xp, level, created_at FROM users WHERE id=?').get(req.userId);
  if (!u) return res.status(404).json({ error: 'unbekannt' });
  const finds = db.prepare(`SELECT id, category, created_at, taken_at, lat, lng, accuracy, gps_source,
      species_id, species_name, species_sci, species_src, confidence, notes, harvested, harvested_at,
      photo, thumb FROM finds WHERE user_id=? ORDER BY datetime(created_at) ASC`).all(req.userId);
  // Photo-URLs zum Selbst-Herunterladen — Bytes sind nicht im JSON enthalten, sonst wird's riesig.
  const findsExport = finds.map(f => ({
    ...f,
    photo_url: `/media/finds/${f.id}/photo`,
    thumb_url: f.thumb ? `/media/finds/${f.id}/thumb` : null,
    photo: undefined, thumb: undefined,
  }));
  const achievements = db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id=?').all(req.userId);
  const quests = db.prepare('SELECT quest_code, set_code, progress, target, completed_at FROM quest_progress WHERE user_id=?').all(req.userId);
  const data = {
    exportDate: nowIso(),
    note: 'Diese Datei enthält alle deine bei Blütenpfad gespeicherten Daten (Art. 20 DSGVO). Fotos sind nicht in dieser Datei enthalten — sie liegen unter den photo_url/thumb_url-Pfaden, solange dein Konto besteht. Lade die Fotos vor einer evtl. Kontolöschung separat herunter.',
    user: u,
    finds: findsExport,
    achievements,
    quest_progress: quests,
  };
  const safeEmail = (u.email || 'data').replace(/[^a-z0-9_.@-]/gi, '_');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bluetenpfad-export-${safeEmail}-${new Date().toISOString().slice(0,10)}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// DSGVO Art. 17 — vollständige Kontolöschung inkl. Foto-Files.
app.delete('/api/me', requireAuth, (req, res) => {
  const userId = req.userId;
  try {
    const finds = db.prepare('SELECT photo, thumb FROM finds WHERE user_id=?').all(userId);
    for (const f of finds) {
      if (f.photo) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.photo)); } catch (_) {} }
      if (f.thumb) { try { fs.unlinkSync(path.join(THUMB_DIR, f.thumb)); } catch (_) {} }
    }
    db.prepare('DELETE FROM finds WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM achievements WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM quest_progress WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM periodic_quests WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM friendships WHERE requester_id=? OR addressee_id=?').run(userId, userId);
    db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    res.clearCookie('sid', { path: '/' });
    console.log(`[gdpr-delete] user=${userId} finds=${finds.length} → fully removed`);
    res.json({ ok: true, deletedFinds: finds.length });
  } catch (e) { console.error('[gdpr-delete]', e); res.status(500).json({ error: e.message }); }
});

// ── Funde-API (pro User) ───────────────────────────────────────
app.get('/api/finds', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM finds WHERE user_id=? ORDER BY datetime(COALESCE(taken_at, created_at)) DESC').all(req.userId);
  res.json(rows.map(rowToFind));
});
app.get('/api/stats', requireAuth, (req, res) => {
  // MVP zählt nur sichtbare Kategorien (siehe /api/config). Fische bleiben im Datenmodell,
  // tauchen aber nicht in den UI-Totals auf.
  const total = db.prepare("SELECT COUNT(*) n FROM finds WHERE user_id=? AND category IN ('plant','insect')").get(req.userId).n;
  const species = db.prepare("SELECT COUNT(DISTINCT COALESCE(species_id, species_name)) n FROM finds WHERE user_id=? AND species_name IS NOT NULL AND category IN ('plant','insect')").get(req.userId).n;
  const toHarvest = countToHarvest(req.userId);
  res.json({ total, species, toHarvest });
});
app.post('/api/finds', requireAuth, upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), async (req, res) => {
  try {
    const photoFile = req.files && req.files.photo && req.files.photo[0];
    if (!photoFile) return res.status(400).json({ error: 'kein Foto' });
    const thumbFile = req.files && req.files.thumb && req.files.thumb[0];
    let meta = {}; try { meta = JSON.parse(req.body.meta || '{}'); } catch (_) {}
    const category = ['plant', 'insect', 'fish'].includes(meta.category) ? meta.category : 'plant';

    const id = crypto.randomUUID();
    const photoName = id + '.jpg';
    const thumbName = thumbFile ? id + '_t.jpg' : null;
    fs.writeFileSync(path.join(UPLOAD_DIR, photoName), photoFile.buffer);
    if (thumbFile) fs.writeFileSync(path.join(THUMB_DIR, thumbName), thumbFile.buffer);

    let lat = num(meta.lat), lng = num(meta.lng), accuracy = num(meta.accuracy);
    let gpsSource = meta.gpsSource || null;
    let takenAt = meta.takenAt || null;
    if (lat == null || lng == null || takenAt == null) {
      try {
        const ex = await exifr.parse(photoFile.buffer, { gps: true });
        if (ex) {
          if ((lat == null || lng == null) && ex.latitude != null && ex.longitude != null) { lat = ex.latitude; lng = ex.longitude; gpsSource = 'exif'; }
          if (!takenAt && (ex.DateTimeOriginal || ex.CreateDate)) takenAt = new Date(ex.DateTimeOriginal || ex.CreateDate).toISOString();
        }
      } catch (_) {}
    }

    let species = { name: meta.speciesName || null, sci: meta.speciesSci || null, id: meta.speciesId || null, src: meta.speciesSrc || null, confidence: num(meta.confidence) };
    if (!species.name && identifyEnabledFor(category) && meta.autoIdentify !== false) {
      const r = await identifyByCat(category, photoFile.buffer, photoName);
      if (r) species = { name: r.name, sci: r.sci, id: null, src: identifySrcFor(category), confidence: r.confidence };
    }

    db.prepare(`INSERT INTO finds
      (id, user_id, category, created_at, taken_at, photo, thumb, lat, lng, accuracy, gps_source,
       species_id, species_name, species_sci, species_src, confidence, notes, harvested)
      VALUES (@id,@user_id,@category,@created_at,@taken_at,@photo,@thumb,@lat,@lng,@accuracy,@gps_source,
       @species_id,@species_name,@species_sci,@species_src,@confidence,@notes,0)`).run({
      id, user_id: req.userId, category, created_at: nowIso(), taken_at: takenAt, photo: photoName, thumb: thumbName,
      lat, lng, accuracy, gps_source: gpsSource,
      species_id: species.id, species_name: species.name, species_sci: species.sci, species_src: species.src, confidence: species.confidence,
      notes: meta.notes || null,
    });
    const row = db.prepare('SELECT * FROM finds WHERE id=?').get(id);
    let progression = null;
    try { progression = applyFindProgression(req.userId, row, 'new_find'); }
    catch (e) { console.error('[progression]', e.message); }
    try { const pc = refreshPeriodicQuests(req.userId); if (progression) progression.periodicCompleted = pc; }
    catch (e) { console.error('[periodic]', e.message); }
    try {
      const coop = coopRecordFind(req.userId, row, progression ? progression.xpDelta : 0);
      if (coop && progression) { progression.coop = coop; if (coop.bonusXp) { progression.xpDelta += coop.bonusXp; progression.xp += coop.bonusXp; } }
    } catch (e) { console.error('[coop]', e.message); }
    res.json({ ...rowToFind(row), progression });
  } catch (e) { console.error('[create]', e); res.status(500).json({ error: e.message }); }
});

// eigenen Fund holen (mit Besitz-Prüfung)
function ownFind(req, res) {
  const r = db.prepare('SELECT * FROM finds WHERE id=?').get(req.params.id);
  if (!r || r.user_id !== req.userId) { res.status(404).json({ error: 'nicht gefunden' }); return null; }
  return r;
}
app.patch('/api/finds/:id', requireAuth, (req, res) => {
  const r = ownFind(req, res); if (!r) return;
  const b = req.body || {};
  const harvested = b.harvested != null ? (b.harvested ? 1 : 0) : r.harvested;
  const justHarvested = harvested && !r.harvested;
  db.prepare(`UPDATE finds SET species_id=@sid, species_name=@sname, species_sci=@ssci, species_src=@ssrc,
      notes=@notes, harvested=@harv, harvested_at=@hat, favorite=@fav, lat=@lat, lng=@lng, gps_source=@gpssrc, accuracy=@acc WHERE id=@id`).run({
    id: r.id,
    sid: b.speciesId !== undefined ? b.speciesId : r.species_id,
    sname: b.speciesName !== undefined ? b.speciesName : r.species_name,
    ssci: b.speciesSci !== undefined ? b.speciesSci : r.species_sci,
    ssrc: b.speciesSrc !== undefined ? b.speciesSrc : r.species_src,
    notes: b.notes !== undefined ? b.notes : r.notes,
    harv: harvested,
    hat: justHarvested ? nowIso() : (harvested ? r.harvested_at : null),
    fav: b.favorite != null ? (b.favorite ? 1 : 0) : r.favorite,
    lat: b.lat !== undefined ? b.lat : r.lat,
    lng: b.lng !== undefined ? b.lng : r.lng,
    gpssrc: b.gpsSource !== undefined ? b.gpsSource : r.gps_source,
    acc: b.accuracy !== undefined ? b.accuracy : r.accuracy,
  });
  const updated = db.prepare('SELECT * FROM finds WHERE id=?').get(r.id);
  let progression = null;
  if (justHarvested) {
    try { progression = applyFindProgression(req.userId, updated, 'harvest'); }
    catch (e) { console.error('[progression-harvest]', e.message); }
    try { const pc = refreshPeriodicQuests(req.userId); if (progression) progression.periodicCompleted = pc; }
    catch (e) { console.error('[periodic]', e.message); }
  }
  res.json({ ...rowToFind(updated), progression });
});
app.delete('/api/finds/:id', requireAuth, (req, res) => {
  const r = ownFind(req, res); if (!r) return;
  db.prepare('DELETE FROM finds WHERE id=?').run(r.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, r.photo)); } catch (_) {}
  if (r.thumb) { try { fs.unlinkSync(path.join(THUMB_DIR, r.thumb)); } catch (_) {} }
  res.json({ ok: true });
});
// Foto eines bestehenden Funds ersetzen (z. B. nach nachträglichem Crop im Edit-Sheet).
// Schreibt das vorhandene Photo-File / Thumb-File auf der Disk neu — IDs bleiben gleich,
// dadurch wirken die /media/finds/:id/(photo|thumb)-URLs sofort nach Cache-Refresh.
app.post('/api/finds/:id/photo', requireAuth, upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), (req, res) => {
  const r = ownFind(req, res); if (!r) return;
  const photoFile = req.files && req.files.photo && req.files.photo[0];
  if (!photoFile) return res.status(400).json({ error: 'kein Foto' });
  const thumbFile = req.files && req.files.thumb && req.files.thumb[0];
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, r.photo), photoFile.buffer);
    if (thumbFile) {
      let thumbName = r.thumb;
      if (!thumbName) {
        thumbName = r.id + '_t.jpg';
        db.prepare('UPDATE finds SET thumb=? WHERE id=?').run(thumbName, r.id);
      }
      fs.writeFileSync(path.join(THUMB_DIR, thumbName), thumbFile.buffer);
    }
    res.json({ ok: true });
  } catch (e) { console.error('[replace-photo]', e); res.status(500).json({ error: e.message }); }
});

app.post('/api/finds/:id/identify', requireAuth, identifyLimiter, async (req, res) => {
  const r = ownFind(req, res); if (!r) return;
  const cat = r.category || 'plant';
  if (!identifyEnabledFor(cat)) return res.status(400).json({ error: 'für diese Kategorie ist keine Auto-Erkennung konfiguriert' });
  const buf = fs.readFileSync(path.join(UPLOAD_DIR, r.photo));
  const result = await identifyByCat(cat, buf, r.photo);
  if (!result) return res.status(502).json({ error: 'keine Erkennung' });
  db.prepare('UPDATE finds SET species_name=?, species_sci=?, species_src=?, confidence=? WHERE id=?').run(result.name, result.sci, identifySrcFor(cat), result.confidence, r.id);
  res.json(rowToFind(db.prepare('SELECT * FROM finds WHERE id=?').get(r.id)));
});

// Erkennung ohne Speichern (Live-Vorschlag im Sheet). Kategorie per Query (`?cat=plant|insect`).
app.post('/api/identify', requireAuth, identifyLimiter, upload.single('photo'), async (req, res) => {
  const cat = (req.query.cat === 'insect') ? 'insect' : 'plant';
  if (!identifyEnabledFor(cat)) return res.json({});
  if (!req.file) return res.status(400).json({ error: 'kein Foto' });
  const r = await identifyByCat(cat, req.file.buffer, req.file.originalname || 'photo.jpg');
  res.json(r || {});
});

app.get('/api/config', (req, res) => res.json({ plantnet: !!PLANTNET_KEY, insect: !!INSECT_ID_KEY, fish: false }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Profil / XP / Achievements / Quests ────────────────────────
app.get('/api/profile', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id, email, name, avatar, xp, level, friend_code, email_verified FROM users WHERE id=?').get(req.userId);
  if (!u) return res.status(404).json({ error: 'unbekannt' });
  const stats = userStats(req.userId);
  const lv = u.level || computeLevel(u.xp || 0);
  const title = levelTitleFor(lv);
  const prev = xpThreshold(lv);
  const next = lv >= LEVEL_CAP ? prev : xpThreshold(lv + 1);
  const have = db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id=?').all(req.userId);
  const haveMap = Object.fromEntries(have.map(r => [r.code, r.unlocked_at]));
  const achievements = ACHIEVEMENTS.map(a => ({
    code: a.code, name: a.name, desc: a.desc, emoji: a.emoji, xp: a.xp,
    unlocked: !!haveMap[a.code],
    unlockedAt: haveMap[a.code] || null,
  }));
  res.json({
    name: u.name || u.email || 'Sammler:in',
    email: u.email,
    avatar: u.avatar || null,
    friendCode: formatFriendCode(u.friend_code),
    emailVerified: !!u.email_verified,
    xp: u.xp || 0, level: lv, levelTitle: title,
    prevLevelXp: prev, nextLevelXp: next, isMaxLevel: lv >= LEVEL_CAP,
    stats,
    achievements,
    seasonalBadges: seasonalBadgesFor(req.userId),
  });
});

// Profil-Updates (Avatar, ggf. Name) — winziger Endpoint, bewusst ohne Multi-Field-Pattern.
app.patch('/api/profile', requireAuth, (req, res) => {
  const b = req.body || {};
  const updates = {};
  if (b.avatar !== undefined) {
    if (b.avatar !== null && (typeof b.avatar !== 'string' || b.avatar.length > 8)) {
      return res.status(400).json({ error: 'avatar muss ein Emoji-String (≤ 8 Zeichen) oder null sein' });
    }
    updates.avatar = b.avatar;
  }
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.length > 64) return res.status(400).json({ error: 'name ungültig' });
    updates.name = b.name.trim() || null;
  }
  for (const [k, v] of Object.entries(updates)) {
    db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, req.userId);
  }
  res.json({ ok: true });
});

app.get('/api/quests', requireAuth, (req, res) => {
  const now = new Date();
  try { refreshPeriodicQuests(req.userId, now); } catch (e) { console.error('[periodic]', e.message); }
  const daily = periodicQuestsView(req.userId, dayPeriod(now));
  const weekly = periodicQuestsView(req.userId, weekPeriod(now));
  const set = activeQuestSet(now);
  let season;
  if (set) {
    const result = visibleQuestsForSet(req.userId, set);
    season = {
      activeSet: { code: set.code, name: set.name, emoji: set.emoji, from: set.from, to: set.to },
      quests: result.visible, totalQuests: result.total, completedCount: result.completed, hiddenCount: result.hiddenCount,
    };
  } else {
    season = { activeSet: null, quests: [], totalQuests: 0, completedCount: 0, hiddenCount: 0 };
  }
  res.json({ daily, weekly, season });
});

// ── Freunde ────────────────────────────────────────────────────
// Kompakte Anzeige-Infos eines Users (für Listen/Anfragen).
function friendBrief(userId) {
  const u = db.prepare('SELECT id, name, email, avatar, xp, level FROM users WHERE id=?').get(userId);
  if (!u) return null;
  const lv = u.level || computeLevel(u.xp || 0);
  return {
    userId: u.id,
    name: u.name || (u.email ? u.email.split('@')[0] : 'Sammler:in'),
    avatar: u.avatar || null,
    level: lv,
    levelTitle: levelTitleFor(lv),
  };
}
// Dex-Stand je Kategorie (entdeckte kuratierte Arten / kuratierte Arten gesamt).
function dexCountsFor(userId) {
  const finds = db.prepare("SELECT species_id, species_sci, species_name, category FROM finds WHERE user_id=?").all(userId);
  const byCat = {};       // kuratierte Art-IDs
  const customByCat = {}; // benannte Custom-Arten (Name-Key) — wachsen mit der Sammlung
  for (const f of finds) {
    const sp = curatedOfRow(f);
    const cat = f.category || 'plant';
    if (sp) (byCat[sp.cat] ||= new Set()).add(sp.id);
    else if (f.species_name) (customByCat[cat] ||= new Set()).add(String(f.species_name).toLowerCase());
  }
  const totalByCat = {};
  for (const s of SPECIES_LIST) totalByCat[s.cat] = (totalByCat[s.cat] || 0) + 1;
  const out = {};
  for (const cat of ['plant', 'insect']) {
    const customN = customByCat[cat] ? customByCat[cat].size : 0;
    out[cat] = { have: (byCat[cat] ? byCat[cat].size : 0) + customN, total: (totalByCat[cat] || 0) + customN };
  }
  return out;
}
// Freund-Profil: Aggregate + Sammlung MIT Fotos (Freunde dürfen die Sammlung sehen),
// aber WEITERHIN OHNE E-Mail und OHNE Koordinaten (Standort bleibt privat).
function friendPublicProfile(userId, since) {
  const u = db.prepare('SELECT id, name, email, avatar, xp, level FROM users WHERE id=?').get(userId);
  if (!u) return null;
  const stats = userStats(userId);
  const lv = u.level || computeLevel(u.xp || 0);
  const prev = xpThreshold(lv);
  const next = lv >= LEVEL_CAP ? prev : xpThreshold(lv + 1);
  const have = db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id=?').all(userId);
  const haveMap = Object.fromEntries(have.map(r => [r.code, r.unlocked_at]));
  const achievements = ACHIEVEMENTS
    .filter(a => haveMap[a.code])
    .map(a => ({ code: a.code, name: a.name, desc: a.desc, emoji: a.emoji, xp: a.xp, unlockedAt: haveMap[a.code] }));
  // Funde für die Sammlungsansicht — mit Foto-/Thumb-URLs (geschützter Endpoint erlaubt Freunde),
  // aber ohne lat/lng. Nur sichtbare Kategorien (Pflanze/Insekt).
  const findRows = db.prepare(`SELECT * FROM finds WHERE user_id=? AND category IN ('plant','insect')
    ORDER BY datetime(COALESCE(taken_at, created_at)) DESC`).all(userId);
  const finds = findRows.map(r => ({
    id: r.id, category: r.category || 'plant',
    speciesId: r.species_id, speciesName: r.species_name, speciesSci: r.species_sci,
    photo: `/media/finds/${r.id}/photo`, thumb: `/media/finds/${r.id}/thumb`,
    takenAt: r.taken_at || r.created_at, harvested: !!r.harvested,
  }));
  return {
    userId: u.id,
    name: u.name || (u.email ? u.email.split('@')[0] : 'Sammler:in'),
    avatar: u.avatar || null,
    xp: u.xp || 0, level: lv, levelTitle: levelTitleFor(lv),
    prevLevelXp: prev, nextLevelXp: next, isMaxLevel: lv >= LEVEL_CAP,
    stats,
    achievementsUnlocked: achievements,
    achievementsTotal: ACHIEVEMENTS.length,
    seasonalBadges: seasonalBadgesFor(userId),
    dex: dexCountsFor(userId),
    finds,
    friendsSince: since || null,
  };
}
// Bestätigte Freundschaft zwischen zwei Usern finden (egal welche Richtung).
function acceptedFriendship(a, b) {
  return db.prepare(`SELECT * FROM friendships WHERE status='accepted'
    AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`).get(a, b, b, a);
}

app.get('/api/friends', requireAuth, (req, res) => {
  const me = req.userId;
  const u = db.prepare('SELECT friend_code FROM users WHERE id=?').get(me);
  const rows = db.prepare('SELECT * FROM friendships WHERE requester_id=? OR addressee_id=?').all(me, me);
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const otherId = r.requester_id === me ? r.addressee_id : r.requester_id;
    const brief = friendBrief(otherId);
    if (!brief) continue;
    const entry = { ...brief, friendshipId: r.id, createdAt: r.created_at };
    if (r.status === 'accepted') { entry.since = r.responded_at || r.created_at; friends.push(entry); }
    else if (r.addressee_id === me) incoming.push(entry);
    else outgoing.push(entry);
  }
  friends.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  res.json({ code: formatFriendCode(u && u.friend_code), friends, incoming, outgoing });
});

app.post('/api/friends/request', requireAuth, friendReqLimiter, (req, res) => {
  const me = req.userId;
  const code = normalizeFriendCode((req.body || {}).code);
  if (code.length < 6) return res.status(400).json({ error: 'Bitte einen gültigen Freundescode eingeben' });
  const target = db.prepare('SELECT id, name FROM users WHERE friend_code=?').get(code);
  if (!target) return res.status(404).json({ error: 'Diesen Freundescode gibt es nicht 🤔' });
  if (target.id === me) return res.status(400).json({ error: 'Das ist dein eigener Code 🙂' });

  const existing = db.prepare(`SELECT * FROM friendships
    WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)`).get(me, target.id, target.id, me);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Ihr seid schon Freunde 🌿' });
    if (existing.requester_id === me) return res.status(409).json({ error: 'Deine Anfrage läuft schon — warte auf die Bestätigung.' });
    // Reziprok: die andere Person hat MICH bereits angefragt → direkt annehmen.
    db.prepare("UPDATE friendships SET status='accepted', responded_at=? WHERE id=?").run(nowIso(), existing.id);
    return res.json({ status: 'accepted', friend: friendBrief(target.id) });
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO friendships(id,requester_id,addressee_id,status,created_at) VALUES(?,?,?,?,?)')
    .run(id, me, target.id, 'pending', nowIso());
  res.json({ status: 'pending', friend: friendBrief(target.id) });
});

app.post('/api/friends/:id/accept', requireAuth, (req, res) => {
  const me = req.userId;
  const r = db.prepare('SELECT * FROM friendships WHERE id=?').get(req.params.id);
  if (!r || r.addressee_id !== me) return res.status(404).json({ error: 'Anfrage nicht gefunden' });
  if (r.status === 'accepted') return res.json({ ok: true, friend: friendBrief(r.requester_id) });
  db.prepare("UPDATE friendships SET status='accepted', responded_at=? WHERE id=?").run(nowIso(), r.id);
  res.json({ ok: true, friend: friendBrief(r.requester_id) });
});

// Ablehnen / Anfrage zurückziehen / Freund entfernen — jeweils nur als Beteiligte:r.
app.delete('/api/friends/:id', requireAuth, (req, res) => {
  const me = req.userId;
  const r = db.prepare('SELECT * FROM friendships WHERE id=?').get(req.params.id);
  if (!r || (r.requester_id !== me && r.addressee_id !== me)) return res.status(404).json({ error: 'nicht gefunden' });
  db.prepare('DELETE FROM friendships WHERE id=?').run(r.id);
  res.json({ ok: true });
});

app.get('/api/friends/:userId/profile', requireAuth, (req, res) => {
  const me = req.userId;
  const otherId = req.params.userId;
  const fr = acceptedFriendship(me, otherId);
  if (!fr) return res.status(403).json({ error: 'Nur Profile bestätigter Freunde sind sichtbar.' });
  const prof = friendPublicProfile(otherId, fr.responded_at || fr.created_at);
  if (!prof) return res.status(404).json({ error: 'Profil nicht gefunden' });
  prof.friendshipId = fr.id;
  res.json(prof);
});

// ── Sammel-Runde (Co-op-Lobby) ─────────────────────────────────
// Temporäre Lobby für gemeinsame Spaziergänge: Bonus-XP, geteilte Co-op-Quests.
// Geteilt werden NUR Name/Avatar/Level + Artennamen — keine Fotos, keine Koordinaten.
const COOP_DEFAULT_HOURS = 6;
const COOP_BONUS_PCT = 20;
const COOP_SYNC_TARGET = 3;
function coopGenCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne I,O,0,1
  for (let attempt = 0; attempt < 20; attempt++) {
    let c = '';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += alphabet[bytes[i] % alphabet.length];
    if (!db.prepare('SELECT 1 FROM coop_rounds WHERE code=?').get(c)) return c;
  }
  return crypto.randomUUID().slice(0, 6).toUpperCase();
}
function coopExpireLazy() {
  db.prepare("UPDATE coop_rounds SET status='ended' WHERE status='active' AND ends_at < ?").run(nowIso());
}
function coopActiveRoundFor(userId) {
  coopExpireLazy();
  return db.prepare(`SELECT r.* FROM coop_rounds r JOIN coop_members m ON m.round_id=r.id
    WHERE m.user_id=? AND r.status='active' AND r.ends_at >= ? ORDER BY r.created_at DESC LIMIT 1`).get(userId, nowIso());
}
function coopMembers(roundId) {
  const rows = db.prepare('SELECT user_id FROM coop_members WHERE round_id=? ORDER BY joined_at').all(roundId);
  return rows.map(r => friendBrief(r.user_id)).filter(Boolean);
}
function coopSpeciesKeyFor(row) {
  const sp = curatedOfRow(row);
  if (sp) return { key: 'sp:' + sp.id, name: sp.name, emoji: sp.emoji, cat: sp.cat };
  if (row.species_name) return { key: 'nm:' + String(row.species_name).toLowerCase(), name: row.species_name, emoji: (row.category === 'insect' ? '🐛' : '🌿'), cat: row.category || 'plant' };
  return null;
}
// Pro Art: welche (distinct) Mitglieder haben sie in dieser Runde gescannt?
function coopSpeciesMap(roundId, memberIds) {
  const memberSet = new Set(memberIds);
  const scans = db.prepare('SELECT user_id, species_key, species_name, emoji, category FROM coop_scans WHERE round_id=?').all(roundId);
  const map = new Map();
  for (const s of scans) {
    if (!memberSet.has(s.user_id)) continue; // ausgetretene Mitglieder ignorieren
    let e = map.get(s.species_key);
    if (!e) { e = { key: s.species_key, name: s.species_name, emoji: s.emoji, cat: s.category, by: new Set() }; map.set(s.species_key, e); }
    e.by.add(s.user_id);
  }
  return map;
}
function coopQuestState(round, members) {
  const n = members.length;
  const map = coopSpeciesMap(round.id, members.map(m => m.userId));
  const species = [...map.values()];
  const synced = species.filter(s => n >= 2 && s.by.size >= n);
  const syncing = species.filter(s => s.by.size < n && s.by.size >= 1)
    .map(s => ({ key: s.key, name: s.name, emoji: s.emoji, have: s.by.size, need: n }))
    .sort((a, b) => b.have - a.have).slice(0, 6);
  const variety = species.length;
  const hasPlant = species.some(s => s.cat === 'plant');
  const hasInsect = species.some(s => s.cat === 'insect');
  const varietyTarget = Math.max(6, n * 4);
  const quests = [
    { code: 'sync', emoji: '🤝', name: 'Synchron-Sichtung',
      desc: `Findet ${COOP_SYNC_TARGET} Arten, die alle in der Crew scannen.`,
      progress: Math.min(synced.length, COOP_SYNC_TARGET), target: COOP_SYNC_TARGET },
    { code: 'variety', emoji: '🌈', name: 'Crew-Vielfalt',
      desc: `Sammelt zusammen ${varietyTarget} verschiedene Arten.`,
      progress: Math.min(variety, varietyTarget), target: varietyTarget },
    { code: 'duo', emoji: '🐝', name: 'Bestäuber-Duo',
      desc: 'Scannt als Crew je eine Pflanze und ein Insekt.',
      progress: (hasPlant ? 1 : 0) + (hasInsect ? 1 : 0), target: 2 },
  ].map(q => ({ ...q, done: q.progress >= q.target }));
  return { quests, syncing, syncedCount: synced.length };
}
function coopRecentScans(roundId, memberIds) {
  const memberSet = new Set(memberIds);
  const rows = db.prepare('SELECT user_id, species_name, emoji, scanned_at FROM coop_scans WHERE round_id=? ORDER BY scanned_at DESC LIMIT 12').all(roundId);
  const out = [];
  for (const r of rows) {
    if (!memberSet.has(r.user_id)) continue;
    const b = friendBrief(r.user_id);
    out.push({ name: r.species_name, emoji: r.emoji, by: b ? b.name : 'Crew', at: r.scanned_at });
    if (out.length >= 8) break;
  }
  return out;
}
function coopRoundState(round, viewerId) {
  const members = coopMembers(round.id);
  const qs = coopQuestState(round, members);
  return {
    active: true,
    id: round.id, code: round.code, hostId: round.host_id,
    isHost: round.host_id === viewerId,
    endsAt: round.ends_at, bonusPct: round.bonus_pct,
    members,
    quests: qs.quests, syncing: qs.syncing,
    recent: coopRecentScans(round.id, members.map(m => m.userId)),
  };
}
// Beim Anlegen eines Funds aufgerufen: Scan protokollieren + Bonus-XP. Liefert Bonus-Info oder null.
function coopRecordFind(userId, row, baseXpDelta) {
  const round = coopActiveRoundFor(userId);
  if (!round) return null;
  const sk = coopSpeciesKeyFor(row);
  if (sk) {
    const dup = db.prepare('SELECT 1 FROM coop_scans WHERE round_id=? AND user_id=? AND species_key=?').get(round.id, userId, sk.key);
    if (!dup) {
      db.prepare('INSERT INTO coop_scans(round_id,user_id,species_key,species_name,emoji,category,find_id,scanned_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(round.id, userId, sk.key, sk.name, sk.emoji, sk.cat, row.id, nowIso());
    }
  }
  let bonusXp = 0;
  if (baseXpDelta > 0 && round.bonus_pct > 0) {
    bonusXp = Math.round(baseXpDelta * round.bonus_pct / 100);
    if (bonusXp > 0) grantXp(userId, bonusXp);
  }
  return { roundId: round.id, bonusXp, bonusPct: round.bonus_pct };
}

const coopLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte kurz warten.' },
});

app.get('/api/coop/current', requireAuth, (req, res) => {
  const round = coopActiveRoundFor(req.userId);
  if (!round) return res.json({ active: false });
  res.json(coopRoundState(round, req.userId));
});

app.post('/api/coop/rounds', requireAuth, coopLimiter, (req, res) => {
  const existing = coopActiveRoundFor(req.userId);
  if (existing) return res.json(coopRoundState(existing, req.userId)); // schon in einer Runde → diese zurückgeben
  const id = crypto.randomUUID();
  const code = coopGenCode();
  const now = nowIso();
  const endsAt = new Date(Date.now() + COOP_DEFAULT_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO coop_rounds(id,code,host_id,created_at,ends_at,status,bonus_pct) VALUES(?,?,?,?,?,?,?)')
    .run(id, code, req.userId, now, endsAt, 'active', COOP_BONUS_PCT);
  db.prepare('INSERT INTO coop_members(round_id,user_id,joined_at) VALUES(?,?,?)').run(id, req.userId, now);
  res.json(coopRoundState(db.prepare('SELECT * FROM coop_rounds WHERE id=?').get(id), req.userId));
});

app.post('/api/coop/rounds/join', requireAuth, coopLimiter, (req, res) => {
  const code = String((req.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return res.status(400).json({ error: 'Bitte einen gültigen 6-stelligen Code eingeben' });
  coopExpireLazy();
  const round = db.prepare("SELECT * FROM coop_rounds WHERE code=? AND status='active' AND ends_at >= ?").get(code, nowIso());
  if (!round) return res.status(404).json({ error: 'Diese Runde gibt es nicht (mehr) 🤔' });
  const mine = coopActiveRoundFor(req.userId);
  if (mine && mine.id !== round.id) return res.status(409).json({ error: 'Du bist schon in einer anderen Runde — erst verlassen.' });
  db.prepare('INSERT OR IGNORE INTO coop_members(round_id,user_id,joined_at) VALUES(?,?,?)').run(round.id, req.userId, nowIso());
  res.json(coopRoundState(round, req.userId));
});

app.post('/api/coop/rounds/leave', requireAuth, (req, res) => {
  const round = coopActiveRoundFor(req.userId);
  if (!round) return res.json({ ok: true });
  if (round.host_id === req.userId) {
    db.prepare("UPDATE coop_rounds SET status='ended' WHERE id=?").run(round.id); // Host beendet die ganze Runde
  } else {
    db.prepare('DELETE FROM coop_members WHERE round_id=? AND user_id=?').run(round.id, req.userId);
  }
  res.json({ ok: true });
});

// ── Admin-Panel ────────────────────────────────────────────────
// Datenschutz/Datenminimierung: KEINE GPS-Koordinaten, KEINE Foto-Bytes, KEINE Passwort-Hashes
// werden hier ausgeliefert. Nur Aggregate + Artenlisten + Konto-Metadaten (siehe Spec).
function lastActivityIso(userId, createdAt) {
  const lf = db.prepare('SELECT MAX(created_at) m FROM finds WHERE user_id=?').get(userId).m;
  const ls = db.prepare('SELECT MAX(created_at) m FROM sessions WHERE user_id=?').get(userId).m;
  return [createdAt, lf, ls].filter(Boolean).sort().pop(); // ISO-Strings → lexikografisch korrekt
}
function adminUserSummary(u) {
  const stats = userStats(u.id);
  const catRows = db.prepare('SELECT category, COUNT(*) n FROM finds WHERE user_id=? GROUP BY category').all(u.id);
  const byCat = {}; for (const r of catRows) byCat[r.category] = r.n;
  const friends = db.prepare("SELECT COUNT(*) n FROM friendships WHERE status='accepted' AND (requester_id=? OR addressee_id=?)").get(u.id, u.id).n;
  const lv = u.level || computeLevel(u.xp || 0);
  return {
    id: u.id, email: u.email, name: u.name, avatar: u.avatar || null,
    level: lv, levelTitle: levelTitleFor(lv), xp: u.xp || 0,
    emailVerified: !!u.email_verified,
    createdAt: u.created_at, lastActivity: lastActivityIso(u.id, u.created_at),
    totalFinds: stats.totalFinds, uniqueSpecies: stats.uniqueSpecies,
    plantCount: byCat.plant || 0, insectCount: byCat.insect || 0,
    friends,
  };
}
function adminStats() {
  const users = db.prepare('SELECT id, xp, level, email_verified, created_at FROM users').all();
  const now = Date.now();
  const d7 = new Date(now - 7 * 864e5).toISOString();
  const d30 = new Date(now - 30 * 864e5).toISOString();
  let active7 = 0, active30 = 0, verified = 0, newWeek = 0;
  const levelDist = {};
  for (const u of users) {
    if (u.email_verified) verified++;
    if (u.created_at >= d7) newWeek++;
    const last = lastActivityIso(u.id, u.created_at);
    if (last >= d7) active7++;
    if (last >= d30) active30++;
    const lv = u.level || computeLevel(u.xp || 0);
    levelDist[lv] = (levelDist[lv] || 0) + 1;
  }
  const totalFinds = db.prepare('SELECT COUNT(*) n FROM finds').get().n;
  const plantFinds = db.prepare("SELECT COUNT(*) n FROM finds WHERE category='plant'").get().n;
  const insectFinds = db.prepare("SELECT COUNT(*) n FROM finds WHERE category='insect'").get().n;
  const allFinds = db.prepare('SELECT species_id, species_sci, species_name, category FROM finds').all();
  const speciesCount = {};
  for (const f of allFinds) {
    const sp = curatedOfRow(f);
    let key, name, cat;
    if (sp) { key = 'sp:' + sp.id; name = sp.name; cat = sp.cat; }
    else if (f.species_name) { key = 'nm:' + f.species_name.toLowerCase(); name = f.species_name; cat = f.category; }
    else continue;
    if (!speciesCount[key]) speciesCount[key] = { name, cat, count: 0 };
    speciesCount[key].count++;
  }
  const topSpecies = Object.values(speciesCount).sort((a, b) => b.count - a.count).slice(0, 12);

  // Live-Aktivitätsfeed: letzte Funde (Name + Art + Zeit; KEINE Koordinaten/Fotos).
  const recent = db.prepare(`SELECT f.species_id, f.species_sci, f.species_name, f.category, f.created_at,
      u.name AS uname, u.email AS uemail, u.avatar AS uavatar
      FROM finds f LEFT JOIN users u ON u.id = f.user_id
      ORDER BY datetime(f.created_at) DESC LIMIT 15`).all();
  const recentActivity = recent.map(r => {
    const sp = curatedOfRow(r);
    return {
      user: r.uname || (r.uemail ? r.uemail.split('@')[0] : 'Unbekannt'),
      avatar: r.uavatar || null,
      species: sp ? sp.name : (r.species_name || 'Unbestimmt'),
      emoji: sp ? sp.emoji : (r.category === 'insect' ? '🐛' : '🌿'),
      cat: r.category, at: r.created_at,
    };
  });

  // Funde der letzten 14 Tage (für Mini-Säulendiagramm).
  const dayCounts = Object.fromEntries(
    db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) n FROM finds GROUP BY d").all().map(r => [r.d, r.n])
  );
  const findsByDay = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(now - i * 864e5);
    const key = dt.toISOString().slice(0, 10);
    findsByDay.push({ day: key, count: dayCounts[key] || 0 });
  }

  coopExpireLazy();
  const coop = {
    active: db.prepare("SELECT COUNT(*) n FROM coop_rounds WHERE status='active' AND ends_at >= ?").get(nowIso()).n,
    ended: db.prepare("SELECT COUNT(*) n FROM coop_rounds WHERE status='ended'").get().n,
    total: db.prepare('SELECT COUNT(*) n FROM coop_rounds').get().n,
    participants: db.prepare(`SELECT COUNT(*) n FROM coop_members m JOIN coop_rounds r ON r.id=m.round_id
      WHERE r.status='active' AND r.ends_at >= ?`).get(nowIso()).n,
  };
  return {
    users: users.length, verified, active7, active30, newWeek,
    totalFinds, plantFinds, insectFinds,
    distinctSpecies: Object.keys(speciesCount).length,
    topSpecies, levelDist, friendships: db.prepare("SELECT COUNT(*) n FROM friendships WHERE status='accepted'").get().n,
    recentActivity, findsByDay, coop,
  };
}
function adminUserDetail(id) {
  const u = db.prepare('SELECT id, email, name, avatar, xp, level, email_verified, created_at FROM users WHERE id=?').get(id);
  if (!u) return null;
  const summary = adminUserSummary(u);
  const finds = db.prepare('SELECT species_id, species_sci, species_name, category, harvested, lat, lng FROM finds WHERE user_id=?').all(id);
  const speciesMap = {};
  let located = 0;
  for (const f of finds) {
    if (f.lat != null && f.lng != null && !(f.lat === 0 && f.lng === 0)) located++;
    const sp = curatedOfRow(f);
    let key, entry;
    if (sp) { key = 'sp:' + sp.id; entry = { id: sp.id, name: sp.name, sci: sp.sci, cat: sp.cat, rarity: sp.rarity || null, curated: true }; }
    else { const nm = f.species_name || 'Unbestimmt'; key = 'nm:' + nm.toLowerCase(); entry = { name: nm, sci: f.species_sci || null, cat: f.category, rarity: null, curated: false }; }
    if (!speciesMap[key]) speciesMap[key] = { ...entry, count: 0, harvested: 0 };
    speciesMap[key].count++;
    if (f.harvested) speciesMap[key].harvested++;
  }
  const species = Object.values(speciesMap).sort((a, b) => (a.cat === b.cat ? b.count - a.count : String(a.cat).localeCompare(String(b.cat))));
  const ach = db.prepare('SELECT code, unlocked_at FROM achievements WHERE user_id=?').all(id);
  const achMap = Object.fromEntries(ach.map(r => [r.code, r.unlocked_at]));
  const achievements = ACHIEVEMENTS.filter(a => achMap[a.code]).map(a => ({ code: a.code, name: a.name, emoji: a.emoji, unlockedAt: achMap[a.code] }));
  const questsCompleted = db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE user_id=? AND completed_at IS NOT NULL').get(id).n;
  return { ...summary, locatedFinds: located, species, achievements, achievementsTotal: ACHIEVEMENTS.length, questsCompleted };
}

// Arten-Katalog: alle freischaltbaren Pflanzen/Insekten (kein Fisch — im MVP ausgeblendet)
// mit Entdeckungs-Statistik (wie oft + von wie vielen Nutzern gefunden).
function adminCatalog() {
  const finds = db.prepare('SELECT species_id, species_sci, species_name, user_id, harvested FROM finds').all();
  const stat = {};
  for (const f of finds) {
    const sp = curatedOfRow(f);
    if (!sp) continue;
    const s = stat[sp.id] || (stat[sp.id] = { finds: 0, users: new Set(), harvested: 0 });
    s.finds++; if (f.user_id) s.users.add(f.user_id); if (f.harvested) s.harvested++;
  }
  const species = SPECIES_LIST
    .filter(s => s.cat === 'plant' || s.cat === 'insect')
    .map(s => {
      const st = stat[s.id];
      return {
        id: s.id, name: s.name, sci: s.sci, cat: s.cat, kind: s.kind || null,
        emoji: s.emoji, color: s.color, rarity: s.rarity || null,
        bloom: s.bloom || null, season: s.season || null, seed: s.seed || null,
        habitats: s.habitats || [],
        finds: st ? st.finds : 0, users: st ? st.users.size : 0, harvested: st ? st.harvested : 0,
      };
    });
  const totals = { plant: 0, insect: 0 };
  for (const s of species) totals[s.cat]++;
  return { species, totals, total: species.length, discovered: species.filter(s => s.finds > 0).length };
}

// Quest-Übersicht: alle Saison-Sets + pro Quest/Set, wie viele Nutzer sie geschafft haben.
function adminQuests() {
  const active = activeQuestSet(new Date());
  const sets = QUEST_SETS.map(set => {
    const quests = set.quests.map(q => ({
      code: q.code, name: q.name, kind: q.kind, category: q.category || null, target: q.target,
      completedBy: db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE quest_code=? AND completed_at IS NOT NULL').get(q.code).n,
      inProgress: db.prepare('SELECT COUNT(*) n FROM quest_progress WHERE quest_code=? AND completed_at IS NULL AND progress>0').get(q.code).n,
    }));
    const setCompletedBy = db.prepare(
      'SELECT COUNT(*) n FROM (SELECT user_id FROM quest_progress WHERE set_code=? AND completed_at IS NOT NULL GROUP BY user_id HAVING COUNT(*) >= ?)'
    ).get(set.code, set.quests.length).n;
    return { code: set.code, name: set.name, emoji: set.emoji, from: set.from, to: set.to, totalQuests: set.quests.length, setCompletedBy, quests };
  });
  return { sets, activeSetCode: active ? active.code : null };
}

// kompakte Nutzer-Infos für Drill-down-Listen (kein Email/Koordinaten/Fotos)
function briefUser(uid) {
  const u = db.prepare('SELECT id, name, email, avatar, xp, level FROM users WHERE id=?').get(uid);
  if (!u) return null;
  const lv = u.level || computeLevel(u.xp || 0);
  return { userId: u.id, name: u.name || (u.email ? u.email.split('@')[0] : 'Unbekannt'), avatar: u.avatar || null, level: lv };
}

// Drill-down Art: welche Nutzer haben diese Art entdeckt (+ Fund-/Erntezahlen).
function adminSpeciesDetail(id) {
  const sp = SPECIES_BY_ID[id];
  if (!sp) return null;
  const rows = db.prepare('SELECT user_id, species_id, species_sci, species_name, category, harvested, created_at FROM finds').all();
  const byUser = {};
  for (const f of rows) {
    const c = curatedOfRow(f);
    if (!c || c.id !== id) continue;
    const u = byUser[f.user_id] || (byUser[f.user_id] = { finds: 0, harvested: 0, firstAt: f.created_at, lastAt: f.created_at });
    u.finds++; if (f.harvested) u.harvested++;
    if (f.created_at < u.firstAt) u.firstAt = f.created_at;
    if (f.created_at > u.lastAt) u.lastAt = f.created_at;
  }
  const discoverers = Object.entries(byUser).map(([uid, st]) => {
    const b = briefUser(uid); if (!b) return null;
    return { ...b, finds: st.finds, harvested: st.harvested, firstAt: st.firstAt, lastAt: st.lastAt };
  }).filter(Boolean).sort((a, b) => b.finds - a.finds || a.name.localeCompare(b.name));
  return {
    id: sp.id, name: sp.name, sci: sp.sci, cat: sp.cat, kind: sp.kind || null,
    emoji: sp.emoji, color: sp.color, rarity: sp.rarity || null,
    bloom: sp.bloom || null, season: sp.season || null, seed: sp.seed || null,
    habitats: sp.habitats || [], active: sp.active || null,
    totalFinds: discoverers.reduce((s, d) => s + d.finds, 0), users: discoverers.length, discoverers,
  };
}

// Drill-down Quest: welche Nutzer haben sie abgeschlossen / sind dran.
function adminQuestDetail(code) {
  let meta = null;
  for (const set of QUEST_SETS) {
    const q = set.quests.find(x => x.code === code);
    if (q) { meta = { ...q, setName: set.name, setEmoji: set.emoji }; break; }
  }
  if (!meta) return null;
  const rows = db.prepare('SELECT user_id, progress, target, completed_at FROM quest_progress WHERE quest_code=?').all(code);
  const completed = [], inProgress = [];
  for (const r of rows) {
    const b = briefUser(r.user_id); if (!b) continue;
    if (r.completed_at) completed.push({ ...b, completedAt: r.completed_at });
    else if (r.progress > 0) inProgress.push({ ...b, progress: r.progress, target: r.target });
  }
  completed.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  inProgress.sort((a, b) => (b.progress / b.target) - (a.progress / a.target));
  return { code, name: meta.name, kind: meta.kind, category: meta.category || null, target: meta.target, setName: meta.setName, setEmoji: meta.setEmoji, completed, inProgress };
}

app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin-Panel ist nicht konfiguriert.' });
  if (!adminIpOk(req)) return res.status(403).json({ error: 'Zugriff von dieser IP nicht erlaubt.' });
  const { user, password } = req.body || {};
  const userOk = String(user || '').trim().toLowerCase() === ADMIN_USER.toLowerCase();
  const passOk = verifyAdminPassword(password);
  if (!userOk || !passOk) {
    console.log(`[admin] fehlgeschlagener Login von ${req.ip}`);
    return res.status(401).json({ error: 'Zugangsdaten falsch' });
  }
  setAdminCookie(req, res, createAdminSession(req.ip));
  console.log(`[admin] Login erfolgreich von ${req.ip}`);
  res.json({ ok: true, user: ADMIN_USER });
});
app.post('/api/admin/logout', (req, res) => {
  const t = parseCookies(req).bp_admin; if (t) db.prepare('DELETE FROM admin_sessions WHERE token=?').run(t);
  res.clearCookie('bp_admin', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/admin/me', (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin-Panel ist nicht konfiguriert.' });
  if (!adminIpOk(req) || !adminFromReq(req)) return res.status(401).json({ error: 'nicht als Admin angemeldet' });
  res.json({ user: ADMIN_USER });
});
app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(adminStats()));
app.get('/api/admin/catalog', requireAdmin, (req, res) => res.json(adminCatalog()));
app.get('/api/admin/quests', requireAdmin, (req, res) => res.json(adminQuests()));
app.get('/api/admin/species/:id', requireAdmin, (req, res) => {
  const d = adminSpeciesDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Art nicht gefunden' });
  res.json(d);
});
app.get('/api/admin/quests/:code', requireAdmin, (req, res) => {
  const d = adminQuestDetail(req.params.code);
  if (!d) return res.status(404).json({ error: 'Quest nicht gefunden' });
  res.json(d);
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, name, avatar, xp, level, email_verified, created_at FROM users ORDER BY datetime(created_at) DESC').all();
  res.json({ users: users.map(adminUserSummary) });
});
app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
  const d = adminUserDetail(req.params.id);
  if (!d) return res.status(404).json({ error: 'User nicht gefunden' });
  res.json(d);
});
app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User nicht gefunden' });
  const b = req.body || {};
  if (b.emailVerified !== undefined) {
    db.prepare('UPDATE users SET email_verified=? WHERE id=?').run(b.emailVerified ? 1 : 0, u.id);
  }
  res.json(adminUserDetail(u.id));
});
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const userId = req.params.id;
  const u = db.prepare('SELECT id, email FROM users WHERE id=?').get(userId);
  if (!u) return res.status(404).json({ error: 'User nicht gefunden' });
  try {
    const finds = db.prepare('SELECT photo, thumb FROM finds WHERE user_id=?').all(userId);
    for (const f of finds) {
      if (f.photo) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.photo)); } catch (_) {} }
      if (f.thumb) { try { fs.unlinkSync(path.join(THUMB_DIR, f.thumb)); } catch (_) {} }
    }
    db.prepare('DELETE FROM finds WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM achievements WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM quest_progress WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM periodic_quests WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM friendships WHERE requester_id=? OR addressee_id=?').run(userId, userId);
    db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    console.log(`[admin] Konto gelöscht: ${u.email} (${userId}) via Admin-Panel, finds=${finds.length}`);
    res.json({ ok: true, deletedFinds: finds.length });
  } catch (e) { console.error('[admin-delete]', e); res.status(500).json({ error: e.message }); }
});

// JSON-Fehlerhandler statt HTML
app.use((err, req, res, _next) => {
  // express.json/multer-Fehler etc.
  const status = err.status || err.statusCode || 500;
  console.error('[err]', req.method, req.path, err.message);
  res.status(status).json({ error: err.message || 'Serverfehler' });
});

// ── Server-Start ───────────────────────────────────────────────
function readTls() {
  try {
    return {
      key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
      cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    };
  } catch (e) {
    return null;
  }
}

const BIND_HOST = (HOST === '127.0.0.1' || TRUST_PROXY) ? '127.0.0.1' : '0.0.0.0';

// Retroaktiver XP/Achievement-Backfill für User mit bestehenden Funden aber xp=0.
try { backfillProgression(); } catch (e) { console.error('[backfill]', e.message); }
// Friend-Codes für Bestands-User nachziehen.
try { backfillFriendCodes(); } catch (e) { console.error('[friend-code]', e.message); }

if (HTTPS_PORT > 0) {
  const tls = readTls();
  if (tls) {
    https.createServer(tls, app).listen(HTTPS_PORT, BIND_HOST, () =>
      console.log(`🌸 Blütenpfad HTTPS (Live-GPS) auf https://${HOST}:${HTTPS_PORT}`));
  } else {
    console.log(`🌸 Blütenpfad: kein TLS-Zertifikat in ${CERT_DIR} — HTTPS-Listener übersprungen`);
  }
}
http.createServer(app).listen(HTTP_PORT, BIND_HOST, () =>
  console.log(`🌸 Blütenpfad HTTP auf http://${BIND_HOST}:${HTTP_PORT} (TRUST_PROXY=${TRUST_PROXY ? 'on' : 'off'}, prod=${IS_PROD})`));
