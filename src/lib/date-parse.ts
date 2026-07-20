/**
 * Explicit date parsers — never rely on JS Date default parsing.
 *
 * Orders CSV:   order_date   →  'YYYY-MM-DD HH:MM:SS'   (space-separated)
 * Payments CSV: processed_at →  'DD/MM/YYYY HH:MM'       (slash-separated)
 */

/**
 * Parse 'YYYY-MM-DD HH:MM:SS' → Date (UTC)
 * Returns null if the string is blank/null.
 * Throws a descriptive error on structural mismatch.
 */
export function parseOrderDate(raw: string | null | undefined): Date {
  if (!raw || raw.trim() === "") {
    throw new Error(`order_date is required but was empty or null`);
  }

  const s = raw.trim();
  // Allow both 'YYYY-MM-DD HH:MM:SS' and 'YYYY-MM-DD HH:MM:SS.mmm'
  const match = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/
  );
  if (!match) {
    throw new Error(
      `order_date "${s}" does not match expected format YYYY-MM-DD HH:MM:SS`
    );
  }

  const [, year, month, day, hour, minute, second] = match;
  const d = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    )
  );

  if (isNaN(d.getTime())) {
    throw new Error(`order_date "${s}" produces an invalid date`);
  }

  return d;
}

/**
 * Parse 'DD/MM/YYYY HH:MM' → Date (UTC)
 * Returns null if the string is blank/null (processed_at is nullable).
 * Throws a descriptive error on structural mismatch.
 */
export function parseProcessedAt(raw: string | null | undefined): Date | null {
  if (!raw || raw.trim() === "") return null;

  const s = raw.trim();
  const match = s.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(
      `processed_at "${s}" does not match expected format DD/MM/YYYY HH:MM`
    );
  }

  const [, day, month, year, hour, minute] = match;

  // Validate ranges before constructing a Date — JS Date silently clamps out-of-range values
  const d_n = Number(day), m_n = Number(month), h_n = Number(hour), min_n = Number(minute);
  if (m_n < 1 || m_n > 12) throw new Error(`processed_at "${s}" has invalid month ${month}`);
  if (d_n < 1 || d_n > 31) throw new Error(`processed_at "${s}" has invalid day ${day}`);
  if (h_n > 23) throw new Error(`processed_at "${s}" has invalid hour ${hour}`);
  if (min_n > 59) throw new Error(`processed_at "${s}" has invalid minute ${minute}`);

  const d = new Date(
    Date.UTC(
      Number(year),
      m_n - 1,
      d_n,
      h_n,
      min_n
    )
  );

  if (isNaN(d.getTime())) {
    throw new Error(`processed_at "${s}" produces an invalid date`);
  }

  return d;
}
