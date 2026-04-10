/**
 * Language detection utility for multilingual AI responses.
 * Supports English, Cantonese (zh-HK), and Traditional Chinese (zh-TW).
 */

export type DetectedLanguage = 'en' | 'zh-HK' | 'zh-TW';

// Cantonese-specific particles and characters that don't appear in Mandarin/written Chinese
const CANTONESE_MARKERS = ['係', '唔', '咁', '嘅', '喺', '冇', '佢', '而家', '食緊', '做緊', '去緊', '啩', '囉', '㗎', '囉', '喇', '咋', '囉'];

// Regex to detect any Chinese character (CJK Unified Ideographs)
const CHINESE_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Detect the language of the given text.
 * Returns 'zh-HK' for Cantonese, 'zh-TW' for Traditional Chinese, 'en' for English.
 */
export function detectLanguage(text: string): DetectedLanguage {
  // Check for Cantonese-specific markers first
  for (const marker of CANTONESE_MARKERS) {
    if (text.includes(marker)) {
      return 'zh-HK';
    }
  }

  // Check if the text is primarily Chinese characters
  const chineseCharCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const totalAlphanumeric = (text.match(/[a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;

  if (totalAlphanumeric > 0 && chineseCharCount / totalAlphanumeric > 0.4) {
    return 'zh-TW';
  }

  // Check if there are any Chinese characters at all (even a minority)
  if (CHINESE_CHAR_REGEX.test(text) && chineseCharCount >= 3) {
    return 'zh-TW';
  }

  return 'en';
}
