#!/usr/bin/env bun
/**
 * scripts/auto-register.ts
 * Pure local automated Qwen account registration script.
 * Solves Aliyun AWSC slider locally without 3rd party solvers.
 * Captures OTP from local OTP store / webhook.
 *
 * Usage:
 *   bun scripts/auto-register.ts --domain mail.aikernel.qzz.io --count 1
 */

import crypto from 'crypto';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { chromium } from 'playwright';
import { solveAliyunSlider, detectAliyunSlider } from '../src/services/captchaSolver.ts';
import { waitForOtp, storeOtp } from '../src/services/otpService.ts';

interface CliArgs {
  domain: string;
  count: number;
  password?: string;
  headless: boolean;
  autoImport: boolean;
  qwenGateUrl: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    domain: 'mail.aikernel.qzz.io',
    count: 1,
    headless: true,
    autoImport: true,
    qwenGateUrl: 'http://127.0.0.1:8080',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--domain' && args[i + 1]) {
      result.domain = args[++i];
    } else if (arg === '--count' && args[i + 1]) {
      result.count = parseInt(args[++i], 10) || 1;
    } else if (arg === '--password' && args[i + 1]) {
      result.password = args[++i];
    } else if (arg === '--no-headless' || arg === '--headed') {
      result.headless = false;
    } else if (arg === '--no-import') {
      result.autoImport = false;
    } else if (arg === '--url' && args[i + 1]) {
      result.qwenGateUrl = args[++i];
    }
  }

  return result;
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  let pwd = 'Qw1!';
  for (let i = 0; i < 12; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

function generateRandomUsername(): string {
  const suffix = crypto.randomBytes(4).toString('hex');
  return `qw_${suffix}`;
}

async function registerOneAccount(args: CliArgs, index: number): Promise<{ success: boolean; email: string; password: string; error?: string }> {
  const username = generateRandomUsername();
  const email = `${username}@${args.domain}`;
  const password = args.password || generatePassword();

  console.log(`\n[${index}/${args.count}] Memulai pendaftaran untuk: ${email}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: args.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Asia/Singapore',
    });

    // Stealth injection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as any).chrome = { runtime: {} };
    });

    const page = await context.newPage();

    console.log('[-] Navigasi ke halaman registrasi Qwen...');
    await page.goto('https://chat.qwen.ai/auth?mode=register', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await page.waitForTimeout(2000);

    // Deteksi form registrasi
    const inputs = await page.$$('input:not([type="hidden"])');
    if (inputs.length < 3) {
      // Fallback cek url /auth?action=signup
      console.log('[-] Mencoba route /auth?action=signup...');
      await page.goto('https://chat.qwen.ai/auth?action=signup', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    const emailInput = (await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]')) || (await page.$('input'));
    const pwdInput = await page.$('input[type="password"], input[name="password"]');

    if (emailInput) {
      console.log('[-] Mengisi form registrasi...');
      await emailInput.fill(email);
      await page.waitForTimeout(300);
    }

    if (pwdInput) {
      await pwdInput.fill(password);
      await page.waitForTimeout(300);
      // Cek konfirmasi password jika ada
      const confirmPwd = await page.$('input[name="confirmPassword"], input[placeholder*="confirm" i]');
      if (confirmPwd) {
        await confirmPwd.fill(password);
        await page.waitForTimeout(300);
      }
    }

    // Centang checkbox syarat/ketentuan jika ada
    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox && !(await checkbox.isChecked())) {
      await checkbox.click();
      await page.waitForTimeout(200);
    }

    // Klik tombol submit/register
    const submitBtn =
      (await page.$('button[type="submit"]')) ||
      (await page.$('button:has-text("Sign up"), button:has-text("Register"), button:has-text("Create account"), button:has-text("Continue")'));

    if (submitBtn) {
      console.log('[-] Submit form registrasi...');
      await submitBtn.click();
      await page.waitForTimeout(1500);
    }

    // Cek apakah muncul Aliyun slider
    const hasSlider = await detectAliyunSlider(page);
    if (hasSlider) {
      console.log('[*] Aliyun AWSC slider terdeteksi! Menjalankan local biometric solver...');
      const solveRes = await solveAliyunSlider(page, 3);
      if (solveRes.success) {
        console.log('[+] Aliyun slider berhasil dilewati secara lokal!');
      } else {
        console.warn(`[!] Slider solver gagal: ${solveRes.error}`);
      }
    }

    // Tunggu input OTP atau pesan verifikasi
    console.log('[-] Menunggu kode OTP verifikasi email...');
    const otp = await waitForOtp(email, 60000, 2000);

    if (otp) {
      console.log(`[+] OTP diterima untuk ${email}: ${otp}`);
      // Cari input OTP di page
      const otpInput = await page.$('input[name*="otp" i], input[name*="code" i], input[placeholder*="code" i], input[maxlength="6"]');
      if (otpInput) {
        await otpInput.fill(otp);
        await page.waitForTimeout(500);
        const confirmBtn = await page.$('button[type="submit"], button:has-text("Verify"), button:has-text("Confirm")');
        if (confirmBtn) await confirmBtn.click();
      }
    } else {
      console.log('[-] Tidak ada OTP instan yang masuk dalam 60s (atau pendaftaran langsung sukses tanpa OTP)');
    }

    // Cek hasil akhir atau cookies
    await page.waitForTimeout(3000);
    const cookies = await context.cookies();
    const token = cookies.find((c) => c.name === 'token' || (c.name.includes('token') && c.domain.includes('qwen')));

    if (token) {
      console.log(`[SUCCESS] Akun berhasil terdaftar dan login! Token length: ${token.value.length}`);
    } else {
      console.log(`[INFO] Registrasi disubmit untuk ${email}`);
    }

    // Simpan ke catatan lokal
    const outPath = join(process.cwd(), '.qwen', 'registered_accounts.txt');
    appendFileSync(outPath, `${email}:${password}\n`, 'utf8');

    // Auto-import ke QwenGate jika diinginkan
    if (args.autoImport) {
      try {
        console.log(`[-] Menambahkan ${email} ke QwenGate (${args.qwenGateUrl})...`);
        const res = await fetch(`${args.qwenGateUrl}/api/accounts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const resData: any = await res.json().catch(() => ({}));
        if (res.ok && resData.success) {
          console.log(`[+] Sukses auto-inject ${email} ke pool QwenGate!`);
        } else {
          console.warn(`[!] Auto-inject QwenGate info: ${JSON.stringify(resData)}`);
        }
      } catch (err: any) {
        console.warn(`[!] Gagal auto-inject ke QwenGate: ${err.message}`);
      }
    }

    await browser.close();
    return { success: true, email, password };
  } catch (err: any) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[ERROR] Gagal registrasi ${email}:`, err.message);
    return { success: false, email, password, error: err.message };
  }
}

async function main() {
  const args = parseArgs();
  console.log('=== QwenGate Local Auto-Register Runner ===');
  console.log(`Domain:     ${args.domain}`);
  console.log(`Jumlah:     ${args.count}`);
  console.log(`Headless:   ${args.headless}`);
  console.log(`AutoImport: ${args.autoImport}`);
  console.log(`QwenGate:   ${args.qwenGateUrl}`);

  const results: Array<{ email: string; success: boolean; error?: string }> = [];

  for (let i = 1; i <= args.count; i++) {
    const res = await registerOneAccount(args, i);
    results.push(res);
    if (i < args.count) {
      const waitSec = Math.floor(Math.random() * 5) + 3;
      console.log(`[-] Menunggu ${waitSec}s sebelum akun berikutnya...`);
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  console.log('\n===========================================');
  console.log(`Selesai: ${successCount}/${args.count} akun berhasil diproses.`);
}

main().catch(console.error);
