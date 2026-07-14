import type { NetOverrides } from "./engines/types";

export function hasNetOverrides(net?: NetOverrides): boolean {
  if (!net) return false;
  return !!(net.origin.trim() || net.referer.trim() || net.userAgent.trim());
}

/**
 * Rewrite an absolute http(s) URL so it is fetched through the local proxy,
 * which injects Origin / Referer / User-Agent (headers the browser forbids
 * JS from setting). Returns the original URL if no override applies.
 */
export function proxifyUrl(url: string, net?: NetOverrides): string {
  if (!hasNetOverrides(net) || !net) return url;
  if (!/^https?:\/\//i.test(url)) return url; // skip blob:, data:, relative
  const qs = new URLSearchParams();
  qs.set("u", url);
  if (net.origin.trim()) qs.set("o", net.origin.trim());
  if (net.referer.trim()) qs.set("r", net.referer.trim());
  if (net.userAgent.trim()) qs.set("ua", net.userAgent.trim());
  return `/api/proxy?${qs.toString()}`;
}

/**
 * Reverse of proxifyUrl: given a proxied URL (absolute or relative), return the
 * real target URL, or null if it is not a proxy URL. Used to keep the player's
 * base-URL resolution pointing at the real CDN (not the local proxy).
 */
export function unproxifyUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const marker = "/api/proxy?";
  const i = url.indexOf(marker);
  if (i < 0) return null;
  try {
    const qs = url.slice(i + marker.length);
    return new URLSearchParams(qs).get("u");
  } catch {
    return null;
  }
}
