import http from 'http';
import zlib from 'zlib';
import { AddressInfo } from 'net';
import dns from 'dns';
import {
  isBlockedAddress,
  assertSafeUrl,
  createSafeFetch,
  safeFetch,
  UnsafeUrlError,
  SafeFetchError,
} from '../utils/safeFetch';

describe('isBlockedAddress', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '127.0.0.1', '127.1.2.3',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::2', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a00:1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    'not an ip', '', '999.1.1.1', '1.2.3',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'];

  it.each(blocked)('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(allowed)('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  const bad = [
    'file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.com',
    'http://user:pass@example.com/', 'http://example.com:8080/', 'https://example.com:22/', 'http://example.com:6379/',
    'http://localhost/', 'http://localhost:80/', 'http://foo.localhost/', 'http://printer.local/', 'http://metadata.google.internal/',
    'http://intranet/', 'http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0/', 'http://10.1.2.3/', 'http://192.168.0.1/',
    'not a url', '', `http://example.com/${'a'.repeat(3000)}`,
  ];
  it.each(bad)('rejects %s', (u) => {
    expect(() => assertSafeUrl(u)).toThrow(UnsafeUrlError);
  });

  it('accepts normal public URLs', () => {
    expect(assertSafeUrl('https://www.example.com/p?id=1#x').hostname).toBe('www.example.com');
    expect(assertSafeUrl('http://example.com:80/').hostname).toBe('example.com');
    expect(assertSafeUrl('https://example.com:443/').hostname).toBe('example.com');
    expect(assertSafeUrl('https://8.8.8.8/').hostname).toBe('8.8.8.8');
  });
});

// ─── Behaviour against a local test server ───────────────────────────────────

describe('safeFetch', () => {
  let server: http.Server;
  let base = '';
  let hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url || '');
      const url = req.url || '';
      if (url === '/ok') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<html>hello</html>');
      } else if (url === '/gzip') {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Type', 'text/html');
        res.end(zlib.gzipSync('<html>zipped page</html>'));
      } else if (url === '/big') {
        res.setHeader('Content-Type', 'text/html');
        res.end('x'.repeat(5000));
      } else if (url === '/bomb') {
        res.setHeader('Content-Encoding', 'gzip');
        res.end(zlib.gzipSync(Buffer.alloc(5_000_000, 'a')));
      } else if (url === '/redirect-ok') {
        res.statusCode = 302;
        res.setHeader('Location', '/ok');
        res.end();
      } else if (url === '/redirect-private') {
        res.statusCode = 302;
        res.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
        res.end();
      } else if (url === '/redirect-loop') {
        res.statusCode = 302;
        res.setHeader('Location', '/redirect-loop');
        res.end();
      } else if (url === '/slow') {
        setTimeout(() => res.end('late'), 1500);
      } else if (url === '/forbidden') {
        res.statusCode = 403;
        res.end('no');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    hits = [];
  });

  describe('default instance (real rules)', () => {
    it('refuses a loopback destination and never contacts the server', async () => {
      await expect(safeFetch(`${base}/ok`)).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(hits).toHaveLength(0);
    });
    it('refuses internal / metadata addresses without any network access', async () => {
      for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://10.0.0.1/', 'http://[::1]/']) {
        await expect(safeFetch(u)).rejects.toBeInstanceOf(UnsafeUrlError);
      }
    });
  });

  // Permissive instance that only lifts the "port" and "loopback" rules so we can exercise the fetching code.
  const permissive = createSafeFetch({ allowedPorts: 'any', isBlockedAddress: (ip) => ip === '169.254.169.254' });

  it('fetches a normal response', async () => {
    const r = await permissive(`${base}/ok`);
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.text()).toBe('<html>hello</html>');
    expect(r.headers['content-type']).toBe('text/html');
  });

  it('decodes gzip', async () => {
    const r = await permissive(`${base}/gzip`);
    expect(r.text()).toBe('<html>zipped page</html>');
  });

  it('truncates at maxBytes by default and flags it', async () => {
    const r = await permissive(`${base}/big`, { maxBytes: 1000 });
    expect(r.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
  });

  it('errors at maxBytes when onLimit is "error"', async () => {
    await expect(permissive(`${base}/big`, { maxBytes: 1000, onLimit: 'error' })).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('caps decompressed output (zip bomb)', async () => {
    await expect(permissive(`${base}/bomb`, { maxBytes: 100_000, onLimit: 'error' })).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('follows a safe redirect', async () => {
    const r = await permissive(`${base}/redirect-ok`);
    expect(r.text()).toBe('<html>hello</html>');
    expect(hits).toEqual(['/redirect-ok', '/ok']);
  });

  it('re-validates every redirect hop (redirect to metadata address is refused)', async () => {
    await expect(permissive(`${base}/redirect-private`)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(hits).toEqual(['/redirect-private']);
  });

  it('stops redirect loops', async () => {
    await expect(permissive(`${base}/redirect-loop`, { maxRedirects: 3 })).rejects.toThrow(/redirect/i);
  });

  it('enforces the total timeout', async () => {
    await expect(permissive(`${base}/slow`, { timeoutMs: 300 })).rejects.toThrow(/timed out/i);
  });

  it('returns non-2xx responses without throwing', async () => {
    const r = await permissive(`${base}/forbidden`);
    expect(r.status).toBe(403);
    expect(r.ok).toBe(false);
  });

  it('blocks a public-looking name that resolves to a private IP (DNS rebinding) and never connects', async () => {
    const port = new URL(base).port;
    const fakeLookup = ((host: string, _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as unknown as typeof dns.lookup;
    const rebinding = createSafeFetch({ allowedPorts: 'any', dnsLookup: fakeLookup }); // default blocklist
    await expect(rebinding(`http://evil.example.com:${port}/ok`)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(hits).toHaveLength(0);
  });

  it('blocks when ANY resolved address is private (mixed answer)', async () => {
    const port = new URL(base).port;
    const fakeLookup = ((host: string, _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    }) as unknown as typeof dns.lookup;
    const mixed = createSafeFetch({ allowedPorts: 'any', dnsLookup: fakeLookup });
    await expect(mixed(`http://mixed.example.com:${port}/ok`)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(hits).toHaveLength(0);
  });
});
