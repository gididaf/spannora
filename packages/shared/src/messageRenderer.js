// SDK message → DOM dispatcher. Walks an SDK message envelope (system /
// assistant / user / result) and appends the appropriate bubbles + tool
// cards to ctx.transcript.
//
// ctx shape:
//   {
//     transcript: HTMLElement,                          // append target
//     toolCards: Map<tool_use_id, ToolCardEntry>,       // for setToolResult
//     askContext: AskContext,                           // see askUserQuestion.js
//   }

import { appendToTranscript, makeTextBubble } from "./dom.js";
import { makeToolCard, setToolResult } from "./toolCard.js";

export function renderSdkMessage(msg, ctx) {
  switch (msg.type) {
    case "system":    renderSystem(msg, ctx); break;
    case "assistant": renderAssistant(msg, ctx); break;
    case "user":      renderUser(msg, ctx); break;
    case "result":    renderResult(msg, ctx); break;
    default: break;
  }
}

function renderSystem(msg, ctx) {
  if (msg.subtype === "init") {
    const sid = msg.session_id ? String(msg.session_id).slice(0, 8) : "?";
    const model = msg.model || "";
    appendToTranscript(ctx.transcript, makeTextBubble("system", `session ${sid} · ${model}`));
  }
}

function renderAssistant(msg, ctx) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "text") {
      const t = (block.text ?? "").trim();
      if (t) appendToTranscript(ctx.transcript, makeTextBubble("assistant", block.text));
    } else if (block.type === "tool_use") {
      appendToTranscript(ctx.transcript, makeToolCard(block, ctx));
    }
  }
}

function renderUser(msg, ctx) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "tool_result") {
      setToolResult(block.tool_use_id, block.content, block.is_error, ctx);
    }
  }
}

function renderResult(msg, ctx) {
  const ok = msg.subtype === "success";
  const parts = [];
  parts.push(ok ? "✓ done" : `✗ ${msg.subtype ?? "error"}`);
  if (typeof msg.duration_ms === "number") parts.push(`${(msg.duration_ms / 1000).toFixed(1)}s`);
  const pct = ctxUsedPct(msg);
  if (pct !== null) parts.push(`${pct}% ctx`);
  appendToTranscript(ctx.transcript, makeTextBubble("system", parts.join(" · ")));
}

// Mirrors Claude Code's status-line math (see sdk.cli.js Qo/OI/_DA/bd):
//   numerator = input + cache_read + cache_creation + output  (latest assistant turn)
//   denominator = contextWindow(model) - maxOutputTokens(model)
// Both derived from the model id substring; the SDK's modelUsage.contextWindow
// is ignored because it isn't what Claude Code itself reads. Same lookups
// also live in src/server.ts for the sidebar's ctx badge — keep in sync.
function ctxUsedPct(msg) {
  const u = msg?.usage;
  if (!u) return null;
  const num =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  if (num <= 0) return null;
  const model = pickModelId(msg);
  const denom = contextWindowFor(model) - maxOutputFor(model);
  if (denom <= 0) return null;
  return Math.round((num / denom) * 100);
}

function pickModelId(msg) {
  const keys = msg?.modelUsage ? Object.keys(msg.modelUsage) : [];
  return keys[0] || "";
}

function contextWindowFor(model) {
  return model.includes("[1m]") ? 1_000_000 : 200_000;
}

function maxOutputFor(model) {
  if (model.includes("opus-4-5")) return 64_000;
  if (model.includes("opus-4")) return 32_000;
  if (model.includes("sonnet-4") || model.includes("haiku-4")) return 64_000;
  if (model.includes("3-5")) return 8_192;
  if (model.includes("claude-3-opus")) return 4_096;
  if (model.includes("claude-3-sonnet")) return 8_192;
  if (model.includes("claude-3-haiku")) return 4_096;
  return 32_000;
}
