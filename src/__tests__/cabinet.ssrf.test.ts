/**
 * Route-level SSRF tests for POST /cabinet/url-lookup and the unauthenticated GET /img/image-proxy.
 * Blocked destinations go through the REAL safeFetch (no network is ever touched); upstream
 * responses for the allowed paths are mocked.
 */
import express from 'express';
import request from 'supertest';

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: (...a: unknown[]) => mockGenerateContent(...a) }),
  })),
}));
jest.mock('../models/CabinetItem', () => ({ CabinetItem: {} }));
jest.mock('../models/AiCache', () => ({
  getCached: jest.fn().mockResolvedValue(null),
  setCached: jest.fn(),
  deleteCached: jest.fn().mockResolvedValue(undefined),
}));

const mockSafeFetch = jest.fn();
jest.mock('../utils/safeFetch', () => {
  const actual = jest.requireActual('../utils/safeFetch');
  return { ...actual, safeFetch: (...a: unknown[]) => mockSafeFetch(...a) };
});

import cabinetRouter, { imageProxyRouter } from '../routes/cabinet';
import { SafeFetchError } from '../utils/safeFetch';

const realSafeFetch = jest.requireActual('../utils/safeFetch').safeFetch as (...a: unknown[]) => Promise<unknown>;

const app = express();
app.use(express.json());
app.use('/img', imageProxyRouter); // no auth, like production
app.use((req, _res, next) => {
  (req as unknown as { userId: string }).userId = '507f1f77bcf86cd799439011';
  next();
});
app.use('/cabinet', cabinetRouter);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const resp = (status: number, headers: Record<string, string>, body: Buffer | string) => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { status, ok: status >= 200 && status < 300, headers, body: b, url: 'https://x.test/', truncated: false, text: () => b.toString('utf8') };
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';
  mockSafeFetch.mockImplementation((...a: unknown[]) => realSafeFetch(...a)); // default: real guard
});

describe('POST /cabinet/url-lookup', () => {
  it.each([
    'http://127.0.0.1/',
    'http://localhost/admin',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://2130706433/',
    'http://10.0.0.5:6379/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ])('refuses %s with 400 and never calls the model', async (u) => {
    const res = await request(app).post('/cabinet/url-lookup').send({ url: u });
    expect(res.status).toBe(400);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('keeps rejecting non-http(s) schemes', async () => {
    const res = await request(app).post('/cabinet/url-lookup').send({ url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
  });

  it('passes the SSRF-guarded options (size and time caps) to safeFetch', async () => {
    mockSafeFetch.mockResolvedValue(resp(403, {}, 'no'));
    await request(app).post('/cabinet/url-lookup').send({ url: 'https://shop.example.com/p/1' });
    expect(mockSafeFetch).toHaveBeenCalledWith('https://shop.example.com/p/1', expect.objectContaining({ timeoutMs: 8000, maxBytes: 1_500_000 }));
  });

  it('403 from the site → 422 with the status', async () => {
    mockSafeFetch.mockResolvedValue(resp(403, {}, 'no'));
    const res = await request(app).post('/cabinet/url-lookup').send({ url: 'https://shop.example.com/p/1' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Could not fetch URL (403)');
  });

  it('non-HTML response → 422 and the model is not called', async () => {
    mockSafeFetch.mockResolvedValue(resp(200, { 'content-type': 'application/json' }, '{"a":1}'));
    const res = await request(app).post('/cabinet/url-lookup').send({ url: 'https://shop.example.com/data' });
    expect(res.status).toBe(422);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('timeout / network error → 422 Could not reach URL', async () => {
    mockSafeFetch.mockRejectedValue(new SafeFetchError('Timed out'));
    const res = await request(app).post('/cabinet/url-lookup').send({ url: 'https://shop.example.com/p/1' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Could not reach URL');
  });

  it('a normal product page still works end to end', async () => {
    mockSafeFetch.mockResolvedValue(
      resp(200, { 'content-type': 'text/html; charset=utf-8' }, '<html><head><title>Zinc 50 mg</title><meta property="og:title" content="Zinc 50 mg"></head><body>Zinc</body></html>'),
    );
    mockGenerateContent.mockResolvedValue({
      response: { text: () => JSON.stringify({ name: 'Zinc 50 mg', brand: 'NOW', type: 'vitamin', dosage: '1 capsule' }), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    });
    const res = await request(app).post('/cabinet/url-lookup').send({ url: 'https://shop.example.com/p/1' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Zinc 50 mg');
  });
});

describe('GET /img/image-proxy (unauthenticated)', () => {
  it.each([
    'https://127.0.0.1/x.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/x.png',
    'https://[::1]/x.png',
    'https://internal.corp/x.png',
    'https://example.com:8443/x.png',
  ])('refuses %s with 400', async (u) => {
    const res = await request(app).get('/img/image-proxy').query({ url: u });
    expect(res.status).toBe(400);
  });

  it('refuses plain http and missing url', async () => {
    expect((await request(app).get('/img/image-proxy').query({ url: 'http://example.com/a.png' })).status).toBe(400);
    expect((await request(app).get('/img/image-proxy')).status).toBe(400);
  });

  it('serves a real PNG with hardening headers', async () => {
    mockSafeFetch.mockResolvedValue(resp(200, { 'content-type': 'image/png' }, PNG));
    const res = await request(app).get('/img/image-proxy').query({ url: 'https://cdn.example.com/a.png' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('refuses HTML served as an image (415)', async () => {
    mockSafeFetch.mockResolvedValue(resp(200, { 'content-type': 'text/html' }, '<script>alert(1)</script>'));
    expect((await request(app).get('/img/image-proxy').query({ url: 'https://evil.example.com/x' })).status).toBe(415);
  });

  it('refuses SVG (415)', async () => {
    mockSafeFetch.mockResolvedValue(resp(200, { 'content-type': 'image/svg+xml' }, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
    expect((await request(app).get('/img/image-proxy').query({ url: 'https://evil.example.com/x.svg' })).status).toBe(415);
  });

  it('refuses a body that is not really an image even if the header says image/png (415)', async () => {
    mockSafeFetch.mockResolvedValue(resp(200, { 'content-type': 'image/png' }, '<html>nope</html>'));
    expect((await request(app).get('/img/image-proxy').query({ url: 'https://evil.example.com/x.png' })).status).toBe(415);
  });

  it('upstream errors map to 404 / 502, oversize to 502', async () => {
    mockSafeFetch.mockResolvedValueOnce(resp(404, {}, ''));
    expect((await request(app).get('/img/image-proxy').query({ url: 'https://cdn.example.com/a.png' })).status).toBe(404);
    mockSafeFetch.mockResolvedValueOnce(resp(500, {}, ''));
    expect((await request(app).get('/img/image-proxy').query({ url: 'https://cdn.example.com/a.png' })).status).toBe(502);
    mockSafeFetch.mockRejectedValueOnce(new SafeFetchError('Response too large'));
    expect((await request(app).get('/img/image-proxy').query({ url: 'https://cdn.example.com/a.png' })).status).toBe(502);
  });

  it('passes a 5 MB hard cap that errors (not truncates)', async () => {
    mockSafeFetch.mockResolvedValue(resp(200, { 'content-type': 'image/png' }, PNG));
    await request(app).get('/img/image-proxy').query({ url: 'https://cdn.example.com/a.png' });
    expect(mockSafeFetch).toHaveBeenCalledWith('https://cdn.example.com/a.png', expect.objectContaining({ maxBytes: 5 * 1024 * 1024, onLimit: 'error' }));
  });
});
