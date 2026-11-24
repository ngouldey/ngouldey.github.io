import { sellThrough, profit, verdict } from './calc.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'flipscout.settings.v1';
const HISTORY_KEY = 'flipscout.history.v1';
const MAX_PHOTOS = 4;
const DEFAULTS = {
  passcode: '',
  feePct: 13.6,
  perOrderFee: 0.4,
  adPct: 0,
  defaultShipping: 8,
  minProfit: 15,
  minRoi: 100,
  research: true,
};

// ---------------------------------------------------------------- storage
// Local storage can be missing (private mode) or full; the app still works without it.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

let settings = { ...DEFAULTS, ...store.get(SETTINGS_KEY, {}) };

const state = {
  photos: [], // { dataUrl, b64, thumb }
  run: null,
  tab: 'sold',
  retry: null,
};

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

function money(n, { sign = false } = {}) {
  if (n == null || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const s = abs.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: abs >= 100 ? 0 : abs % 1 ? 2 : 0,
    maximumFractionDigits: abs >= 100 ? 0 : 2,
  });
  if (n < 0) return `−${s}`;
  return sign ? `+${s}` : s;
}

function parseMoney(v) {
  if (v == null) return null;
  const n = Number.parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const pct = (r) => `${r < 0 ? '−' : ''}${Math.abs(Math.round(r * 100))}%`;
// Resale values read better as whole dollars once they're over $10.
const approx = (n) => money(n != null && Math.abs(n) >= 10 ? Math.round(n) : n);

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- photos
async function loadImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

function scaled(src, maxEdge) {
  const w = src.width;
  const hgt = src.height;
  const k = Math.min(1, maxEdge / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(hgt * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const dataUrlBytes = (u) => Math.floor(((u.length - u.indexOf(',') - 1) * 3) / 4);

// Phone photos are 3–5 MB; shrink to ~1280px JPEG. Google Lens uploads cap near 500 KB.
async function processFile(file) {
  const img = await loadImage(file);
  let dataUrl = scaled(img, 1280).toDataURL('image/jpeg', 0.82);
  for (const [edge, q] of [[1280, 0.7], [1024, 0.7], [900, 0.6]]) {
    if (dataUrlBytes(dataUrl) <= 470_000) break;
    dataUrl = scaled(img, edge).toDataURL('image/jpeg', q);
  }
  const thumb = scaled(img, 180).toDataURL('image/jpeg', 0.72);
  img.close?.();
  return { dataUrl, b64: dataUrl.slice(dataUrl.indexOf(',') + 1), thumb };
}

async function addFiles(files) {
  const list = [...files].slice(0, MAX_PHOTOS - state.photos.length);
  if (!list.length) return;
  for (const f of list) {
    try {
      state.photos.push(await processFile(f));
    } catch {
      toast('Could not read that photo');
    }
  }
  renderPhotos();
}

function renderPhotos() {
  $('photos').replaceChildren(
    ...state.photos.map((p, i) =>
      h('div', { class: 'photo' },
        h('img', { src: p.thumb, alt: `Photo ${i + 1}` }),
        h('button', {
          class: 'remove',
          type: 'button',
          'aria-label': `Remove photo ${i + 1}`,
          onclick: () => { state.photos.splice(i, 1); renderPhotos(); },
        }, icon('i-x')),
      ),
    ),
  );
  const snap = $('snapBtn');
  snap.classList.toggle('compact', state.photos.length > 0);
  snap.querySelector('.snap-title').textContent = state.photos.length ? 'Add another angle' : 'Snap the item';
  snap.hidden = state.photos.length >= MAX_PHOTOS;
  $('checkBtn').disabled = state.photos.length === 0;
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

// ---------------------------------------------------------------- API
async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-app-passcode': settings.passcode },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(75_000),
    });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? 'The server took too long.' : 'No connection. Check your signal and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Server error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- flow
function newRun(mode) {
  return {
    key: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    mode,
    hint: $('hintInput').value.trim(),
    buy: parseMoney($('priceInput').value),
    photoThumb: state.photos[0]?.thumb ?? null,
    query: '',
    id: null,
    matches: [],
    comps: null,
    manualSold: null,
    manualActive: null,
    sell: null,
    ship: null,
  };
}

function needsPasscode() {
  if (settings.passcode) return false;
  toast('Add your access code first');
  openSettings();
  return true;
}

async function startPhotoScan() {
  if (!state.photos.length || needsPasscode()) return;
  const run = newRun('photo');
  showResults(run);
  await identify(run);
}

async function startTextSearch(text) {
  if (!text || needsPasscode()) return;
  const run = newRun('text');
  run.photoThumb = null;
  run.query = text;
  run.id = { name: text, search_query: text, alternatives: [], verify_tips: [], red_flags: [] };
  showResults(run);
  await fetchComps(run);
}

async function identify(run) {
  state.retry = () => identify(run);
  setProgress([['Identifying the item', 'active', 'about 10–20 seconds'], ['Checking eBay and recent sales']]);
  try {
    const res = await api('/api/identify', {
      images: state.photos.map((p) => p.b64),
      hint: run.hint,
    });
    if (state.run !== run) return;
    run.id = res.id;
    run.matches = res.matches || [];
    run.query = res.id.search_query || res.id.name;
    renderRun();
    await fetchComps(run);
  } catch (e) {
    if (state.run === run) showError(e);
  }
}

function detailsOf(id) {
  if (!id) return '';
  return [id.brand, id.model_or_pattern, id.era, id.materials, id.condition_notes].filter(Boolean).join('; ');
}

async function fetchComps(run) {
  state.retry = () => fetchComps(run);
  const steps = run.mode === 'photo' ? [['Identified', 'done']] : [];
  steps.push(settings.research
    ? ['Checking eBay and recent sales', 'active', 'about 20–40 seconds']
    : ['Checking eBay listings', 'active']);
  setProgress(steps);
  $('errorCard').hidden = true;
  try {
    const res = await api('/api/comps', {
      query: run.query,
      name: run.id?.name,
      details: [detailsOf(run.id), run.hint].filter(Boolean).join('; '),
      research: settings.research,
    });
    if (state.run !== run) return;
    run.comps = res;
    run.sell = null;
    setProgress([]);
    renderRun();
    saveHistory(run);
  } catch (e) {
    if (state.run === run) showError(e);
  }
}

function setProgress(steps) {
  $('progress').replaceChildren(
    ...steps.map(([label, st, note]) => h('li', { class: st || '' }, label, note ? h('small', {}, ` · ${note}`) : null)),
  );
}

function showError(e) {
  setProgress([]);
  $('errorText').textContent = e.message || 'Something went wrong.';
  $('errorCard').hidden = false;
  if (e.status === 401 || e.status === 503) openSettings();
}

function showResults(run) {
  state.run = run;
  state.tab = 'sold';
  $('scanView').hidden = true;
  $('resultView').hidden = false;
  $('backBtn').hidden = false;
  $('errorCard').hidden = true;
  window.scrollTo({ top: 0 });
  renderRun();
}

function newScan() {
  state.run = null;
  state.photos = [];
  $('priceInput').value = '';
  $('hintInput').value = '';
  $('textInput').value = '';
  renderPhotos();
  $('resultView').hidden = true;
  $('scanView').hidden = false;
  $('backBtn').hidden = true;
  setProgress([]);
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- render: results
function valueInfo(run) {
  const v = run.comps?.value;
  if (v && v.typical > 0) return v;
  const q = run.id?.quick_value;
  if (run.comps && q && q.high > 0) {
    return { low: q.low, typical: Math.round(((q.low + q.high) / 2) * 100) / 100, high: q.high, basis: 'AI gut check – no comps found' };
  }
  return null;
}

function strInfo(run) {
  const c = run.comps;
  if (!c) return null;
  const active = c.active?.total ?? run.manualActive;
  const sold = c.sold?.count90 ?? run.manualSold;
  return { active, sold, st: sellThrough(sold, active) };
}

function renderRun() {
  const run = state.run;
  if (!run) return;
  renderId(run);
  const ready = Boolean(run.comps);
  for (const id of ['stats', 'profitCard', 'insightCard', 'compsCard', 'linksCard']) $(id).hidden = !ready;
  if (!ready) {
    $('verdict').hidden = true;
    $('soldCountCard').hidden = true;
    return;
  }
  renderValue(run);
  renderStr(run);
  renderProfitInputs(run);
  updateMoney();
  renderInsights(run);
  renderComps();
  renderLinks(run);
}

function renderId(run) {
  const id = run.id;
  const card = $('idCard');
  // While identifying, show the photo so the screen isn't empty.
  card.hidden = !id && !run.photoThumb;
  card.classList.toggle('pending', !id);
  const thumb = $('idThumb');
  if (run.photoThumb) thumb.src = run.photoThumb;
  else thumb.removeAttribute('src');
  if (!id) {
    $('idName').textContent = 'Looking closely…';
    $('idChips').replaceChildren();
    $('idNote').textContent = run.hint ? `Your notes: ${run.hint}` : '';
    $('alts').hidden = true;
    return;
  }
  $('idName').textContent = id.name;
  const chips = [id.brand, id.model_or_pattern, id.era].filter(Boolean).map((t) => h('span', { class: 'chip' }, t));
  if (id.confidence) chips.push(h('span', { class: `chip conf-${id.confidence}` }, `${id.confidence} confidence`));
  $('idChips').replaceChildren(...chips);
  $('idNote').textContent = id.condition_notes || '';
  $('queryInput').value = run.query;
  const alts = [
    ...(id.alternatives || []).map((a) => ({ label: a.name, query: a.search_query })),
    ...(id.alt_queries || []).map((q) => ({ label: q, query: q })),
  ].filter((a, i, arr) => a.query && a.query !== run.query && arr.findIndex((b) => b.query === a.query) === i).slice(0, 5);
  $('alts').hidden = !alts.length;
  $('altChips').replaceChildren(
    ...alts.map((a) => h('button', { class: 'chip', type: 'button', onclick: () => requery(a.query, a.label) }, a.label)),
  );
}

function renderValue(run) {
  const v = valueInfo(run);
  $('valueBig').textContent = v ? approx(v.typical) : '–';
  $('valueRange').textContent = v ? `${approx(v.low)} – ${approx(v.high)}` : 'No sold data';
  $('valueBasis').textContent = v ? v.basis : settings.research ? 'Nothing found – check eBay sold' : 'Turn on sold-price research';
  const s = run.comps.sold?.summary;
  const bar = $('valueBar');
  bar.hidden = !(v && s && s.count >= 3 && s.high > s.low);
  if (!bar.hidden) {
    const span = s.high - s.low;
    const at = (x) => `${Math.min(100, Math.max(0, ((x - s.low) / span) * 100))}%`;
    const fill = bar.querySelector('.range-fill');
    fill.style.left = at(s.p25);
    fill.style.width = `calc(${at(s.p75)} - ${at(s.p25)})`;
    bar.querySelector('.range-dot').style.left = at(s.median);
  }
}

const DEMAND = {
  very_high: ['Very high', 'hot'],
  high: ['High', 'good'],
  medium: ['Medium', ''],
  low: ['Low', 'slow'],
  very_low: ['Very low', 'very-slow'],
};

function renderStr(run) {
  const card = $('strStat');
  const info = strInfo(run);
  const research = run.comps.research;
  card.className = 'card stat';
  $('strMeter').hidden = true;
  if (info.st) {
    card.classList.add(`tier-${info.st.tier}`);
    $('strBig').textContent = pct(info.st.rate);
    $('strSub').textContent = info.st.label;
    $('strMeter').hidden = false;
    $('strMeter').firstElementChild.style.width = pct(info.st.rate);
    $('strFoot').textContent = `${info.sold} sold · ${info.active} active`;
  } else if (research?.demand && DEMAND[research.demand]) {
    const [label, tier] = DEMAND[research.demand];
    if (tier) card.classList.add(`tier-${tier}`);
    $('strBig').textContent = label;
    $('strSub').textContent = `demand${research.typical_days_to_sell ? ` · ${research.typical_days_to_sell}` : ''}`;
    $('strFoot').textContent = info.active != null ? `${info.active} active on eBay · AI estimate` : 'AI estimate';
  } else {
    $('strBig').textContent = '–';
    $('strSub').textContent = info.active != null ? 'Add the sold count' : 'No market data';
    $('strFoot').textContent = info.active != null ? `${info.active} active on eBay` : '';
  }

  const needCount = run.comps.sold?.count90 == null;
  $('soldCountCard').hidden = !needCount;
  $('soldLink').href = ebayUrl(run.query, true);
  $('soldCountInput').value = run.manualSold ?? '';
  let activeInput = $('activeCountInput');
  if (run.comps.active?.total == null) {
    if (!activeInput) {
      activeInput = h('input', { id: 'activeCountInput', inputmode: 'numeric', placeholder: '# active', 'aria-label': 'Number of active listings on eBay' });
      activeInput.addEventListener('input', () => {
        state.run.manualActive = parseMoney(activeInput.value);
        renderStr(state.run);
        updateMoney();
        saveHistorySoon();
      });
      $('soldCountInput').after(activeInput);
    }
    activeInput.value = run.manualActive ?? '';
  } else if (activeInput) {
    activeInput.remove();
  }
}

function renderProfitInputs(run) {
  const v = valueInfo(run);
  $('sellInput').value = run.sell ?? v?.typical ?? '';
  $('buyInput').value = run.buy ?? '';
  const ship = run.ship ?? run.id?.shipping?.est_cost_usd ?? settings.defaultShipping;
  $('shipInput').value = ship;
  $('feeNote').textContent = `${settings.feePct}%${settings.adPct ? ` + ${settings.adPct}% ads` : ''} + ${money(settings.perOrderFee)}`;
}

function currentNumbers() {
  const run = state.run;
  const sell = parseMoney($('sellInput').value);
  const buy = parseMoney($('buyInput').value);
  const ship = parseMoney($('shipInput').value) ?? 0;
  const p = sell != null
    ? profit({ sell, buy: buy ?? 0, feePct: settings.feePct, perOrderFee: settings.perOrderFee, adPct: settings.adPct, shipping: ship })
    : null;
  const info = strInfo(run);
  const v = verdict(
    {
      profit: p ? p.profit : null,
      roi: p && buy ? p.roi : null,
      strRate: info?.st ? info.st.rate : null,
      demand: run.comps?.research?.demand ?? null,
      hasBuyPrice: buy != null,
    },
    { minProfit: settings.minProfit, minRoi: settings.minRoi / 100 },
  );
  return { sell, buy, p, v };
}

function updateMoney() {
  const run = state.run;
  if (!run?.comps) return;
  const { buy, p, v } = currentNumbers();
  $('feesVal').textContent = p ? `−${money(p.fees).replace('−', '')}` : '–';
  const pv = $('profitVal');
  pv.textContent = p ? money(p.profit, { sign: true }) : '–';
  pv.className = `calc-val ${p ? (p.profit >= 0 ? 'pos' : 'neg') : ''}`;
  $('roiVal').textContent = p && p.roi != null && buy ? pct(p.roi) : '–';

  const box = $('verdict');
  box.hidden = false;
  box.className = `verdict ${v.level}`;
  $('verdictBadge').textContent = { buy: 'BUY', maybe: 'MAYBE', pass: 'PASS' }[v.level] ?? '—';
  $('verdictProfit').textContent = p && buy != null
    ? `${money(p.profit, { sign: true })} profit${p.roi != null ? ` · ${pct(p.roi)} return` : ''}`
    : p ? `Sells for about ${money(parseMoney($('sellInput').value))}` : 'No value yet';
  $('verdictReasons').textContent = v.reasons.join(' · ');
  run.verdict = v.level;
}

function renderInsights(run) {
  const r = run.comps.research;
  const id = run.id || {};
  const parts = [];
  const block = (title, body) => h('div', { class: 'insight' }, h('strong', {}, title), body);
  const list = (items) => h('ul', {}, items.map((t) => h('li', {}, t)));
  if (r?.demand_reason) parts.push(block('Demand', r.demand_reason));
  if (r?.pricing_tips) parts.push(block('Listing tips', r.pricing_tips));
  if (id.verify_tips?.length) parts.push(block('Check before you buy', list(id.verify_tips)));
  if (id.red_flags?.length) parts.push(block('Watch out for', list(id.red_flags)));
  if (id.quick_value?.note) parts.push(block('What drives the price', id.quick_value.note));
  const notes = [];
  if (r?.confidence) notes.push(`Price research confidence: ${r.confidence}.`);
  if (!settings.research) notes.push('Sold-price research is off (Settings).');
  if (run.comps.sold?.error) notes.push(`Sold research failed: ${run.comps.sold.error}`);
  if (!run.comps.active?.configured) notes.push('Live eBay listings are off: add eBay API keys on the server.');
  else if (run.comps.active?.error) notes.push(`eBay listings failed: ${run.comps.active.error}`);
  if (notes.length) parts.push(h('p', { class: 'insight muted' }, notes.join(' ')));
  $('insights').replaceChildren(...parts);
  $('insightCard').hidden = !parts.length;
}

function renderComps() {
  const run = state.run;
  const c = run.comps;
  const sold = c.sold?.items || [];
  const active = c.active?.items || [];
  const matches = run.matches || [];
  $('soldTabCount').textContent = sold.length ? sold.length : '';
  $('activeTabCount').textContent = c.active?.total != null ? c.active.total.toLocaleString() : '';
  $('matchTabCount').textContent = matches.length ? matches.length : '';
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));

  const thumb = (src, label) =>
    safeUrl(src)
      ? h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('span', { class: 'ph', 'aria-hidden': 'true' }, (label || '').slice(0, 1).toUpperCase());
  const row = ({ url, img, label, title, meta, price, sub }) =>
    h('li', { class: 'comp' },
      h('a', { href: safeUrl(url) ?? '#', target: '_blank', rel: 'noopener noreferrer' },
        thumb(img, label),
        h('div', { class: 'comp-body' }, h('div', { class: 'comp-title' }, title), h('div', { class: 'comp-meta' }, meta)),
        h('div', { class: 'comp-price' }, price, sub ? h('small', {}, sub) : null),
      ),
    );

  let items = [];
  let empty = '';
  if (state.tab === 'sold') {
    items = sold.map((s) => row({
      url: s.url,
      label: s.source,
      title: s.title,
      meta: [s.source, s.sold_date, s.condition].filter(Boolean).join(' · '),
      price: money(s.price_usd),
      sub: 'sold',
    }));
    empty = settings.research
      ? 'No sold comps found online. Use the eBay sold link below.'
      : 'Sold-price research is off. Turn it on in Settings, or use the eBay sold link below.';
  } else if (state.tab === 'active') {
    items = active.map((a) => row({
      url: a.url,
      img: a.image,
      title: a.title,
      meta: [a.condition, a.format === 'auction' ? `auction${a.bids != null ? ` · ${a.bids} bids` : ''}` : null].filter(Boolean).join(' · '),
      price: money(a.price),
      sub: a.shipping == null ? '' : a.shipping === 0 ? 'free ship' : `+${money(a.shipping)} ship`,
    }));
    empty = c.active?.configured ? 'No active listings for this search.' : 'Add eBay API keys on the server to see live listings.';
  } else {
    items = matches.map((m) => row({
      url: m.link,
      img: m.thumbnail,
      title: m.title,
      meta: [m.via, m.source].filter(Boolean).join(' · '),
      price: m.price != null ? money(m.price) : '',
    }));
    empty = run.mode === 'text'
      ? 'Look-alikes come from photo scans.'
      : 'No look-alikes. Add a SerpApi key (Google Lens) or eBay keys on the server.';
  }
  $('compsList').replaceChildren(...(items.length ? items : [h('li', { class: 'empty' }, empty)]));
}

function ebayUrl(q, sold) {
  const p = new URLSearchParams({ _nkw: q });
  if (sold) { p.set('LH_Sold', '1'); p.set('LH_Complete', '1'); }
  return `https://www.ebay.com/sch/i.html?${p}`;
}

function renderLinks(run) {
  const q = encodeURIComponent(run.query);
  const links = [
    ['eBay sold', ebayUrl(run.query, true)],
    ['eBay active', ebayUrl(run.query, false)],
    ['Mercari sold', `https://www.mercari.com/search/?keyword=${q}&status=sold_out`],
    ['Poshmark sold', `https://poshmark.com/search?query=${q}&availability=sold_out`],
    ['Etsy', `https://www.etsy.com/search?q=${q}`],
    ['WorthPoint', `https://www.worthpoint.com/inventory/search?query=${q}`],
    ['Google', `https://www.google.com/search?q=${q}`],
    ['FB Marketplace', `https://www.facebook.com/marketplace/search/?query=${q}`],
  ];
  $('links').replaceChildren(
    ...links.map(([label, href]) => h('a', { class: 'secondary small', href, target: '_blank', rel: 'noopener' }, label, icon('i-ext'))),
  );
}

function requery(query, name) {
  const run = state.run;
  if (!run || !query) return;
  run.query = query.trim();
  if (name && run.id && name !== run.id.name) run.id = { ...run.id, name };
  run.comps = null;
  run.manualSold = null;
  run.manualActive = null;
  renderRun();
  fetchComps(run);
}

// ---------------------------------------------------------------- history
function saveHistory(run) {
  if (!run?.comps) return;
  const entry = { ...run, matches: (run.matches || []).slice(0, 12) };
  let list = store.get(HISTORY_KEY, []).filter((e) => e.key !== run.key);
  list.unshift(entry);
  list = list.slice(0, 40);
  while (!store.set(HISTORY_KEY, list) && list.length > 1) list.pop();
}

function saveHistorySoon() {
  clearTimeout(saveHistorySoon.t);
  saveHistorySoon.t = setTimeout(() => saveHistory(state.run), 600);
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  $('historyEmpty').hidden = list.length > 0;
  $('historyList').replaceChildren(
    ...list.map((e) => {
      const v = valueInfo(e);
      return h('li', {},
        h('button', { type: 'button', onclick: () => openHistory(e) },
          e.photoThumb ? h('img', { src: e.photoThumb, alt: '' }) : h('span', { class: 'ph' }),
          h('div', { class: 'h-body' },
            h('div', { class: 'h-name' }, e.id?.name || e.query),
            h('div', { class: 'h-meta' }, [relTime(e.createdAt), v ? `~${approx(v.typical)}` : null, e.buy != null ? `paid ${money(e.buy)}` : null].filter(Boolean).join(' · ')),
          ),
          e.verdict && e.verdict !== 'unknown' ? h('span', { class: `pill ${e.verdict}` }, e.verdict.toUpperCase()) : null,
        ),
      );
    }),
  );
}

function openHistory(entry) {
  $('historySheet').close();
  state.photos = [];
  renderPhotos();
  showResults(structuredClone(entry));
}

// ---------------------------------------------------------------- settings
const SETTING_FIELDS = [
  ['sPasscode', 'passcode', 'text'],
  ['sFeePct', 'feePct', 'num'],
  ['sPerOrder', 'perOrderFee', 'num'],
  ['sAdPct', 'adPct', 'num'],
  ['sShip', 'defaultShipping', 'num'],
  ['sMinProfit', 'minProfit', 'num'],
  ['sMinRoi', 'minRoi', 'num'],
];

function openSettings() {
  for (const [el, key] of SETTING_FIELDS) $(el).value = settings[key];
  $('sResearch').checked = settings.research;
  $('statusText').textContent = '';
  if (!$('settingsSheet').open) $('settingsSheet').showModal();
}

function readSettingsForm() {
  const next = { ...settings };
  for (const [el, key, type] of SETTING_FIELDS) {
    const raw = $(el).value.trim();
    next[key] = type === 'num' ? (parseMoney(raw) ?? DEFAULTS[key]) : raw;
  }
  next.research = $('sResearch').checked;
  return next;
}

async function testConnection() {
  const prev = settings;
  settings = readSettingsForm();
  $('statusText').textContent = 'Checking…';
  try {
    const s = await api('/api/status');
    const mark = (ok) => (ok ? '✓' : '✗');
    $('statusText').textContent = `Connected · Claude ${mark(s.providers.claude)} · Lens ${mark(s.providers.lens)} · eBay ${mark(s.providers.ebay)}`;
  } catch (e) {
    $('statusText').textContent = e.message;
  } finally {
    settings = prev;
  }
}

// ---------------------------------------------------------------- wire up
function init() {
  $('snapBtn').addEventListener('click', () => $('cameraInput').click());
  $('libraryBtn').addEventListener('click', () => $('libraryInput').click());
  for (const id of ['cameraInput', 'libraryInput']) {
    $(id).addEventListener('change', async (e) => {
      await addFiles(e.target.files || []);
      e.target.value = '';
    });
  }
  $('checkBtn').addEventListener('click', startPhotoScan);
  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('textInput').blur();
    startTextSearch($('textInput').value.trim());
  });
  $('backBtn').addEventListener('click', newScan);
  $('retryBtn').addEventListener('click', () => {
    $('errorCard').hidden = true;
    state.retry?.();
  });
  $('requeryBtn').addEventListener('click', () => requery($('queryInput').value));
  $('queryInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('queryInput').blur(); requery($('queryInput').value); }
  });

  const moneyInput = (id, key) =>
    $(id).addEventListener('input', () => {
      if (!state.run) return;
      state.run[key] = parseMoney($(id).value);
      updateMoney();
      saveHistorySoon();
    });
  moneyInput('sellInput', 'sell');
  moneyInput('buyInput', 'buy');
  moneyInput('shipInput', 'ship');
  $('soldCountInput').addEventListener('input', () => {
    if (!state.run) return;
    state.run.manualSold = parseMoney($('soldCountInput').value);
    renderStr(state.run);
    updateMoney();
    saveHistorySoon();
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => { state.tab = tab.dataset.tab; renderComps(); });
  }

  $('historyBtn').addEventListener('click', () => { renderHistory(); $('historySheet').showModal(); });
  $('settingsBtn').addEventListener('click', openSettings);
  for (const b of document.querySelectorAll('[data-open-settings]')) b.addEventListener('click', openSettings);
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  for (const d of document.querySelectorAll('dialog')) {
    // Tapping the dimmed backdrop (outside the sheet's box) closes it.
    d.addEventListener('click', (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) d.close();
    });
  }
  $('testBtn').addEventListener('click', testConnection);
  $('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    settings = readSettingsForm();
    if (!store.set(SETTINGS_KEY, settings)) toast('Saved for this visit only (storage unavailable)');
    else toast('Saved');
    $('settingsSheet').close();
    $('setupHint').hidden = Boolean(settings.passcode);
    if (state.run?.comps) { renderProfitInputs(state.run); updateMoney(); }
  });
  $('clearHistoryBtn').addEventListener('click', () => {
    if (!confirm('Delete all saved scans on this phone?')) return;
    store.set(HISTORY_KEY, []);
    toast('History cleared');
  });

  $('setupHint').hidden = Boolean(settings.passcode);
  renderPhotos();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
