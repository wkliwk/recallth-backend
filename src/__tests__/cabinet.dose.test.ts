/**
 * Route tests: POST /cabinet/scan and /cabinet/ai-lookup return strength / unitForm /
 * servingUnits / bottleCount separately. Gemini is mocked.
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

import cabinetRouter from '../routes/cabinet';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { userId: string }).userId = '507f1f77bcf86cd799439011';
  next();
});
app.use('/cabinet', cabinetRouter);

const gemini = (obj: unknown) => ({
  response: {
    text: () => JSON.stringify(obj),
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
    candidates: [],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';
});

describe('POST /cabinet/scan', () => {
  it('front-of-bottle label: strength + bottleCount, servingUnits null, dosage falls back to strength', async () => {
    mockGenerateContent.mockResolvedValue(gemini({
      name: 'Curcuma', brand: 'webber naturals', type: 'supplement',
      strength: '500 mg', unitForm: 'capsules', servingUnits: null, bottleCount: 120, ingredients: 'Curcuma',
    }));
    const res = await request(app).post('/cabinet/scan').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ strength: '500 mg', unitForm: 'capsule', servingUnits: null, bottleCount: 120, dosage: '500 mg' });
    expect('servingSize' in res.body.data).toBe(false);
  });

  it('directions label: servingUnits set, dosage composed', async () => {
    mockGenerateContent.mockResolvedValue(gemini({
      name: 'Curcuma', brand: 'webber naturals', type: 'supplement',
      strength: '500 mg', unitForm: 'capsule', servingUnits: 2, bottleCount: 120,
    }));
    const res = await request(app).post('/cabinet/scan').send({ imageBase64: 'AAAA' });
    expect(res.body.data.servingUnits).toBe(2);
    expect(res.body.data.dosage).toBe('2 capsules (500 mg each)');
  });

  it('never trusts a bogus servingUnits (0 / text / bottle-sized)', async () => {
    for (const bad of [0, 'many', 120]) {
      mockGenerateContent.mockResolvedValue(gemini({ name: 'X', type: 'supplement', strength: '10 mg', unitForm: 'tablet', servingUnits: bad, bottleCount: 60 }));
      const res = await request(app).post('/cabinet/scan').send({ imageBase64: 'AAAA' });
      expect(res.body.data.servingUnits).toBeNull();
    }
  });

  it('prompt tells the model not to assume a serving count', async () => {
    mockGenerateContent.mockResolvedValue(gemini({ name: 'X', type: 'supplement' }));
    await request(app).post('/cabinet/scan').send({ imageBase64: 'AAAA' });
    const prompt = mockGenerateContent.mock.calls[0][0][0] as string;
    expect(prompt).toMatch(/Never assume 1/);
    expect(prompt).toMatch(/bottleCount/);
  });
});

describe('POST /cabinet/ai-lookup', () => {
  it('returns normalised servingUnits + directions per result', async () => {
    mockGenerateContent.mockResolvedValue(gemini([
      { name: 'Curcuma 500', brand: 'Webber', type: 'supplement', dosage: '2 capsules', strength: '500 mg', unitForm: 'Capsules', servingUnits: '2', directions: ' Adults: take 2 capsules daily ' },
      { name: 'Other', type: 'supplement', servingUnits: 0, directions: '' },
    ]));
    const res = await request(app).post('/cabinet/ai-lookup').send({ query: 'webber curcuma 500' });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ unitForm: 'capsule', servingUnits: 2, directions: 'Adults: take 2 capsules daily', strength: '500 mg' });
    expect(res.body.data[1]).toMatchObject({ servingUnits: null, directions: null });
  });
});
