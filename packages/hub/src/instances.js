// Instance CRUD over IndexedDB. An "instance" is a registered spannora
// backend with a bearer token, display label, color, and sort order.
//
// Row shape:
//   { id, base_url, label, color, order, token, created_at }
//
// `base_url` is always the canonical origin (scheme + host + optional port,
// no trailing slash). The active-instance pointer lives in the `settings`
// store under key "active_instance_id".

import { getAll, getOne, putOne, deleteOne, bulkPut } from "./storage.js";

export const PALETTE = [
  "#7aa2f7", "#f7768e", "#9ece6a", "#e0af68",
  "#bb9af7", "#7dcfff", "#ff9e64", "#73daca",
];

export function normalizeBaseUrl(input) {
  const u = new URL(input);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("URL must be http:// or https://");
  }
  // strip trailing slash + anything after the origin
  return u.origin;
}

export function fallbackLabel(baseUrl) {
  try { return new URL(baseUrl).hostname; }
  catch { return baseUrl; }
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback for older browsers
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10).join("")}`;
}

export async function listInstances() {
  const rows = await getAll("instances", "by_order");
  return rows.sort((a, b) => a.order - b.order);
}

export async function getInstance(id) {
  return getOne("instances", id);
}

export async function createInstance({ base_url, label, token }) {
  const existing = await listInstances();
  // Defend against duplicate registrations of the same origin — clobber
  // the previous row's token if the user re-adds an instance, rather than
  // accumulating dead tokens.
  const dup = existing.find((i) => i.base_url === base_url);
  if (dup) {
    const updated = { ...dup, label: label || dup.label, token, created_at: Date.now() };
    await putOne("instances", updated);
    return updated;
  }
  const order = existing.length
    ? Math.max(...existing.map((i) => i.order)) + 1
    : 0;
  const color = PALETTE[existing.length % PALETTE.length];
  const row = {
    id: uuid(),
    base_url,
    label: label || fallbackLabel(base_url),
    color,
    order,
    token,
    created_at: Date.now(),
  };
  await putOne("instances", row);
  return row;
}

export async function updateInstance(id, patch) {
  const row = await getOne("instances", id);
  if (!row) throw new Error("instance not found");
  const merged = { ...row, ...patch };
  await putOne("instances", merged);
  return merged;
}

export async function deleteInstance(id) {
  await deleteOne("instances", id);
  const active = await getActiveInstanceId();
  if (active === id) await setActiveInstanceId(null);
}

export async function reorderInstances(idsInNewOrder) {
  const rows = await listInstances();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const updated = [];
  idsInNewOrder.forEach((id, i) => {
    const row = byId.get(id);
    if (row && row.order !== i) updated.push({ ...row, order: i });
  });
  if (updated.length) await bulkPut("instances", updated);
}

export async function getActiveInstanceId() {
  const row = await getOne("settings", "active_instance_id");
  return row?.value ?? null;
}

export async function setActiveInstanceId(id) {
  await putOne("settings", { key: "active_instance_id", value: id });
}

export function initialsFor(label) {
  const trimmed = (label || "?").trim();
  if (!trimmed) return "?";
  // First letter of first 1-2 word-ish chunks
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
