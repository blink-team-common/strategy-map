/**
 * マップの HTTP API（D1）。処理本体は store.ts。
 *
 *   GET    /api/maps                         一覧
 *   GET    /api/maps/:name                   最新版 { name, version, updated_at, updated_by, map }
 *   GET    /api/maps/:name/head              版番号と未処理の提案数だけ（画面の更新チェック用）
 *   PUT    /api/maps/:name                   保存 { map, baseVersion }（楽観ロック。新規は 0。?force=1 で最新に上書き）
 *   POST   /api/maps/:name/ops               操作単位の編集 { ops, note? }（最新版に当てる）
 *   DELETE /api/maps/:name?version=N         削除（履歴には残る）
 *   GET    /api/maps/:name/versions          履歴一覧
 *   GET    /api/maps/:name/versions/:v       履歴の特定版
 *   GET    /api/maps/:name/proposals         提案一覧（?status=open|approved|rejected|all）
 *   POST   /api/maps/:name/proposals         提案を登録 { ops, summary }（マップは変えない）
 *   POST   /api/proposals/:id/approve        提案を承認して反映（ログインした人のみ）
 *   POST   /api/proposals/:id/reject         提案を却下（ログインした人のみ） { reason? }
 *   GET    /api/check                        点検レポート（?maps=a.json,b.json で絞り込み）
 */

import type { Env, User } from "./config";
import { runCheck } from "./check";
import { apiError, json } from "./http";
import {
  createProposal,
  decideProposal,
  deleteMap,
  editMap,
  getHead,
  getMap,
  getVersion,
  listMaps,
  listProposals,
  listVersions,
  saveMap,
  validName,
  type SaveResult,
} from "./store";

const MAX_BYTES = 1_000_000;

async function readJson(req: Request): Promise<{ body?: any; error?: Response }> {
  const text = await req.text();
  if (text.length > MAX_BYTES) return { error: apiError(413, "too_large", "大きすぎます（1MBまで）") };
  try {
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: apiError(400, "bad_json", "JSONとして読めません") };
  }
}

function saveResponse(r: SaveResult & { changes?: string[] }): Response {
  if (r.ok) {
    const { ok: _ok, created, ...rest } = r;
    return json(rest, created ? 201 : 200);
  }
  const status = r.code === "conflict" ? 409 : r.code === "not_found" ? 404 : 400;
  const { ok: _ok, code, message, ...rest } = r as any;
  return apiError(status, code, message, rest);
}

export async function handleMaps(req: Request, env: Env, user: User, parts: string[]): Promise<Response> {
  // parts: ["maps", name?, sub?, arg?]
  const method = req.method;
  if (parts.length === 1) {
    if (method !== "GET") return apiError(405, "method_not_allowed", "GET のみ");
    return json({ maps: await listMaps(env) });
  }

  const name = parts[1];
  if (!validName(name)) return apiError(400, "bad_name", "マップ名が不正です");
  const sub = parts[2];

  if (!sub) {
    if (method === "GET") {
      const rec = await getMap(env, name);
      return rec ? json(rec) : apiError(404, "not_found", `マップ「${name}」はありません`);
    }
    if (method === "PUT") {
      const { body, error } = await readJson(req);
      if (error) return error;
      const force = new URL(req.url).searchParams.get("force") === "1";
      let base = Number(body?.baseVersion);
      if (force) base = (await getHead(env, name))?.version ?? 0;
      return saveResponse(await saveMap(env, name, body?.map, base, user.email, typeof body?.note === "string" ? body.note : ""));
    }
    if (method === "DELETE") {
      const v = Number(new URL(req.url).searchParams.get("version"));
      if (!Number.isInteger(v) || v < 1) return apiError(400, "bad_version", "?version=現在の版 が必要です");
      const r = await deleteMap(env, name, v, user.email);
      if (!r.deleted) return apiError(409, "conflict", "版が一致しないか、マップがありません");
      return json({ name, ...r });
    }
    return apiError(405, "method_not_allowed", "GET / PUT / DELETE のみ");
  }

  if (sub === "head" && method === "GET") {
    const h = await getHead(env, name);
    return h ? json({ name, ...h }) : apiError(404, "not_found", `マップ「${name}」はありません`);
  }

  if (sub === "ops" && method === "POST") {
    const { body, error } = await readJson(req);
    if (error) return error;
    return saveResponse(await editMap(env, name, body?.ops, user.email, typeof body?.note === "string" ? body.note : ""));
  }

  if (sub === "versions" && method === "GET") {
    if (parts.length === 3) return json({ name, versions: await listVersions(env, name) });
    const v = Number(parts[3]);
    if (!Number.isInteger(v) || v < 1) return apiError(400, "bad_version", "version が不正です");
    const rec = await getVersion(env, name, v);
    return rec ? json(rec) : apiError(404, "not_found", "その版はありません");
  }

  if (sub === "proposals") {
    if (method === "GET") {
      const status = new URL(req.url).searchParams.get("status") ?? "open";
      return json({ name, proposals: await listProposals(env, name, status) });
    }
    if (method === "POST") {
      const { body, error } = await readJson(req);
      if (error) return error;
      const summary = typeof body?.summary === "string" ? body.summary.trim() : "";
      if (!summary) return apiError(400, "bad_summary", "summary（提案の理由）が必要です");
      const r = await createProposal(env, name, body?.ops, summary, user.email);
      if (!r.ok) return apiError(r.code === "not_found" ? 404 : 400, r.code, r.message);
      const { ok: _ok, ...rest } = r;
      return json(rest, 201);
    }
  }
  return apiError(404, "not_found", "Not found");
}

/** /api/proposals/:id/(approve|reject) — 承認・却下は人だけ（APIキー不可） */
export async function handleProposalDecision(req: Request, env: Env, user: User, parts: string[]): Promise<Response> {
  if (req.method !== "POST" || parts.length !== 3 || !["approve", "reject"].includes(parts[2])) return apiError(404, "not_found", "Not found");
  if (user.via === "api-key") return apiError(403, "human_only", "提案の承認・却下は、ログインした人が画面から行います");
  const { body, error } = await readJson(req);
  if (error) return error;
  const r = await decideProposal(env, parts[1], parts[2] === "approve", user.email, typeof body?.reason === "string" ? body.reason : "");
  if (!r.ok) return apiError(r.code === "not_found" ? 404 : 409, r.code, r.message);
  const { ok: _ok, ...rest } = r;
  return json(rest);
}

export async function handleCheck(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const names = (url.searchParams.get("maps") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return json(await runCheck(env, names, url.origin));
}
