import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { logStore } from '../services/logStore.ts';
import { sessionPool } from '../services/sessionPool.ts';
import type { Message, OpenAIRequest } from '../types/openai.ts';
import { type AmplificationGuardState } from './chatHelpers.ts';
import { type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { handlePostStreamCompletion, runStreamLoop } from './streamLoop.ts';
import { buildChunkEvent, makeChoice, writeEvent } from './writeHelpers.ts';

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  qwenLogFile?: string;
  retryStream?: (lastFailedEmail?: string) => Promise<{
    stream: ReadableStream;
    qwenAbortController: AbortController;
    resolvedEmail: string;
    session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
    initialParentId: string | null;
    sessionHeaders: any;
  } | null>;
}

function buildPromptString(messages: Message[]): string {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : String(m.content ?? '');
      return `${m.role}: ${content}`;
    })
    .join('\n\n');
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, cleanOutput } = ctx;
  const finalPrompt = buildPromptString(body.messages);
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');
  c.header('X-Accel-Buffering', 'no');
  return honoStream(c, async (streamWriter: any) => {
    const MAX_STREAM_RETRIES = 3;
    let streamReleased = false;
    let heartbeatInterval: any = createHeartbeat(streamWriter, completionId, body.model);
    const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };
    let currentStream = ctx.stream;
    let currentAbort = ctx.qwenAbortController;
    let currentSession = ctx.session;
    let currentResolvedEmail = ctx.resolvedEmail;
    let currentInitialParentId = ctx.initialParentId;
    let currentSessionHeaders = ctx.sessionHeaders;
    try {
      await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ role: 'assistant', content: '' })]));
      for (let attempt = 0; attempt < MAX_STREAM_RETRIES; attempt++) {
        const streamReader: ReadableStreamDefaultReader<Uint8Array> = currentStream.getReader();
        const reader = streamReader;
        const streamState = buildInitialStreamState(finalPrompt, currentInitialParentId);
        const streamCtx: StreamProcessingCtx = {
          streamWriter, completionId, model: body.model,
          enableContentFiltering: cleanOutput, cleanOutput, logId,
          resolvedEmail: currentResolvedEmail, ampState,
          qwenAbortController: currentAbort, qwenLogFile: ctx.qwenLogFile,
          emittedToolCallCount: 0,
        };
        const bufferRef = { text: '' };
        const loopResult = await runStreamLoop(c, reader, streamState, streamCtx, ampState, bufferRef);
        if (!loopResult.error) {
          await handlePostStreamCompletion(
            { streamWriter, completionId, model: body.model, streamState, ampState, logId,
              resolvedEmail: currentResolvedEmail, emittedToolCallCount: streamCtx.emittedToolCallCount,
              buffer: loopResult.buffer, enableContentFiltering: cleanOutput,
              includeUsage: !!body.stream_options?.include_usage },
            { reader, heartbeatInterval, chatId: currentSession.chatId,
              sessionHeaders: currentSessionHeaders, email: currentResolvedEmail, sessionPool },
          );
          streamReleased = true;
          return;
        }
        const hasContent = streamState.lastFullContent && streamState.lastFullContent.trim().length > 0;
        if (hasContent) break;
        if (attempt < MAX_STREAM_RETRIES - 1 && ctx.retryStream) {
          try { reader.cancel(); } catch {}
          currentAbort?.abort();
          if (currentSession?.chatId) {
            sessionPool.release(currentSession.chatId, currentInitialParentId, currentSessionHeaders, currentResolvedEmail, false);
          }
          const retry = await ctx.retryStream(currentResolvedEmail);
          if (retry) {
            currentStream = retry.stream;
            currentAbort = retry.qwenAbortController;
            currentResolvedEmail = retry.resolvedEmail;
            currentSession = retry.session;
            currentInitialParentId = retry.initialParentId;
            currentSessionHeaders = retry.sessionHeaders;
            continue;
          }
        }
        break;
      }
      logStore.addError(logId, 'Stream failed after retries');
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'error';
      });
      logStore.finalizeRequest(logId);
    } finally {
      if (!streamReleased) {
        try { await streamWriter.write('data: [DONE]\n\n'); } catch {}
        logStore.updateEntry(logId, (entry) => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = entry.finalResponse.finishReason || 'error';
        });
        logStore.finalizeRequest(logId);
        sessionPool.release(currentSession?.chatId, currentInitialParentId, currentSessionHeaders, currentResolvedEmail, false);
      }
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }
  });
}

function createHeartbeat(streamWriter: any, completionId: string, model: string): any {
  const hb = setInterval(async () => {
    try {
      await streamWriter.write(`data: ${JSON.stringify({
        id: completionId, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        system_fingerprint: 'fp_qwen_gate',
        choices: [{ index: 0, delta: {}, logprobs: null }],
      })}\n\n`);
    } catch { clearInterval(hb); }
  }, 10_000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  return hb;
}

function buildInitialStreamState(finalPrompt: string, initialParentId: string | null): StreamProcessingState {
  return {
    targetResponseId: null, nextParentId: initialParentId, completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5), currentThoughtIndex: 0,
    reasoningBuffer: '', lastFullContent: '', lastRawContent: '', lastFilteredSnapshot: '',
    lastThinkingSnapshot: '', lastVStrRaw: '', lastFilteredFullContent: '',
    lastDeltaThinkingFull: '', loggedToolCalls: new Set(), lastParsePosition: 0,
    toolCallDepth: 0, pendingChunk: '',
  };
}
