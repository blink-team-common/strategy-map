#!/usr/bin/env node
/**
 * 共有版の戦略マップと手元の JSON をやり取りする CLI（Claude Code / スクリプト用）。
 * 認証は X-API-Key（Worker の API_KEY シークレットと同じ値）。
 *
 *   export STRATEGY_MAP_URL=https://blink-strategy-map.<subdomain>.workers.dev
 *   export STRATEGY_MAP_API_KEY=...
 *
 *   node scripts/maps.mjs list
 *   node scripts/maps.mjs pull <dir> [name...]     共有 → 手元（全部 or 指定）。版番号を <dir>/.versions.json に記録
 *   node scripts/maps.mjs push <file.json...> [--force]
 *                                                  手元 → 共有。pull 時の版を基準に保存し、
 *                                                  その後に誰かが保存していたら止まる（--force で上書き）
 *
 * マップ名は「ファイル名」（例: strategy-map.json）。ノードの link にもこの名前を書く。
 */

import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.STRATEGY_MAP_URL || "").replace(/\/+$/, "");
const KEY = process.env.STRATEGY_MAP_API_KEY || "";
if (!BASE || !KEY) {
  console.error("STRATEGY_MAP_URL と STRATEGY_MAP_API_KEY を環境変数で指定してください。");
  process.exit(2);
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "X-API-Key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, status: res.status, data };
}
const enc = (name) => "/api/maps/" + encodeURIComponent(name);
const versionsFile = (dir) => path.join(dir, ".versions.json");
function readVersions(dir) {
  try {
    return JSON.parse(fs.readFileSync(versionsFile(dir), "utf8"));
  } catch {
    return {};
  }
}
function writeVersions(dir, v) {
  fs.writeFileSync(versionsFile(dir), JSON.stringify(v, null, 2) + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);
const force = rest.includes("--force");
const args = rest.filter((a) => a !== "--force");

if (cmd === "list") {
  const r = await api("GET", "/api/maps");
  if (!r.ok) fail(r);
  for (const m of r.data.maps) console.log(`v${m.version}\t${m.updated_at}\t${m.updated_by}\t${m.name}\t${m.title}`);
} else if (cmd === "pull") {
  const dir = args[0] || ".";
  fs.mkdirSync(dir, { recursive: true });
  let names = args.slice(1);
  if (!names.length) {
    const r = await api("GET", "/api/maps");
    if (!r.ok) fail(r);
    names = r.data.maps.map((m) => m.name);
  }
  const vers = readVersions(dir);
  for (const name of names) {
    const r = await api("GET", enc(name));
    if (!r.ok) {
      console.error(`✗ ${name}: ${r.data?.message || r.status}`);
      continue;
    }
    fs.writeFileSync(path.join(dir, name), JSON.stringify(r.data.map, null, 2) + "\n");
    vers[name] = r.data.version;
    console.log(`↓ ${name} (v${r.data.version})`);
  }
  writeVersions(dir, vers);
} else if (cmd === "push") {
  if (!args.length) {
    console.error("push するファイルを指定してください");
    process.exit(2);
  }
  let failed = 0;
  for (const file of args) {
    const dir = path.dirname(file);
    const name = path.basename(file);
    const vers = readVersions(dir);
    let map;
    try {
      map = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`✗ ${name}: JSONとして読めません (${e.message})`);
      failed++;
      continue;
    }
    let base = vers[name] ?? 0;
    let r = await api("PUT", enc(name), { map, baseVersion: base });
    if (r.status === 409 && force) {
      r = await api("PUT", enc(name), { map, baseVersion: r.data.currentVersion });
    }
    if (r.status === 409) {
      console.error(
        `✗ ${name}: 共有側が更新されています（v${r.data.currentVersion}, ${r.data.updated_by} ${r.data.updated_at}）。` +
          ` pull して差分を取り込むか、--force で上書きしてください（上書きしても相手の版は履歴に残ります）`,
      );
      failed++;
      continue;
    }
    if (!r.ok) {
      console.error(`✗ ${name}: ${r.data?.message || r.status}`);
      failed++;
      continue;
    }
    vers[name] = r.data.version;
    writeVersions(dir, vers);
    console.log(`↑ ${name} (v${r.data.version})`);
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error("使い方: maps.mjs list | pull <dir> [name...] | push <file.json...> [--force]");
  process.exit(2);
}

function fail(r) {
  console.error(`エラー: ${r.data?.message || r.status}`);
  process.exit(1);
}
