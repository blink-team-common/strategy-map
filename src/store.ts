/**
 * D1 への読み書き（HTTP API と MCPハブ向け RPC の共通部分）。
 *
 * - 保存は楽観ロック（baseVersion が最新と一致したときだけ書く）。全版を map_versions に残す。
 * - ops 編集は「最新版を読む → ops を当てる → 楽観ロックで保存」を、競合したら数回やり直す。
 * - 提案（proposals）は承認されるまでマップに反映しない。承認時に、その時点の最新版へ ops を当てる。
 */

import type { Env } from "./config";
import { applyOps, lintMap, OpError, touchedIds, validateMap, type Op, type StrategyMap } from "./model";

export interface MapRecord {
  name: string;
  version: number;
  updated_at: string;
  updated_by: string;
  map: StrategyMap;
}
export type SaveResult =
  | { ok: true; name: string; version: number; updated_at: string; updated_by: string; created: boolean; warnings: string[] }
  | { ok: false; code: "conflict"; message: string; currentVersion: number; updated_by: string | null; updated_at: string | null }
  | { ok: false; code: "invalid_map" | "bad_base_version" | "invalid_ops" | "not_found"; message: string };

export function nowIso(): string {
  return new Date().toISOString();
}

/** マップ名: 1〜120文字。制御文字・スラッシュ・バックスラッシュ禁止、先頭ドット禁止。 */
export function validName(name: string): boolean {
  return typeof name === "string" && name.length >= 1 && name.length <= 120 && !/[\u0000-\u001f\u007f/\\]/.test(name) && !name.startsWith(".");
}

export async function listMaps(env: Env) {
  const rs = await env.DB.prepare("SELECT name, title, version, updated_at, updated_by FROM maps ORDER BY updated_at DESC").all();
  return rs.results as { name: string; title: string; version: number; updated_at: string; updated_by: string }[];
}

export async function getMap(env: Env, name: string): Promise<MapRecord | null> {
  const row = await env.DB.prepare("SELECT version, json, updated_at, updated_by FROM maps WHERE name = ?").bind(name).first<any>();
  if (!row) return null;
  return { name, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, map: JSON.parse(row.json) };
}

export async function getHead(env: Env, name: string) {
  const row = await env.DB.prepare("SELECT version, updated_at, updated_by FROM maps WHERE name = ?").bind(name).first<any>();
  const p = await env.DB.prepare("SELECT COUNT(*) AS c FROM proposals WHERE name = ? AND status = 'open'").bind(name).first<any>();
  return row ? { version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, openProposals: Number(p?.c ?? 0) } : null;
}

async function conflict(env: Env, name: string, message = "他の人が先に保存しています"): Promise<SaveResult> {
  const now = await env.DB.prepare("SELECT version, updated_by, updated_at FROM maps WHERE name = ?").bind(name).first<any>();
  return { ok: false, code: "conflict", message, currentVersion: now?.version ?? 0, updated_by: now?.updated_by ?? null, updated_at: now?.updated_at ?? null };
}

/** 楽観ロック付きの保存。baseVersion は新規なら 0。by は記録する更新者、note は変更内容のメモ。 */
export async function saveMap(env: Env, name: string, map: StrategyMap, baseVersion: number, by: string, note = ""): Promise<SaveResult> {
  const problem = validateMap(map);
  if (problem) return { ok: false, code: "invalid_map", message: problem };
  if (!Number.isInteger(baseVersion) || baseVersion < 0) return { ok: false, code: "bad_base_version", message: "baseVersion（整数）が必要です。新規は 0" };

  const cur = await env.DB.prepare("SELECT version FROM maps WHERE name = ?").bind(name).first<any>();
  const curVersion: number = cur?.version ?? 0;
  if (baseVersion !== curVersion) return conflict(env, name);

  // 削除後に同名で作り直した場合も履歴の版番号が衝突しないよう、新規は履歴の最大版の次から始める。
  let next = curVersion + 1;
  if (curVersion === 0) {
    const h = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM map_versions WHERE name = ?").bind(name).first<any>();
    next = Number(h?.v ?? 0) + 1;
  }
  const at = nowIso();
  const title = typeof map.title === "string" ? map.title.slice(0, 200) : "";
  const doc = JSON.stringify(map);
  const write =
    curVersion === 0
      ? env.DB.prepare(
          "INSERT INTO maps (name, title, json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING",
        ).bind(name, title, doc, next, at, by)
      : env.DB.prepare("UPDATE maps SET title = ?, json = ?, version = ?, updated_at = ?, updated_by = ? WHERE name = ? AND version = ?").bind(
          title,
          doc,
          next,
          at,
          by,
          name,
          curVersion,
        );
  // 条件付き書き込み＋履歴を1トランザクション（D1 batch）で。競合時は1文目が0件、2文目も対象行なし。
  const hist = env.DB.prepare(
    "INSERT OR IGNORE INTO map_versions (name, version, json, updated_at, updated_by, deleted, note) SELECT name, version, json, updated_at, updated_by, 0, ? FROM maps WHERE name = ? AND version = ? AND updated_at = ?",
  ).bind(note.slice(0, 4000), name, next, at);
  const [w] = await env.DB.batch([write, hist]);
  if (!w.meta.changes) return conflict(env, name);
  return { ok: true, name, version: next, updated_at: at, updated_by: by, created: curVersion === 0, warnings: lintMap(map) };
}

/** ops を最新版に当てて保存する（競合したら最新を読み直して最大3回）。 */
export async function editMap(
  env: Env,
  name: string,
  ops: Op[],
  by: string,
  note = "",
): Promise<(SaveResult & { changes?: string[] })> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await getMap(env, name);
    if (!cur) return { ok: false, code: "not_found", message: `マップ「${name}」はありません` };
    let applied;
    try {
      applied = applyOps(cur.map, ops);
    } catch (e) {
      if (e instanceof OpError) return { ok: false, code: "invalid_ops", message: e.message };
      throw e;
    }
    if (!applied.changes.length) return { ok: false, code: "invalid_ops", message: "変更がありません（すでにその状態です）" };
    const memo = [note, ...applied.changes].filter(Boolean).join("\n");
    const r = await saveMap(env, name, applied.map, cur.version, by, memo);
    if (r.ok) return { ...r, warnings: lintMap(applied.map, touchedIds(ops, applied.map)), changes: applied.changes };
    if (r.code !== "conflict") return r;
  }
  return conflict(env, name, "同時に何度も更新されたため保存できませんでした。少し待って再実行してください");
}

export async function deleteMap(env: Env, name: string, version: number, by: string) {
  const at = nowIso();
  const [hist, del] = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO map_versions (name, version, json, updated_at, updated_by, deleted, note) SELECT name, version + 1, json, ?, ?, 1, '削除' FROM maps WHERE name = ? AND version = ?",
    ).bind(at, by, name, version),
    env.DB.prepare("DELETE FROM maps WHERE name = ? AND version = ?").bind(name, version),
  ]);
  return { deleted: !!del.meta.changes, history: !!hist.meta.changes };
}

export async function listVersions(env: Env, name: string, limit = 200) {
  const rs = await env.DB.prepare(
    "SELECT version, updated_at, updated_by, deleted, note FROM map_versions WHERE name = ? ORDER BY version DESC LIMIT ?",
  )
    .bind(name, Math.min(Math.max(1, limit), 200))
    .all();
  return rs.results as { version: number; updated_at: string; updated_by: string; deleted: number; note: string }[];
}

export async function getVersion(env: Env, name: string, version: number) {
  const row = await env.DB.prepare("SELECT version, json, updated_at, updated_by, deleted, note FROM map_versions WHERE name = ? AND version = ?")
    .bind(name, version)
    .first<any>();
  if (!row) return null;
  return { name, version: row.version, updated_at: row.updated_at, updated_by: row.updated_by, deleted: !!row.deleted, note: row.note, map: JSON.parse(row.json) };
}

// ---------------------------------------------------------------- proposals

export interface Proposal {
  id: string;
  name: string;
  base_version: number;
  ops: Op[];
  changes: string[];
  summary: string;
  created_by: string;
  created_at: string;
  status: "open" | "approved" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
}

function rowToProposal(r: any): Proposal {
  return { ...r, ops: JSON.parse(r.ops), changes: JSON.parse(r.changes) };
}

/** 提案を登録する（マップは変えない）。ops は今の最新版に当てて検証し、変更内容を記録しておく。 */
export async function createProposal(env: Env, name: string, ops: Op[], summary: string, by: string) {
  const cur = await getMap(env, name);
  if (!cur) return { ok: false as const, code: "not_found", message: `マップ「${name}」はありません` };
  let applied;
  try {
    applied = applyOps(cur.map, ops);
  } catch (e) {
    if (e instanceof OpError) return { ok: false as const, code: "invalid_ops", message: e.message };
    throw e;
  }
  const problem = validateMap(applied.map);
  if (problem) return { ok: false as const, code: "invalid_map", message: problem };
  if (!applied.changes.length) return { ok: false as const, code: "invalid_ops", message: "変更がありません（すでにその状態です）" };
  const id = crypto.randomUUID();
  const at = nowIso();
  await env.DB.prepare(
    "INSERT INTO proposals (id, name, base_version, ops, changes, summary, created_by, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')",
  )
    .bind(id, name, cur.version, JSON.stringify(ops), JSON.stringify(applied.changes), summary.slice(0, 4000), by, at)
    .run();
  return { ok: true as const, id, name, changes: applied.changes, warnings: lintMap(applied.map, touchedIds(ops, applied.map)) };
}

export async function listProposals(env: Env, name: string | null, status: string | null = "open") {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (name) {
    where.push("name = ?");
    binds.push(name);
  }
  if (status && status !== "all") {
    where.push("status = ?");
    binds.push(status);
  }
  const rs = await env.DB.prepare(
    `SELECT * FROM proposals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(...binds)
    .all();
  return (rs.results as any[]).map(rowToProposal);
}

/** 提案の承認／却下（人だけが行う）。承認は、その時点の最新版へ ops を当てて保存する。 */
export async function decideProposal(env: Env, id: string, approve: boolean, by: string, reason = "") {
  const row = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<any>();
  if (!row) return { ok: false as const, code: "not_found", message: "提案が見つかりません" };
  const p = rowToProposal(row);
  if (p.status !== "open") return { ok: false as const, code: "already_decided", message: `この提案は既に${p.status === "approved" ? "承認" : "却下"}されています` };
  const at = nowIso();
  if (!approve) {
    const u = await env.DB.prepare("UPDATE proposals SET status = 'rejected', decided_by = ?, decided_at = ?, result = ? WHERE id = ? AND status = 'open'")
      .bind(by, at, reason.slice(0, 1000), id)
      .run();
    if (!u.meta.changes) return { ok: false as const, code: "already_decided", message: "この提案は既に処理されています" };
    return { ok: true as const, status: "rejected" as const };
  }
  // 先に提案を確保（二重承認を防ぐ）してから反映。反映に失敗したら open に戻す。
  const lock = await env.DB.prepare("UPDATE proposals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'")
    .bind(by, at, id)
    .run();
  if (!lock.meta.changes) return { ok: false as const, code: "already_decided", message: "この提案は既に処理されています" };
  const r = await editMap(env, p.name, p.ops, by, `提案を承認（提案者: ${p.created_by}）: ${p.summary}`);
  if (!r.ok) {
    await env.DB.prepare("UPDATE proposals SET status = 'open', decided_by = NULL, decided_at = NULL WHERE id = ?").bind(id).run();
    return { ok: false as const, code: r.code, message: `反映できませんでした: ${r.message}` };
  }
  await env.DB.prepare("UPDATE proposals SET result = ? WHERE id = ?").bind(`v${r.version} に反映`, id).run();
  return { ok: true as const, status: "approved" as const, version: r.version, changes: r.changes };
}
