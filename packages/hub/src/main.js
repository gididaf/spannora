// Hub bootstrap. Orchestrates: workspace rail + instance state, conv
// sidebar refresh, hash routing, picker → chatView wiring, modals.
//
// Hash format:
//   #i-<instance_id>            -> workspace open, no active conv
//   #i-<instance_id>/conv-<id>  -> workspace open, conv open
//
// Per-instance last-picked cwd lives in localStorage under key
// `spannora-hub.lastCwd.<instance_id>` so each workspace can pick up
// where it was.

import {
  listInstances,
  getInstance,
  getActiveInstanceId,
  setActiveInstanceId,
} from "./instances.js";
import { SpannoraClient, InstanceUnauthorizedError } from "./client.js";
import {
  initSidebar,
  refreshRail,
  setActiveInstanceUi,
  renderConversationList,
  setSidebarLoadingState,
  closeSidebarDrawer,
} from "./sidebar.js";
import {
  initChatView,
  setActiveClient,
  setPendingCwd,
  getCurrentConversation,
  clearTranscript,
  showEmptyState,
  showInstanceErrorState,
  startNewChat,
  openConversation,
  abortCurrentSend,
} from "./chatView.js";
import {
  initAddInstanceModal,
  openAddInstanceModal,
} from "./addInstance.js";
import {
  initInstanceSettingsModal,
  openInstanceSettings,
} from "./instanceSettings.js";
import { initPicker, openPicker } from "./picker.js";

// === Android Chrome PWA standalone height workaround (same as server) ===
function syncAppHeight() {
  const h = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
}
syncAppHeight();
window.visualViewport?.addEventListener("resize", syncAppHeight);
window.addEventListener("orientationchange", syncAppHeight);

// === Top-level state ===
const state = {
  activeInstanceId: null,
  activeInstance: null,
  activeClient: null,
  // Per-instance conv lists, refreshed on switch / chat finish.
  conversations: [],
};

const LAST_CWD_PREFIX = "spannora-hub.lastCwd.";
function getLastCwd(instId) {
  try { return localStorage.getItem(LAST_CWD_PREFIX + instId) || null; }
  catch { return null; }
}
function saveLastCwd(instId, p) {
  try { localStorage.setItem(LAST_CWD_PREFIX + instId, p); } catch {}
}

// === Bootstrap ===
init().catch((err) => {
  console.error("hub init failed", err);
});

async function init() {
  initSidebar({
    onNewChat: () => {
      if (!state.activeClient) return;
      startNewChat();
      setPendingCwd(getLastCwd(state.activeInstanceId));
      writeHashForInstance();
    },
    onInstanceSettings: () => {
      if (state.activeInstance) openInstanceSettings(state.activeInstance);
    },
    onAddInstance: openAddInstanceModal,
    onInstanceSelected: switchInstance,
    onInstanceContextMenu: openInstanceSettings,
    onSelectConversation: selectConversation,
    onDeleteConversation: deleteConversation,
  });

  initChatView({
    onPickCwd: () => {
      if (!state.activeClient) return;
      openPicker(
        state.activeClient,
        getCurrentConversation()?.cwd || getLastCwd(state.activeInstanceId),
      );
    },
    onUnauthorized: handleUnauthorized,
    onChatFinished: refreshConversationsForActive,
    onConversationCreated: async (conv) => {
      await refreshConversationsForActive(conv.id);
      writeHashForConv(conv.id);
    },
    onAddInstance: openAddInstanceModal,
  });

  initPicker({
    onSelected: (path) => {
      if (!state.activeInstanceId) return;
      saveLastCwd(state.activeInstanceId, path);
      setPendingCwd(path);
    },
  });

  initAddInstanceModal({
    onInstanceCreated: async (inst) => {
      // First-time setup: make it active automatically.
      const existing = await listInstances();
      const shouldActivate = existing.length === 1 || !state.activeInstanceId;
      if (shouldActivate) {
        await setActiveInstanceId(inst.id);
        await switchInstance(inst.id);
      } else {
        await refreshRail(state.activeInstanceId);
      }
    },
  });

  initInstanceSettingsModal({
    onSaved: async (updated) => {
      if (state.activeInstanceId === updated.id) {
        state.activeInstance = updated;
        state.activeClient = new SpannoraClient(updated);
        setActiveClient(state.activeClient);
        setActiveInstanceUi(updated);
      }
      await refreshRail(state.activeInstanceId);
    },
    onDeleted: async (deletedId) => {
      if (state.activeInstanceId === deletedId) {
        state.activeInstanceId = null;
        state.activeInstance = null;
        state.activeClient = null;
        setActiveClient(null);
        // Fall back to first remaining instance if any.
        const remaining = await listInstances();
        if (remaining.length) {
          await setActiveInstanceId(remaining[0].id);
          await switchInstance(remaining[0].id);
        } else {
          await setActiveInstanceId(null);
          state.conversations = [];
          renderConversationList([], null);
          setActiveInstanceUi(null);
          showEmptyState({ hasInstance: false });
          history.replaceState(null, "", "#");
        }
      }
      await refreshRail(state.activeInstanceId);
    },
  });

  // Hydrate from storage
  const instances = await refreshRail(null);
  const storedActive = await getActiveInstanceId();
  const fromHash = parseHash();

  let targetInstId = fromHash.instanceId || storedActive;
  if (targetInstId && !instances.find((i) => i.id === targetInstId)) {
    targetInstId = null;
  }
  if (!targetInstId && instances.length) {
    targetInstId = instances[0].id;
  }

  if (targetInstId) {
    await setActiveInstanceId(targetInstId);
    await switchInstance(targetInstId, fromHash.convId);
  } else {
    setActiveInstanceUi(null);
    renderConversationList([], null);
    showEmptyState({ hasInstance: false });
  }

  window.addEventListener("hashchange", onHashChange);
}

// === Hash routing ===
function parseHash() {
  const m = location.hash.match(/^#i-([^/]+)(?:\/conv-(.+))?$/);
  if (!m) return { instanceId: null, convId: null };
  return { instanceId: m[1], convId: m[2] || null };
}

function writeHashForInstance() {
  if (!state.activeInstanceId) return;
  const h = `#i-${state.activeInstanceId}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

function writeHashForConv(convId) {
  if (!state.activeInstanceId) return;
  const h = `#i-${state.activeInstanceId}/conv-${convId}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}

async function onHashChange() {
  const { instanceId, convId } = parseHash();
  if (!instanceId) return;
  if (instanceId !== state.activeInstanceId) {
    await switchInstance(instanceId, convId);
    return;
  }
  if (convId && convId !== getCurrentConversation()?.id) {
    await selectConversation(convId);
  }
}

// === Instance switching ===
async function switchInstance(instanceId, autoOpenConvId = null) {
  await abortCurrentSend();
  state.activeInstanceId = instanceId;
  state.activeInstance = await getInstance(instanceId);
  if (!state.activeInstance) {
    state.activeInstanceId = null;
    state.activeClient = null;
    setActiveClient(null);
    setActiveInstanceUi(null);
    renderConversationList([], null);
    showEmptyState({ hasInstance: false });
    return;
  }
  state.activeClient = new SpannoraClient(state.activeInstance);
  setActiveClient(state.activeClient);
  setActiveInstanceUi(state.activeInstance);
  await refreshRail(instanceId);
  setSidebarLoadingState("Loading…");
  setPendingCwd(getLastCwd(instanceId));
  clearTranscript();
  showEmptyState({ hasInstance: true });
  writeHashForInstance();

  const ok = await refreshConversationsForActive(autoOpenConvId);
  if (ok && autoOpenConvId) {
    await selectConversation(autoOpenConvId);
  }
}

async function refreshConversationsForActive(focusConvId = null) {
  if (!state.activeClient) {
    state.conversations = [];
    renderConversationList([], null);
    return false;
  }
  try {
    const data = await state.activeClient.listConversations();
    state.conversations = data.items || [];
    const focused = focusConvId || getCurrentConversation()?.id || null;
    renderConversationList(state.conversations, focused);
    return true;
  } catch (err) {
    if (err instanceof InstanceUnauthorizedError) {
      handleUnauthorized(state.activeClient);
    } else {
      setSidebarLoadingState(`Couldn't load: ${err.message}`);
      showInstanceErrorState(
        `Could not reach <code>${state.activeInstance.base_url}</code>. ` +
        `(${err.message})`,
      );
    }
    return false;
  }
}

async function selectConversation(convId) {
  if (!state.activeClient) return;
  closeSidebarDrawer();
  const current = getCurrentConversation();
  if (current?.id === convId) return;
  await openConversation(state.activeClient, convId);
  // Repaint sidebar with new active highlight
  renderConversationList(state.conversations, convId);
  writeHashForConv(convId);
}

async function deleteConversation(convId) {
  if (!state.activeClient) return;
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  try {
    await state.activeClient.deleteConversation(convId);
  } catch (err) {
    if (err instanceof InstanceUnauthorizedError) {
      handleUnauthorized(state.activeClient);
      return;
    }
    alert(`Failed to delete: ${err.message}`);
    return;
  }
  if (getCurrentConversation()?.id === convId) {
    startNewChat();
    setPendingCwd(getLastCwd(state.activeInstanceId));
    writeHashForInstance();
  }
  await refreshConversationsForActive();
}

function handleUnauthorized(client) {
  const inst = client.instance;
  const msg =
    `The API token for "${inst.label}" was rejected by ${inst.base_url}. ` +
    `It was probably revoked from the server's account modal. ` +
    `Remove this instance and add it again with fresh credentials.`;
  showInstanceErrorState(msg);
  setSidebarLoadingState("Token revoked");
}
