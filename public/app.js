'use strict';

/**
 * imgdrop 前端：手機優先的圖片上傳介面
 *  - 上傳碼（存 localStorage，可選記住）
 *  - 上傳前用 canvas 壓縮 + 產生縮圖（省 3 Mbps 頻寬）
 *  - 顯示刪除碼、複製連結、刪除自己的圖片
 */

// ===================== 小工具 =====================
const $ = (sel) => document.querySelector(sel);

const LS = {
  device: 'imgdrop.device',
  code: 'imgdrop.code',
  expire: 'imgdrop.expire',
  compress: 'imgdrop.compress',
  remember: 'imgdrop.remember',
};

function lsGet(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 無痕模式可能失敗，忽略 */
  }
}

function lsDel(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

function deviceToken() {
  let t = lsGet(LS.device);
  if (!/^[a-f0-9]{16,64}$/.test(t)) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    lsSet(LS.device, t);
  }
  return t;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
}

function humanTime(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return '即將刪除';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min} 分鐘後刪除`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} 小時後刪除`;
  return `${Math.round(hr / 24)} 天後刪除`;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, kind === 'err' ? 4200 : 2600);
}

async function copyText(text, okMessage = '已複製') {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(okMessage, 'ok');
      return true;
    }
    throw new Error('no clipboard');
  } catch {
    // HTTP（非安全來源）時退回舊方法
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? okMessage : '請長按選取複製', ok ? 'ok' : '');
      return ok;
    } catch {
      toast('請長按選取複製');
      return false;
    }
  }
}

function formatCode(code) {
  if (!code) return '';
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ===================== 全域狀態 =====================
const state = {
  config: null,
  queue: [], // { key, file, status, progress, result, error }
  mineBefore: null,
  allBefore: null,
  lb: { id: null, photo: null },
};

const MAX_DIM = 2000;
const THUMB_DIM = 480;
const QUALITY = 0.82;
const THUMB_QUALITY = 0.72;
const SKIP_COMPRESS_UNDER = 600 * 1024; // 小於此大小就不重壓

// ===================== API =====================
async function api(path, options = {}) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const msg = (body && body.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

function uploadWithProgress(blob, meta, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.responseType = 'text';
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Code', meta.code);
    xhr.setRequestHeader('X-Device-Token', meta.device);
    xhr.setRequestHeader('X-Expire-Hours', String(meta.expireHours));
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(meta.name || 'photo'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* 忽略 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) resolve(body);
      else reject(new Error((body && body.error) || `上傳失敗（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('網絡連線中斷，請檢查網路後再試'));
    xhr.onabort = () => reject(new Error('已取消上傳'));
    xhr.send(blob);
  });
}

async function uploadThumb(blob, id, device) {
  const res = await fetch(`/api/photo/${id}/thumb`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/jpeg', 'X-Device-Token': device },
    body: blob,
  });
  if (!res.ok) throw new Error('縮圖上傳失敗');
  return res.json();
}

// ===================== 圖片壓縮 =====================
function loadBitmapFromImg(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function loadBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* 換下一種方式 */
    }
    try {
      return await createImageBitmap(blob);
    } catch {
      /* 換下一種方式 */
    }
  }
  return loadBitmapFromImg(blob);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function resizeTo(bitmap, maxDim) {
  const w0 = bitmap.width || bitmap.naturalWidth;
  const h0 = bitmap.height || bitmap.naturalHeight;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // 透明背景先填白，避免轉 JPEG 變黑
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

function renameExt(name, mime) {
  const base = (name || 'photo').replace(/\.[^./\\]+$/, '');
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  return base + ext;
}

const HEIC_RE = /\.(heic|heif)$/i;

/** 準備要上傳的 blob：可選壓縮，並順便產生縮圖。 */
async function prepareUpload(file, compress) {
  const raw = { blob: file, mime: file.type || 'application/octet-stream', name: file.name || 'photo' };

  if (!compress) {
    if (HEIC_RE.test(file.name) || /heic|heif/i.test(file.type)) {
      throw new Error('HEIC 格式無法直接上傳，請開啟「上傳前先壓縮」');
    }
    return { main: raw, thumb: null, note: '' };
  }
  if (/gif/i.test(file.type)) return { main: raw, thumb: null, note: 'GIF 不壓縮' };

  const bitmap = await loadBitmap(file);
  if (!bitmap) {
    if (HEIC_RE.test(file.name) || /heic|heif/i.test(file.type)) {
      throw new Error('這部手機無法轉換 HEIC，請改用 JPEG 再上傳');
    }
    return { main: raw, thumb: null, note: '無法解碼，原圖上傳' };
  }

  const w0 = bitmap.width || bitmap.naturalWidth;
  const h0 = bitmap.height || bitmap.naturalHeight;
  const bigEnough = Math.max(w0, h0) > MAX_DIM;

  let mainBlob = file;
  let mainMime = file.type || 'image/jpeg';
  let note = '原圖';

  if (bigEnough || file.size > SKIP_COMPRESS_UNDER) {
    const preserveAlpha = /png|webp/i.test(file.type);
    const outType = preserveAlpha ? 'image/webp' : 'image/jpeg';
    const canvas = resizeTo(bitmap, MAX_DIM);
    let out = canvas ? await canvasToBlob(canvas, outType, QUALITY) : null;
    if (!out && outType === 'image/webp') {
      const c2 = resizeTo(bitmap, MAX_DIM);
      out = c2 ? await canvasToBlob(c2, 'image/jpeg', QUALITY) : null;
    }
    if (out && out.size > 0 && out.size < file.size) {
      mainBlob = out;
      mainMime = out.type || outType;
      note = `已壓縮 ${Math.round((1 - out.size / file.size) * 100)}%`;
    }
  }

  // 縮圖（相簿用）
  let thumb = null;
  const thumbCanvas = resizeTo(bitmap, THUMB_DIM);
  if (thumbCanvas) {
    const t = await canvasToBlob(thumbCanvas, 'image/jpeg', THUMB_QUALITY);
    if (t && t.size > 0 && t.size < mainBlob.size) thumb = t;
  }
  if (typeof bitmap.close === 'function') bitmap.close();

  return {
    main: { blob: mainBlob, mime: mainMime, name: renameExt(file.name, mainMime) },
    thumb,
    note,
  };
}

// ===================== 分頁切換 =====================
function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('is-active', panel.id === `panel-${name}`);
  }
  try {
    history.replaceState(null, '', `#${name}`);
  } catch {
    /* 忽略 */
  }
  if (name === 'mine') loadMine(true);
  if (name === 'all') loadAll(true);
  window.scrollTo({ top: 0 });
}

// ===================== 上傳佇列 =====================
function queueItemEl(item) {
  const li = el('li', 'item');
  li.dataset.key = item.key;

  const top = el('div', 'item-top');
  const thumb = el('img', 'item-thumb');
  thumb.alt = '';
  const info = el('div', 'item-info');
  const name = el('div', 'item-name', item.file.name || 'photo');
  const sub = el('div', 'item-sub');
  const status = el('div', 'item-state');
  info.append(name, sub);
  top.append(thumb, info, status);

  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);

  const codeBox = el('div', 'code-box');
  codeBox.hidden = true;

  const actions = el('div', 'item-actions');
  actions.hidden = true;

  const errorEl = el('div', 'item-error');
  errorEl.hidden = true;

  li.append(top, bar, errorEl, codeBox, actions);

  item.refs = { li, thumb, name, sub, status, bar, fill, codeBox, actions, errorEl };

  // 本機預覽縮圖
  if (/^image\//.test(item.file.type) && !HEIC_RE.test(item.file.name)) {
    const url = URL.createObjectURL(item.file);
    thumb.src = url;
    thumb.onload = () => URL.revokeObjectURL(url);
    thumb.onerror = () => URL.revokeObjectURL(url);
  }

  renderQueueItem(item);
  return li;
}

function renderQueueItem(item) {
  const r = item.refs;
  if (!r) return;
  const { status, progress, result, error, file } = item;

  r.status.className = 'item-state';
  if (status === 'waiting') {
    r.status.textContent = '等待中';
    r.status.classList.add('state-pending');
    r.sub.textContent = humanSize(file.size);
    r.fill.style.width = '0%';
  } else if (status === 'uploading') {
    r.status.textContent = `${Math.round(progress * 100)}%`;
    r.status.classList.add('state-uploading');
    r.sub.textContent = `${humanSize(file.size)} · 上傳中`;
    r.fill.style.width = `${Math.round(progress * 100)}%`;
  } else if (status === 'done') {
    r.status.textContent = '✓ 完成';
    r.status.classList.add('state-done');
    r.sub.textContent = `${humanSize(result.size)} · ${fmtDateTime(result.expiresAt)} 到期`;
    r.fill.style.width = '100%';
  } else if (status === 'error') {
    r.status.textContent = '✕ 失敗';
    r.status.classList.add('state-error');
    r.fill.style.width = '0%';
  }

  r.errorEl.hidden = status !== 'error';
  if (status === 'error') r.errorEl.textContent = error || '上傳失敗';

  r.actions.hidden = status !== 'done';
  r.codeBox.hidden = status !== 'done';
  if (status === 'done' && !r.actions.dataset.built) {
    r.actions.dataset.built = '1';
    buildResultUI(item);
  }
}

function buildResultUI(item) {
  const r = item.refs;
  const res = item.result;
  const origin = location.origin;
  const pageUrl = `${origin}/i/${res.id}`;

  r.codeBox.replaceChildren();
  r.codeBox.append(el('span', 'code-label', '刪除碼（請立即保存，遺失無法找回）'));
  const code = el('span', 'code-value', formatCode(res.deleteCode));
  const copyCode = el('button', 'secondary', '複製');
  copyCode.type = 'button';
  copyCode.addEventListener('click', () =>
    copyText(res.deleteCode, '刪除碼已複製')
  );
  r.codeBox.append(code, copyCode);

  r.actions.replaceChildren();

  const viewBtn = el('button', 'secondary', '檢視');
  viewBtn.type = 'button';
  viewBtn.addEventListener('click', () => openLightbox({ id: res.id, ...res, isMine: true }));

  const copyLink = el('button', 'secondary', '複製連結');
  copyLink.type = 'button';
  copyLink.addEventListener('click', () => copyText(pageUrl, '圖片連結已複製'));

  const shareBtn = el('button', 'secondary', '分享');
  shareBtn.type = 'button';
  shareBtn.hidden = typeof navigator.share !== 'function';
  shareBtn.addEventListener('click', async () => {
    try {
      await navigator.share({ title: '圖片', url: pageUrl });
    } catch {
      /* 使用者取消 */
    }
  });

  const delBtn = el('button', 'danger', '刪除');
  delBtn.type = 'button';
  delBtn.addEventListener('click', () => requestDelete({ id: res.id, isMine: true }, item));

  r.actions.append(viewBtn, copyLink, shareBtn, delBtn);
}

function enqueue(files) {
  const code = $('#uploadCode').value.trim();
  if (!code) {
    toast('請先填寫上傳碼', 'err');
    $('#uploadCode').focus();
    return;
  }
  const images = Array.from(files).filter((f) => f.size > 0);
  if (!images.length) return;
  if (!images.some((f) => /^image\//.test(f.type) || HEIC_RE.test(f.name))) {
    toast('請選擇圖片檔案', 'err');
    return;
  }

  const maxBytes = state.config ? state.config.maxFileBytes : 20 * 1024 * 1024;
  for (const file of images) {
    const item = {
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      status: 'waiting',
      progress: 0,
      result: null,
      error: null,
    };
    if (file.size > maxBytes) {
      item.status = 'error';
      item.error = `檔案 ${humanSize(file.size)} 超過上限 ${humanSize(maxBytes)}`;
    }
    state.queue.push(item);
    $('#queue').append(queueItemEl(item));
  }
  $('#queueHead').hidden = false;
  pump();
}

const pumpState = { active: 0 };
const MAX_PARALLEL = 2;

function pump() {
  while (pumpState.active < MAX_PARALLEL) {
    const next = state.queue.find((i) => i.status === 'waiting');
    if (!next) break;
    runUpload(next);
  }
}

async function runUpload(item) {
  pumpState.active += 1;
  item.status = 'uploading';
  item.progress = 0;
  renderQueueItem(item);

  const device = deviceToken();
  const code = $('#uploadCode').value.trim();
  const expireHours = Number($('#expire').value) || 24;
  const compress = $('#compress').checked;

  try {
    const prepared = await prepareUpload(item.file, compress);
    if (prepared.note && prepared.note.startsWith('已壓縮')) {
      item.refs.sub.textContent = `${humanSize(item.file.size)} → ${humanSize(prepared.main.blob.size)} · ${prepared.note}`;
    }

    const res = await uploadWithProgress(
      prepared.main.blob,
      { code, device, expireHours, name: prepared.main.name },
      (p) => {
        item.progress = p;
        renderQueueItem(item);
      }
    );

    item.result = res;
    item.status = 'done';
    renderQueueItem(item);
    toast(`上傳完成：${res.deleteCode}`, 'ok');
    refreshHealth();

    // 背景補縮圖，失敗不影響結果
    if (prepared.thumb) {
      uploadThumb(prepared.thumb, res.id, device).catch(() => {});
    }
  } catch (err) {
    item.status = 'error';
    item.error = err.message || '上傳失敗';
    renderQueueItem(item);
    if (err.status === 401 || err.status === 403) toast('上傳碼不正確', 'err');
    else if (err.status === 507) toast(err.message, 'err');
    else toast(`${item.file.name}：${item.error}`, 'err');
  } finally {
    pumpState.active -= 1;
    pump();
  }
}

// ===================== 相簿 =====================
function photoTile(photo) {
  const tile = el('div', 'tile');
  const img = el('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = photo.name || '圖片';
  img.src = photo.thumbUrl;
  img.addEventListener('click', () => openLightbox(photo));
  img.addEventListener('error', () => {
    tile.remove();
  });

  const bar = el('div', 'tile-bar');
  bar.append(el('span', '', humanTime(photo.expiresAt)));
  const actions = el('div', 'tile-actions');

  const open = el('button', '', '⤢');
  open.type = 'button';
  open.title = '檢視';
  open.addEventListener('click', (e) => {
    e.stopPropagation();
    openLightbox(photo);
  });

  const del = el('button', '', '🗑');
  del.type = 'button';
  del.title = '刪除';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    requestDelete(photo);
  });

  actions.append(open, del);
  bar.append(actions);
  tile.append(img, bar);
  return tile;
}

async function loadPhotos(scope, reset) {
  const grid = scope === 'mine' ? $('#mineGrid') : $('#allGrid');
  const empty = scope === 'mine' ? $('#mineEmpty') : $('#allEmpty');
  const moreBtn = scope === 'mine' ? $('#mineMore') : $('#allMore');

  if (reset) {
    grid.replaceChildren();
    if (scope === 'mine') state.mineBefore = null;
    else state.allBefore = null;
  }
  const before = scope === 'mine' ? state.mineBefore : state.allBefore;

  const params = new URLSearchParams({ scope, limit: '60' });
  if (before) params.set('before', String(before));

  try {
    const data = await api(`/api/photos?${params}`, {
      headers: { 'X-Device-Token': deviceToken() },
    });
    const frag = document.createDocumentFragment();
    for (const photo of data.items) frag.append(photoTile(photo));
    grid.append(frag);

    if (scope === 'mine') state.mineBefore = data.nextBefore;
    else state.allBefore = data.nextBefore;

    moreBtn.hidden = !data.nextBefore;
    if (!grid.children.length) {
      empty.hidden = false;
      empty.textContent = scope === 'mine' ? '還沒有上傳紀錄。' : '暫時沒有照片。';
    } else {
      empty.hidden = true;
    }
  } catch (err) {
    empty.hidden = false;
    empty.textContent = `載入失敗：${err.message}`;
    moreBtn.hidden = true;
  }
}

const loadMine = (reset) => loadPhotos('mine', reset);
const loadAll = (reset) => loadPhotos('all', reset);

// ===================== 大圖 =====================
function openLightbox(photo) {
  state.lb = { id: photo.id, photo };
  const lb = $('#lightbox');
  const img = $('#lbImg');
  const spinner = $('#lbSpinner');

  img.style.display = 'none';
  img.removeAttribute('src');
  spinner.hidden = false;
  lb.hidden = false;
  document.body.style.overflow = 'hidden';

  $('#lbMeta').textContent = `${photo.name || photo.id} · ${humanSize(photo.size)} · ${humanTime(photo.expiresAt)}`;
  $('#lbDownload').href = photo.downloadUrl || `/d/${photo.id}`;
  $('#lbDelete').hidden = false;

  img.onload = () => {
    spinner.hidden = true;
    img.style.display = '';
  };
  img.onerror = () => {
    spinner.hidden = true;
    $('#lbMeta').textContent = '載入失敗，圖片可能已被刪除';
  };
  img.src = photo.url || `/i/${photo.id}`;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lbImg').removeAttribute('src');
  document.body.style.overflow = '';
}

// ===================== 刪除 =====================
let pendingDelete = null;

function requestDelete(photo, queueItem) {
  pendingDelete = { photo, queueItem };
  const dlg = $('#deleteDialog');
  $('#dlgErr').hidden = true;
  $('#dlgCode').value = '';
  $('#dlgSub').textContent = photo.isMine
    ? '這是你在這部裝置上傳的圖片，可直接確認刪除；如已遺失刪除碼也可輸入。'
    : '輸入該圖片的刪除碼以確認刪除。';
  dlg.showModal();
  setTimeout(() => $('#dlgCode').focus(), 60);
}

async function confirmDelete() {
  if (!pendingDelete) return;
  const { photo, queueItem } = pendingDelete;
  const code = $('#dlgCode').value.trim();
  const btn = $('#dlgConfirm');
  btn.disabled = true;
  btn.textContent = '刪除中…';

  try {
    const headers = { 'X-Device-Token': deviceToken() };
    if (code) headers['X-Delete-Code'] = code;
    await api(`/api/photo/${photo.id}`, { method: 'DELETE', headers });

    $('#deleteDialog').close();
    pendingDelete = null;
    toast('已刪除', 'ok');
    if (state.lb.id === photo.id) closeLightbox();
    if (queueItem) {
      queueItem.status = 'error';
      queueItem.error = '已刪除';
      queueItem.refs.li.style.opacity = '.45';
      queueItem.refs.actions.hidden = true;
      queueItem.refs.codeBox.hidden = true;
      queueItem.refs.status.textContent = '已刪除';
      queueItem.refs.status.className = 'item-state state-pending';
      queueItem.refs.errorEl.hidden = true;
    }
    if ($('#panel-mine').classList.contains('is-active')) loadMine(true);
    if (state.config && state.config.publicGallery && $('#panel-all').classList.contains('is-active')) {
      loadAll(true);
    }
    refreshHealth();
  } catch (err) {
    const errEl = $('#dlgErr');
    errEl.hidden = false;
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '確認刪除';
  }
}

// ===================== 健康狀態 =====================
async function refreshHealth() {
  try {
    const data = await api('/api/health');
    $('#health').textContent = `${data.photos} 張 · ${humanSize(data.bytes)}`;
  } catch {
    $('#health').textContent = '';
  }
}

// ===================== 初始化 =====================
async function init() {
  deviceToken();

  let config;
  try {
    config = await api('/api/config');
  } catch {
    config = { allowedExpireHours: [1, 6, 24, 72, 168], defaultExpireHours: 24, publicGallery: true };
  }
  state.config = config;

  document.title = config.siteName || '圖片上傳';
  $('#siteName').textContent = config.siteName || '圖片上傳';

  // 保存時間選項
  const expireSel = $('#expire');
  const hours = config.allowedExpireHours && config.allowedExpireHours.length ? config.allowedExpireHours : [1, 6, 24, 72, 168];
  for (const h of hours) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = h < 24 ? `${h} 小時後自動刪除` : `${h / 24} 天後自動刪除`;
    expireSel.append(opt);
  }
  const savedExpire = lsGet(LS.expire);
  expireSel.value = hours.includes(Number(savedExpire)) ? savedExpire : String(config.defaultExpireHours || 24);
  if (!expireSel.value) expireSel.value = String(hours[0]);

  // 記住上傳碼
  const remember = lsGet(LS.remember, '1') !== '0';
  $('#remember').checked = remember;
  if (remember) $('#uploadCode').value = lsGet(LS.code);

  if (lsGet(LS.compress, '1') === '0') $('#compress').checked = false;

  $('#limitHint').textContent = `單張上限 ${humanSize(config.maxFileBytes || 20971520)} · 到期自動刪除`;

  // 共用相簿分頁
  $('.tab[data-tab="all"]').hidden = !config.publicGallery;

  // ---- 事件 ----
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }

  $('#pickBtn').addEventListener('click', () => $('#fileInput').click());
  $('#cameraBtn').addEventListener('click', () => $('#cameraInput').click());
  $('#fileInput').addEventListener('change', (e) => {
    enqueue(e.target.files);
    e.target.value = '';
  });
  $('#cameraInput').addEventListener('change', (e) => {
    enqueue(e.target.files);
    e.target.value = '';
  });

  $('#toggleCode').addEventListener('click', () => {
    const input = $('#uploadCode');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggleCode').textContent = show ? '隱藏' : '顯示';
  });

  $('#uploadCode').addEventListener('change', () => {
    if ($('#remember').checked) lsSet(LS.code, $('#uploadCode').value.trim());
  });
  $('#remember').addEventListener('change', () => {
    lsSet(LS.remember, $('#remember').checked ? '1' : '0');
    if ($('#remember').checked) lsSet(LS.code, $('#uploadCode').value.trim());
    else lsDel(LS.code);
  });
  $('#expire').addEventListener('change', () => lsSet(LS.expire, $('#expire').value));
  $('#compress').addEventListener('change', () => lsSet(LS.compress, $('#compress').checked ? '1' : '0'));

  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    enqueue(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) enqueue(files);
  });

  $('#clearDone').addEventListener('click', () => {
    state.queue = state.queue.filter((i) => i.status !== 'done');
    for (const li of Array.from($('#queue').children)) {
      const item = state.queue.find((i) => i.key === li.dataset.key);
      if (!item) li.remove();
    }
    $('#queueHead').hidden = state.queue.length === 0;
  });

  $('#reloadMine').addEventListener('click', () => loadMine(true));
  $('#reloadAll').addEventListener('click', () => loadAll(true));
  $('#mineMore').addEventListener('click', () => loadMine(false));
  $('#allMore').addEventListener('click', () => loadAll(false));

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbDelete').addEventListener('click', () => {
    if (state.lb.photo) requestDelete(state.lb.photo);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#lightbox').hidden) closeLightbox();
  });

  $('#dlgCancel').addEventListener('click', () => {
    pendingDelete = null;
    $('#deleteDialog').close();
  });
  $('#dlgConfirm').addEventListener('click', confirmDelete);
  $('#dlgCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmDelete();
    }
  });

  refreshHealth();
  setInterval(refreshHealth, 60000);

  // 支援直接用 #all / #mine 開啟指定分頁
  const initial = (location.hash || '').replace(/^#/, '');
  if (initial === 'all' && !config.publicGallery) showTab('upload');
  else if (['upload', 'mine', 'all'].includes(initial)) showTab(initial);
}

document.addEventListener('DOMContentLoaded', init);
