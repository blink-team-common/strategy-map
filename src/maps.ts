/**
 * マップの保存API（D1）。
 *
 *   GET    /api/maps                         一覧（name, title, version, updated_at, updated_by）
 *   GET    /api/maps/:name                   最新版 { name, version, updated_at, updated_by, map }
 *   PUT    /api/maps/:name                   保存 { map, baseVersion }（楽観ロック。新規は baseVersion=0）
 *                                            ?force=1 で競合を無視して上書き（スクリプト用）
 *   DELETE /api/maps/:name?version=N         削除（履歴には残る）
 *   GET    /api/maps/:name/versions          履歴一覧
 *   GET    /api/maps/:name/versions/:v       履歴の特定版
 *
 * 競合: 他の人が先に保存していたら 409 と最新の version / updated_by を返す（上書きはしない）。
 */

import type { Env, User } from "./config";
import { apiError, json } from "./http";

const MAX_BYTES = 1_000_000;
const KINDS = new Set(["start", "task", "milestone", "goal"]);

/** マップ名: 1〜120文字。制御文字・スラッシュ・バックスラッシュ禁止、先頭ドット禁止。 */
export function validName(name: string): boolean {
  return name.length >= 1 && name.length <= 120 && !/[\u0000-\u001f\u007f/\\]/.test(name) && !name.startsWith(".");
}

/** 形の検証（最低限）。壊れたデータを保存させない。 */
export function validateMap(m: any): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "map はオブジェクトである必要があります";
  if (!Array.isArray(m.nodes)) return "nodes は配列である必要があります";
  if (!Array.isArray(m.edges)) return "edges は配列である必要があります";
  if (m.nodes.length > 2000 || m.edges.length > 5000) return "ノード/矢印が多すぎます";
  const ids = new Set<string>();
  for (const n of m.nodes) {
    if (!n || typeof n.id !== "string" || !n.id) return "ノードに id がありません";
    if (ids.has(n.id)) return `ノードIDが重複しています: ${n.id}`;
    ids.add(n.id);
    if (n.kind !== undefined && !KINDS.has(n.kind)) return `kind が不正です: ${n.id}`;
    if (n.jira !== undefined && n.jira !== "" && !/^[A-Z][A-Z0-9_]+-\d+$/.test(String(n.jira))) return `Jiraキーの形式が不正です: ${n.jira}`;
  }
  for (const e of m.edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) return "存在しないノードを指す矢印があります";
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function handleMaps(req: Request, env: Env, user: User, parts: string[]): Promise<Response> {
  // parts: ["maps", name?, "versions"?, version?]
  const method = req.method;
  if (parts.length === 1) {
    if (method !== "GET") return apiError(405, "method_not_allowed", "GET のみ");
    const rs = await env.DB.prepare(
      "SELECT name, title, version, updated_at, updated_by FROM maps ORDER BY updated_at DESC",
    ).all();
    return json({ maps: rs.results });
  }

  const name = parts[1];
  if (!validName(name)) return apiError(400, "bad_name", "マップ名が不正です");

  if (parts.length === 2) {
    if (method === "GET") return getMap(env, name);
    if (method === "PUT") return putMap(req, env, user, name);
    if (method === "DELETE") return deleteMap(req, env, user, name);
    return apiError(405, "method_not_allowed", "GET / PUT / DELETE のみ");
  }

  if (parts[2] === "versions" && method === "GET") {
    if (parts.length === 3) {
      const rs = await env.DB.prepare(
        "SELECT version, updated_at, updated_by, deleted FROM map_versions WHERE name = ? ORDER BY version DESC LIMIT 200",
      )
        .bind(name)
        .all();
      return json({ name, versions: rs.results });
    }
    const v = Number(parts[3]);
    if (!Number.isInteger(v) || v < 1) return apiError(400, "bad_version", "version が不正です");
    const row = await env.DB.prepare(
      "SELECT version, json, updated_at, updated_by, deleted FROM map_versions WHERE name = ? AND version = ?",
    )
      .bind(name, v)
      .first<any>();
    if (!row) return apiError(404, "not_found", "その版はありません");
    return json({ name, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, deleted: !!row.deleted, map: JSON.parse(row.json) });
  }
  return apiError(404, "not_found", "Not found");
}

async function getMap(env: Env, name: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT version, json, updated_at, updated_by FROM maps WHERE name = ?")
    .bind(name)
    .first<any>();
  if (!row) return apiError(404, "not_found", `マップ「${name}」はありません`);
  return json({ name, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, map: JSON.parse(row.json) });
}

async function putMap(req: Request, env: Env, user: User, name: string): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BYTES) return apiError(413, "too_large", "マップが大きすぎます（1MBまで）");
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return apiError(400, "bad_json", "JSONとして読めません");
  }
  const map = body?.map;
  const problem = validateMap(map);
  if (problem) return apiError(400, "invalid_map", problem);

  const force = new URL(req.url).searchParams.get("force") === "1";
  const cur = await env.DB.prepare("SELECT version, updated_by, updated_at FROM maps WHERE name = ?").bind(name).first<any>();
  const curVersion: number = cur?.version ?? 0;
  const base = force ? curVersion : Number(body?.baseVersion);
  if (!Number.isInteger(base) || base < 0) return apiError(400, "bad_base_version", "baseVersion（整数）が必要です。新規は 0");
  if (base !== curVersion) {
    return apiError(409, "conflict", "他の人が先に保存しています", {
      currentVersion: curVersion,
      updated_by: cur?.updated_by ?? null,
      updated_at: cur?.updated_at ?? null,
    });
  }

  // 削除後に同名で作り直した場合も履歴の版番号が衝突しないよう、新規は履歴の最大版の次から始める。
  let next = curVersion + 1;
  if (curVersion === 0) {
    const h = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM map_versions WHERE name = ?").bind(name).first<any>();
    next = Number(h?.v ?? 0) + 1;
  }
  const at = nowIso();
  const title = typeof map.title === "string" ? map.title.slice(0, 200) : "";
  const doc = JSON.stringify(map);

  // 条件付き書き込み＋履歴を1トランザクション（D1 batch）で。
  // 競合（同時保存）時は1文目が0件になり、2文目も対象行が無いので何も入らない。
  const write =
    curVersion === 0
      ? env.DB.prepare(
          "INSERT INTO maps (name, title, json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING",
        ).bind(name, title, doc, next, at, user.email)
      : env.DB.prepare(
          "UPDATE maps SET title = ?, json = ?, version = ?, updated_at = ?, updated_by = ? WHERE name = ? AND version = ?",
        ).bind(title, doc, next, at, user.email, name, curVersion);
  const hist = env.DB.prepare(
    "INSERT OR IGNORE INTO map_versions (name, version, json, updated_at, updated_by, deleted) SELECT name, version, json, updated_at, updated_by, 0 FROM maps WHERE name = ? AND version = ? AND updated_at = ?",
  ).bind(name, next, at);
  const [w] = await env.DB.batch([write, hist]);
  if (!w.meta.changes) {
    const now = await env.DB.prepare("SELECT version, updated_by, updated_at FROM maps WHERE name = ?").bind(name).first<any>();
    return apiError(409, "conflict", "他の人が先に保存しています", {
      currentVersion: now?.version ?? 0,
      updated_by: now?.updated_by ?? null,
      updated_at: now?.updated_at ?? null,
    });
  }
  return json({ name, version: next, updated_at: at, updated_by: user.email }, curVersion === 0 ? 201 : 200);
}

async function deleteMap(req: Request, env: Env, user: User, name: string): Promise<Response> {
  const v = Number(new URL(req.url).searchParams.get("version"));
  if (!Number.isInteger(v) || v < 1) return apiError(400, "bad_version", "?version=現在の版 が必要です");
  const at = nowIso();
  const [hist, del] = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO map_versions (name, version, json, updated_at, updated_by, deleted) SELECT name, version + 1, json, ?, ?, 1 FROM maps WHERE name = ? AND version = ?",
    ).bind(at, user.email, name, v),
    env.DB.prepare("DELETE FROM maps WHERE name = ? AND version = ?").bind(name, v),
  ]);
  if (!del.meta.changes) return apiError(409, "conflict", "版が一致しないか、マップがありません");
  return json({ name, deleted: true, history: !!hist.meta.changes });
}
