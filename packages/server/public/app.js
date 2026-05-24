// spannora — in-server PWA. Same-origin only; uses cookie sessions and
// apiFetch (401 → /login). Chat rendering + SSE + tool cards now live in
// @spannora/shared, served at /shared/*.js by the dev server (symlink)
// and at /opt/spannora/public/shared/*.js on deployed installs (bundled
// by scripts/package.mjs at packaging time).

import {
  streamSse,
  renderSdkMessage,
  escapeHtml,
  makeTextBubble,
} from "/shared/index.js";

// Android Chrome PWA standalone + viewport-fit=cover renders the WebView
// under the 3-button nav, and reports `env(safe-area-inset-bottom)` as 0
// (the inset is only non-zero for gesture-nav). `100dvh` therefore extends
// behind the nav, hiding our footer. visualViewport.height excludes opaque
// system bars, so use that for the real usable height; iOS standalone
// matches the layout viewport, so this is a no-op there.
function syncAppHeight() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
}
syncAppHeight();
window.visualViewport?.addEventListener("resize", syncAppHeight);
window.addEventListener("orientationchange", syncAppHeight);

// === DOM refs ===
const transcript = document.getElementById("transcript");
const promptInput = document.getElementById("prompt");
const sendBtn = document.getElementById("send");

const cwdBtn = document.getElementById("cwd-btn");
const cwdDisplay = document.getElementById("cwd-display");

const sidebarList = document.getElementById("sidebar-list");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarClose = document.getElementById("sidebar-close");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const newChatBtn = document.getElementById("new-chat-btn");

const accountBtn = document.getElementById("account-btn");
const accountModal = document.getElementById("account-modal");
const accountClose = document.getElementById("account-close");
const accountLogout = document.getElementById("account-logout");
const accountSessionsEl = document.getElementById("account-sessions");
const accountUsernameEl = document.getElementById("account-username");

// Wrap fetch so any 401 (e.g. session revoked from another browser) sends the
// user to /login instead of silently breaking the UI.
async function apiFetch(url, options) {
  const res = await window.fetch(url, options);
  if (res.status === 401) {
    location.replace("/login");
    throw new Error("unauthorized");
  }
  return res;
}

// === State ===
const state = {
  conversations: [],
  current: null,        // {id, title, cwd, sdk_session_id, ...}
  pendingCwd: null,     // chosen but no conversation yet
  sending: false,
};

// Last-picked working directory persists across refreshes so "+ New chat"
// and a refresh-during-new-chat both retain the user's selection.
const LAST_CWD_KEY = "spannora.lastCwd";
function getLastCwd() { return localStorage.getItem(LAST_CWD_KEY) || null; }
function saveLastCwd(p) { try { localStorage.setItem(LAST_CWD_KEY, p); } catch {} }

let currentController = null;
// Highest SSE seq seen in the current turn — used as the `since` cursor
// on reconnect after a mobile background drops the SSE stream. See
// handleStreamReattach in src/server.ts and the loop in send() below.
let lastSeq = 0;
// True iff the current controller was aborted to force a reconnect (vs.
// a real user cancel). Lets the send-loop distinguish silently-reattach
// from propagate-AbortError.
let reconnectRequested = false;
const toolCards = new Map();
// tool_use_ids of AskUserQuestion cards whose form is still open
// (not yet answered, denied, or aborted). While non-empty, the main
// prompt textarea is locked so the user can only interact with the form.
const openAsks = new Set();

// Context passed to @spannora/shared modules. Bound to this page's
// transcript element, this page's toolCards Map, and a same-origin
// askContext that uses apiFetch + the active conversation id.
const renderCtx = {
  transcript,
  toolCards,
  askContext: {
    async submitAnswer(toolUseId, answers) {
      const convId = state.current?.id;
      if (!convId) throw new Error("No active conversation.");
      const res = await apiFetch(
        `/api/chat/${encodeURIComponent(convId)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool_use_id: toolUseId, answers }),
        },
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
    },
    onOpen(toolUseId) {
      openAsks.add(toolUseId);
      applyPromptState();
    },
    onClosed(toolUseId) {
      if (openAsks.delete(toolUseId)) applyPromptState();
    },
  },
};

// === Picker modal refs ===
const pickerEl = document.getElementById("picker");
const pickerListEl = document.getElementById("picker-list");
const pickerPathInput = document.getElementById("picker-path-input");
const pickerUp = document.getElementById("picker-up");
const pickerCloseBtn = document.getElementById("picker-close");
const pickerCancel = document.getElementById("picker-cancel");
const pickerSelect = document.getElementById("picker-select");
const pickerMkdirToggle = document.getElementById("picker-mkdir-toggle");
const pickerMkdirRow = document.getElementById("picker-mkdir-row");
const pickerMkdirName = document.getElementById("picker-mkdir-name");
const pickerMkdirConfirm = document.getElementById("picker-mkdir-confirm");
const pickerMkdirCancel = document.getElementById("picker-mkdir-cancel");
let pickerCurrentPath = null;

// === Init ===
init();

async function init() {
  bindEvents();
  state.pendingCwd = getLastCwd();
  renderCwd();
  await refreshSidebar();
  hydrateFromHash();
  window.addEventListener("hashchange", hydrateFromHash);
}

function bindEvents() {
  cwdBtn.addEventListener("click", () => {
    if (state.current) return; // locked
    openPicker();
  });
  pickerCloseBtn.addEventListener("click", closePicker);
  pickerCancel.addEventListener("click", closePicker);
  pickerEl.addEventListener("click", (e) => {
    if (e.target === pickerEl) closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pickerEl.classList.contains("hidden")) closePicker();
  });
  pickerUp.addEventListener("click", async () => {
    if (!pickerCurrentPath) return;
    try {
      const data = await fetchList(pickerCurrentPath);
      if (data.parent) renderPickerList(data.parent);
    } catch {}
  });
  pickerPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      renderPickerList(pickerPathInput.value);
    }
  });
  pickerSelect.addEventListener("click", () => {
    if (!pickerCurrentPath) return;
    state.pendingCwd = pickerCurrentPath;
    saveLastCwd(pickerCurrentPath);
    renderCwd();
    closePicker();
  });
  pickerMkdirToggle.addEventListener("click", () => {
    pickerMkdirRow.classList.remove("hidden");
    pickerMkdirName.focus();
  });
  pickerMkdirCancel.addEventListener("click", () => {
    pickerMkdirRow.classList.add("hidden");
    pickerMkdirName.value = "";
  });
  pickerMkdirName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); pickerMkdirConfirm.click(); }
  });
  pickerMkdirConfirm.addEventListener("click", onMkdirConfirm);

  sidebarToggle.addEventListener("click", openSidebarDrawer);
  sidebarClose.addEventListener("click", closeSidebarDrawer);
  sidebarBackdrop.addEventListener("click", closeSidebarDrawer);
  newChatBtn.addEventListener("click", startNewChat);

  accountBtn.addEventListener("click", openAccountModal);
  accountClose.addEventListener("click", closeAccountModal);
  accountLogout.addEventListener("click", logout);
  accountModal.addEventListener("click", (e) => {
    if (e.target === accountModal) closeAccountModal();
  });

  sendBtn.addEventListener("click", send);
  promptInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });
  // Mobile background → resume frequently leaves the SSE socket in a
  // half-dead state where reads silently hang. As soon as we're back
  // to visible, abort the current fetch so the send() loop reattaches
  // via /api/chat/:id/stream and resumes rendering from lastSeq.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!state.sending || !currentController) return;
    reconnectRequested = true;
    try { currentController.abort(); } catch { /* already aborted */ }
  });
}

// === Sidebar ===
async function refreshSidebar() {
  try {
    const res = await apiFetch("/api/conversations");
    const data = await res.json();
    state.conversations = data.items || [];
  } catch {
    state.conversations = [];
  }
  renderSidebar();
}

function renderSidebar() {
  sidebarList.innerHTML = "";
  if (state.conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Pick a working directory to start your first chat.";
    sidebarList.appendChild(empty);
    return;
  }
  for (const c of state.conversations) {
    const item = document.createElement("div");
    item.className = "sidebar-item" + (state.current?.id === c.id ? " active" : "");
    item.dataset.id = c.id;

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = c.title;
    item.appendChild(title);

    const cwd = document.createElement("div");
    cwd.className = "cwd";
    cwd.textContent = c.cwd;
    item.appendChild(cwd);

    if (c.last_context_tokens && c.last_context_window) {
      const pct = Math.round((c.last_context_tokens / c.last_context_window) * 100);
      const ctx = document.createElement("div");
      ctx.className = "ctx" + (pct >= 80 ? " hot" : pct >= 50 ? " warm" : "");
      ctx.textContent = `${pct}% ctx`;
      ctx.title = `${c.last_context_tokens.toLocaleString()} / ${c.last_context_window.toLocaleString()} tokens used (incl. cache + output)`;
      item.appendChild(ctx);
    }

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete conversation";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onDeleteConversation(c.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => selectConversation(c.id));
    sidebarList.appendChild(item);
  }
}

async function onDeleteConversation(id) {
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
    return;
  }
  if (state.current?.id === id) {
    state.current = null;
    state.pendingCwd = getLastCwd();
    location.hash = "";
    renderCwd();
    showEmptyState();
  }
  await refreshSidebar();
}

async function selectConversation(id) {
  closeSidebarDrawer();
  if (state.current?.id === id) return;
  if (state.sending) {
    alert("A response is still streaming. Cancel it first or wait for it to finish.");
    return;
  }
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.current = data.conversation;
    state.pendingCwd = null;
    location.hash = `conv-${id}`;
    clearTranscript();
    hydrateMessages(data.messages || []);
    renderCwd();
    renderSidebar();
  } catch (err) {
    append("error", `Failed to open conversation: ${err.message}`);
  }
}

function startNewChat() {
  if (state.sending) {
    alert("A response is still streaming. Cancel it first or wait for it to finish.");
    return;
  }
  state.current = null;
  state.pendingCwd = getLastCwd();
  location.hash = "";
  clearTranscript();
  showEmptyState();
  renderCwd();
  renderSidebar();
  closeSidebarDrawer();
}

function openSidebarDrawer() {
  document.body.classList.add("sidebar-open");
  sidebarBackdrop.classList.remove("hidden");
}

function closeSidebarDrawer() {
  document.body.classList.remove("sidebar-open");
  sidebarBackdrop.classList.add("hidden");
}

// === Account modal ===
async function openAccountModal() {
  accountModal.classList.remove("hidden");
  accountModal.setAttribute("aria-hidden", "false");
  closeSidebarDrawer();
  accountSessionsEl.innerHTML = `<div class="sidebar-empty">Loading…</div>`;
  try {
    const [meRes, sessRes] = await Promise.all([
      apiFetch("/api/auth/me"),
      apiFetch("/api/auth/sessions"),
    ]);
    const me = await meRes.json();
    const data = await sessRes.json();
    accountUsernameEl.textContent = me.username || "Account";
    renderAccountSessions(data.items || []);
  } catch (err) {
    if (err.message !== "unauthorized") {
      accountSessionsEl.innerHTML = `<div class="sidebar-empty">${escapeHtml(err.message)}</div>`;
    }
  }
}

function closeAccountModal() {
  accountModal.classList.add("hidden");
  accountModal.setAttribute("aria-hidden", "true");
}

function shortenUserAgent(ua) {
  if (!ua) return "unknown client";
  const m = ua.match(/(Firefox|Chrome|Safari|Edge|Opera)\/[\d.]+/);
  const browser = m ? m[1] : "browser";
  let os = "unknown OS";
  if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  return `${browser} · ${os}`;
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderAccountSessions(sessions) {
  accountSessionsEl.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions";
    accountSessionsEl.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "account-session" + (s.current ? " current" : "");

    const ua = document.createElement("div");
    ua.className = "ua";
    const kindTag = document.createElement("span");
    kindTag.className = "session-kind " + (s.kind === "token" ? "token" : "cookie");
    kindTag.textContent = s.kind === "token" ? "API token" : "Browser";
    ua.appendChild(kindTag);
    // Identifier text: for token rows we prefer the user-supplied label
    // (the hub's UA string isn't very identifying); for cookie rows we
    // shorten the User-Agent.
    const idText = document.createTextNode(
      s.kind === "token"
        ? (s.label || shortenUserAgent(s.user_agent))
        : shortenUserAgent(s.user_agent),
    );
    ua.appendChild(idText);
    row.appendChild(ua);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `Last active ${formatRelative(s.last_used_at)}`;
    row.appendChild(meta);

    if (s.current) {
      const badge = document.createElement("div");
      badge.className = "current-badge";
      badge.textContent = "Current";
      row.appendChild(badge);
    } else {
      const btn = document.createElement("button");
      btn.className = "revoke";
      btn.type = "button";
      btn.textContent = "Revoke";
      btn.addEventListener("click", () => revokeSession(s.id, row));
      row.appendChild(btn);
    }

    accountSessionsEl.appendChild(row);
  }
}

async function revokeSession(id, rowEl) {
  if (!confirm("Sign this session out?")) return;
  try {
    const res = await apiFetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    rowEl.remove();
  } catch (err) {
    if (err.message !== "unauthorized") alert(`Failed to revoke: ${err.message}`);
  }
}

async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {}
  location.replace("/login");
}

// === Hash routing ===
function hydrateFromHash() {
  const m = location.hash.match(/^#conv-(.+)$/);
  if (m) {
    const id = m[1];
    if (state.current?.id !== id) selectConversation(id);
  } else if (!state.current) {
    showEmptyState();
  }
}

// === Empty state ===
function showEmptyState() {
  clearTranscript();
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const h = document.createElement("h2");
  h.textContent = "Start a new chat";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Pick a working directory above, then type a prompt.";
  wrap.appendChild(h);
  wrap.appendChild(hint);
  transcript.appendChild(wrap);
}

// === Cwd display ===
function renderCwd() {
  const cwd = state.current?.cwd || state.pendingCwd || "";
  if (cwd) {
    cwdDisplay.textContent = cwd;
    cwdDisplay.classList.remove("cwd-empty");
  } else {
    cwdDisplay.textContent = "Choose folder…";
    cwdDisplay.classList.add("cwd-empty");
  }
  cwdBtn.disabled = !!state.current;
  cwdBtn.title = state.current
    ? "Working directory is locked to this conversation"
    : "Choose working directory";

  // Prompt + Send are disabled until a project (cwd) is selected.
  sendBtn.disabled = !cwd;
  applyPromptState();
}

// Centralizes the prompt textarea's disabled+placeholder state. Two
// reasons to lock it: no cwd selected yet, or an AskUserQuestion form
// is open and awaiting an answer. Send stays available so the user
// can still hit Stop to abort the turn.
function applyPromptState() {
  const cwd = state.current?.cwd || state.pendingCwd;
  if (openAsks.size > 0) {
    promptInput.disabled = true;
    promptInput.placeholder = "Answer the question above to continue…";
    return;
  }
  promptInput.disabled = !cwd;
  promptInput.placeholder = cwd
    ? "Ask Claude Code… (⌘/Ctrl+Enter to send)"
    : "Choose a working directory to start…";
}

// === Picker modal ===
async function fetchList(p) {
  const url = p ? `/api/fs/list?path=${encodeURIComponent(p)}` : "/api/fs/list";
  const res = await apiFetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function renderPickerList(p) {
  pickerListEl.innerHTML = `<div class="picker-empty">Loading…</div>`;
  let data;
  try {
    data = await fetchList(p);
  } catch (err) {
    pickerListEl.innerHTML = `<div class="picker-empty error">${escapeHtml(err.message)}</div>`;
    return;
  }
  pickerCurrentPath = data.path;
  pickerPathInput.value = data.path;
  pickerUp.disabled = !data.parent;
  pickerListEl.innerHTML = "";
  if (data.entries.length === 0) {
    pickerListEl.innerHTML = `<div class="picker-empty">(no subdirectories)</div>`;
    return;
  }
  for (const entry of data.entries) {
    const el = document.createElement("div");
    el.className = "picker-entry" + (entry.hidden ? " hidden-entry" : "");
    el.innerHTML = `<span class="icon">📁</span><span></span>`;
    el.lastElementChild.textContent = entry.name;
    el.addEventListener("click", () => {
      const next = (data.path.replace(/\/+$/, "") || "") + "/" + entry.name;
      renderPickerList(next);
    });
    pickerListEl.appendChild(el);
  }
}

function openPicker() {
  pickerEl.classList.remove("hidden");
  pickerEl.setAttribute("aria-hidden", "false");
  pickerMkdirRow.classList.add("hidden");
  pickerMkdirName.value = "";
  renderPickerList(state.pendingCwd || state.current?.cwd || null);
}

function closePicker() {
  pickerEl.classList.add("hidden");
  pickerEl.setAttribute("aria-hidden", "true");
}

async function onMkdirConfirm() {
  const name = pickerMkdirName.value.trim();
  if (!name || !pickerCurrentPath) return;
  try {
    const res = await apiFetch("/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: pickerCurrentPath, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    pickerMkdirRow.classList.add("hidden");
    pickerMkdirName.value = "";
    await renderPickerList(data.path);
  } catch (err) {
    pickerMkdirName.focus();
    flashMkdirError(err.message);
  }
}

let mkdirErrorTimer = null;
function flashMkdirError(message) {
  pickerMkdirName.style.borderColor = "var(--error)";
  pickerMkdirName.title = message;
  if (mkdirErrorTimer) clearTimeout(mkdirErrorTimer);
  mkdirErrorTimer = setTimeout(() => {
    pickerMkdirName.style.borderColor = "";
    pickerMkdirName.title = "";
  }, 2500);
}

// === Transcript helpers ===
function clearTranscript() {
  transcript.innerHTML = "";
  toolCards.clear();
  openAsks.clear();
  applyPromptState();
}

function append(cls, text) {
  // Remove empty-state if present
  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  transcript.appendChild(el);
  transcript.scrollTop = transcript.scrollHeight;
  return el;
}

function hydrateMessages(messages) {
  for (const row of messages) {
    let content;
    try { content = JSON.parse(row.content_json); }
    catch { continue; }
    if (row.role === "prompt") {
      append("user", content.text || "");
    } else if (row.role === "sdk") {
      renderSdkMessage(content, renderCtx);
    }
  }
}

// === Send ===

function setSending(sending) {
  if (sending) {
    sendBtn.textContent = "Stop";
    sendBtn.classList.add("stop");
  } else {
    sendBtn.textContent = "Send";
    sendBtn.classList.remove("stop");
  }
}

async function stopCurrentChat(conversationId) {
  try {
    await apiFetch(`/api/chat/${encodeURIComponent(conversationId)}/current`, {
      method: "DELETE",
    });
  } catch (err) {
    if (err.message !== "unauthorized") append("error", `Stop failed: ${err.message}`);
  }
}

async function send() {
  if (state.sending) {
    // Don't abort the fetch — that severs the SSE stream and we lose the
    // partial response. Ask the server to cancel the query; it'll flush
    // whatever it has so far and close the stream cleanly.
    if (state.current) stopCurrentChat(state.current.id);
    return;
  }
  const effCwd = state.current?.cwd || state.pendingCwd;
  if (!effCwd) {
    openPicker();
    return;
  }
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  // First message of a new chat — create conversation row.
  if (!state.current) {
    try {
      const res = await apiFetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.pendingCwd }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      state.current = await res.json();
      state.pendingCwd = null;
      location.hash = `conv-${state.current.id}`;
      clearTranscript();
      renderCwd();
      await refreshSidebar();
    } catch (err) {
      append("error", `Failed to start chat: ${err.message}`);
      return;
    }
  }

  append("user", prompt);
  promptInput.value = "";

  lastSeq = 0;
  reconnectRequested = false;
  currentController = new AbortController();
  state.sending = true;
  setSending(true);

  try {
    let res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: state.current.id, prompt }),
      signal: currentController.signal,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      append("error", `HTTP ${res.status}: ${errBody.error || "request failed"}`);
      return;
    }

    // Reconnect loop: read SSE until we see a terminal `end` event, or
    // a non-recoverable error. If the read errors or gets aborted-for-
    // reconnect, reattach via /api/chat/:id/stream?since=lastSeq.
    let endSeen = false;
    while (!endSeen) {
      try {
        await streamSse(res, {
          onMessage: (sdkMsg, meta) => {
            if (typeof meta?.id === "number") lastSeq = Math.max(lastSeq, meta.id);
            renderSdkMessage(sdkMsg, renderCtx);
          },
          onError: (err) => {
            if (err.kind === "parse") append("system", `(unparseable: ${err.raw})`);
            else append("error", err.payload?.message ?? JSON.stringify(err.payload));
          },
          onEnd: () => { endSeen = true; },
        });
      } catch (err) {
        if (err.name === "AbortError" && !reconnectRequested) throw err;
      }
      if (endSeen) break;
      reconnectRequested = false;
      currentController = new AbortController();
      try {
        res = await apiFetch(
          `/api/chat/${encodeURIComponent(state.current.id)}/stream?since=${lastSeq | 0}`,
          { signal: currentController.signal },
        );
        if (!res.ok) {
          append("error", `Reconnect failed: HTTP ${res.status}`);
          break;
        }
      } catch (err) {
        if (err.name !== "AbortError") append("error", `Reconnect failed: ${err.message}`);
        break;
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") append("error", `Network error: ${err.message}`);
    else append("system", "(cancelled)");
  } finally {
    currentController = null;
    state.sending = false;
    setSending(false);
    // Stream is done. If a question was open (e.g. turn aborted before
    // a tool_result arrived), unlock the prompt so the user can move on.
    if (openAsks.size > 0) {
      openAsks.clear();
      applyPromptState();
    }
    refreshSidebar();
  }
}
