import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChat, type ChatHandle } from "./chat.js";
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
  type AuthedRequest,
} from "./auth.js";

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
};

// One in-flight query per conversation. Keyed by conversation_id.
const activeQueries = new Map<string, ChatHandle>();

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

function writeSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

      if (activeQueries.has(conversation_id)) {
        sendJson(res, 409, { error: "conversation already has an active query" });
        return;
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

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": stream-open\n\n");

      const handle = startChat(
        {
          prompt,
          cwd: conv.cwd,
          resumeSessionId: conv.sdk_session_id ?? null,
        },
        {
          onMessage: (msg) => {
            // Persist every SDK message in order.
            try {
              insertMessage({
                conversation_id,
                role: "sdk",
                content_json: JSON.stringify(msg),
              });
            } catch (err) {
              console.error("[spannora] failed to persist SDK message:", err);
            }
            // Capture the latest session_id whenever the SDK reports one
            // (init system message + every result; can change on fork).
            const sid = extractSessionId(msg);
            if (sid && sid !== conv.sdk_session_id) {
              updateConversation(conversation_id, { sdk_session_id: sid });
              conv.sdk_session_id = sid;
            }
            writeSseEvent(res, "message", msg);
          },
          onError: (err) =>
            writeSseEvent(res, "error", {
              message: err instanceof Error ? err.message : String(err),
            }),
          onEnd: () => {
            activeQueries.delete(conversation_id);
            touchConversation(conversation_id);
            writeSseEvent(res, "end", {});
            res.end();
          },
        },
      );

      activeQueries.set(conversation_id, handle);

      const cancelOnClose = () => {
        handle.cancel();
        activeQueries.delete(conversation_id);
      };
      req.on("close", cancelOnClose);
      req.on("aborted", cancelOnClose);
    })
    .catch((err) => {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    });
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
  const active = activeQueries.get(id);
  if (active) {
    active.cancel();
    activeQueries.delete(id);
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
    current: s.id === auth.session.id,
  }));
  sendJson(res, 200, { items: sessions });
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

function isPublicPath(method: string | undefined, p: string): boolean {
  if (method === "GET" && (p === "/login" || p === "/setup")) return true;
  if (method === "GET" && (p === "/login.html" || p === "/setup.html")) return true;
  if (method === "GET" && (p === "/login.js" || p === "/setup.js")) return true;
  if (method === "GET" && p === "/favicon.ico") return true;
  if (method === "GET" && p === "/api/auth/status") return true;
  if (method === "POST" && p === "/api/auth/setup") return true;
  if (method === "POST" && p === "/api/auth/login") return true;
  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // --- Public routes ---
  if (req.method === "GET" && url.pathname === "/api/auth/status") return handleAuthStatus(res);
  if (req.method === "POST" && url.pathname === "/api/auth/setup") return handleAuthSetup(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/login") return handleAuthLogin(req, res);

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
  console.log(`spannora listening on http://${HOST}:${PORT}`);
});
