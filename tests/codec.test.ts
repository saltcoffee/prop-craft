import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as obsidian from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { ObsidianNoteCodec } from '../src/infrastructure/ObsidianNoteCodec';
import { parseBodyTags } from '../src/infrastructure/MarkdownTags';
import { planAddProperty, planRenameProperty, planRenameTag, applyTextOps } from '../src/domain/plan';
import { diffForFile } from '../src/domain/diff';
import { MemoryVault } from './support/vault';
const codec = new ObsidianNoteCodec();
describe('0.1.2 note and tag codecs', () => {
  it.each(['\n', '\r\n'])('TC-X01: preserves body, BOM and %j newline through a full-text change', newline => {
    const vault = new MemoryVault(), source = '\ufeff' + ['---', 'source: "[[Book]]"', 'untouched:', '  nested: [0, false, "5"]', '---', 'Body #old', '', 'Tail', ''].join(newline);
    vault.setText('a.md', source); const decoded = codec.decode(source); expect(decoded.ok).toBe(true); if (!decoded.ok) return;
    const change = planRenameProperty(vault.meta('a.md'), 'source', 'target')!, encoded = codec.compose(source, decoded.note, change);
    expect(encoded.ok).toBe(true); if (!encoded.ok) return;
    expect(encoded.content.startsWith('\ufeff---' + newline)).toBe(true); expect(encoded.content.endsWith(['Body #old', '', 'Tail', ''].join(newline))).toBe(true);
    expect(codec.decode(encoded.content)).toMatchObject({ ok: true, note: { frontmatter: { target: '[[Book]]', untouched: { nested: [0, false, '5'] } } } });
  });
  it('TC-X01: creates frontmatter without changing a note body or BOM', () => {
    const vault = new MemoryVault(), source = '\ufeff#book\r\nBody\r\n'; vault.setText('a.md', source);
    const decoded = codec.decode(source); if (!decoded.ok) throw Error('decode');
    const change = planAddProperty(vault.meta('a.md'), 'status', 'unread', 'text', 'skip')!, result = codec.compose(source, decoded.note, change);
    expect(result.ok).toBe(true); if (result.ok) expect(result.content).toBe('\ufeff---\r\nstatus: unread\r\n---\r\n#book\r\nBody\r\n');
  });
  it.each(['---\n---\nBody', '---\n# comment\n---\nBody', 'Body'])('TC-X01: distinguishes valid empty YAML and no YAML: %j', source => { expect(codec.decode(source).ok).toBe(true); });
  it.each(['---\nx: [\n---\nBody', '---\na: 1\na: 2\n---\nBody', '---\n- list\n---\nBody', '---\nnull\n---\nBody', '---\nx: &cycle [*cycle]\n---\n', '---\nnot closed'])('TC-X02: blocks unsupported YAML: %j', source => { expect(codec.decode(source)).toEqual({ ok: false, code: 'frontmatter-invalid' }); });
  it('TC-X02: rejects duplicate keys even when a legacy host silently accepts them', () => {
    const host = vi.spyOn(obsidian, 'parseYaml').mockImplementation(source => parse(source, { uniqueKeys: false }));
    expect(codec.decode('---\na: 1\na: 2\n---\nBody')).toEqual({ ok: false, code: 'frontmatter-invalid' });
    host.mockRestore();
  });
  it('TC-X03: matches captured Obsidian 1.15.0 body tag offsets, including Unicode and syntax exclusions', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/0.1.2/host-1.15.0-syntax.json', import.meta.url), 'utf8')) as { source: string; tags: { tag: string; position: { start: { offset: number }; end: { offset: number } } }[] };
    expect(parseBodyTags(fixture.source, 0)).toEqual(fixture.tags.map(tag => ({ tag: tag.tag, start: tag.position.start.offset, end: tag.position.end.offset })));
  });
  it('TC-X03: matches broader native syntax, footnotes, escaped hashes and emoji boundaries', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/0.1.2/host-1.15.0-broad-tags.json', import.meta.url), 'utf8')) as { source: string; actual: { tag: string; start: number; end: number }[] };
    expect(parseBodyTags(fixture.source, 0)).toEqual(fixture.actual);
  });
  it('TC-E02: any invalid, overlapping or out-of-range text edit aborts the entire note', () => {
    for (const ops of [
      [{ start: 0, end: 4, expect: '#old', replacement: '#new' }, { start: 2, end: 4, expect: 'ld', replacement: 'x' }],
      [{ start: -1, end: 4, expect: '#old', replacement: '#new' }], [{ start: 0, end: 100, expect: '#old', replacement: '#new' }],
    ]) expect(() => applyTextOps('#old', ops)).toThrow('metadata-stale');
    const vault = new MemoryVault(), source = '---\ntags: [old]\n---\n#old'; vault.setText('a.md', source);
    const decoded = codec.decode(source); if (!decoded.ok) throw Error('decode');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!; change.textOps[0].expect = '#different';
    expect(codec.compose(source, decoded.note, change)).toEqual({ ok: false, code: 'metadata-stale' });
  });
  it('TC-X04: adding a prototype-like key cannot mutate Object.prototype', () => {
    const vault = new MemoryVault(); vault.add('a.md', { keep: false }); const source = vault.files.get('a.md')!.content, decoded = codec.decode(source); if (!decoded.ok) throw Error('decode');
    const change = planAddProperty(vault.meta('a.md'), '__proto__', 'safe', 'text', 'skip')!, result = codec.compose(source, decoded.note, change);
    expect(result.ok).toBe(true); expect(Object.getPrototypeOf(change.afterFrontmatter)).toBeNull(); expect(Object.hasOwn({}, 'safe')).toBe(false);
    if (result.ok) expect(codec.decode(result.content)).toMatchObject({ ok: true, note: { frontmatter: { keep: false } } });
  });
  it('TC-X05: rewrites both tag and tags and preserves non-target data', () => {
    const vault = new MemoryVault(); vault.add('a.md', { tags: ['Old', 'other', 7], tag: 'old, keep' }, '#OLD #deep_work #deep-work');
    const source = vault.files.get('a.md')!.content, decoded = codec.decode(source); if (!decoded.ok) throw Error('decode');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!, result = codec.compose(source, decoded.note, change);
    expect(change.afterFrontmatter).toEqual({ tags: ['new', 'other', 7], tag: 'new, keep' });
    expect(result.ok).toBe(true); if (result.ok) expect(result.content).toContain('#new #deep_work #deep-work');
  });
  it('TC-X04: differences expose a text/number change even with identical displayed characters', () => {
    const vault = new MemoryVault(); vault.add('a.md', { year: '5' });
    const change = planAddProperty(vault.meta('a.md'), 'year', 5, 'number', 'overwrite')!, diff = diffForFile(change);
    expect(diff).toHaveLength(1); expect(diff[0].before).toContain('string'); expect(diff[0].after).toContain('number');
  });
});
