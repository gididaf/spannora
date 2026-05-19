# spannora — context for future sessions

Self-hosted web chat for [Claude Code](https://docs.claude.com/en/docs/claude-code/sdk). Runs on a Linux VM, talks to Claude via the Agent SDK, accessed in a browser (PWA-installable). Personal tool for controlling Claude on remote VMs from any device.

Since v0.5.0 the repo is a **monorepo** with three workspaces:

- `packages/server` — the spannora backend (TypeScript, runs on the VM)
- `packages/shared` — frontend modules shared between the in-server PWA and the hub
- `packages/hub` — a standalone hub PWA that manages multiple spannora backends from one app

Each spannora install is still self-contained; the hub is optional and additive.

## Identity

- All git/GitHub identity here is **gididaf1@gmail.com**.
- Repo: `github.com/gididaf/spannora` (public).

## Where to look

| Need | File |
|---|---|
| HTTP entrypoint, router, SSE writer, auth gate | `packages/server/src/server.ts` |
| SDK `query()` wrapper + cancel/interrupt | `packages/server/src/chat.ts` |
| SQLite schema, DAOs, idempotent migrations (incl. `sessions.kind`) | `packages/server/src/db.ts` |
| bcrypt + cookie sessions + bearer tokens + setup token | `packages/server/src/auth.ts` |
| CORS allowlist (env-pinned, opt-in) | `packages/server/src/cors.ts` |
| Structured JSON logger | `packages/server/src/log.ts` |
| Retention job — deletes old conversations + matching JSONL | `packages/server/src/retention.ts` |
| In-server PWA bootstrap (consumes `@spannora/shared`) | `packages/server/public/app.js` |
| In-server index page (inline CSS, no framework) | `packages/server/public/index.html` |
| Tarball builder (dereferences shared symlink) | `packages/server/scripts/package.mjs` |
| Shared frontend module entrypoint | `packages/shared/src/index.js` |
| Hub PWA shell + inline CSS | `packages/hub/index.html` |
| Hub bootstrap, hash routing, instance switching | `packages/hub/src/main.js` |
| Hub IndexedDB layer + instance CRUD | `packages/hub/src/storage.js`, `packages/hub/src/instances.js` |
| Hub bearer-authed client wrapper | `packages/hub/src/client.js` |
| Hub Pages deploy workflow | `.github/workflows/deploy-hub.yml` |
| One-line installer (Caddy/nginx auto, certbot, sslip.io) | `install.sh` |
| Manual deploy reference | `packages/server/deploy/DEPLOY.md` |
| systemd unit (runs as root) | `packages/server/deploy/spannora.service` |

`packages/server/public/shared` and `packages/hub/shared` are checked-in symlinks to `packages/shared/src/`. mac/Linux only; Windows isn't supported as a dev platform.

## Stack

TypeScript on Node ≥20, plain `node:http` (no Fastify/Express), `better-sqlite3`, `bcryptjs` (pure-JS, no native build), `@anthropic-ai/claude-agent-sdk` (which bundles its own `cli.js` — no separate Claude Code install needed). Frontend is vanilla ES modules + one inline-CSS HTML page per app. SSE for streaming.

npm workspaces drive the monorepo. No bundler — the browser imports `/shared/*.js` directly. Server tarball staging (and the Pages deploy workflow) follow the symlink to copy real files into the artifact.

## Local dev

```bash
npm install
npm run dev              # tsx watch on the server → http://localhost:7878
npm run typecheck        # tsc -b on the server workspace
```

First boot prints a setup token in a banner box. Visit `/setup`, paste it, create the account, you're in.

### Testing the hub against multiple spannoras locally

```bash
# Spannora A
SPANNORA_PORT=7878 SPANNORA_DB=/tmp/spann-a.db \
SPANNORA_ALLOWED_ORIGINS=http://localhost:5173 \
  npm run dev -w packages/server

# Spannora B (separate terminal)
SPANNORA_PORT=7979 SPANNORA_DB=/tmp/spann-b.db \
SPANNORA_ALLOWED_ORIGINS=http://localhost:5173 \
  npm run dev -w packages/server

# Hub (static serve from packages/hub/)
npm run dev -w packages/hub    # python3 -m http.server 5173 on 127.0.0.1
```

Open `http://localhost:5173/` (not `127.0.0.1:5173/` — see CORS section). Add each spannora via the rail's `+` button; enter URL + creds; you're in.

**dev gotcha**: `tsx watch` regenerates the setup token on every reload (each restart calls `initAuth` which mints a fresh token). For repeatable manual setup-token testing, use `tsx packages/server/src/server.ts` (no watch) so the printed token stays valid until the user is actually created. The normal `npm run dev` workflow is fine for everything else — the user persists to SQLite, so the token only matters for the first-ever account.

## Release flow

```bash
# 1. Bump version in the root package.json
# 2. Build the server tarball
npm run package          # → spannora-<version>.tar.gz at repo root
# 3. Commit, tag, and push the tag — the deploy-hub.yml workflow
#    fires on v* tags and publishes the matching hub.
git tag vX.Y.Z && git push --tags
# 4. Cut the GitHub release (shtum-wrapped token)
shtum run -- bash -c 'GH_TOKEN={GH_TOKEN} gh release create vX.Y.Z \
   spannora-X.Y.Z.tar.gz --title "..." --notes-file ...'
# 5. Delete the local tarball
```

One tag = server tarball release + hub Pages deploy. Hub lands at `https://gididaf.github.io/spannora/`.

The installer fetches `/releases/latest` so whatever tag you create becomes the new install target. **GitHub raw URL has a ~5 min CDN cache** — if `install.sh` keeps fetching the old version after a release, wait it out or hit the tag URL directly (`raw.githubusercontent.com/gididaf/spannora/vX.Y.Z/install.sh`).

GitHub Pages source for the repo must be set to "GitHub Actions" (Settings → Pages → Build and deployment → Source) once, before the first deploy works.

## Deployment topology

The installer drops everything at:

- `/opt/spannora/` — code (compiled `dist/`, `public/`, `node_modules/`, `deploy/`, `package*.json`)
- `/var/lib/spannora/spannora.db` — SQLite (set via `SPANNORA_DB` env)
- `/root/.claude/` — Claude Code auth (SDK looks here because we run as root)
- `/etc/systemd/system/spannora.service` — systemd unit
- `/etc/caddy/conf.d/spannora.caddy` or `/etc/nginx/conf.d/spannora.conf` — proxy snippet

The tarball still extracts to `/opt/spannora/{dist,public,deploy,...}` (same layout as pre-monorepo) so `install.sh`, the systemd unit, and proxy snippets are unchanged. The monorepo restructure is invisible to deployed installs.

**Runs as root by design.** No `User=` line in the systemd unit. The point: from a phone, you tell Claude to do something on a VM, and tool calls (Bash, Edit, Write) need filesystem access to that VM. Sandboxing defeats the use case. The auth gate is the line of defense. Treat the web UI like a root shell.

The installer detects existing reverse proxies via `systemctl is-active`:

- No proxy → installs Caddy, configures sslip.io with auto Let's Encrypt
- nginx running → writes `/etc/nginx/conf.d/spannora.conf` then runs `certbot --nginx` to provision HTTPS
- Apache / other → warns and skips proxy setup

`SPANNORA_DOMAIN` overrides the default `<public-ip>.sslip.io` hostname. `SPANNORA_NO_PROXY=1` skips proxy entirely. `SPANNORA_NO_HTTPS=1` (nginx path only) skips certbot. `SPANNORA_ACME_EMAIL` for Let's Encrypt registration. `SPANNORA_ALLOWED_ORIGINS` (no default) opts the install into cross-origin hub access — see the CORS section.

## Claude Agent SDK gotchas

- `permissionMode: 'bypassPermissions'` **requires** `allowDangerouslySkipPermissions: true` together; SDK throws otherwise.
- `options.resume = <session_id>` resumes. The session ID comes from `SystemMessage.session_id` (init) and is repeated on every `SDKResultMessage`. **The latest one wins** — it can change on fork.
- Resume requires the **exact same `cwd`** as the original call. SDK keys its on-disk JSONL by encoded-cwd; resume with a different cwd silently starts a fresh session. Store cwd with the conversation row.
- Never use `continue: true` once there are multiple conversations — it picks "most recent session for this cwd" and cross-contaminates threads sharing a cwd.
- Tool correlation: match `tool_use.id` (assistant) ↔ `tool_result.tool_use_id` (user). **Never trust message ordering.**
- `Query.interrupt()` only works in streaming-input mode (passing `AsyncIterable<SDKUserMessage>` instead of a string prompt). We pass strings, so our stop button uses `q.return(undefined)` via the async-generator protocol — functionally equivalent for our purposes.
- The SDK's bundled CLI lives at `/opt/spannora/node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. Run that to `/login` Claude Code when needed — no separate Claude Code install required.
- Context-fill % matches Claude Code's status-line math (see bundled `cli.js` — `Qo`/`OI` for numerator, `_DA`/`bd` for denominator). **Numerator:** `input_tokens + cache_read + cache_creation + output_tokens` from the latest assistant turn's `usage` (output is included — don't drop it). **Denominator:** `contextWindow(model) − maxOutputTokens(model)`, where both come from substring lookups on the model id — `model.includes("[1m]") → 1M, else 200K`, and `maxOutputTokens` is a model-family table (opus-4-5 → 64k, opus-4 → 32k, sonnet-4/haiku-4 → 64k, etc.). The SDK *does* expose `modelUsage[m].contextWindow`, but Claude Code itself ignores it, so we ignore it too. The same lookups live in both `packages/server/src/server.ts` (sidebar badge) and `packages/shared/src/messageRenderer.js` (done-line) — keep them in sync.
- Default model is `claude-opus-4-7[1m]` (1M context Opus 4.7). The `[1m]` suffix is what triggers the 1M variant; the SDK's `betas: ['context-1m-2025-08-07']` header is **Sonnet 4/4.5 only** per the SdkBeta typedef, so do NOT add it for Opus. Override via `SPANNORA_MODEL` env var.
- `bypassPermissions` does **not** swallow tools that flag `requiresUserInteraction: true` — currently `AskUserQuestion` and `ExitPlanMode`. The SDK's permission resolver returns `behavior:"ask"` for those *before* the bypass shortcut, so they still flow into `canUseTool`. That's why `chat.ts`'s `canUseTool` branches on `toolName === "AskUserQuestion"` and pass-throughs everything else with `{behavior:"allow", updatedInput:input}`. Verified by reading `cli.js` (search `requiresUserInteraction` and `==="bypassPermissions"`).
- `AskUserQuestion` round-trip: model emits `tool_use` with `{questions:[...]}` → SDK invokes `canUseTool` → host resolves to `{behavior:"allow", updatedInput:{questions, answers}}`. The `tool_result` content the SDK emits afterwards is **a plain string, not JSON**: `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user's answers in mind.` — parse with `/"([^"]*)"="([^"]*)"/g`.
- `AskUserQuestion` "Other" is host-side: the schema docstring says *"There should be no 'Other' option, that will be provided automatically"*, so always render a free-text fallback regardless of `options`. We render it as one more radio/checkbox row that auto-checks when the user types.

## Auth model

Single user per spannora, in-app. `bcryptjs` (~12 rounds). The `sessions` table holds **two kinds** of session row, discriminated by `kind`:

- `kind='cookie'` — browser session. `HttpOnly; SameSite=Strict; Secure` when HTTPS. 30-day **sliding** window (`last_used_at` is touched on each request; idle GC sweeps rows past `SESSION_IDLE_MS`).
- `kind='token'` — long-lived bearer token (the row's UUID *is* the token). No expiry; only revoked manually from the account modal. Used by cross-origin clients — currently the hub PWA.

`readSession()` checks `Authorization: Bearer <id>` first, falls back to the cookie. Both kinds resolve through the same `getSession` lookup, so all downstream handlers are auth-kind-agnostic. The idle GC (`deleteSessionsOlderThan`) filters `WHERE kind='cookie'` so tokens never auto-expire.

Setup token (24 random bytes, base64url) printed in a banner on first boot. `SPANNORA_RESET=1` env wipes all users + sessions and regenerates the token.

`isPublicPath()` in `server.ts` defines what bypasses the auth gate: `/login*`, `/setup*`, `/favicon.ico`, `/api/auth/status|setup|login|token`, and the PWA-essentials (`/sw.js`, `/manifest.webmanifest`, `/icons/*`). Everything else is 401 (for `/api/*`) or 302 → `/login` (for HTML).

## CORS

`packages/server/src/cors.ts` runs at the top of the request handler, **before** the auth gate. Env-pinned allowlist:

```
SPANNORA_ALLOWED_ORIGINS=https://gididaf.github.io,http://localhost:5173
```

- **No default.** Unset → no CORS headers emitted → existing same-origin flows are byte-identical to pre-v0.5.0. The hub will fail to reach the install until the operator opts in.
- **Exact match.** No wildcards, no subdomain magic. Trailing slashes / casing / port / scheme all matter.
- **`localhost` ≠ `127.0.0.1`** — browsers treat them as different origins. Either pick one consistently or list both. Worth a banner in any setup docs you write.
- **Credentials disabled** (`Access-Control-Allow-Credentials: false`). Cookies are never sent cross-origin; hub clients authenticate exclusively with `Authorization: Bearer <token>`.
- Preflight `OPTIONS` is short-circuited to `204` *before* auth, so the browser doesn't see a 401 on its preflight. Without this, every cross-origin POST would fail before reaching auth.

If a cross-origin client gets a CORS error, the failure mode is always: response has no `Access-Control-Allow-Origin`. The diagnostic is `curl -i -X OPTIONS <url> -H 'Origin: <hub origin>'` — a 204 with headers means the server is set up correctly; anything else means `SPANNORA_ALLOWED_ORIGINS` doesn't include the hub origin (or isn't set on that process — env changes only take effect at process restart).

## Hub PWA

A static SPA at `https://gididaf.github.io/spannora/` (or any self-hosted copy). Anyone can use the public hub or self-host their own — the hub has no backend state.

**Per-instance config in IndexedDB** (`spannora-hub` DB, v1):

```
instances    keyPath="id"
  { id: uuid, base_url: string, label: string, color: string,
    order: number, token: string, created_at: number }
  index: by_order on "order"

settings     keyPath="key"
  { key: "active_instance_id", value: string | null }
```

`base_url` is normalized via `new URL(input).origin` (no trailing slash). Duplicate-origin re-adds overwrite the token in place.

**Registration flow** (`packages/hub/src/addInstance.js`): paste URL + creds → `POST <base_url>/api/auth/token` → store `{token, label, color}` in `instances`. Mixed-content check first (https hub + http spannora = inline error, no request sent).

**Switcher UX** (`packages/hub/src/sidebar.js`): permanent left rail with one chip per instance. Active chip has a left-edge accent. HTML5 DnD reorders chips and persists via `reorderInstances()`. Right-click/long-press opens instance settings (relabel, recolor, remove). Removing only forgets the instance locally — the bearer token on the server is **not** revoked. To kill the token, go to the server's same-origin account modal and revoke the matching session.

**Chat view** (`packages/hub/src/chatView.js`): identical to the in-server PWA because both consume `@spannora/shared`. The differences are the injected `askContext.submitAnswer` (uses the bearer-authed `SpannoraClient`) and the SSE source (uses `client.startChat`). On instance switch: abort the in-flight stream, swap the client, restore the hash-routed conversation.

**Hub gotchas:**

- **`scope` and `start_url`** in `manifest.webmanifest` are relative `./` so the same hub works both at `/spannora/` (Pages) and `/` (local dev).
- **SW cache name** is `spannora-hub-v*` — namespaced so the hub PWA and any per-server spannora PWA can coexist on the same device without cache collision.
- **Never intercept cross-origin requests** in the SW. The fetch handler bails on `url.origin !== self.location.origin` so SSE streaming + bearer auth always hit live.
- **Mobile drawer math**: the conv sidebar is `position: fixed; left: 56px; width: calc(80% - 56px)`. Closed transform is `translateX(calc(-100% - 56px))` — translating by just `-100%` or `-110%` leaves the drawer's right edge overlapping the rail (the `left: 56px` offset doesn't get subtracted by % translates).
- **`localhost` vs `127.0.0.1`** — see CORS section. The hub's `Origin` header is whatever the user typed in the address bar.

## PWA gotchas

- The service workers (`packages/server/public/sw.js` and `packages/hub/sw.js`) each have a `VERSION` constant — bump it on cache-strategy or precache-list changes so existing installs purge old caches via the activate handler. Cache name is namespaced per app (`spannora-v*` and `spannora-hub-v*`) so installed hub + installed per-server PWAs don't collide.
- **Never precache auth-gated paths** (`/app.js`, `/login.js`, etc.). If the SW installs before login, the precache fetch follows a 302 → /login and stores login HTML under the asset's cache key, breaking the next authed visit. v0.3.0 had this bug; v0.3.1 fixed it. The hub doesn't have this problem (everything it serves is static and public), but the same `isCacheable()` guard is still there.
- `isCacheable()` in both SWs rejects redirected responses, non-200s, and responses whose `resp.url !== req.url`.
- API paths (`/api/*`) are never intercepted by the SW — chat streaming, auth, and conversation state must always hit live.
- Safe-area insets: header and footer use `padding: max(<original>, env(safe-area-inset-*))` so Android nav buttons and the iOS notch don't cover UI. `viewport-fit=cover` must be in the viewport meta for these env vars to be non-zero.
- Android 3-button nav reports `env(safe-area-inset-bottom): 0` (only gesture-nav reports the home-indicator height), so the safe-area padding alone isn't enough — `100dvh` extends behind the opaque nav and hides the footer. Both apps' `syncAppHeight()` reads `visualViewport.height` (which excludes opaque system bars) into a `--app-height` CSS var; `body`, `.main-pane`, and any fullscreen modal use `var(--app-height, 100dvh)` instead of raw `100dvh`. Side benefit: keyboard-up shrinks the body so the input stays visible. Tested on Pixel 10 Pro XL.

## shtum + GitHub API

`gh` and any `curl` call to GitHub's API are intercepted by a `shtum` PreToolUse hook (it's a Rust tool the user wrote — see `~/Documents/Code/utilities/shtum/`). It blocks commands missing a `{GH_TOKEN}` placeholder. To run `gh` in this repo, wrap with `shtum run -- bash -c 'GH_TOKEN={GH_TOKEN} gh ...'`. The `bash -c` wrapping is required for multi-statement commands (single-statement commands work via the auto-rewrite, but anything with `&&` or pipes needs the explicit wrap).

curl `-w "%{http_code}"` etc. also trips shtum because `%{...}` looks like a placeholder. Either avoid the `-w` format, or wrap the whole command in `shtum run -- bash -c '...'`.

## Build / packaging quirks

- `packages/server/scripts/package.mjs` adds `--no-xattrs --no-mac-metadata --no-fflags` to `tar` on macOS so the tarball doesn't carry `LIBARCHIVE.xattr.com.apple.provenance` PAX headers that emit warnings on Linux extract.
- The tarball stages: `dist/`, `public/`, `deploy/`, `package.json`, `package-lock.json`. No source TS, no devDeps. `npm install --omit=dev` on the target adds runtime deps only.
- `fs.cpSync(packages/shared/src, packages/server/public/shared, { dereference: true })` is the staging step that turns the dev-time symlink into real files in the artifact. Same trick the Pages workflow uses with `cp -rL`.
- The workspace-shaped `package-lock.json` is shipped as-is; `npm install --omit=dev` (not `npm ci`) tolerates it by updating in place on the target.

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

**v0.5.0** adds the monorepo, `@spannora/shared`, token auth + CORS on the server, and the standalone hub PWA — all additive (existing installs are unaffected without `SPANNORA_ALLOWED_ORIGINS`).

**Out of scope per the original plan:** file upload/download, multi-user accounts, cross-host session adapters (the hub registers per-instance — it does not federate or proxy), built-in TLS, mobile-first UI polish (responsive is enough).

**Plausible follow-ups if asked:** push notifications (needs VAPID + a broadcaster), model switcher in the UI, conversation export, slash-command shortcuts, per-conversation cost (`total_cost_usd`) alongside the existing ctx%.
