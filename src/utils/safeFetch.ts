/**
 * SSRF-safe HTTP(S) fetch for URLs that come from users or from page content.
 *
 * - only http/https, no credentials, only ports 80/443
 * - refuses localhost / internal names and IP literals in private, loopback, link-local, reserved ranges
 * - the address actually connected to is validated at connect time (custom DNS lookup), which also
 *   defeats DNS rebinding and public names that resolve to private IPs
 * - redirects are followed manually (max 3) and every hop is validated again
 * - response size, decompressed size and total time are capped
 */
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import zlib from 'zlib';

export class UnsafeUrlError extends Error {
  readonly code = 'UNSAFE_URL';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

// ─── Address classification ──────────────────────────────────────────────────

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Parse an IPv6 literal (with optional embedded IPv4 and zone id) into 8 hextets, or null. */
function parseV6(input: string): number[] | null {
  let ip = input.split('%')[0].toLowerCase();
  if (ip.includes('.')) {
    const idx = ip.lastIndexOf(':');
    const v4 = ip.slice(idx + 1);
    if (!net.isIPv4(v4)) return null;
    const n = ipv4ToInt(v4);
    ip = `${ip.slice(0, idx + 1)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const parts = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...tail];
  const out = parts.map((h) => parseInt(h, 16));
  return out.length === 8 && out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}

function v6Prefix(h: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 16) {
    const take = Math.min(16, bits - i);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((h[i / 16] & mask) !== (prefix[i / 16] & mask)) return false;
  }
  return true;
}

function isBlockedV6(ip: string): boolean {
  const h = parseV6(ip);
  if (!h) return true; // unparseable → fail closed
  // IPv4-mapped (::ffff:a.b.c.d): judge by the embedded IPv4 address
  if (v6Prefix(h, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96)) {
    return isBlockedV4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  }
  const blocks: Array<[number[], number]> = [
    [[0, 0, 0, 0, 0, 0, 0, 0], 96], // ::, ::1 and IPv4-compatible ::a.b.c.d
    [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96], // NAT64
    [[0x100, 0, 0, 0, 0, 0, 0, 0], 64], // discard-only
    [[0x2001, 0, 0, 0, 0, 0, 0, 0], 32], // Teredo
    [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32], // documentation
    [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16], // 6to4
    [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique local
    [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link-local
    [[0xfec0, 0, 0, 0, 0, 0, 0, 0], 10], // site-local (deprecated)
    [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], // multicast
  ];
  return blocks.some(([prefix, bits]) => v6Prefix(h, prefix, bits));
}

/** True when the address must never be fetched. Anything that is not a valid IP is blocked. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true;
}

// ─── URL validation ──────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 2048;
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet'];

export interface SafeFetchDeps {
  isBlockedAddress?: (ip: string) => boolean;
  allowedPorts?: number[] | 'any';
  dnsLookup?: typeof dns.lookup;
}

function validateUrl(raw: string, deps: Required<SafeFetchDeps>): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new UnsafeUrlError('URL missing or too long');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URL are not allowed');

  if (deps.allowedPorts !== 'any') {
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!deps.allowedPorts.includes(port)) throw new UnsafeUrlError('Port not allowed');
  }

  // WHATWG URL already canonicalises 2130706433 / 0x7f.1 / 0177.0.0.1 → 127.0.0.1 and wraps IPv6 in [].
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new UnsafeUrlError('Missing host');
  if (net.isIP(host)) {
    if (deps.isBlockedAddress(host)) throw new UnsafeUrlError('Address not allowed');
    return url;
  }
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.')) {
    throw new UnsafeUrlError('Host not allowed');
  }
  return url;
}

/** Validate a URL without fetching it (used for fast pre-checks and tests). */
export function assertSafeUrl(raw: string, deps: SafeFetchDeps = {}): URL {
  return validateUrl(raw, withDefaults(deps));
}

function withDefaults(deps: SafeFetchDeps): Required<SafeFetchDeps> {
  return {
    isBlockedAddress: deps.isBlockedAddress ?? isBlockedAddress,
    allowedPorts: deps.allowedPorts ?? [80, 443],
    dnsLookup: deps.dnsLookup ?? dns.lookup,
  };
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number; // total, across redirects (default 8000)
  maxBytes?: number; // response body cap after decompression (default 1.5 MB)
  onLimit?: 'truncate' | 'error'; // what to do when the cap is hit (default truncate)
  maxRedirects?: number; // default 3
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  truncated: boolean;
  text(): string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function createSafeFetch(rawDeps: SafeFetchDeps = {}) {
  const deps = withDefaults(rawDeps);

  // Validates every address the name resolves to; if ANY is blocked the connection is refused.
  const lookup = (hostname: string, options: unknown, cb: (...a: unknown[]) => void): void => {
    const opts = typeof options === 'object' && options !== null ? (options as dns.LookupOptions) : {};
    (deps.dnsLookup as typeof dns.lookup)(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as unknown as dns.LookupAddress[];
      if (!list.length || list.some((a) => deps.isBlockedAddress(a.address))) {
        return cb(new UnsafeUrlError('Address not allowed'));
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };

  return async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
    const timeoutMs = options.timeoutMs ?? 8000;
    const maxBytes = options.maxBytes ?? 1_500_000;
    const onLimit = options.onLimit ?? 'truncate';
    const maxRedirects = options.maxRedirects ?? 3;
    const method = options.method ?? 'GET';
    const deadline = Date.now() + timeoutMs;

    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = validateUrl(current, deps);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SafeFetchError('Timed out');

      const result = await requestOnce(url, { method, headers: options.headers ?? {}, remaining, maxBytes, onLimit, lookup });
      if (REDIRECT_STATUSES.has(result.status) && result.headers['location']) {
        if (hop === maxRedirects) throw new SafeFetchError('Too many redirects');
        try {
          current = new URL(result.headers['location'], url).toString();
        } catch {
          throw new SafeFetchError('Bad redirect');
        }
        continue;
      }
      return result;
    }
    throw new SafeFetchError('Too many redirects');
  };
}

interface OnceArgs {
  method: string;
  headers: Record<string, string>;
  remaining: number;
  maxBytes: number;
  onLimit: 'truncate' | 'error';
  lookup: (hostname: string, options: unknown, cb: (...a: unknown[]) => void) => void;
}

function requestOnce(url: URL, a: OnceArgs): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = lib.request(
      url,
      {
        method: a.method,
        agent: false, // no connection pooling: every request does its own validated lookup
        lookup: a.lookup as unknown as net.LookupFunction,
        headers: { 'Accept-Encoding': 'gzip, deflate, br', ...a.headers },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
        const status = res.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(status)) {
          res.resume();
          return finish(() => resolve(build(url, status, headers, Buffer.alloc(0), false)));
        }

        const encoding = (headers['content-encoding'] || '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const stop = () => {
          res.destroy();
          (stream as unknown as { destroy?: () => void }).destroy?.();
        };

        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > a.maxBytes) {
            if (a.onLimit === 'error') {
              stop();
              return finish(() => reject(new SafeFetchError('Response too large')));
            }
            chunks.push(chunk.subarray(0, chunk.length - (size - a.maxBytes)));
            truncated = true;
            stop();
            return finish(() => resolve(build(url, status, headers, Buffer.concat(chunks), true)));
          }
          chunks.push(chunk);
        });
        stream.on('end', () => finish(() => resolve(build(url, status, headers, Buffer.concat(chunks), truncated))));
        stream.on('error', (err: Error) => finish(() => reject(err)));
        res.on('error', (err) => finish(() => reject(err)));
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new SafeFetchError('Timed out')));
    }, a.remaining);

    req.on('error', (err) => finish(() => reject(err)));
    req.end();
  });
}

function build(url: URL, status: number, headers: Record<string, string>, body: Buffer, truncated: boolean): SafeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    url: url.toString(),
    truncated,
    text: () => body.toString('utf8'),
  };
}

/** Default instance: real DNS, ports 80/443 only. */
export const safeFetch = createSafeFetch();
