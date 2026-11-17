import { describe, expect, it } from 'vitest';
import { batchServices } from './support/vault';
import { seedV013, scope013 } from './support/fixtures013';
import type { ConvertPropertyTypeOperation, ValueScalar } from '../src/domain/models';

const text = (value: string): ValueScalar => ({ type: 'text', value });

function ratingSources(): ValueScalar[] {
  return ['5', '-2.5', '0.1', '005', ' 5 ', '+5', '约5分', '9007199254740993', '1.0000000000000001', '1,000', '1e3'].map(text);
}
function conversion(): ConvertPropertyTypeOperation {
  return { kind: 'convertPropertyType', key: 'rating', sources: ratingSources(), conversion: { kind: 'text-to-number' } };
}
function services(types?: unknown) {
  const s = batchServices();
  s.settings.excludeGlobs = ['Books/Templates/**'];
  seedV013(s.vault);
  if (types !== undefined) s.vault.config.set('types.json', JSON.stringify(types));
  return s;
}

describe('0.1.3 conversion preview and confirmation', () => {
  it('TC-C01/C02: classifies safe, pending and unconvertible rating values', async () => {
    const s = services();
    const view = await s.preview(conversion(), scope013);
    expect(view.valueSummary).toMatchObject({ ready: 3, needsConfirmation: 3, unconvertible: 5 });
    const byPath = new Map(view.items.map(item => [item.path, item]));
    expect(byPath.get('Books/A.md')!.state).toBe('ready');
    expect(byPath.get('Books/C.md')!.valueAnalysis!.requiredConfirmations).toContain('value-loss');
    expect(byPath.get('Books/D.md')!.state).toBe('blocked');
    expect(byPath.get('Books/F.md')!.reason).toBe('number-precision');
    expect(view.summary.execute).toBe(3);
  });

  it('TC-C01: a confirmed representation change only then rewrites 005', async () => {
    const s = services();
    const view = await s.preview(conversion(), scope013);
    const f03 = view.items.find(item => item.path === 'Books/C.md')!;
    const revised = await s.planner.revisePreview(view.id, view.revision, [{ path: f03.path, beforeHash: f03.decision.beforeHash, valueLossConfirmed: true }]);
    expect(revised.summary.execute).toBe(4);
    await s.executor.execute(s.planner.getPrepared(revised.id, revised.revision));
    expect(s.vault.frontmatter('Books/C.md').rating).toBe(5);
    expect(s.vault.frontmatter('Books/D.md').rating).toBe('约5分'); // unconvertible stays
  });

  it('TC-C07: declared mismatch blocks until confirmed, and never rewrites the declaration', async () => {
    const s = services({ types: { rating: 'text' } });
    const before = s.vault.config.get('types.json');
    const view = await s.preview(conversion(), scope013);
    const f01 = view.items.find(item => item.path === 'Books/A.md')!;
    expect(f01.state).toBe('conflict');
    expect(f01.valueAnalysis!.requiredConfirmations).toContain('declared-type-mismatch');
    expect(view.summary.execute).toBe(0);
    const revised = await s.planner.revisePreview(view.id, view.revision, [{ path: f01.path, beforeHash: f01.decision.beforeHash, declaredTypeMismatchConfirmed: true }]);
    expect(revised.summary.execute).toBe(1);
    const plan = s.planner.getPrepared(revised.id, revised.revision);
    expect(plan.typePatch).toBeUndefined();
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('Books/A.md').rating).toBe(5);
    expect(s.vault.config.get('types.json')).toBe(before);
  });

  it('TC-X06: both confirmations are required and one may be withdrawn', async () => {
    const s = services({ types: { rating: 'text' } });
    const view = await s.preview(conversion(), scope013);
    const f03 = view.items.find(item => item.path === 'Books/C.md')!;
    expect(f03.valueAnalysis!.requiredConfirmations).toEqual(expect.arrayContaining(['value-loss', 'declared-type-mismatch']));
    const onlyLoss = await s.planner.revisePreview(view.id, view.revision, [{ path: f03.path, beforeHash: f03.decision.beforeHash, valueLossConfirmed: true }]);
    expect(onlyLoss.items.find(item => item.path === 'Books/C.md')!.state).toBe('conflict');
    const both = await s.planner.revisePreview(onlyLoss.id, onlyLoss.revision, [{ path: f03.path, beforeHash: f03.decision.beforeHash, declaredTypeMismatchConfirmed: true }]);
    expect(both.items.find(item => item.path === 'Books/C.md')!.state).toBe('ready');
    const withdrawn = await s.planner.revisePreview(both.id, both.revision, [{ path: f03.path, beforeHash: f03.decision.beforeHash, valueLossConfirmed: false }]);
    expect(withdrawn.items.find(item => item.path === 'Books/C.md')!.state).toBe('conflict');
  });

  it('TC-X07: an unreadable declaration blocks new writes', async () => {
    const s = services();
    s.vault.config.set('types.json', '{ not valid json');
    const view = await s.preview(conversion(), scope013);
    expect(view.summary.execute).toBe(0);
    expect(view.items.find(item => item.path === 'Books/A.md')!.reason).toBe('type-config-unsupported');
  });

  it('legacy normalizeDate shares value-loss confirmation', async () => {
    const s = services();
    const view = await s.preview({ kind: 'normalizeDate', key: 'readAt', target: 'date', regionFormat: 'MDY' }, scope013);
    const f04 = view.items.find(item => item.path === 'Books/D.md')!;
    expect(f04.state).toBe('conflict');
    expect(f04.conflict).toBe(true);
    expect(f04.valueAnalysis!.requiredConfirmations).toContain('value-loss');
    expect(view.valueSummary?.needsConfirmation ?? 0).toBeGreaterThan(0);
    expect(s.vault.frontmatter('Books/D.md').readAt).toBe('2024-01-05T12:30:45');
    const revised = await s.planner.revisePreview(view.id, view.revision, [{ path: f04.path, beforeHash: f04.decision.beforeHash, valueLossConfirmed: true }]);
    expect(revised.items.find(item => item.path === 'Books/D.md')!.state).toBe('ready');
  });

  it('TC-M07: re-running the same mapping writes nothing', async () => {
    const s = services();
    const operation = { kind: 'mapPropertyValues' as const, key: 'status', mode: 'field' as const, rules: [
      { id: 'r1', from: text('已读'), to: text('done') },
      { id: 'r2', from: text('finished'), to: text('done') },
      { id: 'r3', from: text('Done '), to: text('done') },
    ] };
    const first = await s.preview(operation, scope013);
    expect(first.summary.execute).toBe(3);
    await s.executor.execute(s.planner.getPrepared(first.id, first.revision));
    const writes = s.vault.noteWrites;
    const second = await s.preview(operation, scope013);
    expect(second.summary.execute).toBe(0);
    expect(s.vault.noteWrites).toBe(writes);
  });
});
