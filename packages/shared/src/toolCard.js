// Tool card builder + result-binder. A card is a <details> element that
// starts collapsed (open by default for AskUserQuestion so the form is
// visible without a click), and flips its body from "(waiting for result…)"
// to a renderer-specific body when the matching tool_result arrives.
//
// Callers pass a ctx { toolCards: Map, askContext } so the same module can
// drive both the in-server PWA and the hub — they keep their own per-pane
// toolCards Map and provide an askContext suited to their auth path.

import { summarizeToolInput } from "./dom.js";
import { renderToolBody, renderGeneric, rawToggle } from "./toolRenderers.js";
import { makeAskQuestionForm } from "./askUserQuestion.js";

export function makeToolCard(block, ctx) {
  const card = document.createElement("details");
  card.className = "tool-card";
  // Auto-expand AskUserQuestion so the form is visible without a click.
  if (block.name === "AskUserQuestion") card.open = true;

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
  summaryEl.textContent = block.name === "AskUserQuestion"
    ? `${(block.input?.questions ?? []).length} question${(block.input?.questions ?? []).length === 1 ? "" : "s"}`
    : summarizeToolInput(block.input);

  const statusEl = document.createElement("span");
  statusEl.className = "tool-status pending";
  statusEl.textContent = "…";

  header.append(arrow, nameEl, summaryEl, statusEl);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "tool-body";
  if (block.name === "AskUserQuestion" && block.id) {
    body.appendChild(makeAskQuestionForm(block.id, block.input || {}, ctx.askContext));
  } else {
    const waiting = document.createElement("div");
    waiting.className = "tool-waiting";
    waiting.textContent = "(waiting for result…)";
    body.appendChild(waiting);
  }
  card.appendChild(body);

  if (block.id) ctx.toolCards.set(block.id, {
    card, statusEl, body,
    name: block.name,
    input: block.input,
  });
  return card;
}

export function setToolResult(toolUseId, content, isError, ctx) {
  const entry = ctx.toolCards.get(toolUseId);
  if (!entry) return;
  // AskUserQuestion result arriving → notify the host so it can unlock
  // its prompt textarea if this was the last open question. Covers
  // both stop-aborts-turn and normal-completion paths.
  ctx.askContext?.onClosed?.(toolUseId);

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
