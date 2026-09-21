#!/usr/bin/env bun
import { readFileSync } from 'node:fs';

const arg = process.argv[2];
let content = '';

if (!process.stdin.isTTY) {
  content = (await Bun.stdin.text()).trim();
}

if (!content && arg) {
  try {
    content = readFileSync(arg, 'utf-8');
  } catch {
    content = arg;
  }
}

if (!content) {
  console.log('Usage: bun scripts/bulk-import.ts <accounts.txt>');
  console.log('   or: cat accounts.txt | bun scripts/bulk-import.ts');
  console.log('   or: bun scripts/bulk-import.ts "email1:pass1\\nemail2:pass2"');
  process.exit(0);
}

const port = process.env.PORT || '8080';
const res = await fetch(`http://127.0.0.1:${port}/api/accounts/bulk`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ raw: content }),
});

const data = await res.json();
if (!res.ok) {
  console.error('Error:', data?.error?.message || res.statusText);
  process.exit(1);
}

console.log(`\n=== Bulk Import Result: ${data.successful}/${data.total} Success (${data.failed} Failed) ===\n`);
for (const r of data.results || []) {
  const icon = r.success ? '✓' : '✗';
  const detail = r.success ? (r.loginSucceeded ? 'Logged In' : 'Added') : (r.error || 'Failed');
  console.log(`  [${icon}] ${r.email} -> ${detail}`);
}
