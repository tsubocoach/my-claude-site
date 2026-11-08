# 🧾 レシート → freee

主に**現金払いのレシート・領収書**用。撮影するたびに Claude が **日付・取引先・金額・勘定科目・税区分（8%/10%）・支払口座** を読み取ってクラウドの受信箱に貯め、週1回など好きなタイミングで **まとめて freee会計に「支出」取引＋証憑画像** として登録します。

## 使い方（運用）

**ふだん：撮るだけ**
1. 現金で払ったらその場で「📷 撮影」
2. AIが日付・店名・金額・勘定科目・税区分（8%/10%）を読み取るので、ざっと確認して「受信箱に保存」
   - 支払方法は **現金が既定**（カード・交通系IC と読み取れたときだけその口座）。⚙️設定で変更可
   - 画像と内容はクラウド（Cloudflare KV）に保存され、ログとして残ります

**週1回など：まとめて登録**
3. 受信箱の「まとめてfreeeに登録」を押すと、未登録分を古い順に freee へ登録
   - 画像 → ファイルボックス（証憑）、取引先を検索/作成、支出取引を作成して証憑を紐づけ
   - エラーになったものは受信箱に「エラー」で残るので、直して保存 → もう一度ボタン
   - 途中で失敗しても、画像が二重にアップロードされないようにしてあります

その他：
- 同じ日付・同じ金額のレシートが freee か受信箱にあれば「二重登録注意」を表示
- 適格請求書の登録番号（T+13桁）を検出。無い場合、会社で経過措置の税区分（控80/控70）が有効ならそれを使う
- ⚙️設定の「勘定科目のルール」に「スタバ→会議費」のように書くと、AIが最優先で従う
- 登録済みのものは受信箱で閲覧のみ（修正は freee 側で）

### アプリを開かずに登録したい場合（任意）

`SYNC_TOKEN` を設定すると、ショートカット等から一括登録を実行できます。

```bash
curl -X POST -H "Authorization: Bearer <SYNC_TOKEN>" "https://<あなたのURL>/api/sync?all=1"
# → {"processed":[...], "remaining": 3}   remaining が 0 になるまで繰り返す（1回8件ずつ）
```

iPhone の「ショートカット」アプリで「URLの内容を取得」（方法 POST、ヘッダに Authorization）を
「繰り返す」で数回実行するようにしておけば、「Hey Siri、レシート登録」で流し込めます。

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
npx wrangler secret put SYNC_TOKEN            # （任意）ショートカットから一括登録する合言葉。16文字以上
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

- Cloudflare Workers / KV：個人利用なら無料枠内（KV 1GB ＝ レシート画像およそ2,000枚分。古いものは受信箱から削除可）
- Claude API：Claude Opus 5.5 で 1枚あたり数円程度（画像サイズ・明細の量による）

## ファイル

| ファイル | 内容 |
|---|---|
| `src/index.ts` | ルーティング、ログイン、まとめて登録（freee） |
| `src/store.ts` | 受信箱（レシートのログ）の保存 |
| `src/claude.ts` | Claude でのレシート解析（構造化出力） |
| `src/freee.ts` | freee OAuth、マスタ取得、取引先・重複チェック |
| `src/app.html` | スマホ画面 |
| `src/login.html` | ログイン画面 |
