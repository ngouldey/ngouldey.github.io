// POST /api/comps  { query, name?, details?, research?: boolean }
// Live eBay supply (official Browse API) + sold-price research -> value and demand.
import type { Config } from "@netlify/functions";
import { handler, HttpError, json, readJson, requireAccess, settle } from "../../lib/http.mts";
import { ebayConfigured, searchActive, type Listing } from "../../lib/ebay.mts";
import { claudeConfigured, researchMarket } from "../../lib/claude.mts";
import { summarize } from "../../public/calc.js";

// Netlify stops synchronous functions at 60 s; leave room to build the response.
const TIME_BUDGET_MS = 53_000;

type Summary = ReturnType<typeof summarize>;

export function describeActive(total: number | null, summary: Summary, items: Listing[]): string {
  if (total == null) return "Live eBay supply: not available.";
  const titles = items.slice(0, 8).map((i) => `- ${i.title}${i.price != null ? ` ($${i.price})` : ""}`);
  const asking = summary
    ? ` Fixed-price asking prices: median $${summary.median}, middle half $${summary.p25}-$${summary.p75}.`
    : "";
  return `Live eBay supply right now: ${total} active listings for this query.${asking}\nFirst active listings:\n${titles.join("\n")}`;
}

export default handler(async (req) => {
  const started = Date.now();
  requireAccess(req);
  const body = await readJson<{ query?: unknown; name?: unknown; details?: unknown; research?: unknown }>(req, 20_000);
  const query = typeof body.query === "string" ? body.query.trim().slice(0, 200) : "";
  if (!query) throw new HttpError(400, "Missing search query.");
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : query;
  const details = typeof body.details === "string" ? body.details.trim().slice(0, 600) : "";
  const wantResearch = body.research !== false;

  const active = ebayConfigured() ? await settle(() => searchActive(query, 50)) : null;
  const activeItems = active?.value?.items ?? [];
  const askingSummary = summarize(
    activeItems.filter((i) => i.format === "fixed" && i.price != null).map((i) => i.price as number),
  );
  const activeTotal = active?.value?.total ?? null;

  const research =
    wantResearch && claudeConfigured()
      ? await settle(() =>
          researchMarket({
            name,
            query,
            details,
            activeSummary: describeActive(activeTotal, askingSummary, activeItems),
            timeBudgetMs: TIME_BUDGET_MS - (Date.now() - started),
          }),
        )
      : null;

  const comps = (research?.value?.sold_comps ?? []).filter((c) => Number.isFinite(c.price_usd) && c.price_usd > 0);
  const soldSummary = summarize(comps.map((c) => c.price_usd));
  const estimate = research?.value?.estimated_value;

  let value: { low: number; typical: number; high: number; basis: string } | null = null;
  if (soldSummary && soldSummary.count >= 3) {
    value = {
      low: soldSummary.p25,
      typical: soldSummary.median,
      high: soldSummary.p75,
      basis: `${soldSummary.count} sold comps`,
    };
  } else if (estimate && estimate.typical > 0) {
    const basis = comps.length ? `AI estimate from ${comps.length} comp${comps.length > 1 ? "s" : ""}` : "AI estimate";
    value = { ...estimate, basis };
  }

  return json({
    query,
    active: {
      configured: ebayConfigured(),
      total: activeTotal,
      asking: askingSummary,
      items: activeItems.slice(0, 24),
      error: active?.error ?? null,
    },
    sold: {
      source: research ? "web" : "none",
      items: comps,
      summary: soldSummary,
      // Filled by a sold-data provider (eBay Marketplace Insights or a paid comps API) once one is wired in.
      count90: null,
      error: research?.error ?? null,
    },
    research: research?.value
      ? {
          demand: research.value.demand,
          demand_reason: research.value.demand_reason,
          typical_days_to_sell: research.value.typical_days_to_sell,
          pricing_tips: research.value.pricing_tips,
          confidence: research.value.confidence,
          estimate: research.value.estimated_value,
        }
      : null,
    value,
    ms: Date.now() - started,
  });
});

export const config: Config = { path: "/api/comps", method: "POST" };
