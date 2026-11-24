// Local server: serves public/ and runs the Netlify functions in-process.
//   npm run dev        real APIs, keys from .env (see README)
//   npm run dev:mock   no keys needed, fake data, access code "demo"
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const mock = process.argv.includes('--mock');
const port = Number(process.env.PORT || 8888);

if (mock) {
  Object.assign(process.env, {
    APP_PASSCODE: 'demo',
    ANTHROPIC_API_KEY: 'mock',
    SERPAPI_KEY: 'mock',
    EBAY_CLIENT_ID: 'mock',
    EBAY_CLIENT_SECRET: 'mock',
  });
  const { installMockFetch } = await import('./mock-upstream.mjs');
  installMockFetch({ delayMs: Number(process.env.MOCK_DELAY ?? 700), imageBase: `http://localhost:${port}/__mock` });
} else {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    console.warn('No .env file found; using the current environment.');
  }
}

const ROUTES = { '/api/identify': 'identify', '/api/comps': 'comps', '/api/status': 'status' };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function mockThumb(n) {
  const hues = [172, 190, 30, 205, 160, 15, 45, 260];
  const hue = hues[n % hues.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 30% 86%)"/><ellipse cx="32" cy="36" rx="22" ry="14" fill="#fff"/><ellipse cx="32" cy="30" rx="22" ry="8" fill="hsl(${hue} 45% 55%)"/></svg>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    const fn = ROUTES[url.pathname];
    if (fn) {
      const mod = await import(path.join(root, 'netlify/functions', `${fn}.mts`));
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const request = new Request(url, { method: req.method, headers: req.headers, body });
      const response = await mod.default(request, {});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const thumb = url.pathname.match(/^\/__mock\/thumb\/(\d+)\.svg$/);
    if (mock && thumb) {
      res.writeHead(200, { 'content-type': TYPES['.svg'] });
      res.end(mockThumb(Number(thumb[1])));
      return;
    }
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(publicDir, path.normalize(rel));
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.writeHead(404).end('Not found');
    } else {
      console.error(err);
      res.writeHead(500).end('Server error');
    }
  }
});

server.listen(port, () => {
  console.log(`FlipScout on http://localhost:${port}${mock ? '  (MOCK DATA – access code: demo)' : ''}`);
});
