import { test } from "node:test";
import assert from "node:assert/strict";
import { profit, removeOutliers, sellThrough, summarize, verdict } from "../public/calc.js";

test("summarize drops lots and typos with the IQR rule", () => {
  const s = summarize([30, 32, 35, 36, 38, 40, 41, 250, 1]);
  assert.ok(s);
  assert.equal(s.count, 7);
  assert.equal(s.dropped, 2);
  assert.equal(s.median, 36);
  assert.equal(s.low, 30);
  assert.equal(s.high, 41);
});

test("summarize keeps everything when there are too few points to judge", () => {
  assert.deepEqual(removeOutliers([5, 500]), [5, 500]);
  assert.equal(summarize([]), null);
  assert.equal(summarize([0, -3, Number.NaN]), null);
});

test("sell-through = sold / (sold + active), with tiers", () => {
  assert.equal(sellThrough(60, 40)?.rate, 0.6);
  assert.equal(sellThrough(60, 40)?.tier, "hot");
  assert.equal(sellThrough(40, 60)?.tier, "good");
  assert.equal(sellThrough(20, 80)?.tier, "slow");
  assert.equal(sellThrough(5, 95)?.tier, "very-slow");
  assert.equal(sellThrough(0, 0)?.tier, "none");
  assert.equal(sellThrough(null, 10), null);
  assert.equal(sellThrough(10, undefined), null);
});

test("profit subtracts eBay fees, per-order fee and shipping", () => {
  const p = profit({ sell: 40, buy: 5, feePct: 13.6, perOrderFee: 0.4, shipping: 14 });
  assert.equal(p.fees, 5.84); // 40 * 13.6% + 0.40
  assert.equal(p.net, 20.16);
  assert.equal(p.profit, 15.16);
  assert.ok(p.roi && Math.abs(p.roi - 3.032) < 1e-9);
  assert.equal(profit({ sell: 40, buy: 0, feePct: 13.6, perOrderFee: 0.4, shipping: 0 }).roi, null);
});

test("verdict: buy, maybe, pass", () => {
  const rules = { minProfit: 15, minRoi: 1 };
  assert.equal(verdict({ profit: 20, roi: 3, strRate: 0.5, hasBuyPrice: true }, rules).level, "buy");
  assert.equal(verdict({ profit: 20, roi: 3, strRate: 0.1, hasBuyPrice: true }, rules).level, "maybe");
  assert.equal(verdict({ profit: 9, roi: 2, demand: "high", hasBuyPrice: true }, rules).level, "maybe");
  assert.equal(verdict({ profit: 3, roi: 0.3, hasBuyPrice: true }, rules).level, "pass");
  assert.equal(verdict({ profit: -4, roi: -0.5, hasBuyPrice: true }, rules).level, "pass");
  assert.equal(verdict({ profit: 20, roi: null, hasBuyPrice: false }, rules).level, "unknown");
  assert.equal(verdict({ profit: null, roi: null, hasBuyPrice: true }, rules).level, "unknown");
  assert.equal(verdict({ profit: 20, roi: 3, demand: "very_low", hasBuyPrice: true }, rules).level, "maybe");
});
