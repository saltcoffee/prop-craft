import type { ValueConversion } from './models';
import type { ValueAnalysis, ValueConfirmation, ValueIssue } from './preview';
import type { IssueCode } from './errors';
import { actualValueType } from './property-value';
import { normalizeDateValue } from './date';

export type { SplitDelimiter, ValueConversion } from './models';

/** Wikilink, embed, Markdown link or link-like fragments: never split or auto-rewrite these. */
const LINK_PATTERN = /(?:\[\[[^\]]*\]\])|(?:!?\[[^\]]*\]\([^)]*\))|(?:\[\[[^\]]*$)|(?:\[[^\]]*\]\[[^\]]*\])/;

export function containsLink(text: string): boolean {
  return LINK_PATTERN.test(text);
}

interface DecimalParse { ok: boolean; value?: number; representation: boolean; precision: boolean }

function normalizeDecimalString(input: string): string {
  let text = input.trim();
  let negative = false;
  if (text.startsWith('-')) { negative = true; text = text.slice(1); } else if (text.startsWith('+')) text = text.slice(1);
  let [whole, fraction = ''] = text.split('.');
  whole = whole.replace(/^0+(?=\d)/, '');
  if (whole === '') whole = '0';
  fraction = fraction.replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  const isZero = /^0(?:\.0*)?$/.test(body);
  return negative && !isZero ? `-${body}` : body;
}

function expandNumber(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value);
  if (!/e/i.test(text)) return normalizeDecimalString(text);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [base, exponentText] = unsigned.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const [whole, fraction = ''] = base.split('.');
  const digits = whole + fraction;
  const pointIndex = whole.length + exponent;
  let expanded: string;
  if (pointIndex <= 0) expanded = `0.${'0'.repeat(-pointIndex)}${digits}`;
  else if (pointIndex >= digits.length) expanded = digits + '0'.repeat(pointIndex - digits.length);
  else expanded = `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
  return normalizeDecimalString(negative ? `-${expanded}` : expanded);
}

/** Parse a decimal string. `representation` marks a value that changes its written form. */
export function parseDecimal(text: string): DecimalParse {
  const strict = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
  if (strict.test(text)) {
    const value = Number(text);
    const representation = Object.is(value, -0);
    return precisionCheck(text, value, representation);
  }
  const trimmed = text.trim();
  if (trimmed !== text || /^\+/.test(trimmed) || /^-?0[0-9]/.test(trimmed) || /^-0(?:\.0*)?$/.test(trimmed)) {
    let normalized = trimmed;
    if (normalized.startsWith('+')) normalized = normalized.slice(1);
    normalized = normalized.replace(/^(-?)0+(?=[0-9])/, '$1');
    if (strict.test(normalized)) {
      const value = Number(normalized);
      return precisionCheck(normalized, value, true);
    }
  }
  return { ok: false, representation: false, precision: false };
}

function precisionCheck(source: string, value: number, representation: boolean): DecimalParse {
  if (!Number.isFinite(value)) return { ok: false, representation, precision: true };
  if (Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) return { ok: false, representation, precision: true };
  if (Object.is(value, -0)) {
    // Negative zero is only a representation change for an actual zero; a non-zero source that
    // underflowed to -0 has lost precision and must never be accepted.
    if (normalizeDecimalString(source) === '0') return { ok: true, value, representation: true, precision: false };
    return { ok: false, representation: true, precision: true };
  }
  const expected = expandNumber(value);
  if (expected === null || normalizeDecimalString(source) !== expected) return { ok: false, representation, precision: true };
  return { ok: true, value, representation, precision: false };
}

function ok(outcome: ValueAnalysis['outcome'], extra: Partial<ValueAnalysis> = {}): ValueAnalysis {
  return { outcome, ruleIds: [], issues: [], requiredConfirmations: [], ...extra };
}

function issue(code: IssueCode): ValueAnalysis['issues'] {
  return [{ code }];
}

function analyzeNumber(raw: unknown): ValueAnalysis {
  if (typeof raw === 'number') return ok('noop', { beforeType: 'number', issues: issue('already-equal') });
  if (typeof raw !== 'string') return ok('unconvertible', { beforeType: actualValueType(raw), issues: issue('value-unsupported') });
  if (raw.length === 0 || raw.trim().length === 0) return ok('unconvertible', { beforeType: 'text', issues: issue('value-empty-source') });
  const parsed = parseDecimal(raw);
  if (!parsed.ok) {
    const code: IssueCode = parsed.precision ? 'number-precision' : 'number-format';
    return ok('unconvertible', { beforeType: 'text', issues: issue(code) });
  }
  const candidate = parsed.value;
  if (!parsed.representation) return ok('ready', { beforeType: 'text', afterType: 'number', candidate });
  return ok('needs-confirmation', { beforeType: 'text', afterType: 'number', candidate,
    issues: issue('number-representation'), requiredConfirmations: ['value-loss'] });
}

function analyzeWrap(raw: unknown): ValueAnalysis {
  const beforeType = actualValueType(raw);
  if (beforeType === 'list') return ok('noop', { beforeType, issues: issue('already-equal') });
  if (beforeType === 'object') return ok('unconvertible', { beforeType, issues: issue('value-unsupported') });
  if (beforeType === 'null') return ok('unconvertible', { beforeType, issues: issue('value-empty-source') });
  if (beforeType === 'text') {
    const text = raw as string;
    if (text.length === 0 || text.trim().length === 0) return ok('unconvertible', { beforeType, issues: issue('value-empty-source') });
  }
  return ok('ready', { beforeType, afterType: 'list', candidate: [raw] });
}

function analyzeSplit(raw: unknown, conversion: Extract<ValueConversion, { kind: 'split-list' }>): ValueAnalysis {
  if (typeof raw !== 'string') return ok('unconvertible', { beforeType: actualValueType(raw), issues: issue('value-unsupported') });
  if (raw.length === 0) return ok('unconvertible', { beforeType: 'text', issues: issue('value-empty-source') });
  if (containsLink(raw)) return ok('unconvertible', { beforeType: 'text', issues: issue('split-link') });
  const { delimiter, trimItems, dropEmptyItems } = conversion;
  let pieces: string[];
  if (delimiter.kind === 'newline') {
    if (!/[\r\n]/.test(raw)) return ok('unconvertible', { beforeType: 'text', issues: issue('split-delimiter-missing') });
    pieces = raw.split(/\r\n|\r|\n/);
  } else {
    if (!delimiter.value) return ok('unconvertible', { beforeType: 'text', issues: issue('value-unsupported') });
    if (!raw.includes(delimiter.value)) return ok('unconvertible', { beforeType: 'text', issues: issue('split-delimiter-missing') });
    pieces = raw.split(delimiter.value);
  }
  if (trimItems) pieces = pieces.map(piece => piece.trim());
  if (dropEmptyItems) pieces = pieces.filter(piece => piece !== '');
  return ok('ready', { beforeType: 'text', afterType: 'list', candidate: pieces });
}

/** Pre-validate every raw date component before reusing the legacy parser (which drops seconds). */
export function validateDateInput(raw: string): IssueCode | null {
  const text = raw.trim();
  if (!text) return 'date-unrecognized';
  // Reject offsets, Z markers and fractional seconds: the legacy parser cannot preserve them.
  if (/(?:Z|[+-]\d{2}:?\d{2}|\.\d+)$/i.test(text) && /[T ]\d{1,2}:\d{2}/.test(text)) return 'date-unsupported';
  const time = /[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(text);
  if (time) {
    const hour = Number(time[1]), minute = Number(time[2]), second = time[3] === undefined ? 0 : Number(time[3]);
    if (hour > 23 || minute > 59 || second > 59) return 'date-invalid-time';
  }
  return null;
}

function hasTime(text: string): boolean {
  return /[T ]\d{1,2}:\d{2}/.test(text.trim());
}

function hasSeconds(text: string): boolean {
  return /[T ]\d{1,2}:\d{2}:\d{2}/.test(text.trim());
}

function hasTwoDigitYear(text: string): boolean {
  const dotted = /^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/.exec(text.trim());
  return Boolean(dotted && dotted[1].length !== 4 && dotted[3].length === 2);
}

function analyzeDate(raw: unknown, conversion: Extract<ValueConversion, { kind: 'normalize-date' }>): ValueAnalysis {
  if (typeof raw !== 'string') return ok('unconvertible', { beforeType: actualValueType(raw), issues: issue('date-non-text') });
  const invalid = validateDateInput(raw);
  if (invalid) return ok('unconvertible', { beforeType: 'text', issues: issue(invalid) });
  const parsed = normalizeDateValue(raw, conversion.target, conversion.regionFormat);
  if (!parsed.ok || !parsed.iso) {
    return ok('unconvertible', { beforeType: 'text', issues: issue(parsed.ambiguous ? 'date-ambiguous' : 'date-unrecognized') });
  }
  if (parsed.iso === raw) return ok('noop', { beforeType: 'text', afterType: 'text', issues: issue('already-normalized') });
  const required: ValueConfirmation[] = [];
  const issues: ValueIssue[] = [];
  if (parsed.ambiguous || hasTwoDigitYear(raw)) { required.push('date-interpretation'); issues.push({ code: 'date-ambiguous' }); }
  const loss = (conversion.target === 'date' && hasTime(raw))
    || (conversion.target === 'datetime' && !hasTime(raw))
    || hasSeconds(raw);
  if (loss) { required.push('value-loss'); issues.push({ code: 'date-value-loss' }); }
  return ok(required.length ? 'needs-confirmation' : 'ready', {
    beforeType: 'text', afterType: 'text', candidate: parsed.iso, issues, requiredConfirmations: required,
  });
}

/** Pure per-value conversion analysis shared by the editor trial, preview and execution. */
export function analyzeConversion(raw: unknown, conversion: ValueConversion): ValueAnalysis {
  switch (conversion.kind) {
    case 'text-to-number': return analyzeNumber(raw);
    case 'wrap-list': return analyzeWrap(raw);
    case 'split-list': return analyzeSplit(raw, conversion);
    case 'normalize-date': return analyzeDate(raw, conversion);
  }
}
