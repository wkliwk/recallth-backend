export interface PurchaseFields {
  purchasePrice?: number | null;
  purchaseDate?: Date | null;
}

export type PurchaseParse =
  | { ok: true; value: PurchaseFields }
  | { ok: false; error: string };

/**
 * Validate the optional purchase fields of a cabinet request body.
 * - field absent (undefined) → left out of the result (no change)
 * - null or '' → null (clear the value)
 * - purchasePrice must be a finite number ≥ 0; purchaseDate must be a parseable date
 */
export function parsePurchaseFields(body: Record<string, unknown> | undefined): PurchaseParse {
  const value: PurchaseFields = {};
  const b = body ?? {};

  if (b.purchasePrice !== undefined) {
    const raw = b.purchasePrice;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      value.purchasePrice = null;
    } else {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: 'purchasePrice must be a number ≥ 0' };
      }
      value.purchasePrice = n;
    }
  }

  if (b.purchaseDate !== undefined) {
    const raw = b.purchaseDate;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      value.purchaseDate = null;
    } else if (typeof raw === 'string' || typeof raw === 'number' || raw instanceof Date) {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, error: 'purchaseDate must be a valid date' };
      }
      value.purchaseDate = d;
    } else {
      return { ok: false, error: 'purchaseDate must be a valid date' };
    }
  }

  return { ok: true, value };
}
