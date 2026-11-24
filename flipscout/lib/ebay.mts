// eBay's official Browse API: live (active) listings and search-by-photo.
// Needs a free eBay developer keyset: EBAY_CLIENT_ID + EBAY_CLIENT_SECRET (production).
import { env, num } from "./http.mts";

const API = "https://api.ebay.com";
const MARKETPLACE = () => env("EBAY_MARKETPLACE") ?? "EBAY_US";

export interface Listing {
  id: string;
  title: string;
  price: number | null;
  shipping: number | null;
  currency: string;
  url: string;
  image: string | null;
  condition: string | null;
  format: "auction" | "fixed" | "other";
  bids: number | null;
  source: string;
}

export function ebayConfigured(): boolean {
  return Boolean(env("EBAY_CLIENT_ID") && env("EBAY_CLIENT_SECRET"));
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const id = env("EBAY_CLIENT_ID");
  const secret = env("EBAY_CLIENT_SECRET");
  if (!id || !secret) throw new Error("eBay keys not set");
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`eBay sign-in failed (${res.status}): ${body.error_description ?? "check EBAY_CLIENT_ID/SECRET"}`);
  }
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 };
  return cachedToken.token;
}

async function browse(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await appToken();
  const res = await fetch(`${API}/buy/browse/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "x-ebay-c-marketplace-id": MARKETPLACE(),
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(12_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { errors?: { message?: string }[] }).errors?.[0]?.message ?? res.statusText;
    throw new Error(`eBay ${res.status}: ${msg}`);
  }
  return body;
}

interface ItemSummary {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  currentBidPrice?: { value?: string; currency?: string };
  bidCount?: number;
  buyingOptions?: string[];
  condition?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: { imageUrl?: string }[];
  itemWebUrl?: string;
  shippingOptions?: { shippingCost?: { value?: string } }[];
}

export function normalizeItem(s: ItemSummary, source = "eBay"): Listing {
  const options = s.buyingOptions ?? [];
  const format = options.includes("FIXED_PRICE") ? "fixed" : options.includes("AUCTION") ? "auction" : "other";
  return {
    id: s.itemId ?? "",
    title: s.title ?? "",
    price: num(s.price?.value) ?? num(s.currentBidPrice?.value),
    shipping: num(s.shippingOptions?.[0]?.shippingCost?.value),
    currency: s.price?.currency ?? s.currentBidPrice?.currency ?? "USD",
    url: s.itemWebUrl ?? "",
    image: s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl ?? null,
    condition: s.condition ?? null,
    format,
    bids: typeof s.bidCount === "number" ? s.bidCount : null,
    source,
  };
}

/** Active listings for a keyword query. `total` is eBay's full count, not just this page. */
export async function searchActive(query: string, limit = 50): Promise<{ total: number; items: Listing[] }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const body = (await browse(`/item_summary/search?${params}`)) as { total?: number; itemSummaries?: ItemSummary[] };
  const items = (body.itemSummaries ?? []).map((s) => normalizeItem(s));
  return { total: typeof body.total === "number" ? body.total : items.length, items };
}

/** eBay's own visual search: listings that look like the photo. */
export async function searchByImage(jpegBase64: string, limit = 12): Promise<Listing[]> {
  const body = (await browse(`/item_summary/search_by_image?limit=${limit}`, {
    method: "POST",
    body: JSON.stringify({ image: jpegBase64 }),
  })) as { itemSummaries?: ItemSummary[] };
  return (body.itemSummaries ?? []).map((s) => normalizeItem(s, "eBay photo match"));
}

export function ebaySoldSearchUrl(query: string): string {
  const params = new URLSearchParams({ _nkw: query, LH_Sold: "1", LH_Complete: "1" });
  return `https://www.ebay.com/sch/i.html?${params}`;
}
