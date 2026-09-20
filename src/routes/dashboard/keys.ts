import { sidebarHtml } from './sidebar.ts';

export const keysHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen Gate — API Keys</title>
  <link rel="stylesheet" href="/dashboard/static/shared.css">
  <link rel="stylesheet" href="/dashboard/static/keys.css">
</head>
<body>

<div class="dashboard-layout">
  ${sidebarHtml('keys')}
  <main class="main-content">

<div class="keys-header">
  <div>
    <h1>API Keys</h1>
    <p class="keys-sub">Bikin key sendiri, atur RPM, quota request/token, dan tanggal expired-nya.</p>
  </div>
  <button class="save-btn" id="keysNewBtn" onclick="openCreateKey()">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
    New Key
  </button>
</div>

<div id="keysMessage" class="keys-message"></div>

<div class="keys-table-wrap">
  <table class="keys-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Key</th>
        <th>Status</th>
        <th>RPM</th>
        <th>Requests</th>
        <th>Tokens</th>
        <th>Expires</th>
        <th class="keys-actions-col">Actions</th>
      </tr>
    </thead>
    <tbody id="keysTableBody">
      <tr><td colspan="8" class="keys-empty">Memuat…</td></tr>
    </tbody>
  </table>
</div>

<div class="toast-container" id="toastContainer"></div>

<div class="modal-overlay hidden" id="keyModal">
  <div class="modal-box">
    <div class="modal-header" id="keyModalHeader">New API Key</div>
    <div class="modal-body" id="keyModalBody"></div>
    <div class="modal-footer" id="keyModalFooter"></div>
  </div>
</div>

  </main>
</div>

  <script src="/dashboard/static/shared.js"></script>
  <script src="/dashboard/static/keys.js"></script>
</body>
</html>`;
