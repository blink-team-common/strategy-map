/**
 * 点検レポート（読み取りのみ。マップは一切変えない）。
 *
 * 社内AIなどが「点検して」と呼ぶ想定。決まったルールで、人が判断すべき点を挙げる。
 *   - 期限切れ / 期限が近い（7日以内）       … マップの値で判定
 *   - Jira とのずれ（完了・担当・期限）       … マップと Jira の食い違い
 *   - 停滞（マップ未完了・Jira 進行中で14日以上更新なし）
 *   - Jira に存在しないキー
 *   - 未処理の提案
 */

import type { Env } from "./config";
import { fetchJira, normalizeKeys } from "./jira";
import { oneLine, type MapNode } from "./model";
import { getMap, listMaps, listProposals } from "./store";

const DAY = 86_400_000;

export interface CheckItem {
  kind: "overdue" | "due_soon" | "jira_done_mismatch" | "jira_assignee_mismatch" | "jira_due_mismatch" | "stale" | "jira_missing" | "open_proposal";
  map: string;
  mapTitle: string;
  node?: string;
  label?: string;
  detail: string;
}

/** 日本時間の今日（YYYY-MM-DD） */
function todayJst(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}
function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}
/** 担当者名のゆるい一致（「得田」と「得田 太郎」など） */
function sameperson(a: string, b: string): boolean {
  const x = a.replace(/\s|さん/g, "");
  const y = b.replace(/\s|さん/g, "");
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

export async function runCheck(env: Env, names?: string[] | null, origin = "") {
  const all = await listMaps(env);
  const targets = names?.length ? all.filter((m) => names.includes(m.name)) : all;
  const maps = (await Promise.all(targets.map((m) => getMap(env, m.name)))).filter((x) => !!x);
  const today = todayJst();
  const soon = addDays(today, 7);
  const items: CheckItem[] = [];

  const keys = normalizeKeys(maps.flatMap((m) => m.map.nodes.map((n) => n.jira).filter(Boolean)));
  const jr = keys.length ? await fetchJira(env, keys) : null;
  const jira = jr && jr.ok ? jr.issues : {};
  const jiraNote = jr && !jr.ok ? jr.message : null;

  for (const rec of maps) {
    const mapTitle = rec.map.title || rec.name;
    const push = (kind: CheckItem["kind"], n: MapNode | null, detail: string) =>
      items.push({ kind, map: rec.name, mapTitle, ...(n ? { node: n.id, label: oneLine(n.label) } : {}), detail });

    for (const n of rec.map.nodes) {
      const done = !!n.done;
      if (!done && n.due && n.due < today) push("overdue", n, `期限 ${n.due}${n.assignee ? `・${n.assignee}` : ""}`);
      else if (!done && n.due && n.due <= soon) push("due_soon", n, `期限 ${n.due}${n.assignee ? `・${n.assignee}` : ""}`);

      if (!n.jira) continue;
      if (jr && jr.ok && jr.missing.includes(n.jira)) {
        push("jira_missing", n, `${n.jira} が Jira に見つかりません（キー違い・権限なし）`);
        continue;
      }
      const j = jira[n.jira];
      if (!j) continue;
      const jDone = j.category === "done";
      if (jDone && !done) push("jira_done_mismatch", n, `マップ：未完了 ／ ${n.jira}：${j.status}${j.resolutiondate ? `（${j.resolutiondate.slice(0, 10)}）` : ""}`);
      if (!jDone && done) push("jira_done_mismatch", n, `マップ：完了(${n.done}) ／ ${n.jira}：${j.status}`);
      if (n.assignee && j.assignee && !sameperson(n.assignee, j.assignee)) push("jira_assignee_mismatch", n, `担当 マップ：${n.assignee} ／ ${n.jira}：${j.assignee}`);
      if (n.assignee && !j.assignee) push("jira_assignee_mismatch", n, `担当 マップ：${n.assignee} ／ ${n.jira}：未割当`);
      if (n.due && j.duedate && n.due !== j.duedate) push("jira_due_mismatch", n, `期限 マップ：${n.due} ／ ${n.jira}：${j.duedate}`);
      if (!done && j.category === "indeterminate" && j.updated) {
        const days = Math.floor((Date.now() - Date.parse(j.updated)) / DAY);
        if (days >= 14) push("stale", n, `${n.jira}（${j.status}）が ${days}日 更新なし`);
      }
    }
  }

  const props = await listProposals(env, null, "open");
  for (const p of props) {
    if (names?.length && !names.includes(p.name)) continue;
    const t = maps.find((m) => m.name === p.name)?.map.title ?? p.name;
    items.push({ kind: "open_proposal", map: p.name, mapTitle: t, detail: `${p.created_by}：${p.summary}（${p.changes.length}件の変更）` });
  }

  return { today, maps: maps.map((m) => m.name), items, jiraNote, text: renderText(today, items, jiraNote, origin) };
}

const SECTIONS: [CheckItem["kind"][], string][] = [
  [["overdue"], "⏰ 期限切れ"],
  [["due_soon"], "📅 7日以内に期限"],
  [["jira_done_mismatch", "jira_assignee_mismatch", "jira_due_mismatch"], "🔀 Jira とずれ"],
  [["stale"], "💤 停滞"],
  [["jira_missing"], "❓ Jira に無いキー"],
  [["open_proposal"], "💡 未処理の提案"],
];

function renderText(today: string, items: CheckItem[], jiraNote: string | null, origin: string): string {
  const out = [`📍 戦略マップ 点検（${today}）`];
  if (!items.length) out.push("", "気になる点はありませんでした。");
  for (const [kinds, head] of SECTIONS) {
    const xs = items.filter((i) => kinds.includes(i.kind));
    if (!xs.length) continue;
    out.push("", `${head} ${xs.length}件`);
    for (const i of xs) {
      const link = origin ? ` ${origin}/?map=${encodeURIComponent(i.map)}${i.node ? `&node=${encodeURIComponent(i.node)}` : ""}` : "";
      out.push(`・${i.mapTitle}${i.label ? ` ／「${i.label}」` : ""} — ${i.detail}${link}`);
    }
  }
  if (jiraNote) out.push("", `※ Jira は確認できませんでした: ${jiraNote}`);
  out.push("", "マップへの反映は、各ノードを開いて人が判断してください（マップが正典）。");
  return out.join("\n");
}
