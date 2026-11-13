import type { VaultPort } from '../ports/VaultPort';

const TYPES_FILE = 'types.json';

function parseTypesFile(raw: string): { types: Record<string, unknown>; [key: string]: unknown } | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const types = (parsed as Record<string, unknown>).types;
  if (!types || typeof types !== 'object' || Array.isArray(types)) return null;
  return parsed as { types: Record<string, unknown>; [key: string]: unknown };
}

export class TypeMigration {
  private cached = new Map<string, string>();

  constructor(private readonly vault: VaultPort) {}

  /** Load Obsidian's property types (types.json). Missing or invalid files yield an empty map. */
  async load(): Promise<Map<string, string>> {
    try {
      const raw = await this.vault.readConfigFile(TYPES_FILE);
      if (!raw) {
        this.cached = new Map();
        return this.cached;
      }
      const parsed = parseTypesFile(raw);
      const map = new Map<string, string>();
      for (const [key, value] of Object.entries(parsed?.types ?? {})) {
        if (typeof value === 'string') map.set(key, value);
      }
      this.cached = map;
    } catch {
      this.cached = new Map();
    }
    return this.cached;
  }

  getCached(): Map<string, string> {
    return this.cached;
  }

  getPropertyType(key: string): string | null {
    return this.cached.get(key) ?? null;
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    oldKey = oldKey.toLowerCase();
    newKey = newKey.toLowerCase();
    if (oldKey === newKey) return;
    await this.mutate(types => {
      if (types[oldKey] === undefined) return false;
      types[newKey] = types[oldKey];
      delete types[oldKey];
      return true;
    });
  }

  async merge(from: string, to: string): Promise<void> {
    from = from.toLowerCase();
    to = to.toLowerCase();
    if (from === to) return;
    await this.mutate(types => {
      if (types[from] === undefined) return false;
      if (types[to] === undefined) types[to] = types[from];
      delete types[from];
      return true;
    });
  }

  private async mutate(change: (types: Record<string, unknown>) => boolean): Promise<void> {
    try {
      const raw = await this.vault.readConfigFile(TYPES_FILE);
      const data = raw ? parseTypesFile(raw) : null;
      if (!data || !change(data.types)) return;
      await this.vault.writeConfigFile(TYPES_FILE, `${JSON.stringify(data, null, 2)}\n`);
      await this.load();
    } catch {
      // Type migration is best-effort; failure must not block the main operation.
    }
  }
}
