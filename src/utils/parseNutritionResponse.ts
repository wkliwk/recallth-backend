export interface ParsedNutritionResponse {
  foods: unknown[];
  suggestions: unknown[];
}

/**
 * Parse raw AI text response into structured foods + suggestions arrays.
 * Handles both legacy array format and current { foods, suggestions } format.
 */
export function parseAiNutritionResponse(rawText: string): ParsedNutritionResponse | null {
  const jsonMatch = rawText.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]) as unknown;

  if (Array.isArray(parsed)) {
    // Legacy array response — treat all as confirmed foods
    return { foods: parsed, suggestions: [] };
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    return {
      foods: Array.isArray(obj.foods) ? obj.foods : [],
      suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : [],
    };
  }

  return null;
}
