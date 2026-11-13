import { describe, expect, it, vi } from 'vitest';
import { TypeMigration } from '../src/application/TypeMigration';
import { extractFileMeta } from '../src/application/VaultIndexer';
import { MemoryVault } from './support/vault';

describe('Obsidian property types', () => {
  it('loads nested native types and maps multitext to the list view type', async () => {
    const vault = new MemoryVault();
    vault.config.set('types.json', JSON.stringify({ types: { published: 'date', topics: 'multitext', invalid: 42 } }));
    const migration = new TypeMigration(vault);
    const types = await migration.load();
    expect([...types]).toEqual([['published', 'date'], ['topics', 'multitext']]);
    vault.add('a.md', { published: '2024-01-05', topics: null });
    const meta = extractFileMeta(vault, 'a.md', types);
    expect(meta.properties.published!.type).toBe('date');
    expect(meta.properties.topics!.type).toBe('list');
  });

  it('renames within types and preserves other configuration', async () => {
    const vault = new MemoryVault();
    vault.config.set('types.json', JSON.stringify({ types: { published: 'date', topics: 'multitext' }, extra: { setting: true } }));
    const migration = new TypeMigration(vault);
    await migration.rename('Published', 'Created');
    expect(JSON.parse(vault.config.get('types.json')!)).toEqual({ types: { created: 'date', topics: 'multitext' }, extra: { setting: true } });
    expect(migration.getPropertyType('created')).toBe('date');
    expect(migration.getPropertyType('published')).toBeNull();
  });

  it('preserves an existing destination type while merging', async () => {
    const vault = new MemoryVault();
    vault.config.set('types.json', JSON.stringify({ types: { source: 'date', target: 'text', topics: 'multitext' } }));
    const migration = new TypeMigration(vault);
    await migration.merge('Source', 'Target');
    expect(JSON.parse(vault.config.get('types.json')!)).toEqual({ types: { target: 'text', topics: 'multitext' } });
  });

  it('copies the source type when the merge destination has no type', async () => {
    const vault = new MemoryVault();
    vault.config.set('types.json', JSON.stringify({ types: { source: 'date' } }));
    const migration = new TypeMigration(vault);
    await migration.merge('source', 'target');
    expect(JSON.parse(vault.config.get('types.json')!)).toEqual({ types: { target: 'date' } });
  });

  it.each(['rename', 'merge'] as const)('preserves the type for case-only %s operations', async kind => {
    const vault = new MemoryVault();
    vault.config.set('types.json', JSON.stringify({ types: { published: 'date' } }));
    const migration = new TypeMigration(vault);
    await migration[kind]('Published', 'published');
    expect(JSON.parse(vault.config.get('types.json')!)).toEqual({ types: { published: 'date' } });
  });

  it.each(['null', '[]', '{}', '{"types":[]}', '{"types":null}', 'invalid JSON'])('leaves invalid configuration unchanged: %s', async raw => {
    const vault = new MemoryVault();
    vault.config.set('types.json', raw);
    const write = vi.spyOn(vault, 'writeConfigFile');
    const migration = new TypeMigration(vault);
    expect((await migration.load()).size).toBe(0);
    await migration.rename('source', 'target');
    expect(write).not.toHaveBeenCalled();
    expect(vault.config.get('types.json')).toBe(raw);
  });
});
