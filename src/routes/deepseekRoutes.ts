/*
 * File: deepseekRoutes.ts
 * DeepSeek provider handler for /v1/chat/completions.
 *
 * Kept apart from the Qwen flow on purpose: DeepSeek needs no browser, no
 * account rotation and no session handling, so none of that risk lives here.
 * Both streaming and non-streaming responses are proxied to the client, and
 * usage is billed against the gateway API key exactly like Qwen requests.
 */

import type { Context } from 'hono';
import { callDeepSeek, DEEPSEEK_MODELS } from '../services/deepseek.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { recordApiKeyUsage } from '../services/apiKeyStore.ts';
import type { OpenAIRequest } from '../types/openai.ts';

export interface DeepSeekHandlerArgs {
  c: Context;
  logId: string;
  body: OpenAIRequest;
  messages: unknown[];
  isStream: boolean;
}

/** Extract the usage numbers from a DeepSeek response (stream or JSON). */
function readUsage(usage: unknown): { prompt: number; completion: number } {
  const u = (usage || {}) as Record<string, unknown>;
  const prompt = Number(u.prompt_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? 0) || 0;
  return { prompt, completion };
}

/** Charge the gateway API key, tolerating the unauthenticated (legacy) path. */
function bill(c: Context, prompt: number, completion: number): void {
  const keyId = (c.get('apiKeyId') as string | undefined) || undefined;
  if (!keyId) return;
  try {
    recordApiKeyUsage(keyId, prompt, completion);
  } catch (err) {
    // Billing must never break a response that already succeeded.
    logStore.log('warn', 'deepseek', `Failed to record usage: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Shared upstream call, mapping our internal shape onto the provider. */
async function callUpstream(args: DeepSeekHandlerArgs, signal: AbortSignal) {
  const { body, messages, isStream } = args;
  return callDeepSeek({
    apiKey: config.get('DEEPSEEK_API_KEY') || '',
    model: body.model,
    messages,
    stream: isStream,
    tools: body.tools,
    toolChoice: body.tool_choice,
    temperature: body.temperature,
    topP: body.top_p,
    maxTokens: body.max_tokens,
    stop: body.stop,
    responseFormat: body.response_format,
    signal,
  });
}

/** Non-streaming: buffer the upstream JSON, bill once, return it as-is. */
async function handleNonStreaming(args: DeepSeekHandlerArgs, signal: AbortSignal) {
  const { c, logId } = args;
  const result = await callUpstream(args, signal);

  if (!result.ok || !result.response) {
    const err = result.error!;
    logStore.log('error', 'deepseek', `[DeepSeek] ${err.code}: ${err.message}`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = err.code;
    });
    logStore.finalizeRequest(logId);
    return c.json({ error: { message: err.message, type: err.type, param: null, code: err.code } }, result.status as never);
  }

  const payload = (await result.response.json()) as Record<string, any>;
  const usage = readUsage(payload?.usage);
  bill(c, usage.prompt, usage.completion);

  logStore.updateEntry(logId, (entry) => {
    entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
    entry.finalResponse.finishReason = payload?.choices?.[0]?.finish_reason || 'stop';
    entry.finalResponse.toolCallCount = payload?.choices?.[0]?.message?.tool_calls?.length || 0;
    const content = payload?.choices?.[0]?.message?.content;
    entry.finalResponse.contentPreview = typeof content === 'string' ? content.slice(0, 500) : '';
  });
  logStore.finalizeRequest(logId);

  return c.json(payload as never);
}

/**
 * Streaming: pipe DeepSeek's SSE to the client verbatim while sniffing the
 * usage chunk so billing stays accurate. We do NOT rewrite the stream — the
 * client sees exactly what DeepSeek sent.
 */
async function handleStreaming(args: DeepSeekHandlerArgs, signal: AbortSignal) {
  const { c, logId } = args;
  const result = await callUpstream(args, signal);

  if (!result.ok || !result.response) {
    const err = result.error!;
    logStore.log('error', 'deepseek', `[DeepSeek] ${err.code}: ${err.message}`);
    logStore.finalizeRequest(logId);
    return c.json({ error: { message: err.message, type: err.type, param: null, code: err.code } }, result.status as never);
  }

  const upstream = result.response;
  const encoder = new TextEncoder();
  let prompt = 0;
  let completion = 0;
  let buffered = '';
  let finalized = false;

  const finalize = (finishReason: string) => {
    if (finalized) return;
    finalized = true;
    bill(c, prompt, completion);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = finishReason;
    });
    logStore.finalizeRequest(logId);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body?.getReader();
      if (!reader) {
        controller.close();
        finalize('upstream_error');
        return;
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Pass bytes through untouched.
          controller.enqueue(value);

          // Sniff for usage/tool-call metadata without altering the stream.
          buffered += new TextDecoder().decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed?.usage) {
                const u = readUsage(parsed.usage);
                prompt = u.prompt;
                completion = u.completion;
              }
              const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
              if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                logStore.updateEntry(logId, (entry) => {
                  entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
                  entry.finalResponse.toolCallCount = (entry.finalResponse.toolCallCount || 0) + toolCalls.length;
                });
              }
            } catch {
              // Non-JSON keep-alive lines are fine to ignore.
            }
          }
        }
        controller.close();
        finalize('stop');
      } catch (err) {
        if (!finalized) {
          logStore.log('warn', 'deepseek', `[DeepSeek] stream error: ${err instanceof Error ? err.message : String(err)}`);
          finalize('stream_error');
        }
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      // Client went away: still bill whatever the model produced.
      finalize('client_cancelled');
      try {
        upstream.body?.cancel();
      } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * Entry point for DeepSeek-backed requests. Chooses streaming vs buffered and
 * wires client-abort handling.
 */
export async function handleDeepSeekRequest(args: DeepSeekHandlerArgs) {
  const { c, logId, body } = args;
  const model = DEEPSEEK_MODELS.find((m) => m.id === body.model);

  logStore.log(
    'info',
    'deepseek',
    `[DeepSeek] model=${body.model} stream=${args.isStream} msgs=${args.messages.length}${model ? ` (${model.label})` : ''}`,
  );

  const controller = new AbortController();
  // Abort upstream work if the client disconnects.
  c.req.raw.signal?.addEventListener('abort', () => {
    try {
      controller.abort();
    } catch {}
  });

  try {
    return args.isStream
      ? await handleStreaming(args, controller.signal)
      : await handleNonStreaming(args, controller.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStore.log('error', 'deepseek', `[DeepSeek] unexpected failure: ${message}`);
    logStore.finalizeRequest(logId);
    return c.json(
      { error: { message: `DeepSeek request failed: ${message}`, type: 'upstream_error', param: null, code: 'deepseek_failed' } },
      502 as never,
    );
  }
}
