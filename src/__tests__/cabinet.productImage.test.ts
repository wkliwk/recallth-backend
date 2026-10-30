/** POST /cabinet/product-image with the page fetching / vision step mocked. */
import express from 'express';
import request from 'supertest';

const mockPick = jest.fn();
jest.mock('../utils/pageImage', () => ({ pickProductImage: (...a: unknown[]) => mockPick(...a) }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn() }));
jest.mock('../models/CabinetItem', () => ({ CabinetItem: {} }));
jest.mock('../models/AiCache', () => ({ getCached: jest.fn().mockResolvedValue(null), setCached: jest.fn(), deleteCached: jest.fn().mockResolvedValue(undefined) }));

import cabinetRouter from '../routes/cabinet';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { userId: string }).userId = '507f1f77bcf86cd799439011';
  next();
});
app.use('/cabinet', cabinetRouter);

const body = { imageBase64: 'AAAA', mimeType: 'image/heic', pageUrls: ['https://www.brand.com/p/1', 'https://shop.example.com/p/1'], name: 'Turmeric', brand: 'Brand' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPick.mockResolvedValue(null);
});

describe('POST /cabinet/product-image', () => {
  it('returns the chosen picture wrapped through this host\'s image proxy', async () => {
    mockPick.mockResolvedValue('https://cdn.brand.com/front.jpg');
    const res = await request(app).post('/cabinet/product-image').set('Host', 'api.test').set('X-Forwarded-Proto', 'https').send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.imageUrl).toBe(`https://api.test/img/image-proxy?url=${encodeURIComponent('https://cdn.brand.com/front.jpg')}`);
    const [opts] = mockPick.mock.calls[0];
    expect(opts).toMatchObject({ pageUrls: body.pageUrls, photo: { base64: 'AAAA', mime: 'image/heic' }, name: 'Turmeric', brand: 'Brand' });
  });

  it('imageUrl is null when nothing qualifies, and also when the search throws (never fails the flow)', async () => {
    expect((await request(app).post('/cabinet/product-image').send(body)).body.data.imageUrl).toBeNull();
    mockPick.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/cabinet/product-image').send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.imageUrl).toBeNull();
  });

  it('validates the input', async () => {
    const bad = [
      {},
      { ...body, imageBase64: 123 },
      { pageUrls: body.pageUrls }, // neither photo nor name
      { imageBase64: 'AAAA', pageUrls: [] }, // no pages and no name
      { ...body, pageUrls: 'https://x.test' },
      { ...body, pageUrls: Array.from({ length: 5 }, (_, i) => `https://x.test/${i}`) },
      { ...body, pageUrls: ['javascript:alert(1)'] },
      { ...body, pageUrls: ['file:///etc/passwd'] },
      { ...body, pageUrls: [123] },
      { pageUrls: [] },
      { ...body, excludeUrls: 'x' },
      { ...body, excludeUrls: ['javascript:alert(1)'] },
      { ...body, excludeUrls: Array.from({ length: 11 }, (_, i) => `https://x.test/${i}`) },
    ];
    for (const b of bad) {
      const res = await request(app).post('/cabinet/product-image').send(b);
      expect(res.status).toBe(400);
    }
    expect(mockPick).not.toHaveBeenCalled();
  });

  it('retry: passes excludeUrls through; photo and pageUrls are optional when a name is given', async () => {
    mockPick.mockResolvedValue(null);
    await request(app).post('/cabinet/product-image').send({ ...body, excludeUrls: ['https://cdn.brand.com/front.jpg'] });
    expect(mockPick.mock.calls[0][0]).toMatchObject({ excludeUrls: ['https://cdn.brand.com/front.jpg'] });
    const res = await request(app).post('/cabinet/product-image').send({ name: 'Turmeric', brand: 'Brand' });
    expect(res.status).toBe(200);
    expect(mockPick.mock.calls[1][0]).toMatchObject({ pageUrls: [], photo: null, name: 'Turmeric' });
    expect((await request(app).post('/cabinet/product-image').send({ imageBase64: 'AAAA' })).status).toBe(400); // photo but no pages and no name
  });
});
