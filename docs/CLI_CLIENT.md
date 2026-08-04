# CLI Client — Qwen Gate

CLI client untuk berinteraksi dengan Qwen Gate server melalui terminal. Mendukung interactive chat mode, one-shot query, dan streaming SSE responses dengan progress indicators.

## Installation

CLI client sudah termasuk dalam project Qwen Gate. Tidak perlu instalasi tambahan.

## Quick Start

```bash
# Pastikan server Qwen Gate sudah berjalan
cd qwengates
bun start

# Di terminal lain, jalankan CLI client
bun run cli
```

## Usage

### Interactive Mode (Default)

```bash
bun run cli
# atau
bun run chat
```

Menampilkan prompt interaktif `❯` di mana kamu bisa mengetik pesan dan menerima response streaming.

**Interactive Commands:**
| Command | Description |
|---------|-------------|
| `/exit`, `/quit` | Keluar dari chat |
| `/clear` | Hapus conversation history |
| `/help` | Tampilkan bantuan |
| `/model <name>` | Ganti model (contoh: `/model qwen-max`) |
| `/temp <float>` | Ganti temperature (contoh: `/temp 0.5`) |
| `/ct-off` | Disable critical thinking |
| `/ct-on` | Enable critical thinking |

### One-Shot Query

```bash
# Query sederhana
bun run cli --prompt "Jelaskan quantum computing"

# Dengan model kustom
bun run cli -p "Apa itu machine learning?" -m qwen-max

# Dengan temperature kustom
bun run cli -p "Analisis risiko investasi crypto" -t 0.5

# Disable streaming
bun run cli -p "Hello world" --no-stream

# Disable critical thinking
bun run cli -p "Siapa presiden Indonesia?" --no-critical-thinking
```

### Options Lengkap

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--prompt <text>` | `-p` | (interactive) | One-shot query |
| `--model <name>` | `-m` | `qwen-max` | Model yang digunakan |
| `--temperature <float>` | `-t` | `0.7` | Temperature (0.0-2.0) |
| `--max-tokens <int>` | | `4096` | Max output tokens |
| `--server <url>` | `-s` | `http://localhost:8080` | Server URL |
| `--api-key <key>` | `-k` | `QWEN_GATE_API_KEY` env | API key untuk auth |
| `--no-stream` | | (stream enabled) | Disable streaming |
| `--no-critical-thinking` | | (CT enabled) | Disable critical thinking |
| `--help` | `-h` | | Tampilkan bantuan |

### Environment Variables

```bash
export QWEN_GATE_API_KEY="your-api-key"
```

## Contoh Output

### Interactive Mode

```
╔══════════════════════════════════════════════╗
║        Qwen Gate CLI — Interactive Chat       ║
╚══════════════════════════════════════════════╝
Server: http://localhost:8080
Model:  qwen-max
Temp:   0.7
CT:     On (critical thinking)

Type your message and press Enter. Ctrl+C to exit.

❯ Jelaskan konsep OOP dalam programming

⏱ Estimasi waktu berpikir: ~5s

⠋ Menghubungkan ke Qwen...
⏱ 3s elapsed

### 1. Thinking Plan
Estimasi waktu berpikir: ~5 detik
Karena pertanyaan tentang konsep fundamental programming...

### 2. Chain-of-Thought

Langkah 1/4 — Memahami pertanyaan
[██░░░░░░░░░░░░░░░░░░] 1/4 Langkah 1/4
User meminta penjelasan tentang OOP...

Langkah 2/4 — Identifikasi pilar OOP
[██████░░░░░░░░░░░░░░] 2/4 Langkah 2/4
Ada 4 pilar utama: Encapsulation, Inheritance...

...

### 3. Final Answer
OOP adalah paradigma pemrograman yang...

### 4. Confidence Level
🟢 Confidence: TINGGI
Konsep OOP adalah pengetahuan fundamental yang sudah mapan.

✓ Completed in 8s
```

### One-Shot Mode

```bash
$ bun run cli -p "Jelaskan quantum computing dalam 3 kalimat"

⏱ Estimasi waktu berpikir: ~5s

### 1. Thinking Plan
Estimasi waktu berpikir: ~5 detik...

### 2. Chain-of-Thought
Langkah 1/3 — Memahami quantum computing...

### 3. Final Answer
Quantum computing adalah paradigma komputasi yang menggunakan prinsip
mekanika kuantum seperti superposisi dan entanglement untuk memproses
informasi...

### 4. Confidence Level
🟢 Confidence: TINGGI

✓ Completed in 7s
```

## Arsitektur Komunikasi

```
┌─────────────┐     HTTP POST      ┌──────────────┐     Browser      ┌──────────┐
│  CLI Client  │ ────────────────→  │  Qwen Gate    │ ──────────────→ │  Qwen AI  │
│              │                    │  Server        │                 │           │
│              │ ←── SSE Stream ── │  (Bun + Hono)  │ ←── Response ── │           │
└─────────────┘                    └──────────────┘                 └──────────┘
     │                                    │
     │  POST /v1/chat/completions         │
     │  {                                 │
     │    model: "qwen-max",              │
     │    messages: [...],                │
     │    stream: true                    │
     │  }                                 │
     │                                    │
     │  ← SSE: data: {"choices":          │
     │           [{"delta":               │
     │             {"content": "..."}}]}   │
```

1. CLI client mengirim POST request ke `/v1/chat/completions` dengan format OpenAI-compatible
2. Server meneruskan ke Qwen AI melalui browser automation (Playwright)
3. Response dikirim balik sebagai Server-Sent Events (SSE) stream
4. CLI client mem-parse setiap chunk SSE dan menampilkan token secara real-time
5. Progress indicator (Langkah X/N) di-parse dari content dan ditampilkan di stderr
6. Confidence level di-highlight dengan warna di akhir response

## Troubleshooting

### "Cannot connect to server"
Pastikan Qwen Gate server berjalan:
```bash
cd qwengates && bun start
```
Cek health endpoint:
```bash
curl http://localhost:8080/health
```

### "Authentication required"
Set API key:
```bash
export QWEN_GATE_API_KEY="your-key"
# atau
bun run cli --api-key "your-key"
```

### Response lambat/tidak muncul
- Critical thinking mode menambah latency (normal)
- Coba disable dengan `--no-critical-thinking`
- Cek koneksi internet ke `chat.qwen.ai`
- Pastikan Qwen account sudah dikonfigurasi di dashboard
