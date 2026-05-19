// Per-tool body renderers (Edit, MultiEdit, Write, Bash, Read, Glob, Grep,
// AskUserQuestion) plus a generic fallback and the raw-JSON disclosure.
//
// These render the *result* portion of a tool card (i.e. the body shown
// once the tool_result block arrives). The pending-state body and the
// AskUserQuestion *form* live in toolCard.js / askUserQuestion.js.

import {
  fileMeta,
  sectionLabel,
  resultList,
  errorPane,
  stringifyContent,
} from "./dom.js";
import { highlightInto, langForPath } from "./highlight.js";
import { diffBlock } from "./diff.js";

function renderEdit(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-edit";
  const extra = input.replace_all ? "replace all" : "";
  wrap.appendChild(fileMeta(input.file_path, extra));
  wrap.appendChild(diffBlock(input.old_string, input.new_string));
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function renderMultiEdit(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-multiedit";
  const edits = Array.isArray(input.edits) ? input.edits : [];
  wrap.appendChild(fileMeta(input.file_path, `${edits.length} edit${edits.length === 1 ? "" : "s"}`));
  edits.forEach((edit, idx) => {
    wrap.appendChild(sectionLabel(`Edit ${idx + 1}${edit.replace_all ? " · replace all" : ""}`));
    wrap.appendChild(diffBlock(edit.old_string, edit.new_string));
  });
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function renderWrite(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-write";
  const text = typeof input.content === "string" ? input.content : "";
  const lineCount = text ? text.split("\n").length : 0;
  wrap.appendChild(fileMeta(input.file_path, `${lineCount} line${lineCount === 1 ? "" : "s"} · ${text.length} char${text.length === 1 ? "" : "s"}`));
  const code = document.createElement("pre");
  code.className = "code-block";
  highlightInto(code, text, langForPath(input.file_path));
  wrap.appendChild(code);
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

function renderBash(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-bash";
  const cmd = document.createElement("pre");
  cmd.className = "bash-cmd";
  cmd.textContent = `$ ${input.command || ""}`;
  wrap.appendChild(cmd);
  if (input.description) {
    const desc = document.createElement("div");
    desc.className = "bash-desc";
    desc.textContent = input.description;
    wrap.appendChild(desc);
  }
  const out = document.createElement("pre");
  out.className = "bash-output" + (isError ? " err" : "");
  out.textContent = stringifyContent(content) || "(no output)";
  wrap.appendChild(out);
  const status = document.createElement("div");
  status.className = "bash-status " + (isError ? "err" : "ok");
  status.textContent = isError ? "✗ non-zero exit" : "✓ exit 0";
  wrap.appendChild(status);
  return wrap;
}

function renderRead(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-read";
  const text = stringifyContent(content);
  const lineCount = text ? text.split("\n").length : 0;
  const extra = [];
  if (input.offset) extra.push(`offset ${input.offset}`);
  if (input.limit) extra.push(`limit ${input.limit}`);
  extra.push(`${lineCount} line${lineCount === 1 ? "" : "s"}`);
  wrap.appendChild(fileMeta(input.file_path, extra.join(" · ")));
  if (isError) { wrap.appendChild(errorPane(content)); return wrap; }
  const pre = document.createElement("pre");
  pre.className = "read-content";
  pre.textContent = text || "(empty)";
  wrap.appendChild(pre);
  return wrap;
}

function renderGlob(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-glob";
  const text = stringifyContent(content);
  const items = text ? text.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const extra = [`pattern: ${input.pattern ?? "(none)"}`];
  if (input.path) extra.push(`in ${input.path}`);
  extra.push(`${items.length} match${items.length === 1 ? "" : "es"}`);
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = extra.join(" · ");
  wrap.appendChild(meta);
  if (isError) { wrap.appendChild(errorPane(content)); return wrap; }
  wrap.appendChild(resultList(items));
  return wrap;
}

function renderGrep(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-grep";
  const text = stringifyContent(content);
  const lines = text ? text.split("\n").filter((s) => s.length > 0) : [];
  const extra = [`pattern: ${input.pattern ?? "(none)"}`];
  if (input.path) extra.push(`in ${input.path}`);
  if (input.glob) extra.push(`glob: ${input.glob}`);
  if (input.output_mode) extra.push(input.output_mode);
  extra.push(`${lines.length} result${lines.length === 1 ? "" : "s"}`);
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = extra.join(" · ");
  wrap.appendChild(meta);
  if (isError) { wrap.appendChild(errorPane(content)); return wrap; }
  wrap.appendChild(resultList(lines));
  return wrap;
}

function renderAskUserQuestionResult(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-aq";

  // The questions are on the original tool_use input. The answers ride
  // back inside the tool_result content as a flat string the SDK builds
  // in mapToolResultToToolResultBlockParam:
  //   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now…`
  // Parse "X"="Y" pairs out of it.
  let answers = {};
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const raw = stringifyContent(content);
  const re = /"((?:[^"\\]|\\.)*)"=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    answers[m[1]] = m[2];
  }
  // The assistant input may also carry answers directly (e.g. if a future
  // SDK echoes them there). Prefer those if present.
  if (input && typeof input === "object" && input.answers && typeof input.answers === "object") {
    answers = input.answers;
  }

  for (const q of questions) {
    const qWrap = document.createElement("div");
    qWrap.className = "aq-result-q";
    const head = document.createElement("div");
    head.className = "aq-result-head";
    const chip = document.createElement("span");
    chip.className = "aq-chip";
    chip.textContent = q.header || "Q";
    const title = document.createElement("span");
    title.className = "aq-result-title";
    title.textContent = q.question || "";
    head.append(chip, title);
    qWrap.appendChild(head);
    const ans = document.createElement("div");
    ans.className = "aq-result-answer";
    ans.textContent = answers[q.question] ?? "(no answer)";
    qWrap.appendChild(ans);
    wrap.appendChild(qWrap);
  }
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

export const renderers = {
  Edit: renderEdit,
  MultiEdit: renderMultiEdit,
  Write: renderWrite,
  Bash: renderBash,
  Read: renderRead,
  Glob: renderGlob,
  Grep: renderGrep,
  AskUserQuestion: renderAskUserQuestionResult,
};

export function renderToolBody(name, input, content, isError) {
  const fn = renderers[name];
  if (!fn) return null;
  try { return fn(input || {}, content, isError); }
  catch (e) { console.warn(`[spannora] ${name} renderer threw`, e); return null; }
}

export function renderGeneric(input, content, isError) {
  const wrap = document.createElement("div");
  wrap.className = "render-generic";
  wrap.appendChild(sectionLabel("Input"));
  const inPre = document.createElement("pre");
  inPre.className = "tool-section";
  inPre.textContent = JSON.stringify(input ?? {}, null, 2);
  wrap.appendChild(inPre);
  wrap.appendChild(sectionLabel("Output"));
  const outText = stringifyContent(content);
  const outPre = document.createElement("pre");
  outPre.className = "tool-section" + (outText ? "" : " empty");
  outPre.textContent = outText || "(empty)";
  wrap.appendChild(outPre);
  if (isError) wrap.appendChild(errorPane(content));
  return wrap;
}

export function rawToggle(input, content, isError) {
  const det = document.createElement("details");
  det.className = "raw-toggle";
  const sum = document.createElement("summary");
  sum.textContent = "Show raw";
  det.appendChild(sum);
  const pre = document.createElement("pre");
  pre.className = "raw-pane";
  pre.textContent = JSON.stringify({ input: input ?? {}, content, is_error: !!isError }, null, 2);
  det.appendChild(pre);
  return det;
}
