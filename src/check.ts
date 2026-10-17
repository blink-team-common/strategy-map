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
import { jiraKeys, oneLine, type MapNode } from "./model";
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

  const keys = normalizeKeys(maps.flatMap((m) => m.map.nodes.flatMap((n) => jiraKeys(n.jira))));
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

      // 1ノードに複数の Jira 課題を紐付けられる。判定は「マップが正典」のまま、食い違いだけを挙げる。
      const nkeys = jiraKeys(n.jira);
      if (!nkeys.length) continue;
      if (jr && jr.ok) for (const k of nkeys.filter((k) => jr.missing.includes(k))) push("jira_missing", n, `${k} が Jira に見つかりません（キー違い・権限なし）`);
      const found = nkeys.filter((k) => jira[k]);
      if (!found.length) continue;
      const label = (ks: string[]) => (ks.length <= 3 ? ks.join("・") : `${ks.slice(0, 3).join("・")} 他${ks.length - 3}件`);
      const notDone = found.filter((k) => jira[k].category !== "done");
      // 完了: 紐付けた課題が「全部」完了なのにマップが未完了 / マップが完了なのに未完了の課題がある
      if (!done && !notDone.length && found.length === nkeys.length) {
        const last = found.map((k) => jira[k].resolutiondate ?? "").sort().pop()?.slice(0, 10);
        push("jira_done_mismatch", n, `マップ：未完了 ／ ${label(found)}：すべて完了${last ? `（最終 ${last}）` : ""}`);
      }
      if (done && notDone.length) push("jira_done_mismatch", n, `マップ：完了(${n.done}) ／ 未完了の課題 ${label(notDone.map((k) => `${k}:${jira[k].status}`))}`);
      // 担当: マップの担当が、どの課題の担当とも一致しないとき
      const assignees = [...new Set(found.map((k) => jira[k].assignee).filter((a): a is string => !!a))];
      if (n.assignee && assignees.length && !assignees.some((a) => sameperson(n.assignee!, a))) push("jira_assignee_mismatch", n, `担当 マップ：${n.assignee} ／ Jira：${assignees.join("・")}`);
      if (n.assignee && !assignees.length) push("jira_assignee_mismatch", n, `担当 マップ：${n.assignee} ／ ${label(found)}：未割当`);
      // 期限: 課題の中で一番遅い期限と比べる
      const lastDue = found.map((k) => jira[k].duedate ?? "").filter(Boolean).sort().pop();
      if (n.due && lastDue && n.due !== lastDue) push("jira_due_mismatch", n, `期限 マップ：${n.due} ／ Jira（最も遅い期限）：${lastDue}`);
      // 停滞: 進行中のまま14日以上更新のない課題（課題ごと）
      if (!done) {
        for (const k of found) {
          const j = jira[k];
          if (j.category !== "indeterminate" || !j.updated) continue;
          const days = Math.floor((Date.now() - Date.parse(j.updated)) / DAY);
          if (days >= 14) push("stale", n, `${k}（${j.status}）が ${days}日 更新なし`);
        }
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
