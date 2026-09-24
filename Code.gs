/**
 * Non Inventory System — Google Sheet backend (v2: readable sheets)
 * ---------------------------------------------------------------
 * Each collection the app uses gets its OWN sheet tab with real,
 * named columns — so you can open the Google Sheet directly and
 * read the products, transaction history, or user list as an
 * ordinary table (no JSON blobs to decode).
 *
 *   Tab "products"      → id, name, category, unit, price, stock, image
 *   Tab "requisitions"  → id, ts, type, deptCode, deptName, requester,
 *                         employeeId, recordedBy, total, items
 *                         (only "items", the line-item detail, stays as
 *                         a JSON string in its cell — everything else
 *                         is a plain readable column)
 *   Tab "auth_users"    → id, role, displayName, passwordHash
 *
 * Tabs are created automatically (with headers) the first time the
 * app writes to that collection — you don't need to create them by
 * hand.
 *
 * SETUP
 * 1. Create a new Google Sheet (or open an existing one).
 * 2. Extensions > Apps Script. Delete any starter code and paste this
 *    whole file in.
 * 3. Deploy > New deployment > type "Web app".
 *      Execute as:     Me
 *      Who has access: Anyone
 * 4. Deploy, authorize the requested permissions, then copy the
 *    Web app URL (ends in /exec).
 * 5. Paste that URL into config.js as API_URL in the main app folder.
 *
 * Whenever you edit this file afterwards you must re-deploy:
 * Deploy > Manage deployments > pencil icon > Version: New version > Deploy.
 */

var HEADERS = {
  products: ['id', 'name', 'category', 'unit', 'price', 'stock', 'image'],
  // New fields are appended at the END on purpose — if you already have a
  // "requisitions" tab from before the fulfillment feature existed, its
  // existing columns keep their original position (nothing shifts/breaks).
  // A brand-new sheet gets all columns from the start automatically.
  requisitions: [
    'id', 'ts', 'type', 'deptCode', 'deptName', 'requester', 'employeeId', 'recordedBy', 'total', 'items',
    'status', 'fulfilledAt', 'fulfilledBy', 'fulfilledByName', 'cancelledAt', 'cancelledBy'
  ],
  auth_users: ['id', 'role', 'displayName', 'passwordHash'],
  stock_counts: ['id', 'date', 'checkedBy', 'checkedByName', 'notes', 'itemCount', 'changedCount', 'totalDiffValue', 'items']
};
var JSON_FIELDS = { requisitions: ['items'], stock_counts: ['items'] }; // fields that are stored as JSON text inside their own cell

function headersFor_(collection) {
  return HEADERS[collection] || ['id', 'json'];
}

function getSheet_(collection) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(collection);
  if (!sheet) {
    sheet = ss.insertSheet(collection);
    sheet.appendRow(headersFor_(collection));
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Converts a stored data object into a row array matching this collection's headers.
// A single Google Sheets cell holds at most 50,000 characters. Writing more
// than that either truncates silently or throws deep inside the Sheets
// service — better to catch it here with a clear message the app can show.
var CELL_CHAR_LIMIT = 49000;

function objectToRow_(collection, id, data) {
  var headers = headersFor_(collection);
  var jsonFields = JSON_FIELDS[collection] || [];
  return headers.map(function (h) {
    if (h === 'id') return id;
    var v = data[h];
    if (v === undefined || v === null) return '';
    if (jsonFields.indexOf(h) !== -1) v = JSON.stringify(v);
    if (typeof v === 'string' && v.length > CELL_CHAR_LIMIT) {
      throw new Error('field "' + h + '" is too large to store (' + v.length + ' characters, limit ' + CELL_CHAR_LIMIT + ') — try a smaller/simpler value');
    }
    return v;
  });
}

// Converts a stored row array back into a plain object keyed by header name.
function rowToObject_(collection, rowValues) {
  var headers = headersFor_(collection);
  var jsonFields = JSON_FIELDS[collection] || [];
  var obj = {};
  headers.forEach(function (h, i) {
    var v = rowValues[i];
    if (jsonFields.indexOf(h) !== -1) {
      try { v = v ? JSON.parse(v) : []; } catch (err) { v = []; }
    }
    obj[h] = v;
  });
  return obj;
}

function findRow_(sheet, id) {
  var ids = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // 1-based row, +1 for header
  }
  return -1;
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action || 'list';

    if (action === 'list') {
      var collection = params.collection;
      if (!collection) return jsonResponse_({ error: 'collection required' });
      var sheet = getSheet_(collection);
      var lastRow = sheet.getLastRow();
      var rows = [];
      if (lastRow > 1) {
        var values = sheet.getRange(2, 1, lastRow - 1, headersFor_(collection).length).getValues();
        rows = values.map(function (r) { return rowToObject_(collection, r); });
      }
      return jsonResponse_({ ok: true, rows: rows });
    }

    if (action === 'get') {
      var collection2 = params.collection;
      var id = params.id;
      var sheet2 = getSheet_(collection2);
      var rowIdx = findRow_(sheet2, id);
      if (rowIdx === -1) return jsonResponse_({ ok: true, row: null });
      var rowVals = sheet2.getRange(rowIdx, 1, 1, headersFor_(collection2).length).getValues()[0];
      return jsonResponse_({ ok: true, row: rowToObject_(collection2, rowVals) });
    }

    if (action === 'exportAll') {
      var out = {};
      Object.keys(HEADERS).forEach(function (col) {
        var sh = getSheet_(col);
        var lr = sh.getLastRow();
        out[col] = lr > 1 ? sh.getRange(2, 1, lr - 1, headersFor_(col).length).getValues().map(function (r) { return rowToObject_(col, r); }) : [];
      });
      return jsonResponse_({ ok: true, data: out });
    }

    return jsonResponse_({ error: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var collection = body.collection;
    var sheet = getSheet_(collection);
    var headers = headersFor_(collection);

    if (action === 'set') {
      var id = String(body.id);
      var rowIdx = findRow_(sheet, id);
      var rowArr = objectToRow_(collection, id, body.data || {});
      if (rowIdx === -1) sheet.appendRow(rowArr);
      else sheet.getRange(rowIdx, 1, 1, headers.length).setValues([rowArr]);
      return jsonResponse_({ ok: true });
    }

    if (action === 'update') {
      var id2 = String(body.id);
      var rowIdx2 = findRow_(sheet, id2);
      var existing = {};
      if (rowIdx2 !== -1) {
        var existingRow = sheet.getRange(rowIdx2, 1, 1, headers.length).getValues()[0];
        existing = rowToObject_(collection, existingRow);
      }
      var merged = Object.assign({}, existing, body.data || {});
      var rowArr2 = objectToRow_(collection, id2, merged);
      if (rowIdx2 === -1) sheet.appendRow(rowArr2);
      else sheet.getRange(rowIdx2, 1, 1, headers.length).setValues([rowArr2]);
      return jsonResponse_({ ok: true });
    }

    if (action === 'delete') {
      var id3 = String(body.id);
      var rowIdx3 = findRow_(sheet, id3);
      if (rowIdx3 !== -1) sheet.deleteRow(rowIdx3);
      return jsonResponse_({ ok: true });
    }

    if (action === 'add') {
      var id4 = body.id || Utilities.getUuid();
      var rowArr4 = objectToRow_(collection, id4, body.data || {});
      sheet.appendRow(rowArr4);
      return jsonResponse_({ ok: true, id: id4 });
    }

    return jsonResponse_({ error: 'unknown action: ' + action });
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
