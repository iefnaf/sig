# No chat channel: a SERVER_KEY-gated owner API

Browser sign-in and new-deployment key ownership are superseded by [ADR-0010](0010-browser-password-authentication.md). The explicit-key owner API remains available for compatibility.

The Feishu integration — QR onboarding, manual credentials, the event webhook, the sealed tenant token, and card rendering — is removed for now: it was the largest and most intricate slice of the deployment, and the product works without a chat provider. Whoever holds `SERVER_KEY` is the owner. The Worker now serves four keyed routes that forward into the Durable Object:

- `POST /api/messages` — the owner's text (quote with `replyTo` = a sent message id for deterministic Thread routing); the spend phrases (`/花费` 等) stay deterministic.
- `GET /api/messages?after=<sentAt-ms>` — the read side: sent rows grouped by `providerMsgId` (a quiet-merged group shares one id and re-renders as one message).
- `POST /api/actions` — a button callback on one of our messages (ask options, PR consent, note decisions, offline asks). No request-level dedup: the handlers are idempotent and duplicate taps deserve their honest replies.
- `POST /api/pairing` and `POST /api/login-link` — what the chat commands `/加机器` and `/网页` used to do.

Consequences: "delivery" is local — an outbound row settles as sent with `providerMsgId` = row id (merged groups share a membership-scoped uuid), so no pacing, backoff, or token refresh exist; cards became `LocalMessage` objects (structured text + opaque-action buttons) rendered by `report-template.ts`; `sh_inbound`/`sh_outbound`/`sh_channel_log` run on channel `'local'` while the old Feishu tables stay in place (append-only migrations; they are simply unused). This supersedes ADR-0001 decisions 8–9 (setup page, webhook-only inbound) and decision 7's "no HTTP admin routes" — the API **is** the admin surface, gated by the deploy secret itself. `SERVER_KEY_PREVIOUS` is accepted during a rotation window so a configured client keeps working. A future chat channel reintroduces an adapter behind the same outbound queue, not a new core.
