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

const mockPickProductImage = jest.fn();
jest.mock('../utils/pageImage', () => ({ pickProductImage: (...a: unknown[]) => mockPickProductImage(...a) }));
const mockBuildReferences = jest.fn();
jest.mock('../utils/references', () => ({ ...jest.requireActual('../utils/references'), buildReferences: (...a: unknown[]) => mockBuildReferences(...a) }));

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
  ingredients: 'Per serving: Sodium hyaluronate 0.1%. Other ingredients: Boric acid, Sodium chloride.', description: 'Moisturising eye drops for dry eyes.',
  sourceUrl: 'https://example.com/hyalein', codeRead: null, match: 'exact',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';
  mockBuildReferences.mockResolvedValue([]);
  mockPickProductImage.mockResolvedValue(null);
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
    expect(res.body.data.ingredients).toContain('Sodium hyaluronate 0.1%');
    expect(res.body.data.description).toBe('Moisturising eye drops for dry eyes.');
  });

  it('sends the photo with its mime type and the hint, and asks for per-dose counts', async () => {
    mockGenerateContent.mockResolvedValue(gemini(good));
    await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA', mimeType: 'image/heic', hint: { name: 'Curcuma', brand: 'webber naturals', strength: '500 mg', junk: 'x' } });
    const [prompt, image] = mockGenerateContent.mock.calls[0][0] as [string, { inlineData: { mimeType: string; data: string } }];
    expect(image.inlineData).toEqual({ mimeType: 'image/heic', data: 'AAAA' });
    expect(prompt).toContain('name: Curcuma; brand: webber naturals; strength: 500 mg');
    expect(prompt).toMatch(/per DOSE, never the daily total/);
    expect(prompt).toMatch(/Never assume 1/);
    expect(prompt).toMatch(/FULL ingredient list/);
    expect(prompt).toMatch(/do not write it from memory/);
    expect(prompt).toMatch(/manufacturer's own wording/);
    expect(prompt).not.toContain('junk');
  });

  it('unsure → not usable, directions dropped', async () => {
    mockGenerateContent.mockResolvedValue(gemini({ ...good, match: 'unsure' }));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ usable: false, servingUnits: null, directions: null, ingredients: null, description: null });
  });

  it('a daily-range answer stays null', async () => {
    mockGenerateContent.mockResolvedValue(gemini({ ...good, servingUnits: '1-3', timesPerDay: null }));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.body.data.servingUnits).toBeNull();
  });

  it('unparseable model output on every attempt → 422 after three tries', async () => {
    mockGenerateContent.mockResolvedValue(gemini('Sorry, I could not find it.'));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(422);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
  });

  it('retries a non-JSON answer and succeeds on the next attempt', async () => {
    mockGenerateContent.mockResolvedValueOnce(gemini('I cannot read this.')).mockResolvedValueOnce(gemini(good));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data.usable).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('blocked by RECITATION on all three attempts → 500', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Candidate was blocked due to RECITATION'));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(500);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
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

  it('returns reference links (official first) built from the cited page and the grounding chunks', async () => {
    const refs = [
      { url: 'https://www.santen.com/p', title: 'Hyalein', kind: 'official' },
      { url: 'https://www.costco.ca/p', title: 'Costco', kind: 'retailer' },
    ];
    mockBuildReferences.mockResolvedValue(refs);
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify(good),
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/r/1', title: 'santen.com' } }, { web: { uri: 'https://vertexaisearch.cloud.google.com/r/2', title: 'costco.ca' } }] } }],
      },
    });
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.body.data.references).toEqual(refs);
    expect(mockBuildReferences).toHaveBeenCalledWith({
      sourceUrl: 'https://example.com/hyalein',
      chunks: [{ uri: 'https://vertexaisearch.cloud.google.com/r/1', title: 'santen.com' }, { uri: 'https://vertexaisearch.cloud.google.com/r/2', title: 'costco.ca' }],
      brand: 'Santen',
    });
    expect('imageUrl' in res.body.data).toBe(false); // images come from /product-image now
  });

  it('falls back to the cited page when no reference could be resolved', async () => {
    mockGenerateContent.mockResolvedValue(gemini(good));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.body.data.references).toEqual([{ url: 'https://example.com/hyalein', title: 'Source', kind: 'other' }]);
  });

  it('no references (and no lookup) when the match is not usable', async () => {
    mockGenerateContent.mockResolvedValue(gemini({ ...good, match: 'unsure' }));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(mockBuildReferences).not.toHaveBeenCalled();
    expect(res.body.data.references).toEqual([]);
  });

  it('the prompt asks for official / reliable sources', async () => {
    mockGenerateContent.mockResolvedValue(gemini(good));
    await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    const prompt = mockGenerateContent.mock.calls[0][0][0] as string;
    expect(prompt).toMatch(/prefer the manufacturer's official website/);
    expect(prompt).toMatch(/Avoid blogs, affiliate or review sites/);
  });

  it('retries when Gemini blocks the candidate for RECITATION, then succeeds', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new Error('[GoogleGenerativeAI Error]: Candidate was blocked due to RECITATION'))
      .mockResolvedValueOnce(gemini(good));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data.usable).toBe(true);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('the last attempt after repeated RECITATION blocks drops ingredients/description so the product still comes back', async () => {
    const blocked = new Error('Candidate was blocked due to RECITATION');
    mockGenerateContent
      .mockRejectedValueOnce(blocked)
      .mockRejectedValueOnce(blocked)
      .mockResolvedValueOnce(gemini({ ...good, ingredients: null, description: null }));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ usable: true, ingredients: null, description: null, servingUnits: 1 });
    const third = mockGenerateContent.mock.calls[2][0][0] as string;
    expect(third).not.toMatch(/"ingredients":/);
    expect(third).not.toMatch(/"description":/);
    expect(third).toMatch(/"directions":/);
    const first = mockGenerateContent.mock.calls[0][0][0] as string;
    expect(first).toMatch(/"ingredients":/);
  });

  it('other model errors are not retried', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 quota exceeded'));
    const res = await request(app).post('/cabinet/identify').send({ imageBase64: 'AAAA' });
    expect(res.status).toBe(500);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});
