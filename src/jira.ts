/**
 * Jira 連携（読み取りのみ）: ノードに書いた課題キーの状態をまとめて取る。
 *
 *   POST /api/jira/issues  { keys: ["MEDS-21", ...], refresh?: true }
 *   → { issues: { "MEDS-21": JiraIssueInfo }, missing: [...], fetchedAt }
 *
 * マップが正典。Jira の値はマップを書き換えず、画面の参考表示と点検（check.ts）にだけ使う。
 *
 * - 課題本体は bulkfetch（存在しないキーがあっても他は返る）、子課題の進捗は JQL `parent in (...)`。
 * - Workers 無料プランのサブリクエスト上限（50/リクエスト）に収まるよう、1回の呼び出しは
 *   bulkfetch 1回 ＋ 子課題検索 最大5ページ ＋（全件見つからない時だけ）認証確認 1回。
 * - Jira Cloud は認証に失敗しても 200 で「何も見えない」結果を返すことがあるため、
 *   X-Seraph-LoginReason ヘッダーと /myself で認証失敗を見分ける。
 */

import type { Env } from "./config";
import { apiError, json } from "./http";

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_KEYS = 100;
const TTL_MS = 60_000;

export interface JiraIssueInfo {
  key: string;
  summary: string;
  status: string;
  /** Jira の statusCategory.key: "new" | "indeterminate" | "done" */
  category: string;
  assignee: string | null;
  duedate: string | null;
  resolutiondate: string | null;
  /** 最終更新日時（停滞の判定に使う） */
  updated: string | null;
  issuetype: string | null;
  url: string;
  children: { total: number; done: number };
}
export type JiraResult =
  | { ok: true; issues: Record<string, JiraIssueInfo>; missing: string[]; fetchedAt: string }
  | { ok: false; status: number; code: "jira_not_configured" | "jira_auth_failed" | "jira_error" | "too_many_keys"; message: string };

// isolate 内の短期キャッシュ（同じキー集合の連続リクエストで Jira を叩きすぎない）
const cache = new Map<string, { at: number; body: JiraResult }>();

function base(env: Env): string {
  return (env.ATLASSIAN_BASE_URL ?? "").replace(/\/+$/, "");
}
function authHeader(env: Env): string {
  return "Basic " + btoa(`${env.ATLASSIAN_EMAIL}:${env.ATLASSIAN_API_TOKEN}`);
}

async function atl(env: Env, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(base(env) + path, {
    method,
    headers: {
      Authorization: authHeader(env),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => null);
  const login = res.headers.get("x-seraph-loginreason") ?? "";
  return { ok: res.ok, status: res.status, data, authFailed: /AUTHENTICAT(ED|ION)_(FAILED|DENIED)/.test(login) };
}

const AUTH_MSG =
  "Jiraの認証に失敗しました。Worker のシークレット ATLASSIAN_EMAIL（トークンを作ったアカウントのメール）と ATLASSIAN_API_TOKEN（スコープなしのAPIトークン）を確認してください。";

export function normalizeKeys(raw: unknown[]): string[] {
  return [...new Set(raw.map((k) => String(k).trim().toUpperCase()).filter((k) => KEY_RE.test(k)))].sort();
}

export async function fetchJira(env: Env, rawKeys: unknown[], refresh = false): Promise<JiraResult> {
  if (!base(env) || !env.ATLASSIAN_EMAIL || !env.ATLASSIAN_API_TOKEN) {
    return { ok: false, status: 503, code: "jira_not_configured", message: "Jira連携が未設定です（ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN）" };
  }
  const keys = normalizeKeys(rawKeys);
  const fetchedAt = new Date().toISOString();
  if (!keys.length) return { ok: true, issues: {}, missing: [], fetchedAt };
  if (keys.length > MAX_KEYS) return { ok: false, status: 400, code: "too_many_keys", message: `キーは${MAX_KEYS}件までです` };

  const ck = keys.join(",");
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS && !refresh) return hit.body;

  // 1) 課題本体
  const r = await atl(env, "POST", "/rest/api/3/issue/bulkfetch", {
    issueIdsOrKeys: keys,
    fields: ["summary", "status", "assignee", "duedate", "resolutiondate", "updated", "issuetype"],
  });
  if (r.status === 401 || r.status === 403 || r.authFailed) return { ok: false, status: 502, code: "jira_auth_failed", message: AUTH_MSG };
  if (!r.ok) {
    const detail = (r.data?.errorMessages as string[] | undefined)?.join(" / ") ?? "";
    return { ok: false, status: 502, code: "jira_error", message: `Jiraの取得に失敗しました（${r.status}）。${detail}` };
  }

  const issues: Record<string, JiraIssueInfo> = {};
  for (const i of (r.data?.issues as any[]) ?? []) {
    const f = i.fields ?? {};
    issues[i.key] = {
      key: i.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      category: f.status?.statusCategory?.key ?? "",
      assignee: f.assignee?.displayName ?? null,
      duedate: f.duedate ?? null,
      resolutiondate: f.resolutiondate ?? null,
      updated: f.updated ?? null,
      issuetype: f.issuetype?.name ?? null,
      url: `${base(env)}/browse/${i.key}`,
      children: { total: 0, done: 0 },
    };
  }
  const found = Object.keys(issues);
  const missing = keys.filter((k) => !issues[k]);

  // 全件見つからない時は、認証が通っていない（匿名扱い）可能性が高いので確認する
  if (!found.length) {
    const me = await atl(env, "GET", "/rest/api/3/myself");
    if (!me.ok || me.authFailed || !me.data?.accountId) return { ok: false, status: 502, code: "jira_auth_failed", message: AUTH_MSG };
  }

  // 2) 子課題の進捗（エピック配下・サブタスク）
  if (found.length) {
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const s = await atl(env, "POST", "/rest/api/3/search/jql", {
        jql: `parent in (${found.join(",")})`,
        fields: ["status", "parent"],
        maxResults: 100,
        ...(token ? { nextPageToken: token } : {}),
      });
      if (!s.ok) break; // 進捗は付加情報。失敗しても本体は返す
      for (const c of (s.data?.issues as any[]) ?? []) {
        const pk = c.fields?.parent?.key;
        if (pk && issues[pk]) {
          issues[pk].children.total++;
          if (c.fields?.status?.statusCategory?.key === "done") issues[pk].children.done++;
        }
      }
      token = s.data?.nextPageToken;
      if (!token || s.data?.isLast) break;
    }
  }

  const out: JiraResult = { ok: true, issues, missing, fetchedAt };
  cache.set(ck, { at: Date.now(), body: out });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return out;
}

export async function handleJira(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts[1] !== "issues" || parts.length !== 2) return apiError(404, "not_found", "Not found");
  if (req.method !== "POST") return apiError(405, "method_not_allowed", "POST のみ");
  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "bad_json", "JSONとして読めません");
  }
  const r = await fetchJira(env, Array.isArray(body?.keys) ? body.keys : [], body?.refresh === true);
  if (!r.ok) return apiError(r.status, r.code, r.message);
  const { ok: _ok, ...rest } = r;
  return json(rest);
}
