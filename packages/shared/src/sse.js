// SSE stream reader. Takes a fetch Response whose body is text/event-stream
// and dispatches each event frame to onMessage (data) or onError (parse
// failure or `event: error` frames). The caller owns the AbortController
// passed to fetch — cancellation is just an aborted body that exits the
// read loop normally.
//
// Server SSE shape (see src/server.ts handleChat):
//   event: message    + JSON-serialized SDK message
//   event: error      + JSON { message: string }

export async function streamSse(response, { onMessage, onError } = {}) {
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
      handleSseFrame(rawEvent, onMessage, onError);
    }
  }
}

function handleSseFrame(frame, onMessage, onError) {
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
  }
  if (!data) return;
  let parsed;
  try { parsed = JSON.parse(data); }
  catch { onError?.({ kind: "parse", raw: data }); return; }
  if (event === "message") onMessage?.(parsed);
  else if (event === "error") onError?.({ kind: "server", payload: parsed });
}
