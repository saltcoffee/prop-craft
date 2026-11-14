import type { ChangeOperation, VaultSnapshot } from '../domain/models';
import type { ScopeResult } from '../domain/scope';
import type { Translate } from '../i18n';
import type PropCraftPlugin from '../main';
export type TabKey = 'overview' | 'properties' | 'tags' | 'bulk' | 'history';
export interface PageProps {
  plugin: PropCraftPlugin;
  snapshot: VaultSnapshot | null;
  scope: ScopeResult | null;
  canPreview: boolean;
  t: Translate;
  requestPreview: (operation: ChangeOperation) => Promise<void>;
  setTab: (tab: TabKey) => void;
}
