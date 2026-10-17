/** レスポンス・Cookie の小物。 */

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

export function apiError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, status);
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ Location: location, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
}

export function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setCookie(
  url: URL,
  name: string,
  value: string,
  opts: { maxAge: number; path?: string; sameSite?: "Lax" | "Strict" },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
    "HttpOnly",
    `SameSite=${opts.sameSite ?? "Lax"}`,
  ];
  // localhost（wrangler dev）は http なので Secure を付けない。本番(https)は必ず Secure。
  if (url.protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(url: URL, name: string, path = "/"): string {
  return setCookie(url, name, "", { maxAge: 0, path });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
