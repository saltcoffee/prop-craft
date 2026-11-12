import type { VaultPort } from '../ports/VaultPort';

const TYPES_FILE = 'types.json';

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
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const map = new Map<string, string>();
      for (const [key, value] of Object.entries(parsed)) {
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
    await this.mutate(types => {
      if (types[oldKey] === undefined) return false;
      types[newKey] = types[oldKey];
      delete types[oldKey];
      return true;
    });
  }

  async merge(from: string, to: string): Promise<void> {
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
      const types = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (!change(types)) return;
      await this.vault.writeConfigFile(TYPES_FILE, `${JSON.stringify(types, null, 2)}\n`);
      await this.load();
    } catch {
      // Type migration is best-effort; failure must not block the main operation.
    }
  }
}
