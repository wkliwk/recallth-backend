// Gemini pricing per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash':      { input: 0.15,   output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.075,  output: 0.30 },
  'gemini-1.5-flash':      { input: 0.075,  output: 0.30 },
  'gemini-1.5-pro':        { input: 1.25,   output: 5.00 },
};

export interface AiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export function buildAiUsage(
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined
): AiUsage {
  const inp = inputTokens ?? 0;
  const out = outputTokens ?? 0;
  const pricing = PRICING[model] ?? { input: 0.15, output: 0.60 };
  const cost = (inp / 1_000_000) * pricing.input + (out / 1_000_000) * pricing.output;
  return {
    model,
    inputTokens: inp,
    outputTokens: out,
    totalTokens: inp + out,
    estimatedCostUSD: parseFloat(cost.toFixed(6)),
  };
}
