import { describe, expect, it } from 'vitest';
import { batchServices } from './support/vault';
import { seedV013, scope013 } from './support/fixtures013';
import type { MapPropertyValuesOperation, ValueScalar } from '../src/domain/models';
import { analyzeValueMapping, compileValueMapping, suggestTextMappings, validateValueMapping } from '../src/domain/value-mapping';
import { fileMeta } from '../src/application/file-meta';

const text = (value: string): ValueScalar => ({ type: 'text', value });

function fieldRules(): MapPropertyValuesOperation['rules'] {
  return [
    { id: 'r1', from: text('已读'), to: text('done') },
    { id: 'r2', from: text('finished'), to: text('done') },
    { id: 'r3', from: text('Done '), to: text('done') },
  ];
}

function services() {
  const s = batchServices();
  s.settings.excludeGlobs = ['Books/Templates/**'];
  seedV013(s.vault);
  return s;
}

async function run(s: ReturnType<typeof batchServices>, operation: MapPropertyValuesOperation) {
  const view = await s.preview(operation, scope013);
  if (view.summary.execute) await s.executor.execute(s.planner.getPrepared(view.id, view.revision));
  return view;
}

describe('0.1.3 value mapping domain', () => {
  it('TC-M01: field mapping only rewrites the exact typed sources', async () => {
    const s = services();
    const view = await run(s, { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: fieldRules() });
    expect(view.summary.execute).toBe(3);
    expect(s.vault.frontmatter('Books/A.md').status).toBe('done');
    expect(s.vault.frontmatter('Books/B.md').status).toBe('done');
    expect(s.vault.frontmatter('Books/C.md').status).toBe('done');
    expect(s.vault.frontmatter('Books/D.md').status).toBe('done'); // already done, no write
    expect(s.vault.frontmatter('Books/N.md').status).toEqual(['已读', 'done', '待读']); // list untouched
    expect(s.vault.noteWrites).toBe(3);
  });

  it('TC-M02: member mapping preserves order and only dedupes produced targets', async () => {
    const s = services();
    const view = await run(s, { kind: 'mapPropertyValues', key: 'status', mode: 'member', rules: fieldRules() });
    expect(view.summary.execute).toBe(2);
    expect(s.vault.frontmatter('Books/N.md').status).toEqual(['done', '待读']);
    expect(s.vault.frontmatter('Books/P.md').status).toEqual(['done', '待读']);
    expect(s.vault.frontmatter('Books/O.md').status).toEqual(['done', 'done', '待读']); // no source, untouched
    expect(s.vault.frontmatter('Books/Q.md').status).toEqual(['5', 5, '[[Book A]]']);
  });

  it('TC-M02: a self-mapping member rule never dedupes untouched duplicates', async () => {
    const s = services();
    const view = await run(s, { kind: 'mapPropertyValues', key: 'status', mode: 'member', rules: [{ id: 'r', from: text('done'), to: text('done') }] });
    expect(view.summary.execute).toBe(0);
    expect(s.vault.noteWrites).toBe(0);
    expect(s.vault.frontmatter('Books/O.md').status).toEqual(['done', 'done', '待读']);
  });

  it('TC-M05: a rule producing empty text conflicts with empty-text fill', () => {
    const unstable: MapPropertyValuesOperation = { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [{ id: 'a', from: text('old'), to: text('') }], fill: { states: ['empty-text'], target: text('done') } };
    expect(validateValueMapping(unstable).map(issue => issue.code)).toContain('mapping-non-idempotent');
    // Filling empty text back to empty text is already stable, so this must be accepted.
    const stable: MapPropertyValuesOperation = { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [{ id: 'a', from: text('old'), to: text('') }], fill: { states: ['empty-text'], target: text('') } };
    expect(validateValueMapping(stable)).toEqual([]);
  });

  it('TC-M04: four empty states fill independently and never touch whitespace, 0 or false', async () => {
    const s = services();
    const fill = { states: ['missing', 'null', 'empty-text', 'empty-list'] as const, target: text('unread') };
    const view = await run(s, { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [], fill });
    expect(view.summary.execute).toBe(5);
    for (const path of ['Books/E.md', 'Books/F.md', 'Books/G.md', 'Books/H.md', 'Books/S.md']) expect(s.vault.frontmatter(path).status).toBe('unread');
    expect(s.vault.frontmatter('Books/I.md').status).toBe(' ');
    expect(s.vault.frontmatter('Books/J.md').status).toBe(0);
    expect(s.vault.frontmatter('Books/K.md').status).toBe(false);
  });

  it('TC-M05: rejects source conflicts, non-idempotent chains and empty operations', () => {
    const conflict: MapPropertyValuesOperation = { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [
      { id: 'a', from: text('x'), to: text('y') }, { id: 'b', from: text('x'), to: text('z') }] };
    expect(validateValueMapping(conflict).map(issue => issue.code)).toContain('mapping-source-conflict');
    expect(() => compileValueMapping(conflict)).toThrow('mapping-source-conflict');
    const chain: MapPropertyValuesOperation = { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [
      { id: 'a', from: text('a'), to: text('b') }, { id: 'b', from: text('b'), to: text('c') }] };
    expect(validateValueMapping(chain).map(issue => issue.code)).toContain('mapping-non-idempotent');
    const direct: MapPropertyValuesOperation = { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [
      { id: 'a', from: text('a'), to: text('c') }, { id: 'b', from: text('b'), to: text('c') }] };
    expect(validateValueMapping(direct)).toEqual([]);
    const empty: MapPropertyValuesOperation = { kind: 'mapPropertyValues', key: 'status', mode: 'field', rules: [] };
    expect(validateValueMapping(empty).map(issue => issue.code)).toContain('input-invalid');
  });

  it('TC-M03: text assistant only proposes explicit trimmed/case rules and protects links', () => {
    const selected = [text('Done '), text('FINISHED'), text('[[Book A]]')];
    const trimLower = suggestTextMappings(selected, { trim: true, caseMode: 'lower' });
    expect(trimLower.rules.map(rule => [rule.from.value, rule.to.value])).toEqual([['Done ', 'done'], ['FINISHED', 'finished']]);
    expect(trimLower.linked.map(rule => rule.value)).toEqual(['[[Book A]]']);
  });

  it('analyzes a single file against a compiled table', () => {
    const compiled = compileValueMapping({ kind: 'mapPropertyValues', key: 'status', mode: 'member', rules: fieldRules() });
    const meta = fileMeta('n.md', 1, { frontmatter: { status: ['已读', 'done', '待读'] }, bodyTags: [] });
    const analysis = analyzeValueMapping(meta, { kind: 'mapPropertyValues', key: 'status', mode: 'member', rules: fieldRules() }, compiled);
    expect(analysis).toMatchObject({ outcome: 'ready', beforeType: 'list', afterType: 'list' });
    expect(analysis.candidate).toEqual(['done', '待读']);
  });
});
