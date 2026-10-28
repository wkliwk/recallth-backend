export const MAX_TEXT_LENGTH = 2000;

export interface CabinetTextFields {
  description?: string;
  ingredients?: string;
  imageUrl?: string;
}

export type CabinetTextParse =
  | { ok: true; value: CabinetTextFields }
  | { ok: false; error: string };

/**
 * Validate the optional free-text fields accepted on create.
 * - absent / null / empty-after-trim → left out (field not set)
 * - non-string → error
 * - description / ingredients are trimmed and capped at MAX_TEXT_LENGTH
 * - imageUrl must be an http(s) URL or a data:image/ URL
 */
export function parseCabinetTextFields(body: Record<string, unknown> | undefined): CabinetTextParse {
  const b = body ?? {};
  const value: CabinetTextFields = {};

  for (const field of ['description', 'ingredients', 'imageUrl'] as const) {
    const raw = b[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      return { ok: false, error: `${field} must be a string` };
    }
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (field === 'imageUrl') {
      if (!/^(https?:\/\/|data:image\/)/i.test(trimmed)) {
        return { ok: false, error: 'imageUrl must be an http(s) URL or a data:image URL' };
      }
      value.imageUrl = trimmed;
    } else {
      value[field] = trimmed.slice(0, MAX_TEXT_LENGTH);
    }
  }

  return { ok: true, value };
}
