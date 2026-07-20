/**
 * Shared CSV parsing utilities.
 *
 * Uses papaparse in "step" (streaming) mode so large files are processed
 * row-by-row without loading the entire file into a JS array first.
 */

import Papa from "papaparse";
import { Decimal } from "@prisma/client/runtime/library";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportWarning {
  row: number;
  field: string;
  message: string;
}

export interface ParseResult<T> {
  rows: T[];
  warnings: ImportWarning[];
  /** Number of exact-duplicate rows that were silently removed */
  dedupedCount: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse and validate a monetary field as a Prisma Decimal.
 * Throws a descriptive error if the value is not a valid number.
 */
export function parseDecimal(
  raw: string | null | undefined,
  field: string,
  nullable = false
): Decimal | null {
  if (!raw || raw.trim() === "") {
    if (nullable) return null;
    throw new Error(`Field "${field}" is required but was empty`);
  }
  const cleaned = raw.trim().replace(/,/g, ""); // tolerate comma-separated thousands
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(
      `Field "${field}" value "${raw.trim()}" is not a valid number`
    );
  }
  return new Decimal(cleaned);
}

/**
 * Normalise an order ID / order reference:
 *   - trim leading/trailing whitespace
 *   - convert to UPPER CASE
 */
export function normaliseRef(raw: string | null | undefined, field: string): string {
  if (!raw || raw.trim() === "") {
    throw new Error(`Field "${field}" is required but was empty`);
  }
  return raw.trim().toUpperCase();
}

/**
 * Validate that a CSV row contains exactly the required headers.
 * Returns null on success, or an error message string on failure.
 */
export function validateHeaders(
  actual: string[],
  required: string[]
): string | null {
  const missing = required.filter((h) => !actual.includes(h));
  const extra = actual.filter((h) => !required.includes(h));

  if (missing.length > 0) {
    return `Missing required columns: ${missing.join(", ")}`;
  }
  if (extra.length > 0) {
    // Extra columns are a warning, not a rejection — but for strict structural
    // validation we reject to surface data pipeline issues early.
    return `Unexpected columns: ${extra.join(", ")}. Expected: ${required.join(", ")}`;
  }
  return null;
}

/**
 * Deduplicate rows using a serialised-field fingerprint.
 * "Exact duplicate" = every field value is identical.
 *
 * Returns the deduplicated array and the count of removed rows.
 */
export function dedupeRows<T extends Record<string, unknown>>(
  rows: T[]
): { rows: T[]; removed: number } {
  const seen = new Set<string>();
  const unique: T[] = [];

  for (const row of rows) {
    // Stable JSON key order: sort keys before serialising
    const key = JSON.stringify(
      Object.fromEntries(Object.keys(row).sort().map((k) => [k, String((row as Record<string, unknown>)[k])]))
    );
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  return { rows: unique, removed: rows.length - unique.length };
}

// ─── Core streaming parser ────────────────────────────────────────────────────

/**
 * Parse CSV text content using papaparse in step-mode (row-by-row).
 *
 * @param csvText   Raw CSV string content
 * @param requiredHeaders  Expected column names (order-insensitive)
 * @param rowParser  Per-row transform function; throw to add a structural error,
 *                   return null to skip the row with a warning (nullable fields).
 */
export async function parseCsvStream<T extends Record<string, unknown>>(
  csvText: string,
  requiredHeaders: string[],
  rowParser: (
    row: Record<string, string>,
    rowIndex: number,
    warnings: ImportWarning[]
  ) => T | null
): Promise<ParseResult<T>> {
  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    const warnings: ImportWarning[] = [];
    let headersValidated = false;
    let rowIndex = 0;
    let structuralError: string | null = null;

    Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),

      step(result) {
        if (structuralError) return; // stop processing once we have a fatal error

        // Validate headers on the first row
        if (!headersValidated) {
          const headerError = validateHeaders(
            Object.keys(result.data),
            requiredHeaders
          );
          if (headerError) {
            structuralError = headerError;
            return;
          }
          headersValidated = true;
        }

        rowIndex++;

        try {
          const parsed = rowParser(result.data, rowIndex, warnings);
          if (parsed !== null) {
            rows.push(parsed);
          }
        } catch (err) {
          structuralError = `Row ${rowIndex}: ${(err as Error).message}`;
        }
      },

      complete() {
        if (!headersValidated && !structuralError) {
          structuralError = "File is empty or contains no data rows";
        }
        if (structuralError) {
          reject(new Error(structuralError));
          return;
        }
        resolve({ rows, warnings, dedupedCount: 0 });
      },

      error(err: Error) {
        reject(new Error(`CSV parse error: ${err.message}`));
      },
    });
  });
}
