# FlipScout

Point your iPhone at a thrift-store find and get, in about 30 seconds:

- **What it is**: brand, model/pattern, era, read from the photo (plus Google Lens and eBay look-alikes)
- **What it sells for**: recent sold prices with links, and a value range
- **How fast it sells**: demand estimate, live eBay supply, and exact sell-through when you add the sold count
- **Whether to buy it**: profit after eBay fees and shipping, return on cost, and a **BUY / MAYBE / PASS** call

It is a web app you add to your home screen (no App Store), with a small backend on Netlify that keeps your API keys off the phone.

```
photo ──► /api/identify ──► Google Lens (SerpApi) ─┐
                         └► eBay photo search ─────┼─► Claude reads the photos → name + best eBay search
                                                   ┘
query ──► /api/comps ────► eBay Browse API: active listings + count
                         └► Claude + web search: recent sold prices, demand
                         ──► value range, sell-through, profit, verdict (on the phone)
```

## What you need

| Setting | Needed? | What it does | Cost |
|---|---|---|---|
| `APP_PASSCODE` | **Required** | A code you make up. The app asks for it once; without it nobody can spend your API credit. | – |
| `ANTHROPIC_API_KEY` | **Required** | Identifies the item and researches sold prices. Get one at [console.anthropic.com](https://console.anthropic.com). | Pay per use, see below |
| `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` | Recommended | Live eBay listings and the exact active count (for sell-through), plus eBay's photo matching. | Free |
| `SERPAPI_KEY` | Optional | Google Lens look-alikes, used as extra clues. Get one at [serpapi.com](https://serpapi.com). | Free tier, then paid; 1 search per photo scan |
| `CLAUDE_MODEL` | Optional | Defaults to `claude-opus-5-5`. `claude-sonnet-5-5` costs about half. | – |

**Rough Claude cost per scan** (estimate, check your usage in the Anthropic Console): about 5–10¢ to identify, plus about 15–30¢ when sold-price research is on (web searches are billed per search). Turn research off in Settings to save money, then use the eBay sold link and type in the count.

## Put it on your phone (Netlify)

You can do all of this from Safari on your iPhone.

1. Sign in to [app.netlify.com](https://app.netlify.com) → **Add new project** → **Import an existing project** → **GitHub** → pick `ngouldey.github.io`.
2. Branch: the branch this code is on. **Base directory: `flipscout`**. Leave the build command empty; `netlify.toml` sets the rest. Deploy.
3. **Project configuration → Environment variables**: add `APP_PASSCODE` and `ANTHROPIC_API_KEY` (plus the eBay/SerpApi keys if you have them). Then **Deploys → Trigger deploy** so the functions pick them up.
4. Open your new `https://<name>.netlify.app` in Safari → **Share → Add to Home Screen**.
5. Open FlipScout → ⚙︎ Settings → enter your access code → **Test connection**. You should see `Claude ✓`.

### Getting eBay keys (free)

1. Join the [eBay Developers Program](https://developer.ebay.com) with your eBay account.
2. **Application Keys → Create a keyset → Production**. Copy **App ID (Client ID)** → `EBAY_CLIENT_ID` and **Cert ID (Client Secret)** → `EBAY_CLIENT_SECRET`.
3. eBay asks production keysets to handle "Marketplace account deletion" notices. FlipScout stores no eBay user data, so choose the exemption option when asked.

## Using it in the store

1. **Snap the item**, then add a second photo of the label, tag, stamp or bottom mark. Labels make the ID much more precise.
2. Type the **tag price**, add notes if useful ("works", "size 10", "has box"), tap **Check it**.
3. Read the verdict. If the ID is off, tap one of the **Not it? Try** options or edit the search and tap **Re-check**.
4. For an exact sell-through, tap **eBay sold**. It opens your signed-in eBay app. Type the number of results into **# sold**.
5. Scans are saved on your phone under 🕘 History.

Defaults you can change in Settings: eBay fee 13.6% + $0.40 per order (check your category's rate), promoted-listing %, default shipping, and your BUY rule (min $15 profit and 100% return, and not a slow seller).

## Where the numbers come from

**Sold prices.** In 2026 eBay put its sold-listings search behind sign-in, SerpApi removed its eBay "sold" filter (Sept 28, 2026), and eBay's official sold-data API (Marketplace Insights) is limited to approved partners. So FlipScout has Claude search the web for completed sales of the exact item (eBay item pages, Mercari, Etsy, WorthPoint, auction results), and shows each comp with a link so you can check it. Outliers such as lots and parts-only units are dropped before the value range is computed. If fewer than 3 comps turn up, the value is labeled as an AI estimate.

**Sell-through** = items sold in the last ~90 days ÷ (sold + still listed). 60%+ is hot, 40–60% good, 20–40% slow, under 20% very slow. The active count comes from eBay's official Browse API. Until a sold-data source is connected, the sold count comes from you (one tap away), and the card shows Claude's demand estimate in the meantime.

**Adding a paid sold-data API later:** `/api/comps` already returns a `sold.count90` field. Fill it from a provider in `netlify/functions/comps.mts` and the app computes sell-through automatically.

**Privacy:** photos are sent to Anthropic for identification, and the first photo also goes to SerpApi/Google Lens and eBay when those keys are set. Scan history stays in your phone's browser storage.

## Develop locally

```bash
cd flipscout
npm install
npm run dev:mock     # fake data, no keys: http://localhost:8888, access code "demo"
cp .env.example .env # then fill in keys
npm run dev          # real APIs
npm test             # unit + API tests (outside APIs mocked)
npm run typecheck
```

| Path | What |
|---|---|
| `public/` | The phone app: `index.html`, `app.js`, `styles.css`, `calc.js` (value, sell-through, profit, verdict math, shared with the server) |
| `netlify/functions/identify.mts` | Photo → Lens + eBay look-alikes → Claude identification |
| `netlify/functions/comps.mts` | eBay active listings + Claude sold-price research → value |
| `netlify/functions/status.mts` | Access-code check and which keys are set |
| `lib/` | Claude, eBay, SerpApi clients and request helpers |
| `scripts/` | Local dev server and the fake upstream APIs used by tests |
