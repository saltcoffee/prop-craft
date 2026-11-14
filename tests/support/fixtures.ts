import { readFileSync } from 'node:fs';
import type { MemoryVault } from './vault';
export interface FixtureNote { id: string; path: string; frontmatter: Record<string, unknown> | null; body: string; source?: string; pending?: boolean }
export const notes = JSON.parse(readFileSync(new URL('../fixtures/0.1.2/notes.json', import.meta.url), 'utf8')) as FixtureNote[];
export function seedFixtures(vault: MemoryVault): void {
  for (const note of notes) {
    if (note.source) vault.setText(note.path, note.source);
    else if (note.frontmatter === null) vault.setText(note.path, note.body);
    else vault.add(note.path, note.frontmatter, note.body);
    if (note.pending) vault.unavailableTags.add(note.path);
  }
}
