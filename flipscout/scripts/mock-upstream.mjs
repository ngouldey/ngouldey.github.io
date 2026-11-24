// Fake Anthropic / eBay / SerpApi responses for tests and `npm run dev:mock`.
// Replaces globalThis.fetch; every number here is sample data, not real market data.

const ITEM = {
  name: 'Pyrex 443 Cinderella mixing bowl, Butterprint turquoise on white, 2.5 qt',
  brand: 'Pyrex (Corning)',
  model_or_pattern: 'Butterprint · 443 Cinderella',
  category: 'Kitchen / vintage glassware',
  era: '1957–1968',
  materials: 'Opal milk glass',
  condition_notes: 'Pattern looks bright with no visible dishwasher fade; check the rim for chips.',
  identifiers_seen: ['PYREX', '443', '2 1/2 QT'],
  confidence: 'high',
  search_query: 'Pyrex 443 Butterprint Cinderella bowl',
  alt_queries: ['Pyrex Butterprint bowl turquoise', 'Pyrex Butterprint Cinderella bowl set'],
  alternatives: [{ name: 'Pyrex 444 Butterprint 4 qt bowl', search_query: 'Pyrex 444 Butterprint bowl' }],
  verify_tips: [
    'Run a finger around the rim and spouts for chips or flea bites',
    'Hold it to the light: dull, chalky patches mean dishwasher damage and cut the value roughly in half',
    'Check the bottom stamp says 443 and 2 1/2 QT',
  ],
  red_flags: ['Heavy glass – double box it to ship'],
  shipping: { size_class: 'medium', est_weight_lb: 4, est_cost_usd: 14 },
  quick_value: { low: 25, high: 45, note: 'Bright, unfaded pattern and no chips are what buyers pay for.' },
};

const SOLD = [
  ['Vintage Pyrex 443 Butterprint Cinderella Bowl Turquoise 2.5 Qt', 38, '2026-11-12', 'eBay', 'used'],
  ['Pyrex 443 Cinderella Mixing Bowl Butterprint Amish', 34.99, '2026-11-03', 'eBay', 'used'],
  ['Pyrex Butterprint 443 Bowl – bright, no chips', 42, '2026-10-28', 'Mercari', 'used'],
  ['PYREX 443 Butterprint Turquoise Cinderella Bowl', 29.95, '2026-10-19', 'eBay', 'used'],
  ['Pyrex 443 Butter Print Bowl 2 1/2 qt', 31, '2026-10-02', 'eBay', 'used'],
  ['Vintage Pyrex Butterprint Cinderella 443', 36.5, '2026-09-21', 'Etsy', 'used'],
  ['Pyrex 443 Butterprint bowl – some wear', 19.99, '2026-09-15', 'eBay', 'used'],
];

const ACTIVE = [
  ['Pyrex 443 Butterprint Cinderella Mixing Bowl Turquoise', 44.99, 0, 'FIXED_PRICE'],
  ['Vintage PYREX Butterprint 443 2.5 Qt Bowl', 39, 12.5, 'FIXED_PRICE'],
  ['Pyrex Butterprint 443 Cinderella Bowl Amish Farmers', 52, 0, 'FIXED_PRICE'],
  ['Pyrex 443 Cinderella Bowl Butterprint – AUCTION', 18.5, 14, 'AUCTION'],
  ['Pyrex Butterprint Turquoise 443 bowl', 47.5, 0, 'FIXED_PRICE'],
  ['Pyrex 443 butterprint (faded) bowl', 24, 11, 'FIXED_PRICE'],
];

const LENS = [
  ['Pyrex 443 Butterprint Cinderella Bowl', 'eBay', 39.99],
  ['Vintage Pyrex Butterprint Cinderella Mixing Bowl Set', 'Etsy', 120],
  ['Pyrex Butterprint pattern history', 'Pyrex Collectors', null],
  ['Pyrex 443 Turquoise Butterprint bowl', 'Mercari', 35],
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_mock' } });

function message(content, stopReason) {
  return {
    id: `msg_mock_${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 600 },
  };
}

/**
 * @param {{delayMs?: number, imageBase?: string, pauseFirst?: boolean, researchFails?: boolean, refuse?: boolean, ebayDown?: boolean}} opts
 */
export function installMockFetch(opts = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  let researchCalls = 0;
  const img = (n) => (opts.imageBase ? `${opts.imageBase}/thumb/${n}.svg` : `https://i.ebayimg.com/images/mock/${n}.jpg`);
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const bodyText = typeof init.body === 'string' ? init.body : null;
    calls.push({ url, method, body: bodyText });
    await wait();

    if (url.startsWith('https://api.ebay.com/')) {
      if (opts.ebayDown) return json({ errors: [{ message: 'Service unavailable' }] }, 503);
      if (url.includes('/oauth2/token')) return json({ access_token: 'mock-token', expires_in: 7200, token_type: 'Application Access Token' });
      if (url.includes('/item_summary/search_by_image')) {
        return json({
          total: 4,
          itemSummaries: ACTIVE.slice(0, 4).map(([title, price], i) => ({
            itemId: `v1|90000${i}|0`, title, price: { value: String(price), currency: 'USD' },
            buyingOptions: ['FIXED_PRICE'], image: { imageUrl: img(i + 20) }, itemWebUrl: `https://www.ebay.com/itm/90000${i}`,
          })),
        });
      }
      if (url.includes('/item_summary/search')) {
        return json({
          total: 87,
          itemSummaries: ACTIVE.map(([title, price, ship, fmt], i) => ({
            itemId: `v1|10000${i}|0`,
            title,
            ...(fmt === 'AUCTION'
              ? { currentBidPrice: { value: String(price), currency: 'USD' }, bidCount: 3 }
              : { price: { value: String(price), currency: 'USD' } }),
            buyingOptions: [fmt],
            condition: 'Pre-owned',
            image: { imageUrl: img(i) },
            itemWebUrl: `https://www.ebay.com/itm/10000${i}`,
            shippingOptions: [{ shippingCost: { value: String(ship), currency: 'USD' } }],
          })),
        });
      }
    }

    if (url.startsWith('https://serpapi.com/image')) return json({ image_id: 'mock-image-id' });
    if (url.startsWith('https://serpapi.com/search.json')) {
      return json({
        visual_matches: LENS.map(([title, source, price], i) => ({
          position: i + 1, title, source, link: `https://example.com/lens/${i}`, thumbnail: img(i + 40),
          ...(price != null ? { price: { value: `$${price}*`, extracted_value: price, currency: '$' } } : {}),
        })),
        related_content: [{ query: 'Pyrex Butterprint' }, { query: 'Pyrex Cinderella bowl' }],
      });
    }

    if (url.startsWith('https://api.anthropic.com/v1/messages')) {
      const req = bodyText ? JSON.parse(bodyText) : {};
      if (opts.refuse) return json(message([], 'refusal'));
      const isResearch = (req.tools || []).some((t) => t.name === 'report_market');
      if (!isResearch) return json(message([{ type: 'text', text: JSON.stringify(ITEM) }], 'end_turn'));
      researchCalls += 1;
      if (opts.researchFails) return json({ type: 'error', error: { type: 'api_error', message: 'mock failure' } }, 500);
      if (opts.pauseFirst && researchCalls === 1) {
        return json(message([{ type: 'text', text: 'Searching sold listings…' }], 'pause_turn'));
      }
      return json(message([
        {
          type: 'tool_use',
          id: 'toolu_mock',
          name: 'report_market',
          input: {
            sold_comps: SOLD.map(([title, price_usd, sold_date, source, condition], i) => ({
              title, price_usd, sold_date, source, condition, url: `https://www.ebay.com/itm/20000${i}`,
            })),
            estimated_value: { low: 28, typical: 35, high: 42 },
            demand: 'high',
            demand_reason: 'Butterprint is one of the most collected Pyrex patterns; clean 443 bowls usually sell within a couple of weeks.',
            typical_days_to_sell: '1–3 weeks',
            pricing_tips: 'List at $39.99 with Best Offer. Photograph the rim, the bottom stamp and the pattern in daylight.',
            confidence: 'medium',
          },
        },
      ], 'tool_use'));
    }

    if (realFetch && !url.startsWith('https://')) return realFetch(input, init);
    throw new Error(`mock-upstream: unexpected request to ${url}`);
  };

  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

export const MOCK_ITEM = ITEM;
