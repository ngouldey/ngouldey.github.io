// GET /api/status - checks the access code and reports which data sources are set up.
import type { Config } from "@netlify/functions";
import { handler, json, requireAccess } from "../../lib/http.mts";
import { claudeConfigured, model } from "../../lib/claude.mts";
import { lensConfigured } from "../../lib/lens.mts";
import { ebayConfigured } from "../../lib/ebay.mts";

export default handler(async (req) => {
  requireAccess(req);
  return json({
    ok: true,
    model: model(),
    providers: { claude: claudeConfigured(), lens: lensConfigured(), ebay: ebayConfigured() },
  });
});

export const config: Config = { path: "/api/status", method: "GET" };
