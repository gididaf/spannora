// Add-instance modal. Collects URL+creds, normalizes the URL, posts to
// the spannora's `/api/auth/token` endpoint, and stores the resulting
// bearer token in IndexedDB.
//
// Pre-flight guards:
//   - mixed-content: hub on https + spannora on http will fail in the
//     browser; surface a clear message instead of letting the fetch error
//     bubble up as a generic "network error".
//   - duplicate origin: handled inside createInstance() — it updates the
//     row's token in place rather than creating a second chip.

import { createInstance, normalizeBaseUrl } from "./instances.js";

const el = (id) => document.getElementById(id);

const modal = el("add-modal");
const closeBtn = el("add-close");
const cancelBtn = el("add-cancel");
const submitBtn = el("add-submit");
const urlInput = el("add-url");
const userInput = el("add-username");
const passInput = el("add-password");
const labelInput = el("add-label");
const errBox = el("add-error");

let onCreated = null;

function showError(msg) {
  errBox.textContent = msg;
  errBox.classList.remove("hidden");
}
function clearError() {
  errBox.textContent = "";
  errBox.classList.add("hidden");
}

export function initAddInstanceModal({ onInstanceCreated }) {
  onCreated = onInstanceCreated;
  closeBtn.addEventListener("click", closeAddInstanceModal);
  cancelBtn.addEventListener("click", closeAddInstanceModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAddInstanceModal(); });
  submitBtn.addEventListener("click", onSubmit);
  for (const inp of [urlInput, userInput, passInput, labelInput]) {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onSubmit(); } });
  }
}

export function openAddInstanceModal() {
  clearError();
  urlInput.value = "";
  userInput.value = "";
  passInput.value = "";
  labelInput.value = "";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => urlInput.focus(), 0);
}

export function closeAddInstanceModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

async function onSubmit() {
  clearError();
  const rawUrl = urlInput.value.trim();
  const username = userInput.value;
  const password = passInput.value;
  const label = labelInput.value.trim();

  if (!rawUrl || !username || !password) {
    showError("URL, username, and password are all required.");
    return;
  }

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch (err) {
    showError(`Invalid URL: ${err.message}`);
    return;
  }

  // Mixed-content check: hub on https cannot reach an http backend.
  if (location.protocol === "https:" && baseUrl.startsWith("http:")) {
    showError(
      "The hub is loaded over https but the spannora URL is http. " +
      "Browsers block mixed-content requests. Use an https URL, or " +
      "self-host the hub on the same protocol as your spannora.",
    );
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Adding…";
  try {
    const res = await fetch(`${baseUrl}/api/auth/token`, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        label: label || "hub PWA",
      }),
    });
    if (res.status === 401) {
      showError("Invalid credentials.");
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error || `HTTP ${res.status}`);
      return;
    }
    const { token } = await res.json();
    const inst = await createInstance({ base_url: baseUrl, label, token });
    closeAddInstanceModal();
    onCreated?.(inst);
  } catch (err) {
    showError(
      `Could not reach ${baseUrl}. ` +
      "Check the URL is correct and that the spannora was started with " +
      `SPANNORA_ALLOWED_ORIGINS including \`${location.origin}\`. ` +
      `(${err.message})`,
    );
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Add";
  }
}
