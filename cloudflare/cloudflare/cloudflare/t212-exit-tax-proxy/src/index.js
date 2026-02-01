// Cloudflare Worker: Trading 212 proxy (positions only)
// - Does NOT store credentials (no KV/D1/R2).
// - Does NOT log credentials.
// - Handles CORS for your GitHub Pages origin.
// - POST /positions  { apiKey, apiSecret, env?: "live"|"demo" }

const RATE_LIMIT_WINDOW_MS = 1000; // best-effort, in-memory
const ipLastSeen = new Map(); // in-memory only

function json(body, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...corsHeaders,
    },
  });
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // If you really want open CORS for testing, set ALLOWED_ORIGINS="*"
  if (allow.includes("*")) {
    return {
      "Access-Control-Allow-Origin": origin || "*",
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
  }

  if (origin && allow.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
  }

  // No CORS headers if origin not allowed
  return {};
}

function tooSoon(ip) {
  if (!ip) return false;
  const now = Date.now();
  const last = ipLastSeen.get(ip) || 0;
  if (now - last < RATE_LIMIT_WINDOW_MS) return true;
  ipLastSeen.set(ip, now);
  return false;
}

function basicAuth(apiKey, apiSecret) {
  const token = btoa(`${apiKey}:${apiSecret}`);
  return `Basic ${token}`;
}

function pickBaseUrl(envName) {
  // Trading 212 envs
  if (envName === "demo") return "https://demo.trading212.com/api/v0";
  return "https://live.trading212.com/api/v0";
}

export default {
  async fetch(request, env) {
    const cors = getCorsHeaders(request, env);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors } });
    }

    const url = new URL(request.url);

    if (url.pathname !== "/positions") {
      return json({ error: "Not found" }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    // Best-effort rate limit (per IP, in-memory only)
    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (tooSoon(ip)) {
      return json({ error: "Rate limited. Please wait 1s and retry." }, 429, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400, cors);
    }

    const apiKey = String(body?.apiKey || "").trim();
    const apiSecret = String(body?.apiSecret || "").trim();
    const envName = String(body?.env || "live").trim().toLowerCase() === "demo" ? "demo" : "live";

    if (!apiKey || !apiSecret) {
      return json({ error: "Missing apiKey/apiSecret" }, 400, cors);
    }

    const baseUrl = pickBaseUrl(envName);
    const endpoint = `${baseUrl}/equity/positions`;

    const tRes = await fetch(endpoint, {
      method: "GET",
      headers: {
        "Authorization": basicAuth(apiKey, apiSecret),
        "Accept": "application/json",
      },
    });

    if (!tRes.ok) {
      // Do NOT echo secrets. Return generic error.
      const text = await tRes.text().catch(() => "");
      return json(
        { error: `Trading212 error (HTTP ${tRes.status})`, detail: text.slice(0, 300) },
        502,
        cors
      );
    }

    const positions = await tRes.json();
    return json(positions, 200, cors);
  },
};
