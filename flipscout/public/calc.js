// Pure math shared by the phone app and the server. No DOM, no network.

/** @param {number[]} sorted ascending */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Drops prices far outside the pack (lots, parts-only, typos) using the 1.5×IQR rule.
 * Needs at least 5 points; with fewer there is nothing reliable to compare against.
 * @param {number[]} prices
 */
export function removeOutliers(prices) {
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (clean.length < 5) return clean;
  const sorted = [...clean].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter((p) => p >= lo && p <= hi);
}

/**
 * @param {number[]} prices
 * @returns {{count:number, dropped:number, low:number, p25:number, median:number, p75:number, high:number, mean:number} | null}
 */
export function summarize(prices) {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  const kept = removeOutliers(valid).sort((a, b) => a - b);
  if (!kept.length) return null;
  const r = (n) => Math.round(n * 100) / 100;
  return {
    count: kept.length,
    dropped: valid.length - kept.length,
    low: r(kept[0]),
    p25: r(quantile(kept, 0.25)),
    median: r(quantile(kept, 0.5)),
    p75: r(quantile(kept, 0.75)),
    high: r(kept[kept.length - 1]),
    mean: r(kept.reduce((s, p) => s + p, 0) / kept.length),
  };
}

/**
 * Sell-through rate over a window (eBay shows ~90 days of sold items):
 * sold ÷ (sold + still-active). 50% means one sold for every one still sitting.
 * @param {number|null|undefined} sold
 * @param {number|null|undefined} active
 */
export function sellThrough(sold, active) {
  if (sold == null || active == null || !Number.isFinite(sold) || !Number.isFinite(active)) return null;
  if (sold < 0 || active < 0) return null;
  const total = sold + active;
  if (total === 0) return { rate: 0, sold, active, tier: 'none', label: 'No market data' };
  const rate = sold / total;
  let tier = 'very-slow';
  let label = 'Very slow';
  if (rate >= 0.6) { tier = 'hot'; label = 'Hot – sells fast'; }
  else if (rate >= 0.4) { tier = 'good'; label = 'Good – steady seller'; }
  else if (rate >= 0.2) { tier = 'slow'; label = 'Slow – expect to wait'; }
  return { rate, sold, active, tier, label };
}

/**
 * Profit if you list at `sell` with free shipping and pay the shipping yourself.
 * @param {{sell:number, buy:number, feePct:number, perOrderFee:number, shipping:number, adPct?:number}} p
 */
export function profit({ sell, buy, feePct, perOrderFee, shipping, adPct = 0 }) {
  const fees = sell * ((feePct + adPct) / 100) + (sell > 0 ? perOrderFee : 0);
  const net = sell - fees - shipping;
  const gain = net - buy;
  return {
    fees: round2(fees),
    net: round2(net),
    profit: round2(gain),
    roi: buy > 0 ? gain / buy : null,
  };
}

const DEMAND_SPEED = { very_high: 'fast', high: 'fast', medium: 'ok', low: 'slow', very_low: 'slow' };

/**
 * BUY / MAYBE / PASS from profit, return on cost and how fast it moves.
 * @param {{profit:number|null, roi:number|null, strRate?:number|null, demand?:string|null, hasBuyPrice:boolean}} r
 * @param {{minProfit:number, minRoi:number}} s minRoi as a fraction (1 = 100%)
 */
export function verdict(r, s) {
  if (r.profit == null) return { level: 'unknown', reasons: ['No resale value yet'] };
  if (!r.hasBuyPrice) return { level: 'unknown', reasons: ['Enter the tag price to get a verdict'] };

  let speed = 'ok';
  if (r.strRate != null) speed = r.strRate >= 0.4 ? 'fast' : r.strRate >= 0.2 ? 'ok' : 'slow';
  else if (r.demand && DEMAND_SPEED[r.demand]) speed = DEMAND_SPEED[r.demand];

  const reasons = [];
  const profitOk = r.profit >= s.minProfit;
  const roiOk = r.roi == null || r.roi >= s.minRoi;
  if (!profitOk) reasons.push(`Profit under your $${s.minProfit} minimum`);
  if (!roiOk) reasons.push(`Return under ${Math.round(s.minRoi * 100)}% of cost`);
  if (speed === 'slow') reasons.push('Slow seller – cash sits longer');
  if (speed === 'fast') reasons.push('Moves quickly');

  if (profitOk && roiOk && speed !== 'slow') return { level: 'buy', reasons };
  if (r.profit > 0 && (r.profit >= s.minProfit * 0.5 || (profitOk && roiOk))) return { level: 'maybe', reasons };
  return { level: 'pass', reasons };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
