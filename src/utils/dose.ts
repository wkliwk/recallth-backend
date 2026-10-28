export const UNIT_FORMS = ['capsule', 'tablet', 'softgel', 'gummy', 'scoop', 'drop', 'other'] as const;
export type UnitForm = (typeof UNIT_FORMS)[number];

export interface DoseFields {
  strength: string | null;
  unitForm: UnitForm | null;
  servingUnits: number | null;
  bottleCount: number | null;
}

const UNIT_ALIASES: Record<string, UnitForm> = {
  capsule: 'capsule', capsules: 'capsule', caps: 'capsule', cap: 'capsule', 'veg capsule': 'capsule', 'vegetarian capsule': 'capsule', 'vegetarian capsules': 'capsule', 'veg capsules': 'capsule', gélule: 'capsule', gélules: 'capsule',
  tablet: 'tablet', tablets: 'tablet', tab: 'tablet', tabs: 'tablet', caplet: 'tablet', caplets: 'tablet', comprimé: 'tablet', comprimés: 'tablet',
  softgel: 'softgel', softgels: 'softgel', 'soft gel': 'softgel', 'soft gels': 'softgel',
  gummy: 'gummy', gummies: 'gummy',
  scoop: 'scoop', scoops: 'scoop',
  drop: 'drop', drops: 'drop',
  other: 'other',
};

export function normalizeUnitForm(v: unknown): UnitForm | null {
  if (typeof v !== 'string') return null;
  const key = v.trim().toLowerCase();
  if (!key) return null;
  return UNIT_ALIASES[key] ?? null;
}

/** A positive count of units; anything else (0, negative, NaN, text, absurd) is null. Never assume 1. */
export function normalizeCount(v: unknown, max = 100000): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

export function normalizeStrength(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

export function normalizeDoseFields(raw: Record<string, unknown>): DoseFields {
  return {
    strength: normalizeStrength(raw.strength),
    unitForm: normalizeUnitForm(raw.unitForm),
    // servingUnits is a per-dose count (a handful at most); bottleCount can be large.
    servingUnits: normalizeCount(raw.servingUnits, 50),
    bottleCount: normalizeCount(raw.bottleCount),
  };
}

/** Back-compat `dosage` string: "N unit(s) (strength each)" when the count is known, else the strength. */
export function composeLegacyDosage(d: DoseFields, fallback?: unknown): string | null {
  if (d.servingUnits && d.unitForm && d.unitForm !== 'other') {
    const unit = d.servingUnits === 1 ? d.unitForm : `${d.unitForm}s`;
    return d.strength ? `${d.servingUnits} ${unit} (${d.strength} each)` : `${d.servingUnits} ${unit}`;
  }
  return d.strength ?? (typeof fallback === 'string' && fallback.trim() ? fallback.trim() : null);
}
