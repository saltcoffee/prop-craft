import type { ChangePlan, VaultSnapshot } from '../domain/models';
import type { Translate } from '../i18n';
import type PropCraftPlugin from '../main';

export type TabKey = 'overview' | 'properties' | 'tags' | 'bulk' | 'history';

export interface PageProps {
  plugin: PropCraftPlugin;
  snapshot: VaultSnapshot | null;
  t: Translate;
  onPreview: (plan: ChangePlan) => void;
  setTab: (tab: TabKey) => void;
}
