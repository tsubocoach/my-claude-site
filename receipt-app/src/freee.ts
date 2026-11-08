// freee 会計 API とのやり取り（OAuth・マスタ取得・証憑アップロード・取引登録）

export interface Env {
  STORE: KVNamespace;
  ANTHROPIC_API_KEY: string;
  FREEE_CLIENT_ID: string;
  FREEE_CLIENT_SECRET: string;
  FREEE_REDIRECT_URI: string;
  APP_PASSWORD: string;
  SYNC_TOKEN?: string; // 任意: ショートカット等から /api/sync を呼ぶための合言葉
}

const AUTH_BASE = "https://accounts.secure.freee.co.jp/public_api";
const API_BASE = "https://api.freee.co.jp";
const TOKEN_KEY = "freee_token";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  company_id: number | null;
}

export class FreeeNotConnected extends Error {}
export class FreeeApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`freee API ${status}: ${body}`);
  }
}

export function authorizeUrl(env: Env, state: string): string {
  const u = new URL(`${AUTH_BASE}/authorize`);
  u.searchParams.set("client_id", env.FREEE_CLIENT_ID);
  u.searchParams.set("redirect_uri", env.FREEE_REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("prompt", "select_company");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
      ...params,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new FreeeApiError(res.status, text);
  return JSON.parse(text);
}

function toStored(t: any, prevCompany: number | null): StoredToken {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in ?? 21600) - 300) * 1000,
    company_id: t.company_id ? Number(t.company_id) : prevCompany,
  };
}

export async function exchangeCode(env: Env, code: string): Promise<void> {
  const t = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.FREEE_REDIRECT_URI,
  });
  let stored = toStored(t, null);
  if (!stored.company_id) {
    // prompt=select_company で company_id が返らなかった場合は最初の事業所を使う
    const me = await rawGet(stored.access_token, "/api/1/companies");
    stored.company_id = me.companies?.[0]?.id ?? null;
  }
  await env.STORE.put(TOKEN_KEY, JSON.stringify(stored));
  await env.STORE.delete("masters"); // 事業所が変わる可能性があるのでキャッシュを消す
}

export async function disconnect(env: Env): Promise<void> {
  await env.STORE.delete(TOKEN_KEY);
  await env.STORE.delete("masters");
}

async function getToken(env: Env): Promise<StoredToken> {
  const raw = await env.STORE.get(TOKEN_KEY);
  if (!raw) throw new FreeeNotConnected("freee未連携");
  let tok = JSON.parse(raw) as StoredToken;
  if (Date.now() >= tok.expires_at) {
    try {
      const t = await tokenRequest(env, {
        grant_type: "refresh_token",
        refresh_token: tok.refresh_token,
      });
      tok = toStored(t, tok.company_id);
      await env.STORE.put(TOKEN_KEY, JSON.stringify(tok));
    } catch (e) {
      if (e instanceof FreeeApiError && (e.status === 400 || e.status === 401)) {
        await env.STORE.delete(TOKEN_KEY);
        throw new FreeeNotConnected("freeeの認証が切れました。再連携してください");
      }
      throw e;
    }
  }
  return tok;
}

async function rawGet(accessToken: string, path: string, query: Record<string, string | number> = {}) {
  const u = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new FreeeApiError(res.status, text);
  return JSON.parse(text);
}

export class FreeeClient {
  private constructor(private env: Env, private tok: StoredToken) {}

  static async create(env: Env): Promise<FreeeClient> {
    return new FreeeClient(env, await getToken(env));
  }

  get companyId(): number {
    if (!this.tok.company_id) throw new FreeeNotConnected("事業所が選択されていません");
    return this.tok.company_id;
  }

  get(path: string, query: Record<string, string | number> = {}) {
    return rawGet(this.tok.access_token, path, { company_id: this.companyId, ...query });
  }

  /** company_id をクエリに付けない GET（パスに company_id が含まれるエンドポイント用） */
  getPlain(path: string) {
    return rawGet(this.tok.access_token, path);
  }

  async send(method: "POST" | "PUT", path: string, body: unknown) {
    const res = await fetch(API_BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.tok.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new FreeeApiError(res.status, text);
    return JSON.parse(text);
  }

  async postMultipart(path: string, form: FormData) {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.tok.access_token}`, Accept: "application/json" },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new FreeeApiError(res.status, text);
    return JSON.parse(text);
  }
}

// ---------- マスタ（勘定科目・税区分・口座） ----------

export interface AccountItem { id: number; name: string; category: string; default_tax_code: number }
export interface Walletable { id: number; type: "bank_account" | "credit_card" | "wallet"; name: string }
export interface TaxOption { code: number; name: string; name_ja: string }
export interface Masters {
  company_id: number;
  company_name: string;
  account_items: AccountItem[];
  walletables: Walletable[];
  taxes: TaxOption[];
}

// レシート・領収書の経費計上で使いそうな科目区分だけに絞る
const EXPENSE_CATEGORIES = new Set([
  "経費", "売上原価", "製品売上原価", "有形固定資産", "無形固定資産", "他流動資産", "事業主貸", "棚卸資産",
]);

// 仕入側で使う税区分（会社で利用可能なもののみ表示）
const PURCHASE_TAX_NAMES = [
  "purchase_with_tax_10",
  "purchase_with_tax_reduced_8",
  "purchase_with_tax_10_exempt_80",
  "purchase_with_tax_reduced_8_exempt_80",
  "purchase_with_tax_10_exempt_70",
  "purchase_with_tax_reduced_8_exempt_70",
  "purchase_no_tax",
  "non_taxable",
  "without_tax",
];

export async function loadMasters(env: Env, fc: FreeeClient, force = false): Promise<Masters> {
  if (!force) {
    const cached = await env.STORE.get("masters");
    if (cached) {
      const m = JSON.parse(cached) as Masters;
      if (m.company_id === fc.companyId) return m;
    }
  }
  const [items, wallets, taxes, company] = await Promise.all([
    fc.get("/api/1/account_items"),
    fc.get("/api/1/walletables"),
    fc.getPlain(`/api/1/taxes/companies/${fc.companyId}`),
    fc.getPlain(`/api/1/companies/${fc.companyId}`),
  ]);
  const m: Masters = {
    company_id: fc.companyId,
    company_name: company.company?.display_name ?? company.company?.name ?? "",
    account_items: (items.account_items as any[])
      .filter((i) => i.available && EXPENSE_CATEGORIES.has(i.account_category))
      .map((i) => ({ id: i.id, name: i.name, category: i.account_category, default_tax_code: i.default_tax_code })),
    walletables: (wallets.walletables as any[]).map((w) => ({ id: w.id, type: w.type, name: w.name })),
    taxes: PURCHASE_TAX_NAMES.map((n) => (taxes.taxes as any[]).find((t) => t.name === n && t.available))
      .filter(Boolean)
      .map((t: any) => ({ code: t.code, name: t.name, name_ja: t.name_ja })),
  };
  await env.STORE.put("masters", JSON.stringify(m), { expirationTtl: 60 * 60 * 24 });
  return m;
}

// ---------- 取引先 ----------

export async function findOrCreatePartner(fc: FreeeClient, name: string): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const found = await fc.get("/api/1/partners", { keyword: trimmed, limit: 50 });
  const exact = (found.partners as any[]).find((p) => p.name === trimmed || p.shortcut1 === trimmed);
  if (exact) return exact.id;
  const created = await fc.send("POST", "/api/1/partners", { company_id: fc.companyId, name: trimmed });
  return created.partner.id;
}

// ---------- 重複チェック ----------

export async function findSimilarDeals(fc: FreeeClient, date: string, amount: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) return [];
  const res = await fc.get("/api/1/deals", {
    type: "expense",
    start_issue_date: date,
    end_issue_date: date,
    limit: 100,
  });
  return (res.deals as any[])
    .filter((d) => d.amount === amount)
    .map((d) => ({ id: d.id, issue_date: d.issue_date, amount: d.amount }));
}
