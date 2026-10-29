/**
 * Reference links kept with an item: the pages used to identify the product, cleaned, classified by how reliable
 * the source is (official site > official database > reputable retailer > other) and sorted by that.
 */
import { safeFetch as defaultSafeFetch, SafeResponse } from './safeFetch';

export type ReferenceKind = 'official' | 'database' | 'retailer' | 'other';
export interface Reference {
  url: string;
  title: string;
  kind: ReferenceKind;
}

export const MAX_REFERENCES = 5;
const KIND_ORDER: Record<ReferenceKind, number> = { official: 0, database: 1, retailer: 2, other: 3 };
const KINDS = Object.keys(KIND_ORDER) as ReferenceKind[];

// Reputable retailers / pharmacies (exact registrable domain or subdomain of it).
const RETAILER_DOMAINS = [
  'iherb.com', 'costco.ca', 'costco.com', 'shoppersdrugmart.ca', 'walmart.ca', 'walmart.com', 'well.ca', 'londondrugs.com',
  'vitacost.com', 'gnc.com', 'vitaminshoppe.com', 'cvs.com', 'walgreens.com', 'target.com', 'amazon.com', 'amazon.ca',
  'amazon.co.jp', 'amazon.co.uk', 'rakuten.co.jp', 'matsukiyo.co.jp', 'welcia.co.jp', 'sundrug.co.jp', 'tsuruha.co.jp',
  'watsons.com.hk', 'watsons.ca', 'mannings.com.hk', 'hktvmall.com', 'sasa.com', 'boots.com', 'lloydspharmacy.com',
  'chemistwarehouse.com.au', 'superdrug.com', 'holandandbarrett.com', 'healthyplanetcanada.com', 'rexall.ca', 'jeancoutu.com',
];
// Official / regulatory / reference databases.
const DATABASE_SUFFIXES = ['.gov', '.gov.uk', '.gov.au', '.gc.ca', '.go.jp', '.gov.hk', '.europa.eu'];
const DATABASE_DOMAINS = [
  'canada.ca', 'health-products.canada.ca', 'dailymed.nlm.nih.gov', 'nih.gov', 'fda.gov', 'mhlw.go.jp', 'pmda.go.jp',
  'openfoodfacts.org', 'drugs.com', 'medlineplus.gov', 'ods.od.nih.gov', 'ema.europa.eu', 'tga.gov.au',
];

const TRACKING_PARAM = /^(utm_|gclid$|fbclid$|msclkid$|mc_|_hs|ref$|ref_|affid|aff_|cmpid|campaign|igshid$|yclid$)/i;

/** http(s) only, no credentials, fragment and tracking parameters removed; null when not a usable URL. */
export function cleanReferenceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  if (u.toString().length > 2000) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  return u.toString();
}

const domainIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9぀-ヿ㐀-鿿]+/g, '');

/** official = the brand's own site (brand name is a domain label); database; retailer; otherwise other. */
export function classifyReference(url: string, brand?: string | null): ReferenceKind {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'other';
  }
  if (DATABASE_DOMAINS.some((d) => domainIs(host, d)) || DATABASE_SUFFIXES.some((s) => host.endsWith(s))) return 'database';

  const b = norm(brand ?? '');
  if (b.length >= 3) {
    const labels = host.split('.').slice(0, -1); // drop the TLD; keep "co" etc. harmlessly
    const hit = labels.some((label) => {
      const parts = label.split('-').map(norm);
      const whole = norm(label);
      return whole === b || (b.length >= 4 && whole.startsWith(b)) || parts.includes(b);
    });
    if (hit && !RETAILER_DOMAINS.some((d) => domainIs(host, d))) return 'official';
  }
  if (RETAILER_DOMAINS.some((d) => domainIs(host, d))) return 'retailer';
  return 'other';
}

export const hostnameTitle = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 60);
  }
};

const cap = (s: string, n: number) => s.trim().replace(/\s+/g, ' ').slice(0, n);

/** Sort by source reliability (stable), keep at most `max`; "other" only fills up to 2 slots when few better ones exist. */
export function rankReferences(refs: Reference[], max = MAX_REFERENCES): Reference[] {
  const sorted = [...refs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const good = sorted.filter((r) => r.kind !== 'other');
  const others = sorted.filter((r) => r.kind === 'other');
  const room = good.length >= 2 ? 0 : Math.min(others.length, 2 - good.length);
  return [...good, ...others.slice(0, room)].slice(0, max);
}

export type ReferencesParse = { ok: true; value: Reference[] } | { ok: false; error: string };

/** Validate a client-supplied references array (create / update). [] clears. */
export function parseReferences(raw: unknown): ReferencesParse {
  if (!Array.isArray(raw)) return { ok: false, error: 'references must be an array' };
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'each reference must be an object' };
    const o = item as Record<string, unknown>;
    const url = cleanReferenceUrl(o.url);
    if (!url) return { ok: false, error: 'each reference needs a valid http(s) url' };
    if (seen.has(url)) continue;
    seen.add(url);
    const kind = KINDS.includes(o.kind as ReferenceKind) ? (o.kind as ReferenceKind) : 'other';
    const title = typeof o.title === 'string' && o.title.trim() ? cap(o.title, 200) : hostnameTitle(url);
    out.push({ url, title, kind });
    if (out.length > MAX_REFERENCES) return { ok: false, error: `at most ${MAX_REFERENCES} references` };
  }
  return { ok: true, value: out };
}

type Fetcher = (url: string, opts?: Record<string, unknown>) => Promise<SafeResponse>;

const pageTitle = (html: string): string | null => {
  const m = html.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  return m ? cap(m[1].replace(/&amp;/g, '&'), 200) : null;
};

/**
 * Turn the model's cited page + the pages grounding consulted into clean, resolved, classified references.
 * Grounding links are opaque redirects, so each is fetched (SSRF-guarded, tiny) to learn its final URL and title.
 */
export async function buildReferences(
  input: { sourceUrl?: string | null; chunks?: Array<{ uri?: string; title?: string }>; brand?: string | null },
  deps: { safeFetch?: Fetcher } = {},
): Promise<Reference[]> {
  const fetcher = deps.safeFetch ?? (defaultSafeFetch as unknown as Fetcher);
  const raw: Array<{ url: string; title?: string }> = [];
  if (input.sourceUrl) raw.push({ url: input.sourceUrl });
  for (const c of input.chunks ?? []) if (c?.uri) raw.push({ url: c.uri, title: c.title });

  const unique: Array<{ url: string; title?: string }> = [];
  const seenRaw = new Set<string>();
  for (const r of raw) {
    const u = cleanReferenceUrl(r.url);
    if (u && !seenRaw.has(u)) {
      seenRaw.add(u);
      unique.push({ url: u, title: r.title });
    }
    if (unique.length >= 6) break;
  }

  const resolved = await Promise.all(
    unique.map(async (r): Promise<Reference | null> => {
      try {
        const res = await fetcher(r.url, {
          timeoutMs: 2500,
          maxBytes: 30_000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'text/html' },
        });
        if (res.status === 404 || res.status === 410 || res.status >= 500) return null; // dead link
        const finalUrl = cleanReferenceUrl(res.url) ?? r.url;
        const title = pageTitle(res.text()) ?? (r.title && r.title.trim()) ?? hostnameTitle(finalUrl);
        return { url: finalUrl, title: cap(title, 200), kind: classifyReference(finalUrl, input.brand) };
      } catch {
        return null; // unreachable / blocked: not a link we can vouch for
      }
    }),
  );

  const seen = new Set<string>();
  const refs = resolved.filter((r): r is Reference => !!r && !seen.has(r.url) && !!seen.add(r.url));
  return rankReferences(refs);
}
