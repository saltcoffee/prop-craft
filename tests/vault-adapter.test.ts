import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { ObsidianVaultAdapter } from '../src/infrastructure/ObsidianVaultAdapter';

vi.mock('obsidian', () => ({ TFile: class TFile {}, TFolder: class TFolder {}, normalizePath: (path: string) => path }));

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
  it('observes markdown and folder changes until the dependency scan releases its listeners', () => {
    const listeners = new Map<string, (file: TFile | TFolder, oldPath?: string) => void>();
    const app = { vault: {
      on: (event: string, listener: (file: TFile | TFolder, oldPath?: string) => void) => { listeners.set(event, listener); return event; },
      offref: (event: string) => { listeners.delete(event); },
    } } as unknown as App;
    const changed = vi.fn(), release = new ObsidianVaultAdapter(app).watchMarkdownChanges(changed);
    const note = Object.assign(new TFile(), { extension: 'md' }), image = Object.assign(new TFile(), { extension: 'png' });
    for (const event of ['create', 'modify', 'delete', 'rename']) listeners.get(event)!(note);
    listeners.get('rename')!(image, 'Old.md'); listeners.get('rename')!(new TFolder());
    listeners.get('modify')!(image);
    expect(changed).toHaveBeenCalledTimes(6);
    release(); expect(listeners.size).toBe(0);
  });
});
