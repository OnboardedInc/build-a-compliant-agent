import { DEFAULT_BRAND, normalizeDomain, pickBrandColours, type Brand } from "../../shared/builder";
import type { Bindings } from "../index";

/** normalizeDomain is the shared UI helper; fetching adds the server's host restrictions. */
export function safeDomain(input: string): string | null {
  const domain = normalizeDomain(input);
  if (!domain || domain.length > 253 || domain.split(".").some((part) => part.length > 63) || domain === "localhost" || /\.(?:local|internal|test)$/.test(domain)) return null;
  try {
    const host = new URL(`https://${domain}/`).hostname;
    if (host !== domain || /^[\d.]+$/.test(host) || host.includes(":")) return null;
    return domain;
  } catch { return null; }
}
const webUrl = (input: unknown, base: string): string | null => {
  if (typeof input !== "string" || !input.trim()) return null;
  try { const url = new URL(input.replace(/&amp;/g, "&"), base); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  return out;
}
/** A host the Worker may fetch while reading a company's site: public, by name, never an address. */
const publicHost = (host: string): boolean =>
  /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host) && host !== "localhost" && !/\.(?:local|internal|test)$/i.test(host);

/** Reads up to `limit` bytes of a text response. */
async function readText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, limit - size); chunks.push(part); size += part.length;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(bytes);
}

const AGENT = { "User-Agent": "Mozilla/5.0 (compatible; brand-preview/1.0)" };

/**
 * The company's home page. A redirect is followed by hand, at most three times, and only to
 * the same domain or a subdomain of it (example.com to www.example.com), over https.
 */
async function homePage(domain: string): Promise<{ url: string; html: string } | null> {
  let url = `https://${domain}/`;
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual", headers: { Accept: "text/html", ...AGENT } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const next = webUrl(response.headers.get("location"), url);
      const host = next ? new URL(next).hostname.toLowerCase() : "";
      if (!next || !next.startsWith("https://") || !(host === domain || host.endsWith(`.${domain}`)) || !publicHost(host)) return null;
      url = next;
      continue;
    }
    if (!response.ok || !/\btext\/html\b/i.test(response.headers.get("content-type") || "")) { await response.body?.cancel(); return null; }
    return { url, html: await readText(response, 400_000) };
  }
  return null;
}

/** Hex colours in a piece of CSS or HTML, counted, without greys, white and black. */
function countColours(text: string, into: Map<string, number>, weight = 1): void {
  for (const match of text.matchAll(/#([\da-f]{6}|[\da-f]{3})(?![\da-f])/gi)) {
    const raw = match[1]!; const hex = (raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw).toUpperCase();
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if (Math.max(...rgb) - Math.min(...rgb) < 40) continue;
    into.set(`#${hex}`, (into.get(`#${hex}`) || 0) + weight);
  }
}

async function websiteBrand(domain: string): Promise<Brand> {
  const page = await homePage(domain);
  if (!page) return DEFAULT_BRAND;
  const { url, html } = page;
  const colours: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = attrs(match[0]);
    if (/^(theme-color|msapplication-tilecolor)$/i.test(tag.name || "") && /^#[\da-f]{3,6}$/i.test((tag.content || "").trim())) colours.push(tag.content!.trim());
  }
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const frequency = new Map<string, number>();
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) countColours(block[1]!, frequency);
  for (const inline of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) countColours(inline[1]!, frequency);
  // Most sites keep their colours in a stylesheet: read the first two, and only from the
  // company's own domain. A page must not be able to send this Worker to a host of its choosing.
  const own = (h: string): boolean => { const host = new URL(h).hostname.toLowerCase(); return (host === domain || host.endsWith(`.${domain}`)) && publicHost(host); };
  const sheets = links.filter((a) => /\bstylesheet\b/i.test(a.rel || "")).map((a) => webUrl(a.href, url)).filter((h): h is string => !!h && h.startsWith("https://") && own(h)).slice(0, 2);
  await Promise.all(sheets.map(async (href) => {
    try {
      const css = await fetch(href, { signal: AbortSignal.timeout(4000), redirect: "error", headers: { Accept: "text/css", ...AGENT } });
      if (css.ok && /\btext\/css\b/i.test(css.headers.get("content-type") || "")) countColours(await readText(css, 400_000), frequency);
      else await css.body?.cancel();
    } catch { /* A stylesheet that cannot be read only means fewer colours to choose from. */ }
  }));
  colours.push(...[...frequency].sort((a, b) => b[1] - a[1]).slice(0, colours.length ? 1 : 2).map(([hex]) => hex));
  const logo = links.find((a) => /\bapple-touch-icon\b/i.test(a.rel || "") && webUrl(a.href, url)) ?? links.find((a) => /(?:^|\s)icon(?:\s|$)/i.test(a.rel || "") && webUrl(a.href, url));
  const picked = pickBrandColours(colours);
  return { ...(picked || { primary: DEFAULT_BRAND.primary, secondary: DEFAULT_BRAND.secondary }), logoUrl: webUrl(logo?.href, url) || `${new URL(url).origin}/favicon.ico`, source: "website" };
}
async function retrieveBrand(domain: string, env: Pick<Bindings, "BRAND_DEV_API_KEY">): Promise<Brand> {
  if (env.BRAND_DEV_API_KEY?.trim()) try {
    const response = await fetch(`https://api.brand.dev/v1/brand/retrieve?domain=${encodeURIComponent(domain)}`, { headers: { Authorization: `Bearer ${env.BRAND_DEV_API_KEY.trim()}` }, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (response.ok) {
      const body = await response.json() as { brand?: { colors?: Array<{ hex?: string }>; logos?: Array<{ type?: string; url?: string; width?: number; height?: number; resolution?: { width?: number; height?: number } }> } };
      const colours = pickBrandColours((body.brand?.colors || []).flatMap((c) => typeof c.hex === "string" ? [c.hex.startsWith("#") ? c.hex : `#${c.hex}`] : []));
      const logos = (body.brand?.logos || []).filter((l) => webUrl(l.url, `https://${domain}/`));
      const logo = logos.find((l) => l.type === "icon") || logos.find((l) => { const w = l.width ?? l.resolution?.width; const h = l.height ?? l.resolution?.height; return w && h && w / h > 0.8 && w / h < 1.25; }) || logos[0];
      if (colours || logo) return { ...(colours || { primary: DEFAULT_BRAND.primary, secondary: DEFAULT_BRAND.secondary }), logoUrl: webUrl(logo?.url, `https://${domain}/`), source: "brand.dev" };
    }
  } catch { /* A branding service failure falls back to the company's own page. */ }
  try { return await websiteBrand(domain); } catch { return DEFAULT_BRAND; }
}
export async function brandFor(input: string, env: Pick<Bindings, "DB" | "BRAND_DEV_API_KEY">): Promise<Brand> {
  const domain = safeDomain(input);
  if (!domain) return DEFAULT_BRAND;
  const key = `brand:${domain}`;
  try {
    const cached = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string | null }>();
    const entry = cached?.value ? JSON.parse(cached.value) as { at: number; brand: Brand } : null;
    if (entry && Date.now() - entry.at < 86_400_000) return entry.brand;
  } catch { /* A broken/missing cache should never break the preview. */ }
  const brand = await retrieveBrand(domain, env);
  try { await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify({ at: Date.now(), brand })).run(); }
  catch { /* The brand remains usable without a cache write. */ }
  return brand;
}
