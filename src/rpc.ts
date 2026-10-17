/**
 * MCPハブ（blink-slack-mcp）から service binding で呼ぶ RPC エントリポイント。
 *
 * 名前付きエントリポイントは公開URLからは呼べず、service binding を持つ Worker だけが呼べる。
 * そのため鍵は不要。書き込みは必ず「依頼者（requestedBy）」を受け取り、履歴に
 * 「claude（依頼: ○○）」として残す。提案の承認・却下はここには無い（人が画面で行う）。
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./config";
import { runCheck } from "./check";
import { fetchJira } from "./jira";
import { summarizeMap, type Op } from "./model";
import { createProposal, editMap, getMap, listMaps, listProposals, listVersions, validName } from "./store";

function actor(requestedBy: unknown): string | null {
  const who = typeof requestedBy === "string" ? requestedBy.trim().slice(0, 80) : "";
  return who ? `claude（依頼: ${who}）` : null;
}
const NEED_REQUESTER = { ok: false, code: "need_requester", message: "requestedBy（誰の依頼か）が必要です" } as const;
const BAD_NAME = { ok: false, code: "bad_name", message: "マップ名が不正です" } as const;

export class StrategyMapService extends WorkerEntrypoint<Env> {
  private url(name?: string, node?: string): string {
    const base = (this.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
    if (!base) return "";
    return name ? `${base}/?map=${encodeURIComponent(name)}${node ? `&node=${encodeURIComponent(node)}` : ""}` : base;
  }

  async list() {
    const maps = await listMaps(this.env);
    return { ok: true, url: this.url(), maps: maps.map((m) => ({ ...m, url: this.url(m.name) })) };
  }

  /** マップを返す。format=text は AI 向けの要約（Jira の状態つき）、json はそのまま。 */
  async get(name: string, format: "text" | "json" = "text") {
    if (!validName(name)) return BAD_NAME;
    const rec = await getMap(this.env, name);
    if (!rec) return { ok: false, code: "not_found", message: `マップ「${name}」はありません` };
    if (format === "json") return { ok: true, url: this.url(name), ...rec };
    const keys = rec.map.nodes.map((n) => n.jira).filter(Boolean);
    const jr = keys.length ? await fetchJira(this.env, keys) : null;
    const text = summarizeMap(name, rec.map, rec.version, jr && jr.ok ? jr.issues : {});
    const props = await listProposals(this.env, name, "open");
    return {
      ok: true,
      url: this.url(name),
      version: rec.version,
      updated_at: rec.updated_at,
      updated_by: rec.updated_by,
      openProposals: props.length,
      jiraNote: jr && !jr.ok ? jr.message : null,
      text,
    };
  }

  /** 人に頼まれた編集を反映する。 */
  async edit(name: string, ops: Op[], requestedBy: string, note = "") {
    if (!validName(name)) return BAD_NAME;
    const by = actor(requestedBy);
    if (!by) return NEED_REQUESTER;
    const r = await editMap(this.env, name, ops, by, typeof note === "string" ? note : "");
    return { ...r, url: this.url(name) };
  }

  /** 提案を登録する（マップは変えない。人が画面で承認したら反映）。 */
  async propose(name: string, ops: Op[], summary: string, requestedBy: string) {
    if (!validName(name)) return BAD_NAME;
    const by = actor(requestedBy);
    if (!by) return NEED_REQUESTER;
    if (typeof summary !== "string" || !summary.trim()) return { ok: false, code: "bad_summary", message: "summary（提案の理由）が必要です" };
    const r = await createProposal(this.env, name, ops, summary.trim(), by);
    return { ...r, url: this.url(name) };
  }

  async proposals(name?: string, status = "open") {
    if (name && !validName(name)) return BAD_NAME;
    return { ok: true, proposals: await listProposals(this.env, name ?? null, status) };
  }

  async history(name: string, limit = 20) {
    if (!validName(name)) return BAD_NAME;
    return { ok: true, versions: await listVersions(this.env, name, limit) };
  }

  async check(names?: string[]) {
    const r = await runCheck(this.env, Array.isArray(names) ? names : null, (this.env.PUBLIC_URL ?? "").replace(/\/+$/, ""));
    return { ok: true, ...r };
  }
}
