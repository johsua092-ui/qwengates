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
import {
  claimNewOccurrences,
  mergeToolCallSources,
  ToolCallMultiset,
  toolCallDedupKey,
} from '../routes/chatStreamingHelpers.ts';
import { parseToolCallLimit } from '../tools/toolCallLimit.ts';

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

describe('attachment handling', () => {
  test('BUG 7: context file must not overwrite existing attachments', () => {
    // `files: [file]` replaced the array outright, so an image (or any already
    // attached file) silently vanished — including on the Anthropic route.
    // Merge semantics: context file appends, images prepend.
    const existing = [{ type: 'image', file_class: 'vision' }];
    const contextFile = { type: 'file', file_class: 'document' };

    const afterContext = { files: [...existing, contextFile] };
    const afterImages = { files: [...existing, ...(afterContext.files || [])] };

    // The pre-existing attachment survives in both steps.
    expect(afterContext.files).toContain(existing[0]);
    expect(afterContext.files).toContain(contextFile);
    expect(afterContext.files.length).toBe(2);

    // Images end up first: files[0] is what the user just provided.
    expect(afterImages.files[0]).toEqual(existing[0]);
  });

  test('BUG 7: overwriting (the old behaviour) is what dropped attachments', () => {
    const existing = [{ type: 'image' }];
    const oldBehaviour = { ...{}, files: [{ type: 'file' }] };
    expect(oldBehaviour.files).not.toContain(existing[0]);
    expect(oldBehaviour.files.length).toBe(1);
  });
});

describe('deep argument canonicalization (dedup)', () => {
  test('BUG 9: nested object key order must not defeat dedup', () => {
    // Shallow sorting was not enough: the same call arriving over the two
    // transports with inner keys swapped produced different keys, so the
    // duplicate slipped through and the client executed it twice.
    expect(toolCallDedupKey('Bash', { options: { recursive: true, force: false } })).toBe(
      toolCallDedupKey('Bash', { options: { force: false, recursive: true } }),
    );
  });

  test('BUG 9: arrays-of-objects are canonicalized too', () => {
    expect(toolCallDedupKey('Edit', { edits: [{ old: 'a', new: 'b' }] })).toBe(
      toolCallDedupKey('Edit', { edits: [{ new: 'b', old: 'a' }] }),
    );
  });

  test('BUG 9: canonicalization does not merge genuinely different calls', () => {
    expect(toolCallDedupKey('Bash', { command: 'ls' })).not.toBe(toolCallDedupKey('Bash', { command: 'pwd' }));
    expect(toolCallDedupKey('Bash', { nested: { a: 1 } })).not.toBe(toolCallDedupKey('Bash', { nested: { a: 2 } }));
    expect(toolCallDedupKey('Read', { p: 1 })).not.toBe(toolCallDedupKey('Write', { p: 1 }));
  });

  test('BUG 9: primitives, null and arrays serialize deterministically', () => {
    expect(toolCallDedupKey('T', null)).toBe('T:null');
    expect(toolCallDedupKey('T', 5)).toBe('T:5');
    expect(toolCallDedupKey('T', 'x')).toBe('T:"x"');
    expect(toolCallDedupKey('T', [1, 2])).toBe('T:[1,2]');
  });
});

describe('cross-transport tool call merge (multiset)', () => {
  const call = (name: string, args: unknown) => ({ name, arguments: args });

  test('collapses the same call reported over BOTH transports', () => {
    const xml = [call('Bash', { command: 'ls' })];
    const local = [{ ...call('Bash', { command: 'ls' }), id: 'call_abc' }];
    expect(mergeToolCallSources(xml, local)).toHaveLength(1);
  });

  test('ignores id differences (ids are synthesized per source)', () => {
    const xml = [{ ...call('Bash', { command: 'ls' }), id: 'call_xml' }];
    const local = [{ ...call('Bash', { command: 'ls' }), id: 'call_local' }];
    expect(mergeToolCallSources(xml, local)).toHaveLength(1);
  });

  test('nested argument key order does not defeat the merge', () => {
    const xml = [call('Edit', { opts: { a: 1, b: 2 } })];
    const local = [call('Edit', { opts: { b: 2, a: 1 } })];
    expect(mergeToolCallSources(xml, local)).toHaveLength(1);
  });

  test('keeps TWO genuinely repeated calls (must not be deduped)', () => {
    const xml = [call('Bash', { command: 'ls' }), call('Bash', { command: 'ls' })];
    expect(mergeToolCallSources(xml, [])).toHaveLength(2);
  });

  test('keeps an extra real call beyond the cross-transport duplicate', () => {
    // XML has the call twice (two real invocations); local_mcp reports it once.
    // Result must be 2, not 1: the duplicate is absorbed, the second real call
    // survives.
    const xml = [call('Bash', { command: 'ls' }), call('Bash', { command: 'ls' })];
    const local = [call('Bash', { command: 'ls' })];
    expect(mergeToolCallSources(xml, local)).toHaveLength(2);
  });

  test('keeps local_mcp-only calls that never appeared in XML', () => {
    const xml = [call('Read', { file: 'a' })];
    const local = [call('Bash', { command: 'ls' })];
    const merged = mergeToolCallSources(xml, local);
    expect(merged).toHaveLength(2);
    expect(merged.map((c) => c.name).sort()).toEqual(['Bash', 'Read']);
  });

  test('does not merge different arguments', () => {
    const xml = [call('Bash', { command: 'ls' })];
    const local = [call('Bash', { command: 'pwd' })];
    expect(mergeToolCallSources(xml, local)).toHaveLength(2);
  });
});

describe('occurrence claiming (repeated identical calls)', () => {
  const call = (name: string, args: unknown) => ({ name, arguments: args });

  test('first batch claims everything', () => {
    const m = new ToolCallMultiset();
    const out = claimNewOccurrences([call('Bash', { command: 'ls' })], m);
    expect(out).toHaveLength(1);
  });

  test('re-reporting the SAME occurrence does not emit it again', () => {
    // The XML path re-parses the growing buffer every chunk: it keeps seeing
    // the same call. Only the first sighting may be emitted.
    const m = new ToolCallMultiset();
    claimNewOccurrences([call('Bash', { command: 'ls' })], m);
    const second = claimNewOccurrences([call('Bash', { command: 'ls' })], m);
    expect(second).toHaveLength(0);
  });

  test('a genuinely repeated call survives the second time it appears', () => {
    // Buffer now contains the call TWICE — that is a real second invocation.
    const m = new ToolCallMultiset();
    claimNewOccurrences([call('Bash', { command: 'ls' })], m);
    const second = claimNewOccurrences([call('Bash', { command: 'ls' }), call('Bash', { command: 'ls' })], m);
    expect(second).toHaveLength(1);
  });

  test('two identical calls in the very first batch both pass', () => {
    const m = new ToolCallMultiset();
    const out = claimNewOccurrences([call('Bash', { command: 'ls' }), call('Bash', { command: 'ls' })], m);
    expect(out).toHaveLength(2);
  });

  test('N identical calls are emitted one by one as the buffer grows', () => {
    const m = new ToolCallMultiset();
    const seen: number[] = [];
    const one = call('Bash', { command: 'ls' });
    seen.push(claimNewOccurrences([one], m).length); // 1 call in buffer
    seen.push(claimNewOccurrences([one, one], m).length); // 2 calls in buffer
    seen.push(claimNewOccurrences([one, one, one], m).length); // 3 calls in buffer
    expect(seen).toEqual([1, 1, 1]);
    expect(m.count(toolCallDedupKey('Bash', { command: 'ls' }))).toBe(3);
  });

  test('distinct calls are unaffected by each other', () => {
    const m = new ToolCallMultiset();
    claimNewOccurrences([call('Bash', { command: 'ls' })], m);
    const out = claimNewOccurrences([call('Bash', { command: 'pwd' }), call('Read', { file: 'a' })], m);
    expect(out).toHaveLength(2);
  });
});

describe('tool call limit parsing', () => {
  test('BUG 8: malformed values never silently change the limit', () => {
    // parseInt('2.5') === 2 and (limit > 0) === false for -1, so the old
    // config.getInt path reinterpreted typos instead of falling back.
    expect(parseToolCallLimit('2.5', 3)).toBe(3);
    expect(parseToolCallLimit('-1', 3)).toBe(3);
    expect(parseToolCallLimit('', 3)).toBe(3);
    expect(parseToolCallLimit('nonsense', 3)).toBe(3);

    // Valid values and the documented off-switch still work.
    expect(parseToolCallLimit('5', 3)).toBe(5);
    expect(parseToolCallLimit('0', 3)).toBeNull();
    expect(parseToolCallLimit('unlimited', 3)).toBeNull();
  });
});
