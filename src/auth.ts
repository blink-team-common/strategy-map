/**
 * Google Workspace SSO（OpenID Connect / Authorization Code + PKCE）とセッション。
 *
 * 流れ:
 *   GET /auth/login     → state / nonce / PKCE verifier を署名Cookieに入れて Google へリダイレクト
 *   GET /auth/callback  → state 照合 → code をトークンエンドポイントで交換 → id_token のクレーム検証
 *                         → 署名付きセッションCookie（HttpOnly）を発行
 *   GET /auth/logout    → セッションCookieを消す
 *
 * ドメイン制限は二重:
 *   1) GCP の OAuth 同意画面を「内部（Internal）」にする → Workspace 外のアカウントは Google 側で拒否
 *   2) ここで id_token の hd と email のドメインが ALLOWED_DOMAIN であることを検証
 *
 * id_token の署名検証について: id_token は client_secret 付きのトークンエンドポイント呼び出し（TLS）で
 * Google から直接受け取るため、OIDC Core 3.1.3.7 に従い署名検証の代わりに TLS のサーバー認証に依拠する。
 * iss / aud / exp / nonce / hd / email_verified は必ず検証する。
 */

import { sessionHours, type Env, type User } from "./config";
import { decodeJsonSegment, randomToken, sha256b64url, signToken, timingSafeEqual, verifyToken } from "./crypto";
import { clearCookie, escapeHtml, getCookie, html, redirect, setCookie } from "./http";

const SESSION_COOKIE = "sm_session";
const OAUTH_COOKIE = "sm_oauth";
const OAUTH_COOKIE_PATH = "/auth/";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

interface SessionPayload {
  email: string;
  name: string;
  picture?: string;
  exp: number;
}

interface OAuthPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/** ログイン後の戻り先は同一オリジンの相対パスに限る（オープンリダイレクト防止）。 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith("/auth/")) return "/";
  return raw;
}

function missingConfig(env: Env): string[] {
  const miss: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) miss.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) miss.push("GOOGLE_CLIENT_SECRET");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) miss.push("SESSION_SECRET(32文字以上)");
  if (!env.ALLOWED_DOMAIN) miss.push("ALLOWED_DOMAIN");
  return miss;
}

/** リクエストのユーザーを特定する。未ログインなら null。 */
export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const url = new URL(req.url);

  // 1) スクリプト / Claude 用の APIキー（API_KEY 未設定なら無効＝fail-closed）
  const key = req.headers.get("x-api-key");
  if (key !== null) {
    if (env.API_KEY && env.API_KEY.length >= 16 && timingSafeEqual(key, env.API_KEY)) {
      return { email: "api-key", name: "APIキー", via: "api-key" };
    }
    return null;
  }

  // 2) ローカル開発の省略ログイン（localhost のときだけ）
  if (env.DEV_USER_EMAIL && isLocalhost(url)) {
    return { email: env.DEV_USER_EMAIL, name: env.DEV_USER_EMAIL.split("@")[0], via: "dev" };
  }

  // 3) SSO セッションCookie
  if (!env.SESSION_SECRET) return null;
  const p = await verifyToken<SessionPayload>(env.SESSION_SECRET, "sm-session", getCookie(req, SESSION_COOKIE));
  if (!p || !emailInDomain(p.email, env.ALLOWED_DOMAIN)) return null;
  return { email: p.email, name: p.name, picture: p.picture, via: "google" };
}

function emailInDomain(email: unknown, domain: string): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith("@" + domain.toLowerCase());
}

export async function handleAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  switch (url.pathname) {
    case "/auth/login":
      return login(req, env, url);
    case "/auth/callback":
      return callback(req, env, url);
    case "/auth/logout":
      return redirect("/auth/signed-out", [clearCookie(url, SESSION_COOKIE)]);
    case "/auth/signed-out":
      return page("ログアウトしました", `<p>戦略マップからログアウトしました。</p><p><a class="btn" href="/auth/login">もう一度ログイン</a></p>`);
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function login(req: Request, env: Env, url: URL): Promise<Response> {
  const miss = missingConfig(env);
  if (miss.length) {
    return page("SSOが未設定です", `<p>次のシークレットを登録してください: <code>${escapeHtml(miss.join(", "))}</code></p>`, 500);
  }
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const returnTo = safeReturnTo(url.searchParams.get("return"));
  const tmp = await signToken(env.SESSION_SECRET!, "sm-oauth", {
    state,
    nonce,
    verifier,
    returnTo,
    exp: Math.floor(Date.now() / 1000) + 600,
  } satisfies OAuthPayload);

  const auth = new URL(GOOGLE_AUTH);
  auth.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  auth.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("nonce", nonce);
  auth.searchParams.set("code_challenge", await sha256b64url(verifier));
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("hd", env.ALLOWED_DOMAIN); // アカウント選択を社内ドメインに寄せる（検証は callback で行う）
  auth.searchParams.set("prompt", "select_account");

  return redirect(auth.toString(), [setCookie(url, OAUTH_COOKIE, tmp, { maxAge: 600, path: OAUTH_COOKIE_PATH })]);
}

async function callback(req: Request, env: Env, url: URL): Promise<Response> {
  const miss = missingConfig(env);
  if (miss.length) return page("SSOが未設定です", `<p>${escapeHtml(miss.join(", "))}</p>`, 500);
  const clearTmp = clearCookie(url, OAUTH_COOKIE, OAUTH_COOKIE_PATH);

  const err = url.searchParams.get("error");
  if (err) return deny(`Googleでのログインが完了しませんでした（${err}）。`, clearTmp);

  const tmp = await verifyToken<OAuthPayload>(env.SESSION_SECRET!, "sm-oauth", getCookie(req, OAUTH_COOKIE));
  const state = url.searchParams.get("state") ?? "";
  if (!tmp || !timingSafeEqual(state, tmp.state)) {
    return deny("ログインの有効期限が切れたか、不正なリクエストです。もう一度お試しください。", clearTmp);
  }
  const code = url.searchParams.get("code");
  if (!code) return deny("認可コードがありません。", clearTmp);

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
      code_verifier: tmp.verifier,
    }),
  });
  const tok: any = await res.json().catch(() => null);
  if (!res.ok || typeof tok?.id_token !== "string") {
    return deny(`Googleとのトークン交換に失敗しました（${escapeHtml(String(tok?.error ?? res.status))}）。`, clearTmp);
  }

  let claims: any;
  try {
    claims = decodeJsonSegment(tok.id_token.split(".")[1]);
  } catch {
    return deny("id_token を読み取れませんでした。", clearTmp);
  }
  const now = Math.floor(Date.now() / 1000);
  const domain = env.ALLOWED_DOMAIN.toLowerCase();
  const problems: string[] = [];
  if (!GOOGLE_ISSUERS.has(claims?.iss)) problems.push("iss");
  if (claims?.aud !== env.GOOGLE_CLIENT_ID) problems.push("aud");
  if (typeof claims?.exp !== "number" || claims.exp < now) problems.push("exp");
  if (claims?.nonce !== tmp.nonce) problems.push("nonce");
  if (problems.length) return deny(`id_token の検証に失敗しました（${problems.join(", ")}）。`, clearTmp);

  if (claims.email_verified !== true || String(claims.hd ?? "").toLowerCase() !== domain || !emailInDomain(claims.email, domain)) {
    return deny(
      `このツールは <b>@${escapeHtml(domain)}</b> のアカウントでのみ利用できます（${escapeHtml(String(claims.email ?? "不明"))}）。`,
      clearTmp,
    );
  }

  const session = await signToken(env.SESSION_SECRET!, "sm-session", {
    email: String(claims.email).toLowerCase(),
    name: String(claims.name ?? claims.email),
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
    exp: now + Math.round(sessionHours(env) * 3600),
  } satisfies SessionPayload);

  return redirect(safeReturnTo(tmp.returnTo), [
    clearTmp,
    setCookie(url, SESSION_COOKIE, session, { maxAge: sessionHours(env) * 3600 }),
  ]);
}

function deny(message: string, clearTmp: string): Response {
  const r = page("ログインできませんでした", `<p>${message}</p><p><a class="btn" href="/auth/login">別のアカウントでログイン</a></p>`, 403);
  r.headers.append("Set-Cookie", clearTmp);
  return r;
}

function page(title: string, body: string, status = 200): Response {
  return html(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — 戦略マップ</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1420;color:#e7ecf5;
       font-family:-apple-system,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif}
  main{max-width:440px;padding:28px 30px;background:#161d2e;border:1px solid #2b3654;border-radius:14px}
  h1{font-size:18px;margin:0 0 12px} p{line-height:1.7;color:#cdd6ea} code{color:#f2b21a}
  .btn{display:inline-block;margin-top:6px;padding:9px 16px;border-radius:9px;background:#4c7dff;color:#fff;text-decoration:none}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    status,
  );
}
