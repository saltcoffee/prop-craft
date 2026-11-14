import type { FileChange } from '../domain/models';
export interface DecodedNote {
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
  bodyStart: number;
  bom: string;
  newline: '\n' | '\r\n';
}
export type DecodedNoteResult = { ok: true; note: DecodedNote } | { ok: false; code: 'frontmatter-invalid' };
export type EncodedNoteResult = { ok: true; content: string } | { ok: false; code: 'frontmatter-invalid' | 'metadata-stale' };
export interface NoteCodecPort {
  decode(source: string): DecodedNoteResult;
  compose(source: string, decoded: DecodedNote, change: FileChange): EncodedNoteResult;
}
