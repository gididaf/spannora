// Per-instance settings modal: relabel, recolor, remove.
//
// "Remove" only forgets the instance locally — the bearer token continues
// to exist on the spannora server until the user revokes it from there.
// We surface that distinction in the UI so users don't think Remove ==
// kill the token.

import { PALETTE, updateInstance, deleteInstance } from "./instances.js";

const el = (id) => document.getElementById(id);
const modal = el("settings-modal");
const closeBtn = el("settings-close");
const cancelBtn = el("settings-cancel");
const saveBtn = el("settings-save");
const deleteBtn = el("settings-delete");
const labelInput = el("settings-label");
const urlEl = el("settings-url");
const colorsEl = el("settings-colors");

let currentInstance = null;
let chosenColor = null;
let onSaved = null;
let onDeleted = null;

export function initInstanceSettingsModal(handlers) {
  onSaved = handlers.onSaved;
  onDeleted = handlers.onDeleted;
  closeBtn.addEventListener("click", closeInstanceSettings);
  cancelBtn.addEventListener("click", closeInstanceSettings);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeInstanceSettings(); });
  saveBtn.addEventListener("click", onSave);
  deleteBtn.addEventListener("click", onDelete);
}

export function openInstanceSettings(instance) {
  currentInstance = instance;
  chosenColor = instance.color;
  labelInput.value = instance.label;
  urlEl.textContent = instance.base_url;
  renderColors();
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => labelInput.focus(), 0);
}

export function closeInstanceSettings() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  currentInstance = null;
}

function renderColors() {
  colorsEl.innerHTML = "";
  for (const c of PALETTE) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (c === chosenColor ? " active" : "");
    sw.style.background = c;
    sw.addEventListener("click", () => {
      chosenColor = c;
      renderColors();
    });
    colorsEl.appendChild(sw);
  }
}

async function onSave() {
  if (!currentInstance) return;
  const label = labelInput.value.trim() || currentInstance.label;
  const updated = await updateInstance(currentInstance.id, { label, color: chosenColor });
  closeInstanceSettings();
  onSaved?.(updated);
}

async function onDelete() {
  if (!currentInstance) return;
  if (!confirm(
    `Remove "${currentInstance.label}" from this hub?\n\n` +
    "The bearer token on the spannora server is NOT revoked. " +
    "To revoke it, open the spannora's account modal and remove the matching session.",
  )) return;
  const id = currentInstance.id;
  await deleteInstance(id);
  closeInstanceSettings();
  onDeleted?.(id);
}
