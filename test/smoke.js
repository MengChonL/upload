'use strict';

/**
 * imgdrop 端到端煙霧測試
 * 用法：npm run smoke   或   node --disable-warning=ExperimentalWarning test/smoke.js
 *
 * 會自己開一個獨立伺服器（隨機埠、暫存資料目錄），測完自動關閉與清理。
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UPLOAD_CODE = 'TESTCODE123';
const ADMIN_KEY = 'test-admin-key';
const MAX_FILE_BYTES = 4096;

// --- 1x1 PNG ---
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 0x41)]);

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function freePort() {
  return 32000 + Math.floor(Math.random() * 2000);
}

async function waitForReady(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 還沒起來 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('伺服器啟動逾時');
}

async function main() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgdrop-test-'));
  const port = freePort();
  const base = `http://127.0.0.1:${port}`;
  const device = 'a'.repeat(48);

  console.log(`\nimgdrop 煙霧測試\n  資料目錄 ${dataDir}\n  埠 ${port}\n`);

  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        UPLOAD_CODE,
        ADMIN_KEY,
        MAX_FILE_BYTES: String(MAX_FILE_BYTES),
        DEFAULT_EXPIRE_HOURS: '24',
        PUBLIC_GALLERY: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let serverLog = '';
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  const upload = async (body, opts = {}) => {
    const headers = {
      'Content-Type': opts.mime || 'image/png',
      'X-Upload-Code': opts.code === undefined ? UPLOAD_CODE : opts.code,
      'X-Device-Token': opts.device === undefined ? device : opts.device,
      'X-Expire-Hours': String(opts.expireHours || 24),
      'X-File-Name': encodeURIComponent(opts.name || 'test.png'),
      ...(opts.headers || {}),
    };
    const res = await fetch(`${base}/api/upload`, { method: 'POST', headers, body });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 忽略 */
    }
    return { res, json };
  };

  try {
    await waitForReady(base);

    // ---------- 基本 ----------
    await test('首頁可以載入，並帶有 CSP 與 noindex 標頭', async () => {
      const res = await fetch(`${base}/`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
      assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
      const html = await res.text();
      assert.match(html, /上傳碼/);
    });

    await test('靜態資源（CSS / JS / manifest）都拿得到', async () => {
      for (const p of ['/style.css', '/app.js', '/manifest.webmanifest', '/icon.svg']) {
        const res = await fetch(`${base}${p}`);
        assert.strictEqual(res.status, 200, `${p} 應該存在`);
      }
    });

    await test('路徑穿越被擋下', async () => {
      const res = await fetch(`${base}/../server.js`, { redirect: 'manual' });
      assert.ok(res.status === 403 || res.status === 404 || res.status === 400, `得到 ${res.status}`);
      const res2 = await fetch(`${base}/%2e%2e%2fserver.js`, { redirect: 'manual' });
      assert.ok(res2.status === 403 || res2.status === 404 || res2.status === 400, `得到 ${res2.status}`);
    });

    await test('/api/config 回傳前端需要的設定', async () => {
      const res = await fetch(`${base}/api/config`);
      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.ok, true);
      assert.strictEqual(json.maxFileBytes, MAX_FILE_BYTES);
      assert.deepStrictEqual(json.allowedExpireHours, [1, 6, 24, 72, 168]);
      assert.strictEqual(json.deleteCodeLength, 8);
    });

    // ---------- 上傳 ----------
    await test('沒有上傳碼時拒絕上傳', async () => {
      const { res, json } = await upload(PNG, { code: '' });
      assert.strictEqual(res.status, 403);
      assert.match(json.error, /上傳碼/);
    });

    await test('上傳碼錯誤時拒絕上傳', async () => {
      const { res } = await upload(PNG, { code: 'WRONGCODE' });
      assert.strictEqual(res.status, 403);
    });

    await test('非圖片內容被拒絕（415）', async () => {
      const { res, json } = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        mime: 'image/svg+xml',
        name: 'x.svg',
      });
      assert.strictEqual(res.status, 415);
      assert.match(json.error, /格式/);
    });

    await test('超過大小上限被拒絕（413）', async () => {
      const { res } = await upload(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_FILE_BYTES + 100, 1)]));
      assert.strictEqual(res.status, 413);
    });

    let photo = null;
    await test('正確上傳碼可以上傳 PNG，並取得刪除碼', async () => {
      const { res, json } = await upload(PNG, { name: '我的相片.png' });
      assert.strictEqual(res.status, 201, JSON.stringify(json));
      assert.strictEqual(json.ok, true);
      assert.match(json.id, /^[a-z0-9]{12}$/);
      assert.match(json.deleteCode, /^[0-9A-HJKMNP-TV-Z]{8}$/);
      assert.strictEqual(json.mime, 'image/png');
      assert.strictEqual(json.size, PNG.length);
      assert.ok(json.expiresAt > Date.now());
      assert.strictEqual(Math.round((json.expiresAt - json.createdAt) / 3600000), 24);
      photo = json;
    });

    await test('上傳的檔案真的寫進磁碟（不是只寫資料庫）', async () => {
      const p = path.join(dataDir, 'files', `${photo.id}.png`);
      const st = await fsp.stat(p);
      assert.strictEqual(st.size, PNG.length);
    });

    await test('圖片用 /i/<id> 讀得回來，並且型別正確', async () => {
      const res = await fetch(`${base}${photo.url}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/png');
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.equals(PNG));
    });

    await test('帶副檔名的網址也通（/i/<id>.png）', async () => {
      const res = await fetch(`${base}/i/${photo.id}.png`);
      assert.strictEqual(res.status, 200);
    });

    await test('沒有縮圖時 /t/<id> 會回原圖', async () => {
      const res = await fetch(`${base}${photo.thumbUrl}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/png');
    });

    await test('ETag 命中時回 304', async () => {
      const first = await fetch(`${base}${photo.url}`);
      const etag = first.headers.get('etag');
      assert.ok(etag);
      const second = await fetch(`${base}${photo.url}`, { headers: { 'If-None-Match': etag } });
      assert.strictEqual(second.status, 304);
    });

    await test('/d/<id> 會帶 attachment 下載標頭', async () => {
      const res = await fetch(`${base}${photo.downloadUrl}`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-disposition') || '', /attachment/);
    });

    await test('上傳縮圖後 /t/<id> 改用縮圖', async () => {
      const res = await fetch(`${base}/api/photo/${photo.id}/thumb`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Device-Token': device },
        body: JPEG_HEAD.subarray(0, 800),
      });
      assert.strictEqual(res.status, 200, await res.text());
      const t = await fetch(`${base}${photo.thumbUrl}`);
      assert.strictEqual(t.headers.get('content-type'), 'image/jpeg');
      assert.strictEqual(Number(t.headers.get('content-length')), 800);
    });

    await test('別人（沒有裝置權杖）不能上傳縮圖', async () => {
      const res = await fetch(`${base}/api/photo/${photo.id}/thumb`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', 'X-Device-Token': 'b'.repeat(48) },
        body: JPEG_HEAD.subarray(0, 100),
      });
      assert.strictEqual(res.status, 403);
    });

    // ---------- 列表 ----------
    await test('scope=mine 只列出這部裝置的上傳', async () => {
      const res = await fetch(`${base}/api/photos?scope=mine`, {
        headers: { 'X-Device-Token': device },
      });
      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.items.length, 1);
      assert.strictEqual(json.items[0].id, photo.id);
      assert.strictEqual(json.items[0].isMine, true);
      assert.strictEqual(json.items[0].hasThumb, true);
      assert.strictEqual(json.items[0].deleteCode, undefined, '不應該回傳刪除碼');
    });

    await test('scope=mine 沒有裝置權杖時報錯', async () => {
      const res = await fetch(`${base}/api/photos?scope=mine`);
      assert.strictEqual(res.status, 400);
    });

    await test('scope=all 列出全部照片', async () => {
      const res = await fetch(`${base}/api/photos?scope=all`);
      const json = await res.json();
      assert.strictEqual(res.status, 200);
      assert.ok(json.items.length >= 1);
    });

    // ---------- 刪除 ----------
    await test('刪除碼錯誤時不能刪除（403），圖片仍在', async () => {
      const res = await fetch(`${base}/api/photo/${photo.id}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Code': 'ZZZZZZZZ' },
      });
      assert.strictEqual(res.status, 403);
      const check = await fetch(`${base}${photo.url}`);
      assert.strictEqual(check.status, 200);
    });

    await test('用小寫／含連字號的刪除碼也能刪除（容錯）', async () => {
      const messy = `${photo.deleteCode.slice(0, 4).toLowerCase()}-${photo.deleteCode.slice(4).toLowerCase()}`;
      const res = await fetch(`${base}/api/photo/${photo.id}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Code': messy },
      });
      assert.strictEqual(res.status, 200, await res.text());
    });

    await test('刪除後圖片 404，檔案也從磁碟消失', async () => {
      const res = await fetch(`${base}${photo.url}`);
      assert.strictEqual(res.status, 404);
      const file = path.join(dataDir, 'files', `${photo.id}.png`);
      const exists = await fsp
        .stat(file)
        .then(() => true)
        .catch(() => false);
      assert.strictEqual(exists, false, '檔案應該已刪除');
      const thumb = path.join(dataDir, 'thumbs', `${photo.id}.jpg`);
      const thumbExists = await fsp
        .stat(thumb)
        .then(() => true)
        .catch(() => false);
      assert.strictEqual(thumbExists, false, '縮圖應該已刪除');
    });

    await test('已刪除的圖片再刪一次回 404', async () => {
      const res = await fetch(`${base}/api/photo/${photo.id}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Code': photo.deleteCode },
      });
      assert.strictEqual(res.status, 404);
    });

    // ---------- 裝置刪除（不需要刪除碼）----------
    let photo2 = null;
    await test('同一部裝置不需要刪除碼也能刪除自己的圖片', async () => {
      const { json } = await upload(PNG, { name: 'second.png' });
      photo2 = json;
      const res = await fetch(`${base}/api/photo/${photo2.id}`, {
        method: 'DELETE',
        headers: { 'X-Device-Token': device },
      });
      assert.strictEqual(res.status, 200, await res.text());
    });

    await test('別的裝置不能刪除別人的圖片', async () => {
      const { json } = await upload(PNG, { name: 'third.png' });
      const res = await fetch(`${base}/api/photo/${json.id}`, {
        method: 'DELETE',
        headers: { 'X-Device-Token': 'c'.repeat(48) },
      });
      assert.strictEqual(res.status, 403);
      // 清掉
      await fetch(`${base}/api/photo/${json.id}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Code': json.deleteCode },
      });
    });

    // ---------- 過期清理 ----------
    await test('過期圖片會被清掉（資料庫與磁碟）', async () => {
      const { json } = await upload(PNG, { name: 'expiring.png' });
      assert.strictEqual(json.ok, true);

      // 直接把到期時間改成過去，模擬已過期
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(dataDir, 'imgdrop.db'));
      db.prepare('UPDATE photos SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, json.id);
      db.close();

      const res = await fetch(`${base}/api/admin/cleanup`, {
        method: 'POST',
        headers: { 'X-Admin-Key': ADMIN_KEY },
      });
      const out = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(out));
      assert.ok(out.expiredRemoved >= 1, `應該清掉至少 1 張，實際 ${out.expiredRemoved}`);

      const gone = await fetch(`${base}${json.url}`);
      assert.strictEqual(gone.status, 404);
      const fileExists = await fsp
        .stat(path.join(dataDir, 'files', `${json.id}.png`))
        .then(() => true)
        .catch(() => false);
      assert.strictEqual(fileExists, false);
    });

    await test('管理 API 需要正確金鑰', async () => {
      const bad = await fetch(`${base}/api/stats`, { headers: { 'X-Admin-Key': 'nope' } });
      assert.strictEqual(bad.status, 403);
      const good = await fetch(`${base}/api/stats`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
      const json = await good.json();
      assert.strictEqual(good.status, 200);
      assert.strictEqual(json.ok, true);
      assert.ok(json.photos >= 0);
      assert.ok(json.diskFreeBytes === null || json.diskFreeBytes > 0);
    });

    await test('沒有這個 API 時回 404 JSON', async () => {
      const res = await fetch(`${base}/api/nope`);
      assert.strictEqual(res.status, 404);
      const json = await res.json();
      assert.strictEqual(json.ok, false);
    });

    await test('未知路由不會 crash 伺服器', async () => {
      await fetch(`${base}/whatever/deep/path`).catch(() => {});
      const res = await fetch(`${base}/api/health`);
      assert.strictEqual(res.status, 200);
    });

    await test('資料庫內沒有留下明文刪除碼', async () => {
      const { json } = await upload(PNG, { name: 'hash-check.png' });
      assert.strictEqual(json.ok, true);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(dataDir, 'imgdrop.db'));
      const rows = db.prepare('SELECT delete_hash FROM photos').all();
      db.close();
      assert.ok(rows.length > 0, '應該還有圖片紀錄');
      for (const row of rows) {
        assert.match(row.delete_hash, /^[a-f0-9]{64}$/, '刪除碼應該只存 sha256');
        assert.notStrictEqual(row.delete_hash, json.deleteCode);
      }
      // 收尾
      await fetch(`${base}/api/photo/${json.id}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Code': json.deleteCode },
      });
    });

    await test('伺服器日誌沒有出現明文刪除碼', async () => {
      assert.ok(!serverLog.includes(photo.deleteCode), '日誌不應出現刪除碼');
    });

    // ---------- 啟動健壯性 ----------
    // 回歸測試：曾經有個 bug —— data 目錄不存在時，secret.key 會在 mkdir 之前
    // 就嘗試寫入而 ENOENT 崩潰。原本的測試用 mkdtemp 預先建好目錄，所以沒抓到。
    await test('DATA_DIR 不存在（含多層父目錄）時仍能啟動並自動建立', async () => {
      const nested = path.join(dataDir, 'a', 'b', 'c', 'not-yet-created');
      const p2 = freePort();
      const child2 = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.js')],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            PORT: String(p2),
            HOST: '127.0.0.1',
            DATA_DIR: nested,
            UPLOAD_CODE,
            ADMIN_KEY,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let log2 = '';
      let exited = false;
      child2.stdout.on('data', (d) => (log2 += d.toString()));
      child2.stderr.on('data', (d) => (log2 += d.toString()));
      child2.on('exit', () => (exited = true));

      try {
        const deadline = Date.now() + 12000;
        let ready = false;
        while (Date.now() < deadline && !ready) {
          if (exited) break;
          try {
            const r = await fetch(`http://127.0.0.1:${p2}/api/health`);
            if (r.ok) ready = true;
          } catch {
            /* 還沒起來 */
          }
          if (!ready) await new Promise((r) => setTimeout(r, 150));
        }
        assert.ok(!exited, `伺服器不該崩潰。日誌：\n${log2}`);
        assert.ok(ready, `伺服器沒有在時限內啟動。日誌：\n${log2}`);

        for (const sub of ['secret.key', 'imgdrop.db', 'files', 'thumbs', 'tmp']) {
          const exists = await fsp
            .stat(path.join(nested, sub))
            .then(() => true)
            .catch(() => false);
          assert.ok(exists, `應該自動建立 ${sub}`);
        }

        // 而且真的能上傳
        const up = await fetch(`http://127.0.0.1:${p2}/api/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'image/png',
            'X-Upload-Code': UPLOAD_CODE,
            'X-Device-Token': device,
          },
          body: PNG,
        });
        assert.strictEqual(up.status, 201, await up.text());
      } finally {
        child2.kill('SIGKILL');
      }
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (child.exitCode === null) child.kill('SIGKILL');
    if (process.env.KEEP_TEST_DATA !== '1') {
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`\n（保留測試資料：${dataDir}）`);
    }
  }

  console.log(`\n通過 ${passed} 項，失敗 ${failures.length} 項`);
  if (failures.length) {
    console.log('\n失敗詳情：');
    for (const f of failures) console.log(`\n▸ ${f.name}\n${f.err.stack}`);
    process.exitCode = 1;
  }
  if (process.env.SHOW_SERVER_LOG === '1') console.log(`\n--- 伺服器日誌 ---\n${serverLog}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
