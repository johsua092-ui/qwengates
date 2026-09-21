import { describe, expect, test } from 'bun:test';
import { generateHumanTrajectory } from '../services/captchaSolver.ts';
import {
  clearOtp,
  extractOtpFromText,
  getAllActiveOtps,
  getOtp,
  storeOtp,
  waitForOtp,
} from '../services/otpService.ts';

describe('Local Captcha Solver — Trajectory & Physics', () => {
  test('generateHumanTrajectory produces non-empty list of steps ending at target distance', () => {
    const distance = 280;
    const trajectory = generateHumanTrajectory(distance);

    expect(trajectory.length).toBeGreaterThan(20);
    expect(trajectory.length).toBeLessThan(60);

    const lastStep = trajectory[trajectory.length - 1];
    expect(lastStep.x).toBe(distance);

    // Verify each step has valid coordinate and human delay
    for (const step of trajectory) {
      expect(typeof step.x).toBe('number');
      expect(typeof step.y).toBe('number');
      expect(step.y).toBeGreaterThanOrEqual(-10);
      expect(step.y).toBeLessThanOrEqual(10);
      expect(step.delay).toBeGreaterThanOrEqual(5);
      expect(step.delay).toBeLessThanOrEqual(50);
    }
  });

  test('generateHumanTrajectory produces smooth acceleration and deceleration', () => {
    const distance = 300;
    const trajectory = generateHumanTrajectory(distance);

    // Initial movement should be small
    expect(trajectory[0].x).toBeLessThanOrEqual(30);

    // Mid point movement should advance
    const midIndex = Math.floor(trajectory.length / 2);
    expect(trajectory[midIndex].x).toBeGreaterThan(50);
  });
});

describe('Local OTP Service', () => {
  test('extractOtpFromText correctly extracts 6-digit codes', () => {
    expect(extractOtpFromText('Your verification code is 849201. Do not share it.')).toBe('849201');
    expect(extractOtpFromText('Qwen security code: 192837')).toBe('192837');
    expect(extractOtpFromText('验证码为 654321，有效期10分钟')).toBe('654321');
    expect(extractOtpFromText('No numbers here')).toBeNull();
  });

  test('storeOtp, getOtp, and clearOtp lifecycle', () => {
    const email = 'test_user_01@mail.aikernel.qzz.io';
    const otp = '772183';

    storeOtp(email, otp, 'test_source', 5000);
    expect(getOtp(email)).toBe(otp);

    // Case-insensitivity check
    expect(getOtp('TEST_USER_01@mail.aikernel.qzz.io')).toBe(otp);

    // Clear
    expect(clearOtp(email)).toBe(true);
    expect(getOtp(email)).toBeNull();
  });

  test('waitForOtp resolves immediately when OTP is already present', async () => {
    const email = 'fast@mail.aikernel.qzz.io';
    storeOtp(email, '999111');

    const resolved = await waitForOtp(email, 1000, 50);
    expect(resolved).toBe('999111');
    clearOtp(email);
  });

  test('waitForOtp resolves asynchronously when OTP is pushed mid-wait', async () => {
    const email = 'async@mail.aikernel.qzz.io';

    setTimeout(() => {
      storeOtp(email, '555222');
    }, 100);

    const resolved = await waitForOtp(email, 2000, 50);
    expect(resolved).toBe('555222');
    clearOtp(email);
  });

  test('waitForOtp times out gracefully when OTP never arrives', async () => {
    const email = 'never@mail.aikernel.qzz.io';
    const resolved = await waitForOtp(email, 150, 50);
    expect(resolved).toBeNull();
  });
});
