export const MODELS = {
  CHAT: 'claude-sonnet-4-6',                   // complex health advice — requires reasoning + nuance
  EXTRACTION: 'claude-haiku-4-5-20251001',      // data extraction — structured output, no reasoning needed
  INTERACTION: 'claude-haiku-4-5-20251001',     // supplement interaction checking — structured checklist task
} as const;
