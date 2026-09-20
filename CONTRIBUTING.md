# Contributing

Thanks for improving Gmail Control Engine.

## Before opening a pull request

1. Use Node.js 24 or newer.
2. Run `npm ci`.
3. Run `npm run check`.
4. Run `npm test`.
5. Run `npm audit --omit=dev`.
6. Do not add real credentials, OAuth tokens, private recipient lists, or runtime database files.

Keep changes focused, preserve idempotency guarantees, and add regression coverage for queue, persistence, OAuth, or retry behavior you modify.
