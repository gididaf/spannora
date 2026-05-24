import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChat, type ChatHandle, type AskUserAnswer } from "./chat.js";
import { listDir, mkdirIn, validateCwd } from "./fs.js";
import {
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  touchConversation,
  deleteConversation,
  insertMessage,
  getMessages,
  listSessionsForUser,
  deleteSession,
  getSession,
} from "./db.js";
import {
  initAuth,
  isSetupNeeded,
  consumeSetupToken,
  createUserAccount,
  authenticate,
  startSession,
  endSession,
  readSession,
  issueToken,
  type AuthedRequest,
} from "./auth.js";
import { applyCors } from "./cors.js";
import { log } from "./log.js";
import { startRetention } from "./retention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const HOST = process.env.SPANNORA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SPANNORA_PORT ?? 7878);

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
};

type PendingResolver = (answer: AskUserAnswer) => void;

interface BufferedEvent {
  /** Monotonic SQLite rowid from the persisted message row. */
  seq: number;
  /** SSE event name: "message" or "error". `end` is not buffered (terminal). */
  event: "message" | "error";
  /** JSON-serializable payload. */
  data: unknown;
}

interface Subscriber {
  res: http.ServerResponse;
  /** Last seq written to this subscriber's response stream. */
  lastSeq: number;
  /** Set to true when this subscriber's underlying socket closed. */
  closed: boolean;
}

/**
 * Per-conversation broker. Holds the SDK query handle, the pending
 * AskUserQuestion resolvers, an in-memory replay buffer of every SSE
 * event emitted during the turn, and a Set of currently-attached
 * subscribers. The broker outlives any one HTTP request — when a mobile
 * client backgrounds and drops its SSE connection, the broker keeps the
 * SDK query alive and persists messages to DB; the client reconnects via
 * GET /api/chat/:id/stream?since=N and the broker replays from the buffer.
 *
 * Lifecycle: created on POST /api/chat (first subscriber attaches as part
 * of the same request). Removed from `activeQueries` synchronously when
 * the SDK ends or is explicitly cancelled — there's a small grace window
 * (5s) between SDK end and broker removal so a reattacher that just missed
 * the last frame can still replay it.
 */
interface Broker {
  handle: ChatHandle;
  pending: Map<string, PendingResolver>;
  buffer: BufferedEvent[];
  subscribers: Set<Subscriber>;
  /** True once onEnd fired. After this, no new buffered events arrive. */
  ended: boolean;
  /** Cleared in cleanupBroker(); kept here so we can stop the heartbeat. */
  heartbeat: NodeJS.Timeout;
}

// One in-flight query per conversation. Keyed by conversation_id.
const activeQueries = new Map<string, Broker>();

/**
 * SSE keepalive frame. Sent every 15s on every subscriber so:
 *  - mobile-network NATs don't reap the TCP connection
 *  - reverse proxies (nginx, Caddy) keep the stream open
 *  - the client can detect a silently-dead stream (no data in >30s)
 */
const HEARTBEAT_MS = 15_000;
/** Time between SDK end and broker removal, so late reattachers still replay. */
const POST_END_GRACE_MS = 5_000;

function drainPending(broker: Broker, message: string): void {
  for (const resolve of broker.pending.values()) {
    resolve({ denied: true, message });
  }
  broker.pending.clear();
}

function writeSseRaw(res: http.ServerResponse, frame: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(frame);
    return true;
  } catch {
    return false;
  }
}

function emitToSubscriber(sub: Subscriber, ev: BufferedEvent): void {
  if (sub.closed) return;
  const ok = writeSseRaw(
    sub.res,
    `id: ${ev.seq}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`,
  );
  if (!ok) {
    sub.closed = true;
    return;
  }
  sub.lastSeq = ev.seq;
}

function publishToBroker(broker: Broker, ev: BufferedEvent): void {
  broker.buffer.push(ev);
  for (const sub of broker.subscribers) emitToSubscriber(sub, ev);
}

function attachSubscriber(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  broker: Broker,
  since: number,
): Subscriber {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": stream-open\n\n");

  const sub: Subscriber = { res, lastSeq: since, closed: false };
  let replayed = 0;
  // Replay anything the broker has already emitted past the client's cursor.
  for (const ev of broker.buffer) {
    if (ev.seq > since) { emitToSubscriber(sub, ev); replayed++; }
  }
  log.info("sse subscriber attached", {
    since,
    replayed,
    buffered: broker.buffer.length,
    subscribers_after: broker.subscribers.size + 1,
    ended: broker.ended,
  });
  if (broker.ended) {
    // Caught up to the end and the turn already finished — close out.
    writeSseRaw(res, `event: end\ndata: {}\n\n`);
    res.end();
    sub.closed = true;
    return sub;
  }
  broker.subscribers.add(sub);
  const onClose = () => {
    if (sub.closed) return;
    sub.closed = true;
    broker.subscribers.delete(sub);
    log.info("sse subscriber dropped", {
      last_seq: sub.lastSeq,
      subscribers_after: broker.subscribers.size,
      ended: broker.ended,
    });
  };
  req.on("close", onClose);
  req.on("aborted", onClose);
  return sub;
}

function cleanupBroker(conversationId: string, broker: Broker): void {
  clearInterval(broker.heartbeat);
  // Close any still-attached subscribers.
  for (const sub of broker.subscribers) {
    if (!sub.closed) {
      writeSseRaw(sub.res, `event: end\ndata: {}\n\n`);
      try { sub.res.end(); } catch { /* socket already gone */ }
      sub.closed = true;
    }
  }
  broker.subscribers.clear();
  if (activeQueries.get(conversationId) === broker) {
    activeQueries.delete(conversationId);
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = path.normalize(relPath).replace(/^(\.\.[\\/])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store, must-revalidate",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function deriveTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= 60) return flat || "New chat";
  return flat.slice(0, 57).trimEnd() + "…";
}

function extractSessionId(msg: unknown): string | null {
  if (msg && typeof msg === "object") {
    const sid = (msg as { session_id?: unknown }).session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

interface UsageExtract {
  tokens: number;
  window: number;
}

/**
 * Pull context-used numbers out of an SDK result message, matching Claude
 * Code's own status-line math (see sdk's bundled cli.js — functions Qo/OI for
 * the numerator, _DA/bd for the denominator).
 *
 * Numerator: input + cache_read + cache_creation + output, from the latest
 * assistant turn's `usage`.
 *
 * Denominator: contextWindow(model) - maxOutputTokens(model). Both derived
 * from the model id string; the SDK exposes `modelUsage[m].contextWindow`
 * but Claude Code itself doesn't read it, so we don't either.
 *
 * `last_context_window` therefore stores the *usable* window (raw window
 * minus the output reservation), so `tokens / window` is true "% used of
 * usable context."
 */
function extractUsage(msg: unknown): UsageExtract | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "result") return null;
  const usage = m.usage as
    | {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens?: number;
      }
    | undefined;
  if (!usage) return null;
  const tokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  if (tokens <= 0) return null;

  const modelUsage = m.modelUsage as Record<string, unknown> | undefined;
  const model = modelUsage ? Object.keys(modelUsage)[0] ?? "" : "";
  const window = contextWindowFor(model) - maxOutputFor(model);
  if (window <= 0) return null;
  return { tokens, window };
}

function contextWindowFor(model: string): number {
  return model.includes("[1m]") ? 1_000_000 : 200_000;
}

function maxOutputFor(model: string): number {
  if (model.includes("opus-4-5")) return 64_000;
  if (model.includes("opus-4")) return 32_000;
  if (model.includes("sonnet-4") || model.includes("haiku-4")) return 64_000;
  if (model.includes("3-5")) return 8_192;
  if (model.includes("claude-3-opus")) return 4_096;
  if (model.includes("claude-3-sonnet")) return 8_192;
  if (model.includes("claude-3-haiku")) return 4_096;
  return 32_000;
}

// --- /api/chat ---

function handleChat(req: http.IncomingMessage, res: http.ServerResponse): void {
  readJsonBody(req)
    .then(async (body) => {
      const { conversation_id, prompt } = (body ?? {}) as {
        conversation_id?: string;
        prompt?: string;
      };

      if (typeof prompt !== "string" || !prompt.trim()) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }
      if (typeof conversation_id !== "string" || !conversation_id.trim()) {
        sendJson(res, 400, { error: "conversation_id is required" });
        return;
      }

      const conv = getConversation(conversation_id);
      if (!conv) {
        sendJson(res, 404, { error: "conversation not found" });
        return;
      }

      const existing = activeQueries.get(conversation_id);
      if (existing && !existing.ended) {
        sendJson(res, 409, { error: "conversation already has an active query" });
        return;
      }
      if (existing) {
        // The previous broker finished but is still in its post-end grace
        // window (held for late reattachers). The user wants to send a
        // new turn now, so collapse the grace window immediately.
        cleanupBroker(conversation_id, existing);
      }

      // Persist the user's prompt before launching the query so a crash
      // mid-stream still leaves the prompt in history.
      insertMessage({
        conversation_id,
        role: "prompt",
        content_json: JSON.stringify({ text: prompt }),
      });

      // Auto-title from the first prompt if the conversation still has the
      // placeholder title.
      if (conv.title === "New chat") {
        updateConversation(conversation_id, { title: deriveTitle(prompt) });
      }
      touchConversation(conversation_id);

      const pending = new Map<string, PendingResolver>();
      const broker: Broker = {
        // Filled in below; declared first so onMessage can reference it.
        handle: undefined as unknown as ChatHandle,
        pending,
        buffer: [],
        subscribers: new Set(),
        ended: false,
        heartbeat: setInterval(() => {
          for (const sub of broker.subscribers) {
            if (!writeSseRaw(sub.res, ": hb\n\n")) {
              sub.closed = true;
              broker.subscribers.delete(sub);
            }
          }
        }, HEARTBEAT_MS),
      };

      broker.handle = startChat(
        {
          prompt,
          cwd: conv.cwd,
          resumeSessionId: conv.sdk_session_id ?? null,
          requestUserAnswer: (toolUseId, _input) =>
            new Promise<AskUserAnswer>((resolve) => {
              pending.set(toolUseId, (answer) => {
                pending.delete(toolUseId);
                resolve(answer);
              });
            }),
        },
        {
          onMessage: (msg) => {
            // Persist every SDK message in order. The DB-assigned rowid is
            // the seq used as the SSE id, so reattachers can replay by seq.
            let seq = 0;
            try {
              const row = insertMessage({
                conversation_id,
                role: "sdk",
                content_json: JSON.stringify(msg),
              });
              seq = row.seq;
            } catch (err) {
              log.error("failed to persist SDK message", { conversation_id, err });
            }
            // Capture the latest session_id whenever the SDK reports one
            // (init system message + every result; can change on fork).
            const sid = extractSessionId(msg);
            if (sid && sid !== conv.sdk_session_id) {
              updateConversation(conversation_id, { sdk_session_id: sid });
              conv.sdk_session_id = sid;
            }
            // Result messages also carry input-context usage — persist it so
            // the sidebar can show "X% ctx" without recomputing.
            const usage = extractUsage(msg);
            if (usage) {
              updateConversation(conversation_id, {
                last_context_tokens: usage.tokens,
                last_context_window: usage.window,
              });
              conv.last_context_tokens = usage.tokens;
              conv.last_context_window = usage.window;
            }
            publishToBroker(broker, { seq, event: "message", data: msg });
          },
          onError: (err) => {
            // Error events get the next seq slot so they're ordered properly
            // in the replay buffer. They're NOT persisted to DB.
            const seq = (broker.buffer.at(-1)?.seq ?? 0) + 1;
            publishToBroker(broker, {
              seq,
              event: "error",
              data: { message: err instanceof Error ? err.message : String(err) },
            });
          },
          onEnd: () => {
            broker.ended = true;
            drainPending(broker, "Stream ended.");
            touchConversation(conversation_id);
            // Fan a terminal `end` event to every currently-attached
            // subscriber so they stop reading.
            for (const sub of broker.subscribers) {
              if (sub.closed) continue;
              writeSseRaw(sub.res, `event: end\ndata: {}\n\n`);
              try { sub.res.end(); } catch { /* socket gone */ }
              sub.closed = true;
            }
            broker.subscribers.clear();
            // Hold the buffer briefly so a reconnecting client whose
            // last fetch died milliseconds before the end can still see
            // the final state via the reattach endpoint.
            setTimeout(() => cleanupBroker(conversation_id, broker), POST_END_GRACE_MS);
          },
        },
      );

      activeQueries.set(conversation_id, broker);

      // Attach this request's response as the first subscriber, starting
      // from seq=0 (the buffer is still empty so no replay). When this
      // socket closes (e.g. mobile background → TCP drop), we ONLY
      // unsubscribe — the SDK query keeps running.
      attachSubscriber(req, res, broker, 0);
    })
    .catch((err) => {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    });
}

// Cancel the in-flight query for a conversation. Returns 200 if a query
// was actively cancelled, 204 if there was nothing in flight. Either way,
// the client can stop waiting. The SDK's onEnd handler does the broker
// teardown so we don't double-clean here.
function handleStopChat(res: http.ServerResponse, conversationId: string): void {
  const broker = activeQueries.get(conversationId);
  if (!broker) {
    sendJson(res, 204, { ok: true, was_active: false });
    return;
  }
  drainPending(broker, "User stopped the turn.");
  broker.handle.cancel();
  log.info("chat stopped via DELETE", { conversation_id: conversationId });
  sendJson(res, 200, { ok: true, was_active: true });
}

/**
 * Reattach to an in-flight (or just-finished) turn. The client passes
 * `?since=<seq>` — the highest seq it has already rendered. The broker
 * replays any buffered messages past that cursor, then keeps the SSE
 * stream open for live messages until the turn ends.
 *
 * If no broker exists for the conversation (turn finished long ago or
 * never started), we write a single `end` event and close. That lets
 * the client treat "reattach" as idempotent — it always gets either
 * live frames, replay, or an immediate end.
 */
function handleStreamReattach(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  conversationId: string,
  since: number,
): void {
  const conv = getConversation(conversationId);
  if (!conv) {
    sendJson(res, 404, { error: "conversation not found" });
    return;
  }
  const broker = activeQueries.get(conversationId);
  if (!broker) {
    // No in-flight turn — write a synthetic open + end so the client's
    // stream reader closes cleanly without throwing.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": stream-open\n\n");
    res.write(`event: end\ndata: {}\n\n`);
    res.end();
    return;
  }
  attachSubscriber(req, res, broker, since);
}

// Resolve an AskUserQuestion that the SDK is currently paused on. Body:
// { tool_use_id: string, answers: Record<string,string> }. 204 on success,
// 404 if no matching pending resolver exists (covers reload / double-submit).
function handleAnswerChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  conversationId: string,
): void {
  readJsonBody(req)
    .then((body) => {
      const { tool_use_id, answers } = (body ?? {}) as {
        tool_use_id?: string;
        answers?: Record<string, string>;
      };
      if (typeof tool_use_id !== "string" || !tool_use_id) {
        sendJson(res, 400, { error: "tool_use_id is required" });
        return;
      }
      if (!answers || typeof answers !== "object") {
        sendJson(res, 400, { error: "answers object is required" });
        return;
      }
      const broker = activeQueries.get(conversationId);
      const resolver = broker?.pending.get(tool_use_id);
      if (!broker || !resolver) {
        sendJson(res, 404, { error: "no pending question for that tool_use_id" });
        return;
      }
      resolver({ answers });
      sendJson(res, 200, { ok: true });
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

// --- /api/conversations ---

function handleListConversations(res: http.ServerResponse): void {
  try {
    const items = listConversations();
    sendJson(res, 200, { items });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function handleCreateConversation(req: http.IncomingMessage, res: http.ServerResponse): void {
  readJsonBody(req)
    .then(async (body) => {
      const { cwd, title } = (body ?? {}) as { cwd?: string; title?: string };
      if (typeof cwd !== "string" || !cwd.trim()) {
        sendJson(res, 400, { error: "cwd is required" });
        return;
      }
      const absCwd = await validateCwd(cwd);
      const conv = createConversation({
        cwd: absCwd,
        title: (title && title.trim()) || "New chat",
      });
      sendJson(res, 200, conv);
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

function handleGetConversation(res: http.ServerResponse, id: string): void {
  const conv = getConversation(id);
  if (!conv) {
    sendJson(res, 404, { error: "conversation not found" });
    return;
  }
  const messages = getMessages(id);
  sendJson(res, 200, { conversation: conv, messages });
}

function handlePatchConversation(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  readJsonBody(req)
    .then((body) => {
      const { title } = (body ?? {}) as { title?: string };
      if (typeof title !== "string" || !title.trim()) {
        sendJson(res, 400, { error: "title is required" });
        return;
      }
      const conv = getConversation(id);
      if (!conv) {
        sendJson(res, 404, { error: "conversation not found" });
        return;
      }
      updateConversation(id, { title: title.trim() });
      sendJson(res, 200, getConversation(id));
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

function handleDeleteConversation(res: http.ServerResponse, id: string): void {
  const conv = getConversation(id);
  if (!conv) {
    sendJson(res, 404, { error: "conversation not found" });
    return;
  }
  // Cancel any in-flight query for this conversation before deleting.
  // SDK onEnd → broker cleanup will fire shortly; we don't drop the
  // broker from activeQueries here so subscribers get the `end` event.
  const broker = activeQueries.get(id);
  if (broker) {
    drainPending(broker, "Conversation deleted.");
    broker.handle.cancel();
  }
  deleteConversation(id);
  sendJson(res, 200, { ok: true });
}

// --- /api/fs ---

function handleFsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const p = url.searchParams.get("path");
  listDir(p)
    .then((result) => sendJson(res, 200, result))
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

function handleFsMkdir(req: http.IncomingMessage, res: http.ServerResponse): void {
  readJsonBody(req)
    .then(async (body) => {
      const { parent, name } = (body ?? {}) as { parent?: string; name?: string };
      if (typeof parent !== "string" || typeof name !== "string") {
        sendJson(res, 400, { error: "parent and name are required" });
        return;
      }
      const result = await mkdirIn(parent, name);
      sendJson(res, 200, result);
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

// --- /api/auth ---

function handleAuthStatus(res: http.ServerResponse): void {
  sendJson(res, 200, { setup_needed: isSetupNeeded() });
}

function handleAuthSetup(req: http.IncomingMessage, res: http.ServerResponse): void {
  readJsonBody(req)
    .then(async (body) => {
      const { token, username, password } = (body ?? {}) as {
        token?: string;
        username?: string;
        password?: string;
      };
      if (!isSetupNeeded()) {
        sendJson(res, 400, { error: "setup already completed" });
        return;
      }
      if (typeof token !== "string" || !token) {
        sendJson(res, 400, { error: "token is required" });
        return;
      }
      if (typeof username !== "string" || typeof password !== "string") {
        sendJson(res, 400, { error: "username and password are required" });
        return;
      }
      if (!consumeSetupToken(token)) {
        sendJson(res, 401, { error: "invalid setup token" });
        return;
      }
      try {
        const user = await createUserAccount(username, password);
        const session = startSession(req, res, user);
        sendJson(res, 200, { username: user.username, session_id: session.id });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

function handleAuthLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
  readJsonBody(req)
    .then(async (body) => {
      const { username, password } = (body ?? {}) as { username?: string; password?: string };
      if (typeof username !== "string" || typeof password !== "string") {
        sendJson(res, 400, { error: "username and password are required" });
        return;
      }
      const user = await authenticate(username, password);
      if (!user) {
        sendJson(res, 401, { error: "invalid credentials" });
        return;
      }
      const session = startSession(req, res, user);
      sendJson(res, 200, { username: user.username, session_id: session.id });
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

function handleAuthLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
  endSession(req, res);
  sendJson(res, 200, { ok: true });
}

function handleAuthMe(res: http.ServerResponse, auth: AuthedRequest): void {
  sendJson(res, 200, {
    username: auth.user.username,
    current_session_id: auth.session.id,
  });
}

function handleListSessions(res: http.ServerResponse, auth: AuthedRequest): void {
  const sessions = listSessionsForUser(auth.user.id).map((s) => ({
    id: s.id,
    created_at: s.created_at,
    last_used_at: s.last_used_at,
    user_agent: s.user_agent,
    kind: s.kind,
    label: s.label,
    current: s.id === auth.session.id,
  }));
  sendJson(res, 200, { items: sessions });
}

/**
 * Mint a long-lived API token for cross-origin clients (e.g. the hub PWA).
 * Public — gated on username+password just like /api/auth/login. The
 * token is the session id itself (UUIDv4), stored with kind='token'.
 * Body: { username, password, label? }
 * Response: { token, kind:"token", label, created_at }
 */
function handleAuthToken(req: http.IncomingMessage, res: http.ServerResponse): void {
  readJsonBody(req)
    .then(async (body) => {
      const { username, password, label } = (body ?? {}) as {
        username?: string;
        password?: string;
        label?: string;
      };
      if (typeof username !== "string" || typeof password !== "string") {
        sendJson(res, 400, { error: "username and password are required" });
        return;
      }
      const user = await authenticate(username, password);
      if (!user) {
        sendJson(res, 401, { error: "invalid credentials" });
        return;
      }
      const ua = (req.headers["user-agent"] as string | undefined) ?? null;
      const session = issueToken(user, {
        label: typeof label === "string" ? label : null,
        user_agent: ua,
      });
      sendJson(res, 200, {
        token: session.id,
        kind: session.kind,
        label: session.label,
        created_at: session.created_at,
      });
    })
    .catch((err) => sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) }));
}

function handleRevokeSession(res: http.ServerResponse, auth: AuthedRequest, sessionId: string): void {
  const target = getSession(sessionId);
  if (!target) {
    sendJson(res, 404, { error: "session not found" });
    return;
  }
  if (target.user_id !== auth.user.id) {
    sendJson(res, 403, { error: "not your session" });
    return;
  }
  deleteSession(sessionId);
  sendJson(res, 200, { ok: true });
}

// --- Router ---

const CONV_PATH_RE = /^\/api\/conversations(?:\/([^/]+))?$/;
const SESSION_REVOKE_RE = /^\/api\/auth\/sessions\/([^/]+)$/;
const CHAT_STOP_RE = /^\/api\/chat\/([^/]+)\/current$/;
const CHAT_ANSWER_RE = /^\/api\/chat\/([^/]+)\/answer$/;
const CHAT_STREAM_RE = /^\/api\/chat\/([^/]+)\/stream$/;

function isPublicPath(method: string | undefined, p: string): boolean {
  if (method === "GET" && (p === "/login" || p === "/setup")) return true;
  if (method === "GET" && (p === "/login.html" || p === "/setup.html")) return true;
  if (method === "GET" && (p === "/login.js" || p === "/setup.js")) return true;
  if (method === "GET" && p === "/favicon.ico") return true;
  if (method === "GET" && p === "/api/auth/status") return true;
  if (method === "POST" && p === "/api/auth/setup") return true;
  if (method === "POST" && p === "/api/auth/login") return true;
  // Cross-origin clients (hub PWA) exchange creds for a bearer token via
  // this endpoint. Same gating as /api/auth/login — password-checked.
  if (method === "POST" && p === "/api/auth/token") return true;
  // PWA assets — the browser fetches these even on /login (before auth), and
  // the service worker registers from any page. Keep them public so install
  // works regardless of session state.
  if (method === "GET" && p === "/sw.js") return true;
  if (method === "GET" && p === "/manifest.webmanifest") return true;
  if (method === "GET" && p.startsWith("/icons/")) return true;
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // --- CORS ---
  // No-op when SPANNORA_ALLOWED_ORIGINS is unset or the request Origin
  // isn't on the allowlist. Otherwise sets response headers (so SSE +
  // /api/* responses are readable cross-origin) and short-circuits
  // preflight OPTIONS with a 204 — before the auth gate, so the
  // browser doesn't see a redirect on its preflight.
  if (applyCors(req, res).handled) return;

  // --- Public routes ---
  if (req.method === "GET" && url.pathname === "/api/auth/status") return handleAuthStatus(res);
  if (req.method === "POST" && url.pathname === "/api/auth/setup") return handleAuthSetup(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/login") return handleAuthLogin(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/token") return handleAuthToken(req, res);

  if (isPublicPath(req.method, url.pathname)) {
    if (req.method === "GET") {
      const rewritten = url.pathname === "/login" ? "/login.html"
        : url.pathname === "/setup" ? "/setup.html"
        : url.pathname;
      return serveStatic(req, res, rewritten);
    }
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  // --- Authentication gate ---
  const auth = readSession(req);
  if (!auth) {
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const target = isSetupNeeded() ? "/setup" : "/login";
    res.writeHead(302, { Location: target });
    res.end();
    return;
  }

  // --- Authenticated routes ---
  if (req.method === "GET" && url.pathname === "/api/auth/me") return handleAuthMe(res, auth);
  if (req.method === "POST" && url.pathname === "/api/auth/logout") return handleAuthLogout(req, res);
  if (req.method === "GET" && url.pathname === "/api/auth/sessions") return handleListSessions(res, auth);

  const sm = SESSION_REVOKE_RE.exec(url.pathname);
  if (sm && req.method === "DELETE") return handleRevokeSession(res, auth, sm[1]);

  if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
  const stopMatch = CHAT_STOP_RE.exec(url.pathname);
  if (stopMatch && req.method === "DELETE") return handleStopChat(res, stopMatch[1]);
  const answerMatch = CHAT_ANSWER_RE.exec(url.pathname);
  if (answerMatch && req.method === "POST") return handleAnswerChat(req, res, answerMatch[1]);
  const streamMatch = CHAT_STREAM_RE.exec(url.pathname);
  if (streamMatch && req.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    log.info("stream reattach request", { conversation_id: streamMatch[1], since });
    return handleStreamReattach(req, res, streamMatch[1], since);
  }
  if (req.method === "GET" && url.pathname === "/api/fs/list") return handleFsList(req, res, url);
  if (req.method === "POST" && url.pathname === "/api/fs/mkdir") return handleFsMkdir(req, res);

  const cm = CONV_PATH_RE.exec(url.pathname);
  if (cm) {
    const id = cm[1];
    if (!id) {
      if (req.method === "GET") return handleListConversations(res);
      if (req.method === "POST") return handleCreateConversation(req, res);
    } else {
      if (req.method === "GET") return handleGetConversation(res, id);
      if (req.method === "PATCH") return handlePatchConversation(req, res, id);
      if (req.method === "DELETE") return handleDeleteConversation(res, id);
    }
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  if (req.method === "GET") return serveStatic(req, res, url.pathname);

  res.writeHead(405).end("Method Not Allowed");
});

initAuth();

server.listen(PORT, HOST, () => {
  // `0.0.0.0` and `::` mean "all interfaces" — show localhost in the
  // banner since that's the URL a dev hitting `npm run dev` would open.
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  const url = `http://${displayHost}:${PORT}`;
  log.info("server listening", { host: HOST, port: PORT, url });
  process.stderr.write(`\n  spannora → ${url}\n\n`);
});

startRetention();
