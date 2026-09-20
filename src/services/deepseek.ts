/**
 * DeepSeek provider — OpenAI-compatible passthrough.
 *
 * Deliberately simple: DeepSeek authenticates with a single API key, so none of
 * the Qwen machinery (Playwright, session pool, token refresh, CAPTCHA) applies
 * here. We translate the gateway's internal request shape into DeepSeek's and
 * stream the response back through untouched.
 *
 * Model IDs are the CURRENT upstream names, not the legacy aliases:
 *   - `deepseek-flash`   → DeepSeek-V4.1-Flash
 *   - `deepseek-v4-pro`  → DeepSeek-V4-Pro-0813
 *
 * `deepseek-chat` / `deepseek-reasoner` are intentionally NOT used: DeepSeek
 * retires those aliases on 2026-07-24, and `deepseek-v4-flash` no longer selects
 * its original checkpoint (it is an alias for V4.1-Flash).
 */

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** Models this provider serves, in the order we advertise them. */
export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash',
    description: 'Fast default chat model (text + images)',
    vision: true,
    reasoning: false,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro-0813',
    description: 'Frontier reasoning/coding model (text only)',
    vision: false,
    reasoning: true,
  },
] as const;

export type DeepSeekModelId = (typeof DEEPSEEK_MODELS)[number]['id'];

/** Every model name this provider owns. Used for routing decisions. */
export const DEEPSEEK_MODEL_IDS: string[] = DEEPSEEK_MODELS.map((m) => m.id);

/** True when a requested model name should be served by DeepSeek. */
export function isDeepSeekModel(model: string | undefined | null): boolean {
  if (!model) return false;
  const name = String(model).toLowerCase();
  return name.startsWith('deepseek-') || name.startsWith('deepseek');
}

/**
 * DeepSeek rejects an image message on a text-only model, so catch it early
 * with a clear error instead of surfacing an opaque upstream 400.
 */
function hasImageContent(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = (part as { type?: string })?.type;
      if (type === 'image_url' || type === 'input_image' || type === 'image') return true;
    }
  }
  return false;
}

export interface DeepSeekCallOptions {
  apiKey: string;
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: unknown;
  toolChoice?: unknown;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: unknown;
  responseFormat?: unknown;
  signal?: AbortSignal;
  /** Raw passthrough of any other OpenAI fields the client sent. */
  extra?: Record<string, unknown>;
}

export interface DeepSeekResult {
  ok: boolean;
  status: number;
  /** Present when ok — the upstream Response (SSE body or JSON). */
  response?: Response;
  /** Present when !ok — a normalised OpenAI error body. */
  error?: { message: string; type: string; code: string };
}

/**
 * Build the upstream request body. Unknown client fields are passed through so
 * DeepSeek-only knobs keep working, but our own resolved values win.
 */
function buildUpstreamBody(opts: DeepSeekCallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(opts.extra || {}) };
  body.model = opts.model;
  body.messages = opts.messages;
  body.stream = opts.stream;

  if (opts.tools) body.tools = opts.tools;
  if (opts.toolChoice) body.tool_choice = opts.toolChoice;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (typeof opts.topP === 'number') body.top_p = opts.topP;
  if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
  if (opts.stop) body.stop = opts.stop;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  // Ask for the usage block on streaming responses so billing has real numbers.
  if (opts.stream) body.stream_options = { ...((body.stream_options as object) || {}), include_usage: true };

  return body;
}

/**
 * Call DeepSeek's OpenAI-compatible endpoint.
 *
 * Never throws for upstream failures — returns a normalised error so the caller
 * can decide the HTTP status. Reads the body as a stream and hands it straight
 * back, so streaming and non-streaming share one path.
 */
export async function callDeepSeek(opts: DeepSeekCallOptions): Promise<DeepSeekResult> {
  if (!opts.apiKey) {
    return {
      ok: false,
      status: 503,
      error: {
        message: 'DeepSeek is not configured: set DEEPSEEK_API_KEY',
        type: 'configuration_error',
        code: 'deepseek_not_configured',
      },
    };
  }
  if (!opts.model) {
    return {
      ok: false,
      status: 400,
      error: { message: 'Missing model', type: 'invalid_request_error', code: 'model_required' },
    };
  }

  // Guard: a vision model is required for image input.
  const spec = DEEPSEEK_MODELS.find((m) => m.id === opts.model);
  if (hasImageContent(opts.messages) && spec && !spec.vision) {
    return {
      ok: false,
      status: 400,
      error: {
        message: `Model "${opts.model}" does not support image input. Use "deepseek-flash" for vision.`,
        type: 'invalid_request_error',
        code: 'vision_not_supported',
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: opts.stream ? 'text/event-stream' : 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(buildUpstreamBody(opts)),
      signal: opts.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 499 : 502,
      error: {
        message: aborted ? 'Request aborted by client' : `DeepSeek request failed: ${message}`,
        type: aborted ? 'aborted' : 'upstream_error',
        code: aborted ? 'client_closed_request' : 'deepseek_unreachable',
      },
    };
  }

  if (!response.ok) {
    // Read the error body but never leak it raw — normalise to OpenAI's shape.
    let detail = '';
    try {
      const text = await response.text();
      detail = text.slice(0, 500);
    } catch {}
    let message = `DeepSeek returned ${response.status}`;
    let code = 'deepseek_error';
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
      if (parsed?.error?.code) code = parsed.error.code;
    } catch {
      if (detail) message = detail;
    }
    return {
      ok: false,
      status: response.status,
      error: { message, type: 'upstream_error', code },
    };
  }

  return { ok: true, status: response.status, response };
}

/**
 * List models for `/v1/models`. Kept here so both providers describe themselves
 * the same way.
 */
export function listDeepSeekModels() {
  return DEEPSEEK_MODELS.map((m) => ({
    id: m.id as string,
    object: 'model',
    owned_by: 'deepseek',
    label: m.label as string,
    description: m.description as string,
    vision: m.vision as boolean,
    reasoning: m.reasoning as boolean,
  }));
}
