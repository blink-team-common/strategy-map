# 戦略マップ（Cloudflare Workers）

「左下の複数スタート → 集約 → 右上のゴール」で戦略を描く社内ツールの**共有版**。
Google Workspace（blink-consulting.jp）でログインして使い、マップはチームで共有・履歴付きで保存される。
ノードに Jira の課題キーを書くと、Jira の状態・子課題の進捗を参考表示し、マップとのずれを知らせる。

> **マップが正典。** 完了・担当・期限などマップの中身を変えるのは人の判断だけ。
> Jira の値でマップが書き換わることはなく、AI は「人に頼まれた編集」か「提案（人が承認するまで反映されない）」しかできない。

- ランタイム: Cloudflare Workers（TypeScript / wrangler）＋ Workers Static Assets（画面）
- 保存先: Cloudflare D1（最新版 `maps` ＋ 全履歴 `map_versions`）
- 認証: Google Workspace SSO（OpenID Connect / PKCE）。画面・APIともログイン必須
- 依存: なし（Worker は `fetch` と Web Crypto のみ）
- 費用: 無料枠に収まる想定（Workers 10万リクエスト/日、D1 読取500万行/日・書込10万行/日・5GB）

```
ブラウザ ──(SSO Cookie)──▶ Worker blink-strategy-map ──▶ D1 strategy-map（マップ・履歴）
   │                          │  /auth/*  Google OIDC        └▶ Jira Cloud（課題の状態・読み取りのみ）
   │                          │  /api/*   保存・Jira
Claude Code / スクリプト ─(X-API-Key)─┘  それ以外: public/index.html
```

---

## 画面でできること

| 操作 | やり方 |
|---|---|
| マップを開く | 「📂 開く」→ 一覧から選ぶ（絞り込み可）。URL `?map=<マップ名>` で直接開ける（共有リンクに使える） |
| 保存 | 「💾 保存」または Ctrl/⌘+S。ツールバーに「● 未保存の変更」「✓ 保存済み vN」が出る |
| 同時編集 | 自分が開いた後に誰かが保存していたら、保存時に確認が出る（上書きしても相手の版は履歴に残る） |
| 新規 / 取込 | 一覧の「＋ 新規」、または「⇧ JSONを取込」で手元の JSON を読み込んで保存 |
| 下位マップへ | ノードの「リンク先マップ」にマップ名を書くと、ダブルクリックで潜れる（「← 戻る」で上位へ） |
| Jira 連携 | ノード編集の「Jira キー」に `MEDS-21` などを入れる。複数はカンマ区切り（`MEDS-21, KNOW-5`）。「⟳ Jira」で手動更新（5分ごとに自動更新） |
| 提案の承認 | AI などからの提案があるとツールバーに「💡 提案 N」。変更内容を見て「承認して反映」か「却下」 |
| 他の人の更新 | 開いている間に誰か（や AI）が保存すると、自動で取り込む（自分に未保存の変更があれば知らせるだけ） |
| ノードを直接開く | URL `?map=<マップ名>&node=<ノードID>`（点検レポートのリンクはこの形） |

### Jira 連携の表示ルール（Jira は参考表示）
- 丸の下に **キー・状態** のチップ（未着手=灰 / 進行中=青 / 完了=緑 / 見つからない=赤）
- 子課題（エピック配下・サブタスク）があれば **緑の進捗リング** と `2/4` 表示
- **複数の課題**を紐付けたときは `MEDS-21 他2件  完了 1/3` のように、何件完了したかをチップとリングで表示。
  編集パネルには課題ごとの状態・担当・期限が並ぶ。たくさんあるならエピック1つを紐付けて子課題の進捗で見るのがすっきりする
- 複数のときのずれ判定：**全部完了**なのにマップが未完了／マップが完了なのに未完了の課題がある／
  マップの担当が**どの課題の担当とも一致しない**／期限は**最も遅い期限**と比べる
- **完了・担当・期限はマップに書いた値だけ**を表示する（Jira の値で上書きしない）
- マップと Jira が食い違うと、チップに **≠**（オレンジ枠）。ノード編集の Jira 欄に「ずれ」と、
  人が押したときだけ反映する「完了にする」「Jiraの担当にする」などのボタンが出る（反映後に 💾 保存で確定）
- 認証に失敗しているときは「Jiraの認証に失敗しています」と出る（ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN を確認）
- 期限切れの期限は赤字

---

## 初回セットアップ（1回だけ）

前提: Cloudflare アカウント（MCPハブと同じ）、GCP プロジェクト（blink-consulting.jp の Workspace）。

### 1. Google OAuth クライアントを作る
1. GCP → **APIとサービス → OAuth同意画面**: User Type = **内部（Internal）**
   （Workspace 外のアカウントは Google 側で拒否される。MCPハブで作った同意画面があればそのまま使える）
2. **認証情報 → OAuthクライアントID を作成**: 種類 = **ウェブアプリケーション**
   - 承認済みのリダイレクト URI: `https://blink-strategy-map.<subdomain>.workers.dev/auth/callback`
   - （ローカルで本物のGoogleログインを試すなら `http://localhost:8787/auth/callback` も）
3. クライアントID / クライアントシークレットを控える

### 2. D1 データベースを作る
```bash
npm install
npx wrangler d1 create strategy-map
# 表示された database_id を wrangler.jsonc の "REPLACE_WITH_D1_DATABASE_ID" に貼ってコミット
npm run db:migrate:remote
```

### 3. シークレットを登録
```bash
npx wrangler deploy                              # 初回だけ手元から（Worker を作成）
npx wrangler secret put GOOGLE_CLIENT_ID         # 1. の値
npx wrangler secret put GOOGLE_CLIENT_SECRET     # 1. の値
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put ATLASSIAN_EMAIL          # MCPハブと同じ値
npx wrangler secret put ATLASSIAN_API_TOKEN      # MCPハブと同じ値
openssl rand -hex 32                             # ↓ スクリプト/Claude用のキー（任意）
npx wrangler secret put API_KEY
```
`ATLASSIAN_BASE_URL`（`https://blink-consulting.atlassian.net`）と `ALLOWED_DOMAIN` は `wrangler.jsonc` の vars にある。

### 4. GitHub Actions
`CLOUDFLARE_API_TOKEN` に **D1:Edit** 権限を追加する（MCPハブ用に Workers Scripts:Edit は付与済み）。
以降は `main` への push で、マイグレーション適用 → デプロイが自動で走る。

### 5. 今あるマップを入れる
```bash
export STRATEGY_MAP_URL=https://blink-strategy-map.<subdomain>.workers.dev
export STRATEGY_MAP_API_KEY=<API_KEY>
npm run maps -- push ~/strategy-map/*.json
```
（画面の「⇧ JSONを取込」→「💾 保存」でも入れられる）

---

## AI から使う（MCPハブ = blink-tools コネクタ）

MCPハブ（[internal-tools](https://github.com/blink-team-common/internal-tools) の `mcp/`）に戦略マップの道具が入っている。claude.ai・Claude Code・定期タスク・Slack の社内AIのどこからでも使える。
MCPハブ → 戦略マップは service binding（`StrategyMapService` の RPC）で、公開URLや鍵は使わない。

| ツール | 内容 | マップを変えるか |
|---|---|---|
| `strategy_map_list` | 一覧 | — |
| `strategy_map_get` | AI 向けの要約（ノード・状態・担当・期限・Jira の状態・矢印） | — |
| `strategy_map_edit` | 操作単位の編集。**人が明示的に頼んだときだけ**使う。履歴に「claude（依頼: ○○）」 | 変える |
| `strategy_map_propose` | 提案を登録。人が画面で承認したときだけ反映 | 変えない |
| `strategy_map_check` | 点検（期限切れ・7日以内・Jira とのずれ・停滞14日・無いキー・未処理の提案）。Slack に貼れる文章で返す | — |
| `strategy_map_history` | 変更履歴と提案の一覧 | — |

編集は JSON 丸ごとではなく **操作（ops）** で行う。サーバーで最新版に当てて検証するので、他の人の変更を巻き戻さない。
```jsonc
[
  { "op": "update_node", "id": "pacs", "set": { "done": "2026-10-16" } },
  { "op": "add_node", "label": "品川で\n運用が\n回っている", "from": ["shina_run"], "to": ["shina_ok"] },
  { "op": "connect", "from": "sec", "to": "koiwa_big" },
  { "op": "disconnect", "from": "a", "to": "b" },
  { "op": "remove_node", "id": "old" },
  { "op": "set_meta", "title": "…", "titleBlock": { "date": "2027-03-31" } }
]
```
- 循環・存在しないノード・不正な日付/キーは保存しない（エラー）
- 長すぎるラベル・体言止め・行き止まりは保存したうえで「注意」として返す（触ったノードについてだけ）
- AI が追加したノードは座標を持たず、画面がつながるノードの近くに置く（他のノードの配置は動かさない）
- 提案の承認・却下はログインした人だけ（APIキー・RPC からはできない）

## Claude Code から JSON で編集する（従来の方法）

`scripts/maps.mjs` で共有版と手元の JSON を往復できる。JSON の書き方は [`CLAUDE.md`](./CLAUDE.md)。

```bash
npm run maps -- list                       # 一覧
npm run maps -- pull ./maps                # 全マップを ./maps に取得（版番号を ./maps/.versions.json に記録）
#   … Claude が ./maps/*.json を編集 …
npm run maps -- push ./maps/strategy-map.json
```
`push` は pull した版を基準に保存する。その後に誰かが画面で保存していたら止まる（`--force` で上書き。相手の版は履歴に残る）。

---

## セキュリティ設計

- **ログイン必須**: 画面（静的ファイル）も `run_worker_first` で必ず Worker の認証を通る。未ログインは `/auth/login` へ
- **ドメイン制限（二重）**: 同意画面「内部」＋ id_token の `hd`・メールドメイン・`email_verified` を検証
- **OIDC**: Authorization Code + PKCE、`state`・`nonce` は署名付きの一時 Cookie（10分）で照合。
  `iss` / `aud` / `exp` を検証。id_token は client_secret 付きでトークンエンドポイントから直接受け取るため、署名検証の代わりに TLS に依拠（OIDC Core 3.1.3.7）
- **セッション**: HMAC-SHA256 署名の Cookie（HttpOnly / Secure / SameSite=Lax、既定12時間）。サーバー側に状態なし
- **CSRF**: Cookie 認証の書き込み系 API は `Origin` が自オリジンの時だけ許可
- **APIキー**: `X-API-Key` を定数時間比較。`API_KEY` 未設定なら無効（fail-closed）
- **Jira**: 読み取りのみ（bulkfetch / JQL 検索）。トークンはブラウザに出さない
- **ローカル開発の省略ログイン** `DEV_USER_EMAIL` は `localhost` / `127.0.0.1` へのアクセス時だけ有効。本番に登録しないこと

---

## API

すべてログイン（Cookie）または `X-API-Key` が必要。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/me` | ログイン中のユーザー |
| GET | `/api/maps` | 一覧 |
| GET | `/api/maps/:name` | 最新版 `{ name, version, updated_at, updated_by, map }` |
| GET | `/api/maps/:name/head` | 版番号と未処理の提案数だけ（画面の更新チェック用） |
| PUT | `/api/maps/:name` | 保存 `{ map, baseVersion, note? }`（新規は 0）。競合は 409 ＋ `currentVersion` |
| POST | `/api/maps/:name/ops` | 操作単位の編集 `{ ops, note? }`（最新版に当てる） |
| GET / POST | `/api/maps/:name/proposals` | 提案の一覧（`?status=open\|approved\|rejected\|all`）／登録 `{ ops, summary }` |
| POST | `/api/proposals/:id/approve` ・ `/reject` | 提案の承認・却下（ログインした人のみ） |
| GET | `/api/check` | 点検レポート（`?maps=a.json,b.json` で絞り込み） |
| DELETE | `/api/maps/:name?version=N` | 削除（履歴には残る） |
| GET | `/api/maps/:name/versions` | 履歴一覧 |
| GET | `/api/maps/:name/versions/:v` | 履歴の特定版 |
| POST | `/api/jira/issues` | `{ keys: [...] }` → 状態・担当・期限・子課題進捗 |

---

## ローカル開発

```bash
cp .dev.vars.example .dev.vars     # DEV_USER_EMAIL を入れると Google ログインを省略できる
npm run db:migrate:local
npm run dev                        # http://localhost:8787
npm run typecheck
```
`public/index.html` は単体（file:// や旧 `serve.mjs`）でも従来のローカル版として動く（`/api/me` が無ければローカル版）。

## ファイル構成

```
.
├── .github/workflows/   # ci.yml（型チェック）
├── public/index.html      # 画面（ローカル版／共有版の両対応）
├── src/
│   ├── index.ts           # ルーティング・認証ゲート・CSRF
│   ├── auth.ts            # Google Workspace SSO・セッション
│   ├── maps.ts            # マップの HTTP API
│   ├── store.ts           # D1 の読み書き（楽観ロック・履歴・ops 編集・提案）
│   ├── model.ts           # 検証・ops の適用・注意（lint）・AI 向け要約
│   ├── check.ts           # 点検レポート
│   ├── rpc.ts             # MCPハブ向け RPC（StrategyMapService）
│   ├── jira.ts            # Jira 課題の状態取得
│   ├── crypto.ts          # 署名トークン・PKCE
│   ├── http.ts            # レスポンス・Cookie
│   └── config.ts          # 環境変数
├── migrations/            # 0001 マップと履歴 / 0002 提案・変更メモ
├── scripts/maps.mjs       # pull / push CLI
└── wrangler.jsonc
```
