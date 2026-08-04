# Setup & Development Guide — Qwen Gate

Panduan lengkap untuk setup environment, development, dan troubleshooting Qwen Gate.

## Prerequisites

- **Bun** ≥ 1.3 (runtime + package manager)
- **Node.js** ≥ 18 (fallback runtime)
- **Playwright** browsers (auto-installed via `bun install`)
- Qwen AI account (email + password) — daftar di [chat.qwen.ai](https://chat.qwen.ai)

## Quick Start

```bash
# 1. Clone repository
git clone https://github.com/johsua092-ui/qwengates.git
cd qwengates

# 2. Install dependencies
bun install

# 3. Setup environment
cp .env.example .env
# Edit .env sesuai kebutuhan

# 4. Start server
bun start

# 5. Buka dashboard
open http://localhost:8080/dashboard

# 6. Tambahkan Qwen account di dashboard → Accounts → Add Account

# 7. Test API
curl http://localhost:8080/v1/models

# 8. Jalankan CLI client (di terminal lain)
bun run cli
```

## Environment Variables (.env)

```bash
# Server
PORT=8080                           # Port server (default: 8080)
HOST=localhost                      # Host (production: 0.0.0.0)

# Authentication (opsional)
API_KEY=                            # Kosongkan untuk no auth

# Browser engine
BROWSER=chromium                    # chromium | firefox | chrome | edge

# Critical Thinking Mode
CRITICAL_THINKING=true              # true = enable, false = disable

# Environment
NODE_ENV=development                # development | production
```

## config.json Reference

| Key | Default | Description |
|-----|---------|-------------|
| `PORT` | `8080` | Server port |
| `HOST` | `` | Bind address |
| `API_KEY` | `` | API key untuk auth |
| `BROWSER` | `chromium` | Browser engine |
| `CRITICAL_THINKING` | `true` | Critical thinking mode |
| `TOOL_CALLING` | `true` | Enable tool/function calling |
| `CLEAN_OUTPUT` | `true` | Strip XML artifacts dari output |
| `STREAMING_MODE` | `auto` | auto | stream | non-stream |
| `QWEN_FETCH_TIMEOUT_MS` | `30000` | Timeout fetch ke Qwen (ms) |
| `RATE_LIMIT_COOLDOWN_MS` | `120000` | Cooldown setelah rate limit (ms) |
| `RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts |
| `RETRY_ENABLED` | `true` | Enable auto retry |

## Struktur Project

```
qwengates/
├── src/
│   ├── index.tsx                  # Entry point server (Hono)
│   ├── cli.ts                     # CLI untuk manage server (qg)
│   ├── cli-client.ts              # CLI client untuk chat
│   ├── cluster.ts                 # Multi-process cluster mode
│   ├── middleware/
│   │   └── rateLimit.ts           # Rate limiting middleware
│   ├── routes/
│   │   ├── chat.ts                # /v1/chat/completions handler
│   │   ├── chatHelpers.ts         # Business logic + system prompt injection
│   │   ├── chatHelpersCore.ts     # Core streaming utilities
│   │   ├── chatStreaming.ts       # Streaming response handler
│   │   ├── chatNonStreaming.ts    # Non-streaming response handler
│   │   ├── anthropic.ts           # Anthropic Messages API
│   │   ├── accounts.ts            # Account CRUD API
│   │   ├── config.ts              # Config API
│   │   └── dashboard/             # Web dashboard
│   ├── services/
│   │   ├── auth.ts                # Authentication service
│   │   ├── qwen.ts                # Qwen API integration
│   │   ├── configService.ts       # Configuration management
│   │   ├── criticalThinkingPrompt.ts  # Critical thinking system prompt
│   │   ├── defaultSystemPrompt.ts # Default system prompt
│   │   ├── playwright.ts          # Playwright browser management
│   │   └── sessionPool.ts         # Session pooling
│   ├── types/
│   │   └── openai.ts              # OpenAI-compatible types
│   └── utils/
│       ├── env.ts                 # Environment detection
│       ├── paths.ts               # Path utilities
│       ├── validation.ts          # Request validation
│       └── tokenEstimator.ts      # Token estimation
├── scripts/
│   └── setup.js                   # Interactive setup wizard
├── docs/
│   ├── CRITICAL_THINKING.md       # Critical thinking mode docs
│   ├── CLI_CLIENT.md              # CLI client docs
│   ├── API.md                     # API reference
│   ├── ARCHITECTURE.md            # Architecture overview
│   └── DEPLOYMENT.md              # Deployment guide
├── .env.example                   # Environment template
├── config.json                    # Runtime configuration
├── package.json                   # Dependencies & scripts
└── tsconfig.json                  # TypeScript configuration
```

## Development Scripts

```bash
# Start server (development)
bun start

# Start server dengan auto-reload
bun dev

# Build TypeScript
bun run build

# Start CLI client (interactive chat)
bun run cli

# Run tests
bun test

# Run linter
bun run lint

# Format code
bun run format
```

## How to Add a Qwen Account

### Via Dashboard (Recommended)
1. Buka `http://localhost:8080/dashboard`
2. Klik **Accounts** di sidebar
3. Klik **Add Account**
4. Masukkan email dan password Qwen
5. Klik **Save**

### Via API
```bash
curl -X POST http://localhost:8080/api/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"email": "user@example.com", "password": "your-password"}'
```

## Testing the API

```bash
# List models
curl http://localhost:8080/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Chat completion (streaming)
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "Jelaskan AI"}],
    "stream": true
  }'

# Test critical thinking mode
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {"role": "user", "content": "Analisis risiko investasi crypto"}
    ],
    "stream": true
  }'
```

## Troubleshooting

### "No saved accounts found"
Tambahkan Qwen account via dashboard → Accounts → Add Account.

### Port already in use
```bash
# Cek process yang menggunakan port
lsof -i :8080
# Atau ganti port di .env
PORT=8081
```

### Playwright browser not found
```bash
bunx playwright install chromium
```

### Rate limit / daily usage limit
- Tambahkan multiple accounts untuk rotasi
- Qwen Gate akan auto-rotate accounts saat rate limited
- Cek dashboard → Monitor untuk status accounts

### Critical thinking tidak muncul
- Pastikan `CRITICAL_THINKING=true` di `.env` atau `config.json`
- Cek dashboard → Settings → Critical Thinking
- System prompt hanya efektif untuk request baru
