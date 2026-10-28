/**
 * Route tests for the purchase fields on POST /cabinet and PUT /cabinet/:id.
 * The CabinetItem model and AI helpers are mocked — no database or network.
 */
import express from 'express';
import request from 'supertest';

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: jest.fn().mockResolvedValue({ response: { text: () => '{}', usageMetadata: {} } }) }),
  })),
}));

const mockCreate = jest.fn();
const mockFindById = jest.fn();
const mockFindByIdAndUpdate = jest.fn();

jest.mock('../models/CabinetItem', () => ({
  CabinetItem: {
    create: (...a: unknown[]) => mockCreate(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
    findByIdAndUpdate: (...a: unknown[]) => mockFindByIdAndUpdate(...a),
  },
}));
jest.mock('../models/AiCache', () => ({
  getCached: jest.fn().mockResolvedValue(null),
  setCached: jest.fn(),
  deleteCached: jest.fn().mockResolvedValue(undefined),
}));

import { Types } from 'mongoose';
import cabinetRouter from '../routes/cabinet';

const USER_ID = new Types.ObjectId().toString();
const ITEM_ID = new Types.ObjectId().toString();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { userId: string }).userId = USER_ID;
  next();
});
app.use('/cabinet', cabinetRouter);

const baseBody = { name: 'Zinc', type: 'vitamin', dosage: '25mg' };

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
    _id: new Types.ObjectId(ITEM_ID),
    name: doc.name,
    type: doc.type,
    toObject: () => ({ ...doc, _id: ITEM_ID }),
  }));
});

describe('POST /cabinet purchase fields', () => {
  it('persists purchasePrice, purchaseDate and currency', async () => {
    const res = await request(app)
      .post('/cabinet')
      .send({ ...baseBody, purchasePrice: 128.5, purchaseDate: '2026-10-20', currency: 'CAD' });
    expect(res.status).toBe(201);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.purchasePrice).toBe(128.5);
    expect(doc.currency).toBe('CAD');
    expect((doc.purchaseDate as Date).toISOString().startsWith('2026-10-20')).toBe(true);
    expect(res.body.data.purchasePrice).toBe(128.5);
  });

  it('works without the new fields and leaves them out', async () => {
    const res = await request(app).post('/cabinet').send(baseBody);
    expect(res.status).toBe(201);
    const doc = mockCreate.mock.calls[0][0];
    expect('purchasePrice' in doc).toBe(false);
    expect('purchaseDate' in doc).toBe(false);
    expect(doc.currency).toBe('HKD');
  });

  it('rejects a negative price and an invalid date with 400', async () => {
    const neg = await request(app).post('/cabinet').send({ ...baseBody, purchasePrice: -1 });
    expect(neg.status).toBe(400);
    const bad = await request(app).post('/cabinet').send({ ...baseBody, purchaseDate: 'not a date' });
    expect(bad.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('POST /cabinet description / ingredients / imageUrl', () => {
  it('persists them when provided (trimmed)', async () => {
    const res = await request(app)
      .post('/cabinet')
      .send({ ...baseBody, ingredients: ' Curcumin 500 mg ', description: 'Joint support', imageUrl: 'https://x.test/a.png' });
    expect(res.status).toBe(201);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.ingredients).toBe('Curcumin 500 mg');
    expect(doc.description).toBe('Joint support');
    expect(doc.imageUrl).toBe('https://x.test/a.png');
    expect(res.body.data.ingredients).toBe('Curcumin 500 mg');
  });

  it('leaves them out when absent or blank', async () => {
    const res = await request(app).post('/cabinet').send({ ...baseBody, ingredients: '  ', description: '' });
    expect(res.status).toBe(201);
    const doc = mockCreate.mock.calls[0][0];
    for (const k of ['ingredients', 'description', 'imageUrl']) expect(k in doc).toBe(false);
  });

  it('rejects non-string values and bad image URLs with 400', async () => {
    const a = await request(app).post('/cabinet').send({ ...baseBody, ingredients: 123 });
    const b = await request(app).post('/cabinet').send({ ...baseBody, imageUrl: 'javascript:alert(1)' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('still persists the purchase fields alongside', async () => {
    await request(app).post('/cabinet').send({ ...baseBody, ingredients: 'x', purchasePrice: 5, currency: 'CAD' });
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.ingredients).toBe('x');
    expect(doc.purchasePrice).toBe(5);
    expect(doc.currency).toBe('CAD');
  });
});

describe('PUT /cabinet/:id purchase fields', () => {
  beforeEach(() => {
    mockFindById.mockResolvedValue({ userId: { toString: () => USER_ID }, name: 'Zinc', type: 'vitamin' });
    mockFindByIdAndUpdate.mockImplementation(async (_id: string, update: { $set: Record<string, unknown> }) => ({
      name: 'Zinc',
      type: 'vitamin',
      toObject: () => ({ ...update.$set }),
    }));
  });

  it('updates price and date', async () => {
    const res = await request(app).put(`/cabinet/${ITEM_ID}`).send({ purchasePrice: 42, purchaseDate: '2026-09-01' });
    expect(res.status).toBe(200);
    const set = mockFindByIdAndUpdate.mock.calls[0][1].$set;
    expect(set.purchasePrice).toBe(42);
    expect((set.purchaseDate as Date).toISOString().startsWith('2026-09-01')).toBe(true);
  });

  it('clears both with null', async () => {
    const res = await request(app).put(`/cabinet/${ITEM_ID}`).send({ purchasePrice: null, purchaseDate: null });
    expect(res.status).toBe(200);
    const set = mockFindByIdAndUpdate.mock.calls[0][1].$set;
    expect(set.purchasePrice).toBeNull();
    expect(set.purchaseDate).toBeNull();
  });

  it('rejects invalid values with 400 and does not update', async () => {
    const a = await request(app).put(`/cabinet/${ITEM_ID}`).send({ purchasePrice: 'abc' });
    const b = await request(app).put(`/cabinet/${ITEM_ID}`).send({ purchaseDate: 'nope' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(mockFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('does not touch the monthly price field', async () => {
    await request(app).put(`/cabinet/${ITEM_ID}`).send({ purchasePrice: 10 });
    const set = mockFindByIdAndUpdate.mock.calls[0][1].$set;
    expect('price' in set).toBe(false);
  });
});
