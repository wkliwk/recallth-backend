/**
 * Find a clear, front-facing picture of a product on the web (best effort, SSRF-guarded).
 *
 * Candidates are gathered from the product's reference pages (official site first) and then judged by a vision
 * model against the user's own photo: only the FRONT of the SAME product, clear and uncropped, is accepted — logos,
 * banners, lifestyle shots, back labels, multi-product shots and other variants are rejected. None → null, and the
 * app falls back to the user's own photo.
 */
import { safeFetch as defaultSafeFetch, SafeResponse } from './safeFetch';
import { sniffImageType } from './imageType';

type Fetcher = (url: string, opts?: Record<string, unknown>) => Promise<SafeResponse>;

export interface ImageCandidate {
  url: string;
  mime: string;
  base64: string;
}

/** Chooses the best candidate (0-based index) or null. Injected so tests do not need a model. */
export type ImageChooser = (photo: { base64: string; mime: string }, candidates: ImageCandidate[], hint: { name?: string; brand?: string }) => Promise<number | null>;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// Formats the vision model accepts (no AVIF / GIF).
const VISION_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
 * Candidate image URLs from one page, best-first: schema.org Product images, then og:image, twitter:image and
 * image_src. Anything goes in here — a vision model judges them afterwards — but only https, resolved against the
 * page URL and deduplicated.
 */
export function extractImageCandidates(html: string, baseUrl: string): string[] {
  const raw = [
    ...ldProductImages(html),
    ...meta(html, 'property', 'og:image:secure_url'),
    ...meta(html, 'property', 'og:image'),
    ...meta(html, 'name', 'twitter:image'),
    ...meta(html, 'property', 'twitter:image'),
  ];
  const link = html.match(/<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i);
  if (link) raw.push(link[1]);

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

export interface PickOptions {
  pageUrls: string[];
  photo: { base64: string; mime: string };
  name?: string;
  brand?: string;
}

export async function pickProductImage(
  opts: PickOptions,
  deps: { safeFetch?: Fetcher; chooser: ImageChooser; morePages?: () => Promise<string[]>; maxPages?: number; perPage?: number; maxCandidates?: number },
): Promise<string | null> {
  const fetcher = deps.safeFetch ?? (defaultSafeFetch as unknown as Fetcher);
  const maxPages = deps.maxPages ?? 4;
  const perPage = deps.perPage ?? 3;
  const maxCandidates = deps.maxCandidates ?? 6;

  // pages (in the given order = most reliable source first) -> downloaded, byte-verified candidate images
  const collect = async (pageUrls: string[]): Promise<ImageCandidate[]> => {
    // 1. pages, fetched in parallel
    const pages = await Promise.all(
      pageUrls.slice(0, maxPages).map(async (url) => {
        try {
          const res = await fetcher(url, { timeoutMs: 3500, maxBytes: 1_200_000, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' } });
          return res.ok ? extractImageCandidates(res.text(), res.url || url).slice(0, perPage) : [];
        } catch {
          return [];
        }
      }),
    );

    // 2. interleave so every page gets a chance, official page's images first
    const urls: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < perPage; i++) {
      for (const list of pages) {
        const u = list[i];
        if (u && !seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
    }

    // 3. download + byte-verify (raster formats the vision model understands), in parallel
    const downloaded = await Promise.all(
      urls.slice(0, maxCandidates + 2).map(async (url): Promise<ImageCandidate | null> => {
        try {
          const img = await fetcher(url, { timeoutMs: 2500, maxBytes: 700_000, onLimit: 'error', headers: { 'User-Agent': UA, Accept: 'image/webp,image/jpeg,image/png;q=0.9,*/*;q=0.5', Referer: new URL(url).origin + '/' } });
          if (!img.ok) return null;
          const mime = sniffImageType(img.body);
          if (!mime || !VISION_MIMES.has(mime)) return null;
          return { url, mime, base64: img.body.toString('base64') };
        } catch {
          return null;
        }
      }),
    );
    return downloaded.filter((c): c is ImageCandidate => !!c).slice(0, maxCandidates);
  };

  try {
    let candidates = await collect(opts.pageUrls);
    // The given pages gave nothing (blocked, no pictures): look for the product's other pages and try those.
    if (candidates.length === 0 && deps.morePages) {
      const tried = new Set(opts.pageUrls);
      const extra = (await deps.morePages().catch(() => [])).filter((u) => !tried.has(u));
      if (extra.length > 0) candidates = await collect(extra);
    }
    if (candidates.length === 0) return null;

    // 4. the vision model decides (or rejects them all)
    const idx = await deps.chooser(opts.photo, candidates, { name: opts.name, brand: opts.brand });
    return idx !== null && Number.isInteger(idx) && idx >= 0 && idx < candidates.length ? candidates[idx].url : null;
  } catch {
    return null;
  }
}
