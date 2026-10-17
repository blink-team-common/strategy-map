/**
 * Jira 連携: ノードに書いた課題キーの状態をまとめて返す。
 *
 *   POST /api/jira/issues  { keys: ["MEDS-21", "BLK-1", ...] }
 *   → { issues: { "MEDS-21": { summary, status, category, assignee, duedate, resolutiondate,
 *                               issuetype, url, children: { total, done } }, ... },
 *       missing: ["XXX-999"], fetchedAt }
 *
 * - 課題本体は bulkfetch（存在しないキーがあっても他は返る）、子課題の進捗は JQL `parent in (...)`。
 * - Workers 無料プランのサブリクエスト上限（50/リクエスト）に収まるよう、1回の呼び出しは
 *   bulkfetch 1回 ＋ 子課題検索 最大5ページ。
 * - 認証は MCPハブと同じ Basic（ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN）。読み取りのみ。
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
  issuetype: string | null;
  url: string;
  children: { total: number; done: number };
}

// isolate 内の短期キャッシュ（同じキー集合の連続リクエストで Jira を叩きすぎない）
const cache = new Map<string, { at: number; body: unknown }>();

function base(env: Env): string {
  return (env.ATLASSIAN_BASE_URL ?? "").replace(/\/+$/, "");
}

async function atl(env: Env, path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(base(env) + path, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.ATLASSIAN_EMAIL}:${env.ATLASSIAN_API_TOKEN}`),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export async function handleJira(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts[1] !== "issues" || parts.length !== 2) return apiError(404, "not_found", "Not found");
  if (req.method !== "POST") return apiError(405, "method_not_allowed", "POST のみ");
  if (!base(env) || !env.ATLASSIAN_EMAIL || !env.ATLASSIAN_API_TOKEN) {
    return apiError(503, "jira_not_configured", "Jira連携が未設定です（ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN）");
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "bad_json", "JSONとして読めません");
  }
  const raw: unknown[] = Array.isArray(body?.keys) ? body.keys : [];
  const keys = [...new Set(raw.map((k) => String(k).trim().toUpperCase()).filter((k) => KEY_RE.test(k)))].sort();
  if (!keys.length) return json({ issues: {}, missing: [], fetchedAt: new Date().toISOString() });
  if (keys.length > MAX_KEYS) return apiError(400, "too_many_keys", `キーは${MAX_KEYS}件までです`);

  const ck = keys.join(",");
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS && body?.refresh !== true) return json(hit.body);

  // 1) 課題本体
  const r = await atl(env, "/rest/api/3/issue/bulkfetch", {
    issueIdsOrKeys: keys,
    fields: ["summary", "status", "assignee", "duedate", "resolutiondate", "issuetype"],
  });
  if (!r.ok) return jiraFailure(r);

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
      issuetype: f.issuetype?.name ?? null,
      url: `${base(env)}/browse/${i.key}`,
      children: { total: 0, done: 0 },
    };
  }
  // 課題がプロジェクト移動でキーが変わった場合、Jira は新しいキーで返すため、依頼キー側は missing 扱いになる。
  const found = Object.keys(issues);
  const missing = keys.filter((k) => !issues[k]);

  // 2) 子課題の進捗（エピック配下・サブタスク）
  if (found.length) {
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const s = await atl(env, "/rest/api/3/search/jql", {
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

  const out = { issues, missing, fetchedAt: new Date().toISOString() };
  cache.set(ck, { at: Date.now(), body: out });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return json(out);
}

function jiraFailure(r: { status: number; data: any }): Response {
  const detail = (r.data?.errorMessages as string[] | undefined)?.join(" / ") ?? "";
  if (r.status === 401 || r.status === 403) {
    return apiError(502, "jira_auth_failed", `Jiraの認証に失敗しました（${r.status}）。APIトークンを確認してください。${detail}`);
  }
  return apiError(502, "jira_error", `Jiraの取得に失敗しました（${r.status}）。${detail}`);
}
