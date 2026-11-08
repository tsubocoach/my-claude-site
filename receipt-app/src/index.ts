// レシート → freee 登録アプリ（Cloudflare Worker）
//
// 運用: 撮影するたびに AI で読み取って「受信箱」に保存し、
//       好きなタイミング（週1回など）で受信箱の未登録分をまとめて freee に登録する。
import { analyzeReceipt } from "./claude";
import {
  type Env,
  FreeeApiError,
  FreeeClient,
  FreeeNotConnected,
  type Masters,
  authorizeUrl,
  disconnect,
  exchangeCode,
  findOrCreatePartner,
  findSimilarDeals,
  loadMasters,
} from "./freee";
import {
  type Entry,
  type EntryData,
  deleteEntry,
  entryTotal,
  getEntry,
  getImage,
  listEntries,
  newId,
  saveEntry,
  saveImage,
} from "./store";
import { APP_HTML, LOGIN_HTML } from "./ui";

const COOKIE = "rf_session";
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

/** 1回の /api/sync で処理する件数（Workers 無料プランの外部リクエスト上限 50 に収めるため） */
const SYNC_BATCH = 8;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  // ---- ログイン（アプリ自体をパスワードで保護） ----
  if (pathname === "/login" && method === "GET") return html(LOGIN_HTML);
  if (pathname === "/login" && method === "POST") {
    const form = await req.formData();
    if (form.get("password") !== env.APP_PASSWORD) return html(LOGIN_HTML.replace("<!--ERR-->", "パスワードが違います"), 401);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": `${COOKIE}=${await sessionValue(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`,
      },
    });
  }

  // 外部（ショートカット等）からの一括登録: Authorization: Bearer <SYNC_TOKEN>
  if (pathname === "/api/sync" && method === "POST" && hasSyncToken(req, env)) {
    return json(await syncPending(env, url.searchParams.get("all") === "1"));
  }

  if (!(await isLoggedIn(req, env))) {
    if (pathname.startsWith("/api/")) return json({ error: "ログインが必要です" }, 401);
    return Response.redirect(new URL("/login", url).toString(), 303);
  }

  // ---- 画面 ----
  if (pathname === "/" && method === "GET") return html(APP_HTML);

  // ---- freee OAuth ----
  if (pathname === "/auth/start") {
    const state = crypto.randomUUID();
    await env.STORE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });
    return Response.redirect(authorizeUrl(env, state), 302);
  }
  if (pathname === "/auth/callback") {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    if (!code || !(await env.STORE.get(`oauth_state:${state}`))) return html("<p>認可に失敗しました。<a href='/'>戻る</a></p>", 400);
    await env.STORE.delete(`oauth_state:${state}`);
    await exchangeCode(env, code);
    return Response.redirect(new URL("/", url).toString(), 303);
  }
  if (pathname === "/api/disconnect" && method === "POST") {
    await disconnect(env);
    return json({ ok: true });
  }

  // ---- API ----
  if (pathname === "/api/status") {
    try {
      const fc = await FreeeClient.create(env);
      const m = await loadMasters(env, fc);
      return json({ connected: true, company_name: m.company_name });
    } catch (e) {
      if (e instanceof FreeeNotConnected) return json({ connected: false, message: e.message });
      throw e;
    }
  }

  if (pathname === "/api/masters") {
    const fc = await FreeeClient.create(env);
    return json(await loadMasters(env, fc, url.searchParams.get("refresh") === "1"));
  }

  if (pathname === "/api/rules") {
    if (method === "PUT") {
      const { rules } = (await req.json()) as { rules: string };
      await env.STORE.put("rules", String(rules ?? "").slice(0, 5000));
      return json({ ok: true });
    }
    return json({ rules: (await env.STORE.get("rules")) ?? "" });
  }

  if (pathname === "/api/analyze" && method === "POST") {
    const body = (await req.json()) as { image: string; media_type: string };
    const mediaType = checkImage(body);
    const fc = await FreeeClient.create(env);
    const masters = await loadMasters(env, fc);
    const rules = (await env.STORE.get("rules")) ?? "";
    const analysis = await analyzeReceipt(env.ANTHROPIC_API_KEY, masters, rules, body.image, mediaType, todayJst());

    // 一覧に無い科目・口座が返ってきた場合は空にして、画面で選んでもらう
    const itemIds = new Set(masters.account_items.map((a) => a.id));
    for (const l of analysis.lines) if (!itemIds.has(l.account_item_id)) l.account_item_id = 0;
    if (analysis.suggested_walletable_id && !masters.walletables.some((w) => w.id === analysis.suggested_walletable_id)) {
      analysis.suggested_walletable_id = null;
    }

    // 二重登録チェック: freee 登録済み ＋ 受信箱の中
    const [inFreee, inbox] = await Promise.all([
      findSimilarDeals(fc, analysis.issue_date, analysis.total_amount).catch(() => []),
      listEntries(env),
    ]);
    const inInbox = inbox.filter((s) => s.date === analysis.issue_date && s.amount === analysis.total_amount);
    return json({ analysis, duplicates: { freee: inFreee.length, inbox: inInbox.length } });
  }

  // ---- 受信箱 ----
  if (pathname === "/api/entries" && method === "GET") {
    return json({ entries: await listEntries(env) });
  }

  if (pathname === "/api/entries" && method === "POST") {
    const body = (await req.json()) as {
      image: string; media_type: string; data: EntryData;
      analysis_total?: number | null; payment_hint?: string; warnings?: string[];
    };
    const mediaType = checkImage(body);
    const data = validateData(body.data);
    const entry: Entry = {
      id: newId(),
      created_at: new Date().toISOString(),
      status: "pending",
      media_type: mediaType,
      data,
      analysis_total: body.analysis_total ?? null,
      payment_hint: String(body.payment_hint ?? "").slice(0, 200),
      warnings: (body.warnings ?? []).map(String).slice(0, 20),
    };
    await saveImage(env, entry.id, body.image);
    await saveEntry(env, entry, await walletName(env, data));
    return json({ ok: true, id: entry.id });
  }

  const m = pathname.match(/^\/api\/entries\/([\w-]+)(\/image)?$/);
  if (m) {
    const id = m[1];
    if (m[2]) {
      const img = await getImage(env, id);
      const entry = await getEntry(env, id);
      if (!img || !entry) return json({ error: "画像がありません" }, 404);
      const bytes = Uint8Array.from(atob(img), (c) => c.charCodeAt(0));
      return new Response(bytes, { headers: { "Content-Type": entry.media_type, "Cache-Control": "private, max-age=86400" } });
    }
    const entry = await getEntry(env, id);
    if (!entry) return json({ error: "見つかりません" }, 404);
    if (method === "GET") return json(entry);
    if (method === "PUT") {
      if (entry.status === "done") throw new UserError("freee登録済みのため編集できません（freee側で修正してください）");
      const { data } = (await req.json()) as { data: EntryData };
      entry.data = validateData(data);
      entry.status = "pending";
      delete entry.error;
      await saveEntry(env, entry, await walletName(env, entry.data));
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await deleteEntry(env, id);
      return json({ ok: true });
    }
  }

  if (pathname === "/api/sync" && method === "POST") {
    return json(await syncPending(env, url.searchParams.get("all") === "1"));
  }

  return json({ error: "Not found" }, 404);
}

// ---------- 入力チェック ----------

function validateData(d: EntryData): EntryData {
  if (!d || typeof d !== "object") throw new UserError("内容が空です");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.issue_date ?? "")) throw new UserError("日付を入力してください");
  if (!Array.isArray(d.lines) || !d.lines.length) throw new UserError("明細が空です");
  for (const l of d.lines) {
    if (!l.account_item_id) throw new UserError("勘定科目が未選択の行があります");
    if (!Number.isInteger(l.tax_code)) throw new UserError("税区分が未選択の行があります");
    if (!Number.isInteger(l.amount) || l.amount <= 0) throw new UserError("金額が正しくない行があります");
  }
  return {
    issue_date: d.issue_date,
    vendor_name: String(d.vendor_name ?? "").trim().slice(0, 255),
    create_partner: !!d.create_partner,
    walletable: d.walletable && d.walletable.id ? { id: Number(d.walletable.id), type: String(d.walletable.type) } : null,
    qualified_invoice: !!d.qualified_invoice,
    registration_number: d.registration_number ? String(d.registration_number).slice(0, 20) : null,
    memo: String(d.memo ?? "").slice(0, 255),
    lines: d.lines.map((l) => ({
      account_item_id: Number(l.account_item_id),
      tax_code: Number(l.tax_code),
      tax_rate: l.tax_rate ? String(l.tax_rate) : undefined,
      amount: Number(l.amount),
      description: String(l.description ?? "").slice(0, 250),
      reason: l.reason ? String(l.reason).slice(0, 200) : undefined,
    })),
  };
}

async function walletName(env: Env, d: EntryData): Promise<string> {
  if (!d.walletable) return "未決済";
  const cached = await env.STORE.get("masters");
  const m = cached ? (JSON.parse(cached) as Masters) : null;
  return m?.walletables.find((w) => w.id === d.walletable!.id)?.name ?? "";
}

// ---------- freee へのまとめて登録 ----------

interface SyncResult {
  processed: { id: string; vendor: string; amount: number; ok: boolean; deal_id?: number; error?: string }[];
  remaining: number;
}

/**
 * 受信箱の未登録分を古い順に最大 SYNC_BATCH 件 freee に登録する。
 * remaining > 0 なら、もう一度呼ぶと続きを処理する。
 * retryErrors=true でエラーになったものも再試行する。
 */
async function syncPending(env: Env, retryErrors: boolean): Promise<SyncResult> {
  const all = await listEntries(env);
  const targets = all
    .filter((s) => s.status === "pending" || (retryErrors && s.status === "error"))
    // 再試行時はエラー分を先に、その後は日付の古い順
    .sort((a, b) => (a.status === "error" ? 0 : 1) - (b.status === "error" ? 0 : 1) || a.date.localeCompare(b.date));
  const batch = targets.slice(0, SYNC_BATCH);
  const fc = await FreeeClient.create(env);
  const processed: SyncResult["processed"] = [];

  for (const s of batch) {
    const entry = await getEntry(env, s.id);
    if (!entry || entry.status === "done") continue;
    const name = await walletName(env, entry.data);
    try {
      await registerEntry(env, fc, entry, name);
      entry.status = "done";
      entry.synced_at = new Date().toISOString();
      delete entry.error;
      processed.push({ id: entry.id, vendor: entry.data.vendor_name, amount: entryTotal(entry.data), ok: true, deal_id: entry.deal_id });
    } catch (e) {
      if (e instanceof FreeeNotConnected) throw e;
      entry.status = "error";
      entry.error = errorMessage(e);
      processed.push({ id: entry.id, vendor: entry.data.vendor_name, amount: entryTotal(entry.data), ok: false, error: entry.error });
    }
    await saveEntry(env, entry, name);
  }
  return { processed, remaining: Math.max(0, targets.length - batch.length) };
}

/** 1件を freee に登録。段階ごとに保存するので、途中で失敗して再試行しても証憑が二重にならない */
async function registerEntry(env: Env, fc: FreeeClient, entry: Entry, walletLabel: string) {
  const d = entry.data;
  const total = entryTotal(d);

  // 1) 証憑（画像）をファイルボックスへ
  if (!entry.receipt_id) {
    const img = await getImage(env, entry.id);
    if (!img) throw new Error("画像が見つかりません");
    entry.receipt_id = await uploadReceipt(fc, d, img, entry.media_type as MediaType, total);
    await saveEntry(env, entry, walletLabel);
  }

  // 2) 取引先
  if (entry.partner_id === undefined) {
    entry.partner_id = d.create_partner && d.vendor_name ? await findOrCreatePartner(fc, d.vendor_name) : null;
  }

  // 3) 支出取引を作成して証憑を紐づけ
  const deal: Record<string, unknown> = {
    company_id: fc.companyId,
    issue_date: d.issue_date,
    type: "expense",
    receipt_ids: [entry.receipt_id],
    details: d.lines.map((l) => ({
      account_item_id: l.account_item_id,
      tax_code: l.tax_code,
      amount: l.amount,
      description: l.description || undefined,
    })),
  };
  if (entry.partner_id) deal.partner_id = entry.partner_id;
  if (d.walletable) {
    deal.payments = [{
      date: d.issue_date,
      from_walletable_type: d.walletable.type,
      from_walletable_id: d.walletable.id,
      amount: total,
    }];
  }
  const created = await fc.send("POST", "/api/1/deals", deal);
  entry.deal_id = created.deal?.id;
}

async function uploadReceipt(fc: FreeeClient, d: EntryData, base64: string, mediaType: MediaType, total: number): Promise<number> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const ext = mediaType.split("/")[1].replace("jpeg", "jpg");
  const build = (withMeta: boolean) => {
    const f = new FormData();
    f.set("company_id", String(fc.companyId));
    f.set("receipt", new Blob([bytes], { type: mediaType }), `receipt_${d.issue_date}.${ext}`);
    f.set("description", [d.vendor_name, d.memo].filter(Boolean).join(" / ").slice(0, 255));
    if (withMeta) {
      f.set("receipt_metadatum_partner_name", d.vendor_name.slice(0, 255));
      f.set("receipt_metadatum_issue_date", d.issue_date);
      f.set("receipt_metadatum_amount", String(total));
      f.set("qualified_invoice", d.qualified_invoice ? "qualified" : "not_qualified");
    }
    return f;
  };
  try {
    const r = await fc.postMultipart("/api/1/receipts", build(true));
    return r.receipt.id;
  } catch (e) {
    // メタデータ項目が受け付けられない場合は画像だけで再送
    if (e instanceof FreeeApiError && e.status === 400) {
      const r = await fc.postMultipart("/api/1/receipts", build(false));
      return r.receipt.id;
    }
    throw e;
  }
}

// ---------- 共通 ----------

class UserError extends Error {}

function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function checkImage(b: { image?: string; media_type?: string }): MediaType {
  if (!b.image || typeof b.image !== "string") throw new UserError("画像がありません");
  if (!MEDIA_TYPES.includes(b.media_type as MediaType)) throw new UserError("対応していない画像形式です");
  if (b.image.length > 8_000_000) throw new UserError("画像が大きすぎます");
  return b.media_type as MediaType;
}

function hasSyncToken(req: Request, env: Env): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  return !!env.SYNC_TOKEN && env.SYNC_TOKEN.length >= 16 && auth === `Bearer ${env.SYNC_TOKEN}`;
}

async function sessionValue(env: Env): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`receipt-app:${env.APP_PASSWORD}`));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function isLoggedIn(req: Request, env: Env): Promise<boolean> {
  if (!env.APP_PASSWORD) return false;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`));
  return !!m && m[1] === (await sessionValue(env));
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function errorMessage(e: unknown): string {
  if (e instanceof FreeeApiError) {
    try {
      const j = JSON.parse(e.body);
      const msg = j.errors?.flatMap((x: any) => x.messages ?? []).join(" / ") || j.message;
      if (msg) return `freee: ${msg}`;
    } catch {}
    return `freee: ${e.body.slice(0, 300)}`;
  }
  return e instanceof Error ? e.message : "不明なエラー";
}

function errorResponse(e: unknown): Response {
  if (e instanceof UserError) return json({ error: e.message }, 400);
  if (e instanceof FreeeNotConnected) return json({ error: e.message, need_auth: true }, 401);
  if (e instanceof FreeeApiError) return json({ error: errorMessage(e) }, 502);
  console.error(e);
  return json({ error: errorMessage(e) }, 500);
}
