# Blütenpfad 🌸

> Eine cozy Natur-Sammel-PWA im Animal-Crossing-/Critterpedia-Stil — „dein echter Natur-Dex".
> Pflanze fotografieren, Standort dazu, Steckbrief lesen, Sammlung füllen, rausgehen.
> Region: DACH/Mitteleuropa. Kein Bestimmungs-Labor, sondern Motivation.

**Live:** [bluetenpfad.de](https://bluetenpfad.de) · **Stack:** Node.js + Express + SQLite + Vanilla JS · **Build-Step:** keiner

---

## Worum es in diesem Repo geht

Das hier ist ein bewusst **kleines, dependency-armes Hobby-Projekt**, das trotzdem alles
mitbringt, was eine echte App braucht: Auth, Foto-Upload mit EXIF-Auswertung, externe
Erkennungs-APIs, Progression, Freundes-System, ein Multiplayer-Modus, ein Admin-Panel,
DSGVO-Endpoints und ein gehärtetes Deployment.

Die interessanteste Eigenschaft ist, **was nicht drin ist**: kein React, kein Bundler,
kein ORM, kein Docker, kein Redis, kein Job-Queue-Worker. Ein Node-Prozess, eine
SQLite-Datei, statische Dateien. Das ist keine Nachlässigkeit, sondern die zentrale
Design-Entscheidung — siehe [Leitgedanken](#leitgedanken).

---

## Inhalt

- [Leitgedanken](#leitgedanken)
- [Tech-Stack](#tech-stack)
- [Repo-Struktur](#repo-struktur)
- [Architektur](#architektur)
- [Datenmodell](#datenmodell)
- [API-Referenz](#api-referenz)
- [Durchstich: Wie ein Fund entsteht](#durchstich-wie-ein-fund-entsteht)
- [Auth & Sicherheit](#auth--sicherheit)
- [Progression: XP, Achievements, Quests](#progression-xp-achievements-quests)
- [Der Arten-Katalog](#der-arten-katalog)
- [Co-op: Sammel-Runden](#co-op-sammel-runden)
- [Lokal starten](#lokal-starten)
- [Konfiguration](#konfiguration)
- [Deployment](#deployment)
- [Bekannte Grenzen](#bekannte-grenzen)

---

## Leitgedanken

**1. Ein Prozess, eine Datei, kein Build.**
Das Frontend wird als statisches Verzeichnis vom selben Express-Server ausgeliefert, der
auch die JSON-API bedient. `git pull && systemctl restart` ist das komplette Deployment.
Kein `npm run build`, kein Artefakt, keine Sourcemaps. Der Code, der im Browser läuft, ist
exakt der Code im Repo — das macht Debugging auf dem iPhone im Feld erträglich.

**2. SQLite ist genug — und `better-sqlite3` ist synchron.**
Bei ein paar tausend Funden und einstelligen Nutzerzahlen ist ein Netzwerk-Hop zu einer
Datenbank pure Latenz. `better-sqlite3` ist **synchron**, was in Node erst mal falsch
aussieht, hier aber der Punkt ist: keine Promise-Ketten, keine Transaktions-Kopfstände,
keine Race-Conditions zwischen Fund-Insert und XP-Vergabe. WAL-Modus sorgt dafür, dass
Leser Schreiber nicht blockieren.

**3. Migrationen sind idempotent und laufen beim Start.**
Kein Migrations-Framework, keine Versionstabelle. Stattdessen prüft der Server beim
Hochfahren via `PRAGMA table_info` selbst, ob eine Spalte fehlt, und legt sie an. Jede
Migration ist so geschrieben, dass sie beliebig oft laufen darf. Ergebnis: Deploy heißt
Dateien kopieren und neu starten — der Rest passiert von allein.

**4. Der Arten-Katalog ist eine JS-Datei, die beide Seiten lesen.**
`public/species.js` ist die Single Source of Truth für alle 265 Arten. Das Frontend lädt
sie per `<script>`. Der Server liest **dieselbe Datei** und evaluiert sie in einem
isolierten Scope, um an die Daten zu kommen — Details unter
[Der Arten-Katalog](#der-arten-katalog).

**5. Secrets leben ausschließlich in der Umgebung.**
Keine Config-Datei im Repo. API-Keys kommen aus der systemd-Unit bzw.
`/etc/bluetenpfad.env`. Der Pl@ntNet-Key wird nie an den Client durchgereicht — der
Client fragt nur `/api/config`, ob die Erkennung verfügbar ist.

---

## Tech-Stack

| Bereich | Wahl | Warum |
|---|---|---|
| Runtime | Node.js (≥ 18, wegen `fetch`) | Built-ins reichen weit |
| HTTP | Express 4 | bekannt, klein, kein Overhead |
| Datenbank | SQLite via `better-sqlite3` (WAL) | synchron, keine Netzwerk-Latenz, eine Datei zum Backup |
| Upload | `multer` (MemoryStorage) | Buffer geht direkt an EXIF-Parser + Erkennungs-API, ohne Zwischendatei |
| EXIF/GPS | `exifr` | liest Koordinaten aus Fotos, wenn Live-GPS fehlt |
| Passwörter | `crypto.scrypt` (Node-Built-in) | keine native Dependency wie bcrypt/argon2 |
| Security-Header | `helmet` + strikte CSP | siehe [Auth & Sicherheit](#auth--sicherheit) |
| Rate-Limiting | `express-rate-limit` | sechs getrennte Limiter |
| E-Mail | `lib/mailer.js` — selbstgeschrieben | ~330 Zeilen auf `net`/`tls`/`https`, keine Dependency |
| Frontend | Vanilla JS, kein Framework | kein Build-Step, siehe Leitgedanke 1 |
| Karte | Leaflet + markercluster, self-hosted | in `public/vendor/`, kein CDN → strengere CSP möglich |
| Kartendaten | CartoDB Voyager Tiles + OSM · GBIF-Density-Tiles | Verbreitungskarten im Steckbrief |
| PWA | Manifest + Service Worker | offline-fähige App-Shell |

**Dependencies gesamt: acht.** Neue kommen nur mit klarer Begründung dazu.

---

## Repo-Struktur

```
.
├── server.js                 # Der gesamte Backend-Code (~2.250 Zeilen, bewusst eine Datei)
├── lib/
│   └── mailer.js             # Dependency-freier Mailer: Brevo-HTTP-API oder SMTP/STARTTLS
├── public/                   # Wird statisch ausgeliefert — kein Build
│   ├── index.html            # App-Shell, 4 Tabs
│   ├── app.js                # Frontend-Logik (~2.000 Zeilen)
│   ├── style.css             # Cozy-Cream-Design
│   ├── species.js            # Arten-Katalog: 265 Arten + Bestäuber-Verknüpfungen
│   ├── sw.js                 # Service Worker
│   ├── admin.{html,css,js}   # Separates Admin-Panel
│   ├── impressum.html        # Rechtstexte (Angaben hier anonymisiert)
│   ├── datenschutz.html
│   ├── naturschutz.html      # Sammel-Disclaimer
│   └── vendor/               # Leaflet, markercluster, exifr — self-hosted
├── deploy/
│   ├── bluetenpfad.service   # systemd-Unit inkl. Härtung
│   └── Caddyfile             # Reverse-Proxy + TLS + Security-Header
├── scripts/
│   ├── provision-vps.sh      # Server von null aufsetzen
│   ├── deploy-netcup.sh      # rsync + restart
│   ├── backup.sh             # DB + Fotos sichern
│   └── migrate-from-pi.sh    # Daten von der LAN-Instanz auf den VPS
└── .env.example              # Alle Konfigurationsvariablen, dokumentiert
```

> **Warum ist `server.js` eine einzige Datei?** Weil sie mit `Strg+F` navigierbar ist und
> es keine Import-Zyklen gibt. Sie ist in klar beschriftete Abschnitte gegliedert
> (Konfiguration → Schema/Migrationen → Progression → Auth-Helfer → Middleware → Routen
> → Boot). Ab etwa dieser Größe wäre Aufteilen sinnvoll — das ist die ehrlichste offene
> Baustelle im Projekt.

---

## Architektur

### Ein Prozess, zwei Listener

Lokal und im LAN lauscht derselbe Express-App-Objekt auf zwei Ports:

```
  HTTP  :8068  ─┐
                ├─→  eine Express-App  ─→  SQLite  +  Dateisystem (Fotos)
  HTTPS :8069  ─┘     (self-signed)
```

Der HTTPS-Listener existiert aus einem sehr konkreten Grund: **iOS gibt Live-GPS und
Kamera nur in einem Secure Context frei.** Zum Testen im LAN braucht es also TLS, auch
wenn das Zertifikat selbstsigniert ist. Der HTTP-Port bleibt parallel offen, damit man
sich beim schnellen Ausprobieren nicht durch Zertifikatswarnungen klicken muss.

### In Produktion

```
   Internet
      │  :443
      ▼
  ┌─────────┐   Let's Encrypt (automatisch), HSTS, gzip/zstd,
  │  Caddy  │   X-Forwarded-Proto/Host
  └────┬────┘
       │  127.0.0.1:8068
       ▼
  ┌──────────────────────────┐
  │  node server.js          │  systemd, User `bluetenpfad`,
  │  (TRUST_PROXY=1)         │  ProtectSystem=strict, CapabilityBoundingSet=
  └────┬────────────────┬────┘
       │                │
       ▼                ▼
  /var/lib/bluetenpfad/data/*.db     /var/lib/bluetenpfad/{uploads,thumbs}/
```

Der HTTPS-Listener wird in Produktion per `WB_HTTPS_PORT=0` abgeschaltet — TLS macht
Caddy. Setzt man `TRUST_PROXY=1`, bindet der Prozess automatisch nur noch auf
`127.0.0.1`, ist also von außen nicht direkt erreichbar:

```js
const BIND_HOST = (HOST === '127.0.0.1' || TRUST_PROXY) ? '127.0.0.1' : '0.0.0.0';
```

### Middleware-Kette

Jeder Request läuft durch:

1. **helmet** — CSP, HSTS (nur in Produktion), Referrer-Policy, CORP
2. **`express.json({ limit: '2mb' })`**
3. **Admin-Guard** — `/admin*` bekommt `Cache-Control: no-store` + `X-Robots-Tag: noindex`
4. **Statisches Ausliefern** von `public/` — aber **nicht** `uploads/`/`thumbs/`
5. **Session-Auflösung** — Cookie `sid` → `req.userId`
6. **Origin-Check** — bei allen mutierenden Requests (siehe unten)
7. **Route-spezifisches Rate-Limit**
8. **`requireAuth`**
9. Der eigentliche Handler
10. **JSON-Fehlerhandler** — damit die API nie Express' HTML-Fehlerseiten zurückgibt

---

## Datenmodell

Elf Tabellen, alle mit `CREATE TABLE IF NOT EXISTS` beim Start angelegt:

| Tabelle | Zweck |
|---|---|
| `finds` | Der Kern. Foto-Dateiname, Koordinaten, Zeitpunkt, Art, Kategorie, Notiz, Ernte-Status |
| `users` | E-Mail, Name, scrypt-Hash, Freundescode, XP, Avatar |
| `sessions` | Opake Tokens mit Ablaufdatum |
| `email_verifications` | Bestätigungs-Tokens (nur aktiv wenn `EMAIL_VERIFICATION=1`) |
| `friendships` | `requester_id`/`addressee_id` + Status (`pending`/`accepted`) |
| `achievements` | Freigeschaltete Abzeichen pro Nutzer |
| `quest_progress` | Saison-Quest-Fortschritt |
| `periodic_quests` | Tages-/Wochen-Quests, per `period_key` gebucht |
| `coop_rounds` / `coop_members` / `coop_scans` | Temporäre Sammel-Runden |
| `admin_sessions` | Getrennte Sessions fürs Admin-Panel |

**Details, die im Betrieb wehgetan haben:**

- **Fotos liegen nicht in der DB**, sondern als `<uuid>.jpg` bzw. `<uuid>_t.jpg` im
  Dateisystem. Die DB speichert nur den Dateinamen. Das hält die `.db` klein genug, dass
  ein Backup ein simples `cp` ist.
- **`num()`** normalisiert `null`/`undefined`/`''` zu `null` statt zu `0`. Ohne das landen
  Funde ohne GPS bei Koordinate `(0,0)` — mitten im Atlantik, im „Golf von Guinea"-Bug.
  Das Frontend filtert zusätzlich über einen `located()`-Guard.
- **Alle Zeitstempel sind ISO-8601-Strings in UTC.** SQLite hat keinen Datumstyp;
  ISO-Strings sortieren lexikografisch korrekt, was Bereichsabfragen trivial macht.
- **Indizes** auf `finds(user_id, created_at)` und die Freundschafts-Spalten.

---

## API-Referenz

Alles unter `/api/*` liefert JSON. Auth per HttpOnly-Cookie.

### Auth & Konto
| Methode | Pfad | Zweck |
|---|---|---|
| `POST` | `/api/auth/register` | Registrierung (rate-limited) |
| `POST` | `/api/auth/login` | Login |
| `POST` | `/api/auth/logout` | Session beenden |
| `POST` | `/api/auth/resend` | Bestätigungsmail erneut — antwortet **immer** `ok` (kein Existenz-Leak) |
| `GET` | `/verify` | Bestätigungslink aus der E-Mail |
| `GET` | `/api/me` | Aktueller Nutzer |
| `GET` | `/api/me/export` | **DSGVO Art. 20** — alle eigenen Daten als JSON |
| `DELETE` | `/api/me` | **DSGVO Art. 17** — Konto + Fotodateien löschen |

### Funde
| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/finds` | Eigene Funde |
| `POST` | `/api/finds` | Neuer Fund (multipart: `photo`, `thumb`, `meta`) |
| `PATCH` | `/api/finds/:id` | Art/Notiz/Ernte ändern |
| `DELETE` | `/api/finds/:id` | Löschen |
| `POST` | `/api/finds/:id/photo` | Foto ersetzen |
| `POST` | `/api/finds/:id/identify` | Nachträglich bestimmen lassen |
| `POST` | `/api/identify` | Foto bestimmen, ohne es zu speichern |
| `GET` | `/api/stats` | Aggregate für die Sammlung |

### Medien (ownership-geprüft)
| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/media/finds/:id/photo` | Vollbild — nur für den Besitzer |
| `GET` | `/media/finds/:id/thumb` | Vorschau — nur für den Besitzer |

### Profil, Progression, Freunde, Co-op
| Methode | Pfad | Zweck |
|---|---|---|
| `GET`/`PATCH` | `/api/profile` | Profil inkl. Level, XP, Freundescode |
| `GET` | `/api/quests` | Aktive Quests + Achievements |
| `GET` | `/api/friends` | Freundesliste + offene Anfragen |
| `POST` | `/api/friends/request` | Anfrage per Freundescode |
| `POST` | `/api/friends/:id/accept` | Annehmen |
| `DELETE` | `/api/friends/:id` | Entfernen/Ablehnen |
| `GET` | `/api/friends/:userId/profile` | Öffentliches Profil — **ohne** E-Mail, Koordinaten, Fotos |
| `GET` | `/api/coop/current` | Laufende Sammel-Runde |
| `POST` | `/api/coop/rounds` | Runde eröffnen |
| `POST` | `/api/coop/rounds/join` | Per 6-stelligem Code beitreten |
| `POST` | `/api/coop/rounds/leave` | Verlassen |

### Sonstiges
| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/config` | Feature-Flags — meldet **ob** Erkennung verfügbar ist, nie den Key |
| `GET` | `/health` | Liveness (aus den Caddy-Logs ausgeblendet) |
| `*` | `/api/admin/*` | Admin-Panel — nur mit separater `bp_admin`-Session |

---

## Durchstich: Wie ein Fund entsteht

`POST /api/finds` ist die Route, in der am meisten zusammenläuft — ein guter Einstieg
zum Lesen (`server.js`, ab Zeile ~1375).

**Im Browser**, bevor irgendetwas gesendet wird:
Das Foto wird per Canvas auf Vollbild- und Thumbnail-Größe herunterskaliert und
komprimiert. Beide Varianten gehen mit. Das spart Upload-Zeit im Feld bei mobilem Netz
und der Server muss keine Bildbibliothek einbinden — es gibt schlicht **keine
serverseitige Bildverarbeitung**.

**Auf dem Server**, in dieser Reihenfolge:

1. **Upload entgegennehmen** — `multer` mit MemoryStorage, also ein `Buffer`. Es entsteht
   keine temporäre Datei.
2. **UUID vergeben** und Buffer nach `<uuid>.jpg` / `<uuid>_t.jpg` schreiben.
3. **Standort ermitteln, mit Fallback-Kette:**
   Live-GPS des Browsers → sonst EXIF-Koordinaten aus dem Foto (`exifr`) → sonst `null`.
   Welche Quelle gewonnen hat, landet als `gps_source` in der DB. Genauso beim Zeitpunkt:
   Browser-Zeit → `DateTimeOriginal` aus EXIF → `null`. Ein Foto aus der Galerie bringt so
   seinen echten Aufnahmeort mit, auch wenn es Tage später hochgeladen wird.
4. **Art bestimmen** — nur wenn der Nutzer nichts angegeben hat und ein API-Key gesetzt
   ist. Ein Dispatcher wählt anhand der Kategorie: Pflanzen → **Pl@ntNet**, Insekten →
   **insect.id (Kindwise)**. Beides schlägt fehl → der Fund wird trotzdem gespeichert,
   nur ohne Art. Erkennung ist Komfort, nie Voraussetzung.
5. **Insert** in `finds`.
6. **Progression anwenden** — XP, Achievements, Saison-Quests.
7. **Periodische Quests** aktualisieren (Tag/Woche).
8. **Co-op verbuchen** — läuft eine Sammel-Runde, wird der Fund den Mitspielern
   gutgeschrieben und der Bonus-XP addiert.

Bemerkenswert an Schritt 6–8: jeder dieser Blöcke steht in einem eigenen `try/catch`.
**Ein Fehler in der Gamification darf niemals den Fund verlieren.** Der Fund ist die
Nutzerdaten; XP sind Deko. Schlägt die Progression fehl, wird geloggt und der Fund
trotzdem zurückgegeben.

Die Antwort enthält den Fund **plus** ein `progression`-Objekt, aus dem das Frontend
direkt seine Level-Up- und Quest-Toasts baut — ein Roundtrip statt drei.

---

## Auth & Sicherheit

### Passwörter
`crypto.scryptSync` mit 16-Byte-Zufallssalt, 64-Byte-Hash, gespeichert als `salt:hash`
in Hex. Verglichen wird mit `crypto.timingSafeEqual`. Kein bcrypt, kein argon2 — beides
wären native Dependencies, die bei jedem Node-Update neu kompiliert werden müssten.

### Sessions
Opakes Zufallstoken in einem Cookie:

```js
res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: isSecureReq(req), … });
```

Kein JWT. Ein Datenbank-Lookup pro Request ist bei SQLite kostenlos, und dafür ist
Logout sofort wirksam — statt „Token läuft irgendwann ab".

`isSecureReq()` setzt das `Secure`-Flag **bedingt**: gesetzt hinter HTTPS, nicht gesetzt
im LAN-HTTP-Betrieb. Ein hart gesetztes `Secure` würde die LAN-Instanz unbenutzbar
machen.

Das Admin-Panel hat ein **komplett getrenntes** Cookie `bp_admin` mit
`sameSite: 'strict'`. Eine Admin-Session ist keine aufgewertete Nutzer-Session — beide
wissen nichts voneinander.

### CSRF / Origin-Check
Statt Token-basiertem CSRF-Schutz prüft eine Middleware bei allen mutierenden Requests
den `Origin`-Header gegen eine Allowlist: Same-Origin, `WB_ALLOWED_ORIGINS`, plus
LAN-Dev-Bereiche (`192.168.*`, `10.*`, `127.0.0.1`, `*.local`). Zusammen mit
`SameSite`-Cookies deckt das den relevanten Fall ab, ohne dass jedes Formular ein Token
mitschleppen muss.

### Content Security Policy
`useDefaults: false` — jede Direktive ist explizit gesetzt, nichts wird geerbt:

```js
defaultSrc:  ["'self'"]
scriptSrc:   ["'self'"]              // kein 'unsafe-inline', kein CDN
frameAncestors: ["'none'"]
objectSrc:   ["'none'"]
imgSrc:      ["'self'", 'data:', 'blob:', … Karten-Tiles …]
connectSrc:  ["'self'", 'https://api.gbif.org', 'https://tile.gbif.org']
```

Dass Leaflet und exifr unter `public/vendor/` self-hosted liegen, ist genau deshalb
kein Zufall: **ohne CDN darf `scriptSrc` bei `'self'` bleiben.**

### Rate-Limiting
Sechs getrennte Limiter statt eines globalen — Login, Registrierung, Arterkennung,
Freundschaftsanfragen, Admin-Login und Co-op. Jeder mit eigenem Fenster. Die
Erkennungs-Route ist dabei nicht nur ein Missbrauchs-, sondern auch ein Kostenschutz:
dahinter hängt ein fremdes API-Kontingent.

### Fotos
Der frühere Weg war ein statisches `/uploads`-Verzeichnis — UUID-Dateinamen als einzige
Hürde, also Security through Obscurity. Heute laufen Fotos über
`/media/finds/:id/photo`: Session prüfen, `user_id` des Funds gegen `req.userId`
vergleichen, erst dann streamen. Der Legacy-Pfad existiert noch, aber hinter einer
Auth-Wall.

### Systemd-Härtung
`deploy/bluetenpfad.service` ist einen Blick wert: eigener unprivilegierter User,
`ProtectSystem=strict` mit genau einem `ReadWritePaths`, `ProtectHome=true`,
`PrivateTmp=true`, `NoNewPrivileges=true` und ein **leeres**
`CapabilityBoundingSet=` — der Prozess hat keinerlei Linux-Capabilities.

---

## Progression: XP, Achievements, Quests

Der Gamification-Teil steckt in `server.js` zwischen Zeile ~259 und ~820.

- **25 Level** mit ansteigenden XP-Schwellen und Titeln, die alle fünf Level wechseln.
- **Achievements** sind deklarativ definiert — jedes ist ein Objekt mit einer
  `check`-Funktion über ein vorberechnetes Statistik-Objekt:

  ```js
  { code: 'pollinator', name: 'Bestäuber-Beobachter:in', desc: '5 Insekten gesichtet.',
    emoji: '🐝', xp: 100, check: s => s.insectFinds >= 5 }
  ```

  Ein neues Abzeichen ist eine Zeile. Die Auswertung läuft über alle Definitionen und
  vergibt XP für jedes neu erfüllte.

- **Saison-Quests** (Frühling/Sommer/Herbst/Winter) mit Sets und Abschluss-Badge.
- **Periodische Quests** — Tages- und Wochenaufgaben, gebucht über einen `period_key`
  (z. B. `2026-W21`). Beim Abruf wird geprüft, ob der aktuelle Schlüssel schon existiert;
  wenn nicht, wird gewürfelt und neu angelegt. **Kein Cronjob nötig** — der erste
  Request des Tages erledigt den Rollover.

Die Quest-Auswertung ist inkrementell: pro Fund wird geschaut, welche Quests der Fund
matcht (Kategorie, Art, Anzahl), und deren `progress` um eins erhöht — statt bei jedem
Request alles neu zu berechnen.

---

## Der Arten-Katalog

`public/species.js` hält **265 kuratierte Arten**: 159 Pflanzen, 89 Insekten, 17 Fische
(letztere als Reservelane, im UI noch aus). Jeder Eintrag ist eine Zeile:

```js
{ cat:"plant", kind:"wild", id:"kornblume", name:"Kornblume", sci:"Centaurea cyanus",
  emoji:"🌸", color:"#6b8ed6", bloom:"Jun–Sep", seed:"Jul–Sep",
  habitats:["Acker","Wegrand"], rarity:3 },
```

Daraus speisen sich Steckbrief, Dex-Silhouetten, Karten-Pin-Farben, die
Saison-Berechnung („blüht gerade") und die Quest-Ziele.

**Der Kniff:** Der Server braucht dieselben Daten (für Quest-Ziele und
Admin-Statistiken), soll sie aber nicht duplizieren. Also liest er die Datei und
evaluiert sie in einem isolierten Scope mit einem Fake-`window`:

```js
const src = fs.readFileSync(path.join(APP_DIR, 'public', 'species.js'), 'utf-8');
const fakeWin = {};
new Function('window', src)(fakeWin);
return Array.isArray(fakeWin.SPECIES) ? fakeWin.SPECIES : [];
```

Eine Datei, beide Seiten, kein Build-Step, keine doppelte Pflege. Das funktioniert, weil
`species.js` reine Daten sind und aus dem eigenen Repo stammen — auf Fremdeingaben
angewandt wäre `new Function` natürlich eine Sicherheitslücke.

---

## Co-op: Sammel-Runden

Ein leichtgewichtiger Mehrspieler-Modus ohne WebSockets und ohne Matchmaking-Server.

Jemand eröffnet eine Runde und bekommt einen **6-stelligen Code**. Wer beitritt, sammelt
für eine begrenzte Zeit mit: **+20 % Bonus-XP** für alle, plus drei gemeinsame Quests —
Synchron-Sichtung (dieselbe Art am selben Tag), Crew-Vielfalt, Bestäuber-Duo (je eine
Pflanze und ein Insekt).

Die Synchronisation läuft komplett über Polling auf `/api/coop/current`. Bei
Runden-Größen im einstelligen Bereich ist das die richtige Menge Technik — WebSockets
hätten einen zweiten Zustandsraum und Reconnect-Logik bedeutet.

**Geteilt wird nur:** Name, Avatar, Level und die Namen der gefundenen Arten.
**Nie:** Fotos, Koordinaten, E-Mail-Adressen. Dasselbe gilt fürs Freunde-Profil.

---

## Lokal starten

**Voraussetzung:** Node.js ≥ 18 (wegen `fetch`). `better-sqlite3` wird beim Install
nativ kompiliert und braucht deshalb eine passende Node-Version.

```bash
git clone https://github.com/xzHannes/bluetenpfad.git
cd bluetenpfad
npm install

cp .env.example .env      # optional — es läuft auch ohne
mkdir -p media data

npm start
```

Dann `http://localhost:8068` öffnen, ein Konto registrieren, fertig.

**Ohne API-Keys läuft alles** — nur die automatische Arterkennung ist dann aus, und Arten
werden aus dem Katalog von Hand gewählt.

### Optional: HTTPS-Listener fürs Handy

Für Live-GPS und Kamera auf dem iPhone braucht es einen Secure Context:

```bash
mkdir -p certs && cd certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout key.pem -out cert.pem -subj "/CN=bluetenpfad.local" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Danach liegt die App zusätzlich auf `https://<deine-lan-ip>:8069` — beim ersten Aufruf
einmal durch die Zertifikatswarnung klicken.

```bash
npm run check   # node --check server.js, Syntax-Prüfung ohne Start
```

---

## Konfiguration

Alles über Umgebungsvariablen, vollständig dokumentiert in
[`.env.example`](.env.example). Die wichtigsten:

| Variable | Default | Zweck |
|---|---|---|
| `WB_HTTP_PORT` | `8068` | HTTP-Port |
| `WB_HTTPS_PORT` | `8069` | HTTPS-Port — `0` schaltet den Listener ab |
| `WB_HOST` | `0.0.0.0` | Bind-Adresse |
| `TRUST_PROXY` | – | `1` hinter Caddy/nginx → bindet nur auf `127.0.0.1` |
| `WB_MEDIA_DIR` | `/mnt/media/wildblumen` | Elternverzeichnis für `uploads/` + `thumbs/` |
| `WB_DATA_DIR` | `./data` | Ablage der SQLite-Datei |
| `WB_ALLOWED_ORIGINS` | – | Kommagetrennte Origin-Allowlist für den CSRF-Check |
| `PLANTNET_API_KEY` | – | Pflanzenerkennung; ohne Key einfach aus |
| `INSECT_ID_API_KEY` | – | Insektenerkennung (Kindwise) |
| `EMAIL_VERIFICATION` | `0` | `1` aktiviert den Bestätigungs-Flow |
| `BREVO_API_KEY` | – | Mailversand über HTTPS statt SMTP |
| `SMTP_*` | – | Alternativer klassischer Mailversand |
| `ADMIN_USER` / `ADMIN_PASSWORD` | – | Ohne beides ist `/admin` **komplett deaktiviert** |
| `ADMIN_ALLOWED_IPS` | – | Optionale IP-Allowlist fürs Admin-Panel |

Zwei Muster ziehen sich durch: **Fehlt ein Key, ist das Feature aus statt kaputt.** Und
**Secrets stehen nie im Repo** — auf dem Server kommen sie aus `/etc/bluetenpfad.env`,
das die systemd-Unit per `EnvironmentFile=` einliest.

### Der Mailer

`lib/mailer.js` spricht SMTP selbst — implizites TLS (465), STARTTLS (587), `AUTH LOGIN`
und `AUTH PLAIN`, in ~330 Zeilen auf `net` und `tls`, ohne Dependency.

In der Praxis wird trotzdem meist der andere Pfad genutzt: Der Hoster blockiert
ausgehende SMTP-Ports (25/465/587), deshalb bevorzugt der Mailer die **Brevo-REST-API
über Port 443**, wenn `BREVO_API_KEY` gesetzt ist. Ist gar nichts konfiguriert, wirft er
nicht, sondern meldet „nicht konfiguriert" — und die Registrierung loggt den
Bestätigungslink einfach in die Konsole. Lokal entwickeln geht so ohne jeden
Mail-Zugang.

---

## Deployment

Die Skripte in `scripts/` sind auf einen Debian/Ubuntu-VPS zugeschnitten. Server-Adressen
stehen als Platzhalter drin und lassen sich per Umgebungsvariable setzen
(`BP_SERVER`, `BP_PI_SSH`, …).

```bash
BP_SERVER=root@dein.server ./scripts/provision-vps.sh   # Node, Caddy, User, Verzeichnisse
BP_SERVER=root@dein.server ./scripts/deploy-netcup.sh   # rsync + systemctl restart
./scripts/backup.sh                                     # DB + Fotos sichern
```

`provision-vps.sh` legt den unprivilegierten Service-User an, erstellt
`/var/lib/bluetenpfad/{data,uploads,thumbs,backups}`, installiert Unit und Caddyfile.
`deploy-netcup.sh` synchronisiert unter Ausschluss von `node_modules`, `data` und
`certs` und startet den Dienst neu.

**Regel im Projekt: vor jeder Migration ein DB-Backup.** Service stoppen, `data/*.db*`
kopieren, Service starten. Weil die Migrationen idempotent sind, ist ein Rollback dann
das Zurückkopieren einer Datei.

---

## Bekannte Grenzen

Ehrlichkeitshalber — was ich weiß und wo die Grenzen liegen:

- **`server.js` ist mit ~2.250 Zeilen zu groß geworden.** Die Abschnitte sind sauber
  getrennt, aber Routen, Progression und Admin-Logik gehörten inzwischen in eigene
  Module. Das ist die nächste Aufräumarbeit.
- **Keine automatisierten Tests.** Es gibt `npm run check` (reine Syntaxprüfung) und
  manuelle Geräte-Tests. Für ein Hobby-Projekt tragbar, für mehr nicht.
- **SQLite ist Single-Writer.** Bei den aktuellen Nutzerzahlen völlig unkritisch; ab
  echter Parallellast wäre Postgres fällig. Der Datenzugriff ist bewusst so knapp
  gehalten, dass ein Umbau überschaubar bliebe.
- **Fotos werden nicht dedupliziert und nicht gestaffelt gelagert.** Zwei Größen pro
  Fund, direkt im Dateisystem. Bei ernsthaftem Wachstum bräuchte es Object Storage.
- **Kein Cronjob für Aufräumarbeiten.** Abgelaufene Sessions und Verifizierungs-Tokens
  werden beim Zugriff aussortiert, nicht im Hintergrund.

---

## Danke an

[Pl@ntNet](https://plantnet.org/) (Pflanzenerkennung) · [Kindwise
insect.id](https://www.kindwise.com/) (Insektenerkennung) · [GBIF](https://www.gbif.org/)
(Verbreitungsdaten) · [OpenStreetMap](https://www.openstreetmap.org/) & [CARTO](https://carto.com/)
(Kartenmaterial) · [Leaflet](https://leafletjs.com/)

---

*Hobby-Projekt, keine kommerzielle Nutzung. Lizenz: [MIT](LICENSE).*
*Die Angaben in `impressum.html` und `datenschutz.html` sind in dieser
Repo-Fassung durch Platzhalter ersetzt.*
