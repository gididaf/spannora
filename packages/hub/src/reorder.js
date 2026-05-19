// HTML5 drag-and-drop reorder for the workspace rail. Persists the new
// order to IndexedDB and re-renders the rail.
//
// Pointer-based DnD works on desktop natively; on touch devices, the
// HTML5 DnD spec is unreliable (Safari iOS in particular), so we rely
// on long-press → Instance settings as the alternative interaction
// for mobile users. Reordering on mobile is a power-user feature; first
// pass keeps it desktop-only.

import { reorderInstances } from "./instances.js";

let draggedId = null;

export function attachDnd(railEl, chipEl, instanceId, onReordered) {
  chipEl.setAttribute("draggable", "true");

  chipEl.addEventListener("dragstart", (e) => {
    draggedId = instanceId;
    chipEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    // Some browsers require something to be set, even if we don't use it.
    e.dataTransfer.setData("text/plain", instanceId);
  });

  chipEl.addEventListener("dragend", () => {
    chipEl.classList.remove("dragging");
    draggedId = null;
    // Cleanup any lingering drop-target highlighting.
    for (const c of railEl.querySelectorAll(".rail-chip.drop-target")) {
      c.classList.remove("drop-target");
    }
  });

  chipEl.addEventListener("dragover", (e) => {
    if (!draggedId || draggedId === instanceId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    chipEl.classList.add("drop-target");
  });

  chipEl.addEventListener("dragleave", () => {
    chipEl.classList.remove("drop-target");
  });

  chipEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    chipEl.classList.remove("drop-target");
    const src = draggedId;
    const dst = instanceId;
    if (!src || src === dst) return;

    // Compute the new order by reading the current chip DOM order, then
    // swapping the dragged id into the drop target's slot.
    const ids = [...railEl.querySelectorAll(".rail-chip")]
      .map((c) => c.dataset.instanceId)
      .filter(Boolean);
    const without = ids.filter((id) => id !== src);
    const dstIdx = without.indexOf(dst);
    if (dstIdx < 0) return;
    without.splice(dstIdx, 0, src);

    await reorderInstances(without);
    onReordered?.();
  });
}
