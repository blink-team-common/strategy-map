/**
 * 戦略マップ Worker のエントリ。
 *
 *   /auth/*     Google Workspace SSO（auth.ts）
 *   /healthz    死活監視（認証なし）
 *   /api/me     ログイン中のユーザー
 *   /api/maps/* マップの保存・履歴（maps.ts / D1）
 *   /api/jira/* Jira 課題の状態取得（jira.ts）
 *   それ以外     画面（public/ の静的ファイル）。未ログインならログインへリダイレクト
 *
 * 画面もAPIもすべてログイン必須（静的ファイルも run_worker_first で必ずここを通る）。
 */

import type { Env, User } from "./config";
import { currentUser, handleAuth } from "./auth";
import { apiError, json, redirect, SECURITY_HEADERS } from "./http";
import { handleMaps } from "./maps";
import { handleJira } from "./jira";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");
    if (path.startsWith("/auth/")) return handleAuth(req, env);

    const user = await currentUser(req, env);

    if (path.startsWith("/api/")) {
      if (!user) return apiError(401, "unauthorized", "ログインが必要です", { login: "/auth/login" });
      if (!sameOriginForWrite(req, url, user)) return apiError(403, "bad_origin", "不正なオリジンからのリクエストです");
      try {
        return await routeApi(req, env, user, path);
      } catch (e) {
        console.error("api error", path, e);
        return apiError(500, "internal_error", "サーバーでエラーが発生しました");
      }
    }

    if (!user) {
      if (req.method === "GET" || req.method === "HEAD") {
        return redirect(`/auth/login?return=${encodeURIComponent(path + url.search)}`);
      }
      return new Response("Unauthorized", { status: 401 });
    }
    return serveAsset(req, env);
  },
} satisfies ExportedHandler<Env>;

async function routeApi(req: Request, env: Env, user: User, path: string): Promise<Response> {
  const parts = path
    .slice("/api/".length)
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  switch (parts[0]) {
    case "me":
      return json({ email: user.email, name: user.name, picture: user.picture ?? null, via: user.via });
    case "maps":
      return handleMaps(req, env, user, parts);
    case "jira":
      return handleJira(req, env, parts);
    default:
      return apiError(404, "not_found", "Not found");
  }
}

/**
 * CSRF 対策: Cookie で認証した書き込み系リクエストは、同一オリジンからの fetch に限る。
 * （SameSite=Lax でも防げるが、Origin でも二重に確認する。APIキー経由はブラウザ外なので対象外）
 */
function sameOriginForWrite(req: Request, url: URL, user: User): boolean {
  if (req.method === "GET" || req.method === "HEAD" || user.via === "api-key") return true;
  const origin = req.headers.get("origin");
  return origin === url.origin;
}

async function serveAsset(req: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  // 認証の後ろにあるページなので共有キャッシュに載せない
  out.headers.set("Cache-Control", "private, no-cache");
  return out;
}
