import { GoogleGenerativeAI } from '@google/generative-ai';
import { ICabinetItem } from '../models/CabinetItem';
import { MODELS } from '../config/models';
import { getCached, setCached, deleteCached } from '../models/AiCache';

export interface Interaction {
  item1: string;
  item2: string;
  severity: 'minor' | 'moderate' | 'major';
  description: string;
  recommendation: string;
  citation: string;
}

interface GeminiInteractionResponse {
  interactions: Array<{
    item1: string;
    item2: string;
    severity: string;
    description: string;
    recommendation: string;
    citation: string;
  }>;
}

const VALID_SEVERITIES = new Set<string>(['minor', 'moderate', 'major']);

const CACHE_TYPE = 'interactions';

function getCacheKey(itemNames: string[]): string {
  return itemNames.sort().join('|').toLowerCase();
}

/**
 * Invalidate cache entries that contain the given item name.
 * Call this whenever a cabinet item is added, updated, or removed.
 */
export async function invalidateInteractionCache(itemName: string): Promise<void> {
  await deleteCached(CACHE_TYPE, itemName.toLowerCase());
}

function buildItemList(items: ICabinetItem[]): string {
  return items
    .map((item, idx) => {
      const parts = [`${idx + 1}. ${item.name} (${item.type})`];
      if (item.dosage) parts.push(`dosage: ${item.dosage}`);
      if (item.frequency) parts.push(`frequency: ${item.frequency}`);
      if (item.timing) parts.push(`timing: ${item.timing}`);
      return parts.join(', ');
    })
    .join('\n');
}

function buildPrompt(items: ICabinetItem[]): string {
  const itemList = buildItemList(items);
  return `You are a pharmacology expert checking for interactions between supplements and medications.

Check ALL pairwise interactions between these items:
${itemList}

For each interaction found, return JSON:
{
  "interactions": [
    {
      "item1": "Supplement A",
      "item2": "Supplement B",
      "severity": "minor|moderate|major",
      "description": "Plain language explanation of the risk",
      "recommendation": "What the user should do",
      "citation": "Source URL (NIH, examine.com, pubmed, drugs.com)"
    }
  ]
}

Rules:
- Only report interactions with actual evidence — do not guess
- If no interactions found, return { "interactions": [] }
- Severity levels: minor (awareness only), moderate (timing adjustment needed), major (avoid combination)
- Always provide a citation URL
- Return ONLY valid JSON, no other text`;
}

function parseGeminiResponse(content: string): Interaction[] {
  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: GeminiInteractionResponse;
  try {
    parsed = JSON.parse(cleaned) as GeminiInteractionResponse;
  } catch {
    throw new Error(`Gemini returned non-JSON response: ${content.slice(0, 200)}`);
  }

  if (!parsed.interactions || !Array.isArray(parsed.interactions)) {
    throw new Error('Gemini response missing interactions array');
  }

  return parsed.interactions
    .filter((raw) => {
      // Drop any entry missing required fields or with invalid severity
      return (
        typeof raw.item1 === 'string' &&
        raw.item1.trim() !== '' &&
        typeof raw.item2 === 'string' &&
        raw.item2.trim() !== '' &&
        VALID_SEVERITIES.has(raw.severity) &&
        typeof raw.description === 'string' &&
        typeof raw.recommendation === 'string' &&
        typeof raw.citation === 'string'
      );
    })
    .map((raw) => ({
      item1: raw.item1.trim(),
      item2: raw.item2.trim(),
      severity: raw.severity as 'minor' | 'moderate' | 'major',
      description: raw.description.trim(),
      recommendation: raw.recommendation.trim(),
      citation: raw.citation.trim(),
    }));
}

async function runInteractionCheck(items: ICabinetItem[], prompt: string): Promise<Interaction[]> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  }

  const cacheKey = getCacheKey(items.map((i) => i.name));

  // Check MongoDB cache
  const cached = await getCached<Interaction[]>(CACHE_TYPE, cacheKey);
  if (cached) {
    console.log(`[AI] model=${MODELS.INTERACTION} task=interaction cache_hit=true key="${cacheKey}"`);
    return cached;
  }

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: MODELS.INTERACTION });

  const response = await model.generateContent(prompt);
  const text = response.response.text();

  const usage = response.response.usageMetadata;
  console.log(
    `[AI] model=${MODELS.INTERACTION} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=interaction cache_hit=false`
  );

  const result = parseGeminiResponse(text);

  // Persist to MongoDB (TTL handled by index)
  await setCached(CACHE_TYPE, cacheKey, result);

  return result;
}

/**
 * Check all pairwise interactions for a user's full cabinet.
 * Returns an empty array if the cabinet has fewer than 2 active items.
 *
 * Integration note for POST /cabinet and PUT /cabinet/:id:
 *   After creating/updating an item, call checkNewItemInteractions(newItem, existingItems)
 *   and include the result as `interactions` in the response body.
 *   Example:
 *     const interactions = await checkNewItemInteractions(savedItem, otherActiveItems);
 *     res.json({ success: true, data: { ...savedItem.toObject(), interactions }, error: null });
 */
export async function checkCabinetInteractions(items: ICabinetItem[]): Promise<Interaction[]> {
  if (items.length < 2) {
    return [];
  }
  const prompt = buildPrompt(items);
  return runInteractionCheck(items, prompt);
}

/**
 * Check a single new item against existing cabinet items for interactions.
 * Returns an empty array if there are no existing items to check against.
 *
 * Integration note for POST /cabinet and PUT /cabinet/:id:
 *   Pass the newly saved item as `newItem` and all other active cabinet items
 *   as `existingItems` (excluding the new item itself to avoid self-check).
 */
export async function checkNewItemInteractions(
  newItem: ICabinetItem,
  existingItems: ICabinetItem[]
): Promise<Interaction[]> {
  if (existingItems.length === 0) {
    return [];
  }
  // Build a focused list: new item + existing items
  const allItems = [newItem, ...existingItems];
  const prompt = buildPrompt(allItems);
  return runInteractionCheck(allItems, prompt);
}
