/**
 * 環境変数（wrangler.jsonc の vars ＋ wrangler secret put で登録するシークレット）。
 */
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;

  // --- vars（非機密） ---
  ALLOWED_DOMAIN: string;
  ATLASSIAN_BASE_URL?: string;
  SESSION_HOURS?: string;

  // --- secrets ---
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  ATLASSIAN_EMAIL?: string;
  ATLASSIAN_API_TOKEN?: string;
  API_KEY?: string;

  // --- ローカル開発専用（.dev.vars のみ。本番に登録しない） ---
  DEV_USER_EMAIL?: string;
}

/** ログイン中のユーザー（またはAPIキー経由のクライアント）。 */
export interface User {
  email: string;
  name: string;
  picture?: string;
  /** "google" = SSO のブラウザセッション / "api-key" = スクリプト・Claude / "dev" = ローカル開発 */
  via: "google" | "api-key" | "dev";
}

export function sessionHours(env: Env): number {
  const n = Number(env.SESSION_HOURS);
  return Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : 12;
}
