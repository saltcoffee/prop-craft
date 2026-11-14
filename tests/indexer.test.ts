import { describe, expect, it, vi } from 'vitest';
import { VaultIndexer } from '../src/application/VaultIndexer';
import { batchServices, deferred } from './support/vault';

describe('0.1.2 index lifecycle', () => {
  it('TC-X07: replays changes received during a full scan before publishing', async () => {
    const s = batchServices(); s.vault.add('a.md', { value: 'old' });
    const indexer = new VaultIndexer(s.vault, s.store, { getSettings: () => s.settings, getTypes: () => new Map() }, s.codec);
    const gate = deferred(), started = deferred(), read = s.vault.readText.bind(s.vault);
    vi.spyOn(s.vault, 'readText').mockImplementationOnce(async path => {
      const old = await read(path); started.resolve(); await gate.promise; return old;
    });
    const pending = indexer.rebuild(); await started.promise;
    s.vault.add('a.md', { value: 'new' }); indexer.onChanged('a.md'); gate.resolve(); await pending;
    expect(s.store.get()!.files.get('a.md')!.rawFrontmatter.value).toBe('new');
    indexer.stop();
  });
  it('TC-X07: replays deletes and renames without following an old path', async () => {
    const s = batchServices(); s.vault.add('a.md', { value: 'old' });
    const indexer = new VaultIndexer(s.vault, s.store, { getSettings: () => s.settings, getTypes: () => new Map() }, s.codec);
    const gate = deferred(), started = deferred(), read = s.vault.readText.bind(s.vault);
    vi.spyOn(s.vault, 'readText').mockImplementationOnce(async path => {
      const old = await read(path); started.resolve(); await gate.promise; return old;
    });
    const pending = indexer.rebuild(); await started.promise;
    s.vault.files.delete('a.md'); s.vault.add('Renamed.md', { value: 'new' });
    indexer.onRenamed('a.md', 'Renamed.md'); gate.resolve(); await pending;
    expect([...s.store.get()!.files.keys()]).toEqual(['Renamed.md']);
    indexer.stop();
  });
  it('TC-X07: older asynchronous updates cannot replace newer metadata', async () => {
    const s = batchServices(); s.vault.add('a.md', { value: 'original' });
    const indexer = new VaultIndexer(s.vault, s.store, { getSettings: () => s.settings, getTypes: () => new Map() }, s.codec);
    await indexer.rebuild();
    vi.useFakeTimers();
    try {
      const gate = deferred(), started = deferred(), read = s.vault.readText.bind(s.vault);
      vi.spyOn(s.vault, 'readText').mockImplementationOnce(async path => {
        const old = await read(path); started.resolve(); await gate.promise; return old;
      });
      indexer.onChanged('a.md'); await started.promise;
      s.vault.add('a.md', { value: 'new' }); indexer.onChanged('a.md');
      await vi.runAllTimersAsync(); gate.resolve(); await vi.runAllTimersAsync();
      expect(s.store.get()!.files.get('a.md')!.rawFrontmatter.value).toBe('new');
    } finally { indexer.stop(); vi.useRealTimers(); }
  });
  it('TC-X07: unloading stops an unfinished scan from publishing', async () => {
    const s = batchServices(); s.vault.add('a.md', { value: 'old' });
    const indexer = new VaultIndexer(s.vault, s.store, { getSettings: () => s.settings, getTypes: () => new Map() }, s.codec);
    const gate = deferred(), started = deferred(), read = s.vault.readText.bind(s.vault);
    vi.spyOn(s.vault, 'readText').mockImplementationOnce(async path => { started.resolve(); await gate.promise; return read(path); });
    const pending = indexer.rebuild(); await started.promise; indexer.stop(); gate.resolve(); await pending;
    expect(s.store.get()).toBeNull();
  });
});
