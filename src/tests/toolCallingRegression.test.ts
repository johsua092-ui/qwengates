/**
 * Regression tests for the tool-calling fixes.
 *
 * Each test pins one specific bug that produced the user-visible symptom
 * "tool / terminal error even though everything is normal":
 *
 *  1. Identical repeated tool calls were silently dropped in the parser.
 *  2. The same logical call arrived twice (local_mcp + XML) and the dedup
 *     key did not match, so the client executed it twice.
 *  3. Dedup ran on the RAW tool name, before healing, so `★-Bash` and
 *     `<function=bash>` were treated as different tools.
 *  4. Un-emitted calls were selected by slicing on a count, which skipped or
 *     re-emitted the wrong calls when the two transports disagreed on order.
 *  5. A single-tool client had EVERY unknown call rewritten to that tool,
 *     clobbering valid MCP/tool names into `Bash`.
 */
import { describe, expect, test } from 'bun:test';
import { parseXmlToolCalls, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';
import { healToolCall } from '../tools/toolHealer.ts';
import { toolCallDedupKey } from '../routes/chatStreamingHelpers.ts';

const BASH = '<function=bash>\n<parameter=command>ls</parameter>\n</function>';
const BASH_OTHER = '<function=bash>\n<parameter=command>pwd</parameter>\n</function>';
const READ = '<function=read>\n<parameter=filePath>/tmp/x</parameter>\n</function>';

describe('tool-calling regressions', () => {
  test('BUG 1: identical repeated calls are separate invocations, nothing dropped', () => {
    const r = parseXmlToolCalls(`${BASH}\n${BASH}`);
    expect(r.toolCalls.length).toBe(2);
    expect(r.cleanedText.trim()).toBe('');
  });

  test('BUG 1: distinct repeated calls all survive, in order', () => {
    const r = parseXmlToolCalls(`${BASH}\n${BASH_OTHER}\n${READ}`);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['bash', 'bash', 'read']);
    expect(r.toolCalls.map((t) => (t.parameters as any).command ?? (t.parameters as any).filePath)).toEqual([
      'ls',
      'pwd',
      '/tmp/x',
    ]);
    expect(r.cleanedText.trim()).toBe('');
  });

  test('BUG 2: dedup key is order-independent for the same logical call', () => {
    expect(toolCallDedupKey('Bash', { command: 'ls', timeout: 1000 })).toBe(
      toolCallDedupKey('Bash', { timeout: 1000, command: 'ls' }),
    );
  });

  test('BUG 2: dedup key still separates genuinely different calls', () => {
    const a = toolCallDedupKey('Bash', { command: 'ls' });
    const b = toolCallDedupKey('Bash', { command: 'pwd' });
    const c = toolCallDedupKey('Read', { command: 'ls' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test('BUG 3: local_mcp and XML forms of one call produce the SAME dedup key after healing', () => {
    const clientTools = [{ type: 'function', function: { name: 'Bash' } }];
    const viaLocalMcp = healToolCall({ id: 'c1', name: '★-Bash', arguments: { command: 'cat /etc/hostname' } }, clientTools);
    const viaXml = healToolCall(
      xmlToolCallToParsed(
        parseXmlToolCalls('<function=bash>\n<parameter=command>cat /etc/hostname</parameter>\n</function>').toolCalls[0],
        0,
      ),
      clientTools,
    );
    expect(viaLocalMcp.name).toBe('Bash');
    expect(viaXml.name).toBe('Bash');
    expect(toolCallDedupKey(viaLocalMcp.name, viaLocalMcp.arguments)).toBe(
      toolCallDedupKey(viaXml.name, viaXml.arguments),
    );
  });

  test('BUG 4: count-based slice would drop a new call — key-based selection keeps it', () => {
    // local_mcp emitted #1; XML reports #2 then #1 (different order).
    // A naive `slice(1)` would pick #1 again and lose #2 entirely.
    const clientTools = [{ type: 'function', function: { name: 'Bash' } }];
    const emitted = new Set([toolCallDedupKey('Bash', { command: 'ls' })]);
    const xmlCalls = parseXmlToolCalls(`${BASH_OTHER}\n${BASH}`).toolCalls.map((tc) =>
      healToolCall(xmlToolCallToParsed(tc, 0), clientTools),
    );
    const fresh = xmlCalls.filter((h) => {
      const k = toolCallDedupKey(h.name, h.arguments);
      if (emitted.has(k)) return false;
      emitted.add(k);
      return true;
    });
    expect(fresh.length).toBe(1);
    expect((fresh[0].arguments as any).command).toBe('pwd');
  });

  test('BUG 5: single-tool client must NOT clobber an unknown tool name', () => {
    const clientTools = [{ type: 'function', function: { name: 'Bash' } }];
    const unknown = healToolCall({ id: 'c2', name: 'totally_unknown_tool', arguments: { x: 1 } }, clientTools);
    expect(unknown.name).toBe('totally_unknown_tool');
  });

  test('BUG 6: MCP tool names keep their mcp__ prefix when registered as-is', () => {
    // MCP tools are `mcp__<server>__<tool>`. Stripping `mcp__` yields
    // `fs__read_file`, which the client rejects as an unknown tool.
    const clientTools = [
      { type: 'function', function: { name: 'mcp__fs__read_file' } },
      { type: 'function', function: { name: 'Bash' } },
    ];
    const mcp = healToolCall({ id: 'c1', name: 'mcp__fs__read_file', arguments: { path: '/etc/hosts' } }, clientTools);
    expect(mcp.name).toBe('mcp__fs__read_file');

    // Case-insensitive registration must also win over prefix stripping.
    const mcpCase = healToolCall(
      { id: 'c2', name: 'mcp__fs__read_file', arguments: { path: '/etc/hosts' } },
      [{ type: 'function', function: { name: 'MCP__FS__READ_FILE' } }],
    );
    expect(mcpCase.name).toBe('MCP__FS__READ_FILE');
  });

  test('BUG 6: prefix stripping still applies when the client has the stripped name', () => {
    // Some clients register MCP tools WITHOUT the mcp__ prefix. Then stripping
    // is exactly right and must keep working.
    const clientTools = [{ type: 'function', function: { name: 'fs__read_file' } }];
    const mcp = healToolCall({ id: 'c1', name: 'mcp__fs__read_file', arguments: { path: '/etc/hosts' } }, clientTools);
    expect(mcp.name).toBe('fs__read_file');
  });

  test('BUG 5: single-tool client still rescues a genuinely generic action name', () => {
    const clientTools = [{ type: 'function', function: { name: 'Bash' } }];
    const generic = healToolCall({ id: 'c1', name: 'execute', arguments: { command: 'ls' } }, clientTools);
    expect(generic.name).toBe('Bash');
  });

  test('healing still maps terminal/execute_code aliases to real client tools', () => {
    const bashClient = [{ type: 'function', function: { name: 'bash' } }];
    expect(healToolCall({ id: 'c1', name: 'terminal', arguments: { command: 'pwd' } }, bashClient).name).toBe('bash');

    const customClient = [{ type: 'function', function: { name: 'run_terminal_cmd' } }];
    expect(
      healToolCall({ id: 'c2', name: 'terminal', arguments: { command: 'pwd' } }, customClient).name,
    ).toBe('run_terminal_cmd');

    const healed = healToolCall({ id: 'c3', name: 'execute_code', arguments: { code: 'print(1)' } }, bashClient);
    expect(healed.name).toBe('bash');
    expect((healed.arguments as any).command).toBe('print(1)');
  });
});
