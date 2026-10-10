'use strict';

/**
 * imgdrop — 極簡手機圖片上傳伺服器
 * ------------------------------------------------------------------
 *  • 零 npm 依賴：只用 Node.js 內建模組（node:http / node:sqlite / node:crypto）
 *  • 上傳需要「上傳碼」，刪除需要該張圖片的「刪除碼」（或同裝置的本機權杖）
 *  • 圖片自動過期刪除（預設 24 小時），到期即從磁碟移除
 *  • 無需登入、無需帳號
 *
 * 啟動：node --disable-warning=ExperimentalWarning server.js
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

// =====================================================================
// 1. 設定
// =====================================================================

const ENV_DUPLICATES = loadEnvFile(path.join(__dirname, '.env'));

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'imgdrop.db');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = intEnv('PORT', 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_NAME = process.env.SITE_NAME || 'imgdrop 圖片上傳';

// 上傳碼：必填。沒有設定就不准上傳（安全預設）。
const UPLOAD_CODE = normalizeCodeString(process.env.UPLOAD_CODE || '');

// 管理金鑰：選填，用於 /api/stats 與手動清理。
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();

const DEFAULT_EXPIRE_HOURS = intEnv('DEFAULT_EXPIRE_HOURS', 24);
const MAX_EXPIRE_HOURS = intEnv('MAX_EXPIRE_HOURS', 168);
const ALLOWED_EXPIRE_HOURS = (process.env.ALLOWED_EXPIRE_HOURS || '1,6,24,72,168')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_EXPIRE_HOURS)
  .sort((a, b) => a - b);

const MAX_FILE_BYTES = intEnv('MAX_FILE_BYTES', 20 * 1024 * 1024); // 20 MB
const MAX_THUMB_BYTES = intEnv('MAX_THUMB_BYTES', 1024 * 1024); // 1 MB
const MAX_TOTAL_BYTES = intEnv('MAX_TOTAL_BYTES', 2 * 1024 * 1024 * 1024); // 2 GB 磁碟配額
const MAX_PHOTOS = intEnv('MAX_PHOTOS', 20000);

const PUBLIC_GALLERY = boolEnv('PUBLIC_GALLERY', true); // 是否開放「全部照片」瀏覽
const TRUST_PROXY = boolEnv('TRUST_PROXY', false); // 前面有 Nginx/Caddy 時設 true

const MAX_UPLOADS_PER_HOUR = intEnv('MAX_UPLOADS_PER_HOUR', 120); // 每個 IP
const MAX_UPLOADS_GLOBAL_PER_HOUR = intEnv('MAX_UPLOADS_GLOBAL_PER_HOUR', 2000);
const MAX_DELETES_PER_HOUR = intEnv('MAX_DELETES_PER_HOUR', 120);
const MAX_THUMBS_PER_HOUR = intEnv('MAX_THUMBS_PER_HOUR', 400);
const MAX_LIST_PER_MINUTE = intEnv('MAX_LIST_PER_MINUTE', 120);

const CLEANUP_INTERVAL_MS = intEnv('CLEANUP_INTERVAL_SECONDS', 60) * 1000;
const CODE_LENGTH = 8;
const ID_LENGTH = 12;

// =====================================================================
// 2. 小工具
// =====================================================================

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * 讀取 .env。
 *
 * 規則：同一個鍵重複出現時，**第一次出現的勝出**（與「已存在的環境變數不被覆蓋」
 * 一致）。重複的鍵會被收集起來，啟動時大聲警告 —— 因為重複的鍵幾乎都是
 * 手動編輯留下來的，而且往往是安全相關的設定（例如 PUBLIC_GALLERY）。
 */
function loadEnvFile(file) {
  const duplicates = [];
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return duplicates;
  }

  const seen = new Map(); // key -> { values: string[], used: string|null }

  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    const entry = seen.get(key) || { values: [], used: null };
    entry.values.push(value);
    if (process.env[key] === undefined) {
      process.env[key] = value;
      entry.used = value;
    } else if (entry.used === null) {
      entry.used = '(由環境變數覆蓋，.env 的值未採用)';
    }
    seen.set(key, entry);
  }

  for (const [key, entry] of seen) {
    if (entry.values.length > 1) {
      duplicates.push({ key, values: entry.values, used: entry.used });
    }
  }
  return duplicates;
}

/** 上傳碼正規化：去空白、轉大寫（手機鍵盤常自動首字大寫）。 */
function normalizeCodeString(s) {
  return String(s || '').trim().toUpperCase();
}

/** 刪除碼正規化：Crockford Base32，把易混淆字元 O→0、I/L→1。 */
function normalizeDeleteCode(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** 長度無關的常數時間比較。 */
function safeEqual(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  const len = Math.max(A.length, B.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  A.copy(pa);
  B.copy(pb);
  return A.length === B.length && crypto.timingSafeEqual(pa, pb);
}

/** 人類可讀的檔案大小（給錯誤訊息用）。 */
function fmtBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(n % 1048576 === 0 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CROCKFORD[crypto.randomInt(0, CROCKFORD.length)];
  return out;
}

function randomId(length = ID_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CROCKFORD[crypto.randomInt(0, CROCKFORD.length)].toLowerCase();
  return out;
}

// ---- 資料目錄：必須在任何讀寫之前建立好 ----
// （沒有這段的話，DATA_DIR 不存在時 secret.key 會寫入失敗並以 ENOENT 崩潰）
for (const dir of [DATA_DIR, FILES_DIR, THUMBS_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

// ---- 伺服器密鑰（用於雜湊刪除碼／裝置權杖，避免資料庫外洩即可反推）----
function loadOrCreateSecret() {
  if (process.env.HASH_SECRET && process.env.HASH_SECRET.length >= 16) {
    return process.env.HASH_SECRET;
  }
  try {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* 檔案不存在，繼續建立 */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o750 });
  fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
  return secret;
}

const SECRET = loadOrCreateSecret();

function hashWithSecret(kind, value) {
  return crypto.createHash('sha256').update(`${SECRET}|${kind}|${value}`).digest('hex');
}

const hashDeleteCode = (code) => hashWithSecret('del', normalizeDeleteCode(code));
const hashDevice = (token) => hashWithSecret('dev', String(token || '').trim());
const hashIp = (ip) => hashWithSecret('ip', ip).slice(0, 24);

// =====================================================================
// 3. 資料庫（Node 內建 SQLite）
// =====================================================================

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(
    '\n[imgdrop] 這個 Node.js 版本沒有內建 node:sqlite。\n' +
      '          請升級到 Node.js 22.13+ 或 24 LTS 後再啟動。\n' +
      '          目前版本：' + process.version + '\n' +
      '          安裝方式：curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs\n'
  );
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS photos (
    id           TEXT PRIMARY KEY,
    mime         TEXT    NOT NULL,
    ext          TEXT    NOT NULL,
    size         INTEGER NOT NULL,
    has_thumb    INTEGER NOT NULL DEFAULT 0,
    thumb_size   INTEGER NOT NULL DEFAULT 0,
    orig_name    TEXT,
    delete_hash  TEXT    NOT NULL,
    device_hash  TEXT,
    ip_hash      TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_photos_expires ON photos(expires_at);
  CREATE INDEX IF NOT EXISTS idx_photos_device  ON photos(device_hash, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created_at DESC);
`);

const q = {
  insert: db.prepare(`INSERT INTO photos
      (id, mime, ext, size, has_thumb, thumb_size, orig_name, delete_hash, device_hash, ip_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`),
  byId: db.prepare('SELECT * FROM photos WHERE id = ?'),
  del: db.prepare('DELETE FROM photos WHERE id = ?'),
  setThumb: db.prepare('UPDATE photos SET has_thumb = 1, thumb_size = ? WHERE id = ?'),
  expired: db.prepare('SELECT id, ext, has_thumb FROM photos WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?'),
  recent: db.prepare('SELECT * FROM photos ORDER BY created_at DESC, id DESC LIMIT ?'),
  recentBefore: db.prepare('SELECT * FROM photos WHERE created_at < ? ORDER BY created_at DESC LIMIT ?'),
  mine: db.prepare('SELECT * FROM photos WHERE device_hash = ? ORDER BY created_at DESC LIMIT ?'),
  mineBefore: db.prepare('SELECT * FROM photos WHERE device_hash = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'),
  totals: db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size + thumb_size), 0) AS bytes FROM photos'),
  allIds: db.prepare('SELECT id, ext, has_thumb FROM photos'),
  oldest: db.prepare('SELECT MIN(created_at) AS t FROM photos'),
};

// =====================================================================
// 4. 速率限制（記憶體內滑動視窗）
// =====================================================================

const buckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    const err = new HttpError(429, `操作太頻繁，請於 ${Math.ceil((b.resetAt - now) / 1000)} 秒後再試`);
    err.retryAfter = Math.ceil((b.resetAt - now) / 1000);
    throw err;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

// =====================================================================
// 5. HTTP 輔助
// =====================================================================

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

function sendJson(res, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: message }, extra);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.length) return real.trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function headerValue(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : '';
}

/** 錯誤路徑用：把請求內容讀掉，避免客戶端收到 RST 而看不到錯誤訊息。 */
async function drain(req, limit = 1_000_000) {
  let read = 0;
  try {
    for await (const chunk of req) {
      read += chunk.length;
      if (read > limit) {
        req.destroy();
        return;
      }
    }
  } catch {
    /* 忽略 */
  }
}

// =====================================================================
// 6. 圖片類型偵測（看 magic bytes，不信副檔名）
// =====================================================================

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') return { mime: 'image/gif', ext: '.gif' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: '.avif' };
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return { mime: 'image/heic', ext: '.heic', unsupported: 'HEIC' };
    }
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: 'image/bmp', ext: '.bmp' };
  }
  return null;
}

// =====================================================================
// 7. 檔案存取
// =====================================================================

const filePath = (id, ext) => path.join(FILES_DIR, `${id}${ext}`);
const thumbPath = (id) => path.join(THUMBS_DIR, `${id}.jpg`);

async function removeQuietly(p) {
  try {
    await fsp.unlink(p);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[imgdrop] 刪檔失敗', p, err.code);
  }
}

async function deletePhotoFiles(row) {
  await removeQuietly(filePath(row.id, row.ext));
  if (row.has_thumb) await removeQuietly(thumbPath(row.id));
}

function safeDownloadName(row) {
  const base = (row.orig_name || `photo-${row.id}`).replace(/[\\/\r\n"\\]/g, '_').slice(0, 120);
  const ext = row.ext || '';
  const withExt = base.toLowerCase().endsWith(ext) ? base : base + ext;
  return withExt || `photo-${row.id}${ext}`;
}

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// =====================================================================
// 8. 清理：過期刪除、孤兒檔、總量
// =====================================================================

let lastCleanup = { at: 0, removed: 0, bytes: 0 };

async function cleanupExpired(limit = 200) {
  const rows = q.expired.all(Date.now(), limit);
  let bytes = 0;
  for (const row of rows) {
    const info = q.byId.get(row.id);
    if (info) bytes += info.size + info.thumb_size;
    await deletePhotoFiles(row);
    q.del.run(row.id);
  }
  if (rows.length) {
    lastCleanup = { at: Date.now(), removed: rows.length, bytes };
    console.log(`[imgdrop] 已清理 ${rows.length} 張過期圖片（釋放 ${(bytes / 1048576).toFixed(2)} MB）`);
  }
  return rows.length;
}

/** 資料庫沒有紀錄、卻還躺在磁碟上的檔案（例如中途崩潰）→ 刪掉。 */
async function sweepOrphans() {
  const known = new Set();
  for (const row of q.allIds.all()) {
    known.add(`${row.id}${row.ext}`);
    if (row.has_thumb) known.add(`t:${row.id}.jpg`);
  }
  let removed = 0;
  const dirs = [
    [FILES_DIR, (n) => known.has(n)],
    [THUMBS_DIR, (n) => known.has(`t:${n}`)],
  ];
  for (const [dir, isKnown] of dirs) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (isKnown(name)) continue;
      await removeQuietly(path.join(dir, name));
      removed += 1;
    }
  }
  // 清掉殘留的暫存上傳片段
  try {
    const tmpNames = await fsp.readdir(TMP_DIR);
    const cutoff = Date.now() - 3600_000;
    for (const name of tmpNames) {
      const p = path.join(TMP_DIR, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) await removeQuietly(p);
    }
  } catch {
    /* 忽略 */
  }
  if (removed) console.log(`[imgdrop] 已移除 ${removed} 個無主檔案`);
  return removed;
}

function storageUsage() {
  return q.totals.get();
}

async function diskFreeBytes() {
  try {
    const st = await fsp.statfs(DATA_DIR);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

async function ensureCapacity(incomingBytes) {
  const { bytes, count } = storageUsage();
  if (count >= MAX_PHOTOS) {
    await cleanupExpired(500);
    const after = storageUsage();
    if (after.count >= MAX_PHOTOS) {
      throw new HttpError(507, `圖片數量已達上限（${MAX_PHOTOS} 張），請稍後再試或手動清理`);
    }
    return;
  }
  if (bytes + incomingBytes > MAX_TOTAL_BYTES) {
    await cleanupExpired(500);
    const after = storageUsage();
    if (after.bytes + incomingBytes > MAX_TOTAL_BYTES) {
      const free = (MAX_TOTAL_BYTES - after.bytes) / 1048576;
      throw new HttpError(507, `伺服器儲存空間已滿（剩餘約 ${free.toFixed(1)} MB），請稍後再試`);
    }
  }
}

// =====================================================================
// 9. API 處理
// =====================================================================

function photoToJson(row, deviceHash) {
  return {
    id: row.id,
    mime: row.mime,
    size: row.size,
    thumbSize: row.thumb_size,
    hasThumb: !!row.has_thumb,
    name: row.orig_name || null,
    url: `/i/${row.id}`,
    thumbUrl: `/t/${row.id}`,
    downloadUrl: `/d/${row.id}`,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    isMine: !!deviceHash && row.device_hash === deviceHash,
  };
}

function apiConfig() {
  return {
    ok: true,
    siteName: SITE_NAME,
    publicGallery: PUBLIC_GALLERY,
    defaultExpireHours: DEFAULT_EXPIRE_HOURS,
    maxExpireHours: MAX_EXPIRE_HOURS,
    allowedExpireHours: ALLOWED_EXPIRE_HOURS,
    maxFileBytes: MAX_FILE_BYTES,
    maxThumbBytes: MAX_THUMB_BYTES,
    deleteCodeLength: CODE_LENGTH,
  };
}

/** 把 raw body 寫入暫存檔，同時限制大小並讀取開頭 bytes 判斷型別。 */
async function saveUploadToTmp(req, id) {
  const tmpFile = path.join(TMP_DIR, `${id}.part`);
  const out = fs.createWriteStream(tmpFile, { flags: 'wx', mode: 0o640 });
  // 超過上限後不再寫檔，但繼續把剩餘資料讀掉（有硬上限），
  // 這樣才能送出乾淨的 413 而不是直接斷線。
  const HARD_DRAIN_LIMIT = MAX_FILE_BYTES * 2;
  let size = 0;
  let drained = 0;
  let over = false;
  let head = Buffer.alloc(0);
  let failed = null;
  try {
    for await (const chunk of req) {
      if (over) {
        drained += chunk.length;
        if (drained > HARD_DRAIN_LIMIT) break;
        continue;
      }
      if (head.length < 32) {
        head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
      }
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        over = true;
        continue;
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } catch (err) {
    failed = err;
  }
  try {
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    failed = failed || err;
  }
  if (failed || over) {
    await removeQuietly(tmpFile);
    if (failed) throw failed;
    throw new HttpError(413, `檔案太大（上限 ${fmtBytes(MAX_FILE_BYTES)}）`);
  }
  if (size === 0) {
    await removeQuietly(tmpFile);
    throw new HttpError(400, '沒有收到檔案內容');
  }
  return { tmpFile, size, head };
}

async function handleUpload(req, res) {
  const ip = clientIp(req);
  rateLimit(`up:${ip}`, MAX_UPLOADS_PER_HOUR, 3600_000);
  rateLimit('up:global', MAX_UPLOADS_GLOBAL_PER_HOUR, 3600_000);

  if (!UPLOAD_CODE) {
    await drain(req);
    throw new HttpError(503, '伺服器尚未設定上傳碼（UPLOAD_CODE），請聯絡管理員');
  }

  const supplied = normalizeCodeString(headerValue(req, 'x-upload-code'));
  if (!safeEqual(supplied, UPLOAD_CODE)) {
    await drain(req);
    throw new HttpError(403, '上傳碼不正確');
  }

  const declared = Number.parseInt(headerValue(req, 'content-length'), 10);
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    await drain(req);
    throw new HttpError(413, `檔案太大（上限 ${fmtBytes(MAX_FILE_BYTES)}）`);
  }

  await ensureCapacity(Math.max(0, declared || 0));

  const id = randomId();
  const { tmpFile, size, head } = await saveUploadToTmp(req, id);

  const kind = sniffImage(head);
  if (!kind) {
    await removeQuietly(tmpFile);
    throw new HttpError(415, '這不是支援的圖片格式（只接受 JPEG / PNG / GIF / WebP / AVIF / BMP）');
  }
  if (kind.unsupported) {
    await removeQuietly(tmpFile);
    throw new HttpError(415, '不支援 HEIC 格式，請在手機上開啟「壓縮後上傳」再試');
  }

  // 過期時間
  let expireHours = Number.parseInt(headerValue(req, 'x-expire-hours'), 10);
  if (!Number.isFinite(expireHours) || expireHours <= 0) expireHours = DEFAULT_EXPIRE_HOURS;
  expireHours = Math.min(expireHours, MAX_EXPIRE_HOURS);

  const deleteCode = randomCode(CODE_LENGTH);
  const deviceToken = headerValue(req, 'x-device-token').trim().slice(0, 128);
  const deviceHash = deviceToken.length >= 8 ? hashDevice(deviceToken) : null;
  const origName = (() => {
    const raw = headerValue(req, 'x-file-name');
    if (!raw) return null;
    try {
      return decodeURIComponent(raw).slice(0, 160) || null;
    } catch {
      return raw.slice(0, 160) || null;
    }
  })();

  const now = Date.now();
  const expiresAt = now + expireHours * 3600_000;
  const finalPath = filePath(id, kind.ext);

  try {
    await fsp.rename(tmpFile, finalPath);
    await fsp.chmod(finalPath, 0o640).catch(() => {});
    q.insert.run(id, kind.mime, kind.ext, size, origName, hashDeleteCode(deleteCode), deviceHash, hashIp(ip), now, expiresAt);
  } catch (err) {
    await removeQuietly(tmpFile);
    await removeQuietly(finalPath);
    throw err;
  }

  console.log(
    `[imgdrop] 上傳 ${id} ${kind.mime} ${(size / 1024).toFixed(0)} KB 由 ${hashIp(ip).slice(0, 8)}… 到期 ${new Date(expiresAt).toISOString()}`
  );

  sendJson(res, 201, {
    ok: true,
    id,
    deleteCode,
    deleteCodeHint: `${deleteCode.slice(0, 4)}-${deleteCode.slice(4)}`,
    url: `/i/${id}`,
    thumbUrl: `/t/${id}`,
    downloadUrl: `/d/${id}`,
    mime: kind.mime,
    size,
    createdAt: now,
    expiresAt,
    expireHours,
  });
}

async function handleThumbUpload(req, res, id) {
  const ip = clientIp(req);
  rateLimit(`th:${ip}`, MAX_THUMBS_PER_HOUR, 3600_000);

  const row = q.byId.get(id);
  if (!row) {
    await drain(req);
    throw new HttpError(404, '找不到這張圖片（可能已被刪除或過期）');
  }

  const token = headerValue(req, 'x-device-token').trim();
  const deviceHash = token ? hashDevice(token) : null;
  if (!row.device_hash || !deviceHash || !safeEqual(deviceHash, row.device_hash)) {
    await drain(req);
    throw new HttpError(403, '沒有權限為這張圖片加上縮圖');
  }

  const declared = Number.parseInt(headerValue(req, 'content-length'), 10);
  if (Number.isFinite(declared) && declared > MAX_THUMB_BYTES) {
    await drain(req);
    throw new HttpError(413, '縮圖太大');
  }

  const tmpFile = path.join(TMP_DIR, `${id}.thumb.part`);
  const out = fs.createWriteStream(tmpFile, { flags: 'w', mode: 0o640 });
  let size = 0;
  let drained = 0;
  let over = false;
  let head = Buffer.alloc(0);
  let failed = null;
  try {
    for await (const chunk of req) {
      if (over) {
        drained += chunk.length;
        if (drained > MAX_THUMB_BYTES * 2) break;
        continue;
      }
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      size += chunk.length;
      if (size > MAX_THUMB_BYTES) {
        over = true;
        continue;
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
  } catch (err) {
    failed = err;
  }
  try {
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (err) {
    failed = failed || err;
  }

  if (failed || over) {
    await removeQuietly(tmpFile);
    throw failed || new HttpError(413, '縮圖太大');
  }

  const kind = sniffImage(head);
  if (!kind || !/^image\/(jpeg|png|webp)$/.test(kind.mime) || size === 0) {
    await removeQuietly(tmpFile);
    throw new HttpError(415, '縮圖格式不正確');
  }

  await fsp.rename(tmpFile, thumbPath(id));
  await fsp.chmod(thumbPath(id), 0o640).catch(() => {});
  q.setThumb.run(size, id);

  sendJson(res, 200, { ok: true, thumbUrl: `/t/${id}`, thumbSize: size });
}

async function handleDelete(req, res, id) {
  const ip = clientIp(req);
  rateLimit(`del:${ip}`, MAX_DELETES_PER_HOUR, 3600_000);

  const row = q.byId.get(id);
  await drain(req);
  if (!row) throw new HttpError(404, '找不到這張圖片（可能已被刪除或過期）');

  const code = headerValue(req, 'x-delete-code');
  const token = headerValue(req, 'x-device-token').trim();

  let allowed = false;
  let how = '';
  if (code) {
    if (safeEqual(hashDeleteCode(code), row.delete_hash)) {
      allowed = true;
      how = 'delete-code';
    }
  }
  if (!allowed && token && row.device_hash && safeEqual(hashDevice(token), row.device_hash)) {
    allowed = true;
    how = 'device';
  }
  if (!allowed) throw new HttpError(403, '刪除碼不正確（或用於上傳的裝置不同）');

  await deletePhotoFiles(row);
  q.del.run(id);
  console.log(`[imgdrop] 刪除 ${id}（${how}）`);

  sendJson(res, 200, { ok: true, id, deleted: true });
}

async function handleList(req, res, url) {
  const ip = clientIp(req);
  rateLimit(`ls:${ip}`, MAX_LIST_PER_MINUTE, 60_000);

  const scope = url.searchParams.get('scope') === 'mine' ? 'mine' : 'all';
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '60', 10) || 60, 1), 200);
  const beforeRaw = Number.parseInt(url.searchParams.get('before') || '', 10);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

  const token = headerValue(req, 'x-device-token').trim();
  const deviceHash = token ? hashDevice(token) : null;

  let rows;
  if (scope === 'mine') {
    if (!deviceHash) throw new HttpError(400, '缺少裝置權杖，無法列出你的上傳');
    rows = before ? q.mineBefore.all(deviceHash, before, limit) : q.mine.all(deviceHash, limit);
  } else {
    if (!PUBLIC_GALLERY) throw new HttpError(403, '這個伺服器沒有開放共用相簿');
    rows = before ? q.recentBefore.all(before, limit) : q.recent.all(limit);
  }

  const items = rows.map((r) => photoToJson(r, deviceHash));
  const nextBefore = rows.length === limit ? rows[rows.length - 1].created_at : null;
  sendJson(res, 200, { ok: true, scope, items, nextBefore });
}

async function handleStats(req, res) {
  const key = headerValue(req, 'x-admin-key');
  if (!ADMIN_KEY || !safeEqual(key, ADMIN_KEY)) throw new HttpError(403, '需要管理金鑰');

  const { count, bytes } = storageUsage();
  const oldest = q.oldest.get();
  sendJson(res, 200, {
    ok: true,
    photos: count,
    bytes,
    megabytes: +(bytes / 1048576).toFixed(2),
    quotaBytes: MAX_TOTAL_BYTES,
    diskFreeBytes: await diskFreeBytes(),
    oldestCreatedAt: oldest?.t || null,
    lastCleanup,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
    node: process.version,
  });
}

// ---- 圖片輸出 ----

async function serveImage(req, res, id, mode) {
  if (!/^[a-z0-9]{6,32}$/.test(id)) throw new HttpError(404, '找不到圖片');
  const row = q.byId.get(id);
  if (!row) throw new HttpError(404, '找不到這張圖片（可能已被刪除或過期）');

  const wantThumb = mode === 'thumb' && row.has_thumb;
  const file = wantThumb ? thumbPath(row.id) : filePath(row.id, row.ext);
  const mime = wantThumb ? 'image/jpeg' : row.mime;

  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    // 檔案不見了，順手清掉資料庫紀錄
    q.del.run(row.id);
    throw new HttpError(404, '圖片檔案已不存在');
  }

  const etag = `"${row.id}-${wantThumb ? 't' : 'f'}-${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': mime,
    'Content-Length': st.size,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
  };
  if (mode === 'download') {
    headers['Content-Disposition'] = contentDisposition('attachment', safeDownloadName(row));
    headers['Cache-Control'] = 'private, max-age=300';
  } else {
    headers['Content-Disposition'] = contentDisposition('inline', safeDownloadName(row));
  }

  if (headerValue(req, 'if-none-match') === etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag, 'Cache-Control': headers['Cache-Control'] });
    res.end();
    return;
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---- 靜態檔案 ----

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';

  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(403, '禁止存取');
  }

  const st = await fsp.stat(target).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, '找不到頁面');

  const ext = path.extname(target).toLowerCase();
  const isHtml = ext === '.html';
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
  };
  if (isHtml) {
    headers['Content-Security-Policy'] =
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
  }

  const etag = `"s-${st.size}-${Math.round(st.mtimeMs)}"`;
  if (headerValue(req, 'if-none-match') === etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag });
    res.end();
    return;
  }
  headers.ETag = etag;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(target);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// =====================================================================
// 10. 路由
// =====================================================================

async function handleRequest(req, res) {
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.LOG_REQUESTS === 'true') {
      console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(res, 400, '網址格式錯誤');
    return;
  }

  const seg = pathname.split('/').filter(Boolean);
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  // 圖片輸出：/i/<id>、/t/<id>、/d/<id>，允許 /i/<id>.jpg 這種帶副檔名的寫法
  if (seg.length === 2 && ['i', 't', 'd'].includes(seg[0])) {
    const id = seg[1].split('.')[0].toLowerCase();
    const mode = seg[0] === 'i' ? 'full' : seg[0] === 't' ? 'thumb' : 'download';
    await serveImage(req, res, id, mode);
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (method === 'POST' && pathname === '/api/upload') return handleUpload(req, res);
    if (method === 'GET' && pathname === '/api/photos') return handleList(req, res, url);
    if (method === 'GET' && pathname === '/api/config') return sendJson(res, 200, apiConfig());
    if (method === 'GET' && pathname === '/api/health') {
      const { count, bytes } = storageUsage();
      return sendJson(res, 200, { ok: true, photos: count, bytes, uptimeSeconds: Math.round(process.uptime()) });
    }
    if (method === 'GET' && pathname === '/api/stats') return handleStats(req, res);
    if (method === 'POST' && pathname === '/api/admin/cleanup') {
      const key = headerValue(req, 'x-admin-key');
      if (!ADMIN_KEY || !safeEqual(key, ADMIN_KEY)) throw new HttpError(403, '需要管理金鑰');
      await drain(req);
      const removed = await cleanupExpired(500);
      const orphans = await sweepOrphans();
      return sendJson(res, 200, { ok: true, expiredRemoved: removed, orphansRemoved: orphans });
    }

    const thumbMatch = /^\/api\/photo\/([a-z0-9]{6,32})\/thumb$/.exec(pathname);
    if (thumbMatch && method === 'POST') return handleThumbUpload(req, res, thumbMatch[1]);

    const photoMatch = /^\/api\/photo\/([a-z0-9]{6,32})$/.exec(pathname);
    if (photoMatch) {
      if (method === 'DELETE') return handleDelete(req, res, photoMatch[1]);
      if (method === 'GET') {
        const row = q.byId.get(photoMatch[1]);
        if (!row) throw new HttpError(404, '找不到這張圖片');
        const token = headerValue(req, 'x-device-token').trim();
        return sendJson(res, 200, { ok: true, photo: photoToJson(row, token ? hashDevice(token) : null) });
      }
    }

    throw new HttpError(404, '沒有這個 API');
  }

  if (method !== 'GET') throw new HttpError(405, '不支援的請求方法');
  await serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(async (err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[imgdrop] 伺服器錯誤：', err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const headers = {};
    if (err.retryAfter) headers['Retry-After'] = String(err.retryAfter);
    // 請求內容還沒讀完就要回錯誤時，關掉連線語意，讓客戶端能完整讀到錯誤訊息
    if (!req.complete) headers.Connection = 'close';
    try {
      sendError(res, status, status >= 500 ? '伺服器內部錯誤' : err.message, headers);
    } catch {
      res.destroy();
    }
  });
});

server.requestTimeout = 0; // 慢速上傳（手機網路）不設限
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;
server.maxRequestsPerSocket = 0;

// =====================================================================
// 11. 啟動
// =====================================================================

async function start() {
  await sweepOrphans();
  await cleanupExpired(500);
  setInterval(() => {
    cleanupExpired(200).catch((e) => console.warn('[imgdrop] 清理失敗', e.message));
  }, CLEANUP_INTERVAL_MS).unref();

  if (ENV_DUPLICATES.length) {
    console.warn('');
    console.warn('  \u26a0\uFE0F  .env 有重複的設定鍵 —— 這幾乎都是手動編輯留下來的，請清理：');
    for (const d of ENV_DUPLICATES) {
      console.warn(`     ${d.key} 出現了 ${d.values.length} 次：${d.values.map((v) => JSON.stringify(v)).join(' / ')}`);
      console.warn(`     目前採用：${JSON.stringify(d.used)}  （規則：第一次出現的勝出）`);
    }
    console.warn('     建議把重複的行刪掉，只留一行，避免日後誤判。');
    console.warn('');
  }

  server.listen(PORT, HOST, () => {
    const { count, bytes } = storageUsage();
    const free = MAX_TOTAL_BYTES - bytes;
    console.log('');
    console.log('  imgdrop 已啟動');
    console.log(`  網址        http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  上傳碼      ${UPLOAD_CODE ? '已設定 ✓' : '⚠ 未設定（UPLOAD_CODE）→ 目前無法上傳'}`);
    console.log(`  管理金鑰    ${ADMIN_KEY ? '已設定 ✓' : '未設定'}`);
    console.log(`  共用相簿    ${PUBLIC_GALLERY ? '開啟' : '關閉'}`);
    console.log(`  預設保存    ${DEFAULT_EXPIRE_HOURS} 小時（最長 ${MAX_EXPIRE_HOURS} 小時）`);
    console.log(`  儲存配額    ${(MAX_TOTAL_BYTES / 1073741824).toFixed(2)} GB（已用 ${(bytes / 1048576).toFixed(1)} MB / ${count} 張，剩 ${(free / 1048576).toFixed(0)} MB）`);
    console.log(`  資料目錄    ${DATA_DIR}`);
    console.log(`  Node        ${process.version}`);
    console.log('');
  });
}

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[imgdrop] 收到 ${sig}，正在關閉…`);
    server.close(() => {
      try {
        db.close();
      } catch {
        /* 忽略 */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (err) => console.error('[imgdrop] unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('[imgdrop] uncaughtException', err));

start().catch((err) => {
  console.error('[imgdrop] 啟動失敗：', err);
  process.exit(1);
});
