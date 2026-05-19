// Small DOM + stringification helpers shared by the in-server PWA and the hub.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function makeTextBubble(cls, text) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  return el;
}

export function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

export function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const preferred = [
    "file_path", "filePath", "command", "pattern", "url",
    "query", "path", "prompt", "description", "name",
  ];
  for (const key of preferred) {
    if (typeof input[key] === "string") return input[key];
  }
  for (const val of Object.values(input)) {
    if (typeof val === "string") return val;
  }
  return JSON.stringify(input);
}

export function fileMeta(pathStr, extra) {
  const wrap = document.createElement("div");
  wrap.className = "file-meta";
  const p = document.createElement("span");
  p.className = "path";
  p.textContent = pathStr || "(no path)";
  wrap.appendChild(p);
  if (extra) {
    const e = document.createElement("span");
    e.className = "extra";
    e.textContent = extra;
    wrap.appendChild(e);
  }
  return wrap;
}

export function sectionLabel(text) {
  const l = document.createElement("div");
  l.className = "tool-section-label";
  l.textContent = text;
  return l;
}

export function resultList(items) {
  const list = document.createElement("div");
  list.className = "result-list";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "result-empty";
    empty.textContent = "(no results)";
    list.appendChild(empty);
    return list;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "result-item";
    row.textContent = item;
    list.appendChild(row);
  }
  return list;
}

export function errorPane(content) {
  const pre = document.createElement("pre");
  pre.className = "tool-error";
  pre.textContent = stringifyContent(content) || "(error)";
  return pre;
}

// Append a node to a transcript, removing the empty-state placeholder if
// present, and auto-scrolling to the bottom.
export function appendToTranscript(transcript, node) {
  const empty = transcript.querySelector(".empty-state");
  if (empty) empty.remove();
  transcript.appendChild(node);
  transcript.scrollTop = transcript.scrollHeight;
  return node;
}
