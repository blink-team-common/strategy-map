-- 戦略マップ: 最新版（maps）と全履歴（map_versions）
-- name はマップの識別子（例: strategy-map.json / blink-中戦略-01-医療AX.json）。ノードの link から参照される。

CREATE TABLE IF NOT EXISTS maps (
  name        TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  json        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS map_versions (
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  json        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, version)
);
