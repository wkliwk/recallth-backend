import { rewrapImageUrl } from '../utils/imageUrl';

const BASE = 'https://api.example.com';

describe('rewrapImageUrl', () => {
  it('returns undefined for empty values', () => {
    expect(rewrapImageUrl(undefined, BASE)).toBeUndefined();
    expect(rewrapImageUrl('', BASE)).toBeUndefined();
    expect(rewrapImageUrl(null, BASE)).toBeUndefined();
  });

  it('leaves data:image URLs (uploaded photos / scan thumbnails) unchanged', () => {
    const d = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    expect(rewrapImageUrl(d, BASE)).toBe(d);
    expect(rewrapImageUrl('DATA:IMAGE/PNG;base64,AAAA', BASE)).toBe('DATA:IMAGE/PNG;base64,AAAA');
  });

  it('wraps a raw https URL through the current proxy', () => {
    expect(rewrapImageUrl('https://cdn.test/a b.png', BASE)).toBe(`${BASE}/img/image-proxy?url=${encodeURIComponent('https://cdn.test/a b.png')}`);
  });

  it('re-wraps an old-host proxy URL with the current host', () => {
    const old = `https://old.railway.app/img/image-proxy?url=${encodeURIComponent('https://cdn.test/a.png')}`;
    expect(rewrapImageUrl(old, BASE)).toBe(`${BASE}/img/image-proxy?url=${encodeURIComponent('https://cdn.test/a.png')}`);
  });

  it('does not throw on a malformed percent-encoding', () => {
    expect(() => rewrapImageUrl('https://old/img/image-proxy?url=%E0%A4%A', BASE)).not.toThrow();
  });
});
