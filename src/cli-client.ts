#!/usr/bin/env bun
/**
 * Qwen Gate CLI Client
 *
 * A clean terminal client for interacting with Qwen Gate's
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Supports:
 *   - Interactive chat mode
 *   - One-shot queries via --prompt
 *   - Streaming SSE responses with progress indicators
 *   - Custom model, temperature, max_tokens
 *   - Critical thinking mode support
 *
 * Usage:
 *   bun run cli-client.ts                          # Interactive mode
 *   bun run cli-client.ts --prompt "Hello"         # One-shot query
 *   bun run cli-client.ts --prompt "..." --model qwen-max --temperature 0.7
 *   bun run cli-client.ts --server http://localhost:8080
 */

import { createInterface } from 'node:readline';

// ── Config from CLI args ──────────────────────────────────────────

interface CLIConfig {
  server: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  prompt: string | null;
  stream: boolean;
  noCriticalThinking: boolean;
}

function parseArgs(): CLIConfig {
  const args = process.argv.slice(2);
  const cfg: CLIConfig = {
    server: 'http://localhost:8080',
    apiKey: process.env.QWEN_GATE_API_KEY || '',
    model: 'qwen-max',
    temperature: 0.7,
    maxTokens: 4096,
    prompt: null,
    stream: true,
    noCriticalThinking: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--server':
      case '-s':
        if (next) cfg.server = next.replace(/\/$/, '');
        i++;
        break;
      case '--api-key':
      case '-k':
        if (next) cfg.apiKey = next;
        i++;
        break;
      case '--model':
      case '-m':
        if (next) cfg.model = next;
        i++;
        break;
      case '--temperature':
      case '-t':
        if (next) cfg.temperature = parseFloat(next);
        i++;
        break;
      case '--max-tokens':
        if (next) cfg.maxTokens = parseInt(next, 10);
        i++;
        break;
      case '--prompt':
      case '-p':
        if (next) cfg.prompt = next;
        i++;
        break;
      case '--no-stream':
        cfg.stream = false;
        break;
      case '--no-critical-thinking':
        cfg.noCriticalThinking = true;
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
    }
  }
  return cfg;
}

function showHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║            Qwen Gate — CLI Client                        ║
║            OpenAI-compatible Terminal Chat                ║
╚══════════════════════════════════════════════════════════╝

USAGE:
  bun run cli-client.ts [OPTIONS]

OPTIONS:
  --prompt, -p <text>       One-shot query
  --model, -m <model>       Model to use (default: qwen-max)
  --temperature, -t <float> Temperature (default: 0.7)
  --max-tokens <int>        Max output tokens (default: 4096)
  --server, -s <url>        Server URL (default: http://localhost:8080)
  --api-key, -k <key>       API key (or env: QWEN_GATE_API_KEY)
  --no-stream               Disable streaming (wait for full response)
  --no-critical-thinking    Disable critical thinking system prompt
  --help, -h                Show this help

ENVIRONMENT:
  QWEN_GATE_API_KEY         API key for authentication

EXAMPLES:
  # Interactive chat mode
  $ bun run cli-client.ts

  # One-shot query
  $ bun run cli-client.ts --prompt "Jelaskan quantum computing"

  # Custom model with temperature
  $ bun run cli-client.ts -p "Risiko investasi crypto" -m qwen-max -t 0.5

  # No streaming (get full response at once)
  $ bun run cli-client.ts -p "Hello" --no-stream
`);
}

// ── Spinner animation ────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerInterval: Timer | null = null;
let spinnerIdx = 0;

function startSpinner(text: string) {
  stopSpinner();
  spinnerIdx = 0;
  process.stderr.write('\x1b[36m' + SPINNER_FRAMES[0] + '\x1b[0m ' + text);
  spinnerInterval = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    process.stderr.write(
      '\r\x1b[K\x1b[36m' + SPINNER_FRAMES[spinnerIdx] + '\x1b[0m ' + text,
    );
  }, 80);
}

function stopSpinner() {
  if (spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
    process.stderr.write('\r\x1b[K');
  }
}

function updateSpinnerText(text: string) {
  if (spinnerInterval) {
    process.stderr.write(
      '\r\x1b[K\x1b[36m' + SPINNER_FRAMES[spinnerIdx] + '\x1b[0m ' + text,
    );
  }
}

// ── Progress tracker ─────────────────────────────────────────────

let currentStep = 0;
let totalSteps = 0;
let stepLabel = '';

function parseProgress(text: string): string | null {
  // Match patterns like "Langkah 2/5", "Step 3/7", "Langkah X/N — ..."
  const langkahRe = /Langkah\s+(\d+)\/(\d+)/i;
  const stepRe = /Step\s+(\d+)\/(\d+)/i;

  let match = text.match(langkahRe) || text.match(stepRe);
  if (match) {
    const step = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    if (step !== currentStep || total !== totalSteps) {
      currentStep = step;
      totalSteps = total;
      return `Langkah ${step}/${total}`;
    }
  }
  return null;
}

function renderProgressBar(step: number, total: number, label: string): string {
  const width = 20;
  const filled = Math.round((step / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `\x1b[33m[${bar}] ${step}/${total}\x1b[0m ${label}`;
}

// ── Thinking time estimator ──────────────────────────────────────

function estimateThinkingTime(prompt: string): number {
  const len = prompt.length;
  if (len < 50) return 2;
  if (len < 200) return 5;
  if (len < 1000) return 10;
  if (len < 5000) return 20;
  return 30;
}

// ── Confidence level display ─────────────────────────────────────

function formatConfidence(text: string): string {
  const lowRe = /confidence\s*level[:\s]*(rendah|low)/i;
  const medRe = /confidence\s*level[:\s]*(sedang|medium)/i;
  const highRe = /confidence\s*level[:\s]*(tinggi|high)/i;

  if (highRe.test(text)) return '\x1b[32m🟢 Confidence: TINGGI\x1b[0m';
  if (medRe.test(text)) return '\x1b[33m🟡 Confidence: SEDANG\x1b[0m';
  if (lowRe.test(text)) return '\x1b[31m🔴 Confidence: RENDAH\x1b[0m';
  return '';
}

// ── Chat completions API call ────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function chatCompletion(
  cfg: CLIConfig,
  messages: ChatMessage[],
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: cfg.stream,
  };

  const response = await fetch(`${cfg.server}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = `HTTP ${response.status}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.error?.message || errMsg;
    } catch {}
    throw new Error(`Server error: ${errMsg}`);
  }

  if (!cfg.stream) {
    const json: any = await response.json();
    return json.choices?.[0]?.message?.content || '';
  }

  // ── Streaming response ───────────────────────────────────────
  return await handleStreamingResponse(response);
}

async function handleStreamingResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';
  let lastLineWasProgress = false;
  let confidenceFound = false;
  const startTime = Date.now();

  startSpinner('Menghubungkan ke Qwen...');

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Handle thinking content
          if (delta.reasoning_content) {
            updateSpinnerText('Berpikir: ' + delta.reasoning_content.slice(-60));
            continue;
          }

          const content = delta.content;
          if (!content) continue;

          // Parse progress indicators
          const progress = parseProgress(content);
          if (progress) {
            if (!lastLineWasProgress) {
              stopSpinner();
              process.stderr.write('\n');
            }
            process.stderr.write(
              '\r\x1b[K' + renderProgressBar(currentStep, totalSteps, progress) + '\r',
            );
            lastLineWasProgress = true;
            continue;
          }

          // On first real content, stop spinner
          if (fullContent === '' || lastLineWasProgress) {
            stopSpinner();
            if (lastLineWasProgress) {
              process.stderr.write('\r\x1b[K');
              // Show estimated time
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              process.stderr.write(`\x1b[90m⏱ ${elapsed}s elapsed\x1b[0m\n\n`);
            }
            lastLineWasProgress = false;
          }

          fullContent += content;
          process.stdout.write(content);
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
    stopSpinner();
  }

  // Show confidence if found
  const confidence = formatConfidence(fullContent);
  if (confidence) {
    process.stdout.write('\n\n' + confidence + '\n');
    confidenceFound = true;
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  process.stderr.write(`\n\x1b[90m✓ Completed in ${elapsed}s\x1b[0m\n`);

  return fullContent;
}

// ── Interactive mode ─────────────────────────────────────────────

async function interactiveMode(cfg: CLIConfig) {
  console.log('\x1b[36m╔══════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║\x1b[0m        \x1b[1mQwen Gate CLI — Interactive Chat\x1b[0m        \x1b[36m║\x1b[0m');
  console.log('\x1b[36m╚══════════════════════════════════════════════╝\x1b[0m');
  console.log(`\x1b[90mServer:\x1b[0m ${cfg.server}`);
  console.log(`\x1b[90mModel:\x1b[0m  ${cfg.model}`);
  console.log(`\x1b[90mTemp:\x1b[0m   ${cfg.temperature}`);
  if (!cfg.stream) console.log(`\x1b[90mMode:\x1b[0m   Non-streaming`);
  console.log(`\x1b[90mCT:\x1b[0m     ${cfg.noCriticalThinking ? 'Off' : 'On (critical thinking)'}`);
  console.log('\n\x1b[90mType your message and press Enter. Ctrl+C to exit.\x1b[0m\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[32m❯\x1b[0m ',
  });

  const messages: ChatMessage[] = [];

  // Inject critical thinking system prompt
  if (!cfg.noCriticalThinking) {
    messages.push({
      role: 'system',
      content:
        'Anda adalah asisten AI yang selalu berpikir kritis. Gunakan format: 1) Thinking Plan 2) Chain-of-Thought (Langkah X/N) 3) Final Answer 4) Confidence Level. Bahasa default: Indonesia.',
    });
  }

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '/exit' || input === '/quit') {
      console.log('\n\x1b[90mGoodbye!\x1b[0m');
      process.exit(0);
    }

    if (input === '/clear') {
      messages.length = 0;
      if (!cfg.noCriticalThinking) {
        messages.push({
          role: 'system',
          content:
            'Anda adalah asisten AI yang selalu berpikir kritis. Gunakan format: 1) Thinking Plan 2) Chain-of-Thought (Langkah X/N) 3) Final Answer 4) Confidence Level. Bahasa default: Indonesia.',
        });
      }
      console.log('\x1b[90mConversation cleared.\x1b[0m\n');
      rl.prompt();
      return;
    }

    if (input === '/help') {
      console.log(`
\x1b[1mCommands:\x1b[0m
  /exit, /quit   Exit the chat
  /clear         Clear conversation history
  /help          Show this help
  /model <name>  Change model (e.g. /model qwen-max)
  /temp <float>  Change temperature (e.g. /temp 0.5)
  /ct-off        Disable critical thinking
  /ct-on         Enable critical thinking
`);
      rl.prompt();
      return;
    }

    if (input.startsWith('/model ')) {
      cfg.model = input.slice(7).trim();
      console.log(`\x1b[90mModel changed to: ${cfg.model}\x1b[0m\n`);
      rl.prompt();
      return;
    }

    if (input.startsWith('/temp ')) {
      cfg.temperature = parseFloat(input.slice(6).trim());
      console.log(`\x1b[90mTemperature changed to: ${cfg.temperature}\x1b[0m\n`);
      rl.prompt();
      return;
    }

    if (input === '/ct-off') {
      cfg.noCriticalThinking = true;
      messages.length = 0;
      console.log('\x1b[90mCritical thinking disabled.\x1b[0m\n');
      rl.prompt();
      return;
    }

    if (input === '/ct-on') {
      cfg.noCriticalThinking = false;
      messages.unshift({
        role: 'system',
        content:
          'Anda adalah asisten AI yang selalu berpikir kritis. Gunakan format: 1) Thinking Plan 2) Chain-of-Thought (Langkah X/N) 3) Final Answer 4) Confidence Level. Bahasa default: Indonesia.',
      });
      console.log('\x1b[90mCritical thinking enabled.\x1b[0m\n');
      rl.prompt();
      return;
    }

    messages.push({ role: 'user', content: input });
    rl.pause();

    try {
      const thinkingTime = estimateThinkingTime(input);
      console.log(`\x1b[90m⏱ Estimasi waktu berpikir: ~${thinkingTime}s\x1b[0m\n`);

      const response = await chatCompletion(cfg, messages);
      messages.push({ role: 'assistant', content: response });
      console.log('\n');
    } catch (err: any) {
      stopSpinner();
      console.error(`\x1b[31m✖ Error: ${err.message}\x1b[0m\n`);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n\n\x1b[90mGoodbye!\x1b[0m');
    process.exit(0);
  });
}

// ── One-shot mode ─────────────────────────────────────────────────

async function oneShotMode(cfg: CLIConfig) {
  const messages: ChatMessage[] = [];

  if (!cfg.noCriticalThinking) {
    messages.push({
      role: 'system',
      content:
        'Anda adalah asisten AI yang selalu berpikir kritis. Gunakan format: 1) Thinking Plan 2) Chain-of-Thought (Langkah X/N) 3) Final Answer 4) Confidence Level. Bahasa default: Indonesia.',
    });
  }

  messages.push({ role: 'user', content: cfg.prompt! });

  const thinkingTime = estimateThinkingTime(cfg.prompt!);
  process.stderr.write(`\x1b[90m⏱ Estimasi waktu berpikir: ~${thinkingTime}s\x1b[0m\n\n`);

  try {
    const response = await chatCompletion(cfg, messages);
    if (!cfg.stream) {
      console.log(response);
    }
    console.log();
  } catch (err: any) {
    stopSpinner();
    console.error(`\x1b[31m✖ Error: ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

// ── Server health check ──────────────────────────────────────────

async function checkServer(cfg: CLIConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.server}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const health: any = await res.json();
      if (health.status === 'ok') return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs();

  // Check server health first
  process.stderr.write('\x1b[90mChecking server...\x1b[0m ');
  const healthy = await checkServer(cfg);
  if (!healthy) {
    console.error(
      `\x1b[31m✖ Cannot connect to server at ${cfg.server}\x1b[0m`,
    );
    console.error('\x1b[90mMake sure Qwen Gate is running:\x1b[0m');
    console.error('  cd qwengates && bun start');
    process.exit(1);
  }
  process.stderr.write('\x1b[32m✓ Connected\x1b[0m\n\n');

  if (cfg.prompt) {
    await oneShotMode(cfg);
  } else {
    await interactiveMode(cfg);
  }
}

main().catch((err) => {
  stopSpinner();
  console.error(`\x1b[31m✖ Fatal: ${err.message}\x1b[0m`);
  process.exit(1);
});
