/*
 * API Keys page — self-service key management.
 *
 * Icons are inline SVG (stroke, currentColor). No emoji anywhere.
 */

var keysCache = [];

/* ── Icons ── */
var SVG_ATTR =
  'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

function iconKey() {
  return (
    '<svg ' + SVG_ATTR + '><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="M17 6l3 3"/><path d="M14 9l3 3"/></svg>'
  );
}
function iconEdit() {
  return '<svg ' + SVG_ATTR + '><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
}
function iconReset() {
  return '<svg ' + SVG_ATTR + '><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
}
function iconTrash() {
  return '<svg ' + SVG_ATTR + '><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
}
function iconCopy() {
  return (
    '<svg ' +
    SVG_ATTR +
    '><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>'
  );
}
function iconCheck() {
  return '<svg ' + SVG_ATTR + '><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>';
}
function iconWarn() {
  return '<svg ' + SVG_ATTR + '><path d="M12 3 2 20h20L12 3z"/><path d="M12 9v5"/><path d="M12 17.5h.01"/></svg>';
}
function iconBan() {
  return '<svg ' + SVG_ATTR + '><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>';
}

/* ── Helpers ── */
function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(), opts.headers || {});
  return fetch(path, opts);
}

function fmtNum(n) {
  if (n === null || n === undefined) return '∞';
  return String(n);
}

function fmtUsage(used, max) {
  if (max === null || max === undefined) return fmtNum(used) + ' / ∞';
  return fmtNum(used) + ' / ' + fmtNum(max);
}

function fmtDate(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showKeysMessage(html, kind) {
  var el = document.getElementById('keysMessage');
  if (!html) {
    el.innerHTML = '';
    el.className = 'keys-message';
    return;
  }
  el.className = 'keys-message' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
}

/* ── Load & render ── */
async function loadKeys() {
  try {
    var res = await api('/api/keys');
    if (!res.ok) {
      showKeysMessage(iconWarn() + ' Gagal muat daftar key (HTTP ' + res.status + ').', 'error');
      return;
    }
    var data = await res.json();
    keysCache = Array.isArray(data.keys) ? data.keys : [];
    showKeysMessage('');
    renderKeysTable();
  } catch (e) {
    showKeysMessage(iconWarn() + ' Gagal nyambung ke server.', 'error');
  }
}

function statusCell(k) {
  if (!k.enabled) return '<span class="badge badge-off">' + iconBan() + ' Disabled</span>';
  if (k.expired) return '<span class="badge badge-expired">' + iconWarn() + ' Expired</span>';
  if (k.blocked) return '<span class="badge badge-blocked">' + iconWarn() + ' Quota habis</span>';
  return '<span class="badge badge-active">' + iconCheck() + ' Active</span>';
}

function renderKeysTable() {
  var body = document.getElementById('keysTableBody');
  if (!keysCache.length) {
    body.innerHTML = '<tr><td colspan="8" class="keys-empty">Belum ada API key. Klik <strong>New Key</strong> buat bikin.</td></tr>';
    return;
  }

  var html = '';
  for (var i = 0; i < keysCache.length; i++) {
    var k = keysCache[i];
    html +=
      '<tr>' +
      '<td><div class="key-name">' +
      escHtml(k.name) +
      '</div>' +
      '<div class="key-id">' +
      escHtml(k.id) +
      '</div></td>' +
      '<td><code class="key-prefix">' +
      escHtml(k.prefix) +
      '…</code></td>' +
      '<td>' +
      statusCell(k) +
      '</td>' +
      '<td>' +
      fmtNum(k.rpm) +
      '</td>' +
      '<td>' +
      fmtUsage(k.requestCount, k.maxRequests) +
      '</td>' +
      '<td>' +
      fmtUsage(k.totalTokens, k.maxTokens) +
      '</td>' +
      '<td>' +
      fmtDate(k.expiresAt) +
      '</td>' +
      '<td class="keys-actions">' +
      '<button class="icon-btn" title="Edit" onclick="openEditKey(\'' +
      k.id +
      '\')">' +
      iconEdit() +
      '</button>' +
      '<button class="icon-btn" title="Reset pemakaian" onclick="resetKey(\'' +
      k.id +
      '\')">' +
      iconReset() +
      '</button>' +
      '<button class="icon-btn danger" title="Hapus" onclick="deleteKey(\'' +
      k.id +
      "', '" +
      escHtml(k.name) +
      '\')">' +
      iconTrash() +
      '</button>' +
      '</td>' +
      '</tr>';
  }
  body.innerHTML = html;
}

/* ── Modal plumbing ── */
function openKeyModal(title, bodyHtml, footerHtml) {
  document.getElementById('keyModalHeader').textContent = title;
  document.getElementById('keyModalBody').innerHTML = bodyHtml;
  document.getElementById('keyModalFooter').innerHTML = footerHtml;
  document.getElementById('keyModal').classList.remove('hidden');
}

function closeKeyModal() {
  document.getElementById('keyModal').classList.add('hidden');
}

/* ── Create ── */
function limitField(id, label, hint) {
  return (
    '<div class="form-row"><label for="' +
    id +
    '">' +
    label +
    '</label>' +
    '<input type="number" min="0" id="' +
    id +
    '" placeholder="kosong = unlimited">' +
    (hint ? '<span class="form-hint">' + hint + '</span>' : '') +
    '</div>'
  );
}

function openCreateKey() {
  var body =
    '<div class="form-row"><label for="kName">Nama</label>' +
    '<input type="text" id="kName" placeholder="misal: klien-budi" maxlength="120">' +
    '<span class="form-hint">Buat nandain key ini punya siapa.</span></div>' +
    limitField('kRpm', 'RPM', 'Request per menit. Kosong = unlimited.') +
    limitField('kMaxReq', 'Max requests', 'Total request seumur key. Kosong = unlimited.') +
    limitField('kMaxTok', 'Max tokens', 'Total token (prompt + completion). Kosong = unlimited.') +
    '<div class="form-row"><label for="kExpires">Expired</label>' +
    '<input type="date" id="kExpires">' +
    '<span class="form-hint">Kosong = nggak pernah expired.</span></div>';

  var footer =
    '<button class="modal-btn modal-btn-secondary" onclick="closeKeyModal()">Cancel</button>' +
    '<button class="modal-btn modal-btn-primary" id="kCreateBtn" onclick="submitCreateKey()">Create</button>';

  openKeyModal('New API Key', body, footer);
  setTimeout(function () {
    var el = document.getElementById('kName');
    if (el) el.focus();
  }, 0);
}

function readLimit(id) {
  var raw = document.getElementById(id).value;
  if (raw === '' || raw === null) return null;
  var n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return undefined; // sentinel: invalid
  return n;
}

async function submitCreateKey() {
  var name = document.getElementById('kName').value.trim();
  if (!name) {
    showKeysMessage(iconWarn() + ' Nama wajib diisi.', 'error');
    return;
  }

  var payload = { name: name };
  var fields = [
    ['kRpm', 'rpm'],
    ['kMaxReq', 'maxRequests'],
    ['kMaxTok', 'maxTokens'],
  ];
  for (var i = 0; i < fields.length; i++) {
    var v = readLimit(fields[i][0]);
    if (v === undefined) {
      showKeysMessage(iconWarn() + ' Angka limit harus bilangan bulat >= 0.', 'error');
      return;
    }
    payload[fields[i][1]] = v;
  }

  var expRaw = document.getElementById('kExpires').value;
  payload.expiresAt = expRaw ? new Date(expRaw + 'T23:59:59').getTime() : null;

  var btn = document.getElementById('kCreateBtn');
  btn.disabled = true;
  try {
    var res = await api('/api/keys', { method: 'POST', body: JSON.stringify(payload) });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      btn.disabled = false;
      showKeysMessage(iconWarn() + ' ' + escHtml(data.error || 'Gagal bikin key.'), 'error');
      return;
    }
    closeKeyModal();
    showSecretOnce(data.secret, data.key);
    loadKeys();
  } catch (e) {
    btn.disabled = false;
    showKeysMessage(iconWarn() + ' Gagal nyambung ke server.', 'error');
  }
}

/* ── Secret shown exactly once ── */
function showSecretOnce(secret, key) {
  var body =
    '<p class="secret-warn">' +
    iconWarn() +
    ' <strong>Copy sekarang.</strong> Key ini cuma ditampilin sekali — server cuma nyimpen hash-nya, ' +
    'jadi nggak bisa dilihat lagi.</p>' +
    '<div class="secret-box"><code id="secretValue">' +
    escHtml(secret) +
    '</code>' +
    '<button class="icon-btn" title="Copy" onclick="copySecret()">' +
    iconCopy() +
    '</button></div>' +
    '<p class="form-hint">Pakai di client: <code>Authorization: Bearer &lt;key&gt;</code></p>';

  var footer = '<button class="modal-btn modal-btn-primary" onclick="closeKeyModal()">Udah gw copy</button>';
  openKeyModal('Key: ' + escHtml(key.name), body, footer);
}

function copySecret() {
  var el = document.getElementById('secretValue');
  if (!el) return;
  var text = el.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      showToast('Key ke-copy');
    });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Key ke-copy');
    } catch (e) {}
    document.body.removeChild(ta);
  }
}

/* ── Edit ── */
function findKey(id) {
  for (var i = 0; i < keysCache.length; i++) if (keysCache[i].id === id) return keysCache[i];
  return null;
}

function openEditKey(id) {
  var k = findKey(id);
  if (!k) return;
  window.__editKeyId = id;

  var body =
    '<div class="form-row"><label for="eName">Nama</label>' +
    '<input type="text" id="eName" value="' +
    escHtml(k.name) +
    '" maxlength="120"></div>' +
    '<div class="form-row"><label for="eRpm">RPM</label>' +
    '<input type="number" min="0" id="eRpm" value="' +
    (k.rpm === null ? '' : k.rpm) +
    '" placeholder="kosong = unlimited"></div>' +
    '<div class="form-row"><label for="eMaxReq">Max requests</label>' +
    '<input type="number" min="0" id="eMaxReq" value="' +
    (k.maxRequests === null ? '' : k.maxRequests) +
    '" placeholder="kosong = unlimited"></div>' +
    '<div class="form-row"><label for="eMaxTok">Max tokens</label>' +
    '<input type="number" min="0" id="eMaxTok" value="' +
    (k.maxTokens === null ? '' : k.maxTokens) +
    '" placeholder="kosong = unlimited"></div>' +
    '<div class="form-row"><label for="eExpires">Expired</label>' +
    '<input type="date" id="eExpires" value="' +
    (k.expiresAt ? new Date(k.expiresAt).toISOString().slice(0, 10) : '') +
    '">' +
    '<span class="form-hint">Kosongin buat ngilangin expired.</span></div>' +
    '<div class="form-row form-row-inline"><label for="eEnabled">Aktif</label>' +
    '<input type="checkbox" id="eEnabled"' +
    (k.enabled ? ' checked' : '') +
    '></div>';

  var footer =
    '<button class="modal-btn modal-btn-secondary" onclick="closeKeyModal()">Cancel</button>' +
    '<button class="modal-btn modal-btn-primary" id="kSaveBtn" onclick="submitEditKey()">Save</button>';

  openKeyModal('Edit Key', body, footer);
}

async function submitEditKey() {
  var id = window.__editKeyId;
  if (!id) return;

  var name = document.getElementById('eName').value.trim();
  if (!name) {
    showKeysMessage(iconWarn() + ' Nama nggak boleh kosong.', 'error');
    return;
  }

  var payload = {
    name: name,
    enabled: document.getElementById('eEnabled').checked,
  };

  var fields = [
    ['eRpm', 'rpm'],
    ['eMaxReq', 'maxRequests'],
    ['eMaxTok', 'maxTokens'],
  ];
  for (var i = 0; i < fields.length; i++) {
    var v = readLimit(fields[i][0]);
    if (v === undefined) {
      showKeysMessage(iconWarn() + ' Angka limit harus bilangan bulat >= 0.', 'error');
      return;
    }
    payload[fields[i][1]] = v;
  }

  var expRaw = document.getElementById('eExpires').value;
  payload.expiresAt = expRaw ? new Date(expRaw + 'T23:59:59').getTime() : null;

  var btn = document.getElementById('kSaveBtn');
  btn.disabled = true;
  try {
    var res = await api('/api/keys/' + id, { method: 'PATCH', body: JSON.stringify(payload) });
    var data = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      btn.disabled = false;
      showKeysMessage(iconWarn() + ' ' + escHtml(data.error || 'Gagal nyimpen.'), 'error');
      return;
    }
    closeKeyModal();
    showKeysMessage(iconCheck() + ' Key <strong>' + escHtml(data.key.name) + '</strong> keupdate.', 'ok');
    loadKeys();
  } catch (e) {
    btn.disabled = false;
    showKeysMessage(iconWarn() + ' Gagal nyambung ke server.', 'error');
  }
}

/* ── Reset ── */
async function resetKey(id) {
  var k = findKey(id);
  if (!k) return;
  var bodyHtml =
    '<p>Nol-in counter <strong>request</strong> dan <strong>token</strong> buat key ' +
    '<strong>' +
    escHtml(k.name) +
    '</strong>?</p>' +
    '<p style="margin:0;color:var(--text-secondary);font-size:0.85em">Key-nya tetep hidup, cuma pemakaiannya di-reset.</p>';
  var footerHtml =
    '<button class="modal-btn modal-btn-secondary" onclick="closeKeyModal()">Cancel</button>' +
    '<button class="modal-btn modal-btn-primary" id="kResetBtn" onclick="confirmResetKey(\'' +
    id +
    '\')">Yes, reset</button>';
  openKeyModal('Reset Pemakaian', bodyHtml, footerHtml);
}

async function confirmResetKey(id) {
  var btn = document.getElementById('kResetBtn');
  btn.disabled = true;
  try {
    var res = await api('/api/keys/' + id + '/reset', { method: 'POST' });
    var data = await res.json().catch(function () {
      return {};
    });
    closeKeyModal();
    if (!res.ok) {
      showKeysMessage(iconWarn() + ' ' + escHtml(data.error || 'Gagal reset.'), 'error');
      return;
    }
    showKeysMessage(iconCheck() + ' Pemakaian key <strong>' + escHtml(data.key.name) + '</strong> udah di-reset.', 'ok');
    loadKeys();
  } catch (e) {
    closeKeyModal();
    showKeysMessage(iconWarn() + ' Gagal nyambung ke server.', 'error');
  }
}

/* ── Delete ── */
function deleteKey(id, name) {
  var bodyHtml =
    '<p>Hapus permanen key <strong>' +
    escHtml(name) +
    '</strong>?</p>' +
    '<p style="margin:0;color:var(--danger)"><strong>Client yang pakai key ini bakal langsung ditolak.</strong> ' +
    'Nggak bisa dibalikin.</p>';
  var footerHtml =
    '<button class="modal-btn modal-btn-secondary" onclick="closeKeyModal()">Cancel</button>' +
    '<button class="modal-btn modal-btn-primary" style="background:var(--danger)" id="kDelBtn" onclick="confirmDeleteKey(\'' +
    id +
    '\')">Yes, hapus</button>';
  openKeyModal('Hapus Key', bodyHtml, footerHtml);
}

async function confirmDeleteKey(id) {
  var btn = document.getElementById('kDelBtn');
  btn.disabled = true;
  try {
    var res = await api('/api/keys/' + id, { method: 'DELETE' });
    closeKeyModal();
    if (!res.ok) {
      showKeysMessage(iconWarn() + ' Gagal hapus key.', 'error');
      return;
    }
    showKeysMessage(iconCheck() + ' Key udah dihapus.', 'ok');
    loadKeys();
  } catch (e) {
    closeKeyModal();
    showKeysMessage(iconWarn() + ' Gagal nyambung ke server.', 'error');
  }
}

/* ── Init ── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadKeys);
} else {
  loadKeys();
}
