/**
 * Dashboard login page.
 *
 * Icons are inline SVG (stroke, currentColor) — never emoji — so they inherit
 * the existing dashboard theme and render identically on every platform.
 */

/** Lock mark used as the primary visual on the login card. */
const LOCK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="40" height="40" aria-hidden="true">
  <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
  <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  <circle cx="12" cy="15.8" r="1.4" />
  <path d="M12 17.2v2.1" />
</svg>`;

/** Small key mark shown inline next to the password label. */
const KEY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
  <circle cx="8" cy="8" r="4" />
  <path d="M11 11l8 8M16.5 16.5l1.8-1.8M19 19l1.8-1.8" />
</svg>`;

/** Error mark for the invalid-password notice. */
const ALERT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
  <circle cx="12" cy="12" r="9" />
  <path d="M12 7.5v5" />
  <circle cx="12" cy="16.2" r="0.9" fill="currentColor" stroke="none" />
</svg>`;

/**
 * Render the login page.
 *
 * @param error Set when a previous attempt failed, to show the notice.
 */
export function loginHtml(error = false): string {
  const errorBlock = error ? `<div class="login-error" role="alert">${ALERT_ICON}<span>Password salah. Coba lagi.</span></div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Login — QwenGate</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #f5f6f8;
    --card: #ffffff;
    --text: #14161a;
    --muted: #6b7280;
    --border: #e3e5e9;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --danger-bg: #fef2f2;
    --danger-border: #fecaca;
    --danger-text: #b91c1c;
  }
  html.dark-mode {
    --bg: #0f1115;
    --card: #171a21;
    --text: #e8eaed;
    --muted: #9aa1ac;
    --border: #262b34;
    --accent: #6366f1;
    --accent-hover: #7c7ff5;
    --danger-bg: #2a1618;
    --danger-border: #5b2626;
    --danger-text: #fca5a5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--text);
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    padding: 24px;
  }
  .login-card {
    width: 100%;
    max-width: 380px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px 28px 28px;
    box-shadow: 0 1px 2px rgba(16,18,22,.04), 0 12px 32px rgba(16,18,22,.06);
  }
  .login-mark {
    display: flex;
    justify-content: center;
    color: var(--accent);
    margin-bottom: 18px;
  }
  h1 {
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -.01em;
    margin: 0 0 6px;
    text-align: center;
  }
  .login-sub {
    font-size: 13.5px;
    color: var(--muted);
    text-align: center;
    margin: 0 0 24px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
    margin-bottom: 7px;
  }
  input[type="password"] {
    width: 100%;
    padding: 11px 13px;
    font-size: 14px;
    font-family: inherit;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 9px;
    outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type="password"]:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
  }
  button {
    width: 100%;
    margin-top: 18px;
    padding: 11px 14px;
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    color: #fff;
    background: var(--accent);
    border: 0;
    border-radius: 9px;
    cursor: pointer;
    transition: background .15s;
  }
  button:hover { background: var(--accent-hover); }
  .login-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 18px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--danger-text);
    background: var(--danger-bg);
    border: 1px solid var(--danger-border);
    border-radius: 9px;
  }
</style>
</head>
<body>
  <form class="login-card" method="POST" action="/login">
    <div class="login-mark">${LOCK_ICON}</div>
    <h1>Login QwenGate</h1>
    <p class="login-sub">Masukin password buat lanjut ke dashboard.</p>
    ${errorBlock}
    <label for="password">${KEY_ICON}<span>Password</span></label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">Masuk</button>
  </form>
</body>
</html>`;
}
