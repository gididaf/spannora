// Two pieces of left-side chrome:
//   1. Workspace rail (instance chips, +, DnD)
//   2. Conversation sidebar for the active instance
//
// Conversation rendering mirrors the in-server PWA's sidebar, but the
// data comes from a bearer-authed SpannoraClient, and per-conversation
// hash routing is namespaced by instance id so reloads restore the
// correct workspace.

import { listInstances, initialsFor, setActiveInstanceId } from "./instances.js";
import { attachDnd } from "./reorder.js";

const railEl = document.getElementById("rail");
const sidebarList = document.getElementById("sidebar-list");
const sidebarTitle = document.getElementById("sidebar-title");
const instanceLabelEl = document.getElementById("active-instance-label");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

let callbacks = {};

export function initSidebar(handlers) {
  callbacks = handlers;

  document.getElementById("sidebar-toggle").addEventListener("click", openSidebarDrawer);
  document.getElementById("sidebar-close").addEventListener("click", closeSidebarDrawer);
  sidebarBackdrop.addEventListener("click", closeSidebarDrawer);
  document.getElementById("new-chat-btn").addEventListener("click", () => {
    callbacks.onNewChat?.();
    closeSidebarDrawer();
  });
  document.getElementById("instance-settings-btn").addEventListener("click", () => {
    callbacks.onInstanceSettings?.();
  });
}

export async function refreshRail(activeId) {
  const instances = await listInstances();
  railEl.innerHTML = "";

  for (const inst of instances) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rail-chip" + (inst.id === activeId ? " active" : "");
    chip.style.background = inst.color;
    chip.dataset.instanceId = inst.id;
    chip.title = `${inst.label} — ${inst.base_url}`;
    chip.textContent = initialsFor(inst.label);
    chip.addEventListener("click", async () => {
      if (inst.id === activeId) return;
      await setActiveInstanceId(inst.id);
      callbacks.onInstanceSelected?.(inst.id);
    });
    // Right-click / long-press → instance settings
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      callbacks.onInstanceContextMenu?.(inst);
    });
    attachDnd(railEl, chip, inst.id, () => refreshRail(activeId));
    railEl.appendChild(chip);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "rail-add";
  add.title = "Add spannora instance";
  add.textContent = "+";
  add.addEventListener("click", () => callbacks.onAddInstance?.());
  railEl.appendChild(add);

  return instances;
}

export function setActiveInstanceUi(instance) {
  if (!instance) {
    sidebarTitle.textContent = "No instance";
    instanceLabelEl.textContent = "spannora hub";
    sidebarList.innerHTML = "";
    return;
  }
  sidebarTitle.textContent = instance.label;
  instanceLabelEl.textContent = instance.label;
  instanceLabelEl.title = instance.base_url;
}

export function renderConversationList(conversations, activeConvId) {
  sidebarList.innerHTML = "";
  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No chats yet. Pick a working directory and send your first prompt.";
    sidebarList.appendChild(empty);
    return;
  }
  for (const c of conversations) {
    const item = document.createElement("div");
    item.className = "sidebar-item" + (c.id === activeConvId ? " active" : "");
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
      ctx.title = `${c.last_context_tokens.toLocaleString()} / ${c.last_context_window.toLocaleString()} tokens used`;
      item.appendChild(ctx);
    }

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "×";
    del.title = "Delete conversation";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      callbacks.onDeleteConversation?.(c.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => {
      callbacks.onSelectConversation?.(c.id);
      closeSidebarDrawer();
    });
    sidebarList.appendChild(item);
  }
}

export function setSidebarLoadingState(message) {
  sidebarList.innerHTML = `<div class="sidebar-empty">${message}</div>`;
}

export function openSidebarDrawer() {
  document.body.classList.add("sidebar-open");
  sidebarBackdrop.classList.remove("hidden");
}

export function closeSidebarDrawer() {
  document.body.classList.remove("sidebar-open");
  sidebarBackdrop.classList.add("hidden");
}
