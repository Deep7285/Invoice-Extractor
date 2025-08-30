// src/worker.ts
// Cloudflare Worker: Invoice extractor + auth
// -------------------------------------------------------------
// Endpoints:
//   POST /api/login      -> { username, password } JSON body
//   POST /api/logout     -> clears session cookie + KV entry
//   POST /api/extract    -> FormData (images_dataurl[] and/or doc_text)
//                          Requires session OR uses free-trial (3 attempts, 1 page max)
//
// Bindings (wrangler.toml):
//   [vars] ALLOWED_ORIGIN="https://deep7285.github.io"
//   [[kv_namespaces]] binding="USERS" id="..." preview_id="..."
//   secret OPENAI_API_KEY
//
// Notes:
// - Sessions are stored under KV key "session:<token>" with TTL.
// - Users are stored under KV key "user:<username>" (created via your tools/make-user.mjs).
// - Free-trial counts are tracked in a "trial" cookie (httpOnly for integrity).
// -------------------------------------------------------------

export interface Env {
  ALLOWED_ORIGIN: string;
  OPENAI_API_KEY: string;
  USERS: KVNamespace; // used for both users and sessions via prefixes
}

// -------------------------
// 0) Small utilities
// -------------------------
const JSON_HEADER = { "content-type": "application/json; charset=utf-8" };

// Centralized CORS for both preflight and actual responses.
// IMPORTANT: We echo *your* GitHub Pages origin and allow credentials.
function cors(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function ok(body: any, env: Env, extraHeaders: Record<string, string> = {}) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, headers: { ...JSON_HEADER, ...cors(env), ...extraHeaders } }
  );
}
function bad(body: any, env: Env, status = 400) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { ...JSON_HEADER, ...cors(env) } }
  );
}
function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie") || "";
  const m = raw.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// CHANGED: default SameSite is now "None" so cookies work cross-site.
// (Browsers require SameSite=None; Secure for 3rd-party/cross-site cookies.)
function setCookie(
  name: string,
  val: string,
  opts: {
    maxAge?: number;
    path?: string;
    httpOnly?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
  } = {}
) {
  const parts = [`${name}=${encodeURIComponent(val)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  // DEFAULT CHANGED HERE
  parts.push(`SameSite=${opts.sameSite ?? "None"}`);
  if (opts.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

async function hashPasswordPBKDF2(password: string, saltB64: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations, salt },
    key,
    256
  );
  const out = String.fromCharCode(...new Uint8Array(bits));
  return btoa(out); // base64 string to compare with stored hash
}
function b64Random(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/=+$/, "");
}

// -------------------------
// 1) Session & trial helpers
// -------------------------
const SESSION_PREFIX = "session:";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const TRIAL_LIMIT = 3; // max free attempts if not logged in
const TRIAL_COOKIE = "trial";
const SESSION_COOKIE = "sess";

async function getSession(env: Env, token: string | null) {
  if (!token) return null;
  const key = SESSION_PREFIX + token;
  const json = await env.USERS.get(key, "json");
  return json as null | { username: string; exp: number; roles?: string[] };
}
async function createSession(env: Env, username: string, roles: string[] = []) {
  const token = b64Random(24);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await env.USERS.put(SESSION_PREFIX + token, JSON.stringify({ username, exp, roles }), {
    expirationTtl: SESSION_TTL_SECONDS
  });
  return { token, exp };
}
async function destroySession(env: Env, token: string | null) {
  if (!token) return;
  await env.USERS.delete(SESSION_PREFIX + token);
}
function readTrialCookie(req: Request): number {
  const v = getCookie(req, TRIAL_COOKIE);
  const n = parseInt(v || "0", 10);
  return Number.isFinite(n) ? n : 0;
}
function trialExceeded(n: number) {
  return n >= TRIAL_LIMIT;
}

// -------------------------
// 2) Auth: login / logout
// -------------------------
async function handleLogin(req: Request, env: Env) {
  try {
    const body = await req.json<{ username?: string; password?: string }>();
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!username || !password) return bad({ error: "username and password are required" }, env, 400);

    const doc = (await env.USERS.get("user:" + username, "json")) as
      | null
      | { username: string; salt: string; hash: string; iterations: number; expires?: string; roles?: string[] };

    if (!doc) return bad({ error: "invalid_credentials" }, env, 401);

    // Validate not expired (if your tool sets expires)
    if (doc.expires && new Date(doc.expires).getTime() < Date.now()) {
      return bad({ error: "account_expired" }, env, 403);
    }

    // Verify password (PBKDF2 fields from your make-user tool)
    const derived = await hashPasswordPBKDF2(password, doc.salt, doc.iterations);
    if (derived !== doc.hash) {
      return bad({ error: "invalid_credentials" }, env, 401);
    }

    // Create session
    const session = await createSession(env, username, doc.roles ?? []);
    const cookie = setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "None", // CHANGED
      secure: true,
      maxAge: SESSION_TTL_SECONDS
    });

    // Reset trial counter upon login
    const clearTrial = setCookie(TRIAL_COOKIE, "0", {
      httpOnly: true,
      sameSite: "None", // CHANGED
      secure: true,
      maxAge: 0
    });

    return ok({ ok: true, username }, env, { "Set-Cookie": `${cookie}, ${clearTrial}` });
  } catch (e: any) {
    return bad({ error: e?.message || "bad_request" }, env, 400);
  }
}

async function handleLogout(req: Request, env: Env) {
  const token = getCookie(req, SESSION_COOKIE);
  await destroySession(env, token);
  const clear = setCookie(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "None", // CHANGED
    secure: true,
    maxAge: 0
  });
  return ok({ ok: true }, env, { "Set-Cookie": clear });
}

// -------------------------
// 3) Guard for /api/extract
// -------------------------
type AuthResult =
  | { kind: "session"; username: string; roles: string[] }
  | { kind: "trial"; count: number };

async function guardExtract(
  req: Request,
  env: Env
): Promise<{ allowed: boolean; mode?: AuthResult; headers?: Record<string, string>; error?: Response }> {
  const sessToken = getCookie(req, SESSION_COOKIE);
  const sess = await getSession(env, sessToken);
  if (sess && sess.exp > Math.floor(Date.now() / 1000)) {
    return { allowed: true, mode: { kind: "session", username: sess.username, roles: sess.roles ?? [] } };
  }

  // Not logged in -> trial mode
  const used = readTrialCookie(req);
  if (trialExceeded(used)) {
    const hint = "Trial limit reached. Please login to continue.";
    return { allowed: false, error: bad({ error: "trial_exhausted", hint }, env, 429) };
  }
  // Increment trial cookie for this response
  const newCount = used + 1;
  const cookie = setCookie(TRIAL_COOKIE, String(newCount), {
    httpOnly: true,
    sameSite: "None", // CHANGED
    secure: true,
    maxAge: 60 * 60 * 24 * 7
  });
  return { allowed: true, mode: { kind: "trial", count: newCount }, headers: { "Set-Cookie": cookie } };
}

// -------------------------
// 4) Multipart parsing helpers for extract
// -------------------------
async function parseFormData(request: Request) {
  const form = await request.formData();
  const imgs: string[] = [];
  for (const [key, value] of form.entries()) {
    if (key === "images_dataurl[]" && typeof value === "string") imgs.push(value);
  }
  const docText = (form.get("doc_text") as string) || "";
  return { imgs, docText };
}

// -------------------------
// 5) GPT extraction call (Responses API)
// -------------------------
async function extractWithGPT(env: Env, parts: { imgs: string[]; docText: string }) {
  const content: any[] = [];
  content.push({
    type: "text",
    text: `You are an invoice parser for Indian GST invoices.
Return only this JSON fields:
{
  "seller": { "company_name": string, "gstin": string, "address": string },
  "invoice": { "number": string, "date": string, "transaction_id": string },
  "taxes": [ { "type": "CGST|SGST|IGST", "rate_percent": number, "amount": number } ],
  "amounts": { "taxable_amount": number, "total_amount": number }
}
Use DD-MM-YYYY date format. If a field is missing, return an empty string.`
  });
  for (const d of parts.imgs) content.push({ type: "input_image", image_url: d });
  if (parts.docText?.trim()) content.push({ type: "text", text: "Raw extracted text:\n" + parts.docText.slice(0, 10000) });

  const body = {
    model: "gpt-4o-mini",
    input: [{ role: "user", content }],
    temperature: 0,
    text: { format: "json" }
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI error: ${resp.status} ${t}`);
  }
  const data = await resp.json<any>();
  const payload = data?.output_text ?? data?.output?.[0]?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

// -------------------------
// 6) /api/extract handler
// -------------------------
async function handleExtract(req: Request, env: Env) {
  const guard = await guardExtract(req, env);
  if (!guard.allowed) return guard.error!;
  const extraHeaders = guard.headers || {};

  const { imgs, docText } = await parseFormData(req);

  // Trial restriction: max 1 page (1 image) on trial
  if ("mode" in guard && guard.mode?.kind === "trial" && imgs.length > 1) {
    return bad({ error: "trial_one_page_only" }, env, 403);
  }

  if (imgs.length > 10) {
    return bad({ error: "too_many_pages" }, env, 400);
  }

  const json = await extractWithGPT(env, { imgs, docText });
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { ...JSON_HEADER, ...cors(env), ...extraHeaders }
  });
}

// -------------------------
// 7) Router
// -------------------------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS + preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response("Use POST /api/extract", { status: 405, headers: cors(env) });
    }

    try {
      if (url.pathname === "/api/login" && req.method === "POST") {
        return await handleLogin(req, env);
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        return await handleLogout(req, env);
      }
      if (url.pathname === "/api/extract" && req.method === "POST") {
        return await handleExtract(req, env);
      }

      return bad({ error: "not_found" }, env, 404);
    } catch (err: any) {
      return bad({ error: "server_error", detail: String(err?.message || err) }, env, 500);
    }
  }
};
