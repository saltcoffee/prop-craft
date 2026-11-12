export type RegionFormat = 'MDY' | 'DMY' | 'YMD';

export interface DateParseResult {
  ok: boolean;
  iso?: string;
  ambiguous?: boolean;
  raw?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function build(year: number, month: number, day: number, time?: [number, number]): DateParseResult | null {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (time) {
    const [hour, minute] = time;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { ok: true, iso: `${date}T${pad(hour)}:${pad(minute)}` };
  }
  return { ok: true, iso: date };
}

function parseTime(raw: string): [number, number] | undefined {
  const match = /[T ](\d{1,2}):(\d{2})(?::\d{2})?/.exec(raw);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/** Parse a human date string into an ISO date (or datetime) value. */
export function parseDate(raw: string, region: RegionFormat): DateParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, raw };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(text);
  if (iso) {
    const result = build(Number(iso[1]), Number(iso[2]), Number(iso[3]), parseTime(text));
    return result ?? { ok: false, raw };
  }

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) {
    const result = build(Number(compact[1]), Number(compact[2]), Number(compact[3]));
    return result ?? { ok: false, raw };
  }

  const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(text);
  if (cn) {
    const result = build(Number(cn[1]), Number(cn[2]), Number(cn[3]));
    return result ?? { ok: false, raw };
  }

  const dotted = /^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/.exec(text);
  if (dotted) {
    const a = dotted[1]!;
    const b = Number(dotted[2]);
    const c = dotted[3]!;
    if (a.length === 4) {
      const result = build(Number(a), b, Number(c));
      return result ?? { ok: false, raw };
    }
    if (region === 'YMD') return { ok: false, ambiguous: true, raw };
    const year = Number(c.length === 2 ? `20${c}` : c);
    if (region === 'MDY') {
      const result = build(year, Number(a), b);
      return result ?? { ok: false, raw };
    }
    const result = build(year, b, Number(a));
    return result ?? { ok: false, raw };
  }

  const monthFirst = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1]!.toLowerCase()];
    if (month) {
      const result = build(Number(monthFirst[3]), month, Number(monthFirst[2]));
      return result ?? { ok: false, raw };
    }
  }

  const dayFirst = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(text);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.toLowerCase()];
    if (month) {
      const result = build(Number(dayFirst[3]), month, Number(dayFirst[1]));
      return result ?? { ok: false, raw };
    }
  }

  return { ok: false, raw };
}

/** Convert to the requested target type; datetime targets keep a time if present. */
export function normalizeDateValue(raw: string, target: 'date' | 'datetime', region: RegionFormat): DateParseResult {
  const parsed = parseDate(raw, region);
  if (!parsed.ok || !parsed.iso) return parsed;
  if (target === 'date') return { ok: true, iso: parsed.iso.slice(0, 10), raw };
  return { ok: true, iso: parsed.iso.includes('T') ? parsed.iso : `${parsed.iso}T00:00`, raw };
}
