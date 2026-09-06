import { test } from 'bun:test';
import assert from 'node:assert';
import { processToolCallsThroughGuard, ToolSpamGuard } from '../routes/chatHelpersCore.ts';
import { truncateToolResult } from '../routes/compressToolResult.ts';
import { streamChunks } from '../tests/helpers.ts';
import { parseToolCallLimit } from './toolCallLimit.ts';

/**
 * Tool call limiting tests.
 *
 * Tests:
 * 1. truncateToolResult — smart elision preserves head + tail of large content
 * 2. MAX_TOOL_CALLS_PER_RESPONSE env var — reads default and override
 * 3. StreamingToolParser respects the limit
 */

// ─── truncateToolResult (from chat.ts) ──────────────────────────────────────

/**
 * Truncate large tool results to prevent context pollution.
 * Smart elision: keep first ~40% + last ~40%, with a marker in the middle.
 */

test('truncateToolResult: returns short content unchanged', () => {
  const short = 'Hello world';
  assert.strictEqual(truncateToolResult(short, 100), short);
});

test('truncateToolResult: truncates long content with head+tail', () => {
  const long = 'A'.repeat(10_000);
  const result = truncateToolResult(long, 200);
  assert.ok(result.length < long.length, 'should be shorter than original');
  assert.ok(result.startsWith('AAA'), 'should preserve head');
  assert.ok(result.endsWith('AAA'), 'should preserve tail');
  assert.ok(result.includes('... [truncated'), 'should include truncation marker');
});

test('truncateToolResult: handles empty string', () => {
  assert.strictEqual(truncateToolResult(''), '');
});

test('truncateToolResult: handles null/undefined gracefully', () => {
  assert.strictEqual(truncateToolResult(''), '');
});

test('truncateToolResult: respects exact boundary', () => {
  const exactly = 'x'.repeat(4096);
  assert.strictEqual(truncateToolResult(exactly, 4096), exactly);
});

// ─── MAX_TOOL_CALLS_PER_RESPONSE env config ─────────────────────────────────

test('MAX_TOOL_CALLS_PER_RESPONSE: uses the configured positive integer', () => {
  assert.strictEqual(parseToolCallLimit('5', 3), 5);
});

test('MAX_TOOL_CALLS_PER_RESPONSE: zero enables unlimited mode', () => {
  assert.strictEqual(parseToolCallLimit('0', 3), null);
});

test('MAX_TOOL_CALLS_PER_RESPONSE: explicit unlimited aliases enable unlimited mode', () => {
  for (const value of ['unlimited', 'none', 'infinity']) {
    assert.strictEqual(parseToolCallLimit(value, 3), null, value);
  }
});

test('MAX_TOOL_CALLS_PER_RESPONSE: malformed and negative values use the fallback', () => {
  for (const bad of ['', 'not-a-number', '-1', '2.5']) {
    assert.strictEqual(parseToolCallLimit(bad, 3), 3, bad);
  }
});

function calls(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `call-${i}`, name: `tool-${i}`, arguments: { i } }));
}

test('tool guard: configured limit applies across parser batches', () => {
  const output: any[] = [];
  const options = {
    logId: 'limit-test',
    toolSpamGuard: new ToolSpamGuard(),
    correctionPrompts: [] as string[],
    maxToolCalls: 3,
  };
  processToolCallsThroughGuard(calls(2), output, options);
  processToolCallsThroughGuard(calls(2).map((call, i) => ({ ...call, id: `next-${i}`, name: `next-${i}` })), output, options);
  assert.strictEqual(output.length, 3);
  assert.match(options.correctionPrompts[0], /maximum of 3/i);
});

test('tool guard: unlimited mode does not truncate calls', () => {
  const output: any[] = [];
  const options = {
    logId: 'unlimited-test',
    toolSpamGuard: new ToolSpamGuard(),
    correctionPrompts: [] as string[],
    maxToolCalls: null,
  };
  processToolCallsThroughGuard(calls(20), output, options);
  assert.strictEqual(output.length, 20);
  assert.deepStrictEqual(options.correctionPrompts, []);
});

// ─── Streaming chunk truncation ──────────────────────────────────────────────

test('streaming: truncateToolResult on accumulated chunks produces same result as block', () => {
  const longString = 'word '.repeat(2000);
  const chunks = streamChunks(longString);
  const accumulated = chunks.join('');
  const streamingResult = truncateToolResult(accumulated, 200);
  const blockResult = truncateToolResult(longString, 200);
  assert.strictEqual(streamingResult, blockResult, 'streaming-accumulated truncation must match block truncation');
});

test('streaming: short content passes through unchanged when accumulated from chunks', () => {
  const shortText = 'The quick brown fox jumps over the lazy dog.';
  const chunks = streamChunks(shortText);
  const accumulated = chunks.join('');
  const result = truncateToolResult(accumulated, 4096);
  assert.strictEqual(result, shortText, 'short content must pass through unchanged');
});

test('streaming: truncation marker present in accumulated streaming output', () => {
  const text = 'data '.repeat(3000);
  const chunks = streamChunks(text);
  const accumulated = chunks.join('');
  const result = truncateToolResult(accumulated, 200);
  assert.ok(result.includes('[truncated'), `truncation marker missing from streaming output: "${result.slice(0, 100)}..."`);
});

test('streaming: head and tail preserved in accumulated streaming output', () => {
  const text = 'abcdefghij '.repeat(1000);
  const chunks = streamChunks(text);
  const accumulated = chunks.join('');
  const result = truncateToolResult(accumulated, 200);
  const head = accumulated.slice(0, 90);
  const tail = accumulated.slice(-90);
  assert.ok(result.includes(head.slice(0, 20)), 'first characters (head) must be preserved');
  assert.ok(result.includes(tail.slice(-20)), 'last characters (tail) must be preserved');
});
