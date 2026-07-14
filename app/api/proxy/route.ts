import { type NextRequest } from "next/server";

// Node runtime so we can set otherwise-forbidden request headers
// (Origin / Referer / User-Agent) when fetching upstream.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "date",
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function handle(req: NextRequest, method: "GET" | "HEAD") {
  const { searchParams } = new URL(req.url);
  const o = searchParams.get("o");
  const r = searchParams.get("r");
  const ua = searchParams.get("ua");

  // Debug mode: report exactly which headers the proxy injects, without
  // fetching upstream. Used by the "Verify headers" button.
  if (searchParams.get("debug") != null) {
    const injected: Record<string, string> = {};
    if (o) injected["origin"] = o;
    if (r) injected["referer"] = r;
    if (ua) injected["user-agent"] = ua;
    return new Response(JSON.stringify({ injected }, null, 2), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const target = searchParams.get("u");
  if (!target) return new Response("missing 'u' param", { status: 400 });

  let url: string;
  try {
    url = new URL(target).toString();
  } catch {
    return new Response("invalid target url", { status: 400 });
  }

  const headers: Record<string, string> = {};
  if (o) headers["origin"] = o;
  if (r) headers["referer"] = r;
  // Never let undici's default "user-agent: node" leak upstream — it breaks
  // UA-based CDN routing (e.g. Akamai's multiperiod→single-period rule). Use
  // the explicit override if given, else forward the caller's real UA.
  const uaOut = ua || req.headers.get("user-agent") || undefined;
  if (uaOut) headers["user-agent"] = uaOut;
  const range = req.headers.get("range");
  if (range) headers["range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers, redirect: "follow" });
  } catch (e: any) {
    return new Response("upstream fetch failed: " + (e?.message || e), {
      status: 502,
      headers: CORS,
    });
  }

  const respHeaders = new Headers(CORS);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  // Echo the headers we injected so the client can verify per request.
  if (o) respHeaders.set("x-sp-sent-origin", o);
  if (r) respHeaders.set("x-sp-sent-referer", r);
  if (ua) respHeaders.set("x-sp-sent-user-agent", ua);

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export function GET(req: NextRequest) {
  return handle(req, "GET");
}

export function HEAD(req: NextRequest) {
  return handle(req, "HEAD");
}
