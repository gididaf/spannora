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
    if (!currentController) return;
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
  if (currentController) {
    try { currentController.abort(); } catch { /* already aborted */ }
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
  // A previous attemptResume may have a probe controller in flight
  // (sending=false during the probe, so the check above didn't catch it).
  // Abort it so its lingering frames don't render into the new transcript.
  if (currentController) {
    try { currentController.abort(); } catch { /* already aborted */ }
  }
  setActiveClient(client);
  let messages;
  try {
    const data = await client.getConversation(convId);
    currentConversation = data.conversation;
    pendingCwd = null;
    clearTranscript();
    messages = data.messages || [];
    hydrateMessages(messages);
    renderCwd();
  } catch (err) {
    if (err instanceof InstanceUnauthorizedError) {
      callbacks.onUnauthorized?.(client);
      return;
    }
    appendError(`Failed to open conversation: ${err.message}`);
    return;
  }
  // If the SDK turn is still running server-side, attach to its live
  // stream and resume rendering past whatever's already in DB. If the
  // turn already ended, the server returns an immediate `event: end`
  // and this is a no-op — no UI flicker.
  await attemptResume(messages);
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

// Pump an initial SSE Response through render until `event: end`, with
// automatic reattach on dropped reads (visibilitychange-triggered or
// otherwise). Mutates module state: lastSeq, currentController,
// streamPhase, reconnectRequested. Caller owns the sending/UI flags.
//
// `onActive`, if provided, is invoked at most once when the broker is
// confirmed alive — either via the server's `event: open` frame (sent
// on attach when the broker exists) or, as a fallback, on the first
// message frame. attemptResume uses this to flip the UI to "Stop"
// without waiting for actual content, so a turn that's mid-stream but
// momentarily quiet (between tool calls, mid-thought) still shows the
// correct controls when the user reopens.
async function runStreamLoop(initialRes, onActive) {
  let res = initialRes;
  let endSeen = false;
  let activeFired = false;
  const fireActive = () => {
    if (activeFired) return;
    activeFired = true;
    onActive?.();
  };
  while (!endSeen) {
    streamPhase = "streaming";
    try {
      await streamSse(res, {
        onOpen: () => { fireActive(); },
        onMessage: (sdkMsg, meta) => {
          fireActive();
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
      // below. Treat any other read error as a candidate for reconnect
      // as well — the broker might still be alive.
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
  return activeFired;
}

// Called from openConversation after hydrate. If the conversation's
// turn is still active server-side, attach and stream remaining frames;
// if not, the server's immediate `event: end` ends the loop with no UI
// side-effects (we only flip the UI to "streaming" once a real frame
// arrives — `onFirstFrame` in runStreamLoop).
async function attemptResume(messages) {
  let cursor = 0;
  for (const m of messages) {
    if (typeof m.seq === "number" && m.seq > cursor) cursor = m.seq;
  }
  if (!cursor || !activeClient || !currentConversation) return;

  lastSeq = cursor;
  reconnectRequested = false;
  currentController = new AbortController();
  const convAtStart = currentConversation;

  let res;
  try {
    res = await activeClient.streamReattach(
      currentConversation.id,
      lastSeq,
      currentController.signal,
    );
    if (!res.ok) { currentController = null; return; }
  } catch (err) {
    currentController = null;
    if (err instanceof InstanceUnauthorizedError) callbacks.onUnauthorized?.(activeClient);
    // Other errors stay silent: a cold-reopen resume probe shouldn't
    // surface a red error if the network is flaky — the hydrated DB
    // snapshot is still useful on its own.
    return;
  }

  let activated = false;
  try {
    await runStreamLoop(res, () => {
      // Bail out if the user switched conversations mid-probe.
      if (currentConversation !== convAtStart) return;
      activated = true;
      setSending(true);
    });
  } catch (err) {
    if (err instanceof InstanceUnauthorizedError) callbacks.onUnauthorized?.(activeClient);
    else if (err.name !== "AbortError") appendError(`Network error: ${err.message}`);
  } finally {
    currentController = null;
    streamPhase = null;
    if (activated) {
      setSending(false);
      if (openAsks.size > 0) { openAsks.clear(); applyPromptState(); }
      await callbacks.onChatFinished?.();
    }
  }
}

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
    const res = await activeClient.startChat(
      { conversation_id: currentConversation.id, prompt },
      currentController.signal,
    );
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      appendError(`HTTP ${res.status}: ${errBody.error || "request failed"}`);
      return;
    }
    await runStreamLoop(res);
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
