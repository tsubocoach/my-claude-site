// Claude でレシート画像を読み取り、勘定科目・税区分・支払方法を推定する
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Masters } from "./freee";

const MODEL = "claude-opus-5-5";

const LineSchema = z.object({
  description: z.string().describe("この行の内容（例: 'コーヒー等', '文房具'）。品目ごとではなく科目×税率ごとにまとめる"),
  amount: z.number().int().describe("税込金額（円）"),
  tax_rate: z.enum(["10", "8_reduced", "non_taxable", "tax_exempt"])
    .describe("10=標準税率10%, 8_reduced=軽減税率8%, non_taxable=不課税/対象外(切手以外の公租公課・保険等), tax_exempt=非課税(切手・印紙など)"),
  account_item_id: z.number().int().describe("勘定科目一覧の id から選ぶ"),
  reason: z.string().describe("その勘定科目を選んだ理由（短く）"),
});

export const ReceiptSchema = z.object({
  is_receipt: z.boolean().describe("画像がレシート・領収書・請求書として読めるか"),
  vendor_name: z.string().describe("発行元（店名・会社名）。支店名は省いてよい"),
  issue_date: z.string().describe("取引日 YYYY-MM-DD。和暦は西暦に変換。読めなければ空文字"),
  total_amount: z.number().int().describe("支払総額（税込・円）"),
  invoice_registration_number: z.string().nullable().describe("適格請求書発行事業者の登録番号（T+13桁）。無ければ null"),
  payment_method: z.enum(["cash", "credit_card", "ic_card", "qr_or_electronic", "bank_transfer", "unknown"]),
  payment_detail: z.string().nullable().describe("カード下4桁やブランド等、支払手段の手がかり。無ければ null"),
  suggested_walletable_id: z.number().int().nullable().describe("口座一覧から最も合う id。判断できなければ null"),
  lines: z.array(LineSchema).describe("合計が total_amount と一致するように分ける"),
  memo: z.string().describe("freeeの備考に入れる短い説明（例: '打合せ時のカフェ代'）"),
  warnings: z.array(z.string()).describe("読み取りが不確かな箇所や、確認すべき点（日本語）"),
});
export type ReceiptAnalysis = z.infer<typeof ReceiptSchema>;

function buildSystem(m: Masters, rules: string): string {
  const items = m.account_items.map((a) => `${a.id}: ${a.name}（${a.category}）`).join("\n");
  const wallets = m.walletables.map((w) => `${w.id}: ${w.name}（${w.type}）`).join("\n");
  return `あなたは日本の中小企業の経理担当です。レシート・領収書の画像を読み取り、freee会計に「支出」の取引として登録するためのデータを作ります。

事業所: ${m.company_name}

# 判断の方針
- 金額は画像に印字された数字を正確に読み取る。推測で数字を作らない。読めない場合は warnings に書く。
- 明細は品目ごとではなく「勘定科目 × 税率」ごとに合算する。軽減税率(8%)と10%が混在するレシート（コンビニ・スーパー等）は分ける。
- 各行の amount の合計は total_amount と必ず一致させる（値引き・ポイント利用は該当行から差し引く。ポイント払いの扱いが不明なら warnings に書く）。
- 勘定科目は下の一覧の id からのみ選ぶ。一般的な目安:
  - 電車・バス・タクシー・駐車場・高速 → 旅費交通費
  - 打合せの飲食（少人数・カフェ等）→ 会議費、取引先との会食・贈答 → 交際費
  - 文房具・コピー用紙 → 事務用品費、10万円未満の備品・日用品 → 消耗品費
  - 書籍・雑誌・新聞 → 新聞図書費、郵送・宅配 → 荷造運賃 or 通信費、切手 → 通信費(非課税)
  - ガソリン → 車両費 or 燃料費（一覧にある方）
  - 10万円以上の物品は固定資産の可能性があるので warnings で注意喚起する
- 適格請求書の登録番号（T+13桁）が印字されていれば抜き出す。
- 支払方法はレシートの「お預り/現金」「クレジット」「交通系IC」「PayPay」等の表記から判断する。クレジットの場合、カード名や下4桁を見て口座一覧から選ぶ。現金なら現金の口座を選ぶ。判断できなければ null。

# ユーザー独自のルール（最優先で従う）
${rules.trim() || "（なし）"}

# 勘定科目一覧（id: 名前（区分））
${items}

# 口座一覧（id: 名前（種類））
${wallets}`;
}

export async function analyzeReceipt(
  apiKey: string,
  masters: Masters,
  rules: string,
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  today: string,
): Promise<ReceiptAnalysis> {
  const client = new Anthropic({ apiKey });

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(ReceiptSchema) },
    system: buildSystem(masters, rules),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: `このレシート/領収書を読み取ってください。今日の日付は ${today} です（年が印字されていない場合の参考）。` },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("この画像は解析できませんでした（モデルが応答を辞退しました）");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("解析結果が長すぎて途中で切れました。もう一度お試しください");
  }
  const out = response.parsed_output;
  if (!out) throw new Error("解析結果を読み取れませんでした");
  return out;
}
