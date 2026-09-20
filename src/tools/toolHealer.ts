import type { ParsedToolCall } from '../types/openai.ts';

/**
 * Extract clean list of registered tool names from body.tools or body.functions.
 * Supports OpenAI format ({ type: 'function', function: { name: '...' } }),
 * Anthropic format ({ name: '...', input_schema: { ... } }),
 * and flat format ({ name: '...' }).
 */
export function extractClientToolNames(tools?: unknown, functions?: unknown): string[] {
  const names = new Set<string>();

  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t === 'object') {
        const obj = t as any;
        const fn = obj.function || obj;
        const name = fn.name || obj.name;
        if (typeof name === 'string' && name.trim()) {
          names.add(name.trim());
        }
      }
    }
  }

  if (Array.isArray(functions)) {
    for (const f of functions) {
      if (f && typeof f === 'object') {
        const fnName = (f as { name?: string }).name;
        if (typeof fnName === 'string' && fnName.trim()) {
          names.add(fnName.trim());
        }
      }
    }
  }

  return Array.from(names);
}

/**
 * Strip upstream prefixes: "★-terminal" -> "terminal", "functions.terminal" -> "terminal"
 */
export function cleanRawToolName(name: string): string {
  if (!name) return '';
  return name
    .replace(/^★-/, '')
    .replace(/^functions\./, '')
    .replace(/^local_mcp:/, '')
    .replace(/^mcp__/, '')
    .trim();
}

const TERMINAL_ALIASES = [
  'bash',
  'terminal',
  'execute_command',
  'run_command',
  'run_terminal_command',
  'shell',
  'sh',
  'cmd',
  'command_runner',
  'execute_bash',
  'bash_command',
  'run_shell_command',
  'shell_command',
  'terminal_execute',
  'exec_command',
  'run_bash',
  'cli',
  'system_command',
  'command',
  'exec',
];

const CODE_ALIASES = [
  'execute_code',
  'code_interpreter',
  'run_code',
  'python',
  'eval',
  'repl',
  'bash',
  'execute_command',
  'python_interpreter',
  'run_python',
  'code_runner',
];

/**
 * Heals a tool call so that it maps to one of the client's registered tools.
 * Prevents "Tool does not exists" error when Qwen calls its internal web tools
 * ("terminal", "execute_code") instead of the tools declared by the client (e.g. "bash").
 */
export function healToolCall(tc: ParsedToolCall, clientTools?: unknown): ParsedToolCall {
  if (!tc) return tc;

  const clientNames = Array.isArray(clientTools)
    ? (typeof clientTools[0] === 'string' ? (clientTools as string[]) : extractClientToolNames(clientTools))
    : [];

  const rawName = cleanRawToolName(tc.name);
  if (clientNames.length === 0) {
    return { ...tc, name: rawName };
  }

  // 0. Exact match on the UNTOUCHED name, before any prefix stripping.
  //
  // MCP tools are named `mcp__<server>__<tool>`. Stripping the `mcp__` prefix
  // (as cleanRawToolName does) produces `fs__read_file`, which the client does
  // NOT recognize → "tool does not exist". If the client registered the name
  // as-is, that registration always wins.
  const untouched = (tc.name || '').trim();
  if (untouched && clientNames.includes(untouched)) {
    return { ...tc, name: untouched };
  }
  const untouchedCase = clientNames.find((n) => n.toLowerCase() === untouched.toLowerCase());
  if (untouched && untouchedCase) {
    return { ...tc, name: untouchedCase };
  }

  // 1. Exact match
  if (clientNames.includes(rawName)) {
    return { ...tc, name: rawName };
  }

  // 2. Case-insensitive match (e.g. "Bash" vs "bash")
  const lower = rawName.toLowerCase();
  const caseMatch = clientNames.find((n) => n.toLowerCase() === lower);
  if (caseMatch) {
    return { ...tc, name: caseMatch };
  }

  // 3. Suffix stripped match (e.g. "terminal_tool" -> "terminal")
  const strippedSuffix = lower.replace(/_(?:tool|function|cmd)$/, '');
  const suffixMatch = clientNames.find((n) => n.toLowerCase() === strippedSuffix);
  if (suffixMatch) {
    return { ...tc, name: suffixMatch };
  }

  let targetName = rawName;
  let args = { ...(tc.arguments || {}) } as Record<string, any>;

  // 4. Shell / Terminal tool aliasing
  const isTerminalCall = TERMINAL_ALIASES.includes(lower) || lower.includes('terminal') || lower.includes('shell');
  if (isTerminalCall) {
    // Find candidate in client tools
    for (const alias of TERMINAL_ALIASES) {
      const match = clientNames.find((n) => n.toLowerCase() === alias);
      if (match) {
        targetName = match;
        break;
      }
    }
    // Fallback: search any client tool containing command/bash/shell
    if (targetName === rawName) {
      const match = clientNames.find((n) => {
        const l = n.toLowerCase();
        return l.includes('bash') || l.includes('command') || l.includes('shell') || l.includes('term');
      });
      if (match) targetName = match;
    }
  }

  // 5. Code execution aliasing (execute_code -> python or bash)
  const isCodeCall = CODE_ALIASES.includes(lower) || lower.includes('code') || lower.includes('python');
  if (isCodeCall && targetName === rawName) {
    // Preferred: python / code runner
    for (const alias of CODE_ALIASES) {
      const match = clientNames.find((n) => n.toLowerCase() === alias);
      if (match) {
        targetName = match;
        break;
      }
    }
    // Fallback: if no python runner, but client has bash/command tool, map to it!
    if (targetName === rawName) {
      for (const alias of TERMINAL_ALIASES) {
        const match = clientNames.find((n) => n.toLowerCase() === alias);
        if (match) {
          targetName = match;
          break;
        }
      }
    }
  }

  // 6. Single-tool client fallback
  //
  // Deliberately narrow. A single-tool client (e.g. Claude Code exposing only
  // `Bash`) often gets a generic action name from Qwen (`run`, `exec`,
  // `do_it`). Collapsing that to the one available tool keeps the turn alive.
  //
  // This MUST NOT fire for arbitrary names: doing so rewrites a perfectly
  // valid MCP/tool call (e.g. `mcp__fs__read`) into `Bash`, which the client
  // then rejects with "tool does not exist" or, worse, executes with args that
  // do not match the schema — the exact "tool error although everything is
  // normal" symptom.
  //
  // Terminal/code aliases are already handled by steps 4 and 5, so only
  // alias-free generic names are listed here.
  const GENERIC_ACTION_NAMES = [
    'run',
    'exec',
    'execute',
    'do_it',
    'run_command',
    'exec_command',
    'run_shell',
    'execute_command',
    'tool',
    'action',
  ];
  if (targetName === rawName && clientNames.length === 1 && GENERIC_ACTION_NAMES.includes(lower)) {
    targetName = clientNames[0];
  }

  // Normalize arguments between tool formats
  // Ensure "command", "cmd", "code", "input" are mapped appropriately
  if (args.code && !args.command) {
    args.command = args.code;
  }
  if (args.cmd && !args.command) {
    args.command = args.cmd;
  } else if (args.command && !args.cmd) {
    args.cmd = args.command;
  }
  if (args.input && !args.command && typeof args.input === 'string') {
    args.command = args.input;
  }

  return {
    ...tc,
    name: targetName,
    arguments: args,
  };
}
