(function () {
  "use strict";

  const PRODUCTS_SEED = JSON.parse(document.getElementById('products-seed').textContent);
  const DEPTS = JSON.parse(document.getElementById('depts-seed').textContent);
  const LOGO_SRC = JSON.parse(document.getElementById('logo-data').textContent);

  // ====================================================================
  // API layer — talks to a Google Apps Script Web App backed by a
  // Google Sheet (see apps-script/Code.gs). Fill in API_URL below with
  // your deployed Web App URL (Deploy > New deployment > Web app >
  // Execute as: Me > Who has access: Anyone). See README.md.
  // ====================================================================
  const API_URL = (window.NIS_CONFIG && window.NIS_CONFIG.API_URL) || 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';

  async function apiGetJson_(params) {
    const qs = Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    const res = await fetch(API_URL + '?' + qs, { method: 'GET' });
    if (!res.ok) throw new Error('API error ' + res.status);
    const j = await res.json();
    // The backend always answers with HTTP 200 even when the operation
    // itself failed (e.g. Apps Script exception) — the real result is in
    // the JSON body, so a silently-successful-looking fetch can still be
    // a failure. Surface it instead of pretending everything worked.
    if (j && j.error) throw new Error(j.error);
    return j;
  }
  async function apiPost_(payload) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
        body: JSON.stringify(payload)
      });
    } catch (networkErr) {
      // fetch() itself threw — this is a network/CORS-level failure, not
      // something the backend responded to. Distinguish it clearly, since
      // it points at the Apps Script deployment/URL, not the app logic.
      throw new Error('เชื่อมต่อ API ไม่สำเร็จ (เครือข่าย/CORS) — เช็คว่า API_URL ถูกต้องและ deployment ตั้งค่า "Anyone" จริง: ' + networkErr.message);
    }
    if (!res.ok) throw new Error('API error ' + res.status);
    const j = await res.json();
    if (j && j.error) throw new Error(j.error);
    return j;
  }
  async function apiList(collection) {
    const j = await apiGetJson_({ action: 'list', collection });
    return (j && j.rows) || [];
  }
  async function apiSet(collection, id, data) { return apiPost_({ action: 'set', collection, id, data }); }
  async function apiUpdate(collection, id, data) { return apiPost_({ action: 'update', collection, id, data }); }
  async function apiDelete(collection, id) { return apiPost_({ action: 'delete', collection, id }); }
  async function apiAdd(collection, data) {
    const res = await apiPost_({ action: 'add', collection, data });
    return res.id;
  }
  async function apiExportAll() { return apiGetJson_({ action: 'exportAll' }); }

  let apiAvailable = false;
  let dbAvailable = false; // kept as an alias throughout the render code below
  let products = PRODUCTS_SEED.map(p => ({ ...p }));
  let history = [];
  let authUsers = [];
  let stockCounts = [];
  let pollTimer = null;

  let session = null;
  try {
    const raw = localStorage.getItem('req_app_session');
    if (raw) session = JSON.parse(raw);
  } catch (e) { session = null; }

  let state = {
    tab: 'transact',
    mode: 'withdraw',
    deptCode: '',
    category: 'ทั้งหมด',
    search: '',
    cart: {},
    cartOpen: false,
    requester: '',
    histFilter: 'all',
    histSearch: '',
    histDept: '',
    reportFrom: '',
    reportTo: '',
    reportDeptFilter: '',
    expandedDept: null,
    whSearch: '',
    whEditCode: null,
    whConfirmDelete: null,
    fulfillConfirmCancel: null,
    stockCountCategory: 'ทั้งหมด',
    stockCountSearch: '',
    stockCountNotes: '',
    stockCountExpanded: null,
    whAdding: false,
    userConfirmDelete: null,
    loginError: ''
  };

  try {
    const savedDept = localStorage.getItem('req_app_dept');
    if (savedDept) state.deptCode = savedDept;
  } catch (e) {}

  // ---------- utils ----------
  function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }
  function fmtMoney(n) { return Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString('th-TH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function categories() {
    const set = new Set(products.map(p => p.category));
    return ['ทั้งหมด', ...Array.from(set).sort()];
  }
  function deptName(code) {
    const d = DEPTS.find(d => d.code === code);
    return d ? d.name : code;
  }
  function showToast(msg, isErr) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.className = 'toast'; }, 2600);
  }
  async function hashPassword(pw) {
    const enc = new TextEncoder().encode(pw);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function csvEscape(v) {
    v = v === undefined || v === null ? '' : String(v);
    if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function toCSV(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n'); }
  async function downloadCSV(filename, rows) {
    try {
      const csv = '\uFEFF' + toCSV(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { console.error(e); showToast('ไม่สามารถดาวน์โหลดได้', true); }
  }

  async function downloadJSON(filename, obj) {
    try {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { console.error(e); showToast('ไม่สามารถดาวน์โหลดได้', true); }
  }

  // sheets: { "Sheet Name": [[header...], [row...], ...], ... }
  function downloadXLSX(filename, sheets) {
    if (typeof XLSX === 'undefined') { showToast('ไม่พบไลบรารี Excel — ตรวจสอบว่าไฟล์ index.html โหลด xlsx.full.min.js สำเร็จ (ต้องต่ออินเทอร์เน็ต)', true); return; }
    try {
      const wb = XLSX.utils.book_new();
      Object.keys(sheets).forEach(name => {
        const ws = XLSX.utils.aoa_to_sheet(sheets[name]);
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); // Excel sheet name limit = 31 chars
      });
      XLSX.writeFile(wb, filename);
    } catch (e) { console.error(e); showToast('ไม่สามารถสร้างไฟล์ Excel ได้', true); }
  }

  async function exportDatabaseExcel() {
    if (!apiAvailable) { showToast('ยังไม่ได้เชื่อมต่อฐานข้อมูล', true); return; }
    try {
      showToast('กำลังเตรียมไฟล์ Excel...');
      const j = await apiExportAll();
      const data = j.data || {};
      const sheets = {};

      const prodRows = [['รหัสสินค้า', 'ชื่อสินค้า', 'หมวดหมู่', 'หน่วย', 'ราคา/หน่วย', 'คงเหลือ']];
      (data.products || []).forEach(p => prodRows.push([p.id, p.name, p.category, p.unit, p.price, p.stock]));
      sheets['สินค้าคงคลัง'] = prodRows;

      const histRows = [['วันที่', 'ประเภท', 'รหัสแผนก', 'แผนก', 'ผู้เบิก', 'รหัสพนักงาน', 'รายการสินค้า', 'จำนวน', 'มูลค่า', 'ยอดรวมทั้งใบ']];
      (data.requisitions || []).forEach(h => {
        (h.items || []).forEach(it => {
          histRows.push([fmtDate(h.ts), h.type, h.deptCode, h.deptName, h.requester, h.employeeId, it.name, it.qty, it.subtotal, h.total]);
        });
      });
      sheets['ประวัติการทำรายการ'] = histRows;

      const userRows = [['รหัสพนักงาน (Username)', 'ชื่อ-นามสกุล', 'สิทธิ์']];
      (data.auth_users || []).forEach(u => userRows.push([u.id, u.displayName, u.role === 'admin' ? 'แอดมิน' : 'ผู้ใช้งานทั่วไป']));
      sheets['ผู้ใช้งาน'] = userRows;

      const scRows = [['วันที่เช็ค', 'ผู้เช็ค', 'หมายเหตุ', 'รหัสสินค้า', 'ชื่อสินค้า', 'ยอดในระบบ', 'ยอดนับจริง', 'ผลต่าง', 'มูลค่าผลต่าง']];
      (data.stock_counts || []).forEach(sc => {
        (sc.items || []).filter(it => it.diff !== 0).forEach(it => {
          scRows.push([fmtDate(sc.date), sc.checkedByName, sc.notes, it.code, it.name, it.systemStock, it.countedStock, it.diff, it.diffValue]);
        });
      });
      sheets['ประวัติเช็คสต๊อก'] = scRows;

      downloadXLSX('nis-database-' + todayStr() + '.xlsx', sheets);
    } catch (e) { console.error(e); showToast('ส่งออกไม่สำเร็จ', true); }
  }

  async function exportDatabaseJSON() {
    if (!apiAvailable) { showToast('ยังไม่ได้เชื่อมต่อฐานข้อมูล', true); return; }
    try {
      showToast('กำลังเตรียมไฟล์ JSON...');
      const j = await apiExportAll();
      downloadJSON('nis-database-' + todayStr() + '.json', j.data || {});
    } catch (e) { console.error(e); showToast('ส่งออกไม่สำเร็จ', true); }
  }
  // A withdrawal only actually leaves the shelf once released at the
  // fulfillment counter. Older records (created before this status field
  // existed) deducted stock immediately, so treat a missing status as
  // already fulfilled for backward compatibility.
  function isFulfilled_(h) { return (h.status || 'fulfilled') === 'fulfilled'; }

  function inRange(iso) {
    if (!state.reportFrom && !state.reportTo) return true;
    const t = new Date(iso).getTime();
    if (state.reportFrom) { const f = new Date(state.reportFrom + 'T00:00:00').getTime(); if (t < f) return false; }
    if (state.reportTo) { const to = new Date(state.reportTo + 'T23:59:59').getTime(); if (t > to) return false; }
    return true;
  }

  // ---------- DB init (Google Apps Script + Google Sheet backend) ----------
  async function seedIfNeeded_() {
    try {
      const existingProducts = await apiList('products');
      if (!existingProducts.length) {
        for (const p of PRODUCTS_SEED) await apiSet('products', p.code, p);
      }
    } catch (e) { /* seeding is best-effort */ }
    try {
      const existingUsers = await apiList('auth_users');
      if (!existingUsers.length) {
        const adminHash = await hashPassword('admin123');
        const staffHash = await hashPassword('staff123');
        await apiSet('auth_users', 'admin', { passwordHash: adminHash, role: 'admin', displayName: 'ผู้ดูแลระบบ' });
        await apiSet('auth_users', 'staff', { passwordHash: staffHash, role: 'user', displayName: 'เจ้าหน้าที่ทั่วไป' });
      }
    } catch (e) { /* seeding is best-effort */ }
  }

  async function loadProducts_() {
    const rows = await apiList('products');
    // Normalize: the backend's own row key comes back as `id` — the rest
    // of this app keys products by `code`, so make sure that's always set
    // (works whether the stored record already carried its own `code`
    // field or not).
    const list = rows.map(r => ({ ...r, code: r.code || r.id }));
    if (list.length) { list.sort((a, b) => a.name.localeCompare(b.name, 'th')); products = list; }
  }
  async function loadHistory_() {
    const list = await apiList('requisitions');
    list.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    history = list.slice(0, 2000);
  }
  async function loadAuthUsers_() {
    const rows = await apiList('auth_users');
    // Same normalization as products: this app keys accounts by `username`.
    authUsers = rows.map(r => ({ ...r, username: r.username || r.id }));
  }
  async function loadStockCounts_() {
    const rows = await apiList('stock_counts');
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    stockCounts = rows;
  }

  let consecutiveFailures_ = 0;
  // Google Apps Script Web Apps occasionally hiccup on a single request
  // (cold start, brief slowdown) — that's normal and not a real
  // disconnection. Only show "not connected" after several polls in a
  // row fail, so one flaky request doesn't flash a scary banner.
  const MAX_FAILURES_BEFORE_OFFLINE = 3;

  async function refreshAll_(rerender) {
    try {
      // stock_counts is deliberately NOT fetched here — it's an admin-only,
      // occasional-use page, so it's loaded on demand (see renderStockCount)
      // instead of on every 8-second poll, to keep routine traffic light.
      await Promise.all([loadProducts_(), loadHistory_(), loadAuthUsers_()]);
      apiAvailable = true; dbAvailable = true; consecutiveFailures_ = 0;
    } catch (e) {
      consecutiveFailures_++;
      if (consecutiveFailures_ >= MAX_FAILURES_BEFORE_OFFLINE) { apiAvailable = false; dbAvailable = false; }
      // else: keep the previous connected state — treat this as a blip, not a disconnect.
    }
    if (rerender !== false) render();
  }

  async function initDb() {
    if (!API_URL || API_URL.indexOf('PASTE_YOUR') === 0) {
      apiAvailable = false; dbAvailable = false; render(); return;
    }
    await refreshAll_(false);
    if (apiAvailable) await seedIfNeeded_();
    await refreshAll_();
    // Poll for changes made by other devices/tabs every 8 seconds.
    // Skipped while the user is actively typing so it never yanks focus mid-input.
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!apiAvailable) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      refreshAll_();
    }, 8000);
  }

  // ---------- Auth ----------
  const LOCAL_FALLBACK_USERS = {
    admin: { password: 'admin123', role: 'admin', displayName: 'ผู้ดูแลระบบ' },
    staff: { password: 'staff123', role: 'user', displayName: 'เจ้าหน้าที่ทั่วไป' }
  };

  async function doLogin(username, password) {
    username = (username || '').trim().toLowerCase();
    if (!username || !password) { state.loginError = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน'; render(); return; }

    if (apiAvailable) {
      try {
        if (!authUsers.length) { try { await loadAuthUsers_(); } catch (e2) {} }
        const data = authUsers.find(u => u.username === username);
        if (!data) { state.loginError = 'ไม่พบผู้ใช้งานนี้'; render(); return; }
        const hash = await hashPassword(password);
        if (hash !== data.passwordHash) { state.loginError = 'รหัสผ่านไม่ถูกต้อง'; render(); return; }
        session = { username, role: data.role, displayName: data.displayName || username };
      } catch (e) {
        state.loginError = 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง'; render(); return;
      }
    } else {
      const u = LOCAL_FALLBACK_USERS[username];
      if (!u || u.password !== password) { state.loginError = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'; render(); return; }
      session = { username, role: u.role, displayName: u.displayName };
    }

    try { localStorage.setItem('req_app_session', JSON.stringify(session)); } catch (e) {}
    state.loginError = '';
    state.tab = 'transact';
    showToast('เข้าสู่ระบบสำเร็จ');
    render();
  }

  function doLogout() {
    session = null;
    try { localStorage.removeItem('req_app_session'); } catch (e) {}
    state.tab = 'transact';
    render();
  }

  function isAdmin() { return session && session.role === 'admin'; }

  // ---------- Cart ----------
  function cartItemsArray() {
    return Object.keys(state.cart).map(code => {
      const p = products.find(pp => pp.code === code);
      return { code, qty: state.cart[code], product: p };
    }).filter(x => x.product && x.qty > 0);
  }
  function cartTotal() { return cartItemsArray().reduce((s, i) => s + i.qty * i.product.price, 0); }
  function cartCount() { return cartItemsArray().reduce((s, i) => s + i.qty, 0); }
  function setCartQty(code, qty) {
    if (qty <= 0) delete state.cart[code]; else state.cart[code] = qty;
    render();
  }

  async function submit() {
    const items = cartItemsArray();
    if (!items.length) return;
    if (state.mode === 'restock' && !isAdmin()) { showToast('เฉพาะแอดมินเท่านั้นที่เติมสต๊อกได้', true); return; }
    if (state.mode === 'withdraw' && !state.deptCode) { showToast('กรุณาเลือกแผนกก่อนบันทึกการเบิก', true); return; }
    if (state.mode === 'withdraw') {
      for (const it of items) {
        if (it.qty > it.product.stock) { showToast(`${it.product.name}: คงเหลือไม่พอ (เหลือ ${fmt(it.product.stock)})`, true); return; }
      }
    }

    const isWithdraw = state.mode === 'withdraw';
    const recItems = items.map(it => ({
      code: it.code, name: it.product.name, unit: it.product.unit, category: it.product.category,
      price: it.product.price, qty: it.qty, subtotal: Math.round(it.qty * it.product.price * 100) / 100
    }));
    const total = Math.round(recItems.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    // Withdrawals go in as "pending" — stock isn't deducted until staff
    // actually hands the items over (see the "สรุปรายการเบิก" tab). Restocks
    // still apply immediately since there's no separate hand-over step for them.
    const record = {
      ts: new Date().toISOString(),
      type: isWithdraw ? 'เบิกของ' : 'เติมสต๊อก',
      status: isWithdraw ? 'pending' : 'fulfilled',
      deptCode: isWithdraw ? state.deptCode : '',
      deptName: isWithdraw ? deptName(state.deptCode) : 'คลังกลาง',
      requester: session ? session.displayName : '',
      employeeId: session ? session.username : '',
      recordedBy: session ? session.username : '',
      items: recItems,
      total
    };

    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.disabled = true;
    try {
      if (apiAvailable) {
        if (!isWithdraw) {
          for (const it of items) {
            const newStock = Math.round((it.product.stock + it.qty) * 100) / 100;
            await apiUpdate('products', it.code, { stock: newStock });
          }
        }
        await apiAdd('requisitions', record);
        await refreshAll_(false);
      } else {
        if (!isWithdraw) {
          items.forEach(it => { it.product.stock = Math.round((it.product.stock + it.qty) * 100) / 100; });
        }
        history.unshift({ id: 'local-' + Date.now(), ...record });
      }
      state.cart = {};
      state.cartOpen = false;
      showToast(isWithdraw ? 'ส่งคำขอเบิกสำเร็จ — กรุณารอรับของที่คลัง' : 'บันทึกการเติมสต๊อกสำเร็จ');
    } catch (e) {
      console.error(e);
      showToast('เกิดข้อผิดพลาด — ' + (e && e.message ? e.message : 'ลองใหม่อีกครั้ง'), true);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      render();
    }
  }

  // ---------- Product admin CRUD ----------
  async function saveProductEdit(oldCode, data) {
    const payload = { name: data.name.trim(), category: data.category.trim(), unit: data.unit.trim(), price: parseFloat(data.price) || 0, stock: Math.max(0, parseFloat(data.stock) || 0) };
    const newCode = data.code.trim();
    try {
      if (apiAvailable) {
        if (newCode !== oldCode) {
          const existing = products.find(p => p.code === oldCode) || {};
          await apiSet('products', newCode, { ...existing, ...payload });
          await apiDelete('products', oldCode);
        } else {
          await apiUpdate('products', oldCode, payload);
        }
        await loadProducts_();
      } else {
        const idx = products.findIndex(p => p.code === oldCode);
        if (idx > -1) products[idx] = { ...products[idx], ...payload, code: newCode };
      }
      state.whEditCode = null;
      showToast('บันทึกข้อมูลสินค้าแล้ว');
    } catch (e) {
      showToast('บันทึกไม่สำเร็จ — ' + (e && e.message ? e.message : ''), true);
    }
    render();
  }

  async function addProduct(data) {
    const code = data.code.trim();
    if (!code || !data.name.trim()) { showToast('กรุณากรอกรหัสและชื่อสินค้า', true); return; }
    if (products.some(p => p.code === code)) { showToast('มีรหัสสินค้านี้อยู่แล้ว', true); return; }
    const payload = { name: data.name.trim(), category: (data.category || 'อื่นๆ').trim(), unit: (data.unit || 'ชิ้น').trim(), price: parseFloat(data.price) || 0, stock: parseFloat(data.stock) || 0 };
    try {
      if (apiAvailable) { await apiSet('products', code, payload); await loadProducts_(); }
      else { products.push({ code, ...payload }); }
      state.whAdding = false;
      showToast('เพิ่มสินค้าใหม่แล้ว');
    } catch (e) { console.error(e); showToast('เพิ่มสินค้าไม่สำเร็จ — ' + (e && e.message ? e.message : ''), true); }
    render();
  }

  async function deleteProduct(code) {
    try {
      if (apiAvailable) { await apiDelete('products', code); await loadProducts_(); }
      else { products = products.filter(p => p.code !== code); }
      state.whConfirmDelete = null;
      showToast('ลบสินค้าแล้ว');
    } catch (e) { console.error(e); showToast('ลบไม่สำเร็จ', true); }
    render();
  }

  // Images are stored directly as compressed base64 data-URIs on the product
  // record (field `image`) — no separate file storage/service needed, which
  // keeps this deployable as a static site + a plain Google Sheet backend.
  async function resyncMissingProducts() {
    const missing = PRODUCTS_SEED.filter(seed => !products.some(p => p.code === seed.code));
    if (!missing.length) { showToast('ไม่มีสินค้าที่ขาดหายแล้ว'); return; }
    if (!apiAvailable) { showToast('ยังไม่ได้เชื่อมต่อฐานข้อมูล', true); return; }
    showToast(`กำลังเพิ่มสินค้าที่ขาดหาย ${missing.length} รายการ...`);
    let added = 0;
    for (const p of missing) {
      try { await apiSet('products', p.code, p); added++; } catch (e) { /* keep going, report at the end */ }
    }
    await loadProducts_();
    render();
    showToast(`เพิ่มสินค้าสำเร็จ ${added}/${missing.length} รายการ` + (added < missing.length ? ' — ลองกดซ้ำอีกครั้งถ้ายังไม่ครบ' : ''));
  }

  function productImageSrc(p) { return (p && p.image) || null; }

  function compressImageFile_(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        img.onerror = reject;
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
          else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // A Google Sheets cell holds at most 50,000 characters. Try progressively
  // smaller/lower-quality renders until the base64 data URI safely fits,
  // instead of gambling on one fixed setting and silently failing later.
  const CELL_SAFE_LIMIT = 45000;
  async function compressImageUnderLimit_(file) {
    const attempts = [[360, 0.62], [280, 0.55], [200, 0.5], [160, 0.4], [120, 0.35]];
    let last = null;
    for (const [maxDim, quality] of attempts) {
      last = await compressImageFile_(file, maxDim, quality);
      if (last.length <= CELL_SAFE_LIMIT) return last;
    }
    throw new Error('image too large even at lowest quality (' + last.length + ' chars)');
  }

  async function uploadProductImage(code, file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) { showToast('กรุณาเลือกไฟล์รูปภาพ', true); return; }
    showToast('กำลังประมวลผลรูป...');
    try {
      const dataUrl = await compressImageUnderLimit_(file);
      if (apiAvailable) { await apiUpdate('products', code, { image: dataUrl }); await loadProducts_(); }
      else { const idx = products.findIndex(p => p.code === code); if (idx > -1) products[idx].image = dataUrl; }
      showToast('อัปโหลดรูปสำเร็จ');
    } catch (e) {
      console.error(e);
      showToast('อัปโหลดรูปไม่สำเร็จ — ' + (e && e.message ? e.message : 'ลองใช้รูปที่มีรายละเอียดน้อยกว่านี้'), true);
    }
    render();
  }

  async function removeProductImage(code) {
    try {
      if (apiAvailable) { await apiUpdate('products', code, { image: '' }); await loadProducts_(); }
      else { const idx = products.findIndex(p => p.code === code); if (idx > -1) products[idx].image = ''; }
      showToast('ลบรูปแล้ว');
    } catch (e) { console.error(e); showToast('ลบรูปไม่สำเร็จ', true); }
    render();
  }

  function imagePickerButton(code, labelText, cls) {
    const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none;' });
    input.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadProductImage(code, f); });
    const btn = el('button', { class: cls || 'btn ghost sm', onclick: () => input.click() }, [txt(labelText)]);
    const wrap = el('span', {}, [btn, input]);
    return wrap;
  }

  // ---------- User admin CRUD ----------
  async function addUser(data) {
    const username = (data.username || '').trim().toLowerCase();
    if (!username || !data.password) { showToast('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน', true); return; }
    if (authUsers.some(u => u.username === username) || LOCAL_FALLBACK_USERS[username]) { showToast('มีชื่อผู้ใช้นี้อยู่แล้ว', true); return; }
    try {
      const hash = await hashPassword(data.password);
      const payload = { passwordHash: hash, role: data.role === 'admin' ? 'admin' : 'user', displayName: data.displayName.trim() || username };
      if (apiAvailable) { await apiSet('auth_users', username, payload); await loadAuthUsers_(); }
      else { authUsers.push({ username, ...payload }); }
      showToast('เพิ่มผู้ใช้งานแล้ว');
    } catch (e) { console.error(e); showToast('เพิ่มผู้ใช้งานไม่สำเร็จ — ' + (e && e.message ? e.message : ''), true); }
    render();
  }

  async function deleteUser(username) {
    const admins = authUsers.filter(u => u.role === 'admin');
    if (username === (session && session.username)) { showToast('ไม่สามารถลบบัญชีที่ใช้งานอยู่ได้', true); return; }
    const target = authUsers.find(u => u.username === username);
    if (target && target.role === 'admin' && admins.length <= 1) { showToast('ต้องมีแอดมินอย่างน้อย 1 บัญชี', true); return; }
    try {
      if (apiAvailable) { await apiDelete('auth_users', username); await loadAuthUsers_(); }
      else { authUsers = authUsers.filter(u => u.username !== username); }
      state.userConfirmDelete = null;
      showToast('ลบผู้ใช้งานแล้ว');
    } catch (e) { console.error(e); showToast('ลบไม่สำเร็จ', true); }
    render();
  }

  // ---------- DOM helpers ----------
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.setAttribute('style', v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    });
    (children || []).forEach(c => { if (c) e.appendChild(c); });
    return e;
  }
  function txt(s) { return document.createTextNode(s); }

  // ---------- Render root ----------
  function render() {
    if (!session) { showLogin_(); return; }
    document.body.style.background = '';
    document.body.classList.remove('login-body');
    document.getElementById('loginPage').style.display = 'none';
    const app = document.getElementById('app');
    app.style.display = '';
    app.innerHTML = '';

    const header = el('header', { class: 'topbar' }, [
      el('div', { class: 'brand-row' }, [
        el('img', { src: LOGO_SRC, alt: 'Bangkok Hospital Samui' }),
        el('div', { class: 'brand-text' }, [
          el('div', { class: 'name' }, [txt('ระบบเบิกของใช้ฟุ่มเฟือย')]),
          el('div', { class: 'sub' }, [txt('NON INVENTORY SYSTEM')])
        ])
      ]),
      el('div', { class: 'session-box' }, [
        el('span', { class: 'role-badge ' + session.role }, [txt(session.role === 'admin' ? 'แอดมิน' : 'ผู้ใช้งาน')]),
        el('span', {}, [txt(session.displayName)]),
        el('button', { class: 'logout-btn', onclick: doLogout }, [txt('ออกจากระบบ')])
      ])
    ]);
    app.appendChild(header);
    app.appendChild(el('p', { class: 'subtitle' }, [txt('Bangkok Hospital Samui')]));

    const pendingCountForTab = history.filter(h => h.type === 'เบิกของ' && h.status === 'pending').length;
    const tabsDef = [
      ['transact', '📦 เบิก/เติมสต๊อก']
    ];
    if (isAdmin()) tabsDef.push(['fulfillment', '📋 สรุปรายการเบิก' + (pendingCountForTab ? ` (${pendingCountForTab})` : '')]);
    tabsDef.push(
      ['warehouse', '🗄️ คลังสินค้า']
    );
    if (isAdmin()) tabsDef.push(['stockCount', '🧮 เช็คสต๊อก']);
    tabsDef.push(
      ['reportLuxury', '📊 รายงานฟุ่มเฟือย'],
      ['reportWithdraw', '🔻 รายงานการเบิก'],
      ['reportRestock', '🔄 รายงานเติมสต๊อก'],
      ['reportDept', '🏥 รายงานรายแผนก'],
      ['history', '🕒 ประวัติ']
    );
    if (isAdmin()) tabsDef.push(['users', '👤 ผู้ใช้งาน']);

    const nav = el('nav', { class: 'tabs' }, tabsDef.map(([key, label]) =>
      el('button', { class: state.tab === key ? 'active' : '', onclick: () => { state.tab = key; render(); } }, [txt(label)])
    ));
    app.appendChild(nav);

    if (!dbAvailable) {
      app.appendChild(el('div', { class: 'banner' }, [txt('⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูล (Google Sheet) — กรุณาตั้งค่า API_URL ในไฟล์ config.js ตามคำแนะนำใน README.md ตอนนี้ข้อมูลจะไม่ถูกบันทึกถาวรและใช้ได้เฉพาะเครื่องนี้เท่านั้น')]));
    }

    const map = { transact: renderTransact, fulfillment: renderFulfillment, warehouse: renderWarehouse, stockCount: renderStockCount, reportLuxury: renderReportLuxury, reportWithdraw: renderReportWithdraw, reportRestock: renderReportRestock, reportDept: renderReportDept, history: renderHistory, users: renderUsers };
    const fn = map[state.tab] || renderTransact;
    const adminOnlyTabs = ['users', 'fulfillment', 'stockCount'];
    if (adminOnlyTabs.indexOf(state.tab) !== -1 && !isAdmin()) { state.tab = 'transact'; renderTransact(app); }
    else fn(app);

    const footerEl = document.getElementById('appFooter');
    if (footerEl) footerEl.style.display = '';
  }

  // ---------- Login page ----------
  // The login page is now real, static HTML living directly in index.html
  // (search for id="loginPage" there). This JS only shows/hides it, fills
  // in the logo, wires the submit button once, and displays any error.
  // To change wording/layout/styling, edit index.html directly — no need
  // to touch this file at all for that.
  let loginWired_ = false;
  function wireLoginOnce_() {
    if (loginWired_) return;
    loginWired_ = true;
    const logoEl = document.getElementById('loginLogo');
    if (logoEl) logoEl.src = LOGO_SRC;
    const submitLogin = () => {
      const u = document.getElementById('loginUser').value;
      const p = document.getElementById('loginPass').value;
      doLogin(u, p);
    };
    const btn = document.getElementById('loginSubmitBtn');
    if (btn) btn.addEventListener('click', submitLogin);
    const ui = document.getElementById('loginUser');
    const pi = document.getElementById('loginPass');
    if (ui) ui.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
    if (pi) pi.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });
  }

  function showLogin_() {
    wireLoginOnce_();
    document.body.style.background = 'linear-gradient(160deg,#070a1e 0%,#141c48 42%,#241b4d 72%,#07091c 100%)';
    document.body.classList.add('login-body');
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.display = 'none';
    const appFooterEl = document.getElementById('appFooter');
    if (appFooterEl) appFooterEl.style.display = 'none';
    const loginPage = document.getElementById('loginPage');
    if (loginPage) loginPage.style.display = '';
    const errBox = document.getElementById('loginErrorBox');
    if (errBox) {
      if (state.loginError) { errBox.textContent = state.loginError; errBox.style.display = ''; }
      else { errBox.style.display = 'none'; }
    }
    const ui = document.getElementById('loginUser');
    if (ui && !state.loginError) ui.focus();
  }

  // ---------- Transact tab ----------
  function renderTransact(app) {
    const card = el('div', { class: 'card' });
    const modeSwitch = el('div', { class: 'mode-switch' }, [
      el('button', { class: 'withdraw' + (state.mode === 'withdraw' ? ' active' : ''), onclick: () => { state.mode = 'withdraw'; render(); } }, [txt('🔻 เบิกของ')]),
      el('button', {
        class: 'restock' + (state.mode === 'restock' ? ' active' : ''),
        disabled: !isAdmin() ? 'disabled' : null,
        onclick: () => { if (isAdmin()) { state.mode = 'restock'; render(); } }
      }, [txt('🔺 เติมสต๊อก' + (isAdmin() ? '' : ' (เฉพาะแอดมิน)'))])
    ]);
    card.appendChild(modeSwitch);

    if (state.mode === 'withdraw' && session) {
      card.appendChild(el('div', { class: 'requester-box' }, [
        txt('👤 ผู้เบิก: '),
        el('span', { class: 'who' }, [txt(session.displayName)]),
        txt(' (รหัสพนักงาน ' + session.username + ') — ระบุอัตโนมัติจากบัญชีที่เข้าสู่ระบบ')
      ]));
    }

    const controls = el('div', { class: 'grid-controls' });

    if (state.mode === 'withdraw') {
      const deptField = el('div', { class: 'field grow' });
      deptField.appendChild(el('label', {}, [txt('แผนกที่เบิก')]));
      const sel = el('select', {
        onchange: (e) => { state.deptCode = e.target.value; try { localStorage.setItem('req_app_dept', state.deptCode); } catch (err) {} render(); }
      });
      sel.appendChild(el('option', { value: '' }, [txt('-- เลือกแผนก --')]));
      DEPTS.forEach(d => {
        const o = el('option', { value: d.code }, [txt(d.name + ' (' + d.code + ')')]);
        if (d.code === state.deptCode) o.setAttribute('selected', 'selected');
        sel.appendChild(o);
      });
      deptField.appendChild(sel);
      controls.appendChild(deptField);
    }

    const searchField = el('div', { class: 'field grow' });
    searchField.appendChild(el('label', {}, [txt('ค้นหาสินค้า')]));
    const searchInput = el('input', { type: 'search', placeholder: 'พิมพ์ชื่อสินค้า...', value: state.search });
    searchInput.addEventListener('input', (e) => { state.search = e.target.value; renderProductList(); });
    searchField.appendChild(searchInput);
    controls.appendChild(searchField);

    card.appendChild(controls);

    const catScroll = el('div', { class: 'cat-scroll' }, categories().map(c =>
      el('button', { class: 'cat-chip' + (state.category === c ? ' active' : ''), onclick: () => { state.category = c; render(); } }, [txt(c)])
    ));
    card.appendChild(catScroll);

    const listWrap = el('div', { id: 'productListWrap' });
    card.appendChild(listWrap);

    app.appendChild(card);
    renderProductList();
    renderCartUI(app);
  }

  function renderProductList() {
    const wrap = document.getElementById('productListWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const q = state.search.trim().toLowerCase();
    let list = products.filter(p => (state.category === 'ทั้งหมด' || p.category === state.category));
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.code.includes(q));

    if (!list.length) { wrap.appendChild(el('div', { class: 'empty-note' }, [txt('ไม่พบสินค้าที่ค้นหา')])); return; }

    const container = el('div', { class: 'product-list' });
    list.forEach(p => {
      const stockClass = p.stock <= 0 ? 'zero' : (p.stock <= 5 ? 'low' : 'ok');
      const thumbSrc = productImageSrc(p);
      const thumb = thumbSrc ? el('img', { class: 'prod-thumb', src: thumbSrc, alt: p.name }) : el('div', { class: 'prod-thumb-ph' }, [txt('📦')]);
      const info = el('div', {}, [
        el('div', { class: 'p-name' }, [txt(p.name)]),
        el('div', { class: 'p-meta' }, [txt(p.category + ' • ' + p.unit + ' • ' + fmtMoney(p.price) + ' บาท/' + p.unit)]),
        el('div', { class: 'p-stock ' + stockClass }, [txt('คงเหลือ: ' + fmt(p.stock) + ' ' + p.unit)])
      ]);
      const currentQty = state.cart[p.code] || 0;
      const qtyInput = el('input', { type: 'number', min: '0', step: '1', value: currentQty || '' });
      qtyInput.addEventListener('change', (e) => { let v = parseFloat(e.target.value) || 0; if (v < 0) v = 0; setCartQty(p.code, v); });
      const minusBtn = el('button', { onclick: () => { const v = Math.max(0, (state.cart[p.code] || 0) - 1); setCartQty(p.code, v); } }, [txt('−')]);
      const plusBtn = el('button', { onclick: () => { const v = (state.cart[p.code] || 0) + 1; setCartQty(p.code, v); } }, [txt('+')]);
      const qtyBox = el('div', { class: 'qty-box' }, [minusBtn, qtyInput, plusBtn]);
      container.appendChild(el('div', { class: 'product-row' }, [thumb, info, qtyBox]));
    });
    wrap.appendChild(container);
  }

  function renderCartUI(app) {
    const items = cartItemsArray();
    const count = cartCount();
    const total = cartTotal();

    if (state.cartOpen && items.length) {
      const panel = el('div', { class: 'cart-panel' });
      const inner = el('div', { class: 'cart-panel-inner' });
      items.forEach(it => {
        const thumbSrc = productImageSrc(it.product);
        const thumb = thumbSrc ? el('img', { src: thumbSrc, alt: it.product.name, style: 'width:30px;height:30px;border-radius:6px;object-fit:cover;flex-shrink:0;' }) : el('div', { style: 'width:30px;height:30px;border-radius:6px;background:var(--surface-2);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.8rem;' }, [txt('📦')]);
        inner.appendChild(el('div', { class: 'cart-line' }, [
          thumb,
          el('div', { class: 'name' }, [txt(it.product.name + ' × ' + fmt(it.qty) + ' ' + it.product.unit)]),
          el('div', { class: 'amt' }, [txt(fmtMoney(it.qty * it.product.price) + ' บ.')]),
          el('button', { class: 'rm', onclick: () => { delete state.cart[it.code]; render(); } }, [txt('✕')])
        ]));
      });
      panel.appendChild(inner);
      app.appendChild(panel);
    }

    const bar = el('div', { class: 'cart-bar' });
    const submitBtn = el('button', { id: 'submitBtn', class: 'submit-btn ' + state.mode, onclick: submit }, [txt(state.mode === 'withdraw' ? 'บันทึกการเบิก' : 'บันทึกการเติมสต๊อก')]);
    if (!items.length) submitBtn.setAttribute('disabled', 'disabled');
    bar.appendChild(el('div', { class: 'cart-bar-inner' }, [
      el('div', { class: 'cart-summary' }, [
        el('div', {}, [txt(count ? (count + ' รายการ') : 'ยังไม่มีรายการ')]),
        el('b', {}, [txt(fmtMoney(total) + ' บาท')])
      ]),
      el('button', { class: 'cart-toggle', onclick: () => { state.cartOpen = !state.cartOpen; render(); } }, [txt(state.cartOpen ? 'ซ่อนรายการ' : 'ดูรายการ (' + count + ')')]),
      submitBtn
    ]));
    app.appendChild(bar);
  }

  // ---------- Fulfillment tab: check & release pending withdrawals ----------
  function pendingWithdrawals_() {
    return history.filter(h => h.type === 'เบิกของ' && h.status === 'pending')
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()); // oldest first (queue order)
  }

  async function releaseRequisition(reqId) {
    const req = history.find(h => h.id === reqId);
    if (!req) return;
    const rows = document.querySelectorAll(`[data-fulfill-row="${reqId}"]`);
    const updatedItems = [];
    let shortfall = null;
    rows.forEach(row => {
      const code = row.getAttribute('data-code');
      const input = row.querySelector('input');
      const qty = Math.max(0, parseFloat(input.value) || 0);
      const orig = (req.items || []).find(it => it.code === code);
      const product = products.find(p => p.code === code);
      const availableStock = product ? product.stock : 0;
      if (qty > availableStock && !shortfall) shortfall = { name: orig.name, available: availableStock };
      updatedItems.push({ ...orig, qty, subtotal: Math.round(qty * orig.price * 100) / 100 });
    });
    if (shortfall) { showToast(`${shortfall.name}: คงเหลือไม่พอ (เหลือ ${fmt(shortfall.available)}) กรุณาปรับจำนวนหรือเติมสต๊อกก่อน`, true); return; }

    const newTotal = Math.round(updatedItems.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    try {
      if (apiAvailable) {
        for (const it of updatedItems) {
          if (it.qty <= 0) continue;
          const product = products.find(p => p.code === it.code);
          const newStock = Math.round(((product ? product.stock : 0) - it.qty) * 100) / 100;
          await apiUpdate('products', it.code, { stock: newStock });
        }
        await apiUpdate('requisitions', reqId, {
          items: updatedItems.filter(it => it.qty > 0), total: newTotal, status: 'fulfilled',
          fulfilledAt: new Date().toISOString(), fulfilledBy: session.username, fulfilledByName: session.displayName
        });
        await refreshAll_(false);
      } else {
        updatedItems.forEach(it => { if (it.qty > 0) { const p = products.find(pp => pp.code === it.code); if (p) p.stock = Math.round((p.stock - it.qty) * 100) / 100; } });
        const idx = history.findIndex(h => h.id === reqId);
        if (idx > -1) history[idx] = { ...history[idx], items: updatedItems.filter(it => it.qty > 0), total: newTotal, status: 'fulfilled' };
      }
      showToast('ปล่อยของสำเร็จ');
    } catch (e) { console.error(e); showToast('เกิดข้อผิดพลาด — ' + (e && e.message ? e.message : 'ลองใหม่อีกครั้ง'), true); }
    render();
  }

  async function cancelRequisition(reqId) {
    try {
      if (apiAvailable) {
        await apiUpdate('requisitions', reqId, { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: session.username });
        await refreshAll_(false);
      } else {
        const idx = history.findIndex(h => h.id === reqId);
        if (idx > -1) history[idx] = { ...history[idx], status: 'cancelled' };
      }
      state.fulfillConfirmCancel = null;
      showToast('ยกเลิกคำขอแล้ว');
    } catch (e) { console.error(e); showToast('ยกเลิกไม่สำเร็จ', true); }
    render();
  }

  function renderFulfillment(app) {
    const list = pendingWithdrawals_();
    const headCard = el('div', { class: 'card' });
    headCard.appendChild(el('div', { style: 'font-weight:800;font-size:.95rem;color:var(--navy);' }, [txt('สรุปรายการเบิก — ตรวจสอบและปล่อยของ')]));
    headCard.appendChild(el('div', { style: 'font-size:.8rem;color:var(--text-dim);margin-top:4px;' }, [
      txt('รายการที่ผู้เบิกส่งคำขอมา เรียงจากคำขอเก่าสุดก่อน ตรวจนับสินค้าจริงแล้วปรับจำนวนในช่องได้ก่อนกดยืนยัน ระบบจะตัดสต๊อกก็ต่อเมื่อกด "ยืนยันปล่อยของ" เท่านั้น')
    ]));
    app.appendChild(headCard);

    if (!list.length) {
      app.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-note' }, [txt('ไม่มีคำขอเบิกที่รอปล่อยของในขณะนี้')])]));
      return;
    }

    list.forEach(req => {
      const card = el('div', { class: 'fulfill-card' });
      card.appendChild(el('div', { class: 'fulfill-head' }, [
        el('div', {}, [
          el('div', { class: 'who' }, [txt(req.deptName || '-')]),
          el('div', { class: 'meta' }, [txt('ผู้เบิก: ' + (req.requester || '-') + ' (รหัสพนักงาน ' + (req.employeeId || '-') + ') • ' + fmtDate(req.ts))])
        ]),
        el('div', { style: 'font-weight:800;color:var(--navy);' }, [txt(fmtMoney(req.total || 0) + ' บาท')])
      ]));

      const table = el('table', { class: 'fulfill-items' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', {}, [txt('รายการสินค้า')]), el('th', {}, [txt('ขอเบิก')]), el('th', {}, [txt('คงเหลือปัจจุบัน')]), el('th', {}, [txt('จำนวนที่จะปล่อยจริง')])
      ])]));
      const tbody = el('tbody');
      (req.items || []).forEach(it => {
        const product = products.find(p => p.code === it.code);
        const available = product ? product.stock : 0;
        const short = available < it.qty;
        const input = el('input', { type: 'number', min: '0', step: '1', value: Math.min(it.qty, Math.max(available, 0)) });
        tbody.appendChild(el('tr', { 'data-fulfill-row': req.id, 'data-code': it.code }, [
          el('td', {}, [txt(it.name)]),
          el('td', {}, [txt(fmt(it.qty) + ' ' + it.unit)]),
          el('td', { class: short ? 'short' : '' }, [txt(fmt(available) + ' ' + it.unit)]),
          el('td', {}, [input])
        ]));
      });
      table.appendChild(tbody);
      card.appendChild(table);

      const actions = el('div', { class: 'fulfill-actions' }, [
        el('button', { class: 'btn success', onclick: () => releaseRequisition(req.id) }, [txt('✅ ยืนยันปล่อยของ')]),
        el('button', { class: 'btn ghost', onclick: () => { state.fulfillConfirmCancel = state.fulfillConfirmCancel === req.id ? null : req.id; render(); } }, [txt('✕ ยกเลิกคำขอนี้')])
      ]);
      card.appendChild(actions);

      if (state.fulfillConfirmCancel === req.id) {
        card.appendChild(el('div', { class: 'confirm-box' }, [
          txt('ยืนยันยกเลิกคำขอเบิกนี้หรือไม่? (จะไม่มีการตัดสต๊อก)'),
          el('button', { class: 'btn danger sm', onclick: () => cancelRequisition(req.id) }, [txt('ยืนยันยกเลิก')]),
          el('button', { class: 'btn ghost sm', onclick: () => { state.fulfillConfirmCancel = null; render(); } }, [txt('ปิด')])
        ]));
      }

      app.appendChild(card);
    });
  }

  // ---------- Stock count tab (monthly physical inventory check) ----------
  async function saveStockCount() {
    const rows = document.querySelectorAll('[data-stockcount-code]');
    if (!rows.length) { showToast('ไม่พบรายการสินค้าให้บันทึก', true); return; }
    const items = [];
    rows.forEach(row => {
      const code = row.getAttribute('data-stockcount-code');
      const product = products.find(p => p.code === code);
      if (!product) return;
      const input = row.querySelector('input');
      const counted = Math.max(0, parseFloat(input.value));
      if (isNaN(counted)) return;
      const diff = Math.round((counted - product.stock) * 100) / 100;
      items.push({
        code, name: product.name, category: product.category, unit: product.unit, price: product.price,
        systemStock: product.stock, countedStock: counted, diff, diffValue: Math.round(diff * product.price * 100) / 100
      });
    });
    if (!items.length) { showToast('ไม่พบข้อมูลที่กรอก', true); return; }

    const changed = items.filter(it => it.diff !== 0);
    const totalDiffValue = Math.round(items.reduce((s, it) => s + it.diffValue, 0) * 100) / 100;
    const record = {
      date: new Date().toISOString(),
      checkedBy: session.username,
      checkedByName: session.displayName,
      notes: state.stockCountNotes.trim(),
      items,
      itemCount: items.length,
      changedCount: changed.length,
      totalDiffValue
    };

    const btn = document.getElementById('saveStockCountBtn');
    if (btn) btn.disabled = true;
    try {
      if (apiAvailable) {
        for (const it of changed) await apiUpdate('products', it.code, { stock: it.countedStock });
        await apiAdd('stock_counts', record);
        await refreshAll_(false);
        try { await loadStockCounts_(); } catch (e2) {}
      } else {
        changed.forEach(it => { const p = products.find(pp => pp.code === it.code); if (p) p.stock = it.countedStock; });
        stockCounts.unshift({ id: 'local-' + Date.now(), ...record });
      }
      state.stockCountNotes = '';
      showToast(`บันทึกผลการเช็คสต๊อกสำเร็จ — พบผลต่าง ${changed.length} จาก ${items.length} รายการ`);
    } catch (e) { console.error(e); showToast('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง', true); }
    if (btn) btn.disabled = false;
    render();
  }

  function exportStockCountXLSX(session) {
    const rows = [['รหัสสินค้า', 'ชื่อสินค้า', 'หมวดหมู่', 'หน่วย', 'ราคา/หน่วย', 'ยอดในระบบ (ก่อนปรับ)', 'ยอดนับจริง', 'ผลต่าง (จำนวน)', 'ผลต่าง (มูลค่า)']];
    (session.items || []).forEach(it => {
      rows.push([it.code, it.name, it.category, it.unit, it.price, it.systemStock, it.countedStock, it.diff, it.diffValue]);
    });
    const info = [['วันที่เช็คสต๊อก', fmtDate(session.date)], ['ผู้เช็ค', session.checkedByName || session.checkedBy || '-'], ['หมายเหตุ', session.notes || '-'], ['จำนวนรายการที่ตรวจนับ', session.itemCount], ['จำนวนรายการที่พบผลต่าง', session.changedCount], ['มูลค่าผลต่างรวม', session.totalDiffValue], []];
    downloadXLSX('รายงานเช็คสต๊อก_' + fmtDate(session.date).replace(/[/,: ]/g, '-') + '.xlsx', { 'สรุป': info, 'รายละเอียด': rows });
  }

  let stockCountsFetched_ = false;
  function ensureStockCountsLoaded_() {
    if (stockCountsFetched_ || !apiAvailable) return;
    stockCountsFetched_ = true;
    loadStockCounts_().then(render).catch(() => { stockCountsFetched_ = false; });
  }

  function renderStockCount(app) {
    ensureStockCountsLoaded_();
    const formCard = el('div', { class: 'card' });
    formCard.appendChild(el('div', { style: 'font-weight:800;font-size:.95rem;color:var(--navy);margin-bottom:4px;' }, [txt('เช็คสต๊อกสินค้า (ตรวจนับประจำเดือน)')]));
    formCard.appendChild(el('div', { style: 'font-size:.8rem;color:var(--text-dim);margin-bottom:10px;' }, [
      txt('กรอกยอดที่นับได้จริงในช่อง "นับได้จริง" ของแต่ละรายการ (ค่าเริ่มต้น = ยอดในระบบ แก้เฉพาะรายการที่ต่างจากที่นับได้) แล้วกดบันทึกท้ายหน้า ระบบจะปรับยอดคงเหลือให้ตรงกับที่นับจริงเฉพาะรายการที่มีผลต่างเท่านั้น')
    ]));

    const controls = el('div', { class: 'grid-controls' });
    const searchField = el('div', { class: 'field grow' });
    searchField.appendChild(el('label', {}, [txt('ค้นหาสินค้า')]));
    const searchInput = el('input', { type: 'search', placeholder: 'พิมพ์ชื่อหรือรหัสสินค้า', value: state.stockCountSearch });
    searchInput.addEventListener('input', (e) => { state.stockCountSearch = e.target.value; renderStockCountList(); });
    searchField.appendChild(searchInput);
    controls.appendChild(searchField);
    formCard.appendChild(controls);

    const catScroll = el('div', { class: 'cat-scroll' }, categories().map(c =>
      el('button', { class: 'cat-chip' + (state.stockCountCategory === c ? ' active' : ''), onclick: () => { state.stockCountCategory = c; render(); } }, [txt(c)])
    ));
    formCard.appendChild(catScroll);

    const listWrap = el('div', { id: 'stockCountListWrap' });
    formCard.appendChild(listWrap);

    const notesField = el('div', { class: 'field grow', style: 'margin-top:10px;' });
    notesField.appendChild(el('label', {}, [txt('หมายเหตุ (ถ้ามี)')]));
    const notesInput = el('input', { type: 'text', placeholder: 'เช่น เช็คสต๊อกประจำเดือนกันยายน 2569', value: state.stockCountNotes });
    notesInput.addEventListener('input', (e) => { state.stockCountNotes = e.target.value; });
    notesField.appendChild(notesInput);
    formCard.appendChild(notesField);

    formCard.appendChild(el('button', { id: 'saveStockCountBtn', class: 'btn success', style: 'margin-top:10px;', onclick: saveStockCount }, [txt('💾 บันทึกผลการเช็คสต๊อก')]));
    app.appendChild(formCard);
    renderStockCountList();

    // ---- History of past stock counts ----
    const histCard = el('div', { class: 'card' });
    histCard.appendChild(el('div', { style: 'font-weight:800;font-size:.92rem;color:var(--navy);margin-bottom:8px;' }, [txt('ประวัติการเช็คสต๊อก')]));
    if (!stockCounts.length) {
      histCard.appendChild(el('div', { class: 'empty-note' }, [txt('ยังไม่มีประวัติการเช็คสต๊อก')]));
    } else {
      const table = el('table', { class: 'rep' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', {}, [txt('วันที่')]), el('th', {}, [txt('ผู้เช็ค')]), el('th', {}, [txt('หมายเหตุ')]),
        el('th', {}, [txt('รายการที่ตรวจ')]), el('th', {}, [txt('พบผลต่าง')]), el('th', {}, [txt('มูลค่าผลต่าง')]), el('th', {}, [txt('')])
      ])]));
      const tbody = el('tbody');
      stockCounts.forEach(sc => {
        const isExpanded = state.stockCountExpanded === sc.id;
        tbody.appendChild(el('tr', { class: 'row-expand', onclick: () => { state.stockCountExpanded = isExpanded ? null : sc.id; render(); } }, [
          el('td', {}, [txt((isExpanded ? '▾ ' : '▸ ') + fmtDate(sc.date))]),
          el('td', {}, [txt(sc.checkedByName || sc.checkedBy || '-')]),
          el('td', {}, [txt(sc.notes || '-')]),
          el('td', { class: 'num' }, [txt(fmt(sc.itemCount))]),
          el('td', { class: 'num', style: sc.changedCount ? 'color:var(--warn);font-weight:700;' : '' }, [txt(fmt(sc.changedCount))]),
          el('td', { class: 'num', style: sc.totalDiffValue < 0 ? 'color:var(--red);' : (sc.totalDiffValue > 0 ? 'color:var(--success);' : '') }, [txt(fmtMoney(sc.totalDiffValue) + ' บ.')]),
          el('td', {}, [el('button', { class: 'btn ghost sm', onclick: (e) => { e.stopPropagation(); exportStockCountXLSX(sc); } }, [txt('⬇ Excel')])])
        ]));
        if (isExpanded) {
          const changedItems = (sc.items || []).filter(it => it.diff !== 0);
          const sub = el('tr', { class: 'subrow' });
          const td = el('td', { colspan: '7' });
          if (!changedItems.length) {
            td.appendChild(el('div', { class: 'empty-note' }, [txt('ไม่พบผลต่างในการเช็คครั้งนี้ (ยอดตรงกับระบบทุกรายการ)')]));
          } else {
            const miniTable = el('table', { class: 'rep', style: 'margin:4px 0;' });
            miniTable.appendChild(el('thead', {}, [el('tr', {}, [el('th', {}, [txt('สินค้า')]), el('th', {}, [txt('ระบบ')]), el('th', {}, [txt('นับจริง')]), el('th', {}, [txt('ผลต่าง')]), el('th', {}, [txt('มูลค่าผลต่าง')])])]));
            const miniBody = el('tbody');
            changedItems.forEach(it => {
              miniBody.appendChild(el('tr', {}, [
                el('td', {}, [txt(it.name)]), el('td', { class: 'num' }, [txt(fmt(it.systemStock))]), el('td', { class: 'num' }, [txt(fmt(it.countedStock))]),
                el('td', { class: 'num', style: it.diff < 0 ? 'color:var(--red);' : 'color:var(--success);' }, [txt((it.diff > 0 ? '+' : '') + fmt(it.diff))]),
                el('td', { class: 'num' }, [txt(fmtMoney(it.diffValue) + ' บ.')])
              ]));
            });
            miniTable.appendChild(miniBody);
            td.appendChild(miniTable);
          }
          sub.appendChild(td);
          tbody.appendChild(sub);
        }
      });
      table.appendChild(tbody);
      histCard.appendChild(el('div', { style: 'overflow-x:auto' }, [table]));
    }
    app.appendChild(histCard);
  }

  function renderStockCountList() {
    const wrap = document.getElementById('stockCountListWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const q = state.stockCountSearch.trim().toLowerCase();
    let list = products.filter(p => (state.stockCountCategory === 'ทั้งหมด' || p.category === state.stockCountCategory));
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.code.includes(q));
    list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'th'));

    if (!list.length) { wrap.appendChild(el('div', { class: 'empty-note' }, [txt('ไม่พบสินค้าที่ค้นหา')])); return; }

    const container = el('div', { class: 'product-list' });
    list.forEach(p => {
      const thumbSrc = productImageSrc(p);
      const thumb = thumbSrc ? el('img', { class: 'prod-thumb', src: thumbSrc, alt: p.name }) : el('div', { class: 'prod-thumb-ph' }, [txt('📦')]);
      const info = el('div', {}, [
        el('div', { class: 'p-name' }, [txt(p.name)]),
        el('div', { class: 'p-meta' }, [txt(p.category + ' • ' + p.unit + ' • ระบบ: ' + fmt(p.stock) + ' ' + p.unit)])
      ]);
      const input = el('input', { type: 'number', min: '0', step: '1', value: p.stock, style: 'width:80px;text-align:center;' });
      const qtyBox = el('div', {}, [el('label', { style: 'font-size:.7rem;color:var(--text-dim);display:block;margin-bottom:3px;' }, [txt('นับได้จริง')]), input]);
      container.appendChild(el('div', { class: 'product-row', 'data-stockcount-code': p.code }, [thumb, info, qtyBox]));
    });
    wrap.appendChild(container);
  }

  // ---------- Warehouse tab ----------
  function renderWarehouse(app) {
    const card = el('div', { class: 'card' });
    const controls = el('div', { class: 'grid-controls' });
    const searchField = el('div', { class: 'field grow' });
    searchField.appendChild(el('label', {}, [txt('ค้นหาสินค้า')]));
    const searchInput = el('input', { type: 'search', placeholder: 'ค้นหาชื่อหรือรหัสสินค้า', value: state.whSearch });
    searchInput.addEventListener('input', (e) => { state.whSearch = e.target.value; renderWarehouseList(); });
    searchField.appendChild(searchInput);
    controls.appendChild(searchField);
    if (isAdmin()) {
      const addBtnField = el('div', { class: 'field small' }, [el('label', {}, [txt('\u00A0')])]);
      addBtnField.appendChild(el('button', { class: 'btn', onclick: () => { state.whAdding = !state.whAdding; render(); } }, [txt(state.whAdding ? 'ยกเลิก' : '+ เพิ่มสินค้าใหม่')]));
      controls.appendChild(addBtnField);
    }
    card.appendChild(controls);

    const missingCount = PRODUCTS_SEED.filter(seed => !products.some(p => p.code === seed.code)).length;
    if (isAdmin() && missingCount > 0) {
      card.appendChild(el('div', { class: 'banner' }, [
        txt(`⚠️ พบสินค้าจากรายการเริ่มต้นที่ยังไม่มีในฐานข้อมูล ${missingCount} รายการ (อาจเกิดจากการซิงก์ครั้งแรกไม่สมบูรณ์) `),
        el('button', { class: 'btn ghost sm', style: 'margin-left:8px;', onclick: resyncMissingProducts }, [txt('เพิ่มสินค้าที่ขาดหายให้อัตโนมัติ')])
      ]));
    }

    if (isAdmin() && state.whAdding) card.appendChild(renderAddProductForm());
    if (isAdmin()) card.appendChild(renderProductImportBox());

    const listWrap = el('div', { id: 'whListWrap' });
    card.appendChild(listWrap);
    app.appendChild(card);
    renderWarehouseList();
  }

  function renderAddProductForm() {
    const box = el('div', { class: 'add-form' });
    box.appendChild(el('div', { style: 'font-weight:700;margin-bottom:6px;font-size:.85rem;' }, [txt('เพิ่มสินค้าใหม่')]));
    const grid = el('div', { class: 'edit-grid' });
    const codeIn = el('input', { type: 'text', placeholder: 'รหัสสินค้า' });
    const nameIn = el('input', { type: 'text', placeholder: 'ชื่อสินค้า' });
    const catIn = el('input', { type: 'text', placeholder: 'หมวดหมู่', list: 'catlist' });
    const unitIn = el('input', { type: 'text', placeholder: 'หน่วย' });
    const priceIn = el('input', { type: 'number', placeholder: 'ราคา/หน่วย', step: '0.01' });
    const stockIn = el('input', { type: 'number', placeholder: 'จำนวนเริ่มต้น', step: '1' });
    [codeIn, nameIn, catIn, unitIn, priceIn, stockIn].forEach(i => grid.appendChild(i));
    box.appendChild(grid);
    const datalist = el('datalist', { id: 'catlist' }, categories().filter(c => c !== 'ทั้งหมด').map(c => el('option', { value: c })));
    box.appendChild(datalist);
    box.appendChild(el('button', {
      class: 'btn success sm', onclick: () => addProduct({ code: codeIn.value, name: nameIn.value, category: catIn.value, unit: unitIn.value, price: priceIn.value, stock: stockIn.value })
    }, [txt('บันทึกสินค้าใหม่')]));
    return box;
  }

  // ---------- Bulk product import (CSV / Excel) ----------
  function downloadProductImportTemplate() {
    const rows = [
      ['รหัสสินค้า', 'ชื่อสินค้า', 'หมวดหมู่', 'หน่วย', 'ราคา/หน่วย', 'จำนวนเริ่มต้น (เฉพาะสินค้าใหม่)'],
      ['101992055999', 'ตัวอย่างสินค้า', 'อื่นๆ', 'ชิ้น', 25.5, 100]
    ];
    downloadXLSX('แม่แบบนำเข้าสินค้า.xlsx', { 'แม่แบบ': rows });
  }

  // Reads a .csv or .xlsx/.xls file (via SheetJS, which understands both)
  // and returns its first sheet as an array of row-arrays.
  function fileToRows_(file) {
    return new Promise((resolve, reject) => {
      if (typeof XLSX === 'undefined') { reject(new Error('no xlsx lib')); return; }
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        try {
          const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }));
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function bulkImportProducts(file) {
    if (!file) return;
    let rows;
    try { rows = await fileToRows_(file); } catch (e) { console.error(e); showToast('อ่านไฟล์ไม่สำเร็จ — ต้องเป็น .csv หรือ .xlsx เท่านั้น', true); return; }
    if (!rows || rows.length < 2) { showToast('ไม่พบข้อมูลในไฟล์ (แถวแรกต้องเป็นหัวตาราง)', true); return; }

    const dataRows = rows.slice(1); // skip header row
    let created = 0, updated = 0, skipped = 0;
    for (const r of dataRows) {
      const code = String(r[0] || '').trim();
      const name = String(r[1] || '').trim();
      if (!code || !name) { skipped++; continue; }
      const category = String(r[2] || 'อื่นๆ').trim() || 'อื่นๆ';
      const unit = String(r[3] || 'ชิ้น').trim() || 'ชิ้น';
      const price = parseFloat(r[4]) || 0;
      const stock = parseFloat(r[5]) || 0;
      const exists = products.some(p => p.code === code);
      try {
        if (exists) {
          // Master-data fields only — never clobber live stock with a bulk import.
          if (apiAvailable) await apiUpdate('products', code, { name, category, unit, price });
          else { const idx = products.findIndex(p => p.code === code); if (idx > -1) products[idx] = { ...products[idx], name, category, unit, price }; }
          updated++;
        } else {
          const payload = { name, category, unit, price, stock };
          if (apiAvailable) await apiSet('products', code, payload);
          else products.push({ code, ...payload });
          created++;
        }
      } catch (e) { skipped++; }
    }
    if (apiAvailable) await loadProducts_();
    render();
    showToast(`นำเข้าสำเร็จ: เพิ่มใหม่ ${created} รายการ, อัปเดต ${updated} รายการ` + (skipped ? `, ข้าม ${skipped} แถว` : ''));
  }

  function renderProductImportBox() {
    const box = el('div', { class: 'add-form import-box' });
    box.appendChild(el('div', { style: 'font-weight:700;margin-bottom:4px;font-size:.85rem;' }, [txt('นำเข้า/อัปเดตสินค้าจากไฟล์ CSV หรือ Excel')]));
    box.appendChild(el('div', { style: 'font-size:.74rem;color:var(--text-dim);margin-bottom:8px;line-height:1.6;' }, [
      txt('แถวแรกต้องเป็นหัวตาราง ลำดับคอลัมน์: '), el('b', {}, [txt('รหัสสินค้า, ชื่อสินค้า, หมวดหมู่, หน่วย, ราคา/หน่วย, จำนวนเริ่มต้น')]),
      txt(' — ถ้ารหัสสินค้าซ้ำกับที่มีอยู่แล้ว ระบบจะอัปเดตชื่อ/หมวดหมู่/หน่วย/ราคาให้ (ไม่แตะจำนวนคงเหลือปัจจุบัน) ถ้าเป็นรหัสใหม่จะสร้างสินค้าใหม่พร้อมจำนวนเริ่มต้นตามไฟล์')
    ]));
    box.appendChild(el('button', { class: 'btn ghost sm', style: 'margin-bottom:8px;', onclick: downloadProductImportTemplate }, [txt('⬇ ดาวน์โหลดแม่แบบ (Excel)')]));
    const fileIn = el('input', { type: 'file', accept: '.csv,.xlsx,.xls,text/csv', style: 'display:block;margin-bottom:4px;' });
    fileIn.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) bulkImportProducts(f);
      fileIn.value = '';
    });
    box.appendChild(fileIn);
    return box;
  }

  function renderWarehouseList() {
    const wrap = document.getElementById('whListWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const q = state.whSearch.trim().toLowerCase();
    let list = products.slice().sort((a, b) => a.name.localeCompare(b.name, 'th'));
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.code.includes(q));
    if (!list.length) { wrap.appendChild(el('div', { class: 'empty-note' }, [txt('ไม่พบสินค้า')])); return; }

    list.forEach(p => {
      const row = el('div', { class: 'wh-row' });
      if (state.whEditCode === p.code) {
        const thumbSrcEdit = productImageSrc(p);
        const editThumbRow = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:4px;' }, [
          thumbSrcEdit ? el('img', { class: 'prod-thumb-lg', src: thumbSrcEdit, alt: p.name }) : el('div', { class: 'prod-thumb-ph-lg' }, [txt('📦')]),
          imagePickerButton(p.code, thumbSrcEdit ? '🖼 เปลี่ยนรูป' : '🖼 เพิ่มรูป', 'btn ghost sm')
        ]);
        if (thumbSrcEdit) editThumbRow.appendChild(el('button', { class: 'btn danger sm', onclick: () => removeProductImage(p.code) }, [txt('ลบรูป')]));
        row.appendChild(editThumbRow);
        const grid = el('div', { class: 'edit-grid' });
        const codeIn = el('input', { type: 'text', value: p.code });
        const nameIn = el('input', { type: 'text', value: p.name });
        const catIn = el('input', { type: 'text', value: p.category });
        const unitIn = el('input', { type: 'text', value: p.unit });
        const priceIn = el('input', { type: 'number', step: '0.01', value: p.price });
        const stockIn = el('input', { type: 'number', step: '1', value: p.stock, title: 'ปรับยอดคงเหลือตรงๆ — ใช้สำหรับตรวจนับสต๊อกจริง/ของชำรุด/ของหาย ไม่ผ่านขั้นตอนเบิก-เติม' });
        [codeIn, nameIn, catIn, unitIn, priceIn, stockIn].forEach(i => grid.appendChild(i));
        row.appendChild(grid);
        row.appendChild(el('div', { style: 'font-size:.72rem;color:var(--text-dim);margin:-4px 0 8px;' }, [txt('ช่องสุดท้าย = คงเหลือ (แก้ตรงนี้เพื่อปรับยอดตามการตรวจนับจริง/ของชำรุด-สูญหาย โดยไม่ต้องผ่านขั้นตอนเบิก-เติมสต๊อก)')]));
        const btnRow = el('div', { style: 'display:flex;gap:8px;' }, [
          el('button', { class: 'btn success sm', onclick: () => saveProductEdit(p.code, { code: codeIn.value, name: nameIn.value, category: catIn.value, unit: unitIn.value, price: priceIn.value, stock: stockIn.value }) }, [txt('บันทึก')]),
          el('button', { class: 'btn ghost sm', onclick: () => { state.whEditCode = null; render(); } }, [txt('ยกเลิก')])
        ]);
        row.appendChild(btnRow);
      } else {
        const stockClass = p.stock <= 0 ? 'zero' : (p.stock <= 5 ? 'low' : 'ok');
        const thumbSrc = productImageSrc(p);
        const thumb = thumbSrc ? el('img', { class: 'prod-thumb-lg', src: thumbSrc, alt: p.name }) : el('div', { class: 'prod-thumb-ph-lg' }, [txt('📦')]);
        const top = el('div', { class: 'top-line' }, [
          thumb,
          el('div', { style: 'flex:1;min-width:160px;' }, [
            el('div', { class: 'p-name' }, [txt(p.name + '  ')]),
            el('div', { class: 'p-meta' }, [txt('รหัส ' + p.code + ' • ' + p.category + ' • ' + p.unit + ' • ' + fmtMoney(p.price) + ' บาท/' + p.unit)]),
            el('div', { class: 'p-stock ' + stockClass }, [txt('คงเหลือ: ' + fmt(p.stock) + ' ' + p.unit)])
          ])
        ]);
        if (isAdmin()) {
          const btnBox = el('div', { style: 'display:flex;gap:6px;flex-shrink:0;' }, [
            el('button', { class: 'btn ghost sm', onclick: () => { state.whEditCode = p.code; render(); } }, [txt('แก้ไข')]),
            el('button', { class: 'btn danger sm', onclick: () => { state.whConfirmDelete = state.whConfirmDelete === p.code ? null : p.code; render(); } }, [txt('ลบ')])
          ]);
          top.appendChild(btnBox);
        }
        row.appendChild(top);
        if (isAdmin()) {
          const imgCtrls = el('div', { class: 'img-controls' }, [
            imagePickerButton(p.code, thumbSrc ? '🖼 เปลี่ยนรูป' : '🖼 เพิ่มรูป', 'btn ghost sm')
          ]);
          if (thumbSrc) imgCtrls.appendChild(el('button', { class: 'btn danger sm', onclick: () => removeProductImage(p.code) }, [txt('ลบรูป')]));
          row.appendChild(imgCtrls);
        }
        if (state.whConfirmDelete === p.code) {
          row.appendChild(el('div', { class: 'confirm-box' }, [
            txt('ยืนยันการลบสินค้านี้หรือไม่?'),
            el('button', { class: 'btn danger sm', onclick: () => deleteProduct(p.code) }, [txt('ยืนยันลบ')]),
            el('button', { class: 'btn ghost sm', onclick: () => { state.whConfirmDelete = null; render(); } }, [txt('ยกเลิก')])
          ]));
        }
      }
      wrap.appendChild(row);
    });
  }

  // ---------- Simple SVG chart helpers ----------
  function svgEl(tag, attrs) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(k => e.setAttribute(k, attrs[k]));
    return e;
  }
  function chartCard(titleText, chartNode, emptyText) {
    const box = el('div', { class: 'card' });
    box.appendChild(el('div', { style: 'font-weight:800;margin-bottom:10px;font-size:.92rem;color:var(--navy);' }, [txt(titleText)]));
    if (chartNode) box.appendChild(chartNode);
    else box.appendChild(el('div', { class: 'empty-note' }, [txt(emptyText || 'ยังไม่มีข้อมูล')]));
    return box;
  }
  function buildHorizontalBarChart(data, opts) {
    opts = opts || {};
    if (!data.length) return null;
    const rowH = 24, gap = 10, topPad = 6, labelW = opts.labelWidth || 150, width = 640;
    const barAreaW = width - labelW - 78;
    const height = topPad * 2 + data.length * (rowH + gap) - gap;
    const maxVal = Math.max(1, ...data.map(d => d.value));
    const svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, width: '100%', height: height, style: 'display:block;overflow:visible;' });
    data.forEach((d, i) => {
      const y = topPad + i * (rowH + gap);
      const label = svgEl('text', { x: 0, y: y + rowH / 2 + 4, 'font-size': '11' });
      label.style.fill = 'var(--text)';
      label.textContent = d.label.length > 24 ? d.label.slice(0, 23) + '…' : d.label;
      svg.appendChild(label);
      const track = svgEl('rect', { x: labelW, y, width: barAreaW, height: rowH, rx: 6 });
      track.style.fill = 'var(--surface-2)';
      svg.appendChild(track);
      const barW = maxVal ? (d.value / maxVal) * barAreaW : 0;
      const bar = svgEl('rect', { x: labelW, y, width: Math.max(barW, d.value > 0 ? 3 : 0), height: rowH, rx: 6 });
      bar.style.fill = opts.color || 'var(--navy)';
      svg.appendChild(bar);
      const valText = svgEl('text', { x: labelW + barAreaW + 8, y: y + rowH / 2 + 4, 'font-size': '11', 'font-weight': '700' });
      valText.style.fill = 'var(--text-dim)';
      valText.textContent = opts.fmt ? opts.fmt(d.value) : String(d.value);
      svg.appendChild(valText);
    });
    return svg;
  }
  function buildVerticalBarChart(data, opts) {
    opts = opts || {};
    if (!data.length) return null;
    const width = 640, height = 260, pad = { top: 26, right: 16, bottom: 56, left: 16 };
    const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
    const gap = 18;
    const barW = Math.max(18, innerW / data.length - gap);
    const maxVal = Math.max(1, ...data.map(d => d.value));
    const svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, width: '100%', height: height, style: 'display:block;overflow:visible;' });
    const axis = svgEl('line', { x1: pad.left, y1: pad.top + innerH, x2: pad.left + innerW, y2: pad.top + innerH, 'stroke-width': 1 });
    axis.style.stroke = 'var(--border)';
    svg.appendChild(axis);
    data.forEach((d, i) => {
      const barH = maxVal ? (d.value / maxVal) * innerH : 0;
      const x = pad.left + i * (innerW / data.length) + ((innerW / data.length) - barW) / 2;
      const y = pad.top + innerH - barH;
      const rect = svgEl('rect', { x, y, width: barW, height: Math.max(barH, d.value > 0 ? 2 : 0), rx: 5 });
      rect.style.fill = opts.color || 'var(--navy)';
      svg.appendChild(rect);
      const vt = svgEl('text', { x: x + barW / 2, y: y - 7, 'text-anchor': 'middle', 'font-size': '10', 'font-weight': '700' });
      vt.style.fill = 'var(--text)';
      vt.textContent = opts.fmt ? opts.fmt(d.value) : String(d.value);
      svg.appendChild(vt);
      const lt = svgEl('text', { x: x + barW / 2, y: pad.top + innerH + 18, 'text-anchor': 'middle', 'font-size': '10' });
      lt.style.fill = 'var(--text-dim)';
      lt.textContent = d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label;
      svg.appendChild(lt);
    });
    return svg;
  }

  // ---------- Report: luxury (per product/category) ----------
  function buildLuxuryReport() {
    const map = {};
    products.forEach(p => {
      map[p.code] = { code: p.code, name: p.name, category: p.category, unit: p.unit, price: p.price, restockQty: 0, restockAmt: 0, withdrawQty: 0, withdrawAmt: 0, stock: p.stock };
    });
    history.forEach(h => {
      if (!inRange(h.ts) || !isFulfilled_(h)) return;
      (h.items || []).forEach(it => {
        if (!map[it.code]) map[it.code] = { code: it.code, name: it.name, category: it.category, unit: it.unit, price: it.price, restockQty: 0, restockAmt: 0, withdrawQty: 0, withdrawAmt: 0, stock: 0 };
        if (h.type === 'เติมสต๊อก') { map[it.code].restockQty += it.qty; map[it.code].restockAmt += it.subtotal; }
        else { map[it.code].withdrawQty += it.qty; map[it.code].withdrawAmt += it.subtotal; }
      });
    });
    const rows = Object.values(map);
    const byCat = {};
    rows.forEach(r => { (byCat[r.category] = byCat[r.category] || []).push(r); });
    return byCat;
  }

  function renderReportLuxury(app) {
    const card = el('div', { class: 'card' });
    const controls = el('div', { class: 'grid-controls' });
    controls.appendChild(dateField('reportFrom', 'จากวันที่'));
    controls.appendChild(dateField('reportTo', 'ถึงวันที่'));
    if (isAdmin()) {
      const f = el('div', { class: 'field small' }, [el('label', {}, [txt('\u00A0')])]);
      f.appendChild(el('button', { class: 'btn ghost', onclick: exportLuxuryCSV }, [txt('⬇ CSV')]));
      f.appendChild(el('button', { class: 'btn ghost', style: 'margin-left:6px;', onclick: exportLuxuryXLSX }, [txt('⬇ Excel')]));
      controls.appendChild(f);
    }
    card.appendChild(controls);

    const byCat = buildLuxuryReport();
    const cats = Object.keys(byCat).sort();
    let grandRestockAmt = 0, grandWithdrawAmt = 0, grandStockVal = 0;

    const tableWrap = el('div', { style: 'overflow-x:auto' });
    const table = el('table', { class: 'rep' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', {}, [txt('รายการสินค้า')]), el('th', {}, [txt('หน่วย')]),
      el('th', {}, [txt('ราคา/หน่วย')]),
      el('th', {}, [txt('เติมสต๊อก (จำนวน)')]), el('th', {}, [txt('เติมสต๊อก (บาท)')]),
      el('th', {}, [txt('เบิกใช้ (จำนวน)')]), el('th', {}, [txt('เบิกใช้ (บาท)')]),
      el('th', {}, [txt('คงเหลือ')]), el('th', {}, [txt('มูลค่าคงเหลือ')])
    ])]));
    const tbody = el('tbody');
    cats.forEach(cat => {
      const items = byCat[cat].sort((a, b) => a.name.localeCompare(b.name, 'th'));
      let catRestockAmt = 0, catWithdrawAmt = 0, catStockVal = 0;
      items.forEach(r => {
        const stockVal = r.stock * r.price;
        catRestockAmt += r.restockAmt; catWithdrawAmt += r.withdrawAmt; catStockVal += stockVal;
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [txt(r.name)]), el('td', {}, [txt(r.unit)]),
          el('td', { class: 'num' }, [txt(fmtMoney(r.price))]),
          el('td', { class: 'num' }, [txt(fmt(r.restockQty))]), el('td', { class: 'num' }, [txt(fmtMoney(r.restockAmt))]),
          el('td', { class: 'num' }, [txt(fmt(r.withdrawQty))]), el('td', { class: 'num' }, [txt(fmtMoney(r.withdrawAmt))]),
          el('td', { class: 'num' }, [txt(fmt(r.stock))]), el('td', { class: 'num' }, [txt(fmtMoney(stockVal))])
        ]));
      });
      tbody.appendChild(el('tr', { class: 'subtotal' }, [
        el('td', { colspan: '4' }, [txt('รวม ' + cat)]), el('td', { class: 'num' }, [txt(fmtMoney(catRestockAmt))]),
        el('td', {}, [txt('')]), el('td', { class: 'num' }, [txt(fmtMoney(catWithdrawAmt))]),
        el('td', {}, [txt('')]), el('td', { class: 'num' }, [txt(fmtMoney(catStockVal))])
      ]));
      grandRestockAmt += catRestockAmt; grandWithdrawAmt += catWithdrawAmt; grandStockVal += catStockVal;
    });
    tbody.appendChild(el('tr', { class: 'grandtotal' }, [
      el('td', { colspan: '4' }, [txt('รวมทั้งหมด')]), el('td', { class: 'num' }, [txt(fmtMoney(grandRestockAmt))]),
      el('td', {}, [txt('')]), el('td', { class: 'num' }, [txt(fmtMoney(grandWithdrawAmt))]),
      el('td', {}, [txt('')]), el('td', { class: 'num' }, [txt(fmtMoney(grandStockVal))])
    ]));
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    card.appendChild(tableWrap);
    app.appendChild(card);
  }

  function exportLuxuryCSV() {
    const byCat = buildLuxuryReport();
    const rows = [['หมวดหมู่', 'รหัสสินค้า', 'รายการสินค้า', 'หน่วย', 'ราคา/หน่วย', 'เติมสต๊อก(จำนวน)', 'เติมสต๊อก(บาท)', 'เบิกใช้(จำนวน)', 'เบิกใช้(บาท)', 'คงเหลือ', 'มูลค่าคงเหลือ']];
    Object.keys(byCat).sort().forEach(cat => {
      byCat[cat].forEach(r => {
        rows.push([cat, r.code, r.name, r.unit, r.price, r.restockQty, r.restockAmt, r.withdrawQty, r.withdrawAmt, r.stock, r.stock * r.price]);
      });
    });
    downloadCSV('รายงานค่าใช้จ่ายฟุ่มเฟือย.csv', rows);
  }

  function exportLuxuryXLSX() {
    const byCat = buildLuxuryReport();
    const rows = [['หมวดหมู่', 'รหัสสินค้า', 'รายการสินค้า', 'หน่วย', 'ราคา/หน่วย', 'เติมสต๊อก(จำนวน)', 'เติมสต๊อก(บาท)', 'เบิกใช้(จำนวน)', 'เบิกใช้(บาท)', 'คงเหลือ', 'มูลค่าคงเหลือ']];
    Object.keys(byCat).sort().forEach(cat => {
      byCat[cat].forEach(r => {
        rows.push([cat, r.code, r.name, r.unit, r.price, r.restockQty, r.restockAmt, r.withdrawQty, r.withdrawAmt, r.stock, r.stock * r.price]);
      });
    });
    downloadXLSX('รายงานค่าใช้จ่ายฟุ่มเฟือย.xlsx', { 'ฟุ่มเฟือย': rows });
  }

  // ---------- Report: withdraw (เบิกของ) ----------
  function buildWithdrawReport() {
    const map = {};
    const deptSet = new Set();
    history.forEach(h => {
      if (h.type !== 'เบิกของ') return;
      if (!inRange(h.ts) || !isFulfilled_(h)) return;
      if (h.deptCode) deptSet.add(h.deptCode);
      (h.items || []).forEach(it => {
        if (!map[it.code]) map[it.code] = { code: it.code, name: it.name, category: it.category, unit: it.unit, price: it.price, qty: 0, amount: 0 };
        map[it.code].qty += it.qty;
        map[it.code].amount += it.subtotal;
      });
    });
    const rows = Object.values(map);
    const byCat = {};
    rows.forEach(r => { (byCat[r.category] = byCat[r.category] || []).push(r); });
    const txCount = history.filter(h => h.type === 'เบิกของ' && inRange(h.ts) && isFulfilled_(h)).length;
    return { byCat, txCount, deptCount: deptSet.size };
  }

  function renderReportWithdraw(app) {
    const controlsCard = el('div', { class: 'card' });
    const controls = el('div', { class: 'grid-controls' });
    controls.appendChild(dateField('reportFrom', 'จากวันที่'));
    controls.appendChild(dateField('reportTo', 'ถึงวันที่'));
    if (isAdmin()) {
      const f = el('div', { class: 'field small' }, [el('label', {}, [txt('\u00A0')])]);
      f.appendChild(el('button', { class: 'btn ghost', onclick: exportWithdrawCSV }, [txt('⬇ CSV')]));
      f.appendChild(el('button', { class: 'btn ghost', style: 'margin-left:6px;', onclick: exportWithdrawXLSX }, [txt('⬇ Excel')]));
      controls.appendChild(f);
    }
    controlsCard.appendChild(controls);
    app.appendChild(controlsCard);

    const { byCat, txCount, deptCount } = buildWithdrawReport();
    const cats = Object.keys(byCat).sort();
    let grandQty = 0, grandAmt = 0;
    const catTotals = cats.map(cat => {
      const amt = byCat[cat].reduce((s, r) => s + r.amount, 0);
      grandAmt += amt;
      grandQty += byCat[cat].reduce((s, r) => s + r.qty, 0);
      return { label: cat, value: amt };
    }).sort((a, b) => b.value - a.value);

    app.appendChild(el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('มูลค่าเบิกใช้รวม')]), el('div', { class: 'val', style: 'color:var(--red)' }, [txt(fmtMoney(grandAmt) + ' บ.')])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนหน่วยที่เบิกรวม')]), el('div', { class: 'val' }, [txt(fmt(grandQty))])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนครั้งที่เบิก')]), el('div', { class: 'val' }, [txt(String(txCount))])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนแผนกที่เบิก')]), el('div', { class: 'val' }, [txt(String(deptCount))])])
    ]));
    app.appendChild(chartCard('กราฟสรุปมูลค่าการเบิกใช้ตามหมวดหมู่', buildVerticalBarChart(catTotals, { fmt: v => fmtMoney(v), color: 'var(--red)' }), 'ยังไม่มีข้อมูลการเบิกในช่วงเวลาที่เลือก'));

    const tableCard = el('div', { class: 'card' });
    const tableWrap = el('div', { style: 'overflow-x:auto' });
    const table = el('table', { class: 'rep' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', {}, [txt('รายการสินค้า')]), el('th', {}, [txt('หน่วย')]), el('th', {}, [txt('ราคา/หน่วย')]),
      el('th', {}, [txt('จำนวนที่เบิก')]), el('th', {}, [txt('มูลค่า (บาท)')])
    ])]));
    const tbody = el('tbody');
    cats.forEach(cat => {
      const items = byCat[cat].slice().sort((a, b) => b.amount - a.amount);
      let catQty = 0, catAmt = 0;
      items.forEach(r => {
        catQty += r.qty; catAmt += r.amount;
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [txt(r.name)]), el('td', {}, [txt(r.unit)]), el('td', { class: 'num' }, [txt(fmtMoney(r.price))]),
          el('td', { class: 'num' }, [txt(fmt(r.qty))]), el('td', { class: 'num' }, [txt(fmtMoney(r.amount))])
        ]));
      });
      tbody.appendChild(el('tr', { class: 'subtotal' }, [
        el('td', { colspan: '3' }, [txt('รวม ' + cat)]), el('td', { class: 'num' }, [txt(fmt(catQty))]), el('td', { class: 'num' }, [txt(fmtMoney(catAmt))])
      ]));
    });
    if (!cats.length) {
      tbody.appendChild(el('tr', {}, [el('td', { colspan: '5' }, [el('div', { class: 'empty-note' }, [txt('ยังไม่มีข้อมูลการเบิกในช่วงเวลาที่เลือก')])])]));
    } else {
      tbody.appendChild(el('tr', { class: 'grandtotal' }, [el('td', { colspan: '3' }, [txt('รวมทั้งหมด')]), el('td', { class: 'num' }, [txt(fmt(grandQty))]), el('td', { class: 'num' }, [txt(fmtMoney(grandAmt))])]));
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    tableCard.appendChild(tableWrap);
    app.appendChild(tableCard);
  }

  function exportWithdrawCSV() {
    const { byCat } = buildWithdrawReport();
    const rows = [['หมวดหมู่', 'รหัสสินค้า', 'รายการสินค้า', 'หน่วย', 'ราคา/หน่วย', 'จำนวนที่เบิก', 'มูลค่า']];
    Object.keys(byCat).sort().forEach(cat => {
      byCat[cat].forEach(r => rows.push([cat, r.code, r.name, r.unit, r.price, r.qty, r.amount]));
    });
    downloadCSV('รายงานการเบิก.csv', rows);
  }

  function exportWithdrawXLSX() {
    const { byCat } = buildWithdrawReport();
    const rows = [['หมวดหมู่', 'รหัสสินค้า', 'รายการสินค้า', 'หน่วย', 'ราคา/หน่วย', 'จำนวนที่เบิก', 'มูลค่า']];
    Object.keys(byCat).sort().forEach(cat => {
      byCat[cat].forEach(r => rows.push([cat, r.code, r.name, r.unit, r.price, r.qty, r.amount]));
    });
    downloadXLSX('รายงานการเบิก.xlsx', { 'รายงานการเบิก': rows });
  }

  // ---------- Report: restock (เติมสต๊อก) ----------
  function buildRestockReport() {
    const map = {};
    history.forEach(h => {
      if (h.type !== 'เติมสต๊อก') return;
      if (!inRange(h.ts)) return;
      (h.items || []).forEach(it => {
        if (!map[it.code]) map[it.code] = { code: it.code, name: it.name, category: it.category, unit: it.unit, price: it.price, qty: 0, amount: 0 };
        map[it.code].qty += it.qty;
        map[it.code].amount += it.subtotal;
      });
    });
    const rows = Object.values(map);
    const byCat = {};
    rows.forEach(r => { (byCat[r.category] = byCat[r.category] || []).push(r); });
    const txCount = history.filter(h => h.type === 'เติมสต๊อก' && inRange(h.ts)).length;
    return { byCat, txCount };
  }

  function renderReportRestock(app) {
    const controlsCard = el('div', { class: 'card' });
    const controls = el('div', { class: 'grid-controls' });
    controls.appendChild(dateField('reportFrom', 'จากวันที่'));
    controls.appendChild(dateField('reportTo', 'ถึงวันที่'));
    if (isAdmin()) {
      const f = el('div', { class: 'field small' }, [el('label', {}, [txt('\u00A0')])]);
      f.appendChild(el('button', { class: 'btn ghost', onclick: exportRestockCSV }, [txt('⬇ CSV')]));
      f.appendChild(el('button', { class: 'btn ghost', style: 'margin-left:6px;', onclick: exportRestockXLSX }, [txt('⬇ Excel')]));
      controls.appendChild(f);
    }
    controlsCard.appendChild(controls);
    app.appendChild(controlsCard);

    const { byCat, txCount } = buildRestockReport();
    const cats = Object.keys(byCat).sort();
    let grandQty = 0, grandAmt = 0;
    const catTotals = cats.map(cat => {
      const amt = byCat[cat].reduce((s, r) => s + r.amount, 0);
      grandAmt += amt;
      grandQty += byCat[cat].reduce((s, r) => s + r.qty, 0);
      return { label: cat, value: amt };
    }).sort((a, b) => b.value - a.value);

    app.appendChild(el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('มูลค่าเติมสต๊อกรวม')]), el('div', { class: 'val', style: 'color:var(--success)' }, [txt(fmtMoney(grandAmt) + ' บ.')])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนหน่วยที่เติมรวม')]), el('div', { class: 'val' }, [txt(fmt(grandQty))])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนครั้งที่เติมสต๊อก')]), el('div', { class: 'val' }, [txt(String(txCount))])])
    ]));
    app.appendChild(chartCard('กราฟสรุปมูลค่าการเติมสต๊อกตามหมวดหมู่', buildVerticalBarChart(catTotals, { fmt: v => fmtMoney(v), color: 'var(--success)' }), 'ยังไม่มีข้อมูลการเติมสต๊อกในช่วงเวลาที่เลือก'));

    const tableCard = el('div', { class: 'card' });
    const tableWrap = el('div', { style: 'overflow-x:auto' });
    const table = el('table', { class: 'rep' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', {}, [txt('รายการสินค้า')]), el('th', {}, [txt('หน่วย')]), el('th', {}, [txt('ราคา/หน่วย')]),
      el('th', {}, [txt('จำนวนที่เติม')]), el('th', {}, [txt('มูลค่า (บาท)')])
    ])]));
    const tbody = el('tbody');
    cats.forEach(cat => {
      const items = byCat[cat].sort((a, b) => a.name.localeCompare(b.name, 'th'));
      let catQty = 0, catAmt = 0;
      items.forEach(r => {
        catQty += r.qty; catAmt += r.amount;
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [txt(r.name)]), el('td', {}, [txt(r.unit)]), el('td', { class: 'num' }, [txt(fmtMoney(r.price))]),
          el('td', { class: 'num' }, [txt(fmt(r.qty))]), el('td', { class: 'num' }, [txt(fmtMoney(r.amount))])
        ]));
      });
      tbody.appendChild(el('tr', { class: 'subtotal' }, [
        el('td', { colspan: '3' }, [txt('รวม ' + cat)]), el('td', { class: 'num' }, [txt(fmt(catQty))]), el('td', { class: 'num' }, [txt(fmtMoney(catAmt))])
      ]));
    });
    if (!cats.length) {
      tbody.appendChild(el('tr', {}, [el('td', { colspan: '5' }, [el('div', { class: 'empty-note' }, [txt('ยังไม่มีข้อมูลการเติมสต๊อกในช่วงเวลาที่เลือก')])])]));
    } else {
      tbody.appendChild(el('tr', { class: 'grandtotal' }, [el('td', { colspan: '3' }, [txt('รวมทั้งหมด')]), el('td', { class: 'num' }, [txt(fmt(grandQty))]), el('td', { class: 'num' }, [txt(fmtMoney(grandAmt))])]));
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    tableCard.appendChild(tableWrap);
    app.appendChild(tableCard);
  }

  function exportRestockCSV() {
    const { byCat } = buildRestockReport();
    const rows = [['หมวดหมู่', 'รหัสสินค้า', 'รายการสินค้า', 'หน่วย', 'ราคา/หน่วย', 'จำนวนที่เติม', 'มูลค่า']];
    Object.keys(byCat).sort().forEach(cat => {
      byCat[cat].forEach(r => rows.push([cat, r.code, r.name, r.unit, r.price, r.qty, r.amount]));
    });
    downloadCSV('รายงานการเติมสต๊อก.csv', rows);
  }

  function exportRestockXLSX() {
    const { byCat } = buildRestockReport();
    const rows = [['หมวดหมู่', 'รหัสสินค้า', 'รายการสินค้า', 'หน่วย', 'ราคา/หน่วย', 'จำนวนที่เติม', 'มูลค่า']];
    Object.keys(byCat).sort().forEach(cat => {
      byCat[cat].forEach(r => rows.push([cat, r.code, r.name, r.unit, r.price, r.qty, r.amount]));
    });
    downloadXLSX('รายงานการเติมสต๊อก.xlsx', { 'เติมสต๊อก': rows });
  }

  function dateField(key, labelText) {
    const f = el('div', { class: 'field small' });
    f.appendChild(el('label', {}, [txt(labelText)]));
    const input = el('input', { type: 'date', value: state[key] });
    input.addEventListener('change', (e) => { state[key] = e.target.value; render(); });
    f.appendChild(input);
    return f;
  }

  // ---------- Report: by department ----------
  function buildDeptReport() {
    const map = {};
    DEPTS.forEach(d => { map[d.code] = { code: d.code, name: d.name, total: 0, count: 0, items: {}, byCategory: {} }; });
    history.forEach(h => {
      if (h.type !== 'เบิกของ') return;
      if (!inRange(h.ts) || !isFulfilled_(h)) return;
      if (!map[h.deptCode]) map[h.deptCode] = { code: h.deptCode, name: h.deptName || h.deptCode, total: 0, count: 0, items: {}, byCategory: {} };
      const bucket = map[h.deptCode];
      bucket.total += h.total || 0;
      bucket.count += 1;
      (h.items || []).forEach(it => {
        const key = it.code;
        if (!bucket.items[key]) bucket.items[key] = { name: it.name, unit: it.unit, category: it.category, qty: 0, amount: 0 };
        bucket.items[key].qty += it.qty;
        bucket.items[key].amount += it.subtotal;
        bucket.byCategory[it.category] = (bucket.byCategory[it.category] || 0) + it.subtotal;
      });
    });
    return map;
  }

  function renderDeptCategoryMatrix(app, map) {
    const cats = categories().filter(c => c !== 'ทั้งหมด').sort();
    const rows = Object.values(map).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
    const box = el('div', { class: 'card' });
    box.appendChild(el('div', { style: 'font-weight:800;margin-bottom:4px;font-size:.92rem;color:var(--navy);' }, [txt('ตารางเปรียบเทียบการใช้สินค้าแต่ละหมวดหมู่ต่อแผนก (บาท)')]));
    box.appendChild(el('div', { style: 'font-size:.76rem;color:var(--text-dim);margin-bottom:10px;' }, [txt('ช่องที่ไฮไลต์ คือหมวดหมู่ที่แผนกนั้นใช้จ่ายสูงสุด — ช่วยมอนิเตอร์พฤติกรรมการเบิกใช้ของแต่ละแผนก')]));
    if (isAdmin()) {
      box.appendChild(el('button', { class: 'btn ghost sm', style: 'margin-bottom:10px;', onclick: () => exportDeptCategoryCSV(map, cats) }, [txt('⬇ ตาราง CSV')]));
      box.appendChild(el('button', { class: 'btn ghost sm', style: 'margin-bottom:10px;margin-left:6px;', onclick: () => exportDeptCategoryXLSX(map, cats) }, [txt('⬇ ตาราง Excel')]));
    }
    if (!rows.length) { box.appendChild(el('div', { class: 'empty-note' }, [txt('ไม่มีข้อมูลในช่วงเวลาที่เลือก')])); app.appendChild(box); return; }

    const wrap = el('div', { style: 'overflow-x:auto' });
    const table = el('table', { class: 'rep' });
    const headRow = el('tr', {}, [el('th', {}, [txt('แผนก')])].concat(cats.map(c => el('th', { class: 'num' }, [txt(c)]))).concat([el('th', { class: 'num' }, [txt('รวม')])]));
    table.appendChild(el('thead', {}, [headRow]));
    const tbody = el('tbody');
    const catGrand = {}; cats.forEach(c => { catGrand[c] = 0; });
    let grandAll = 0;
    rows.forEach(r => {
      let maxCat = null, maxVal = 0;
      cats.forEach(c => { const v = r.byCategory[c] || 0; if (v > maxVal) { maxVal = v; maxCat = c; } });
      const tds = [el('td', {}, [txt(r.name)])];
      cats.forEach(c => {
        const v = r.byCategory[c] || 0;
        catGrand[c] += v;
        const td = el('td', { class: 'num' }, [txt(v ? fmtMoney(v) : '-')]);
        if (c === maxCat && v > 0) td.setAttribute('style', 'background:var(--navy-dim);font-weight:800;color:var(--navy);');
        tds.push(td);
      });
      tds.push(el('td', { class: 'num', style: 'font-weight:800;' }, [txt(fmtMoney(r.total))]));
      grandAll += r.total;
      tbody.appendChild(el('tr', {}, tds));
    });
    const footTds = [el('td', {}, [txt('รวมทั้งหมด')])].concat(cats.map(c => el('td', { class: 'num' }, [txt(fmtMoney(catGrand[c]))]))).concat([el('td', { class: 'num' }, [txt(fmtMoney(grandAll))])]);
    tbody.appendChild(el('tr', { class: 'grandtotal' }, footTds));
    table.appendChild(tbody);
    wrap.appendChild(table);
    box.appendChild(wrap);
    app.appendChild(box);
  }

  function exportDeptCategoryCSV(map, cats) {
    const rows = [['รหัสแผนก', 'แผนก'].concat(cats).concat(['รวม'])];
    Object.values(map).filter(r => r.total > 0).sort((a, b) => b.total - a.total).forEach(r => {
      rows.push([r.code, r.name].concat(cats.map(c => r.byCategory[c] || 0)).concat([r.total]));
    });
    downloadCSV('รายงานหมวดหมู่รายแผนก.csv', rows);
  }

  function exportDeptCategoryXLSX(map, cats) {
    const rows = [['รหัสแผนก', 'แผนก'].concat(cats).concat(['รวม'])];
    Object.values(map).filter(r => r.total > 0).sort((a, b) => b.total - a.total).forEach(r => {
      rows.push([r.code, r.name].concat(cats.map(c => r.byCategory[c] || 0)).concat([r.total]));
    });
    downloadXLSX('รายงานหมวดหมู่รายแผนก.xlsx', { 'หมวดหมู่รายแผนก': rows });
  }

  function renderReportDept(app) {
    const card = el('div', { class: 'card' });
    const controls = el('div', { class: 'grid-controls' });
    controls.appendChild(dateField('reportFrom', 'จากวันที่'));
    controls.appendChild(dateField('reportTo', 'ถึงวันที่'));
    const deptFilterField = el('div', { class: 'field grow' });
    deptFilterField.appendChild(el('label', {}, [txt('ค้นหาแผนก')]));
    const deptInput = el('input', { type: 'search', placeholder: 'พิมพ์ชื่อแผนก...', value: state.reportDeptFilter });
    deptInput.addEventListener('input', (e) => { state.reportDeptFilter = e.target.value; renderDeptTable(); });
    deptFilterField.appendChild(deptInput);
    controls.appendChild(deptFilterField);
    if (isAdmin()) {
      const f = el('div', { class: 'field small' }, [el('label', {}, [txt('\u00A0')])]);
      f.appendChild(el('button', { class: 'btn ghost', onclick: exportDeptCSV }, [txt('⬇ รายการ CSV')]));
      f.appendChild(el('button', { class: 'btn ghost', style: 'margin-left:6px;', onclick: exportDeptXLSX }, [txt('⬇ รายการ Excel')]));
      controls.appendChild(f);
    }
    card.appendChild(controls);
    app.appendChild(card);

    const map = buildDeptReport();
    const chartRows = Object.values(map).filter(r => r.total > 0).sort((a, b) => b.total - a.total).slice(0, 12)
      .map(r => ({ label: r.name, value: r.total }));
    const totalAll = Object.values(map).reduce((s, r) => s + r.total, 0);
    const statCard = el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('ยอดเบิกรวมทุกแผนก')]), el('div', { class: 'val', style: 'color:var(--red)' }, [txt(fmtMoney(totalAll) + ' บ.')])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนแผนกที่มีการเบิก')]), el('div', { class: 'val' }, [txt(String(Object.values(map).filter(r => r.total > 0).length))])])
    ]);
    app.appendChild(statCard);
    app.appendChild(chartCard('กราฟสรุปค่าใช้จ่ายรายแผนก (สูงสุด 12 แผนก)', buildHorizontalBarChart(chartRows, { fmt: v => fmtMoney(v) + ' บ.', labelWidth: 150 }), 'ไม่มีข้อมูลในช่วงเวลาที่เลือก'));

    renderDeptCategoryMatrix(app, map);

    const tableCard = el('div', { class: 'card' });
    tableCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px;font-size:.92rem;color:var(--navy);' }, [txt('รายละเอียดการเบิกรายแผนก (คลิกแถวเพื่อดูรายการสินค้า)')]));
    const wrap = el('div', { id: 'deptTableWrap', style: 'overflow-x:auto' });
    tableCard.appendChild(wrap);
    app.appendChild(tableCard);
    renderDeptTable();
  }

  function renderDeptTable() {
    const wrap = document.getElementById('deptTableWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const map = buildDeptReport();
    const q = state.reportDeptFilter.trim().toLowerCase();
    let rows = Object.values(map).filter(r => r.total > 0 || r.count > 0);
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
    rows.sort((a, b) => b.total - a.total);

    if (!rows.length) { wrap.appendChild(el('div', { class: 'empty-note' }, [txt('ไม่มีข้อมูลในช่วงเวลาที่เลือก')])); return; }

    const grandTotal = rows.reduce((s, r) => s + r.total, 0);
    const table = el('table', { class: 'rep' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', {}, [txt('แผนก')]), el('th', {}, [txt('รหัสแผนก')]), el('th', {}, [txt('จำนวนครั้งที่เบิก')]), el('th', {}, [txt('ยอดรวม (บาท)')])
    ])]));
    const tbody = el('tbody');
    rows.forEach(r => {
      const tr = el('tr', { class: 'row-expand', onclick: () => { state.expandedDept = state.expandedDept === r.code ? null : r.code; renderDeptTable(); } }, [
        el('td', {}, [txt((state.expandedDept === r.code ? '▾ ' : '▸ ') + r.name)]),
        el('td', {}, [txt(r.code)]),
        el('td', { class: 'num' }, [txt(fmt(r.count))]),
        el('td', { class: 'num' }, [txt(fmtMoney(r.total))])
      ]);
      tbody.appendChild(tr);
      if (state.expandedDept === r.code) {
        const byCat = {};
        Object.values(r.items).forEach(it => { (byCat[it.category || 'อื่นๆ'] = byCat[it.category || 'อื่นๆ'] || []).push(it); });
        const sub = el('tr', { class: 'subrow' });
        const td = el('td', { colspan: '4' });
        const miniTable = el('table', { class: 'rep', style: 'margin:4px 0;' });
        miniTable.appendChild(el('thead', {}, [el('tr', {}, [el('th', {}, [txt('รายการสินค้า')]), el('th', {}, [txt('หมวดหมู่')]), el('th', {}, [txt('จำนวน')]), el('th', {}, [txt('มูลค่า')])])]));
        const miniBody = el('tbody');
        Object.keys(byCat).sort().forEach(cat => {
          const items = byCat[cat].sort((a, b) => b.amount - a.amount);
          items.forEach(it => {
            miniBody.appendChild(el('tr', {}, [el('td', {}, [txt(it.name)]), el('td', { style: 'color:var(--text-dim);font-size:.78rem;' }, [txt(cat)]), el('td', { class: 'num' }, [txt(fmt(it.qty) + ' ' + it.unit)]), el('td', { class: 'num' }, [txt(fmtMoney(it.amount))])]));
          });
        });
        miniTable.appendChild(miniBody);
        td.appendChild(miniTable);
        sub.appendChild(td);
        tbody.appendChild(sub);
      }
    });
    tbody.appendChild(el('tr', { class: 'grandtotal' }, [el('td', { colspan: '3' }, [txt('รวมทั้งหมด')]), el('td', { class: 'num' }, [txt(fmtMoney(grandTotal))])]));
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function exportDeptCSV() {
    const map = buildDeptReport();
    const rows = [['รหัสแผนก', 'แผนก', 'รหัสสินค้า', 'รายการสินค้า', 'จำนวน', 'หน่วย', 'มูลค่า']];
    Object.values(map).forEach(d => {
      Object.keys(d.items).forEach(code => {
        const it = d.items[code];
        rows.push([d.code, d.name, code, it.name, it.qty, it.unit, it.amount]);
      });
    });
    downloadCSV('รายงานค่าใช้จ่ายรายแผนก.csv', rows);
  }

  function exportDeptXLSX() {
    const map = buildDeptReport();
    const rows = [['รหัสแผนก', 'แผนก', 'รหัสสินค้า', 'รายการสินค้า', 'จำนวน', 'หน่วย', 'มูลค่า']];
    Object.values(map).forEach(d => {
      Object.keys(d.items).forEach(code => {
        const it = d.items[code];
        rows.push([d.code, d.name, code, it.name, it.qty, it.unit, it.amount]);
      });
    });
    downloadXLSX('รายงานค่าใช้จ่ายรายแผนก.xlsx', { 'รายแผนก': rows });
  }

  // ---------- History tab ----------
  function renderHistory(app) {
    const card = el('div', { class: 'card' });
    const totalWithdraw = history.filter(h => h.type === 'เบิกของ' && isFulfilled_(h)).reduce((s, h) => s + (h.total || 0), 0);
    const totalRestock = history.filter(h => h.type === 'เติมสต๊อก').reduce((s, h) => s + (h.total || 0), 0);
    const pendingCount = history.filter(h => h.type === 'เบิกของ' && h.status === 'pending').length;
    card.appendChild(el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('จำนวนรายการทั้งหมด')]), el('div', { class: 'val' }, [txt(String(history.length))])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('ยอดเบิกรวม (จ่ายแล้ว)')]), el('div', { class: 'val', style: 'color:var(--red)' }, [txt(fmtMoney(totalWithdraw) + ' บ.')])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('ยอดเติมรวม')]), el('div', { class: 'val', style: 'color:var(--success)' }, [txt(fmtMoney(totalRestock) + ' บ.')])]),
      el('div', { class: 'stat' }, [el('div', { class: 'lbl' }, [txt('รอปล่อยของ')]), el('div', { class: 'val', style: 'color:var(--warn)' }, [txt(String(pendingCount))])])
    ]));

    const filters = el('div', { class: 'grid-controls' });
    const typeField = el('div', { class: 'field' });
    typeField.appendChild(el('label', {}, [txt('ประเภท')]));
    const typeSel = el('select', { onchange: (e) => { state.histFilter = e.target.value; renderHistoryTable(); } });
    [['all', 'ทั้งหมด'], ['withdraw', 'เบิกของ'], ['restock', 'เติมสต๊อก']].forEach(([v, l]) => {
      const o = el('option', { value: v }, [txt(l)]);
      if (v === state.histFilter) o.setAttribute('selected', 'selected');
      typeSel.appendChild(o);
    });
    typeField.appendChild(typeSel);
    filters.appendChild(typeField);

    const deptField = el('div', { class: 'field grow' });
    deptField.appendChild(el('label', {}, [txt('แผนก')]));
    const deptSel = el('select', { onchange: (e) => { state.histDept = e.target.value; renderHistoryTable(); } });
    deptSel.appendChild(el('option', { value: '' }, [txt('ทุกแผนก')]));
    DEPTS.forEach(d => {
      const o = el('option', { value: d.code }, [txt(d.name)]);
      if (d.code === state.histDept) o.setAttribute('selected', 'selected');
      deptSel.appendChild(o);
    });
    deptField.appendChild(deptSel);
    filters.appendChild(deptField);

    const searchField = el('div', { class: 'field grow' });
    searchField.appendChild(el('label', {}, [txt('ค้นหา (ชื่อผู้เบิก / สินค้า)')]));
    const searchInput = el('input', { type: 'search', placeholder: 'พิมพ์เพื่อค้นหา...', value: state.histSearch });
    searchInput.addEventListener('input', (e) => { state.histSearch = e.target.value; renderHistoryTable(); });
    searchField.appendChild(searchInput);
    filters.appendChild(searchField);
    if (isAdmin()) {
      const f = el('div', { class: 'field small' }, [el('label', {}, [txt('\u00A0')])]);
      f.appendChild(el('button', { class: 'btn ghost', onclick: exportHistoryXLSX }, [txt('⬇ Excel')]));
      filters.appendChild(f);
    }
    card.appendChild(filters);

    const tableWrap = el('div', { id: 'histTableWrap', style: 'overflow-x:auto' });
    card.appendChild(tableWrap);
    app.appendChild(card);
    renderHistoryTable();
  }

  function filteredHistoryList_() {
    let list = history.slice();
    if (state.histFilter === 'withdraw') list = list.filter(h => h.type === 'เบิกของ');
    if (state.histFilter === 'restock') list = list.filter(h => h.type === 'เติมสต๊อก');
    if (state.histDept) list = list.filter(h => h.deptCode === state.histDept);
    const q = state.histSearch.trim().toLowerCase();
    if (q) list = list.filter(h => (h.requester || '').toLowerCase().includes(q) || (h.items || []).some(it => it.name.toLowerCase().includes(q)));
    return list;
  }

  function exportHistoryXLSX() {
    const list = filteredHistoryList_();
    const rows = [['วันที่', 'ประเภท', 'แผนก', 'ผู้เบิก/ผู้ทำรายการ', 'รหัสพนักงาน', 'รายการสินค้า', 'จำนวน', 'มูลค่า', 'ยอดรวมทั้งใบ']];
    list.forEach(h => {
      (h.items || []).forEach(it => {
        rows.push([fmtDate(h.ts), h.type, h.deptName || '-', h.requester || '-', h.employeeId || '', it.name, it.qty, it.subtotal, h.total]);
      });
    });
    downloadXLSX('ประวัติการทำรายการ.xlsx', { 'ประวัติ': rows });
  }

  function renderHistoryTable() {
    const wrap = document.getElementById('histTableWrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    const list = filteredHistoryList_();

    if (!list.length) { wrap.appendChild(el('div', { class: 'empty-note' }, [txt('ยังไม่มีประวัติการทำรายการ')])); return; }

    const table = el('table', { class: 'hist' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', {}, [txt('วันที่')]), el('th', {}, [txt('ประเภท')]), el('th', {}, [txt('สถานะ')]), el('th', {}, [txt('แผนก')]),
      el('th', {}, [txt('ผู้เบิก/ผู้ทำรายการ')]), el('th', {}, [txt('รายการ')]), el('th', {}, [txt('ยอดรวม')])
    ])]));
    const tbody = el('tbody');
    list.forEach(h => {
      const itemsSummary = (h.items || []).map(it => it.name + ' ×' + fmt(it.qty)).join(', ');
      const badge = el('span', { class: 'badge ' + (h.type === 'เบิกของ' ? 'withdraw' : 'restock') }, [txt(h.type)]);
      const st = h.status || 'fulfilled';
      const stLabel = st === 'pending' ? 'รอปล่อยของ' : (st === 'cancelled' ? 'ยกเลิกแล้ว' : 'จ่ายแล้ว');
      const stBadge = el('span', { class: 'badge status-' + st }, [txt(stLabel)]);
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [txt(fmtDate(h.ts))]), el('td', {}, [badge]), el('td', {}, [stBadge]), el('td', {}, [txt(h.deptName || '-')]),
        el('td', {}, [txt(h.requester || '-')]),
        el('td', {}, [el('div', { class: 'items-mini' }, [txt(itemsSummary)])]),
        el('td', { class: 'num' }, [txt(fmtMoney(h.total || 0) + ' บ.')])
      ]));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  // ---------- Users tab (admin only) ----------
  function renderUsers(app) {
    const backupCard = el('div', { class: 'card' });
    backupCard.appendChild(el('div', { style: 'font-weight:800;margin-bottom:6px;' }, [txt('สำรองข้อมูล')]));
    backupCard.appendChild(el('div', { style: 'font-size:.78rem;color:var(--text-dim);margin-bottom:8px;' }, [txt('ดาวน์โหลดข้อมูลทั้งหมด (สินค้า, ประวัติการทำรายการ, บัญชีผู้ใช้) เป็นไฟล์ JSON ไว้สำรองหรือย้ายฐานข้อมูล')]));
    backupCard.appendChild(el('button', { class: 'btn ghost', onclick: exportDatabaseExcel }, [txt('⬇ ดาวน์โหลดฐานข้อมูลทั้งหมด (Excel)')]));
    backupCard.appendChild(el('button', { class: 'btn ghost', style: 'margin-left:6px;', onclick: exportDatabaseJSON }, [txt('⬇ ดาวน์โหลดฐานข้อมูลทั้งหมด (JSON)')]));
    app.appendChild(backupCard);

    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { style: 'font-weight:800;margin-bottom:8px;' }, [txt('บัญชีผู้ใช้งาน')]));
    const list = dbAvailable ? authUsers : Object.keys(LOCAL_FALLBACK_USERS).map(u => ({ username: u, ...LOCAL_FALLBACK_USERS[u] }));
    list.forEach(u => {
      const row = el('div', { class: 'userlist-row' }, [
        el('div', { style: 'flex:1;' }, [
          el('div', { class: 'u-name' }, [txt(u.displayName || u.username)]),
          el('div', { class: 'u-role' }, [txt('@' + u.username + ' • ' + (u.role === 'admin' ? 'แอดมิน' : 'ผู้ใช้งานทั่วไป'))])
        ])
      ]);
      const delBtn = el('button', { class: 'btn danger sm', onclick: () => { state.userConfirmDelete = state.userConfirmDelete === u.username ? null : u.username; render(); } }, [txt('ลบ')]);
      row.appendChild(delBtn);
      card.appendChild(row);
      if (state.userConfirmDelete === u.username) {
        card.appendChild(el('div', { class: 'confirm-box' }, [
          txt('ยืนยันลบผู้ใช้ ' + u.username + '?'),
          el('button', { class: 'btn danger sm', onclick: () => deleteUser(u.username) }, [txt('ยืนยันลบ')]),
          el('button', { class: 'btn ghost sm', onclick: () => { state.userConfirmDelete = null; render(); } }, [txt('ยกเลิก')])
        ]));
      }
    });

    const addBox = el('div', { class: 'add-form' });
    addBox.appendChild(el('div', { style: 'font-weight:700;margin-bottom:6px;font-size:.85rem;' }, [txt('เพิ่มผู้ใช้งานใหม่ (ทีละคน)')]));
    const grid = el('div', { class: 'edit-grid' });
    const userIn = el('input', { type: 'text', placeholder: 'รหัสพนักงาน (username)' });
    const nameIn = el('input', { type: 'text', placeholder: 'ชื่อ-นามสกุลพนักงาน' });
    const passIn = el('input', { type: 'password', placeholder: 'รหัสผ่าน (ค่าเริ่มต้น = รหัสพนักงาน)' });
    const roleIn = el('select', {}, [el('option', { value: 'user' }, [txt('ผู้ใช้งานทั่วไป')]), el('option', { value: 'admin' }, [txt('แอดมิน')])]);
    userIn.addEventListener('input', () => { if (!passIn.dataset.touched) passIn.value = userIn.value; });
    passIn.addEventListener('input', () => { passIn.dataset.touched = '1'; });
    [userIn, nameIn, passIn, roleIn].forEach(i => grid.appendChild(i));
    addBox.appendChild(grid);
    addBox.appendChild(el('div', { style: 'font-size:.72rem;color:var(--text-dim);margin:-2px 0 8px;' }, [txt('ค่าเริ่มต้น: ใช้รหัสพนักงานเดียวกันเป็นทั้ง Username และ Password (แก้ไขรหัสผ่านได้หากต้องการ)')]));
    addBox.appendChild(el('button', {
      class: 'btn success sm', onclick: () => addUser({ username: userIn.value, displayName: nameIn.value, password: passIn.value || userIn.value, role: roleIn.value })
    }, [txt('เพิ่มผู้ใช้งาน')]));
    card.appendChild(addBox);

    card.appendChild(renderBulkImportBox());

    app.appendChild(card);
  }

  function renderBulkImportBox() {
    const box = el('div', { class: 'add-form import-box' });
    box.appendChild(el('div', { style: 'font-weight:700;margin-bottom:4px;font-size:.85rem;' }, [txt('นำเข้ารายชื่อพนักงานหลายคนพร้อมกัน')]));
    box.appendChild(el('div', { style: 'font-size:.74rem;color:var(--text-dim);margin-bottom:8px;line-height:1.5;' }, [
      txt('วางรายชื่อ 1 คนต่อ 1 บรรทัด รูปแบบ: '), el('b', {}, [txt('รหัสพนักงาน,ชื่อ-นามสกุล')]),
      txt(' (คั่นด้วยจุลภาคหรือแท็บ) — ระบบจะตั้ง Username และ Password เป็นรหัสพนักงาน และสิทธิ์เป็นผู้ใช้งานทั่วไปให้อัตโนมัติ บัญชีแอดมินเดิมจะไม่ถูกทับ')
    ]));
    const fileIn = el('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', style: 'margin-bottom:8px;' });
    const textarea = el('textarea', { placeholder: '10001,สมชาย ใจดี\n10002,สมหญิง รักงาน' });
    fileIn.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { textarea.value = String(reader.result || ''); };
      reader.readAsText(f, 'utf-8');
    });
    box.appendChild(fileIn);
    box.appendChild(textarea);
    box.appendChild(el('button', { class: 'btn success sm', style: 'margin-top:8px;', onclick: () => bulkImportEmployees(textarea.value) }, [txt('นำเข้ารายชื่อทั้งหมด')]));
    return box;
  }

  function parseEmployeeList(text) {
    return (text || '').split('\n').map(line => {
      const parts = line.split(/\t|,/).map(s => s.trim()).filter(s => s.length);
      if (!parts.length) return null;
      const username = parts[0].toLowerCase().replace(/\s+/g, '');
      const name = parts.slice(1).join(' ').trim();
      if (!username) return null;
      return { username, name: name || username };
    }).filter(Boolean);
  }

  async function bulkImportEmployees(text) {
    const list = parseEmployeeList(text);
    if (!list.length) { showToast('ไม่พบรายชื่อที่จะนำเข้า', true); return; }
    let created = 0, updated = 0, skippedAdmin = 0;
    for (const entry of list) {
      const existing = authUsers.find(u => u.username === entry.username) || (LOCAL_FALLBACK_USERS[entry.username] ? { username: entry.username, ...LOCAL_FALLBACK_USERS[entry.username] } : null);
      if (existing && existing.role === 'admin') { skippedAdmin++; continue; }
      try {
        const hash = await hashPassword(entry.username);
        const payload = { passwordHash: hash, role: 'user', displayName: entry.name };
        if (apiAvailable) { await apiSet('auth_users', entry.username, payload); }
        else { const idx = authUsers.findIndex(u => u.username === entry.username); if (idx > -1) authUsers[idx] = { username: entry.username, ...payload }; else authUsers.push({ username: entry.username, ...payload }); }
        if (existing) updated++; else created++;
      } catch (e) { /* continue with the rest */ }
    }
    if (apiAvailable) await loadAuthUsers_();
    showToast(`นำเข้าสำเร็จ: เพิ่มใหม่ ${created} คน, อัปเดต ${updated} คน` + (skippedAdmin ? `, ข้ามบัญชีแอดมิน ${skippedAdmin} คน` : ''));
    render();
  }

  render();
  initDb();
})();
