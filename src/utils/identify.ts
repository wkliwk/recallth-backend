import { normalizeUnitForm, normalizeCount, normalizeStrength, UnitForm } from './dose';

export type IdentifyMatch = 'exact' | 'likely' | 'unsure';

export interface IdentifyResult {
  nameOriginal: string | null;
  nameEnglish: string | null;
  brand: string | null;
  strength: string | null;
  unitForm: UnitForm | null;
  packSize: number | null;
  servingUnits: number | null; // units per DOSE (never the daily total); null for ranges / not found
  timesPerDay: number | null;
  directions: string | null;
  sourceUrl: string | null;
  codes: string[];
  match: IdentifyMatch;
  /** True when the match is trustworthy enough to fill fields: exact/likely AND a source page was used. */
  usable: boolean;
}

const str = (v: unknown, max = 300): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

function httpUrl(v: unknown): string | null {
  const s = str(v, 2000);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

function codesFrom(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list
    .map((c) => str(c, 60))
    .filter((c): c is string => !!c)
    .slice(0, 5);
}

/** Normalise whatever the model returned. Never trusts counts: positive and per-dose-sized, else null. */
export function normalizeIdentify(raw: Record<string, unknown>): IdentifyResult {
  const matchRaw = typeof raw.match === 'string' ? raw.match.trim().toLowerCase() : '';
  const match: IdentifyMatch = matchRaw === 'exact' || matchRaw === 'likely' ? matchRaw : 'unsure';
  const sourceUrl = httpUrl(raw.sourceUrl);
  const usable = (match === 'exact' || match === 'likely') && !!sourceUrl;

  return {
    nameOriginal: str(raw.nameOriginal),
    nameEnglish: str(raw.nameEnglish),
    brand: str(raw.brand, 120),
    strength: normalizeStrength(raw.strength) ? (normalizeStrength(raw.strength) as string).slice(0, 200) : null,
    unitForm: normalizeUnitForm(raw.unitForm),
    packSize: normalizeCount(raw.packSize),
    // Directions-derived fields are only kept when the match is usable.
    servingUnits: usable ? normalizeCount(raw.servingUnits, 50) : null,
    timesPerDay: usable ? normalizeCount(raw.timesPerDay, 24) : null,
    directions: usable ? str(raw.directions, 400) : null,
    sourceUrl,
    codes: codesFrom(raw.codeRead ?? raw.codes),
    match,
    usable,
  };
}
