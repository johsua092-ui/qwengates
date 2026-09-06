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
  error?: string;
}

export function getCaptchaConfig(): CaptchaSolverConfig | null {
  const apiKey = config.get('CAPSOLVER_API_KEY');
  if (!apiKey) return null;
  return { apiKey, timeout: 120000 };
}

export async function solveCaptcha(page: any): Promise<SolveResult> {
  const cfg = getCaptchaConfig();
  if (!cfg) return { success: false, error: 'No API key configured' };

  try {
    logStore.log('info', 'captcha', 'Detecting captcha type on page...');
    
    // Detect captcha type and extract sitekey
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

    // Create task
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
        pageAction: 'login'
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

    // Poll for result
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

      await new Promise(r => setTimeout(r, 3000));
    }

    if (!token) {
       logStore.log('error', 'captcha', `Capsolver task ${taskId} timed out`);
       return { success: false, error: 'Capsolver task timed out' };
    }

    // Inject token
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

    return { success: true, token };
  } catch (err: any) {
    logStore.log('error', 'captcha', `Error solving captcha: ${err.message}`);
    return { success: false, error: err.message };
  }
}
