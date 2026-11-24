// Google Lens results via SerpApi (Google has no public Lens API).
// SerpApi's Image API takes a direct upload (JPG/PNG/WebP up to ~500 KB) and returns
// an image_id that the google_lens engine accepts for about ten minutes.
import { env, num } from "./http.mts";

const SERPAPI = "https://serpapi.com";

export interface VisualMatch {
  title: string;
  source: string;
  link: string;
  thumbnail: string | null;
  price: number | null;
  priceText: string | null;
  via: "Google Lens" | "eBay photo match";
}

export interface LensResult {
  matches: VisualMatch[];
  related: string[];
}

export function lensConfigured(): boolean {
  return Boolean(env("SERPAPI_KEY"));
}

async function uploadImage(jpegBase64: string, key: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([Buffer.from(jpegBase64, "base64")], { type: "image/jpeg" }), "item.jpg");
  form.append("api_key", key);
  const res = await fetch(`${SERPAPI}/image?api_key=${encodeURIComponent(key)}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(12_000),
  });
  const body = (await res.json().catch(() => ({}))) as { image_id?: string; id?: string; error?: string };
  const id = body.image_id ?? body.id;
  if (!res.ok || !id) throw new Error(`Lens upload failed (${res.status}): ${body.error ?? "no image id returned"}`);
  return id;
}

interface LensBody {
  error?: string;
  visual_matches?: {
    title?: string;
    source?: string;
    link?: string;
    thumbnail?: string;
    price?: { value?: string; extracted_value?: number };
  }[];
  related_content?: { query?: string }[];
}

export function normalizeLens(body: LensBody): LensResult {
  const matches: VisualMatch[] = (body.visual_matches ?? [])
    .filter((m) => m.title && m.link)
    .slice(0, 12)
    .map((m) => ({
      title: m.title ?? "",
      source: m.source ?? "",
      link: m.link ?? "",
      thumbnail: m.thumbnail ?? null,
      price: num(m.price?.extracted_value) ?? num(m.price?.value),
      priceText: m.price?.value ?? null,
      via: "Google Lens",
    }));
  const related = (body.related_content ?? []).map((r) => r.query ?? "").filter(Boolean).slice(0, 6);
  return { matches, related };
}

export async function lensSearch(jpegBase64: string): Promise<LensResult> {
  const key = env("SERPAPI_KEY");
  if (!key) throw new Error("SERPAPI_KEY not set");
  const imageId = await uploadImage(jpegBase64, key);
  const params = new URLSearchParams({
    engine: "google_lens",
    image_id: imageId,
    hl: "en",
    country: "us",
    api_key: key,
  });
  const res = await fetch(`${SERPAPI}/search.json?${params}`, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => ({}))) as LensBody;
  if (!res.ok || body.error) throw new Error(`Lens search failed (${res.status}): ${body.error ?? res.statusText}`);
  return normalizeLens(body);
}
