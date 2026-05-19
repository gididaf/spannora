// Working-directory picker. Ported from packages/server/public/app.js.
// Identical UX, but reads from the active instance's bearer-authed client
// instead of same-origin apiFetch. Lives in the hub package because it's
// too DOM-heavy and only has two consumers (server + hub).

import { escapeHtml } from "../shared/index.js";

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

let activeClient = null;
let pickerCurrentPath = null;
let onSelected = null;
let mkdirErrorTimer = null;

export function initPicker(handlers) {
  onSelected = handlers.onSelected;
  pickerCloseBtn.addEventListener("click", closePicker);
  pickerCancel.addEventListener("click", closePicker);
  pickerEl.addEventListener("click", (e) => {
    if (e.target === pickerEl) closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pickerEl.classList.contains("hidden")) closePicker();
  });
  pickerUp.addEventListener("click", async () => {
    if (!pickerCurrentPath || !activeClient) return;
    try {
      const data = await activeClient.fsList(pickerCurrentPath);
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
    const path = pickerCurrentPath;
    closePicker();
    onSelected?.(path);
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
}

export function openPicker(client, startPath) {
  activeClient = client;
  pickerEl.classList.remove("hidden");
  pickerEl.setAttribute("aria-hidden", "false");
  pickerMkdirRow.classList.add("hidden");
  pickerMkdirName.value = "";
  renderPickerList(startPath || null);
}

export function closePicker() {
  pickerEl.classList.add("hidden");
  pickerEl.setAttribute("aria-hidden", "true");
  activeClient = null;
}

async function renderPickerList(p) {
  if (!activeClient) return;
  pickerListEl.innerHTML = `<div class="picker-empty">Loading…</div>`;
  let data;
  try {
    data = await activeClient.fsList(p);
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

async function onMkdirConfirm() {
  if (!activeClient) return;
  const name = pickerMkdirName.value.trim();
  if (!name || !pickerCurrentPath) return;
  try {
    const data = await activeClient.fsMkdir({ parent: pickerCurrentPath, name });
    pickerMkdirRow.classList.add("hidden");
    pickerMkdirName.value = "";
    await renderPickerList(data.path);
  } catch (err) {
    pickerMkdirName.focus();
    flashMkdirError(err.message);
  }
}

function flashMkdirError(message) {
  pickerMkdirName.style.borderColor = "var(--error)";
  pickerMkdirName.title = message;
  if (mkdirErrorTimer) clearTimeout(mkdirErrorTimer);
  mkdirErrorTimer = setTimeout(() => {
    pickerMkdirName.style.borderColor = "";
    pickerMkdirName.title = "";
  }, 2500);
}
