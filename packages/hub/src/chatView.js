// Active-instance chat view. Owns the transcript DOM, the prompt input,
// and the send/stream/answer loop. All SDK-message rendering, SSE parsing,
// and tool-card construction comes from @spannora/shared so the visual
// output matches the in-server PWA exactly.
//
// The chat view is "instance-aware" via a per-call SpannoraClient. On
// instance switch, callers should:
//   1. await abortCurrentSend()
//   2. clearTranscript()
//   3. call setActiveClient(newClient)
//   4. either showEmptyState() or hydrateConversation(...)

import {
  streamSse,
  renderSdkMessage,
  escapeHtml,
} from "../shared/index.js";
import { InstanceUnauthorizedError } from "./client.js";

const transcript = document.getElementById("transcript");
const promptInput = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const cwdBtn = document.getElementById("cwd-btn");
const cwdDisplay = document.getElementById("cwd-display");

const toolCards = new Map();
const openAsks = new Set();

let activeClient = null;
let currentConversation = null; // {id, cwd, ...}
let pendingCwd = null;
let sending = false;
// Controls the SSE fetch in the current send() iteration. Cycled on every
// reconnect: when the page returns to visible after a mobile background,
// we abort this controller to break out of the (likely-dead) read loop
// and immediately attach a fresh streamReattach.
let currentController = null;
// Tracks the highest SSE message seq seen in the current turn. Used as
// the `since` cursor when we reconnect after a mobile background — the
// server-side broker replays anything emitted past that seq from its
// in-memory buffer.
let lastSeq = 0;
// True iff the current AbortController was tripped on purpose to force
// a reconnect (vs. a user-initiated cancel via abortCurrentSend). The
// stream loop in send() distinguishes the two: reconnect → silently
// reattach; user cancel → propagate AbortError to caller.
let reconnectRequested = false;
// "streaming" only while we're actively awaiting reader.read() on the SSE
// body. The visibilitychange handler only aborts during this phase — so a
// late/duplicate visibility event during the reattach fetch can't abort the
// fresh controller and trigger "signal is aborted without reason".
let streamPhase = null; // "streaming" | null

let callbacks = {
  onPickCwd: null,         // () => void  (opens picker)
  onUnauthorized: null,    // (client) => void
  onChatFinished: null,    // () => Promise<void>  (refresh sidebar)
  onConversationCreated: null, // (conv) => Promise<void>
};

const renderCtx = {
  transcript,
  toolCards,
  askContext: {
    async submitAnswer(toolUseId, answers) {
      if (!activeClient || !currentConversation) {
        throw new Error("No active conversation.");
      }
      try {
        await activeClient.answer(currentConversation.id, toolUseId, answers);
      } catch (err) {
        if (err instanceof InstanceUnauthorizedError) {
          callbacks.onUnauthorized?.(activeClient);
        }
        throw err;
      }
    },
    onOpen(toolUseId) { openAsks.add(toolUseId); applyPromptState(); },
    onClosed(toolUseId) { if (openAsks.delete(toolUseId)) applyPromptState(); },
  },
};

export function initChatView(handlers) {
  callbacks = { ...callbacks, ...handlers };
  cwdBtn.addEventListener("click", () => {
    if (currentConversation) return; // locked once a conv exists
    callbacks.onPickCwd?.();
  });
  sendBtn.addEventListener("click", () => send().catch(() => {}));
  promptInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send().catch(() => {});
    }
  });
  // Mobile background → resume often leaves the SSE TCP socket in a
  // half-dead state where reads silently hang for minutes before the
  // OS times out. As soon as we're back to visible, proactively break
  // the current SSE read so the send() loop reattaches via the broker's
  // replay endpoint. We ONLY abort when streamPhase === "streaming" —
  // mobile browsers can fire `visibilitychange` multiple times during a
  // foreground transition; if we aborted blindly we'd kill the fresh
  // controller we just minted for the reattach fetch, causing fetch to
  // throw "signal is aborted without reason".
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!sending || !currentController) return;
    if (streamPhase !== "streaming") return;
    reconnectRequested = true;
    try { currentController.abort(); } catch { /* already aborted */ }
  });
  applyPromptState();
}

export function setActiveClient(client) {
  activeClient = client;
  applyPromptState();
}

export function setPendingCwd(cwd) {
  if (currentConversation) return; // ignore; conv locks its own cwd
  pendingCwd = cwd;
  renderCwd();
}

export function getCurrentConversation() {
  return currentConversation;
}

export function clearTranscript() {
  transcript.innerHTML = "";
  toolCards.clear();
  openAsks.clear();
  applyPromptState();
}

export function showEmptyState({ hasInstance } = { hasInstance: false }) {
  clearTranscript();
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const h = document.createElement("h2");
  const hint = document.createElement("div");
  hint.className = "hint";
  if (!hasInstance) {
    h.textContent = "Welcome to spannora hub";
    hint.innerHTML =
      "Add a spannora instance to get started. The hub stores per-instance " +
      "API tokens locally in IndexedDB; revoke any token at any time from " +
      "the spannora server's account modal.";
    const cta = document.createElement("button");
    cta.className = "cta";
    cta.type = "button";
    cta.textContent = "+ Add spannora instance";
    cta.addEventListener("click", () => callbacks.onAddInstance?.());
    wrap.appendChild(h);
    wrap.appendChild(hint);
    wrap.appendChild(cta);
  } else {
    h.textContent = "Start a new chat";
    hint.textContent = "Pick a working directory above, then type a prompt.";
    wrap.appendChild(h);
    wrap.appendChild(hint);
  }
  transcript.appendChild(wrap);
}

export function startNewChat() {
  if (sending) {
    alert("A response is still streaming. Cancel it first or wait.");
    return;
  }
  currentConversation = null;
  // pendingCwd persists — typically last-used cwd from main's per-instance memory
  clearTranscript();
  showEmptyState({ hasInstance: !!activeClient });
  renderCwd();
}

export async function openConversation(client, convId) {
  if (sending) {
    alert("A response is still streaming. Cancel it first or wait.");
    return;
  }
  setActiveClient(client);
  try {
    const data = await client.getConversation(convId);
    currentConversation = data.conversation;
    pendingCwd = null;
    clearTranscript();
    hydrateMessages(data.messages || []);
    renderCwd();
  } catch (err) {
    if (err instanceof InstanceUnauthorizedError) {
      callbacks.onUnauthorized?.(client);
      return;
    }
    appendError(`Failed to open conversation: ${err.message}`);
  }
}

export async function abortCurrentSend() {
  if (sending && currentConversation && activeClient) {
    try { await activeClient.stopChat(currentConversation.id); } catch {}
  }
  if (currentController) {
    try { currentController.abort(); } catch {}
  }
  // Don't reset `sending` here — the in-flight send() finally{} will.
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

function renderCwd() {
  const cwd = currentConversation?.cwd || pendingCwd || "";
  if (cwd) {
    cwdDisplay.textContent = cwd;
    cwdDisplay.classList.remove("cwd-empty");
  } else {
    cwdDisplay.textContent = "Choose folder…";
    cwdDisplay.classList.add("cwd-empty");
  }
  cwdBtn.disabled = !!currentConversation || !activeClient;
  cwdBtn.title = currentConversation
    ? "Working directory is locked to this conversation"
    : (activeClient ? "Choose working directory" : "Add a spannora instance first");
  sendBtn.disabled = !cwd || !activeClient;
  applyPromptState();
}

function applyPromptState() {
  const cwd = currentConversation?.cwd || pendingCwd;
  if (!activeClient) {
    promptInput.disabled = true;
    promptInput.placeholder = "Add a spannora instance to start…";
    sendBtn.disabled = true;
    return;
  }
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

function setSending(s) {
  sending = s;
  if (s) {
    sendBtn.textContent = "Stop";
    sendBtn.classList.add("stop");
    sendBtn.disabled = false;
  } else {
    sendBtn.textContent = "Send";
    sendBtn.classList.remove("stop");
  }
}

function append(cls, text) {
  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  transcript.appendChild(el);
  transcript.scrollTop = transcript.scrollHeight;
  return el;
}

function appendError(message) { append("error", message); }

async function send() {
  if (!activeClient) return;
  if (sending) {
    // Don't tear down the SSE stream; ask the server to cancel cleanly.
    if (currentConversation) {
      try { await activeClient.stopChat(currentConversation.id); } catch {}
    }
    return;
  }
  const effCwd = currentConversation?.cwd || pendingCwd;
  if (!effCwd) {
    callbacks.onPickCwd?.();
    return;
  }
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  // Create the conversation on first prompt
  if (!currentConversation) {
    try {
      currentConversation = await activeClient.createConversation({ cwd: pendingCwd });
      pendingCwd = null;
      clearTranscript();
      renderCwd();
      await callbacks.onConversationCreated?.(currentConversation);
    } catch (err) {
      if (err instanceof InstanceUnauthorizedError) {
        callbacks.onUnauthorized?.(activeClient);
        return;
      }
      appendError(`Failed to start chat: ${err.message}`);
      return;
    }
  }

  append("user", prompt);
  promptInput.value = "";

  lastSeq = 0;
  reconnectRequested = false;
  currentController = new AbortController();
  setSending(true);

  try {
    let res = await activeClient.startChat(
      { conversation_id: currentConversation.id, prompt },
      currentController.signal,
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      appendError(`HTTP ${res.status}: ${errBody.error || "request failed"}`);
      return;
    }
    // Reconnect loop: stay in here as long as the turn hasn't seen a
    // terminal `end` event. Each iteration reads the current SSE stream
    // to exhaustion; if it errors or gets aborted-for-reconnect, we
    // reattach via streamReattach and resume rendering past lastSeq.
    let endSeen = false;
    while (!endSeen) {
      streamPhase = "streaming";
      try {
        await streamSse(res, {
          onMessage: (sdkMsg, meta) => {
            if (typeof meta?.id === "number") lastSeq = Math.max(lastSeq, meta.id);
            renderSdkMessage(sdkMsg, renderCtx);
          },
          onError: (err) => {
            if (err.kind === "parse") append("system", `(unparseable: ${err.raw})`);
            else appendError(err.payload?.message ?? JSON.stringify(err.payload));
          },
          onEnd: () => { endSeen = true; },
        });
      } catch (err) {
        // A genuine user-cancel (abortCurrentSend) propagates; a
        // visibility-triggered reconnect falls through to the reattach
        // below. Treat any other read error as a candidate for
        // reconnect as well — the broker might still be alive.
        if (err.name === "AbortError" && !reconnectRequested) {
          streamPhase = null;
          throw err;
        }
      }
      streamPhase = null;
      if (endSeen) break;
      reconnectRequested = false;
      currentController = new AbortController();
      try {
        res = await activeClient.streamReattach(
          currentConversation.id,
          lastSeq,
          currentController.signal,
        );
        if (!res.ok) {
          appendError(`Reconnect failed: HTTP ${res.status}`);
          break;
        }
      } catch (err) {
        if (err.name !== "AbortError") appendError(`Reconnect failed: ${err.message}`);
        break;
      }
    }
  } catch (err) {
    if (err instanceof InstanceUnauthorizedError) {
      callbacks.onUnauthorized?.(activeClient);
    } else if (err.name === "AbortError") {
      append("system", "(cancelled)");
    } else {
      appendError(`Network error: ${err.message}`);
    }
  } finally {
    currentController = null;
    streamPhase = null;
    setSending(false);
    if (openAsks.size > 0) {
      openAsks.clear();
      applyPromptState();
    }
    await callbacks.onChatFinished?.();
  }
}

// Used by main.js to render an instance-error inline (e.g. token revoked).
export function showInstanceErrorState(message) {
  clearTranscript();
  const wrap = document.createElement("div");
  wrap.className = "empty-state";
  const h = document.createElement("h2");
  h.textContent = "Instance unreachable";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.innerHTML = escapeHtml(message);
  wrap.appendChild(h);
  wrap.appendChild(hint);
  transcript.appendChild(wrap);
}
