import { describe, expect, it } from 'vitest';
import { normalizeDateValue, parseDate } from '../src/domain/date';

describe('parseDate', () => {
  it('parses ISO input', () => {
    expect(parseDate('2024-01-05', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
  });
  it('parses compact input', () => {
    expect(parseDate('20240105', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
  });
  it('parses Chinese date', () => {
    expect(parseDate('2024年1月5日', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
  });
  it('parses slash and dot dates as year-first', () => {
    expect(parseDate('2024/1/5', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
    expect(parseDate('2024.01.05', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
  });
  it('parses English month names', () => {
    expect(parseDate('Jan 5, 2024', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
    expect(parseDate('5 January 2024', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
  });
  it('honours the region format for ambiguous dates', () => {
    expect(parseDate('01/02/2024', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-02' });
    expect(parseDate('01/02/2024', 'DMY')).toMatchObject({ ok: true, iso: '2024-02-01' });
    expect(parseDate('01/02/2024', 'YMD')).toMatchObject({ ok: false, ambiguous: true });
  });
  it('rejects impossible dates', () => {
    expect(parseDate('2024-02-30', 'MDY').ok).toBe(false);
    expect(parseDate('2023-02-29', 'MDY').ok).toBe(false);
  });
  it('accepts leap day', () => {
    expect(parseDate('2024-02-29', 'MDY')).toMatchObject({ ok: true, iso: '2024-02-29' });
  });
  it('rejects free text', () => {
    expect(parseDate('待定', 'MDY').ok).toBe(false);
  });
});

describe('normalizeDateValue', () => {
  it('keeps time for datetime target', () => {
    expect(normalizeDateValue('2024-01-05T09:30', 'datetime', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05T09:30' });
  });
  it('truncates to date for date target', () => {
    expect(normalizeDateValue('2024-01-05T09:30', 'date', 'MDY')).toMatchObject({ ok: true, iso: '2024-01-05' });
  });
});
