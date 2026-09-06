import { describe, expect, test } from 'bun:test';
import { extractClientToolNames, healToolCall, cleanRawToolName } from '../tools/toolHealer.ts';

describe('toolHealer', () => {
  test('cleanRawToolName strips prefixes', () => {
    expect(cleanRawToolName('★-terminal')).toBe('terminal');
    expect(cleanRawToolName('functions.terminal')).toBe('terminal');
    expect(cleanRawToolName('local_mcp:bash')).toBe('bash');
    expect(cleanRawToolName('mcp__bash')).toBe('bash');
  });

  test('extractClientToolNames extracts from OpenAI and Anthropic format', () => {
    const openAiTools = [
      { type: 'function', function: { name: 'bash', description: 'Run bash' } },
      { type: 'function', function: { name: 'edit' } },
    ];
    expect(extractClientToolNames(openAiTools)).toEqual(['bash', 'edit']);

    const anthropicTools = [
      { name: 'Bash', input_schema: {} },
      { name: 'Read', input_schema: {} },
    ];
    expect(extractClientToolNames(anthropicTools)).toEqual(['Bash', 'Read']);
  });

  test('heals terminal -> bash when client registered bash', () => {
    const clientTools = [
      { type: 'function', function: { name: 'bash', description: 'Run commands' } },
      { type: 'function', function: { name: 'edit_file' } },
    ];

    const inputCall = {
      id: 'call_123',
      name: 'terminal',
      arguments: { command: 'git status' },
    };

    const healed = healToolCall(inputCall, clientTools);
    expect(healed.name).toBe('bash');
    expect(healed.arguments).toEqual({ command: 'git status', cmd: 'git status' });
  });

  test('heals execute_code -> bash with command argument', () => {
    const clientTools = [
      { type: 'function', function: { name: 'bash' } },
    ];

    const inputCall = {
      id: 'call_456',
      name: 'execute_code',
      arguments: { code: 'python3 script.py' },
    };

    const healed = healToolCall(inputCall, clientTools);
    expect(healed.name).toBe('bash');
    expect(healed.arguments.command).toBe('python3 script.py');
  });

  test('handles case-insensitivity (Bash vs bash)', () => {
    const clientTools = [{ name: 'Bash' }];
    const inputCall = {
      id: 'call_789',
      name: 'bash',
      arguments: { command: 'ls' },
    };
    const healed = healToolCall(inputCall, clientTools);
    expect(healed.name).toBe('Bash');
  });
});
