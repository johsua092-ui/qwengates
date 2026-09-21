import { logStore } from './logStore.ts';
import { config } from './configService.ts';

const CAPSOLVER_API = 'https://api.capsolver.com';

export interface CaptchaSolverConfig {
  apiKey: string;
  timeout?: number;
}

export interface SolveResult {
  success: boolean;
  token?: string;
  type?: 'aliyun_slider' | 'hcaptcha' | 'recaptcha_v2' | 'recaptcha_v3';
  error?: string;
}

export interface TrajectoryStep {
  x: number;
  y: number;
  delay: number;
}

export const ALIYUN_SLIDER_SELECTORS = [
  '#nc_1_n1z',
  '.btn_slide',
  '.nc_iconfont.btn_slide',
  'span[id*="_n1z"]',
  '#nocaptcha .btn_slide',
  '[class*="btn_slide"]',
  '#nc_1_wrapper',
  '.nc_scale',
  '#nocaptcha',
  '[id*="baxia-dialog"]',
  'iframe[src*="baxia"]',
  'iframe[src*="awsc"]',
];

const ALIYUN_BUTTON_SELECTORS = [
  '#nc_1_n1z',
  '.btn_slide',
  '.nc_iconfont.btn_slide',
  'span[id*="_n1z"]',
  '#nocaptcha .btn_slide',
  '[class*="btn_slide"]',
];

export function getCaptchaConfig(): CaptchaSolverConfig | null {
  const apiKey = config.get('CAPSOLVER_API_KEY');
  if (!apiKey) return null;
  return { apiKey, timeout: 120000 };
}

/**
 * Generate a realistic biometric human mouse trajectory for dragging a slider.
 * Uses cubic bezier easing, micro-jitters on Y, and slight overshoot + correction.
 */
export function generateHumanTrajectory(distance: number): TrajectoryStep[] {
  const steps: TrajectoryStep[] = [];
  let curX = 0;
  let curY = 0;

  const numSteps = Math.floor(Math.random() * 15) + 28; // 28 - 42 micro-steps
  const overshoot = Math.floor(Math.random() * 4) + 2; // 2 to 5px overshoot
  const targetWithOvershoot = distance + overshoot;

  for (let i = 1; i <= numSteps; i++) {
    const t = i / numSteps;
    // Cubic bezier ease-in-out curve
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const targetStepX = Math.round(ease * targetWithOvershoot);
    const dx = targetStepX - curX;

    // Small vertical human tremor (-1, 0, 1 px) with center-seeking damping
    let dy = 0;
    if (i % 4 === 0) {
      if (curY > 2) dy = -1;
      else if (curY < -2) dy = 1;
      else dy = Math.random() > 0.5 ? 1 : -1;
    }

    curX += dx;
    curY += dy;

    // Human inter-step timing: 8ms to 22ms
    const delay = Math.floor(Math.random() * 14) + 8;
    steps.push({ x: curX, y: curY, delay });
  }

  // Settle back to exact target from overshoot
  const excess = curX - distance;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      curX -= 1;
      steps.push({ x: curX, y: curY, delay: Math.floor(Math.random() * 10) + 15 });
    }
  }

  return steps;
}

/**
 * Check if the page or any iframe contains an Aliyun / AWSC / NoCaptcha slider.
 */
export async function detectAliyunSlider(page: any): Promise<boolean> {
  try {
    const foundOnMain = await page.evaluate((selectors: string[]) => {
      for (const sel of selectors) {
        if (document.querySelector(sel)) return true;
      }
      return false;
    }, ALIYUN_SLIDER_SELECTORS);

    if (foundOnMain) return true;

    // Check inside any iframe
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    for (const frame of frames) {
      try {
        const foundInFrame = await frame.evaluate((selectors: string[]) => {
          for (const sel of selectors) {
            if (document.querySelector(sel)) return true;
          }
          return false;
        }, ALIYUN_SLIDER_SELECTORS);
        if (foundInFrame) return true;
      } catch {}
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if Aliyun slider is solved / verified.
 */
export async function checkAliyunSolved(page: any, targetFrame?: any): Promise<boolean> {
  const evalTarget = targetFrame || page;
  try {
    return await evalTarget.evaluate(() => {
      const text = document.body ? document.body.innerText || '' : '';
      if (text.includes('验证通过') || text.includes('Verified') || text.includes('Verification passed')) {
        return true;
      }
      const successEl = document.querySelector(
        '.nc-lang-cnt[data-nc-lang="_yes"], .btn_ok, .nc_ok, [class*="nc_ok"], span.nc_iconfont.btn_ok',
      );
      if (successEl) return true;

      const slider = document.querySelector('#nc_1_n1z, .btn_slide');
      const errorText = document.querySelector('.nc-lang-cnt[data-nc-lang="_no"]');
      // If slider disappeared without error flag
      if (!slider && !errorText) return true;

      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Solve Aliyun / AWSC slider locally without 3rd party services.
 */
export async function solveAliyunSlider(page: any, maxRetries = 3): Promise<SolveResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logStore.log('info', 'captcha', `[AliyunSolver] Attempt ${attempt}/${maxRetries} to solve local slider...`);

    let sliderEl: any = null;
    let targetFrame: any = null;

    // 1. Search main page
    for (const sel of ALIYUN_BUTTON_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) {
          sliderEl = el;
          break;
        }
      } catch {}
    }

    // 2. Search frames
    if (!sliderEl && typeof page.frames === 'function') {
      for (const frame of page.frames()) {
        for (const sel of ALIYUN_BUTTON_SELECTORS) {
          try {
            const el = await frame.$(sel);
            if (el && (await el.isVisible())) {
              sliderEl = el;
              targetFrame = frame;
              break;
            }
          } catch {}
        }
        if (sliderEl) break;
      }
    }

    if (!sliderEl) {
      const alreadySolved = await checkAliyunSolved(page, targetFrame);
      if (alreadySolved) {
        logStore.log('info', 'captcha', '[AliyunSolver] Slider already solved or verified');
        return { success: true, type: 'aliyun_slider' };
      }
      logStore.log('warn', 'captcha', '[AliyunSolver] Slider button not found or not visible');
      return { success: false, error: 'Slider element not found' };
    }

    const box = await sliderEl.boundingBox();
    if (!box) {
      logStore.log('warn', 'captcha', '[AliyunSolver] Could not get bounding box for slider');
      return { success: false, error: 'Failed to get slider bounding box' };
    }

    // Measure track width
    let trackWidth = 280;
    try {
      const trackSel = '#nc_1__scale_text, .nc_scale, .nc_scale_text, [id*="_scale_text"], #nc_1_wrapper';
      const trackEl = targetFrame ? await targetFrame.$(trackSel) : await page.$(trackSel);
      if (trackEl) {
        const trackBox = await trackEl.boundingBox();
        if (trackBox && trackBox.width > 80) {
          trackWidth = Math.round(trackBox.width - box.width);
        }
      }
    } catch {}

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Simulate drag
    await page.mouse.move(startX, startY);
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 120) + 100));
    await page.mouse.down();

    const trajectory = generateHumanTrajectory(trackWidth);
    for (const step of trajectory) {
      await page.mouse.move(startX + step.x, startY + step.y);
      await new Promise((r) => setTimeout(r, step.delay));
    }

    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 80) + 80));
    await page.mouse.up();

    // Wait for validation
    await new Promise((r) => setTimeout(r, 1500));

    const isSolved = await checkAliyunSolved(page, targetFrame);
    if (isSolved) {
      logStore.log('info', 'captcha', '[AliyunSolver] Slider successfully solved!');
      return { success: true, type: 'aliyun_slider' };
    }

    logStore.log('warn', 'captcha', `[AliyunSolver] Attempt ${attempt} failed, checking for refresh button...`);
    try {
      const refreshSel = '.nc_scale .scale_text2 a, #nc_1_refresh1, [class*="btn_refresh"]';
      const refreshEl = targetFrame ? await targetFrame.$(refreshSel) : await page.$(refreshSel);
      if (refreshEl && (await refreshEl.isVisible())) {
        await refreshEl.click();
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch {}
  }

  return { success: false, error: 'Exceeded max attempts for local Aliyun slider' };
}

/**
 * Master captcha solver.
 * 1. Checks and solves Aliyun slider locally (0 external dependencies, no Capsolver).
 * 2. Falls back to Capsolver for hCaptcha / reCaptcha if configured.
 */
export async function solveCaptcha(page: any): Promise<SolveResult> {
  try {
    // 1. Check for Aliyun slider first (pure local solution)
    const isAliyun = await detectAliyunSlider(page);
    if (isAliyun) {
      logStore.log('info', 'captcha', 'Detected Aliyun/AWSC slider captcha, solving locally...');
      return await solveAliyunSlider(page);
    }

    // 2. External captchas (hCaptcha, reCaptcha) require Capsolver
    const cfg = getCaptchaConfig();
    if (!cfg) {
      logStore.log('warn', 'captcha', 'Non-Aliyun captcha detected but no CAPSOLVER_API_KEY configured');
      return { success: false, error: 'No Capsolver API key configured for external captcha' };
    }

    logStore.log('info', 'captcha', 'Detecting external captcha type on page...');

    const captchaInfo = await page.evaluate(() => {
      // check for hcaptcha
      const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
      if (hcaptchaIframe) {
        const src = hcaptchaIframe.getAttribute('src') || '';
        const sitekeyMatch = src.match(/sitekey=([^&]+)/);
        if (sitekeyMatch) return { type: 'hcaptcha', sitekey: sitekeyMatch[1] };
      }

      const hcaptchaDiv = document.querySelector('[data-sitekey][class*="h-captcha"]');
      if (hcaptchaDiv) {
        return { type: 'hcaptcha', sitekey: hcaptchaDiv.getAttribute('data-sitekey') };
      }

      // check for recaptcha
      const recaptchaIframe = document.querySelector('iframe[src*="google.com/recaptcha/api2"]');
      if (recaptchaIframe) {
        const src = recaptchaIframe.getAttribute('src') || '';
        const sitekeyMatch = src.match(/k=([^&]+)/);
        if (sitekeyMatch) return { type: 'recaptcha_v2', sitekey: sitekeyMatch[1] };
      }

      const recaptchaDiv = document.querySelector('[data-sitekey][class*="g-recaptcha"]');
      if (recaptchaDiv) {
        return { type: 'recaptcha_v2', sitekey: recaptchaDiv.getAttribute('data-sitekey') };
      }

      // Check for v3
      const recaptchaV3Script = document.querySelector('script[src*="render="]');
      if (recaptchaV3Script) {
        const src = recaptchaV3Script.getAttribute('src') || '';
        const sitekeyMatch = src.match(/render=([^&]+)/);
        if (sitekeyMatch) return { type: 'recaptcha_v3', sitekey: sitekeyMatch[1] };
      }

      return null;
    });

    if (!captchaInfo) {
      logStore.log('warn', 'captcha', 'Could not detect captcha type or sitekey');
      return { success: false, error: 'Could not detect captcha type or sitekey' };
    }

    const pageUrl = await page.url();
    logStore.log('info', 'captcha', `Detected ${captchaInfo.type} with sitekey ${captchaInfo.sitekey}`);

    let taskData: any = {};
    if (captchaInfo.type === 'hcaptcha') {
      taskData = {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: captchaInfo.sitekey,
      };
    } else if (captchaInfo.type === 'recaptcha_v2') {
      taskData = {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: captchaInfo.sitekey,
      };
    } else if (captchaInfo.type === 'recaptcha_v3') {
      taskData = {
        type: 'ReCaptchaV3TaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: captchaInfo.sitekey,
        pageAction: 'login',
      };
    }

    const createTaskRes = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: cfg.apiKey,
        task: taskData,
      }),
    });
    const createTaskData = await createTaskRes.json();

    if (createTaskData.errorId !== 0) {
      logStore.log('error', 'captcha', `Capsolver createTask failed: ${createTaskData.errorDescription}`);
      return { success: false, error: createTaskData.errorDescription };
    }

    const taskId = createTaskData.taskId;
    logStore.log('info', 'captcha', `Created Capsolver task ${taskId}, polling for result...`);

    const startTime = Date.now();
    const timeout = cfg.timeout || 120000;
    let token: string | undefined = undefined;

    while (Date.now() - startTime < timeout) {
      const getTaskRes = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: cfg.apiKey,
          taskId: taskId,
        }),
      });
      const getTaskData = await getTaskRes.json();

      if (getTaskData.errorId !== 0) {
        logStore.log('error', 'captcha', `Capsolver getTaskResult failed: ${getTaskData.errorDescription}`);
        return { success: false, error: getTaskData.errorDescription };
      }

      if (getTaskData.status === 'ready') {
        token = getTaskData.solution.gRecaptchaResponse;
        logStore.log('info', 'captcha', `Capsolver task ${taskId} solved successfully`);
        break;
      }

      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!token) {
      logStore.log('error', 'captcha', `Capsolver task ${taskId} timed out`);
      return { success: false, error: 'Capsolver task timed out' };
    }

    logStore.log('info', 'captcha', 'Injecting captcha token into page...');

    await page.evaluate((solToken: string) => {
      const gResponse = document.querySelector('[name="g-recaptcha-response"]') as HTMLTextAreaElement;
      if (gResponse) gResponse.value = solToken;

      const hResponse = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement;
      if (hResponse) hResponse.value = solToken;

      const forms = document.forms;
      for (let i = 0; i < forms.length; i++) {
        if (forms[i].innerHTML.includes('g-recaptcha') || forms[i].innerHTML.includes('h-captcha')) {
          forms[i].dispatchEvent(new Event('submit', { cancelable: true }));
          break;
        }
      }
    }, token);

    return { success: true, token, type: captchaInfo.type as any };
  } catch (err: any) {
    logStore.log('error', 'captcha', `Error solving captcha: ${err.message}`);
    return { success: false, error: err.message };
  }
}
