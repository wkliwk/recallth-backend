import Anthropic from '@anthropic-ai/sdk';
import { ICabinetItem } from '../models/CabinetItem';

export interface Interaction {
  item1: string;
  item2: string;
  severity: 'minor' | 'moderate' | 'major';
  description: string;
  recommendation: string;
  citation: string;
}

interface ClaudeInteractionResponse {
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

function parseClaudeResponse(content: string): Interaction[] {
  let parsed: ClaudeInteractionResponse;
  try {
    parsed = JSON.parse(content) as ClaudeInteractionResponse;
  } catch {
    throw new Error(`Claude returned non-JSON response: ${content.slice(0, 200)}`);
  }

  if (!parsed.interactions || !Array.isArray(parsed.interactions)) {
    throw new Error('Claude response missing interactions array');
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

async function runInteractionCheck(prompt: string): Promise<Interaction[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const block = message.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Unexpected response format from Claude API');
  }

  return parseClaudeResponse(block.text);
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
  return runInteractionCheck(prompt);
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
  return runInteractionCheck(prompt);
}
