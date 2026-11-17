import { describe, expect, it } from 'vitest';
import { analyzeConversion, containsLink } from '../src/domain/value-conversion';
import { isChangeOperation } from '../src/domain/operation';
import type { ConvertPropertyTypeOperation } from '../src/domain/models';

function number(raw: unknown) { return analyzeConversion(raw, { kind: 'text-to-number' }); }
function wrap(raw: unknown) { return analyzeConversion(raw, { kind: 'wrap-list' }); }
function split(raw: string, delimiter: { kind: 'literal'; value: string } | { kind: 'newline' }, trimItems = false, dropEmptyItems = false) {
  return analyzeConversion(raw, { kind: 'split-list', delimiter, trimItems, dropEmptyItems });
}
function date(raw: unknown, target: 'date' | 'datetime', regionFormat: 'MDY' | 'DMY' | 'YMD' = 'MDY') {
  return analyzeConversion(raw, { kind: 'normalize-date', target, regionFormat });
}

describe('0.1.3 text to number', () => {
  it('TC-C01: converts safe decimals and confirms representation changes', () => {
    expect(number('5')).toMatchObject({ outcome: 'ready', afterType: 'number', candidate: 5 });
    expect(number('-2.5')).toMatchObject({ outcome: 'ready', candidate: -2.5 });
    expect(number('0.1')).toMatchObject({ outcome: 'ready', candidate: 0.1 });
    expect(number('5.0')).toMatchObject({ outcome: 'ready', candidate: 5 });
    for (const raw of ['005', ' 5 ', '+5', '-0']) {
      const result = number(raw);
      expect(result.outcome).toBe('needs-confirmation');
      expect(result.requiredConfirmations).toContain('value-loss');
    }
  });

  it('TC-C02: keeps unsupported syntax and unsafe precision as unconvertible', () => {
    for (const raw of ['约5分', '1,000', '1e3', '0x10', '5%', '1 000']) expect(number(raw).outcome).toBe('unconvertible');
    expect(number('约5分').issues[0].code).toBe('number-format');
    expect(number('9007199254740993').issues[0].code).toBe('number-precision');
    expect(number('1.0000000000000001').issues[0].code).toBe('number-precision');
    expect(number(null).outcome).toBe('unconvertible');
    expect(number('').outcome).toBe('unconvertible');
    expect(number('   ').outcome).toBe('unconvertible');
    expect(number(5)).toMatchObject({ outcome: 'noop' });
    // A non-zero negative decimal that underflows to -0 is a precision loss, not a representation change.
    const underflow = '-0.' + '0'.repeat(400) + '1';
    expect(number(underflow).outcome).toBe('unconvertible');
    expect(number(underflow).issues[0].code).toBe('number-precision');
    expect(number('-0')).toMatchObject({ outcome: 'needs-confirmation' });
    expect(number('-0.0')).toMatchObject({ outcome: 'needs-confirmation' });
  });
});

describe('0.1.3 wrap and split', () => {
  it('TC-C03: wraps scalars without stringifying or nesting', () => {
    expect(wrap('甲')).toMatchObject({ outcome: 'ready', candidate: ['甲'], afterType: 'list' });
    expect(wrap(5).candidate).toEqual([5]);
    expect(wrap(false).candidate).toEqual([false]);
    expect(wrap(['a'])).toMatchObject({ outcome: 'noop' });
    expect(wrap(null).outcome).toBe('unconvertible');
    expect(wrap({}).outcome).toBe('unconvertible');
    expect(wrap('  ').outcome).toBe('unconvertible');
  });

  it('TC-C04: splits by an explicit literal delimiter with default preservation', () => {
    expect(split('甲; 乙;;甲', { kind: 'literal', value: ';' }).candidate).toEqual(['甲', ' 乙', '', '甲']);
    expect(split('甲; 乙;;甲', { kind: 'literal', value: ';' }, true, true).candidate).toEqual(['甲', '乙', '甲']);
    expect(split('a\nb', { kind: 'newline' }).candidate).toEqual(['a', 'b']);
    expect(split('a\r\nb', { kind: 'newline' }).candidate).toEqual(['a', 'b']);
    expect(split('a\rb', { kind: 'newline' }).candidate).toEqual(['a', 'b']);
    expect(split('a\\nb', { kind: 'literal', value: '\\n' }).candidate).toEqual(['a', 'b']);
  });

  it('TC-C05: blocks links and reports a missing delimiter', () => {
    expect(containsLink('[[Book A|甲;乙]]')).toBe(true);
    expect(split('[[Book A|甲;乙]]', { kind: 'literal', value: ';' }).issues[0].code).toBe('split-link');
    expect(split('Doe, John', { kind: 'literal', value: ';' }).issues[0].code).toBe('split-delimiter-missing');
    expect(split('Doe, John', { kind: 'literal', value: ',' }).candidate).toEqual(['Doe', ' John']);
  });
});

describe('0.1.3 date normalization', () => {
  it('TC-C06: flags interpretation and value-loss risks', () => {
    const ambiguous = date('01/02/2024', 'date', 'MDY');
    expect(ambiguous.outcome).toBe('needs-confirmation');
    expect(ambiguous.requiredConfirmations).toContain('date-interpretation');
    expect(ambiguous.candidate).toBe('2024-01-02');

    const lossy = date('2024-01-05T12:30:45', 'date');
    expect(lossy.requiredConfirmations).toContain('value-loss');

    const pad = date('2024-01-05', 'datetime');
    expect(pad.candidate).toBe('2024-01-05T00:00');
    expect(pad.requiredConfirmations).toContain('value-loss');

    const twoDigit = date('13/02/24', 'date', 'DMY');
    expect(twoDigit.candidate).toBe('2024-02-13');
    expect(twoDigit.requiredConfirmations).toContain('date-interpretation');
  });

  it('TC-C06/X08: rejects illegal time and unpreservable information', () => {
    expect(date('2024-01-05T12:30:99', 'date').issues[0].code).toBe('date-invalid-time');
    expect(date('2024-01-05T24:00', 'date').issues[0].code).toBe('date-invalid-time');
    expect(date('2024-01-05T12:30:45Z', 'date').issues[0].code).toBe('date-unsupported');
    expect(date('2024-01-05T12:30:45+08:00', 'date').issues[0].code).toBe('date-unsupported');
    expect(date('2024-01-05T12:30:45.500', 'date').issues[0].code).toBe('date-unsupported');
    expect(date('2024-01-05', 'date')).toMatchObject({ outcome: 'noop' });
    expect(date(20240105, 'date').issues[0].code).toBe('date-non-text');
  });
});

describe('0.1.3 operation validation', () => {
  const base: ConvertPropertyTypeOperation = { kind: 'convertPropertyType', key: 'rating', sources: [{ type: 'text', value: '5' }], conversion: { kind: 'text-to-number' } };
  it('accepts valid conversions and rejects malformed parameters', () => {
    expect(isChangeOperation(base)).toBe(true);
    expect(isChangeOperation({ ...base, conversion: { kind: 'split-list', delimiter: { kind: 'literal', value: '' }, trimItems: false, dropEmptyItems: false } })).toBe(false);
    expect(isChangeOperation({ ...base, sources: [{ type: 'number', value: 5 }] })).toBe(false);
    expect(isChangeOperation({ ...base, conversion: { kind: 'normalize-date', target: 'date', regionFormat: 'XX' } })).toBe(false);
    const wrapNumber = { ...base, sources: [{ type: 'number', value: 5 }], conversion: { kind: 'wrap-list' } };
    expect(isChangeOperation(wrapNumber)).toBe(true);
  });

  it('allows stored finite numbers beyond the safe range as sources only', () => {
    const big = 9007199254740992; // 2^53, finite but outside the safe integer targets
    const wrap = { kind: 'convertPropertyType', key: 'n', sources: [{ type: 'number', value: big }], conversion: { kind: 'wrap-list' } };
    expect(isChangeOperation(wrap)).toBe(true);
    const mapToText = { kind: 'mapPropertyValues', key: 'n', mode: 'field', rules: [{ id: 'a', from: { type: 'number', value: big }, to: { type: 'text', value: 'x' } }] };
    expect(isChangeOperation(mapToText)).toBe(true);
    const unsafeTarget = { kind: 'convertPropertyType', key: 'n', sources: [{ type: 'text', value: 'x' }], conversion: { kind: 'wrap-list' } };
    expect(isChangeOperation({ ...unsafeTarget })).toBe(true); // sanity that text sources convert
  });

  it('rejects unsafe numeric mapping targets', () => {
    const operation = {
      kind: 'mapPropertyValues', key: 'rating', mode: 'field',
      rules: [{ id: 'a', from: { type: 'text', value: '5' }, to: { type: 'number', value: Number.MAX_SAFE_INTEGER + 2 } }],
    };
    expect(isChangeOperation(operation)).toBe(false);
    const good = { ...operation, rules: [{ id: 'a', from: { type: 'text', value: '5' }, to: { type: 'number', value: 5 } }] };
    expect(isChangeOperation(good)).toBe(true);
  });
});
