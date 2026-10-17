/**
 * 署名付きトークン（HMAC-SHA256・JWT互換の compact 形式）と小物。
 * セッションCookieと OAuth の一時Cookie（state / PKCE verifier / nonce）に使う。
 * サーバーは状態を持たない（KV / D1 にセッションを置かない）。
 */

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
  const bin = atob(b + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlJson(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)));
}

export function decodeJsonSegment<T = any>(seg: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(seg)));
}

export function randomToken(bytes = 32): string {
  const u8 = new Uint8Array(bytes);
  crypto.getRandomValues(u8);
  return b64url(u8);
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** 定数時間比較（長さ差も畳み込む）。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ba.length ^ bb.length;
  const len = Math.max(ba.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** payload に exp（UNIX秒）を入れて署名する。typ でトークンの用途を区別する。 */
export async function signToken(secret: string, typ: string, payload: Record<string, unknown>): Promise<string> {
  const head = b64urlJson({ alg: "HS256", typ });
  const body = b64urlJson(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

/** 署名・用途・期限を検証して payload を返す。不正なら null。 */
export async function verifyToken<T extends { exp: number }>(
  secret: string,
  typ: string,
  token: string | null | undefined,
): Promise<T | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(sig),
      enc.encode(`${head}.${body}`),
    );
    if (!ok) return null;
    const h = decodeJsonSegment(head);
    if (h?.alg !== "HS256" || h?.typ !== typ) return null;
    const p = decodeJsonSegment<T>(body);
    if (typeof p?.exp !== "number" || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}
