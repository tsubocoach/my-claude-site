// 受信箱（撮影済みレシートのログ）を KV に保存する
import type { Env } from "./freee";

export type EntryStatus = "pending" | "done" | "error";

export interface EntryLine {
  account_item_id: number;
  tax_code: number;
  tax_rate?: string; // AI が判定した税率（適格請求書の切替時に税区分を付け直すため）
  amount: number;
  description: string;
  reason?: string;
}

/** freee に送る内容（画面で確認・編集する部分） */
export interface EntryData {
  issue_date: string;
  vendor_name: string;
  create_partner: boolean;
  walletable: { id: number; type: string } | null; // null = 未決済
  qualified_invoice: boolean;
  registration_number: string | null;
  memo: string;
  lines: EntryLine[];
}

export interface Entry {
  id: string;
  created_at: string;
  status: EntryStatus;
  media_type: string;
  data: EntryData;
  analysis_total: number | null; // AI がレシートから読んだ合計
  payment_hint: string;
  warnings: string[];
  // freee 登録の進捗（途中で失敗しても二重アップロードしないよう段階ごとに保存）
  receipt_id?: number;
  partner_id?: number | null;
  deal_id?: number;
  synced_at?: string;
  error?: string;
}

export interface EntrySummary {
  id: string;
  status: EntryStatus;
  date: string;
  vendor: string;
  amount: number;
  wallet: string;
}

const entryKey = (id: string) => `entry:${id}`;
const imageKey = (id: string) => `img:${id}`;

export const entryTotal = (d: EntryData) => d.lines.reduce((s, l) => s + l.amount, 0);

/** 新しい順に並ぶ ID（KV の list はキーの昇順） */
export function newId(): string {
  const rev = (9_999_999_999_999 - Date.now()).toString().padStart(13, "0");
  return `${rev}-${crypto.randomUUID().slice(0, 6)}`;
}

function summary(e: Entry, walletName: string): EntrySummary {
  return {
    id: e.id,
    status: e.status,
    date: e.data.issue_date,
    vendor: e.data.vendor_name.slice(0, 40),
    amount: entryTotal(e.data),
    wallet: walletName.slice(0, 30),
  };
}

export async function saveEntry(env: Env, e: Entry, walletName = ""): Promise<void> {
  await env.STORE.put(entryKey(e.id), JSON.stringify(e), { metadata: summary(e, walletName) });
}

export async function saveImage(env: Env, id: string, base64: string): Promise<void> {
  await env.STORE.put(imageKey(id), base64);
}

export async function getEntry(env: Env, id: string): Promise<Entry | null> {
  const raw = await env.STORE.get(entryKey(id));
  return raw ? (JSON.parse(raw) as Entry) : null;
}

export async function getImage(env: Env, id: string): Promise<string | null> {
  return env.STORE.get(imageKey(id));
}

export async function deleteEntry(env: Env, id: string): Promise<void> {
  await Promise.all([env.STORE.delete(entryKey(id)), env.STORE.delete(imageKey(id))]);
}

/** 一覧（新しい順）。KV のメタデータだけで組み立てるので速い */
export async function listEntries(env: Env): Promise<EntrySummary[]> {
  const out: EntrySummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STORE.list<EntrySummary>({ prefix: "entry:", cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
