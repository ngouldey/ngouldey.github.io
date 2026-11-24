import Anthropic from "@anthropic-ai/sdk";
import type { Beta } from "@anthropic-ai/sdk/resources";
import { env, HttpError } from "./http.mts";
import type { VisualMatch } from "./lens.mts";

// Change with the CLAUDE_MODEL env var (e.g. claude-sonnet-5-5 for roughly half the cost).
export const model = () => env("CLAUDE_MODEL") ?? "claude-opus-5-5";

// On a safety decline, the API retries on the model Anthropic recommends for that case.
const BETAS: Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

export function claudeConfigured(): boolean {
  return Boolean(env("ANTHROPIC_API_KEY"));
}

function client(timeoutMs: number): Anthropic {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new HttpError(503, "ANTHROPIC_API_KEY is not set on the server.");
  // Netlify cuts functions off at 60 s, so no automatic retries; callers retry once by hand.
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
}

function isTransient(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.InternalServerError ||
    err instanceof Anthropic.APIConnectionError
  );
}

function explain(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, "Anthropic rejected the API key.");
  if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, "Claude is rate limited right now. Try again in a minute.");
  if (err instanceof Anthropic.APIConnectionTimeoutError) throw new HttpError(504, "Claude took too long. Try again.");
  if (err instanceof Anthropic.APIError) throw new HttpError(502, `Claude error ${err.status ?? ""}: ${err.message}`);
  throw err;
}

/** One manual retry for transient failures, only if there is still time before Netlify's limit. */
async function withRetry<T>(fn: () => Promise<T>, startedAt: number, budgetMs: number): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isTransient(err) && Date.now() - startedAt < budgetMs / 3) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        return await fn();
      } catch (err2) {
        explain(err2);
      }
    }
    explain(err);
  }
}

function checkStop(msg: Beta.BetaMessage): void {
  if (msg.stop_reason === "refusal") {
    throw new HttpError(422, "Claude declined to analyze this. Try a different photo or describe the item instead.");
  }
  if (msg.stop_reason === "max_tokens") throw new HttpError(502, "Claude's answer was cut off. Try again.");
}

// ---------------------------------------------------------------- identify

export interface Identification {
  name: string;
  brand: string;
  model_or_pattern: string;
  category: string;
  era: string;
  materials: string;
  condition_notes: string;
  identifiers_seen: string[];
  confidence: "high" | "medium" | "low";
  search_query: string;
  alt_queries: string[];
  alternatives: { name: string; search_query: string }[];
  verify_tips: string[];
  red_flags: string[];
  shipping: { size_class: "small" | "medium" | "large" | "oversize"; est_weight_lb: number; est_cost_usd: number };
  quick_value: { low: number; high: number; note: string };
}

const str = { type: "string" } as const;
const strArr = { type: "array", items: { type: "string" } } as const;

const ID_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name", "brand", "model_or_pattern", "category", "era", "materials", "condition_notes",
    "identifiers_seen", "confidence", "search_query", "alt_queries", "alternatives",
    "verify_tips", "red_flags", "shipping", "quick_value",
  ],
  properties: {
    name: { type: "string", description: "Specific item name a buyer would recognize, e.g. 'Pyrex Butterprint 403 2.5 qt mixing bowl'" },
    brand: { type: "string", description: "Maker/brand, or '' if unknown" },
    model_or_pattern: { type: "string", description: "Model number, pattern, line or edition, or ''" },
    category: str,
    era: { type: "string", description: "Approximate decade/age, or ''" },
    materials: str,
    condition_notes: { type: "string", description: "Visible wear, damage or missing parts" },
    identifiers_seen: { ...strArr, description: "Text, marks, labels, UPC/ISBN or model numbers read from the photos" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    search_query: { type: "string", description: "Best eBay search for sold comps, 3-8 words, how an experienced reseller would type it" },
    alt_queries: { ...strArr, description: "Up to 3 other useful searches (broader or more specific)" },
    alternatives: {
      type: "array",
      description: "Up to 3 other things it could be, if confidence is not high",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "search_query"],
        properties: { name: str, search_query: str },
      },
    },
    verify_tips: { ...strArr, description: "Quick checks to do in the store that confirm the ID or change the value" },
    red_flags: { ...strArr, description: "Reproductions, damage, missing parts, recalls, hard-to-ship issues" },
    shipping: {
      type: "object",
      additionalProperties: false,
      required: ["size_class", "est_weight_lb", "est_cost_usd"],
      properties: {
        size_class: { type: "string", enum: ["small", "medium", "large", "oversize"] },
        est_weight_lb: { type: "number", description: "Packed weight estimate" },
        est_cost_usd: { type: "number", description: "Typical US ground label cost, packed" },
      },
    },
    quick_value: {
      type: "object",
      additionalProperties: false,
      required: ["low", "high", "note"],
      properties: {
        low: { type: "number" },
        high: { type: "number" },
        note: { type: "string", description: "One line on what drives the price" },
      },
    },
  },
} as const;

const ID_SYSTEM = `You identify secondhand items from photos for a reseller standing in a thrift store, estate sale or garage sale, deciding in seconds whether to buy something to flip on eBay.

Be specific. Read every visible mark, label, tag, stamp, model number, UPC or ISBN and use it. Name the maker, the model/pattern/line, the size and the era when the photos support it. Visual matches from Google Lens and eBay image search are supplied as evidence when available; use them to confirm or sharpen your identification, but they are often wrong or only similar, so trust what is visible in the photos over them.

search_query is what you would type into eBay's sold-listings search to find true comps: brand + model/pattern + item type + the one detail that changes value (size, color, edition). No condition words, no "vintage" unless it is part of how the item is sold, no quotation marks. When unsure, prefer a slightly broader query that still returns the right item.

confidence is honest: "low" when you are guessing from the general type. quick_value is your own rough sense of what one sells for on eBay in the condition shown, in USD; real comps are fetched separately, so keep it short.`;

function matchesText(matches: VisualMatch[], related: string[]): string {
  if (!matches.length && !related.length) return "";
  const lines = matches.slice(0, 15).map((m) => {
    const price = m.priceText ?? (m.price != null ? `$${m.price}` : "");
    return `- [${m.via}] ${m.title}${m.source ? ` (${m.source})` : ""}${price ? ` ${price}` : ""}`;
  });
  const rel = related.length ? `\nRelated searches Google suggested: ${related.join("; ")}` : "";
  return `\n\nVisual matches for the first photo:\n${lines.join("\n")}${rel}`;
}

export async function identifyItem(input: {
  images: string[];
  hint: string;
  matches: VisualMatch[];
  related: string[];
}): Promise<Identification> {
  const started = Date.now();
  const content: Beta.BetaContentBlockParam[] = input.images.map((data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  }));
  const hint = input.hint ? `\n\nThe reseller adds: ${input.hint}` : "";
  content.push({
    type: "text",
    text: `Identify this item for resale.${hint}${matchesText(input.matches, input.related)}`,
  });

  const msg = await withRetry(
    () =>
      client(40_000).beta.messages.create({
        model: model(),
        max_tokens: 16000,
        betas: BETAS,
        fallbacks: "default",
        system: ID_SYSTEM,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: ID_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: "user", content }],
      }),
    started,
    45_000,
  );
  checkStop(msg);
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).pop();
  if (!text) throw new HttpError(502, "Claude returned no identification.");
  try {
    return JSON.parse(text) as Identification;
  } catch {
    throw new HttpError(502, "Claude's identification was not valid JSON.");
  }
}

// ---------------------------------------------------------------- market research

export interface MarketResearch {
  sold_comps: { title: string; price_usd: number; sold_date: string; source: string; url: string; condition: string }[];
  estimated_value: { low: number; typical: number; high: number };
  demand: "very_high" | "high" | "medium" | "low" | "very_low";
  demand_reason: string;
  typical_days_to_sell: string;
  pricing_tips: string;
  confidence: "high" | "medium" | "low";
}

const REPORT_TOOL: Beta.BetaTool = {
  name: "report_market",
  description:
    "Report the sold comps you found and your resale estimate for the item. Call this exactly once, after searching.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "sold_comps", "estimated_value", "demand", "demand_reason",
      "typical_days_to_sell", "pricing_tips", "confidence",
    ],
    properties: {
      sold_comps: {
        type: "array",
        description: "Up to 12 real completed sales of this same item, most recent first. Never include asking prices of unsold listings.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "price_usd", "sold_date", "source", "url", "condition"],
          properties: {
            title: str,
            price_usd: { type: "number", description: "Final sale price, excluding shipping when known" },
            sold_date: { type: "string", description: "YYYY-MM-DD or YYYY-MM if known, else ''" },
            source: { type: "string", description: "eBay, Mercari, Poshmark, Etsy, WorthPoint, auction house..." },
            url: str,
            condition: { type: "string", description: "new, used, for parts, etc. or ''" },
          },
        },
      },
      estimated_value: {
        type: "object",
        additionalProperties: false,
        required: ["low", "typical", "high"],
        properties: { low: { type: "number" }, typical: { type: "number" }, high: { type: "number" } },
        description: "Realistic USD sale price for one unit in average used condition",
      },
      demand: { type: "string", enum: ["very_high", "high", "medium", "low", "very_low"] },
      demand_reason: { type: "string", description: "One or two sentences on how fast it sells and why" },
      typical_days_to_sell: { type: "string", description: "e.g. '1-2 weeks'" },
      pricing_tips: { type: "string", description: "How to list it for best result (bundle, auction vs fixed, what to photograph)" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
  },
};

const RESEARCH_SYSTEM = `You are a resale pricing researcher. Find what an item actually SELLS for — completed sales, not asking prices — so a reseller can decide whether to buy it.

eBay's own sold-listings search requires sign-in, so look for individual eBay listing pages that show a sold price, WorthPoint and price-guide entries, Mercari/Poshmark sold items, Etsy, auction results, collector forums and similar. Prefer sales from the last 6 months. Only count sales of the same item (same model/pattern/size; lots and parts-only units do not count unless the item is usually sold that way). Asking prices of unsold listings are not comps.

Use at most 4 searches, then call report_market once. Be conservative: if evidence is thin, say so through confidence and a wider range rather than inventing comps. Never invent a URL; use the page where you saw the sale.`;

export async function researchMarket(input: {
  name: string;
  query: string;
  details: string;
  activeSummary: string;
  timeBudgetMs: number;
}): Promise<MarketResearch> {
  const started = Date.now();
  const prompt = `Item: ${input.name}
eBay search query: ${input.query}${input.details ? `\nDetails: ${input.details}` : ""}
${input.activeSummary}

Find recent sold prices for this item and estimate its resale value and how fast it sells.`;

  const tools: Beta.BetaToolUnion[] = [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }, REPORT_TOOL];
  let messages: Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];

  for (let turn = 0; turn < 3; turn++) {
    const remaining = input.timeBudgetMs - (Date.now() - started);
    if (remaining < 8_000) break;
    const msg = await withRetry(
      () =>
        client(remaining).beta.messages.create({
          model: model(),
          max_tokens: 16000,
          betas: BETAS,
          fallbacks: "default",
          system: RESEARCH_SYSTEM,
          output_config: { effort: "medium" },
          tools,
          tool_choice: { type: "auto" },
          messages,
        }),
      started,
      input.timeBudgetMs,
    );
    if (msg.stop_reason === "refusal") checkStop(msg);

    const report = msg.content.find((b) => b.type === "tool_use" && b.name === "report_market");
    if (report && report.type === "tool_use") return report.input as MarketResearch;

    if (msg.stop_reason === "pause_turn") {
      // Server-side search loop paused; send the turn back unchanged and it resumes.
      messages = [...messages, { role: "assistant", content: msg.content }];
      continue;
    }
    if (msg.stop_reason === "max_tokens") break;
    // Finished without reporting: ask once more for the structured report.
    messages = [
      ...messages,
      { role: "assistant", content: msg.content },
      { role: "user", content: "Call report_market now with what you found." },
    ];
  }
  throw new HttpError(504, "Price research ran out of time. Tap retry, or open eBay sold listings.");
}
