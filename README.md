# Gmail Control Engine

A production-grade, local-first Gmail API queue built for reliable agent-driven email workflows.

Gmail Control Engine is deliberately **headless**: no dashboard, no browser-heavy control panel, and no hidden "current account" state. Jobs are submitted through a compact JSON CLI/API, persisted in normalized SQLite tables, and routed through explicit Gmail account profiles.

## Highlights

- Up to **4 isolated Gmail profiles** per engine.
- Up to **500 unique recipients per job**.
- Explicit sender profile on every job.
- Separate OAuth token storage, rate limits, daily caps, and pause state per Gmail profile.
- Normalized **SQLite + WAL** persistence with indexed campaign and recipient queues.
- Required job-key idempotency with conflict detection.
- Deterministic RFC `Message-ID` values and post-crash Gmail reconciliation to reduce duplicate sends.
- Global, account, and campaign-level throttling with evenly paced requests.
- Exponential retry with jitter and permanent/transient error classification.
- Gmail-limit and OAuth circuit breakers that pause only the affected account.
- Email/domain suppression lists.
- Shared templates or unique subject/body content per recipient.
- Draft and direct-send modes.
- Inbox search, reading, replies, and label operations.
- Authenticated localhost API using a generated 256-bit agent key.
- OAuth CSRF state validation and expected-account verification.
- Graceful shutdown with in-flight worker draining.
- SQLite integrity checks and online backups.
- Machine-readable JSON output designed for agents and automation.
- No runtime credentials, OAuth tokens, queue databases, or logs are tracked by Git.

## Architecture

```text
Agent / CLI
    |
    v
Authenticated localhost API
    |
    v
Normalized SQLite queue (WAL)
    |
    +--> Gmail profile A --> Gmail API
    +--> Gmail profile B --> Gmail API
    +--> Gmail profile C --> Gmail API
    +--> Gmail profile D --> Gmail API
```

Each campaign is permanently associated with an explicit Gmail profile. There is no global sender that can silently change underneath a job.

## Requirements

- Node.js **24 or newer**
- A Google Cloud project with the Gmail API enabled
- An OAuth 2.0 client you control
- Gmail accounts you are authorized to access

This project does not bypass Gmail sending limits or anti-abuse systems. The engine applies conservative defaults and pauses when Gmail reports account-level sending limits.

## Install

```bash
git clone https://github.com/man87878787/gmail-control-engine.git
cd gmail-control-engine
npm install
npm test
```

Start the service:

```bash
npm start
```

By default it binds only to:

```text
http://127.0.0.1:4317
```

On Windows you can also use:

```text
start-gmail-control.cmd
stop-gmail-control.cmd
```

The PowerShell launchers resolve the project directory dynamically and do not require a hardcoded username or install path.

## Safe startup behavior

Every service start forces the global queue to:

```text
masterPaused = true
pauseReason = "startup"
```

Each Gmail account also maintains its own pause state. A job cannot send unless:

1. the engine is globally resumed,
2. the selected Gmail profile is authorized,
3. that Gmail profile is resumed, and
4. the campaign is running.

## Configure Google OAuth

Create a Google OAuth client JSON, then load it into the local engine:

```powershell
npm.cmd run agent -- oauth-config C:\path\to\google-client.json
```

The OAuth client is shared by the engine, while each Gmail profile receives a separate token file.

## Add Gmail profiles

Create a profile with an alias and, optionally, an expected email address:

```powershell
npm.cmd run agent -- account-add northline northline@example.com "Northline"
npm.cmd run agent -- account-add personal personal@example.com "Personal"
```

The engine supports at most four profiles.

Get the authorization URL for one profile:

```powershell
npm.cmd run agent -- account-oauth-url northline
```

If an expected email was configured, the OAuth callback verifies that Google returned that exact account before storing the token.

## Create a job

Example job file:

```json
{
  "jobKey": "example-campaign-001",
  "name": "Example campaign",
  "account": "northline",
  "mode": "draft",
  "start": false,
  "ratePerMinute": 20,
  "subject": "Quick question for {{name}}",
  "body": "Hi {{name}},\n\nThis is an example message.",
  "recipients": [
    {
      "email": "hello@example.com",
      "name": "Example"
    }
  ]
}
```

Validate before queueing:

```powershell
npm.cmd run agent -- validate C:\path\to\job.json
```

Create the job:

```powershell
npm.cmd run agent -- create C:\path\to\job.json
```

The `jobKey` is required. Re-submitting the same key with identical content returns the existing job. Reusing the same key with different content returns an idempotency conflict rather than silently duplicating or mutating the campaign.

## Core agent commands

```text
agent status
agent live
agent ready
agent accounts

agent account-add <alias> [expected-email] [label]
agent account-oauth-url <alias>
agent account-action <alias> <pause|resume> [reason]
agent account-config <alias> <settings.json>

agent validate <job.json>
agent create <job.json>
agent job <job-id-or-key>
agent bind <job-id-or-key> <account>
agent job-config <job-id-or-key> <rate-per-minute>
agent action <job-id-or-key> <start|pause|resume|cancel|retry-failed>

agent system <pause|resume> [reason]
agent config <settings.json>
agent backup [destination.sqlite3]

agent inbox <account> <gmail-query> [max]
agent read <account> <message-id>
agent reply-draft <account> <message-id> <body-file>
agent reply-send <account> <message-id> <body-file>

agent suppress <email|domain> <value> [reason]
agent suppress-account <account> <email|domain> <value> [reason]
agent logs [limit]
```

Use them through npm:

```powershell
npm.cmd run agent -- status --pretty
```

Compact single-line JSON is the default; add `--pretty` for human-readable output.

## Queue and retry behavior

The worker keeps account lanes independent. A quota or authentication failure on one Gmail profile pauses that profile without freezing unrelated accounts.

Each recipient has its own persistent state:

```text
queued -> sending -> sent/drafted
              \-> retry -> sending
              \-> failed
```

If the service stops while a recipient is in `sending`, startup recovery moves it to `retry` with reconciliation enabled. Before sending again, the worker searches Gmail for that item's deterministic RFC `Message-ID`. If Gmail already accepted it, the local queue is reconciled instead of blindly creating another copy.

## Default limits

The defaults are intentionally conservative:

- 4 Gmail profiles maximum
- 500 recipients per job
- 500 recipient units per profile/day
- 50 actions per minute per profile
- 8 global concurrent operations
- 3 concurrent operations per profile
- 6 attempts per recipient
- exponential retry with jitter

Actual Gmail account and API limits are controlled by Google and may differ by account type. Gmail Control Engine does not attempt to evade them.

## Health checks

Unauthenticated localhost probes:

```text
GET /health/live
GET /health/ready
```

The readiness response includes SQLite integrity, schema version, Google OAuth client configuration, and worker status.

## Private runtime data

Runtime data lives under `data/` and is excluded from Git.

Examples:

```text
state.sqlite3
state.sqlite3-wal
state.sqlite3-shm
agent-key.txt
google-oauth-client.json
oauth-token-*.json
oauth-states.json
server.out.log
server.err.log
backups/
```

Do not commit or share those files.

## Development

```bash
npm run check
npm test
npm audit --omit=dev
```

The test suite covers:

- 500-recipient acceptance and 501-recipient rejection
- controlled repeated-recipient load-test expansion
- job fingerprint stability
- idempotent replay and conflict behavior
- four-account boundary enforcement
- normalized SQLite persistence and backups
- recipient parsing and deduplication
- template rendering
- recipient-unit counting
- deterministic message IDs

## Responsible use

Use Gmail Control Engine only with accounts and recipients you are authorized to contact. It is a queue/reliability layer, not a tool for bypassing Gmail limits, unsolicited bulk messaging rules, or provider abuse protections.

## License

MIT


## Inbox Intelligence (3.0)

The engine now includes a local, deterministic understanding layer for inbox triage. It does **not** send email content to a third-party AI service.

It can:
- summarize message text;
- detect likely requests and whether a reply is expected;
- classify common payment, meeting, account/security, order, and support mail;
- flag urgency/deadline language;
- extract dates, money amounts, and links;
- identify likely automated/no-reply mail;
- roll an entire conversation into a thread-level summary;
- triage an inbox and sort higher-priority messages first.

Commands:

```text
npm run smart -- understand <account> <message-id>
npm run smart -- thread <account> <thread-id>
npm run smart -- triage <account> "in:inbox is:unread" 20
```

The intelligence output is machine-readable JSON so another authorized agent can use it as context. Classification is heuristic, so consequential actions should still be reviewed rather than treated as infallible.


## Production Assistant Architecture (4.0)

Version 4 adds a local-first assistant layer without removing the existing queue and safety controls.

- **Semantic memory:** local SQLite vector index with a dependency-free deterministic embedding fallback, plus adapters for Ollama or a local embedding HTTP service (including MiniLM/ONNX servers).
- **Safe action staging:** replies, archive, labels, and trash operations are staged first. High-risk actions such as sending and trashing require explicit approval before execution.
- **Thread DAGs:** RFC Message-ID, In-Reply-To, and References headers are mapped into parent/child reply graphs with unresolved-request and bottleneck signals.
- **Local LLM JSON mode:** optional Ollama analysis uses temperature 0 and strict JSON parsing. No cloud model fallback is enabled by default.
- **Privacy guardrails:** reusable PII/secret scrubbers redact credentials, phone numbers, long account/card-like numbers, addresses, and email identifiers from log-safe payloads.
- **Push ingestion:** Gmail watch/history support processes Pub/Sub notifications using a durable history cursor and can index newly received mail immediately.
- **Plugin bus:** isolated event hooks with timeouts allow local extensions without modifying the core pipeline.
- **Resilience:** shared exponential-backoff utilities classify transient HTTP/network failures and honor Retry-After when available.
- **Unified inbox:** multiple configured Gmail profiles can be merged into one priority-sorted local view while preserving account identity.
- **Adversarial benchmark:** synthetic edge cases are scored in CI and fail the build if accuracy falls below the configured threshold.

### Assistant API

All `/api/assistant/*` routes remain behind the existing local agent-key authentication boundary. Important endpoints include unified inbox, semantic indexing/search, thread graphs, local deep analysis, Gmail watch setup, and the staged-action queue.

The Gmail Pub/Sub receiver is `POST /events/gmail`. It is disabled unless `GMAIL_PUSH_TOKEN` is configured, and it validates that token before processing a notification. Keep the service bound to localhost unless you deliberately place it behind a secure authenticated ingress.

### Semantic embedding providers

The default `hash` provider is offline, deterministic, and dependency-free. For stronger semantic retrieval, set `LOCAL_EMBEDDING_PROVIDER=ollama` and run a local embedding model, or set it to `http` and point `LOCAL_EMBEDDING_URL` at a local MiniLM/ONNX embedding service. Email content stays local in both modes.

### Human-in-the-loop actions

High-impact staged actions are intentionally blocked until approved. The engine currently supports staged draft replies, send replies, archive, trash, and label changes. Permanent delete is not exposed by the assistant API.
