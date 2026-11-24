import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const ROOM_ID_RE = /^[a-z0-9_-]{1,32}$/;
const ASSET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_ROOMS = 100;
const MAX_SSE_TOTAL = 200;
const MAX_SSE_PER_ROOM = 30;
const MAX_ASSET_FILES = 120;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const ALLOWED_VIDEO_EXTS = new Set(['.webm', '.mp4']);
const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

const RAW_STORAGE_DIR = String(process.env.STORAGE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
const STORAGE_ROOT = RAW_STORAGE_DIR ? path.resolve(RAW_STORAGE_DIR) : __dirname;
const USING_VOLUME = STORAGE_ROOT !== __dirname;

const DATA_ROOT = path.resolve(STORAGE_ROOT, 'data');
const ROOMS_DIR = path.resolve(DATA_ROOT, 'rooms');
const PRESETS_FILE = path.resolve(DATA_ROOT, 'team-presets.json');
const BUNDLED_ASSETS_DIR = path.resolve(__dirname, 'assets');
const UPLOADED_ASSETS_DIR = USING_VOLUME ? path.resolve(STORAGE_ROOT, 'assets') : BUNDLED_ASSETS_DIR;
const ASSETS_MANIFEST_FILE = path.resolve(UPLOADED_ASSETS_DIR, 'manifest.json');

try {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
  fs.mkdirSync(UPLOADED_ASSETS_DIR, { recursive: true });
} catch (err) {
  console.warn('Could not initialize storage directories:', err.message);
}

/* =========================================================
   FLAT-FILE JSON STORE & SANITIZATION HELPERS
   ========================================================= */
/** @type {Map<string, { state: any, clock: any, seq: number, updatedAt: number, pinHash: string | null, pinSalt: string | null, clients: Set<{ res: any, role: string, clientId: string }> }>} */
const rooms = new Map();
let totalSseClients = 0;

function sanitizeDeep(value, depth = 0) {
  if (depth > 10 || value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 8192 ? value.slice(0, 8192) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 150).map((item) => sanitizeDeep(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = Object.create(null);
    const keys = Object.keys(value).slice(0, 100);
    for (const k of keys) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = sanitizeDeep(value[k], depth + 1);
    }
    return out;
  }
  return null;
}

function getRoomSnapshotPath(roomId) {
  const resolved = path.resolve(ROOMS_DIR, `${roomId}.json`);
  if (!resolved.startsWith(ROOMS_DIR + path.sep)) {
    throw new Error('Invalid room path');
  }
  return resolved;
}

function getSafePathInDir(baseDir, filename) {
  if (!ASSET_NAME_RE.test(filename) || filename.includes('..')) {
    return null;
  }
  const resolved = path.resolve(baseDir, filename);
  if (!resolved.startsWith(baseDir + path.sep)) {
    return null;
  }
  return resolved;
}

function getSafeAssetPath(filename) {
  return getSafePathInDir(UPLOADED_ASSETS_DIR, filename);
}

function writeJsonAtomic(filePath, dataObj) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(dataObj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function loadRoomFromDisk(roomId) {
  try {
    const filePath = getRoomSnapshotPath(roomId);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      state: parsed.state ? sanitizeDeep(parsed.state) : null,
      clock: parsed.clock ? sanitizeDeep(parsed.clock) : null,
      seq: typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      pinHash: typeof parsed.pinHash === 'string' ? parsed.pinHash : null,
      pinSalt: typeof parsed.pinSalt === 'string' ? parsed.pinSalt : null,
    };
  } catch {
    return null;
  }
}

const diskSaveTimers = new Map();
function scheduleRoomDiskSave(roomId, room) {
  if (diskSaveTimers.has(roomId)) clearTimeout(diskSaveTimers.get(roomId));
  const timer = setTimeout(() => {
    diskSaveTimers.delete(roomId);
    try {
      const filePath = getRoomSnapshotPath(roomId);
      writeJsonAtomic(filePath, {
        state: room.state,
        clock: room.clock,
        seq: room.seq,
        updatedAt: room.updatedAt,
        pinHash: room.pinHash,
        pinSalt: room.pinSalt,
      });
    } catch {
      // Best-effort flat-file snapshot persistence
    }
  }, 300);
  diskSaveTimers.set(roomId, timer);
}

function loadTeamPresetsFromDisk() {
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.teams)) return parsed.teams;
    }
    const cfgPath = path.resolve(__dirname, 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && Array.isArray(cfg.teamPresets)) return cfg.teamPresets;
    }
  } catch {
    // Fallback below
  }
  return [];
}

function sanitizeTeamPresets(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || `team-${Date.now()}-${out.length}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || `team-${out.length}`;
    const shortName = String(item.shortName || 'TEAM').trim().slice(0, 16) || 'TEAM';
    const fullName = String(item.fullName || shortName).trim().slice(0, 40) || shortName;
    const color = typeof item.color === 'string' && HEX_COLOR_RE.test(item.color.trim()) ? item.color.trim() : '#1d4ed8';
    const rawLogo = typeof item.logoPath === 'string' ? item.logoPath.trim().slice(0, 260) : '';
    const safeLogo = (!rawLogo || rawLogo.includes('..') || rawLogo.startsWith('//'))
      ? ''
      : (/^(\.\/assets\/|\/assets\/)[a-zA-Z0-9._-]+$/.test(rawLogo) || /^https:\/\//i.test(rawLogo) ? rawLogo : '');
    out.push({ id, shortName, fullName, color, logoPath: safeLogo });
  }
  return out;
}

let cachedTeamPresets = sanitizeTeamPresets(loadTeamPresetsFromDisk());

function saveTeamPresetsToDisk(teams) {
  cachedTeamPresets = sanitizeTeamPresets(teams);
  try {
    writeJsonAtomic(PRESETS_FILE, { updatedAt: Date.now(), teams: cachedTeamPresets });
  } catch {
    // Best-effort flat-file persistence
  }
  return cachedTeamPresets;
}

function evictIdleRoomsIfNeeded() {
  if (rooms.size < MAX_ROOMS) return;
  let oldestKey = null;
  let oldestTime = Infinity;
  for (const [key, r] of rooms.entries()) {
    if (r.clients.size === 0 && r.updatedAt < oldestTime) {
      oldestTime = r.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) rooms.delete(oldestKey);
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;
  evictIdleRoomsIfNeeded();
  const saved = loadRoomFromDisk(roomId);
  room = {
    state: saved?.state || null,
    clock: saved?.clock || null,
    seq: saved?.seq || 0,
    updatedAt: saved?.updatedAt || Date.now(),
    pinHash: saved?.pinHash || null,
    pinSalt: saved?.pinSalt || null,
    clients: new Set(),
  };
  rooms.set(roomId, room);
  return room;
}

function countRoomPresence(room) {
  let viewers = 0;
  let studios = 0;
  let keepers = 0;
  for (const c of room.clients) {
    if (c.role === 'overlay') viewers++;
    else if (c.role === 'keeper') keepers++;
    else studios++;
  }
  return { viewers, studios, keepers };
}

function sendSseEvent(res, eventName, dataObj) {
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
  } catch {
    // Broken pipe handled on 'close'
  }
}

function broadcastToRoom(room, eventName, dataObj, excludeClientId = '') {
  for (const client of room.clients) {
    if (excludeClientId && client.clientId && client.clientId === excludeClientId) continue;
    sendSseEvent(client.res, eventName, dataObj);
  }
}

function broadcastToAllStudios(eventName, dataObj) {
  for (const room of rooms.values()) {
    for (const client of room.clients) {
      if (client.role === 'studio') sendSseEvent(client.res, eventName, dataObj);
    }
  }
}

/* =========================================================
   OPTIONAL SERVER-WIDE ADMIN_PIN + ROOM PRODUCER PIN
   (SCRYPT + TIMING-SAFE COMPARE + HMAC BEARER SESSIONS)
   ========================================================= */
function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

const ADMIN_PIN_RAW = String(process.env.ADMIN_PIN || '').trim();
const ADMIN_PIN_ENABLED = ADMIN_PIN_RAW.length > 0;
const ADMIN_PIN_SALT = ADMIN_PIN_ENABLED ? crypto.randomBytes(16).toString('hex') : '';
const ADMIN_PIN_HASH = ADMIN_PIN_ENABLED ? hashPin(ADMIN_PIN_RAW, ADMIN_PIN_SALT) : '';
const TOKEN_SIGNING_KEY = process.env.SESSION_SECRET
  ? crypto.createHash('sha256').update(String(process.env.SESSION_SECRET)).digest()
  : crypto.randomBytes(32);
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function verifyAdminPin(suppliedPin) {
  if (!ADMIN_PIN_ENABLED) return true;
  if (typeof suppliedPin !== 'string' || !suppliedPin) return false;
  const candidate = Buffer.from(hashPin(suppliedPin.trim(), ADMIN_PIN_SALT), 'hex');
  const expected = Buffer.from(ADMIN_PIN_HASH, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function issueAdminToken() {
  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Date.now() + ADMIN_TOKEN_TTL_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SIGNING_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAdminToken(authHeader) {
  if (!ADMIN_PIN_ENABLED) return true;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SIGNING_KEY).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed && parsed.role === 'admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

function isRequestAdminAuthenticated(req) {
  if (!ADMIN_PIN_ENABLED) return true;
  if (verifyAdminToken(req.get('Authorization') || '')) return true;
  const directPin = String(req.get('X-Admin-Pin') || '');
  if (directPin && verifyAdminPin(directPin)) return true;
  return false;
}

function verifyRoomPin(room, suppliedPin) {
  if (!room.pinHash || !room.pinSalt) return true;
  if (typeof suppliedPin !== 'string' || !suppliedPin) return false;
  const candidate = Buffer.from(hashPin(suppliedPin, room.pinSalt), 'hex');
  const expected = Buffer.from(room.pinHash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/* =========================================================
   RATE LIMITING, VALIDATION & MAGIC-BYTE CHECKS
   ========================================================= */
const rateBuckets = new Map();
const authRateBuckets = new Map();

function writeRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > 10000) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > 180) {
    return res.status(429).json({ error: 'Too many updates; slow down briefly.' });
  }
  next();
}

function authRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let bucket = authRateBuckets.get(ip);
  if (!bucket || now - bucket.start > 5 * 60 * 1000) {
    bucket = { start: now, count: 0 };
    authRateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > 10) {
    return res.status(429).json({ error: 'Too many PIN attempts. Please wait a few minutes and try again.' });
  }
  next();
}

setInterval(() => {
  const cutoff = Date.now() - 30000;
  for (const [ip, b] of rateBuckets.entries()) {
    if (b.start < cutoff) rateBuckets.delete(ip);
  }
  const authCutoff = Date.now() - 5 * 60 * 1000;
  for (const [ip, b] of authRateBuckets.entries()) {
    if (b.start < authCutoff) authRateBuckets.delete(ip);
  }
}, 60000).unref();

function validateRoomParam(req, res, next) {
  const roomId = String(req.params.room || '').trim().toLowerCase();
  if (!ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'Invalid room name. Use 1-32 lowercase letters, numbers, dashes, or underscores.' });
  }
  req.roomId = roomId;
  next();
}

function detectVerifiedMedia(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: '.png', kind: 'image' };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg', kind: 'image' };
  }
  // GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { mime: 'image/gif', ext: '.gif', kind: 'image' };
  }
  // WebP (RIFF....WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: '.webp', kind: 'image' };
  }
  // WebM (EBML header 1A 45 DF A3)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { mime: 'video/webm', ext: '.webm', kind: 'video' };
  }
  // MP4 (ISO Base Media file: ....ftyp)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return { mime: 'video/mp4', ext: '.mp4', kind: 'video' };
  }
  return null;
}

function scanAssetsDirectory(dirPath, sourceTag, deletable) {
  const items = [];
  try {
    if (!fs.existsSync(dirPath)) return items;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!ASSET_NAME_RE.test(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const isImage = ALLOWED_IMAGE_EXTS.has(ext);
      const isVideo = ALLOWED_VIDEO_EXTS.has(ext);
      if (!isImage && !isVideo) continue;
      const fullPath = getSafePathInDir(dirPath, entry.name);
      if (!fullPath) continue;
      const stat = fs.statSync(fullPath);
      items.push({
        name: entry.name,
        url: `./assets/${entry.name}`,
        kind: isVideo ? 'video' : 'image',
        mime: EXT_TO_MIME[ext] || 'application/octet-stream',
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
        source: sourceTag,
        deletable: !!deletable,
      });
    }
  } catch {
    // Ignore unreadable directory
  }
  return items;
}

function listAssetsOnDisk() {
  const primary = scanAssetsDirectory(UPLOADED_ASSETS_DIR, USING_VOLUME ? 'volume' : 'local', true);
  if (!USING_VOLUME) {
    primary.sort((a, b) => b.updatedAt - a.updatedAt);
    return primary;
  }
  const seen = new Set(primary.map((a) => a.name));
  const bundled = scanAssetsDirectory(BUNDLED_ASSETS_DIR, 'bundled', false).filter((a) => !seen.has(a.name));
  const merged = [...primary, ...bundled];
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  return merged;
}

function syncAssetsManifestFile() {
  try {
    const assets = listAssetsOnDisk();
    writeJsonAtomic(ASSETS_MANIFEST_FILE, { updatedAt: Date.now(), assets });
    return assets;
  } catch {
    return [];
  }
}

syncAssetsManifestFile();

function authorizeWriteRequest(req, room = null) {
  if (ADMIN_PIN_ENABLED) {
    if (!isRequestAdminAuthenticated(req)) {
      return { ok: false, status: 401, body: { error: 'Broadcast Admin PIN required to make changes.', adminPinRequired: true } };
    }
    return { ok: true };
  }
  const targetRoom = room || (() => {
    const roomHint = String(req.get('X-Room-Id') || '').trim().toLowerCase();
    if (!roomHint || !ROOM_ID_RE.test(roomHint)) return null;
    return rooms.get(roomHint) || null;
  })();
  if (targetRoom) {
    const suppliedPin = String(req.get('X-Room-Pin') || '');
    if (!verifyRoomPin(targetRoom, suppliedPin)) {
      return { ok: false, status: 403, body: { error: 'Room Producer PIN required or incorrect', hasPin: true } };
    }
  }
  return { ok: true };
}

/* =========================================================
   GLOBAL SECURITY HEADERS
   ========================================================= */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

/* =========================================================
   OPTIONAL ADMIN_PIN AUTH ROUTES (MOBLIN OVERLAY STAYS OPEN)
   ========================================================= */
app.get('/api/auth/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    adminPinRequired: ADMIN_PIN_ENABLED,
    unlocked: isRequestAdminAuthenticated(req),
  });
});

app.post(
  '/api/auth/unlock',
  authRateLimit,
  express.json({ limit: '4kb' }),
  (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!ADMIN_PIN_ENABLED) {
      return res.json({ ok: true, adminPinRequired: false, token: '' });
    }
    const suppliedPin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : '';
    if (!suppliedPin || !verifyAdminPin(suppliedPin)) {
      return res.status(401).json({ error: 'Incorrect Broadcast PIN.', adminPinRequired: true });
    }
    const token = issueAdminToken();
    return res.json({ ok: true, adminPinRequired: true, token, expiresInMs: ADMIN_TOKEN_TTL_MS });
  }
);

/* =========================================================
   REAL-TIME BROADCAST SYNC API ROUTES (FLAT-FILE JSON DB)
   ========================================================= */
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: 'v9',
    storage: 'flat-file-json',
    persistentVolume: USING_VOLUME,
    adminPinRequired: ADMIN_PIN_ENABLED,
    rooms: rooms.size,
    clients: totalSseClients,
    assets: listAssetsOnDisk().length,
    teamPresets: cachedTeamPresets.length,
    serverTime: Date.now(),
  });
});

app.get('/api/rooms/:room/state', validateRoomParam, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const room = getOrCreateRoom(req.roomId);
  const presence = countRoomPresence(room);
  res.json({
    exists: !!room.state,
    room: req.roomId,
    state: room.state,
    clock: room.clock,
    seq: room.seq,
    ...presence,
    hasPin: !!room.pinHash,
    serverTime: Date.now(),
  });
});

app.get('/api/rooms/:room/stream', validateRoomParam, (req, res) => {
  if (totalSseClients >= MAX_SSE_TOTAL) {
    return res.status(503).json({ error: 'Server stream capacity reached' });
  }
  const room = getOrCreateRoom(req.roomId);
  if (room.clients.size >= MAX_SSE_PER_ROOM) {
    return res.status(503).json({ error: 'Room viewer limit reached' });
  }

  const rawRole = String(req.query.role || 'overlay');
  const role = rawRole === 'studio' ? 'studio' : (rawRole === 'keeper' ? 'keeper' : 'overlay');
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.slice(0, 64) : '';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientEntry = { res, role, clientId };
  room.clients.add(clientEntry);
  totalSseClients += 1;

  const presence = countRoomPresence(room);
  sendSseEvent(res, 'init', {
    exists: !!room.state,
    room: req.roomId,
    state: room.state,
    clock: room.clock,
    seq: room.seq,
    ...presence,
    hasPin: !!room.pinHash,
    serverTime: Date.now(),
  });

  broadcastToRoom(room, 'presence', { ...presence, serverTime: Date.now() });

  const heartbeat = setInterval(() => {
    sendSseEvent(res, 'heartbeat', { t: Date.now(), ...countRoomPresence(room) });
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (room.clients.delete(clientEntry)) {
      totalSseClients = Math.max(0, totalSseClients - 1);
      broadcastToRoom(room, 'presence', { ...countRoomPresence(room), serverTime: Date.now() });
    }
  });
});

app.put(
  '/api/rooms/:room/state',
  validateRoomParam,
  writeRateLimit,
  express.json({ limit: '512kb' }),
  (req, res) => {
    const room = getOrCreateRoom(req.roomId);
    const auth = authorizeWriteRequest(req, room);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid state payload' });
    }

    const sanitized = sanitizeDeep(req.body);
    const clientId = typeof sanitized._clientId === 'string' ? sanitized._clientId.slice(0, 64) : '';
    delete sanitized._clientId;

    room.seq += 1;
    room.updatedAt = Date.now();
    room.state = { ...sanitized, _seq: room.seq, _updatedAt: room.updatedAt };
    if (typeof sanitized.clockRemainingSec === 'number') {
      room.clock = {
        clockRemainingSec: Math.max(0, sanitized.clockRemainingSec),
        clockRunning: !!sanitized.clockRunning,
        clockSyncedAt: room.updatedAt,
      };
    }

    scheduleRoomDiskSave(req.roomId, room);

    const payload = {
      state: room.state,
      clock: room.clock,
      seq: room.seq,
      senderClientId: clientId,
      serverTime: room.updatedAt,
    };
    broadcastToRoom(room, 'state', payload, clientId);

    const presence = countRoomPresence(room);
    res.json({ ok: true, seq: room.seq, ...presence, serverTime: room.updatedAt });
  }
);

app.put(
  '/api/rooms/:room/clock',
  validateRoomParam,
  writeRateLimit,
  express.json({ limit: '16kb' }),
  (req, res) => {
    const room = getOrCreateRoom(req.roomId);
    const auth = authorizeWriteRequest(req, room);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    const sec = Number(req.body?.clockRemainingSec);
    if (!Number.isFinite(sec) || sec < 0 || sec > 7200) {
      return res.status(400).json({ error: 'Invalid clock value' });
    }
    const running = !!req.body?.clockRunning;
    const clientId = typeof req.body?._clientId === 'string' ? req.body._clientId.slice(0, 64) : '';
    const now = Date.now();

    room.clock = {
      clockRemainingSec: Math.max(0, sec),
      clockRunning: running,
      clockSyncedAt: now,
    };
    if (room.state) {
      room.state.clockRemainingSec = room.clock.clockRemainingSec;
      room.state.clockRunning = room.clock.clockRunning;
      room.state.clockSyncedAt = now;
    }
    room.updatedAt = now;

    broadcastToRoom(room, 'clock', { ...room.clock, senderClientId: clientId, serverTime: now }, clientId);
    res.json({ ok: true, serverTime: now });
  }
);

app.post(
  '/api/rooms/:room/ping',
  validateRoomParam,
  writeRateLimit,
  express.json({ limit: '8kb' }),
  (req, res) => {
    const room = getOrCreateRoom(req.roomId);
    const auth = authorizeWriteRequest(req, room);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    const msg = typeof req.body?.message === 'string' ? req.body.message.slice(0, 80) : `SYNC TEST OK (${req.roomId})`;
    const now = Date.now();
    broadcastToRoom(room, 'ping', { message: msg, t: now });
    const presence = countRoomPresence(room);
    res.json({ ok: true, ...presence, serverTime: now });
  }
);

app.put(
  '/api/rooms/:room/pin',
  validateRoomParam,
  writeRateLimit,
  express.json({ limit: '8kb' }),
  (req, res) => {
    const room = getOrCreateRoom(req.roomId);
    if (ADMIN_PIN_ENABLED) {
      if (!isRequestAdminAuthenticated(req)) {
        return res.status(401).json({ error: 'Broadcast Admin PIN required to modify room settings.', adminPinRequired: true });
      }
    } else {
      const currentPin = String(req.get('X-Room-Pin') || req.body?.currentPin || '');
      if (!verifyRoomPin(room, currentPin)) {
        return res.status(403).json({ error: 'Current Producer PIN is incorrect' });
      }
    }
    const newPin = typeof req.body?.newPin === 'string' ? req.body.newPin.trim() : '';
    if (newPin.length > 32) {
      return res.status(400).json({ error: 'PIN must be 32 characters or fewer' });
    }
    if (!newPin) {
      room.pinHash = null;
      room.pinSalt = null;
    } else {
      const salt = crypto.randomBytes(16).toString('hex');
      room.pinSalt = salt;
      room.pinHash = hashPin(newPin, salt);
    }
    room.updatedAt = Date.now();
    scheduleRoomDiskSave(req.roomId, room);
    res.json({ ok: true, hasPin: !!room.pinHash });
  }
);

/* =========================================================
   /assets/ MEDIA LIBRARY API (BROWSE, UPLOAD, DELETE)
   ========================================================= */
app.get('/api/assets', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ assets: listAssetsOnDisk() });
});

app.post(
  '/api/assets',
  writeRateLimit,
  express.json({ limit: '12mb' }),
  (req, res) => {
    const auth = authorizeWriteRequest(req);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    const rawDataUrl = String(req.body?.dataUrl || '').trim();
    const rawName = String(req.body?.filename || '').trim();
    const match = /^data:(image\/(png|jpeg|jpg|webp|gif|apng)|video\/(webm|mp4));base64,([A-Za-z0-9+/=]+)$/i.exec(rawDataUrl);
    if (!match) {
      return res.status(400).json({ error: 'Only PNG, JPEG, WebP, GIF, WebM, or MP4 uploads are supported.' });
    }
    const buf = Buffer.from(match[4], 'base64');
    if (!buf.length || buf.length > MAX_ASSET_BYTES) {
      return res.status(413).json({ error: 'Asset must be 8 MB or smaller.' });
    }
    const verified = detectVerifiedMedia(buf);
    if (!verified) {
      return res.status(400).json({ error: 'Uploaded file failed format verification.' });
    }

    const existing = listAssetsOnDisk();
    if (existing.length >= MAX_ASSET_FILES) {
      return res.status(400).json({ error: `Asset library limit (${MAX_ASSET_FILES} files) reached. Delete unused assets first.` });
    }

    const baseStem = rawName
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || `asset-${Date.now()}`;

    let finalName = `${baseStem}${verified.ext}`;
    let fullPath = getSafeAssetPath(finalName);
    if (fullPath && fs.existsSync(fullPath) && req.body?.overwrite !== true) {
      finalName = `${baseStem}-${Date.now().toString(36).slice(-4)}${verified.ext}`;
      fullPath = getSafeAssetPath(finalName);
    }
    if (!fullPath) {
      return res.status(400).json({ error: 'Invalid asset filename.' });
    }

    try {
      fs.writeFileSync(fullPath, buf);
      const stat = fs.statSync(fullPath);
      const asset = {
        name: finalName,
        url: `./assets/${finalName}`,
        kind: verified.kind,
        mime: verified.mime,
        size: stat.size,
        updatedAt: Math.round(stat.mtimeMs),
        source: USING_VOLUME ? 'volume' : 'local',
        deletable: true,
      };
      syncAssetsManifestFile();
      broadcastToAllStudios('assets', { action: 'added', asset });
      res.json({ ok: true, asset });
    } catch {
      res.status(500).json({ error: 'Failed to save asset file.' });
    }
  }
);

app.delete('/api/assets/:filename', writeRateLimit, (req, res) => {
  const auth = authorizeWriteRequest(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const filename = String(req.params.filename || '').trim();
  const fullPath = getSafeAssetPath(filename);
  if (!fullPath) return res.status(400).json({ error: 'Invalid filename' });
  if (!fs.existsSync(fullPath)) {
    const bundledPath = USING_VOLUME ? getSafePathInDir(BUNDLED_ASSETS_DIR, filename) : null;
    if (bundledPath && fs.existsSync(bundledPath)) {
      return res.status(400).json({ error: 'Built-in GitHub /assets/ files cannot be deleted here — remove them from your repository instead.' });
    }
    return res.status(404).json({ error: 'Asset not found' });
  }
  try {
    fs.unlinkSync(fullPath);
    syncAssetsManifestFile();
    broadcastToAllStudios('assets', { action: 'deleted', name: filename });
    res.json({ ok: true, name: filename });
  } catch {
    res.status(500).json({ error: 'Could not delete asset.' });
  }
});

/* =========================================================
   SAVED TEAMS & OPPONENT PRESETS FLAT-FILE API
   ========================================================= */
app.get('/api/presets/teams', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ teams: cachedTeamPresets });
});

app.put(
  '/api/presets/teams',
  writeRateLimit,
  express.json({ limit: '256kb' }),
  (req, res) => {
    const auth = authorizeWriteRequest(req);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    if (!Array.isArray(req.body?.teams)) {
      return res.status(400).json({ error: 'Invalid teams preset list' });
    }
    const saved = saveTeamPresetsToDisk(req.body.teams);
    broadcastToAllStudios('presets', { teams: saved });
    res.json({ ok: true, teams: saved });
  }
);

/* =========================================================
   STATIC FILE SERVING (WITH VOLUME ASSETS & DATA CONFINEMENT)
   ========================================================= */
const BLOCKED_PATHS = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
]);

app.use((req, res, next) => {
  const normalized = path.posix.normalize(req.path);
  if (
    BLOCKED_PATHS.has(normalized) ||
    normalized.startsWith('/node_modules') ||
    normalized === '/data' ||
    normalized.startsWith('/data/') ||
    normalized.split('/').some((seg) => seg.startsWith('.'))
  ) {
    return res.status(404).send('Not found');
  }
  next();
});

if (USING_VOLUME) {
  app.use(
    '/assets',
    express.static(UPLOADED_ASSETS_DIR, {
      dotfiles: 'ignore',
      fallthrough: true,
    })
  );
}

app.use(
  express.static(__dirname, {
    dotfiles: 'ignore',
    index: 'index.html',
  })
);

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  const storageMode = USING_VOLUME ? 'persistent volume' : 'local folder';
  const lockMode = ADMIN_PIN_ENABLED ? 'ADMIN_PIN enabled' : 'open (no ADMIN_PIN)';
  console.log(`Hockey Broadcast Studio v9 listening on http://${HOST}:${PORT} [${storageMode}, ${lockMode}]`);
});
