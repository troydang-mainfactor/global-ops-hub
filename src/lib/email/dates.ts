// Date parsing for dates written in emails and PDFs. Returns UTC midnight.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function utc(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

/** Year for a date written without one: the year that puts it closest to the reference date. */
function inferYear(m: number, d: number, ref: Date): number {
  const y = ref.getUTCFullYear();
  const candidates = [y - 1, y, y + 1].map((yy) => ({ yy, t: Date.UTC(yy, m, d) }));
  candidates.sort((a, b) => Math.abs(a.t - ref.getTime()) - Math.abs(b.t - ref.getTime()));
  return candidates[0].yy;
}

/**
 * Parses "2026-12-02", "12/02/2026" (US), "Dec 2, 2026", "December 2 2026", "2 Dec 2026",
 * "Wed, Dec 2" and "Dec 2" (year inferred from `ref`). Returns null for empty / "[no value]" / unknown.
 */
export function parseLooseDate(raw: string | null | undefined, ref: Date = new Date()): Date | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, ""); // drop weekday
  if (!s || /^\[?no value\]?$/i.test(s) || /^(n\/a|tbd|tbc|none|-)$/i.test(s)) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return utc(+m[1], +m[2] - 1, +m[3]);

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return utc(y, +m[1] - 1, +m[2]);
  }

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    const y = m[3] ? +m[3] : inferYear(mon, +m[2], ref);
    return utc(y, mon, +m[2]);
  }

  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?(?:\s+(\d{4}))?$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    const y = m[3] ? +m[3] : inferYear(mon, +m[1], ref);
    return utc(y, mon, +m[1]);
  }
  return null;
}

export function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
