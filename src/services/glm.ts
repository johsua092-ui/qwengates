/*
 * File: glm.ts
 * Z.AI GLM provider — OpenAI-compatible passthrough.
 *
 * Same shape as deepseek.ts on purpose: both providers authenticate with a
 * bearer key against an OpenAI-compatible endpoint, so the Qwen machinery
 * (Playwright, session pool, token refresh, CAPTCHA) is not involved at all.
 *
 * Model IDs are taken from Z.AI's official pricing page. Note the trap:
 * `glm-4.7-flash` is FREE while `glm-4.7-flashx` (one extra letter) is billed at
 * $0.07/1M input — they are different models.
 *
 * A single endpoint serves every model, so routing is purely by name.
 */

/** International endpoint. The CN mirror is open.bigmodel.cn. */
export const GLM_BASE_URL = 'https://api.z.ai/api/paas/v4';

/** Models this provider serves, cheapest/most useful first. */
export const GLM_MODELS = [
  {
    id: 'glm-4.7-flash',
    label: 'GLM-4.7-Flash',
    description: 'Free, strong reasoning/coding (text only)',
    vision: false,
    reasoning: true,
    free: true,
  },
  {
    id: 'glm-4.5-flash',
    label: 'GLM-4.5-Flash',
    description: 'Free, fast general chat (text only)',
    vision: false,
    reasoning: false,
    free: true,
  },
  {
    id: 'glm-4.6v-flash',
    label: 'GLM-4.6V-Flash',
    description: 'Free vision model (text + images)',
    vision: true,
    reasoning: false,
    free: true,
  },
  {
    id: 'glm-4.7',
    label: 'GLM-4.7',
    description: 'Paid flagship reasoning/coding (text only)',
    vision: false,
    reasoning: true,
    free: false,
  },
  {
    id: 'glm-5.3',
    label: 'GLM-5.3',
    description: 'Paid frontier model (text only)',
    vision: false,
    reasoning: true,
    free: false,
  },
] as const;

export type GlmModelId = (typeof GLM_MODELS)[number]['id'];

/** Every model name this provider owns. Used for routing decisions. */
export const GLM_MODEL_IDS: string[] = GLM_MODELS.map((m) => m.id);

/**
 * True when a requested model name should be served by GLM.
 *
 * Only the `glm-` prefix is claimed: that namespace cannot collide with Qwen or
 * DeepSeek names, so a request is never misrouted.
 */
export function isGlmModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return String(model).toLowerCase().startsWith('glm-');
}

/**
 * GLM rejects image input on a text-only model. Catch it here so the client gets
 * a clear message instead of an opaque upstream 400.
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

export interface GlmCallOptions {
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

export interface GlmResult {
  ok: boolean;
  status: number;
  /** Present when ok — the upstream Response (SSE body or JSON). */
  response?: Response;
  /** Present when !ok — a normalised OpenAI error body. */
  error?: { message: string; type: string; code: string };
}

/**
 * Build the upstream request body. Unknown client fields pass through so
 * GLM-only knobs keep working, but our resolved values win.
 */
function buildUpstreamBody(opts: GlmCallOptions): Record<string, unknown> {
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

  // Ask for usage on streaming responses so billing has real numbers.
  if (opts.stream) body.stream_options = { ...((body.stream_options as object) || {}), include_usage: true };

  return body;
}

/**
 * Call GLM's OpenAI-compatible endpoint.
 *
 * Never throws for upstream failures — returns a normalised error so the caller
 * picks the HTTP status. The body is handed back as a stream so streaming and
 * non-streaming share one path.
 */
export async function callGlm(opts: GlmCallOptions): Promise<GlmResult> {
  if (!opts.apiKey) {
    return {
      ok: false,
      status: 503,
      error: {
        message: 'GLM is not configured: set GLM_API_KEY',
        type: 'configuration_error',
        code: 'glm_not_configured',
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

  const spec = GLM_MODELS.find((m) => m.id === opts.model);
  if (hasImageContent(opts.messages) && spec && !spec.vision) {
    return {
      ok: false,
      status: 400,
      error: {
        message: `Model "${opts.model}" does not support image input. Use "glm-4.6v-flash" for vision.`,
        type: 'invalid_request_error',
        code: 'vision_not_supported',
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${GLM_BASE_URL}/chat/completions`, {
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
        message: aborted ? 'Request aborted by client' : `GLM request failed: ${message}`,
        type: aborted ? 'aborted' : 'upstream_error',
        code: aborted ? 'client_closed_request' : 'glm_unreachable',
      },
    };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {}
    let message = `GLM returned ${response.status}`;
    let code = 'glm_error';
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
      if (parsed?.error?.code) code = String(parsed.error.code);
    } catch {
      if (detail) message = detail;
    }
    return { ok: false, status: response.status, error: { message, type: 'upstream_error', code } };
  }

  return { ok: true, status: response.status, response };
}

/** Describe this provider's models for `/v1/models`. */
export function listGlmModels() {
  return GLM_MODELS.map((m) => ({
    id: m.id as string,
    object: 'model',
    owned_by: 'zai',
    label: m.label as string,
    description: m.description as string,
    vision: m.vision as boolean,
    reasoning: m.reasoning as boolean,
    free: m.free as boolean,
  }));
}
