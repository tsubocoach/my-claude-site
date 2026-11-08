# 🧾 レシート → freee

スマホでレシート・領収書を撮影 → Claude が読み取って **日付・取引先・金額・勘定科目・税区分（8%/10%）・支払口座** を推定 → 確認して **freee会計に「支出」取引＋証憑画像** として登録するアプリです。

## 流れ

1. スマホで開いて「📷 撮影」
2. 10〜30秒で読み取り結果が表示される（科目・税区分・口座はAIの提案。変更可）
3. 「freeeに登録」→ freee に
   - 画像をファイルボックスへアップロード（証憑）
   - 取引先を検索、無ければ作成（オフにもできる）
   - 支出取引を作成し、証憑を紐づけ。口座を選んでいれば決済済み、「未決済」を選べば未決済で登録

その他：
- 同じ日付・同じ金額の取引が freee にあれば「二重登録注意」を表示
- 適格請求書の登録番号（T+13桁）を検出。無い場合、会社で経過措置の税区分（控80/控70）が有効ならそれを使う
- ⚙️設定の「勘定科目のルール」に「スタバ→会議費」のように書くと、AIが最優先で従う

## 構成

Cloudflare Workers（無料枠で動きます）1つで、画面・Claude API・freee API をすべて扱います。
APIキーや freee のトークンはサーバー側（Workers のシークレット / KV）にだけ置き、スマホ側には渡しません。

```
スマホ（ブラウザ） ──► Cloudflare Worker ──► Claude API（画像読み取り）
                                   └────► freee 会計 API（証憑・取引登録）
```

## セットアップ（初回だけ・30分程度）

### 1. 必要なもの
- Cloudflare アカウント（無料）
- Claude API キー（https://console.anthropic.com/ で発行）
- freee アカウント（会計の管理者権限）
- Node.js 20 以上

### 2. デプロイ

```bash
cd receipt-app
npm install
npx wrangler login

# KV（トークン保存用）を作成 → 表示された id を wrangler.toml の REPLACE_WITH_YOUR_KV_ID に貼る
npx wrangler kv namespace create STORE

# 一度デプロイして URL を確認（例: https://receipt-to-freee.xxxx.workers.dev）
npx wrangler deploy
```

`wrangler.toml` の `FREEE_REDIRECT_URI` を `https://receipt-to-freee.xxxx.workers.dev/auth/callback` に書き換えます。

### 3. freee アプリを作成

1. https://app.secure.freee.co.jp/developers/applications を開き「新規作成」
2. コールバックURL に上の `.../auth/callback` を登録
3. 権限（スコープ）で、freee会計の次を「参照・更新」にする
   - 取引（収入・支出）／ファイルボックス／取引先／勘定科目（参照）／口座（参照）／事業所（参照）／税区分（参照）
4. 「Client ID」「Client Secret」を控える

### 4. シークレットを登録して再デプロイ

```bash
npx wrangler secret put ANTHROPIC_API_KEY     # Claude API キー
npx wrangler secret put FREEE_CLIENT_ID
npx wrangler secret put FREEE_CLIENT_SECRET
npx wrangler secret put APP_PASSWORD          # アプリを開くときのパスワード（自分で決める）
npx wrangler deploy
```

### 5. スマホで使う

1. iPhone の Safari（Android は Chrome）で URL を開き、パスワードでログイン
2. 「freeeと連携する」→ freee にログインして事業所を選択
3. 共有メニュー →「ホーム画面に追加」でアプリのように使えます

## ローカルで試す

```bash
cp .dev.vars.example .dev.vars   # 中身を埋める（freeeアプリのコールバックに http://localhost:8787/auth/callback も追加）
npm run dev                      # http://localhost:8787
```

## 費用の目安

- Cloudflare Workers / KV：個人利用なら無料枠内
- Claude API：Claude Opus 5.5 で 1枚あたり数円程度（画像サイズ・明細の量による）

## ファイル

| ファイル | 内容 |
|---|---|
| `src/index.ts` | ルーティング、ログイン、freee登録処理 |
| `src/claude.ts` | Claude でのレシート解析（構造化出力） |
| `src/freee.ts` | freee OAuth、マスタ取得、取引先・重複チェック |
| `src/app.html` | スマホ画面 |
| `src/login.html` | ログイン画面 |
