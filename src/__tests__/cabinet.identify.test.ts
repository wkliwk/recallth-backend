/** POST /cabinet/identify with a mocked Gemini. */
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
  response: { text: () => (typeof obj === 'string' ? obj : JSON.stringify(obj)), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } },
});

const good = {
  nameOriginal: 'ヒアレインSミニ点眼', nameEnglish: 'Hyalein S Mini Eye Drops', brand: 'Santen', strength: '0.1% Sodium Hyaluronate',
  unitForm: 'drop', packSize: 10, servingUnits: 1, timesPerDay: 5, directions: 'Instill 1 drop, 5 to 6 times a day.',
  sourceUrl: 'https://example.com/hyalein', codeRead: null, match: 'exact',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';
});

describe('POST /cabinet/identify', () => {
  it('requires an image', async () => {
    const res = await request(app).post('/cabinet/identify').send({});
    expect(res.status).toBe(400);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('returns a normalised, usable match', async () => {
    mockGenerateContent.mockResolvedValue(gemini(good));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA', mimeType: 'image/heic' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ nameEnglish: 'Hyalein S Mini Eye Drops', unitForm: 'drop', servingUnits: 1, timesPerDay: 5, match: 'exact', usable: true });
  });

  it('sends the photo with its mime type and the hint, and asks for per-dose counts', async () => {
    mockGenerateContent.mockResolvedValue(gemini(good));
    await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA', mimeType: 'image/heic', hint: { name: 'Curcuma', brand: 'webber naturals', strength: '500 mg', junk: 'x' } });
    const [prompt, image] = mockGenerateContent.mock.calls[0][0] as [string, { inlineData: { mimeType: string; data: string } }];
    expect(image.inlineData).toEqual({ mimeType: 'image/heic', data: 'AAAA' });
    expect(prompt).toContain('name: Curcuma; brand: webber naturals; strength: 500 mg');
    expect(prompt).toMatch(/per DOSE, never the daily total/);
    expect(prompt).toMatch(/Never assume 1/);
    expect(prompt).not.toContain('junk');
  });

  it('unsure → not usable, directions dropped', async () => {
    mockGenerateContent.mockResolvedValue(gemini({ ...good, match: 'unsure' }));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ usable: false, servingUnits: null, directions: null });
  });

  it('a daily-range answer stays null', async () => {
    mockGenerateContent.mockResolvedValue(gemini({ ...good, servingUnits: '1-3', timesPerDay: null }));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.body.data.servingUnits).toBeNull();
  });

  it('unparseable model output → 422', async () => {
    mockGenerateContent.mockResolvedValue(gemini('Sorry, I could not find it.'));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(422);
  });

  it('model failure → 500 without leaking details', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 quota exceeded secret-detail'));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret-detail');
  });

  it('strips a markdown fence around the JSON', async () => {
    mockGenerateContent.mockResolvedValue(gemini('```json\n' + JSON.stringify(good) + '\n```'));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data.usable).toBe(true);
  });
});
