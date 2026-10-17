-- 変更の記録（誰の依頼で何を変えたか）と、AI からの提案（承認されるまでマップには反映しない）

ALTER TABLE map_versions ADD COLUMN note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS proposals (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,          -- 対象マップ名
  base_version  INTEGER NOT NULL,       -- 提案を作ったときの版（参考）
  ops           TEXT NOT NULL,          -- JSON（model.ts の Op[]）
  changes       TEXT NOT NULL,          -- JSON（人が読める変更内容 string[]）
  summary       TEXT NOT NULL,          -- 提案の理由・要約
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | approved | rejected
  decided_by    TEXT,
  decided_at    TEXT,
  result        TEXT                     -- 承認時の反映結果 / 却下理由
);
CREATE INDEX IF NOT EXISTS proposals_by_map ON proposals (name, status, created_at);
