// SSE stream reader. Takes a fetch Response whose body is text/event-stream
// and dispatches each event frame to onMessage (data) or onError (parse
// failure or `event: error` frames). The caller owns the AbortController
// passed to fetch — cancellation is just an aborted body that exits the
// read loop normally.
//
// Server SSE shape (see src/server.ts handleChat):
//   id: <seq>          (monotonic per-message sequence — used as the
//                       reattach cursor on visibility-resume / dropped
//                       streams; see streamReattach in hub/src/client.js)
//   event: open | message | error | end
//   data: <JSON>
//
// `event: open` fires once on attach if the server-side broker is alive
// (no payload). attemptResume uses it to flip the UI to "streaming"
// without waiting for the first message frame — important for turns
// that pause mid-stream (tool calls, thinking).
//
// onMessage receives (parsed, meta) where meta.id is the seq number (or
// null if the frame had no id field). onEnd is called when an `event: end`
// frame arrives so the client knows the turn finished cleanly vs. the
// stream just being interrupted.

export async function streamSse(response, { onMessage, onError, onEnd, onOpen } = {}) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      handleSseFrame(rawEvent, onMessage, onError, onEnd, onOpen);
    }
  }
}

function handleSseFrame(frame, onMessage, onError, onEnd, onOpen) {
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  let id = null;
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) id = n;
    }
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
  }
  if (event === "open") { onOpen?.(); return; }
  if (event === "end") { onEnd?.(); return; }
  if (!data) return;
  let parsed;
  try { parsed = JSON.parse(data); }
  catch { onError?.({ kind: "parse", raw: data }); return; }
  if (event === "message") onMessage?.(parsed, { id });
  else if (event === "error") onError?.({ kind: "server", payload: parsed });
}
