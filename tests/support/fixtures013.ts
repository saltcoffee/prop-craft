import type { MemoryVault } from './vault';

/** Deterministic 0.1.3 fixture vault mirroring docs 07 §2 (F01–F24). */
export interface FixtureVariant { path: string; frontmatter: Record<string, unknown> | null; body?: string; source?: string }

const BODY = 'Just body text. status: 已读 is written literally here.\n';

export const notes013: FixtureVariant[] = [
  { path: 'Books/A.md', frontmatter: { status: '已读', rating: '5', author: '甲', readAt: '2024/1/5' } },
  { path: 'Books/B.md', frontmatter: { status: 'finished', rating: 5, author: ['甲', '乙'], readAt: '2024-01-05' } },
  { path: 'Books/C.md', frontmatter: { status: 'Done ', rating: '005', author: '甲; 乙;;甲', readAt: '01/02/2024' } },
  { path: 'Books/D.md', frontmatter: { status: 'done', rating: '约5分', author: '[[Book A|甲;乙]]', readAt: '2024-01-05T12:30:45' } },
  { path: 'Books/E.md', frontmatter: { rating: '' } },
  { path: 'Books/F.md', frontmatter: { status: null, rating: '9007199254740993' } },
  { path: 'Books/G.md', frontmatter: { status: '', rating: '1.0000000000000001' } },
  { path: 'Books/H.md', frontmatter: { status: [], rating: ' 5 ' } },
  { path: 'Books/I.md', frontmatter: { status: ' ', rating: '+5' } },
  { path: 'Books/J.md', frontmatter: { status: 0, rating: '-2.5' } },
  { path: 'Books/K.md', frontmatter: { status: false, rating: '1,000' } },
  { path: 'Books/L.md', frontmatter: { status: '5', rating: '1e3' } },
  { path: 'Books/M.md', frontmatter: { status: 5, rating: '0.1' } },
  { path: 'Books/N.md', frontmatter: { status: ['已读', 'done', '待读'] } },
  { path: 'Books/O.md', frontmatter: { status: ['done', 'done', '待读'] } },
  { path: 'Books/P.md', frontmatter: { status: ['finished', 'finished', '待读'] } },
  { path: 'Books/Q.md', frontmatter: { status: ['5', 5, '[[Book A]]'] } },
  { path: 'Books/R.md', frontmatter: { status: { phase: 'done' } } },
  { path: 'Books/S.md', frontmatter: null, source: `Plain note without frontmatter.\n${BODY}` },
  { path: 'Books/Broken.md', frontmatter: null, source: '---\nstatus: [\n---\nbody\n' },
  { path: 'Books/Templates/T.md', frontmatter: { status: '已读' } },
  { path: 'Projects/U.md', frontmatter: { status: '已读' } },
  { path: 'Bookshelf/V.md', frontmatter: { status: '已读' } },
  { path: 'Books/Sub/W.md', frontmatter: { status: 'finished' } },
];

export function seedV013(vault: MemoryVault): void {
  for (const note of notes013) {
    if (note.source) vault.setText(note.path, note.source);
    else vault.add(note.path, note.frontmatter ?? {}, note.body ?? BODY);
  }
}

export const scope013 = {
  base: { kind: 'folder' as const, path: 'Books', includeSubfolders: true },
  conditions: [],
  manuallyExcludedPaths: ['Books/Sub/W.md'],
};
