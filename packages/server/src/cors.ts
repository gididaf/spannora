import http from "node:http";

// Allowed origins are an explicit, env-pinned, comma-separated list. Empty
// env (the default) ⇒ no CORS headers are emitted at all and cross-origin
// requests just fail the way they always have. The hub PWA needs the
// operator to opt in by setting e.g.
//   SPANNORA_ALLOWED_ORIGINS=https://gididaf.github.io
// in the systemd unit's Environment=, or
//   SPANNORA_ALLOWED_ORIGINS=https://gididaf.github.io,http://localhost:5173
// for local dev against a locally-served hub.
//
// Exact match. No wildcards, no subdomain magic.
const ALLOWED = (process.env.SPANNORA_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * If the request's Origin is in the allowlist, set the response CORS
 * headers and (for preflight OPTIONS) write 204 and return handled:true.
 * Otherwise no-op — the route handler proceeds as normal and emits no
 * CORS headers, so same-origin behavior is unchanged.
 *
 * Credentials are NEVER allowed cross-origin (no cookies). The hub PWA
 * authenticates with `Authorization: Bearer <token>` instead.
 */
export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): { handled: boolean } {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !ALLOWED.includes(origin)) {
    return { handled: false };
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "false");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204).end();
    return { handled: true };
  }
  return { handled: false };
}
