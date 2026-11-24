// End-to-end tests of the Netlify functions with all outside APIs faked.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installMockFetch } from "../scripts/mock-upstream.mjs";
import identify from "../netlify/functions/identify.mts";
import comps from "../netlify/functions/comps.mts";
import status from "../netlify/functions/status.mts";
import { normalizeItem } from "../lib/ebay.mts";
import { normalizeLens } from "../lib/lens.mts";

const KEYS = ["APP_PASSCODE", "ANTHROPIC_API_KEY", "SERPAPI_KEY", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"];
const PHOTO = Buffer.from("fake jpeg bytes").toString("base64");
let mock: ReturnType<typeof installMockFetch> | null = null;

function setKeys(on: string[] = KEYS) {
  for (const k of KEYS) delete process.env[k];
  for (const k of on) process.env[k] = k === "APP_PASSCODE" ? "letmein" : "test";
}

function post(path: string, body: unknown, code = "letmein") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-passcode": code },
    body: JSON.stringify(body),
  });
}

beforeEach(() => setKeys());
afterEach(() => {
  mock?.restore();
  mock = null;
});

test("rejects a wrong access code and refuses to run without one configured", async () => {
  mock = installMockFetch();
  const wrong = await identify(post("/api/identify", { images: [PHOTO] }, "nope"));
  assert.equal(wrong.status, 401);
  delete process.env.APP_PASSCODE;
  const unset = await status(new Request("http://localhost/api/status"));
  assert.equal(unset.status, 503);
  assert.equal(mock.calls.length, 0, "no paid API is touched without a valid code");
});

test("status reports configured providers", async () => {
  setKeys(["APP_PASSCODE", "ANTHROPIC_API_KEY"]);
  const res = await status(new Request("http://localhost/api/status", { headers: { "x-app-passcode": "letmein" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.providers, { claude: true, lens: false, ebay: false });
  assert.equal(body.model, "claude-opus-5-5");
});

test("identify: uses Lens + eBay photo matches as hints and returns Claude's ID", async () => {
  mock = installMockFetch();
  const res = await identify(post("/api/identify", { images: [`data:image/jpeg;base64,${PHOTO}`, PHOTO], hint: "has box" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id.search_query, "Pyrex 443 Butterprint Cinderella bowl");
  assert.equal(body.providers.lens, "ok");
  assert.equal(body.providers.ebayPhoto, "ok");
  assert.ok(body.matches.some((m: { via: string }) => m.via === "Google Lens"));
  assert.ok(body.matches.some((m: { via: string }) => m.via === "eBay photo match"));

  const claudeCall = mock.calls.find((c) => c.url.startsWith("https://api.anthropic.com/"));
  assert.ok(claudeCall?.body);
  const sent = JSON.parse(claudeCall.body);
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.fallbacks, "default");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.equal(sent.messages[0].content.filter((b: { type: string }) => b.type === "image").length, 2);
  const text = sent.messages[0].content.find((b: { type: string }) => b.type === "text").text;
  assert.match(text, /has box/);
  assert.match(text, /\[Google Lens\]/);
});

test("identify: works with only the Anthropic key", async () => {
  setKeys(["APP_PASSCODE", "ANTHROPIC_API_KEY"]);
  mock = installMockFetch();
  const res = await identify(post("/api/identify", { images: [PHOTO] }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.lens, "off");
  assert.deepEqual(body.matches, []);
});

test("identify: rejects junk images and reports refusals clearly", async () => {
  mock = installMockFetch({ refuse: true });
  const bad = await identify(post("/api/identify", { images: ["not base64!!"] }));
  assert.equal(bad.status, 400);
  const empty = await identify(post("/api/identify", { images: [] }));
  assert.equal(empty.status, 400);
  const refused = await identify(post("/api/identify", { images: [PHOTO] }));
  assert.equal(refused.status, 422);
});

test("comps: active supply from eBay + sold comps from research -> value", async () => {
  mock = installMockFetch();
  const res = await comps(post("/api/comps", { query: "Pyrex 443 Butterprint Cinderella bowl", name: "Pyrex 443" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.active.total, 87);
  assert.equal(body.active.items.length, 6);
  assert.equal(body.active.items.find((i: { format: string }) => i.format === "auction").bids, 3);
  assert.ok(body.active.asking.median > 0, "asking prices summarized from fixed-price listings");
  assert.equal(body.sold.items.length, 7);
  // The worn $19.99 sale sits far below the pack and is left out of the value.
  assert.equal(body.sold.summary.dropped, 1);
  assert.equal(body.value.basis, "6 sold comps");
  assert.ok(body.value.low <= body.value.typical && body.value.typical <= body.value.high);
  assert.equal(body.research.demand, "high");

  const research = mock.calls.find((c) => c.url.startsWith("https://api.anthropic.com/"));
  const sent = JSON.parse(research!.body!);
  assert.equal(sent.tools[0].type, "web_search_20260209");
  assert.equal(sent.tools[1].name, "report_market");
  assert.equal(sent.tools[1].strict, true);
  assert.match(sent.messages[0].content, /87 active listings/);
});

test("comps: resumes a paused web-search turn", async () => {
  mock = installMockFetch({ pauseFirst: true });
  const res = await comps(post("/api/comps", { query: "pyrex bowl" }));
  const body = await res.json();
  assert.equal(body.sold.items.length, 7);
  const claudeCalls = mock.calls.filter((c) => c.url.startsWith("https://api.anthropic.com/"));
  assert.equal(claudeCalls.length, 2);
  const second = JSON.parse(claudeCalls[1].body!);
  assert.equal(second.messages.length, 2);
  assert.equal(second.messages[1].role, "assistant");
});

test("comps: research failure still returns eBay data", async () => {
  mock = installMockFetch({ researchFails: true });
  const res = await comps(post("/api/comps", { query: "pyrex bowl" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.active.total, 87);
  assert.ok(body.sold.error);
  assert.equal(body.value, null);
});

test("comps: research off and eBay down -> empty but well-formed", async () => {
  mock = installMockFetch({ ebayDown: true });
  const res = await comps(post("/api/comps", { query: "pyrex bowl", research: false }));
  const body = await res.json();
  assert.equal(body.active.total, null);
  assert.match(body.active.error, /eBay/);
  assert.equal(body.sold.source, "none");
  assert.equal(mock.calls.filter((c) => c.url.startsWith("https://api.anthropic.com/")).length, 0);
});

test("comps: requires a query", async () => {
  const res = await comps(post("/api/comps", { query: "  " }));
  assert.equal(res.status, 400);
});

test("normalizers tolerate missing fields", () => {
  const item = normalizeItem({ title: "x", currentBidPrice: { value: "12.50" }, buyingOptions: ["AUCTION"] });
  assert.equal(item.price, 12.5);
  assert.equal(item.format, "auction");
  assert.equal(item.shipping, null);
  const lens = normalizeLens({ visual_matches: [{ title: "a", link: "https://a", price: { value: "$1,299.00*" } }, { title: "no link" }] });
  assert.equal(lens.matches.length, 1);
  assert.equal(lens.matches[0].price, 1299);
});
