/**
 * Find a product's picture on its page (best effort, SSRF-guarded): og:image / twitter:image / JSON-LD / image_src,
 * verified to really be a raster image. Used by /cabinet/identify with the page the model cited as its source.
 */
import { safeFetch as defaultSafeFetch, SafeResponse } from './safeFetch';
import { sniffImageType } from './imageType';

type Fetcher = (url: string, opts?: Record<string, unknown>) => Promise<SafeResponse>;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function meta(html: string, attr: 'property' | 'name', key: string): string[] {
  const out: string[] = [];
  const a = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`, 'gi');
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${key}["']`, 'gi');
  for (const re of [a, b]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) out.push(m[1]);
  }
  return out;
}

const isProduct = (node: unknown): boolean => {
  if (!node || typeof node !== 'object') return false;
  const t = (node as Record<string, unknown>)['@type'];
  return Array.isArray(t) ? t.some((x) => String(x).toLowerCase() === 'product') : String(t ?? '').toLowerCase() === 'product';
};

/** Images declared by schema.org Product nodes only (not Organization logos, breadcrumbs, …). */
function ldProductImages(html: string): string[] {
  const out: string[] = [];
  const pickImage = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(pickImage);
    else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).url === 'string') out.push((v as Record<string, string>).url);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (isProduct(o)) pickImage(o.image);
    if (Array.isArray(o['@graph'])) (o['@graph'] as unknown[]).forEach(visit);
  };
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const block of blocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      visit(JSON.parse(inner));
    } catch {
      /* invalid JSON-LD: ignore */
    }
  }
  return out;
}

/**
 * Trusted product-image candidates, in priority order, resolved against the page URL, https only, deduplicated.
 * Trusted = a schema.org Product's image, or an og:image on a page that declares og:type "product".
 * A bare og:image is NOT used: on manufacturer sites it is usually a site-wide banner or logo, and a wrong
 * picture is worse than none (the app then falls back to the user's own photo).
 */
export function extractImageCandidates(html: string, baseUrl: string): string[] {
  const ogType = meta(html, 'property', 'og:type').join(' ').toLowerCase();
  const raw = [...ldProductImages(html)];
  if (ogType.includes('product')) {
    raw.push(...meta(html, 'property', 'og:image:secure_url'), ...meta(html, 'property', 'og:image'));
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    let u: URL;
    try {
      u = new URL(r.trim().replace(/&amp;/g, '&'), baseUrl);
    } catch {
      continue;
    }
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') continue;
    const key = u.toString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export async function findProductImage(
  pageUrl: string,
  deps: { safeFetch?: Fetcher; maxCandidates?: number } = {},
): Promise<string | null> {
  const fetcher = deps.safeFetch ?? (defaultSafeFetch as unknown as Fetcher);
  const maxCandidates = deps.maxCandidates ?? 2;
  try {
    const page = await fetcher(pageUrl, {
      timeoutMs: 3500,
      maxBytes: 1_200_000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!page.ok) return null;
    const candidates = extractImageCandidates(page.text(), page.url || pageUrl).slice(0, maxCandidates);
    for (const url of candidates) {
      try {
        const img = await fetcher(url, {
          timeoutMs: 2000,
          maxBytes: 32,
          headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*;q=0.8', Referer: new URL(page.url || pageUrl).origin + '/', Range: 'bytes=0-31' },
        });
        if ((img.ok || img.status === 206) && sniffImageType(img.body)) return url;
      } catch {
        /* try the next candidate */
      }
    }
  } catch {
    /* unreachable / blocked page: no image */
  }
  return null;
}
