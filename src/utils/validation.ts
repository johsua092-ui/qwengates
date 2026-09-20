/*
 * File: validation.ts
 * Request body validation schemas using zod (v3 compatibility via zod/v3).
 * Ensures incoming OpenAI-compatible requests are well-formed before processing.
 */

import { z } from 'zod/v3';

const contentPartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z
    .object({
      url: z.string(),
      detail: z.string().optional(),
    })
    .optional(),
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'function']),
  content: z
    .union([z.string(), z.array(contentPartSchema), z.null()])
    .optional()
    .default(''),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  reasoning_content: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.enum(['function']).optional(),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

const functionSchema = z.object({
  type: z.enum(['function']),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
  inputSchema: z.record(z.unknown()).optional(),
});

export const openAIRequestSchema = z.object({
  model: z.string().min(1, 'model is required'),
  messages: z.array(messageSchema).min(1, 'at least one message is required'),
  stream: z.boolean().optional().default(false),
  tools: z.array(functionSchema).optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required', 'any']),
      z.object({ type: z.enum(['function']), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .optional(),
  // Standard OpenAI sampling/format knobs. These used to be silently dropped by
  // validation, so a client sending `temperature` got the upstream default
  // instead — a quiet behaviour change, not an error. Pass them through.
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  seed: z.number().int().optional(),
  response_format: z
    .union([z.object({ type: z.string() }).passthrough(), z.record(z.string(), z.unknown())])
    .optional(),
  user: z.string().optional(),
  n: z.number().int().positive().optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().optional(),
  parallel_tool_calls: z.boolean().optional(),
});

export type ValidatedOpenAIRequest = z.infer<typeof openAIRequestSchema>;

export interface ValidationResult {
  ok: boolean;
  data?: ValidatedOpenAIRequest;
  error?: string;
  code?: string;
  status?: number;
}

export function validateOpenAIRequest(body: unknown): ValidationResult {
  const result = openAIRequestSchema.safeParse(body);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const firstIssue = result.error.issues[0];
  const path = firstIssue?.path?.join('.') || 'body';
  const message = firstIssue?.message || 'Invalid request';
  return {
    ok: false,
    error: `${path}: ${message}`,
    code: 'invalid_request_error',
    status: 400,
  };
}
