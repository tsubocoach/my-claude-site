// レシート → freee 登録アプリ（Cloudflare Worker）
import { analyzeReceipt } from "./claude";
import {
  type Env,
  FreeeApiError,
  FreeeClient,
  FreeeNotConnected,
  authorizeUrl,
  disconnect,
  exchangeCode,
  findOrCreatePartner,
  findSimilarDeals,
  loadMasters,
} from "./freee";
import { APP_HTML, LOGIN_HTML } from "./ui";

const COOKIE = "rf_session";
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

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
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
    const analysis = await analyzeReceipt(env.ANTHROPIC_API_KEY, masters, rules, body.image, mediaType, today);

    // 一覧に無い科目・口座が返ってきた場合は空にして、画面で選んでもらう
    const itemIds = new Set(masters.account_items.map((a) => a.id));
    for (const l of analysis.lines) if (!itemIds.has(l.account_item_id)) l.account_item_id = 0;
    if (analysis.suggested_walletable_id && !masters.walletables.some((w) => w.id === analysis.suggested_walletable_id)) {
      analysis.suggested_walletable_id = null;
    }
    const duplicates = await findSimilarDeals(fc, analysis.issue_date, analysis.total_amount).catch(() => []);
    return json({ analysis, duplicates });
  }

  if (pathname === "/api/submit" && method === "POST") {
    const body = (await req.json()) as SubmitBody;
    return json(await submit(env, body));
  }

  return json({ error: "Not found" }, 404);
}

// ---------- freee への登録 ----------

interface SubmitBody {
  image: string;
  media_type: string;
  issue_date: string;
  vendor_name: string;
  create_partner: boolean;
  walletable: { id: number; type: string } | null; // null = 未決済
  qualified_invoice: boolean;
  memo: string;
  lines: { account_item_id: number; tax_code: number; amount: number; description: string }[];
}

async function submit(env: Env, b: SubmitBody) {
  const mediaType = checkImage(b);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.issue_date)) throw new UserError("日付を YYYY-MM-DD で入力してください");
  if (!b.lines?.length) throw new UserError("明細が空です");
  for (const l of b.lines) {
    if (!l.account_item_id) throw new UserError("勘定科目が未選択の行があります");
    if (!Number.isInteger(l.amount) || l.amount <= 0) throw new UserError("金額が正しくない行があります");
  }
  const total = b.lines.reduce((s, l) => s + l.amount, 0);
  const fc = await FreeeClient.create(env);

  // 1) 証憑（画像）をファイルボックスにアップロード
  const receiptId = await uploadReceipt(fc, b, mediaType, total);

  // 2) 取引先
  const partnerId = b.create_partner && b.vendor_name ? await findOrCreatePartner(fc, b.vendor_name) : null;

  // 3) 取引（支出）を作成し、証憑を紐づける
  const deal: Record<string, unknown> = {
    company_id: fc.companyId,
    issue_date: b.issue_date,
    type: "expense",
    receipt_ids: [receiptId],
    details: b.lines.map((l) => ({
      account_item_id: l.account_item_id,
      tax_code: l.tax_code,
      amount: l.amount,
      description: l.description?.slice(0, 250) || undefined,
    })),
  };
  if (partnerId) deal.partner_id = partnerId;
  if (b.walletable) {
    deal.payments = [{
      date: b.issue_date,
      from_walletable_type: b.walletable.type,
      from_walletable_id: b.walletable.id,
      amount: total,
    }];
  }
  const created = await fc.send("POST", "/api/1/deals", deal);
  return { ok: true, deal_id: created.deal?.id, receipt_id: receiptId, amount: total };
}

async function uploadReceipt(fc: FreeeClient, b: SubmitBody, mediaType: MediaType, total: number): Promise<number> {
  const bytes = Uint8Array.from(atob(b.image), (c) => c.charCodeAt(0));
  const ext = mediaType.split("/")[1].replace("jpeg", "jpg");
  const build = (withMeta: boolean) => {
    const f = new FormData();
    f.set("company_id", String(fc.companyId));
    f.set("receipt", new Blob([bytes], { type: mediaType }), `receipt_${b.issue_date}.${ext}`);
    f.set("description", [b.vendor_name, b.memo].filter(Boolean).join(" / ").slice(0, 255));
    if (withMeta) {
      f.set("receipt_metadatum_partner_name", b.vendor_name.slice(0, 255));
      f.set("receipt_metadatum_issue_date", b.issue_date);
      f.set("receipt_metadatum_amount", String(total));
      f.set("qualified_invoice", b.qualified_invoice ? "qualified" : "not_qualified");
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

function checkImage(b: { image?: string; media_type?: string }): MediaType {
  if (!b.image || typeof b.image !== "string") throw new UserError("画像がありません");
  if (!MEDIA_TYPES.includes(b.media_type as MediaType)) throw new UserError("対応していない画像形式です");
  if (b.image.length > 8_000_000) throw new UserError("画像が大きすぎます");
  return b.media_type as MediaType;
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

function errorResponse(e: unknown): Response {
  if (e instanceof UserError) return json({ error: e.message }, 400);
  if (e instanceof FreeeNotConnected) return json({ error: e.message, need_auth: true }, 401);
  if (e instanceof FreeeApiError) {
    let msg = e.body;
    try {
      const j = JSON.parse(e.body);
      msg = j.errors?.flatMap((x: any) => x.messages ?? []).join(" / ") || j.message || e.body;
    } catch {}
    return json({ error: `freee: ${msg}` }, 502);
  }
  console.error(e);
  return json({ error: e instanceof Error ? e.message : "不明なエラー" }, 500);
}
