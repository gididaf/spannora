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
const toolCards = new Map();
// tool_use_ids of AskUserQuestion cards whose form is still open
// (not yet answered, denied, or aborted). While non-empty, the main
// prompt textarea is locked so the user can only interact with the form.
const openAsks = new Set();

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
    ua.textContent = shortenUserAgent(s.user_agent);
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

function appendNode(node) {
  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();
  transcript.appendChild(node);
  transcript.scrollTop = transcript.scrollHeight;
}

function hydrateMessages(messages) {
  for (const row of messages) {
    let content;
    try { content = JSON.parse(row.content_json); }
    catch { continue; }
    if (row.role === "prompt") {
      append("user", content.text || "");
    } else if (row.role === "sdk") {
      renderSdkMessage(content);
    }
  }
}

// === SDK message rendering ===
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const preferred = [
    "file_path", "filePath", "command", "pattern", "url",
    "query", "path", "prompt", "description", "name",
  ];
  for (const key of preferred) {
    if (typeof input[key] === "string") return input[key];
  }
  for (const val of Object.values(input)) {
    if (typeof val === "string") return val;
  }
  return JSON.stringify(input);
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

// === Phase 2b — pretty tool renderers ===

let hljsPromise = null;
function loadHljs() {
  if (window.hljs) return Promise.resolve(window.hljs);
  if (hljsPromise) return hljsPromise;
  hljsPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
    s.onload = () => resolve(window.hljs);
    s.onerror = (e) => { hljsPromise = null; reject(e); };
    document.head.appendChild(s);
  });
  return hljsPromise;
}

const EXT_LANG = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript",
  json: "json", html: "xml", htm: "xml", xml: "xml", svg: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  swift: "swift", kt: "kotlin", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
  md: "markdown", markdown: "markdown",
  sql: "sql", lua: "lua", dart: "dart", vue: "xml",
  dockerfile: "dockerfile",
};

function langForPath(filePath) {
  if (typeof filePath !== "string") return "";
  const base = filePath.split("/").pop() || "";
  if (/^Dockerfile/i.test(base)) return "dockerfile";
  const m = base.match(/\.([a-zA-Z0-9]+)$/);
  return m ? (EXT_LANG[m[1].toLowerCase()] || "") : "";
}

function highlightInto(el, code, lang) {
  el.textContent = code;
  loadHljs().then((hljs) => {
    if (!hljs || !el.isConnected) return;
    try {
      const result = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true })
        : hljs.highlightAuto(code);
      el.innerHTML = result.value;
      el.classList.add("hljs");
    } catch {}
  }).catch(() => {});
}

function lineDiff(a, b) {
  const aLines = (a ?? "").split("\n");
  const bLines = (b ?? "").split("\n");
  const m = aLines.length;
  const n = bLines.length;
  const CAP = 4000;
  if (m > CAP || n > CAP) {
    return [
      ...aLines.map((t) => ({ type: "del", text: t })),
      ...bLines.map((t) => ({ type: "add", text: t })),
    ];
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) { result.push({ type: "eq", text: aLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: "del", text: aLines[i] }); i++; }
    else { result.push({ type: "add", text: bLines[j] }); j++; }
  }
  while (i < m) result.push({ type: "del", text: aLines[i++] });
  while (j < n) result.push({ type: "add", text: bLines[j++] });
  return result;
}

function diffBlock(oldStr, newStr) {
  const block = document.createElement("div");
  block.className = "diff-block";
  for (const ln of lineDiff(oldStr, newStr)) {
    const row = document.createElement("div");
    row.className = `diff-line ${ln.type}`;
    row.textContent = ln.text;
    block.appendChild(row);
  }
  if (!block.childNodes.length) {
    const empty = document.createElement("div");
    empty.className = "diff-line eq";
    empty.textContent = "(no changes)";
    block.appendChild(empty);
  }
  return block;
}

function fileMeta(pathStr, extra) {
  const wrap = document.createElement("div");
  wrap.className = "file-meta";
  const p = document.createElement("span");
  p.className = "path";
  p.textContent = pathStr || "(no path)";
  wrap.appendChild(p);
  if (extra) {
    const e = document.createElement("span");
    e.className = "extra";
    e.textContent = extra;
    wrap.appendChild(e);
  }
  return wrap;
}

function sectionLabel(text) {
  const l = document.createElement("div");
  l.className = "tool-section-label";
  l.textContent = text;
  return l;
}

function resultList(items) {
  const list = document.createElement("div");
  list.className = "result-list";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "(no results)";
    list.appendChild(empty);
    return list;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "result-item";
    row.textContent = item;
    list.appendChild(row);
  }
  return list;
}

function errorPane(content) {
  const pre = document.createElement("pre");
  pre.className = "tool-error";
  pre.textContent = stringifyContent(content) || "(error)";
  return pre;
}

function renderEdit(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-edit";
  const extra = input.replace_all ? "replace all" : "";
  wrap.appendChild(fileMeta(input.file_path, extra));
  wrap.appendChild(diffBlock(input.old_string, input.new_string));
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function renderMultiEdit(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-multiedit";
  const edits = Array.isArray(input.edits) ? input.edits : [];
  wrap.appendChild(fileMeta(input.file_path, `${edits.length} edit${edits.length === 1 ? "" : "s"}`));
  edits.forEach((edit, idx) => {
    wrap.appendChild(sectionLabel(`Edit ${idx + 1}${edit.replace_all ? " · replace all" : ""}`));
    wrap.appendChild(diffBlock(edit.old_string, edit.new_string));
  });
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function renderWrite(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-write";
  const text = typeof input.content === "string" ? input.content : "";
  const lineCount = text ? text.split("\n").length : 0;
  wrap.appendChild(fileMeta(input.file_path, `${lineCount} line${lineCount === 1 ? "" : "s"} · ${text.length} char${text.length === 1 ? "" : "s"}`));
  const code = document.createElement("pre");
  code.className = "code-block";
  highlightInto(code, text, langForPath(input.file_path));
  wrap.appendChild(code);
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function renderBash(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-bash";
  const cmd = document.createElement("pre");
  cmd.className = "bash-cmd";
  cmd.textContent = `$ ${input.command || ""}`;
  wrap.appendChild(cmd);
  if (input.description) {
    const desc = document.createElement("div");
    desc.className = "bash-desc";
    desc.textContent = input.description;
    wrap.appendChild(desc);
  }
  const out = document.createElement("pre");
  out.className = "bash-output" + (isError ? " err" : "");
  out.textContent = stringifyContent(content) || "(no output)";
  wrap.appendChild(out);
  const status = document.createElement("div");
  status.className = "bash-status " + (isError ? "err" : "ok");
  status.textContent = isError ? "✗ non-zero exit" : "✓ exit 0";
  wrap.appendChild(status);
  return wrap;
}

function renderRead(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-read";
  const text = stringifyContent(content);
  const lineCount = text ? text.split("\n").length : 0;
  const extra = [];
  if (input.offset) extra.push(`offset ${input.offset}`);
  if (input.limit) extra.push(`limit ${input.limit}`);
  extra.push(`${lineCount} line${lineCount === 1 ? "" : "s"}`);
  wrap.appendChild(fileMeta(input.file_path, extra.join(" · ")));
  if (isError) { wrap.appendChild(errorPane(content)); return wrap; }
  const pre = document.createElement("pre");
  pre.className = "read-content";
  pre.textContent = text || "(empty)";
  wrap.appendChild(pre);
  return wrap;
}

function renderGlob(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-glob";
  const text = stringifyContent(content);
  const items = text ? text.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const extra = [`pattern: ${input.pattern ?? "(none)"}`];
  if (input.path) extra.push(`in ${input.path}`);
  extra.push(`${items.length} match${items.length === 1 ? "" : "es"}`);
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = extra.join(" · ");
  wrap.appendChild(meta);
  if (isError) { wrap.appendChild(errorPane(content)); return wrap; }
  wrap.appendChild(resultList(items));
  return wrap;
}

function renderGrep(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-grep";
  const text = stringifyContent(content);
  const lines = text ? text.split("\n").filter((s) => s.length > 0) : [];
  const extra = [`pattern: ${input.pattern ?? "(none)"}`];
  if (input.path) extra.push(`in ${input.path}`);
  if (input.glob) extra.push(`glob: ${input.glob}`);
  if (input.output_mode) extra.push(input.output_mode);
  extra.push(`${lines.length} result${lines.length === 1 ? "" : "s"}`);
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = extra.join(" · ");
  wrap.appendChild(meta);
  if (isError) { wrap.appendChild(errorPane(content)); return wrap; }
  wrap.appendChild(resultList(lines));
  return wrap;
}

function renderAskUserQuestion(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-aq";

  // The questions are on the original tool_use input. The answers ride
  // back inside the tool_result content as a flat string the SDK builds
  // in mapToolResultToToolResultBlockParam:
  //   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now…`
  // Parse "X"="Y" pairs out of it.
  let answers = {};
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const raw = stringifyContent(content);
  const re = /"((?:[^"\\]|\\.)*)"=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    answers[m[1]] = m[2];
  }
  // The assistant input may also carry answers directly (e.g. if a future
  // SDK echoes them there). Prefer those if present.
  if (input && typeof input === "object" && input.answers && typeof input.answers === "object") {
    answers = input.answers;
  }

  for (const q of questions) {
    const qWrap = document.createElement("div");
    qWrap.className = "aq-result-q";
    const head = document.createElement("div");
    head.className = "aq-result-head";
    const chip = document.createElement("span");
    chip.className = "aq-chip";
    chip.textContent = q.header || "Q";
    const title = document.createElement("span");
    title.className = "aq-result-title";
    title.textContent = q.question || "";
    head.append(chip, title);
    qWrap.appendChild(head);
    const ans = document.createElement("div");
    ans.className = "aq-result-answer";
    ans.textContent = answers[q.question] ?? "(no answer)";
    qWrap.appendChild(ans);
    wrap.appendChild(qWrap);
  }
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

const renderers = {
  Edit: renderEdit,
  MultiEdit: renderMultiEdit,
  Write: renderWrite,
  Bash: renderBash,
  Read: renderRead,
  Glob: renderGlob,
  Grep: renderGrep,
  AskUserQuestion: renderAskUserQuestion,
};

function renderToolBody(name, input, content, isError) {
  const fn = renderers[name];
  if (!fn) return null;
  try { return fn(input || {}, content, isError); }
  catch (e) { console.warn(`[spannora] ${name} renderer threw`, e); return null; }
}

function renderGeneric(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-generic";
  wrap.appendChild(sectionLabel("Input"));
  const inPre = document.createElement("pre");
  inPre.className = "tool-section";
  inPre.textContent = JSON.stringify(input ?? {}, null, 2);
  wrap.appendChild(inPre);
  wrap.appendChild(sectionLabel("Output"));
  const outText = stringifyContent(content);
  const outPre = document.createElement("pre");
  outPre.className = "tool-section" + (outText ? "" : " empty");
  outPre.textContent = outText || "(empty)";
  wrap.appendChild(outPre);
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function rawToggle(input, content, isError) {
  const det = document.createElement("details");
  det.className = "raw-toggle";
  const sum = document.createElement("summary");
  sum.textContent = "Show raw";
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "raw-pane";
  pre.textContent = JSON.stringify({ input: input ?? {}, content, is_error: !!isError }, null, 2);
  det.appendChild(pre);
  return det;
}

function makeToolCard(block) {
  const card = document.createElement("details");
  card.className = "tool-card";
  // Auto-expand AskUserQuestion so the form is visible without a click.
  if (block.name === "AskUserQuestion") card.open = true;

  const header = document.createElement("summary");
  header.className = "tool-header";

  const arrow = document.createElement("span");
  arrow.className = "tool-arrow";
  arrow.textContent = "▶";

  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = block.name || "(tool)";

  const summaryEl = document.createElement("span");
  summaryEl.className = "tool-summary";
  summaryEl.textContent = block.name === "AskUserQuestion"
    ? `${(block.input?.questions ?? []).length} question${(block.input?.questions ?? []).length === 1 ? "" : "s"}`
    : summarizeToolInput(block.input);

  const statusEl = document.createElement("span");
  statusEl.className = "tool-status pending";
  statusEl.textContent = "…";

  header.append(arrow, nameEl, summaryEl, statusEl);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "tool-body";
  if (block.name === "AskUserQuestion" && block.id) {
    body.appendChild(makeAskQuestionForm(block.id, block.input || {}));
  } else {
    const waiting = document.createElement("div");
    waiting.className = "tool-waiting";
    waiting.textContent = "(waiting for result…)";
    body.appendChild(waiting);
  }
  card.appendChild(body);

  if (block.id) toolCards.set(block.id, {
    card, statusEl, body,
    name: block.name,
    input: block.input,
  });
  return card;
}

function makeAskQuestionForm(toolUseId, input) {
  const form = document.createElement("div");
  form.className = "aq-form";

  openAsks.add(toolUseId);
  applyPromptState();

  const questions = Array.isArray(input.questions) ? input.questions : [];
  // Per-question selection state. For single-select we track an index;
  // for multi-select we track a Set of indices. Free-text "Other" is
  // tracked separately and always allowed (the SDK doesn't include an
  // "Other" option in `options` — it expects the host to add one).
  const qState = questions.map((q) => ({
    selectedIdx: null,         // single-select: index of picked option
    selectedIdxs: new Set(),   // multi-select: indices of picked options
    otherSelected: false,      // is the "Other" radio/checkbox checked?
    otherText: "",
    multi: !!q.multiSelect,
  }));

  questions.forEach((q, qi) => {
    const qWrap = document.createElement("div");
    qWrap.className = "aq-question";

    const headerRow = document.createElement("div");
    headerRow.className = "aq-question-header";
    const chip = document.createElement("span");
    chip.className = "aq-chip";
    chip.textContent = q.header || `Q${qi + 1}`;
    if (q.multiSelect) {
      const multi = document.createElement("span");
      multi.className = "aq-multi-hint";
      multi.textContent = "multi-select";
      headerRow.append(chip, multi);
    } else {
      headerRow.appendChild(chip);
    }
    qWrap.appendChild(headerRow);

    const titleEl = document.createElement("div");
    titleEl.className = "aq-title";
    titleEl.textContent = q.question || "";
    qWrap.appendChild(titleEl);

    const groupName = `aq-${toolUseId}-${qi}`;
    let otherCheck;  // declared early so option handlers can clear it

    const opts = Array.isArray(q.options) ? q.options : [];
    opts.forEach((opt, oi) => {
      const row = document.createElement("label");
      row.className = "aq-option";
      const inp = document.createElement("input");
      inp.type = q.multiSelect ? "checkbox" : "radio";
      inp.name = groupName;
      inp.value = String(oi);
      inp.addEventListener("change", () => {
        if (q.multiSelect) {
          if (inp.checked) qState[qi].selectedIdxs.add(oi);
          else qState[qi].selectedIdxs.delete(oi);
        } else {
          qState[qi].selectedIdx = oi;
          // Browser already unchecked the Other radio in the same group;
          // mirror that in state.
          qState[qi].otherSelected = false;
        }
      });
      const txt = document.createElement("span");
      txt.className = "aq-option-text";
      const label = document.createElement("span");
      label.className = "aq-option-label";
      label.textContent = opt.label || "";
      txt.appendChild(label);
      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "aq-option-desc";
        desc.textContent = opt.description;
        txt.appendChild(desc);
      }
      row.append(inp, txt);
      qWrap.appendChild(row);
    });

    // "Other" — rendered as one more option row. Per the SDK schema:
    // "There should be no 'Other' option, that will be provided automatically."
    // Not wrapped in <label> because the text input lives inside it and we
    // don't want clicks/keystrokes there to toggle the radio.
    const otherRow = document.createElement("div");
    otherRow.className = "aq-option aq-option-other";
    otherCheck = document.createElement("input");
    otherCheck.type = q.multiSelect ? "checkbox" : "radio";
    otherCheck.name = groupName;
    otherCheck.value = "__other__";
    otherCheck.addEventListener("change", () => {
      qState[qi].otherSelected = otherCheck.checked;
      if (!q.multiSelect && otherCheck.checked) {
        // Browser already unchecked the option radio; mirror that in state.
        qState[qi].selectedIdx = null;
      }
    });
    const otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.className = "aq-other-input";
    otherInput.placeholder = q.multiSelect ? "Other (will be added)" : "Other answer";
    otherInput.addEventListener("input", () => {
      qState[qi].otherText = otherInput.value;
      // Auto-select Other when the user starts typing. For single-select,
      // assigning .checked = true also unchecks the previously-picked
      // option radio (browser maintains the radio-group invariant).
      if (otherInput.value && !otherCheck.checked) {
        otherCheck.checked = true;
        qState[qi].otherSelected = true;
        if (!q.multiSelect) qState[qi].selectedIdx = null;
      }
    });
    otherRow.append(otherCheck, otherInput);
    qWrap.appendChild(otherRow);

    form.appendChild(qWrap);
  });

  const footer = document.createElement("div");
  footer.className = "aq-footer";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "aq-submit";
  submit.textContent = "Submit";
  const msg = document.createElement("span");
  msg.className = "aq-msg";
  footer.append(submit, msg);
  form.appendChild(footer);

  submit.addEventListener("click", async () => {
    const answers = {};
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const s = qState[qi];
      const opts = Array.isArray(q.options) ? q.options : [];
      const other = s.otherText.trim();
      const label = `"${q.header || `Q${qi + 1}`}"`;
      if (q.multiSelect) {
        const picked = [...s.selectedIdxs].map((i) => opts[i]?.label).filter(Boolean);
        if (s.otherSelected) {
          if (!other) {
            msg.textContent = `Please type your Other answer for ${label}.`;
            return;
          }
          picked.push(other);
        }
        if (picked.length === 0) {
          msg.textContent = `Please answer ${label}.`;
          return;
        }
        answers[q.question] = picked.join(", ");
      } else {
        if (s.otherSelected) {
          if (!other) {
            msg.textContent = `Please type your Other answer for ${label}.`;
            return;
          }
          answers[q.question] = other;
        } else if (s.selectedIdx != null) {
          answers[q.question] = opts[s.selectedIdx]?.label || "";
        } else {
          msg.textContent = `Please answer ${label}.`;
          return;
        }
      }
    }

    submit.disabled = true;
    submit.textContent = "Submitting…";
    msg.textContent = "";
    try {
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
      // Lock the form. The inbound tool_result will replace this body
      // with a summary via setToolResult anyway, but if that's slow the
      // user shouldn't be able to re-submit.
      form.querySelectorAll("input").forEach((el) => { el.disabled = true; });
      submit.textContent = "Submitted";
      // setToolResult will also drop this id when the tool_result
      // arrives, but unlocking the prompt as soon as we know the
      // resolver fired feels snappier.
      openAsks.delete(toolUseId);
      applyPromptState();
    } catch (err) {
      if (err.message === "unauthorized") return;
      msg.textContent = `Failed: ${err.message}`;
      submit.disabled = false;
      submit.textContent = "Submit";
      // The question is dead (404 / network) — let the user type again.
      openAsks.delete(toolUseId);
      applyPromptState();
    }
  });

  return form;
}

function setToolResult(toolUseId, content, isError) {
  const entry = toolCards.get(toolUseId);
  if (!entry) return;
  // AskUserQuestion result arriving → unlock the prompt if it was the
  // last open one. Covers Stop-aborts-turn and normal-completion paths.
  if (openAsks.delete(toolUseId)) applyPromptState();

  const body = renderToolBody(entry.name, entry.input, content, isError)
    || renderGeneric(entry.input, content, isError);

  entry.body.replaceChildren(body, rawToggle(entry.input, content, isError));

  entry.statusEl.classList.remove("pending");
  if (isError) {
    entry.statusEl.classList.add("err");
    entry.statusEl.textContent = "✗";
  } else {
    entry.statusEl.classList.add("ok");
    entry.statusEl.textContent = "✓";
  }
}

function makeTextBubble(cls, text) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  return el;
}

function renderAssistant(msg) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "text") {
      const t = (block.text ?? "").trim();
      if (t) appendNode(makeTextBubble("assistant", block.text));
    } else if (block.type === "tool_use") {
      appendNode(makeToolCard(block));
    }
  }
}

function renderUser(msg) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "tool_result") {
      setToolResult(block.tool_use_id, block.content, block.is_error);
    }
  }
}

function renderSystem(msg) {
  if (msg.subtype === "init") {
    const sid = msg.session_id ? String(msg.session_id).slice(0, 8) : "?";
    const model = msg.model || "";
    appendNode(makeTextBubble("system", `session ${sid} · ${model}`));
  }
}

function renderResult(msg) {
  const ok = msg.subtype === "success";
  const parts = [];
  parts.push(ok ? "✓ done" : `✗ ${msg.subtype ?? "error"}`);
  if (typeof msg.duration_ms === "number") parts.push(`${(msg.duration_ms / 1000).toFixed(1)}s`);
  const pct = ctxUsedPct(msg);
  if (pct !== null) parts.push(`${pct}% ctx`);
  appendNode(makeTextBubble("system", parts.join(" · ")));
}

// Mirrors Claude Code's status-line math (see sdk.cli.js Qo/OI/_DA/bd):
//   numerator = input + cache_read + cache_creation + output  (latest assistant turn)
//   denominator = contextWindow(model) - maxOutputTokens(model)
// Both derived from the model id substring; the SDK's modelUsage.contextWindow
// is ignored because it isn't what Claude Code itself reads.
function ctxUsedPct(msg) {
  const u = msg?.usage;
  if (!u) return null;
  const num =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  if (num <= 0) return null;
  const model = pickModelId(msg);
  const denom = contextWindowFor(model) - maxOutputFor(model);
  if (denom <= 0) return null;
  return Math.round((num / denom) * 100);
}

function pickModelId(msg) {
  const keys = msg?.modelUsage ? Object.keys(msg.modelUsage) : [];
  return keys[0] || "";
}

function contextWindowFor(model) {
  return model.includes("[1m]") ? 1_000_000 : 200_000;
}

function maxOutputFor(model) {
  if (model.includes("opus-4-5")) return 64_000;
  if (model.includes("opus-4")) return 32_000;
  if (model.includes("sonnet-4") || model.includes("haiku-4")) return 64_000;
  if (model.includes("3-5")) return 8_192;
  if (model.includes("claude-3-opus")) return 4_096;
  if (model.includes("claude-3-sonnet")) return 8_192;
  if (model.includes("claude-3-haiku")) return 4_096;
  return 32_000;
}

function renderSdkMessage(msg) {
  switch (msg.type) {
    case "system":    renderSystem(msg); break;
    case "assistant": renderAssistant(msg); break;
    case "user":      renderUser(msg); break;
    case "result":    renderResult(msg); break;
    default: break;
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

  currentController = new AbortController();
  state.sending = true;
  setSending(true);

  try {
    const res = await apiFetch("/api/chat", {
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepIdx;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        handleSseFrame(rawEvent);
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

function handleSseFrame(frame) {
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
  }
  if (!data) return;
  let parsed;
  try { parsed = JSON.parse(data); }
  catch { append("system", `(unparseable: ${data})`); return; }
  if (event === "message") renderSdkMessage(parsed);
  else if (event === "error") append("error", parsed.message ?? JSON.stringify(parsed));
}
