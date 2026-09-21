/**
 * Regression test: multi-provider routing.
 *
 * Guarantees the provider namespaces stay disjoint. A collision here would
 * silently send a request to the wrong upstream — the kind of bug that only
 * shows up as a confusing error in production, so it is pinned down here.
 */

import { describe, expect, test } from 'bun:test';
import { isDeepSeekModel, DEEPSEEK_MODEL_IDS, DEEPSEEK_BASE_URL } from '../services/deepseek.ts';
import { isGlmModel, GLM_MODEL_IDS, GLM_BASE_URL } from '../services/glm.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';

describe('provider routing', () => {
  test('deepseek-* routes to DeepSeek', () => {
    expect(isDeepSeekModel('deepseek-flash')).toBe(true);
    expect(isDeepSeekModel('deepseek-v4-pro')).toBe(true);
    expect(isDeepSeekModel('DEEPSEEK-FLASH')).toBe(true); // case-insensitive
  });

  test('glm-* routes to GLM', () => {
    expect(isGlmModel('glm-4.7-flash')).toBe(true);
    expect(isGlmModel('glm-4.5-flash')).toBe(true);
    expect(isGlmModel('glm-4.6v-flash')).toBe(true);
    expect(isGlmModel('GLM-5.3')).toBe(true);
  });

  test('qwen-* is claimed by neither API-key provider', () => {
    for (const m of ['qwen3-coder-plus', 'qwen3-max', 'qwen-max', 'qwen-turbo']) {
      expect(isDeepSeekModel(m)).toBe(false);
      expect(isGlmModel(m)).toBe(false);
    }
  });

  test('namespaces never overlap', () => {
    for (const m of DEEPSEEK_MODEL_IDS) expect(isGlmModel(m)).toBe(false);
    for (const m of GLM_MODEL_IDS) expect(isDeepSeekModel(m)).toBe(false);
  });

  test('unrelated and empty model names are not claimed', () => {
    for (const m of ['gpt-4o', 'claude-sonnet-4', 'gemini-2.5-pro', '', 'glm', 'deepseek']) {
      expect(isDeepSeekModel(m)).toBe(false);
      expect(isGlmModel(m)).toBe(false);
    }
    // Both guards must tolerate null/undefined without throwing.
    expect(isDeepSeekModel(undefined)).toBe(false);
    expect(isGlmModel(null)).toBe(false);
  });

  test('providers point at their own base URLs', () => {
    expect(DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com');
    expect(GLM_BASE_URL).toBe('https://api.z.ai/api/paas/v4');
  });

  test('retired DeepSeek aliases are not advertised', () => {
    expect(DEEPSEEK_MODEL_IDS).not.toContain('deepseek-chat');
    expect(DEEPSEEK_MODEL_IDS).not.toContain('deepseek-reasoner');
    expect(DEEPSEEK_MODEL_IDS).not.toContain('deepseek-v4-flash');
  });

  test('GLM free models are not confused with their paid lookalikes', () => {
    expect(GLM_MODEL_IDS).toContain('glm-4.7-flash');
    // glm-4.7-flashX is a separate, PAID model — it must not be advertised as free.
    expect(GLM_MODEL_IDS).not.toContain('glm-4.7-flashx');
  });
});

describe('tool calling passthrough', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
  ];

  // DeepSeek and GLM both document tool support (DeepSeek's pricing table lists
  // "Tool Calls ✓" for deepseek-flash and deepseek-v4-pro; Z.AI documents
  // function calling with `tools` + `tool_choice`). This pins that we actually
  // forward the fields instead of silently dropping them, which is the failure
  // mode the OpenAI validation schema had.
  test('validation keeps tools and tool_choice', () => {
    const r = validateOpenAIRequest({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      tool_choice: 'auto',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, unknown>;
    expect(Array.isArray(d.tools)).toBe(true);
    expect((d.tools as unknown[]).length).toBe(1);
    expect(d.tool_choice).toBe('auto');
  });

  test('validation survives a tool-result round trip', () => {
    // Second leg of a tool call: the client echoes the assistant's tool_calls
    // and appends a `tool` message. Both must survive validation intact.
    const r = validateOpenAIRequest({
      model: 'glm-4.7-flash',
      messages: [
        { role: 'user', content: 'weather in Bandung?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bandung"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '24C' },
      ],
      tools,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const msgs = (r.data as Record<string, unknown>).messages as Record<string, unknown>[];
    expect(msgs.length).toBe(3);
    expect(msgs[1].role).toBe('assistant');
    expect(Array.isArray(msgs[1].tool_calls)).toBe(true);
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].tool_call_id).toBe('call_1');
  });
});

describe('OpenAI field passthrough', () => {
  // Regression: these were previously dropped by the Zod schema, so a client
  // sending temperature:0.5 silently got the upstream default.
  test('sampling and format fields survive validation', () => {
    const r = validateOpenAIRequest({
      model: 'glm-4.7-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 128,
      stop: ['END'],
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 42,
      response_format: { type: 'json_object' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, unknown>;
    expect(d.temperature).toBe(0.5);
    expect(d.top_p).toBe(0.9);
    expect(d.max_tokens).toBe(128);
    expect(d.stop).toEqual(['END']);
    expect(d.presence_penalty).toBe(0.1);
    expect(d.frequency_penalty).toBe(0.2);
    expect(d.seed).toBe(42);
    expect(d.response_format).toEqual({ type: 'json_object' });
  });

  test('validation still rejects a genuinely invalid body', () => {
    expect(validateOpenAIRequest({ messages: [] }).ok).toBe(false);
    expect(validateOpenAIRequest({ model: 'x' }).ok).toBe(false);
  });
});
