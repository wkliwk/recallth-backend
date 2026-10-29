import { extractImageCandidates, findProductImage } from '../utils/pageImage';
import type { SafeResponse } from '../utils/safeFetch';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const resp = (status: number, body: Buffer | string, url = 'https://shop.example.com/p/1'): SafeResponse => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { status, ok: status >= 200 && status < 300, headers: {}, body: b, url, truncated: false, text: () => b.toString('utf8') };
};

describe('extractImageCandidates (trusted sources only)', () => {
  it('uses a schema.org Product image (string, array, object, @graph)', () => {
    const html = `
      <script type="application/ld+json">{"@type":"Product","image":["https://cdn.example.com/p1.jpg","/img/p2.jpg"]}</script>
      <script type="application/ld+json">{"@graph":[{"@type":"Organization","logo":"https://cdn.example.com/logo.png","image":"https://cdn.example.com/org.png"},{"@type":["Thing","Product"],"image":{"url":"https://cdn.example.com/g.jpg"}}]}</script>
      <script type="application/ld+json">{ not json</script>`;
    expect(extractImageCandidates(html, 'https://shop.example.com/p/1')).toEqual([
      'https://cdn.example.com/p1.jpg',
      'https://shop.example.com/img/p2.jpg',
      'https://cdn.example.com/g.jpg', // Organization image/logo is not used
    ]);
  });

  it('uses og:image only when the page says og:type is product (either attribute order)', () => {
    const product = `<meta property="og:type" content="og:product"><meta content="//cdn.example.com/b.png" property="og:image:secure_url"><meta property="og:image" content="/img/a.jpg">`;
    expect(extractImageCandidates(product, 'https://shop.example.com/p/1')).toEqual(['https://cdn.example.com/b.png', 'https://shop.example.com/img/a.jpg']);
    const website = `<meta property="og:type" content="website"><meta property="og:image" content="https://cdn.example.com/banner.png">`;
    expect(extractImageCandidates(website, 'https://x.test/')).toEqual([]);
    expect(extractImageCandidates(`<meta property="og:image" content="https://cdn.example.com/banner.png">`, 'https://x.test/')).toEqual([]); // no og:type at all
  });

  it('never uses twitter:image / image_src alone, and drops non-https and duplicates', () => {
    const html = `<meta name="twitter:image" content="https://cdn.example.com/t.jpg"><link rel="image_src" href="https://cdn.example.com/l.jpg">
      <script type="application/ld+json">{"@type":"Product","image":["javascript:alert(1)","data:image/png;base64,AAAA","http://cdn.example.com/a.jpg","https://cdn.example.com/a.jpg"]}</script>`;
    expect(extractImageCandidates(html, 'https://x.test/')).toEqual(['https://cdn.example.com/a.jpg']);
  });

  it('returns nothing for a page without trusted images', () => {
    expect(extractImageCandidates('<html><body>hi</body></html>', 'https://x.test/')).toEqual([]);
  });
});

describe('findProductImage', () => {
  const page = '<script type="application/ld+json">{"@type":"Product","image":["https://cdn.example.com/a.jpg","https://cdn.example.com/b.jpg"]}</script>';

  it('returns the first candidate whose bytes are a real image', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url === 'https://shop.example.com/p/1') return resp(200, page);
      if (url.endsWith('a.jpg')) return resp(200, '<html>not an image</html>', url);
      return resp(206, PNG, url);
    });
    expect(await findProductImage('https://shop.example.com/p/1', { safeFetch: fetcher })).toBe('https://cdn.example.com/b.jpg');
  });

  it('is null when the page is not ok, has no images, or every candidate fails', async () => {
    expect(await findProductImage('https://x.test/', { safeFetch: async () => resp(403, 'no') })).toBeNull();
    expect(await findProductImage('https://x.test/', { safeFetch: async () => resp(200, '<html></html>') })).toBeNull();
    const failing = async (url: string) => {
      if (url === 'https://x.test/') return resp(200, page);
      throw new Error('boom');
    };
    expect(await findProductImage('https://x.test/', { safeFetch: failing })).toBeNull();
  });

  it('never throws, even when the page fetch is refused (e.g. blocked address)', async () => {
    const refuse = async () => {
      throw new Error('Address not allowed');
    };
    await expect(findProductImage('http://127.0.0.1/', { safeFetch: refuse })).resolves.toBeNull();
  });

  it('only tries up to maxCandidates', async () => {
    const many = `<script type="application/ld+json">{"@type":"Product","image":[${Array.from({ length: 6 }, (_, i) => `"https://cdn.example.com/${i}.jpg"`).join(',')}]}</script>`;
    const fetcher = jest.fn(async (url: string) => (url === 'https://x.test/' ? resp(200, many) : resp(404, '', url)));
    await findProductImage('https://x.test/', { safeFetch: fetcher, maxCandidates: 2 });
    expect(fetcher).toHaveBeenCalledTimes(3); // page + 2 candidates
  });
});
