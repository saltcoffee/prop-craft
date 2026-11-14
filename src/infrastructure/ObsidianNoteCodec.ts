import { parseDocument } from 'yaml';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from 'obsidian';
import { applyTextOps, deepEqual } from '../domain/plan';
import { isYamlValue } from '../domain/operation';
import { issueCode } from '../domain/errors';
import type { FileChange } from '../domain/models';
import type { DecodedNote, DecodedNoteResult, EncodedNoteResult, NoteCodecPort } from '../ports/NoteCodecPort';

export class ObsidianNoteCodec implements NoteCodecPort {
  decode(source: string): DecodedNoteResult {
    try {
      const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
      const text = source.slice(bom.length);
      const info = getFrontMatterInfo(text);
      // An unclosed YAML fence is never treated as a note without frontmatter.
      if (!info.exists && /^---[ \t]*(?:\r?\n|$)/.test(text)) return { ok: false, code: 'frontmatter-invalid' };
      const validation = info.exists ? parseDocument(info.frontmatter, { uniqueKeys: true }) : null;
      if (validation && (validation.errors.length || validation.warnings.length)) return { ok: false, code: 'frontmatter-invalid' };
      let independent: unknown = validation ? validation.toJS() : {};
      let parsed: unknown = info.exists ? parseYaml(info.frontmatter) : {};
      if (parsed === null && info.frontmatter.split(/\r?\n/).every(line => !line.trim() || line.trimStart().startsWith('#'))) { parsed = {}; independent = {}; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !isYamlValue(parsed) || !isYamlValue(independent) || !deepEqual(parsed, independent)) return { ok: false, code: 'frontmatter-invalid' };
      return { ok: true, note: { frontmatter: structuredClone(parsed as Record<string, unknown>), hasFrontmatter: info.exists,
        bodyStart: info.exists ? bom.length + info.contentStart : bom.length, bom, newline: source.includes('\r\n') ? '\r\n' : '\n' } };
    } catch { return { ok: false, code: 'frontmatter-invalid' }; }
  }
  compose(source: string, decoded: DecodedNote, change: FileChange): EncodedNoteResult {
    try {
      const ops = change.textOps;
      if (ops.some(op => op.start < decoded.bodyStart)) return { ok: false, code: 'metadata-stale' };
      let result = applyTextOps(source, ops);
      if (!deepEqual(change.beforeFrontmatter, change.afterFrontmatter)) {
        if (!isYamlValue(change.afterFrontmatter)) return { ok: false, code: 'frontmatter-invalid' };
        const yaml = stringifyYaml(change.afterFrontmatter).replace(/\r?\n/g, decoded.newline);
        const { newline } = decoded;
        const block = `---${newline}${yaml.endsWith(newline) ? yaml : yaml + newline}---${newline}`;
        result = decoded.bom + block + result.slice(decoded.bodyStart);
      }
      const verification = this.decode(result);
      if (!verification.ok || !deepEqual(verification.note.frontmatter, change.afterFrontmatter)) return { ok: false, code: 'frontmatter-invalid' };
      // Body edits are the only permitted changes outside YAML.
      if (result.slice(verification.note.bodyStart) !== applyTextOps(source, ops).slice(decoded.bodyStart)) return { ok: false, code: 'metadata-stale' };
      return { ok: true, content: result };
    } catch (error) {
      return { ok: false, code: issueCode(error, 'frontmatter-invalid') === 'metadata-stale' ? 'metadata-stale' : 'frontmatter-invalid' };
    }
  }
}
