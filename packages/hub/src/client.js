// Bearer-authenticated client for a single spannora instance. The hub
// holds one of these per active instance; switching instances builds a
// new client. Every request prepends the instance's base_url and sets
// `Authorization: Bearer <token>`.
//
// Cookies are NOT sent (mode:"cors", default credentials:"omit") — the
// spannora server's CORS layer refuses to set Allow-Credentials: true,
// so any cookie attempt would be a no-op anyway.

export class InstanceUnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "InstanceUnauthorizedError";
  }
}

export class InstanceNetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "InstanceNetworkError";
  }
}

export class SpannoraClient {
  constructor(instance) {
    this.instance = instance;
  }

  url(path) {
    return this.instance.base_url + path;
  }

  authHeader() {
    return { Authorization: `Bearer ${this.instance.token}` };
  }

  async _fetch(path, init = {}) {
    const headers = { ...(init.headers || {}), ...this.authHeader() };
    let res;
    try {
      res = await fetch(this.url(path), { ...init, headers, mode: "cors" });
    } catch (err) {
      throw new InstanceNetworkError(err.message || "network error");
    }
    if (res.status === 401) throw new InstanceUnauthorizedError();
    return res;
  }

  async _json(path, init) {
    const res = await this._fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // --- Auth sanity check (used at instance-switch to detect a revoked token) ---
  me() {
    return this._json("/api/auth/me");
  }

  // --- Conversations ---
  listConversations() {
    return this._json("/api/conversations");
  }
  getConversation(id) {
    return this._json(`/api/conversations/${encodeURIComponent(id)}`);
  }
  createConversation(body) {
    return this._json("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  patchConversation(id, body) {
    return this._json(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  deleteConversation(id) {
    return this._json(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // --- Chat streaming ---
  // Returns the raw Response so the caller can pass response.body to
  // streamSse() from @spannora/shared. Caller owns the AbortController.
  async startChat(body, signal) {
    return this._fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }
  // Reattach to an in-flight (or just-finished) turn. The server replays
  // any messages with seq > since from its in-memory broker buffer, then
  // keeps the SSE stream open for live frames until the turn ends. If no
  // broker exists for the conversation, the server still returns a 200
  // SSE response that immediately writes an `event: end` and closes — so
  // the caller can treat reattach as idempotent.
  async streamReattach(conversationId, since, signal) {
    return this._fetch(
      `/api/chat/${encodeURIComponent(conversationId)}/stream?since=${since | 0}`,
      { method: "GET", signal },
    );
  }
  stopChat(conversationId) {
    return this._fetch(`/api/chat/${encodeURIComponent(conversationId)}/current`, { method: "DELETE" });
  }
  answer(conversationId, toolUseId, answers) {
    return this._json(`/api/chat/${encodeURIComponent(conversationId)}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_use_id: toolUseId, answers }),
    });
  }

  // --- Filesystem (cwd picker) ---
  fsList(path) {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    return this._json(`/api/fs/list${qs}`);
  }
  fsMkdir(body) {
    return this._json("/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
