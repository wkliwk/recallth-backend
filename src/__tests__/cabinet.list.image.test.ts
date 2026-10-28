/** GET /cabinet: data:image URLs (uploaded photos / scan thumbnails) must come back unchanged. */
import express from 'express';
import request from 'supertest';
import { Types } from 'mongoose';

jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn() }));
const mockLean = jest.fn();
jest.mock('../models/CabinetItem', () => ({
  CabinetItem: { find: () => ({ sort: () => ({ lean: () => mockLean() }) }) },
}));
jest.mock('../models/AiCache', () => ({
  getCached: jest.fn().mockResolvedValue(null),
  setCached: jest.fn(),
  deleteCached: jest.fn().mockResolvedValue(undefined),
}));

import cabinetRouter from '../routes/cabinet';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { userId: string }).userId = new Types.ObjectId().toString();
  next();
});
app.use('/cabinet', cabinetRouter);

describe('GET /cabinet imageUrl handling', () => {
  it('keeps data: URLs, re-wraps https and old proxy URLs, leaves missing alone', async () => {
    const data = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    mockLean.mockResolvedValue([
      { _id: '1', name: 'A', imageUrl: data },
      { _id: '2', name: 'B', imageUrl: 'https://cdn.test/b.png' },
      { _id: '3', name: 'C', imageUrl: `https://old.railway.app/img/image-proxy?url=${encodeURIComponent('https://cdn.test/c.png')}` },
      { _id: '4', name: 'D' },
    ]);
    const res = await request(app).get('/cabinet').set('Host', 'api.test').set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.map((i: { name: string; imageUrl?: string }) => [i.name, i.imageUrl]));
    expect(byName.A).toBe(data);
    expect(byName.B).toBe(`https://api.test/img/image-proxy?url=${encodeURIComponent('https://cdn.test/b.png')}`);
    expect(byName.C).toBe(`https://api.test/img/image-proxy?url=${encodeURIComponent('https://cdn.test/c.png')}`);
    expect(byName.D).toBeUndefined();
  });
});
