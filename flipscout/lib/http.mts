import { createHash, timingSafeEqual } from "node:crypto";

/** Reads an env var on Netlify (Netlify.env) or locally (process.env). */
export function env(name: string): string | undefined {
  const netlify = (globalThis as { Netlify?: { env?: { get(k: string): string | undefined } } }).Netlify;
  const value = netlify?.env?.get(name) ?? process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Every endpoint spends money on paid APIs, so the whole backend sits behind a
 * shared access code. Fails closed: with no APP_PASSCODE set, nothing runs.
 */
export function requireAccess(req: Request): void {
  const expected = env("APP_PASSCODE");
  if (!expected) {
    throw new HttpError(503, "Server not set up yet: add an APP_PASSCODE environment variable in Netlify.");
  }
  const given = req.headers.get("x-app-passcode") ?? "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) throw new HttpError(401, "Wrong access code. Check Settings.");
}

export async function readJson<T>(req: Request, maxBytes: number): Promise<T> {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

/** Wraps a handler so thrown HttpErrors become JSON responses and surprises are logged. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: `Something went wrong: ${message}` }, 500);
    }
  };
}

/** Runs a task and returns its result, or null plus an error note, never throwing. */
export async function settle<T>(task: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await task(), error: null };
  } catch (err) {
    console.warn(err);
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v.replace(/[^0-9.\-]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}
