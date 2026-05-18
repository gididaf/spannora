# spannora — context for future sessions

Self-hosted web chat for [Claude Code](https://docs.claude.com/en/docs/claude-code/sdk). Runs on a Linux VM, talks to Claude via the Agent SDK, accessed in a browser (PWA-installable). Personal tool for controlling Claude on remote VMs from any device.

## Identity

- All git/GitHub identity here is **gididaf1@gmail.com**.
- Repo: `github.com/gididaf/spannora` (public).

## Where to look

| Need | File |
|---|---|
| HTTP entrypoint, router, SSE writer, auth gate | `src/server.ts` |
| SDK `query()` wrapper + cancel/interrupt | `src/chat.ts` |
| SQLite schema, DAOs, idempotent migrations | `src/db.ts` |
| bcrypt + cookie sessions + setup token | `src/auth.ts` |
| Structured JSON logger (stdout/stderr, one line per entry) | `src/log.ts` |
| Retention job — deletes old conversations + matching JSONL | `src/retention.ts` |
| Browser app (single file, vanilla JS) | `public/app.js` |
| Index page (inline CSS, no framework) | `public/index.html` |
| PWA manifest + service worker | `public/manifest.webmanifest`, `public/sw.js` |
| Tarball builder | `scripts/package.mjs` |
| One-line installer (Caddy/nginx auto, certbot, sslip.io) | `install.sh` |
| Manual deploy reference | `deploy/DEPLOY.md` |
| systemd unit (runs as root) | `deploy/spannora.service` |

## Stack

TypeScript on Node ≥20, plain `node:http` (no Fastify/Express), `better-sqlite3`, `bcryptjs` (pure-JS, no native build), `@anthropic-ai/claude-agent-sdk` (which bundles its own `cli.js` — no separate Claude Code install needed). Frontend is vanilla JS + one inline-CSS HTML page. SSE for streaming.

## Local dev

```bash
npm install
npm run dev              # tsx watch src/server.ts → http://localhost:7878
npx tsc --noEmit         # type-check without emitting
```

First boot prints a setup token in a banner box (see `auth.ts`). Visit `/setup`, paste it, create the account, you're in.

## Release flow

```bash
# 1. Bump version in package.json
# 2. Build tarball
npm run package          # → spannora-<version>.tar.gz at repo root
# 3. Commit + push + release (gh needs the shtum-wrapped token)
shtum run -- bash -c 'GH_TOKEN={GH_TOKEN} gh release create vX.Y.Z \
   spannora-X.Y.Z.tar.gz --title "..." --notes-file ...'
# 4. Delete the local tarball
```

The installer fetches `/releases/latest` so whatever tag you create becomes the new install target. **GitHub raw URL has a ~5 min CDN cache** — if `install.sh` keeps fetching the old version after a release, wait it out or hit the tag URL directly (`raw.githubusercontent.com/gididaf/spannora/vX.Y.Z/install.sh`).

## Deployment topology

The installer drops everything at:

- `/opt/spannora/` — code (compiled `dist/`, `public/`, `node_modules/`, `deploy/`, `package*.json`)
- `/var/lib/spannora/spannora.db` — SQLite (set via `SPANNORA_DB` env)
- `/root/.claude/` — Claude Code auth (SDK looks here because we run as root)
- `/etc/systemd/system/spannora.service` — systemd unit
- `/etc/caddy/conf.d/spannora.caddy` or `/etc/nginx/conf.d/spannora.conf` — proxy snippet

**Runs as root by design.** No `User=` line in the systemd unit. The point: from a phone, you tell Claude to do something on a VM, and tool calls (Bash, Edit, Write) need filesystem access to that VM. Sandboxing defeats the use case. The auth gate is the line of defense. Treat the web UI like a root shell.

The installer detects existing reverse proxies via `systemctl is-active`:

- No proxy → installs Caddy, configures sslip.io with auto Let's Encrypt
- nginx running → writes `/etc/nginx/conf.d/spannora.conf` then runs `certbot --nginx` to provision HTTPS
- Apache / other → warns and skips proxy setup

`SPANNORA_DOMAIN` overrides the default `<public-ip>.sslip.io` hostname. `SPANNORA_NO_PROXY=1` skips proxy entirely. `SPANNORA_NO_HTTPS=1` (nginx path only) skips certbot. `SPANNORA_ACME_EMAIL` for Let's Encrypt registration.

## Claude Agent SDK gotchas

- `permissionMode: 'bypassPermissions'` **requires** `allowDangerouslySkipPermissions: true` together; SDK throws otherwise.
- `options.resume = <session_id>` resumes. The session ID comes from `SystemMessage.session_id` (init) and is repeated on every `SDKResultMessage`. **The latest one wins** — it can change on fork.
- Resume requires the **exact same `cwd`** as the original call. SDK keys its on-disk JSONL by encoded-cwd; resume with a different cwd silently starts a fresh session. Store cwd with the conversation row.
- Never use `continue: true` once there are multiple conversations — it picks "most recent session for this cwd" and cross-contaminates threads sharing a cwd.
- Tool correlation: match `tool_use.id` (assistant) ↔ `tool_result.tool_use_id` (user). **Never trust message ordering.**
- `Query.interrupt()` only works in streaming-input mode (passing `AsyncIterable<SDKUserMessage>` instead of a string prompt). We pass strings, so our stop button uses `q.return(undefined)` via the async-generator protocol — functionally equivalent for our purposes.
- The SDK's bundled CLI lives at `/opt/spannora/node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. Run that to `/login` Claude Code when needed — no separate Claude Code install required.
- Context-fill % matches Claude Code's status-line math (see bundled `cli.js` — `Qo`/`OI` for numerator, `_DA`/`bd` for denominator). **Numerator:** `input_tokens + cache_read + cache_creation + output_tokens` from the latest assistant turn's `usage` (output is included — don't drop it). **Denominator:** `contextWindow(model) − maxOutputTokens(model)`, where both come from substring lookups on the model id — `model.includes("[1m]") → 1M, else 200K`, and `maxOutputTokens` is a model-family table (opus-4-5 → 64k, opus-4 → 32k, sonnet-4/haiku-4 → 64k, etc.). The SDK *does* expose `modelUsage[m].contextWindow`, but Claude Code itself ignores it, so we ignore it too. The same lookups live in both `src/server.ts` (sidebar badge) and `public/app.js` (done-line) — keep them in sync.
- Default model is `claude-opus-4-7[1m]` (1M context Opus 4.7). The `[1m]` suffix is what triggers the 1M variant; the SDK's `betas: ['context-1m-2025-08-07']` header is **Sonnet 4/4.5 only** per the SdkBeta typedef, so do NOT add it for Opus. Override via `SPANNORA_MODEL` env var.
- `bypassPermissions` does **not** swallow tools that flag `requiresUserInteraction: true` — currently `AskUserQuestion` and `ExitPlanMode`. The SDK's permission resolver returns `behavior:"ask"` for those *before* the bypass shortcut, so they still flow into `canUseTool`. That's why `chat.ts`'s `canUseTool` branches on `toolName === "AskUserQuestion"` and pass-throughs everything else with `{behavior:"allow", updatedInput:input}`. Verified by reading `cli.js` (search `requiresUserInteraction` and `==="bypassPermissions"`).
- `AskUserQuestion` round-trip: model emits `tool_use` with `{questions:[...]}` → SDK invokes `canUseTool` → host resolves to `{behavior:"allow", updatedInput:{questions, answers}}`. The `tool_result` content the SDK emits afterwards is **a plain string, not JSON**: `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user's answers in mind.` — parse with `/"([^"]*)"="([^"]*)"/g`.
- `AskUserQuestion` "Other" is host-side: the schema docstring says *"There should be no 'Other' option, that will be provided automatically"*, so always render a free-text fallback regardless of `options`. We render it as one more radio/checkbox row that auto-checks when the user types.

## Auth model

Single user, in-app. `bcryptjs` (~12 rounds), session cookies (`HttpOnly`, `SameSite=Strict`, `Secure` when behind HTTPS), 30-day sliding window. Setup token (24 random bytes, base64url) printed in a banner on first boot. `SPANNORA_RESET=1` env wipes all users + sessions and regenerates the token.

`isPublicPath()` in `server.ts` defines what bypasses the auth gate: `/login*`, `/setup*`, `/favicon.ico`, `/api/auth/status|setup|login`, and the PWA-essentials (`/sw.js`, `/manifest.webmanifest`, `/icons/*`). Everything else is 401 (for `/api/*`) or 302 → `/login` (for HTML).

## PWA gotchas

- The service worker (`public/sw.js`) has a `VERSION` constant — bump it on cache-strategy or precache-list changes so existing installs purge old caches via the activate handler.
- **Never precache auth-gated paths** (`/app.js`, `/login.js`, etc.). If the SW installs before login, the precache fetch follows a 302 → /login and stores login HTML under the asset's cache key, breaking the next authed visit. v0.3.0 had this bug; v0.3.1 fixed it.
- `isCacheable()` in the SW rejects redirected responses, non-200s, and responses whose `resp.url !== req.url`. Belt and braces against the above.
- API paths (`/api/*`) are never intercepted by the SW — chat streaming, auth, and conversation state must always hit live.
- Safe-area insets: header and footer use `padding: max(<original>, env(safe-area-inset-*))` so Android nav buttons and the iOS notch don't cover UI. `viewport-fit=cover` must be in the viewport meta for these env vars to be non-zero.

## shtum + GitHub API

`gh` and any `curl` call to GitHub's API are intercepted by a `shtum` PreToolUse hook (it's a Rust tool the user wrote — see `~/Documents/Code/utilities/shtum/`). It blocks commands missing a `{GH_TOKEN}` placeholder. To run `gh` in this repo, wrap with `shtum run -- bash -c 'GH_TOKEN={GH_TOKEN} gh ...'`. The `bash -c` wrapping is required for multi-statement commands (single-statement commands work via the auto-rewrite, but anything with `&&` or pipes needs the explicit wrap).

curl `-w "%{http_code}"` etc. also trips shtum because `%{...}` looks like a placeholder. Either avoid the `-w` format, or wrap the whole command in `shtum run -- bash -c '...'`.

## Build / packaging quirks

- `scripts/package.mjs` adds `--no-xattrs --no-mac-metadata --no-fflags` to `tar` on macOS so the tarball doesn't carry `LIBARCHIVE.xattr.com.apple.provenance` PAX headers that emit warnings on Linux extract.
- The tarball stages: `dist/`, `public/`, `deploy/`, `package.json`, `package-lock.json`. No source TS, no devDeps. `npm install --omit=dev` on the target adds runtime deps only.

## Phase status (original /plan)

All 7 phases done.

1. Local chat loop — v0.1.0
2. Tool cards (generic + pretty) — v0.1.0
3. SQLite + multi-thread sidebar — v0.1.0
4. Auth — v0.1.0
5. Manual server deploy — v0.1.0
6. One-line installer — v0.1.0 (with later iterations through e040148)
7. Operational polish (stop button, ctx%, JSON logs, retention) — v0.2.0
8. PWA install — v0.3.0, fixes in v0.3.1

**Out of scope per the original plan:** file upload/download, multi-user accounts, cross-host session adapters, built-in TLS, mobile-first UI polish (responsive is enough).

**Plausible follow-ups if asked:** push notifications (needs VAPID + a broadcaster), model switcher in the UI, conversation export, slash-command shortcuts, per-conversation cost (`total_cost_usd`) alongside the existing ctx%.
