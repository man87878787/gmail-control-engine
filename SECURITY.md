# Security Policy

## Reporting a vulnerability

Please report security issues privately to the repository owner rather than opening a public issue containing exploit details or credentials.

## Secret handling

Gmail Control Engine stores OAuth credentials, account tokens, the local agent key, queue databases, logs, and backups under the local `data/` directory. The directory is excluded from Git by default.

Never commit:

- Google OAuth client secrets
- OAuth access or refresh tokens
- `agent-key.txt`
- SQLite runtime databases
- `.env`
- production recipient lists or message bodies containing private data

If a credential is accidentally committed, revoke/rotate it immediately; deleting the file from the latest commit is not enough because Git history may retain it.

## Network boundary

The service binds to `127.0.0.1` by default. If you intentionally expose it beyond localhost, place it behind an authenticated, encrypted network boundary and review the threat model first.


## Assistant-layer protections

The production assistant stores semantic indexes, staged actions, and Gmail history cursors only under the ignored local `data/` directory. High-risk assistant actions require explicit approval before execution. Permanent-delete is not exposed by the assistant API.

The optional Gmail push endpoint is disabled unless `GMAIL_PUSH_TOKEN` is configured. If the push endpoint is exposed outside localhost, use TLS and a trusted ingress in addition to the token. The optional local-model and embedding integrations default to loopback/local endpoints; there is no automatic cloud fallback.

Use `privacy.mjs` before writing untrusted payloads to logs or sending them outside the local trust boundary. Never assume heuristic phishing or priority classifications are infallible.
