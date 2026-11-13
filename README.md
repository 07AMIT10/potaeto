# Potaeto

Persistent personal AI companion and sentient agent core with durable memory, hardware control, scientific research grounding, and local voice.

Potaeto is a privacy-first, self-hosted sentient personal agent designed for continuous local execution. It unites deep persistent memory across sessions, hardware actuation and environmental sensing, sandboxed shell execution with cryptographic approval gating, scientific research grounding via Lens OS, speech synthesis/transcription, and proactive autonomous workflows.

---

## Architecture Overview

```
                                +---------------------------+
                                |  Next.js 16.4.6 Static   |
                                |     PWA Client (out/)     |
                                +-------------+-------------+
                                              | HTTP / SSE
                                              v
+------------------------+      +---------------------------+      +--------------------------+
|  Telegram Bot Client   | ---> |   FastAPI Core Engine     | <--- | Scheduled Workflows      |
|  (Inline Approvals)    |      | (apps/orchestrator :8010) |      | (Cron & Autonomous Runs) |
+------------------------+      +-------------+-------------+      +--------------------------+
                                              |
      +-------------------+-------------------+-------------------+-------------------+
      |                   |                   |                   |                   |
      v                   v                   v                   v                   v
+------------+      +------------+      +------------+      +------------+      +------------+
| SQLite WAL |      | Bubblewrap |      |  Lens OS   |      |  Arduino   |      | Voice Core |
| Durable    |      | Sandboxed  |      |  Research  |      | Serial v1  |      | Piper TTS  |
| Memory     |      | Execution  |      | Sidecar    |      | BLE Sense  |      | Whisper STT|
+------------+      +------------+      +------------+      +------------+      +------------+
```

### Core Subsystems

1. **FastAPI Core Engine (`apps/orchestrator`, `:8010`)**:
   Single-flight turn queue, streaming server-sent events (SSE), resilient provider routing (OpenCode Go, OpenRouter, offline fallback), and cryptographic approval gating.
2. **Next.js Static PWA Client (`out/`)**:
   Next.js 16.4.6 frontend exported as static assets (`output: 'export'`), backed by IndexedDB and offline-first queue synchronization (`/v1/sync`). Served locally via Caddy on `:8080`.
3. **Durable Governed Memory (SQLite WAL)**:
   SQLite WAL database (`journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`) storing facts, episodic summaries, tool audit records, and proactive scheduler state. Enforces a 7-scenario formal memory lifecycle (restart recall, multi-session aggregation, updates/superseding, temporal validity expiration, retraction, remembered preferences, and scope isolation).
4. **Tool Approval & Sandboxed Execution**:
   Deterministic action hashing (`sha256(tool_name + canonical_args)`), expiring one-time approvals via Web UI or Telegram inline buttons, and unshared-namespace Linux sandboxing using Bubblewrap (`bwrap`) locked to `data/sandbox`.
5. **Academic Research Grounding (Lens OS Sidecar)**:
   Stdio JSON-RPC 2.0 integration with native Rust `lens-mcp` sidecar, providing empirical paper discovery, source retrieval, and claim verification across OpenAlex, arXiv, and PubMed with full SSRF protection.
6. **Hardware Telemetry & LED Bridge**:
   Non-blocking async serial bridge communicating with Arduino Nano 33 BLE Sense Rev2 over `/dev/potaeto-arduino` at 115200 baud via Protocol v1. Features active-low RGB LED actuation (solid, blink, breathe presets) and telemetry collection (temperature, humidity, barometric pressure, light, 3-axis accelerometer).
7. **Local Voice Worker (`potaeto-voice`)**:
   Isolated voice processing subsystem running in a dedicated systemd slice (`MemoryMax=1G`). Fast neural text-to-speech with Piper TTS, deterministic SHA-256 audio disk caching, and Whisper.cpp speech-to-text transcription.
8. **Proactive Autonomous Workflows**:
   Cron-scheduled multi-step workflows executing tool calls, LLM steps, condition branching, notifications, and memory persistence with concurrency-safe database leasing.

---

## Release 1 & Release 2 Capabilities

| Capability | Implementation | Description |
|------------|----------------|-------------|
| **Durable Memory** | `app.memory.service.MemoryService` | 7-scenario memory lifecycle, temporal validity, retraction, and 75% context rollup |
| **Tool Approvals** | `app.db.repositories.approvals.ApprovalRepo` | Exact SHA-256 action hashing, expiring one-time tokens, Web & Telegram resolution |
| **Sandboxed Execution**| `app.tools.run_command.run_command` | Bubblewrap (`bwrap`) namespace containment with read-only system roots and isolated workspace |
| **Scientific Research**| `app.tools.lens_mcp.LensMcpClient` | Literature search, PDF source extraction, and claim verification via `lens-mcp` |
| **Hardware Actuation** | `app.hardware.arduino.ArduinoBridge` | Protocol v1 JSON framing over serial, active-low RGB inversion, and bounded telemetry retention |
| **Local Voice** | `app.voice.tts.PiperTts`, `app.voice.stt.WhisperStt` | Low-latency Piper TTS with disk caching and Whisper.cpp voice note transcription |
| **Proactive Workflows**| `app.workflows.engine.WorkflowEngine` | Declarative JSON workflows running under advisory leases via `JobRunner` |

---

## Quickstart & Local Setup

### Prerequisites

- **Python**: `>= 3.11` (managed via `uv`)
- **Node.js**: `>= 20.x`
- **Linux Tools** (optional for full hardware/sandbox runtime): `bubblewrap` (`bwrap`), `pyserial-asyncio`

### 1. Installation

Clone the repository and install dependencies:

```bash
# Install frontend dependencies
npm install

# Install orchestrator dependencies with dev extras
cd apps/orchestrator
uv sync --extra dev
cd ../..
```

### 2. Configuration

Copy the example configuration:

```bash
cp .env.example .env
```

Key environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `POTAETO_PORT` | HTTP port for the FastAPI core | `8010` |
| `POTAETO_DB_PATH` | Path to SQLite database file | `data/potaeto.db` |
| `POTAETO_MODEL` | Active LLM model identifier | `opencode-go/deepseek-v4.1-flash` |
| `POTAETO_SANDBOX_DIR` | Host directory for bwrap workspace | `data/sandbox` |
| `POTAETO_ARDUINO_PORT` | Serial device for Arduino bridge | `/dev/potaeto-arduino` |
| `TELEGRAM_BOT_TOKEN` | Bot API token for Telegram interface | `""` (disabled) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated allowed chat IDs | `""` |

### 3. Running Locally

Start the FastAPI core engine:

```bash
cd apps/orchestrator
uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 8010 --reload
```

In a separate terminal, run the Next.js development server:

```bash
npm run dev
```

Visit `http://localhost:3000` to interact with Potaeto.

---

## Verification & Testing

Potaeto enforces comprehensive test coverage across both backend and frontend.

### Run All Tests & Verifications

Execute the consolidated smoke test script:

```bash
bash scripts/smoke-release-2.sh
```

### Individual Test Suites

- **Backend Pytest Suite (379+ tests)**:
  ```bash
  cd apps/orchestrator
  uv run --extra dev pytest
  ```

- **Acceptance Scenarios Suite**:
  ```bash
  cd apps/orchestrator
  uv run --extra dev pytest tests/test_acceptance_release_2.py -v
  ```

- **Frontend Vitest Suite (47+ tests)**:
  ```bash
  npm test
  ```

- **Static Export Build**:
  ```bash
  npm run build
  node scripts/check-static-export.mjs
  ```

- **PII & Secret Hygiene Scan**:
  ```bash
  bash scripts/check-pii.sh
  ```

---

## Project Structure

```
├── apps/
│   └── orchestrator/                 # Python FastAPI core engine
│       ├── app/
│       │   ├── agent/                # Turn queue, context builder, agent loop
│       │   ├── api/                  # REST & SSE routers (chat, approvals, voice, hardware)
│       │   ├── db/                   # SQLite schema migrations and repositories
│       │   ├── hardware/             # Arduino Protocol v1 serial bridge
│       │   ├── memory/               # Governed memory service, FTS indexer, tools
│       │   ├── providers/            # LLM providers (OpenCode Go, OpenRouter, offline)
│       │   ├── scheduler/            # Cron runner and leased execution engine
│       │   ├── tools/                # run_command, lens_mcp, arduino, monitor tools
│       │   ├── voice/                # Piper TTS & Whisper.cpp runners
│       │   └── workflows/            # JSON workflow engine and step interpreters
│       └── tests/                    # Pytest test suite (379+ tests)
├── src/                              # Next.js 16.4.6 static PWA client
│   ├── app/                          # App router pages (chat, memory, hardware, pair)
│   ├── components/                   # UI components (ApprovalModal, ArduinoPanel, MemoryGovernance)
│   └── lib/core/                     # Client API, IndexedDB storage, sync engine
├── deploy/                           # Systemd service units and caddy configurations
├── scripts/                          # Smoke tests, backup utilities, and PII scanners
└── out/                              # Static production build export
```

---

## Privacy and Open-Source Safety Rule

This project is built under strict open-source and privacy-preserving guidelines:
- Tracked git history must never contain real names, personal email addresses, private IP addresses, personal domains, home usernames, or credentials.
- Always run `bash scripts/check-pii.sh` prior to committing changes.
- Refer to [docs/PII_POLICY.md](docs/PII_POLICY.md) for full compliance guidelines.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
