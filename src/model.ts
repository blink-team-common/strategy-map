/**
 * マップのデータモデル・検証・操作（ops）の適用。
 *
 * AI（MCPハブ経由）や画面の「提案の承認」は、マップ丸ごとの上書きではなく ops で編集する。
 * ops はサーバーで最新版に当ててから検証するので、他の人の変更を巻き戻さない。
 */

export const KINDS = ["start", "task", "milestone", "goal"] as const;
export type Kind = (typeof KINDS)[number];
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MapNode {
  id: string;
  label: string;
  assignee?: string;
  due?: string;
  done?: string;
  kind: Kind;
  note?: string;
  link?: string;
  jira?: string;
  x?: number;
  y?: number;
}
export interface MapEdge {
  from: string;
  to: string;
  label?: string;
}
export interface StrategyMap {
  title?: string;
  titleBlock?: { title?: string; name?: string; date?: string };
  nodes: MapNode[];
  edges: MapEdge[];
}

/** 壊れたデータを保存させないための検証。問題があればメッセージを返す。 */
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
    if (n.kind !== undefined && !(KINDS as readonly string[]).includes(n.kind)) return `kind が不正です: ${n.id}`;
    if (n.jira !== undefined && n.jira !== "" && !JIRA_KEY_RE.test(String(n.jira))) return `Jiraキーの形式が不正です: ${n.jira}`;
    for (const f of ["due", "done"] as const) {
      if (n[f] !== undefined && n[f] !== "" && !DATE_RE.test(String(n[f]))) return `${f} は YYYY-MM-DD 形式です: ${n.id}`;
    }
  }
  for (const e of m.edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) return "存在しないノードを指す矢印があります";
    if (e.from === e.to) return `自分自身への矢印があります: ${e.from}`;
  }
  const cyc = findCycle(m);
  if (cyc) return `矢印が循環しています: ${cyc.join(" → ")}`;
  return null;
}

function findCycle(m: StrategyMap): string[] | null {
  const out = new Map<string, string[]>();
  for (const n of m.nodes) out.set(n.id, []);
  for (const e of m.edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const nx of out.get(id) ?? []) {
      if (state.get(nx) === 1) return [...stack.slice(stack.indexOf(nx)), nx];
      if (!state.get(nx)) {
        const c = visit(nx);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const n of m.nodes) {
    if (!state.get(n.id)) {
      const c = visit(n.id);
      if (c) return c;
    }
  }
  return null;
}

/**
 * 保存はできるが、マップの書き方として気になる点（ラベルの長さ・体言止め・行き止まり）。
 * only を渡すと、そのノードについてだけ返す（AI の編集で、触ったノードだけを注意する）。
 */
export function lintMap(m: StrategyMap, only?: Set<string>): string[] {
  const w: string[] = [];
  const outs = new Set(m.edges.map((e) => e.from));
  for (const n of m.nodes) {
    if (only && !only.has(n.id)) continue;
    const lines = String(n.label ?? "").split("\n");
    const max = n.kind === "goal" ? 9 : 6;
    if (lines.length > 3) w.push(`「${oneLine(n.label)}」(${n.id}) のラベルが4行以上です（3行まで）`);
    if (lines.some((l) => width(l) > max)) w.push(`「${oneLine(n.label)}」(${n.id}) の1行が長すぎて丸からはみ出します（全角${max - 1}文字程度まで）`);
    if (/(構築|整備|作成|検討|導入|対応|実施|推進|強化|確立|開始)$/.test(lines.join("").trim()))
      w.push(`「${oneLine(n.label)}」(${n.id}) は体言止めです。『〜できる／〜している』の形にしてください`);
    if (n.kind !== "goal" && !outs.has(n.id)) w.push(`「${oneLine(n.label)}」(${n.id}) は行き止まりです（goal 以外は先へ矢印をつなぐ）`);
  }
  if (!only && !m.nodes.some((n) => n.kind === "goal")) w.push("goal のノードがありません");
  return w;
}

/** ops が触るノードID（追加・更新・接続の両端。削除されたものは除く） */
export function touchedIds(ops: Op[], m: StrategyMap): Set<string> {
  const ids = new Set<string>();
  for (const o of ops as any[]) {
    for (const k of ["id", "from", "to"]) {
      const v = o?.[k];
      for (const x of Array.isArray(v) ? v : v ? [v] : []) ids.add(String(x));
    }
  }
  // add_node で id 省略時は自動採番されるので、マップに無い新ノードもラベルで拾う
  for (const o of ops as any[]) if (o?.op === "add_node" && !o.id) for (const n of m.nodes) if (n.label === o.label) ids.add(n.id);
  return new Set([...ids].filter((id) => m.nodes.some((n) => n.id === id)));
}

function width(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) < 0x80 ? 0.55 : 1;
  return w;
}
export function oneLine(s: unknown): string {
  return String(s ?? "").replace(/\n/g, "");
}

// ---------------------------------------------------------------- ops

export type Op =
  | {
      op: "add_node";
      id?: string;
      label: string;
      kind?: Kind;
      assignee?: string;
      due?: string;
      done?: string;
      note?: string;
      jira?: string;
      link?: string;
      /** このノードへ矢印を引く元（前提）のノードID */
      from?: string[];
      /** このノードから矢印を引く先のノードID */
      to?: string[];
    }
  | { op: "update_node"; id: string; set: Partial<Omit<MapNode, "id" | "x" | "y">> }
  | { op: "remove_node"; id: string }
  | { op: "connect"; from: string; to: string; label?: string }
  | { op: "disconnect"; from: string; to: string }
  | { op: "set_meta"; title?: string; titleBlock?: { title?: string; name?: string; date?: string } };

const NODE_FIELDS = ["label", "kind", "assignee", "due", "done", "note", "jira", "link"] as const;

export class OpError extends Error {}

/**
 * ops を順に当てた新しいマップと、人が読める変更内容を返す。不正な op は OpError。
 * 座標(x,y)は付けない（画面が、つながるノードの近くに置く）。
 */
export function applyOps(src: StrategyMap, ops: Op[]): { map: StrategyMap; changes: string[] } {
  if (!Array.isArray(ops) || !ops.length) throw new OpError("ops が空です");
  if (ops.length > 100) throw new OpError("ops は1回100件までです");
  const m: StrategyMap = structuredClone(src);
  m.nodes ??= [];
  m.edges ??= [];
  const changes: string[] = [];
  const node = (id: string) => {
    const n = m.nodes.find((x) => x.id === id);
    if (!n) throw new OpError(`ノード ${id} がありません`);
    return n;
  };
  const name = (id: string) => `「${oneLine(node(id).label)}」`;
  const addEdge = (from: string, to: string, label?: string) => {
    node(from);
    node(to);
    if (m.edges.some((e) => e.from === from && e.to === to)) return false;
    m.edges.push({ from, to, ...(label ? { label } : {}) });
    return true;
  };

  ops.forEach((op: any, i) => {
    const where = `ops[${i}]`;
    switch (op?.op) {
      case "add_node": {
        if (!op.label || typeof op.label !== "string") throw new OpError(`${where}: label が必要です`);
        let id = typeof op.id === "string" && op.id ? op.id : "";
        if (!id) {
          let k = m.nodes.length + 1;
          while (m.nodes.some((n) => n.id === "n" + k)) k++;
          id = "n" + k;
        }
        if (!/^[A-Za-z0-9_\-]{1,40}$/.test(id)) throw new OpError(`${where}: id は英数字・_・- で40文字まで`);
        if (m.nodes.some((n) => n.id === id)) throw new OpError(`${where}: id ${id} は既にあります`);
        const n: MapNode = { id, label: op.label, kind: op.kind ?? "task" };
        for (const f of NODE_FIELDS) if (f !== "label" && f !== "kind" && op[f] !== undefined && op[f] !== "") (n as any)[f] = String(op[f]);
        m.nodes.push(n);
        changes.push(`追加: 「${oneLine(n.label)}」(${id})`);
        for (const f of op.from ?? []) if (addEdge(f, id)) changes.push(`接続: ${name(f)} → 「${oneLine(n.label)}」`);
        for (const t of op.to ?? []) if (addEdge(id, t)) changes.push(`接続: 「${oneLine(n.label)}」 → ${name(t)}`);
        break;
      }
      case "update_node": {
        const n = node(op.id);
        const set = op.set ?? {};
        const diffs: string[] = [];
        for (const [k, v] of Object.entries(set)) {
          if (!(NODE_FIELDS as readonly string[]).includes(k)) throw new OpError(`${where}: ${k} は変更できない項目です`);
          const before = (n as any)[k] ?? "";
          const after = v === null || v === undefined ? "" : String(v);
          if (before === after) continue;
          if (after === "") delete (n as any)[k];
          else (n as any)[k] = after;
          diffs.push(`${FIELD_JA[k] ?? k}: ${fmt(before)} → ${fmt(after)}`);
        }
        if (diffs.length) changes.push(`更新: 「${oneLine(n.label)}」(${n.id}) ${diffs.join(" ／ ")}`);
        break;
      }
      case "remove_node": {
        const n = node(op.id);
        m.nodes = m.nodes.filter((x) => x.id !== op.id);
        const before = m.edges.length;
        m.edges = m.edges.filter((e) => e.from !== op.id && e.to !== op.id);
        changes.push(`削除: 「${oneLine(n.label)}」(${n.id})${before !== m.edges.length ? `（矢印${before - m.edges.length}本も削除）` : ""}`);
        break;
      }
      case "connect": {
        if (addEdge(op.from, op.to, op.label)) changes.push(`接続: ${name(op.from)} → ${name(op.to)}`);
        break;
      }
      case "disconnect": {
        const before = m.edges.length;
        m.edges = m.edges.filter((e) => !(e.from === op.from && e.to === op.to));
        if (before !== m.edges.length) changes.push(`切断: ${name(op.from)} → ${name(op.to)}`);
        break;
      }
      case "set_meta": {
        if (typeof op.title === "string" && op.title !== m.title) {
          changes.push(`マップ名: ${fmt(m.title ?? "")} → ${fmt(op.title)}`);
          m.title = op.title;
        }
        if (op.titleBlock && typeof op.titleBlock === "object") {
          m.titleBlock = { ...(m.titleBlock ?? {}), ...op.titleBlock };
          changes.push("表題欄を更新");
        }
        break;
      }
      default:
        throw new OpError(`${where}: 不明な op です（add_node / update_node / remove_node / connect / disconnect / set_meta）`);
    }
  });
  return { map: m, changes };
}

const FIELD_JA: Record<string, string> = {
  label: "ラベル",
  kind: "種別",
  assignee: "担当",
  due: "期限",
  done: "完了日",
  note: "メモ",
  jira: "Jira",
  link: "リンク",
};
function fmt(v: unknown): string {
  const s = oneLine(v);
  return s ? `「${s.length > 30 ? s.slice(0, 30) + "…" : s}」` : "（空）";
}

/** AI が読みやすい要約テキスト（Jira 情報があれば添える）。 */
export function summarizeMap(
  name: string,
  m: StrategyMap,
  version: number,
  jira: Record<string, { status: string; category: string; assignee: string | null; duedate: string | null; children: { total: number; done: number } }> = {},
): string {
  const KIND_JA: Record<string, string> = { start: "起点", task: "タスク", milestone: "節目", goal: "ゴール" };
  const lines: string[] = [];
  lines.push(`# ${m.title || name}（マップ名: ${name} / v${version}）`);
  if (m.titleBlock?.name || m.titleBlock?.date) lines.push(`表題欄: ${m.titleBlock?.title ?? ""} ／ ${m.titleBlock?.name ?? ""} ／ ${m.titleBlock?.date ?? ""}`);
  lines.push("", "## ノード（id | 種別 | ラベル | 状態 | 担当 | 期限 | Jira | 下位マップ）");
  for (const n of m.nodes) {
    const j = n.jira ? jira[n.jira] : undefined;
    const jiraTxt = n.jira
      ? `${n.jira}${j ? `:${j.status}${j.children.total ? ` 子${j.children.done}/${j.children.total}` : ""}` : ""}`
      : "";
    lines.push(
      [
        n.id,
        KIND_JA[n.kind] ?? n.kind,
        oneLine(n.label),
        n.done ? `完了(${n.done})` : "未完了",
        n.assignee ?? "",
        n.due ?? "",
        jiraTxt,
        n.link ?? "",
      ].join(" | "),
    );
    if (n.note) lines.push(`  メモ: ${oneLine(n.note)}`);
  }
  lines.push("", "## 矢印（前提 → 次）");
  for (const e of m.edges) lines.push(`${e.from} → ${e.to}${e.label ? `（${e.label}）` : ""}`);
  return lines.join("\n");
}
