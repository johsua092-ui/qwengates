# Critical Thinking Mode

Critical Thinking Mode adalah fitur yang menginjeksi system prompt khusus ke setiap request yang dikirim ke Qwen AI. Fitur ini memaksa Qwen untuk selalu melakukan chain-of-thought reasoning sebelum memberikan jawaban final.

## Cara Kerja

System prompt diinjeksi melalui file `src/services/criticalThinkingPrompt.ts` dan ditambahkan ke `systemParts` di fungsi `buildQwenMessages()` di `chatHelpers.ts`.

### Struktur Response yang Diharapkan

Setiap response dari Qwen akan mengikuti format:

```
### 1. Thinking Plan
- Estimasi waktu berpikir: ~X detik
- Penjelasan mengapa butuh waktu tersebut
- Pendekatan yang akan digunakan

### 2. Chain-of-Thought
- Langkah 1/N — [analisis awal]
- Langkah 2/N — [analisis lanjutan]
- ...
- Langkah N/N — [kesimpulan sementara]

### 3. Final Answer
Jawaban final yang jelas dan ringkas

### 4. Confidence Level
- Tinggi/Sedang/Rendah — dengan alasan
```

## Konfigurasi

### Via Environment Variable
```bash
CRITICAL_THINKING=true    # Enable (default)
CRITICAL_THINKING=false   # Disable
```

### Via config.json
```json
{
  "CRITICAL_THINKING": "true"
}
```

### Via Dashboard Settings
Buka dashboard di `http://localhost:8080/dashboard/settings` → bagian "Critical Thinking" → toggle ON/OFF.

### Via CLI Client
```bash
# Disable critical thinking untuk satu query
bun run cli --prompt "Hello" --no-critical-thinking

# Di interactive mode:
/ct-off    # Disable
/ct-on     # Enable
```

## System Prompt Content

System prompt yang diinjeksi (dari `criticalThinkingPrompt.ts`):

```
You are Qwen, an advanced AI assistant operating in a CLI environment.
Your primary directive is to solve user problems through rigorous critical thinking.

## Core Rules
1. ALWAYS think before answering. Never jump straight to the final answer.
2. Show your reasoning. Walk the user through your thought process.
3. Be honest about complexity. If a question requires deep analysis,
   explicitly tell the user that you need time to think and explain why.
4. No fake confidence. If uncertain, say so.
5. Prioritize correctness over speed.

## Response Structure
1. Thinking Plan: Estimate time and explain why.
2. Chain-of-Thought: Show step-by-step reasoning.
3. Final Answer: Clear and concise.
4. Confidence Level: High/medium/low with reason.

## CLI Notes
- Use plain text formatting.
- If streaming enabled, emit thinking tokens in real-time.
- For complex tasks, indicate ongoing processing.
- Never say "I am thinking" without producing actual reasoning.

## Tone
Professional, friendly, direct, honest. Prefer Indonesian unless user asks otherwise.
```

## Arsitektur

```
Request masuk (OpenAI-compatible)
    ↓
chatCompletions() [chat.ts]
    ↓
setupSession() → buildQwenMessages() [chatHelpers.ts]
    ↓
Cek CRITICAL_THINKING config
    ↓
systemParts.unshift(CRITICAL_THINKING_SYSTEM_PROMPT)
    ↓
System prompt + user system prompt → context.txt → upload ke Qwen
    ↓
Qwen memproses dengan critical thinking guidance
    ↓
Response dikembalikan ke client
```

## Backward Compatibility

- Default value: **true** (enabled by default)
- User system prompt tetap dipertahankan (ditambahkan setelah critical thinking prompt)
- Jika user sudah punya system prompt sendiri, critical thinking prompt akan menjadi prefix
- Bisa di-disable kapan saja via config/env/dashboard/CLI
- Tidak mengubah format response API (tetap OpenAI-compatible)
