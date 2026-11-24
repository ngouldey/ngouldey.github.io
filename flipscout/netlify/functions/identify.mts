// POST /api/identify  { images: base64 JPEG[], hint?: string }
// Photo -> (Google Lens + eBay photo search as hints) -> Claude identification.
import type { Config } from "@netlify/functions";
import { handler, HttpError, json, readJson, requireAccess, settle } from "../../lib/http.mts";
import { lensConfigured, lensSearch, type VisualMatch } from "../../lib/lens.mts";
import { ebayConfigured, searchByImage } from "../../lib/ebay.mts";
import { identifyItem } from "../../lib/claude.mts";

const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 2_000_000;

export function cleanImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_IMAGES).map((img, i) => {
    if (typeof img !== "string") throw new HttpError(400, `Photo ${i + 1} is not a string`);
    const data = img.replace(/^data:image\/[a-z]+;base64,/, "").replace(/\s/g, "");
    if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new HttpError(400, `Photo ${i + 1} is not base64 JPEG`);
    if (data.length > MAX_IMAGE_B64) throw new HttpError(413, `Photo ${i + 1} is too large`);
    return data;
  });
}

function providerState(r: { error: string | null } | null): string {
  if (!r) return "off";
  return r.error ? `error: ${r.error}` : "ok";
}

export default handler(async (req) => {
  requireAccess(req);
  const body = await readJson<{ images?: unknown; hint?: unknown }>(req, 6_000_000);
  const images = cleanImages(body.images);
  if (!images.length) throw new HttpError(400, "Send at least one photo.");
  const hint = typeof body.hint === "string" ? body.hint.trim().slice(0, 500) : "";

  const first = images[0];
  const [lens, ebayPhoto] = await Promise.all([
    lensConfigured() ? settle(() => lensSearch(first)) : null,
    ebayConfigured() ? settle(() => searchByImage(first)) : null,
  ]);

  const matches: VisualMatch[] = [
    ...(lens?.value?.matches ?? []),
    ...(ebayPhoto?.value ?? []).slice(0, 8).map((l) => ({
      title: l.title,
      source: "eBay",
      link: l.url,
      thumbnail: l.image,
      price: l.price,
      priceText: null,
      via: "eBay photo match" as const,
    })),
  ];

  const id = await identifyItem({ images, hint, matches, related: lens?.value?.related ?? [] });
  return json({
    id,
    matches,
    providers: { lens: providerState(lens), ebayPhoto: providerState(ebayPhoto) },
  });
});

export const config: Config = { path: "/api/identify", method: "POST" };
