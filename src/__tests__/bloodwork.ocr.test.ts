/**
 * Unit tests for POST /bloodwork/ocr
 *
 * Mocks:
 * - @google/generative-ai — controls AI responses without real API calls
 * - jsonwebtoken — bypasses real JWT verification so auth passes
 */

import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';

// ── Mock Gemini AI before importing the router ────────────────────────────────

const mockGenerateContent = jest.fn();

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

// ── Mock JWT so authenticate() always passes ──────────────────────────────────

jest.mock('jsonwebtoken', () => ({
  ...jest.requireActual<typeof import('jsonwebtoken')>('jsonwebtoken'),
  verify: jest.fn().mockReturnValue({ userId: 'test-user-id' }),
}));

// ── Build a minimal Express app with just the bloodwork router ────────────────

import { bloodworkRouter } from '../routes/bloodwork';

const app = express();
app.use(express.json());
app.use('/bloodwork', bloodworkRouter);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal 1×1 white JPEG buffer for testing */
function makeTestImageBuffer(): Buffer {
  // Minimal valid JPEG (SOI + EOI)
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49,
    0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
}

function buildGeminiResponse(text: string) {
  return {
    response: {
      text: () => text,
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /bloodwork/ocr', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Provide required env vars
    process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-key';
    process.env.JWT_SECRET = 'test-secret';
  });

  // ── 1. Success case ─────────────────────────────────────────────────────────
  it('returns extracted markers on success', async () => {
    const markers = [
      { name: 'Hemoglobin', value: 14.2, unit: 'g/dL' },
      { name: 'Fasting Glucose', value: 5.4, unit: 'mmol/L' },
      { name: 'TSH', value: 2.1, unit: 'mIU/L' },
    ];

    mockGenerateContent.mockResolvedValueOnce(
      buildGeminiResponse(JSON.stringify(markers))
    );

    const res = await request(app)
      .post('/bloodwork/ocr')
      .set('Authorization', 'Bearer valid-token')
      .attach('image', makeTestImageBuffer(), { filename: 'lab-report.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.markers).toHaveLength(3);
    expect(res.body.markers[0]).toEqual({ name: 'Hemoglobin', value: 14.2, unit: 'g/dL' });
    expect(res.body.error).toBeUndefined();
  });

  // ── 2. No image uploaded ────────────────────────────────────────────────────
  it('returns 400 with empty markers when no image field is sent', async () => {
    const res = await request(app)
      .post('/bloodwork/ocr')
      .set('Authorization', 'Bearer valid-token')
      .set('Content-Type', 'multipart/form-data');

    expect(res.status).toBe(400);
    expect(res.body.markers).toEqual([]);
    expect(typeof res.body.error).toBe('string');
    // AI should NOT have been called
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // ── 3. AI error — graceful fallback, never 500 ─────────────────────────────
  it('returns empty markers with error message when AI throws, never 500', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('Gemini quota exceeded'));

    const res = await request(app)
      .post('/bloodwork/ocr')
      .set('Authorization', 'Bearer valid-token')
      .attach('image', makeTestImageBuffer(), { filename: 'lab-report.jpg', contentType: 'image/jpeg' });

    // Must not be 500 — requirement: AI errors surface as graceful fallback
    expect(res.status).toBe(200);
    expect(res.body.markers).toEqual([]);
    expect(res.body.error).toBe('Could not extract values');
  });

  // ── 4. Auth required — no token returns 401 ────────────────────────────────
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .post('/bloodwork/ocr')
      .attach('image', makeTestImageBuffer(), { filename: 'lab-report.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(401);
    // AI should NOT have been called
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
