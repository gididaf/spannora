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
  const hasCwd = !!cwd;
  promptInput.disabled = !hasCwd;
  sendBtn.disabled = !hasCwd;
  promptInput.placeholder = hasCwd
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

const renderers = {
  Edit: renderEdit,
  MultiEdit: renderMultiEdit,
  Write: renderWrite,
  Bash: renderBash,
  Read: renderRead,
  Glob: renderGlob,
  Grep: renderGrep,
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
  summaryEl.textContent = summarizeToolInput(block.input);

  const statusEl = document.createElement("span");
  statusEl.className = "tool-status pending";
  statusEl.textContent = "…";

  header.append(arrow, nameEl, summaryEl, statusEl);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "tool-body";
  const waiting = document.createElement("div");
  waiting.className = "tool-waiting";
  waiting.textContent = "(waiting for result…)";
  body.appendChild(waiting);
  card.appendChild(body);

  if (block.id) toolCards.set(block.id, {
    card, statusEl, body,
    name: block.name,
    input: block.input,
  });
  return card;
}

function setToolResult(toolUseId, content, isError) {
  const entry = toolCards.get(toolUseId);
  if (!entry) return;

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
  if (typeof msg.total_cost_usd === "number") parts.push(`$${msg.total_cost_usd.toFixed(4)}`);
  appendNode(makeTextBubble("system", parts.join(" · ")));
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

async function send() {
  if (state.sending) {
    if (currentController) currentController.abort();
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
