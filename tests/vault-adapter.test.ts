import { describe, expect, it, vi } from 'vitest';
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { ObsidianVaultAdapter } from '../src/infrastructure/ObsidianVaultAdapter';

vi.mock('obsidian', () => ({ TFile: class TFile {}, normalizePath: (path: string) => path }));

describe('vault content used for edits', () => {
  it('reads the live file instead of a cached display version', async () => {
    const file = new TFile();
    const app = {
      vault: {
        getAbstractFileByPath: () => file,
        read: async () => 'Current user content',
        cachedRead: async () => 'Outdated cached content',
      },
    } as unknown as App;
    expect(await new ObsidianVaultAdapter(app).readText('a.md')).toBe('Current user content');
  });
});
