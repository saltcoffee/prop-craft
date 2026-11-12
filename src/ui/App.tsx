import { useEffect, useState } from 'preact/hooks';
import type { ChangePlan, ExecutionResult } from '../domain/models';
import type { TextKey } from '../i18n';
import type PropCraftPlugin from '../main';
import { PreviewDrawer } from './components/PreviewDrawer';
import { Overview } from './pages/Overview';
import { PropertyGrid } from './pages/PropertyGrid';
import { TagGrid } from './pages/TagGrid';
import { BulkWizard } from './pages/BulkWizard';
import { History } from './pages/History';
import type { PageProps, TabKey } from './types';

const TABS: TabKey[] = ['overview', 'properties', 'tags', 'bulk', 'history'];
const TAB_LABEL: Record<TabKey, TextKey> = {
  overview: 'tab.overview',
  properties: 'tab.properties',
  tags: 'tab.tags',
  bulk: 'tab.bulk',
  history: 'tab.history',
};

export function App({ plugin }: { plugin: PropCraftPlugin }) {
  const t = plugin.t;
  const [snapshot, setSnapshot] = useState(plugin.store.get());
  const [status, setStatus] = useState(plugin.store.status());
  const [tab, setTab] = useState<TabKey>('overview');
  const [preview, setPreview] = useState<ChangePlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  useEffect(() => {
    const unsubscribe = plugin.store.subscribe(() => {
      setSnapshot(plugin.store.get());
      setStatus(plugin.store.status());
    });
    return unsubscribe;
  }, [plugin]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (preview) setPreview(null);
      else if (result) setResult(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, result]);

  const pageProps: PageProps = { plugin, snapshot, t, onPreview: setPreview, setTab };

  const apply = async (plan: ChangePlan): Promise<void> => {
    setPreview(null);
    if (plan.fileChanges.length === 0) {
      plugin.notify(t('notice.nothingToApply'));
      return;
    }
    setProgress({ done: 0, total: plan.fileChanges.length });
    try {
      const execution = await plugin.executePlan(plan, (done, total) => setProgress({ done, total }));
      setResult(execution);
      if (execution.failed.length > 0) plugin.notify(t('notice.failed', { count: execution.failed.length }));
      else if (!execution.cancelled) plugin.notify(t('notice.applied', { count: execution.succeeded.length }));
    } catch (error) {
      plugin.notify(error instanceof Error ? error.message : String(error));
    } finally {
      setProgress(null);
    }
  };

  const undo = async (transactionId: string): Promise<void> => {
    try {
      const undoResult = await plugin.undo(transactionId);
      plugin.notify(t('notice.undone', { count: undoResult.restored.length }));
      setResult(null);
    } catch (error) {
      plugin.notify(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div class="propcraft">
      <div class="propcraft-topbar">
        <div class="propcraft-tabs">
          {TABS.map(key => (
            <button
              key={key}
              class={`propcraft-tab ${tab === key ? 'is-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {t(TAB_LABEL[key])}
            </button>
          ))}
        </div>
        <div class="propcraft-topbar-actions">
          <span class="propcraft-status">{status === 'indexing' ? t('overview.indexing') : status === 'stale' ? t('overview.stale') : t('overview.ready')}</span>
          <button class="propcraft-btn" onClick={() => plugin.reindex()}>{t('overview.reindex')}</button>
        </div>
      </div>

      <div class="propcraft-main">
        {tab === 'overview' ? <Overview {...pageProps} /> : null}
        {tab === 'properties' ? <PropertyGrid {...pageProps} /> : null}
        {tab === 'tags' ? <TagGrid {...pageProps} /> : null}
        {tab === 'bulk' ? <BulkWizard {...pageProps} /> : null}
        {tab === 'history' ? <History {...pageProps} /> : null}
      </div>

      {preview ? <PreviewDrawer plan={preview} t={t} onApply={() => void apply(preview)} onCancel={() => setPreview(null)} /> : null}

      {progress ? (
        <div class="propcraft-overlay">
          <div class="propcraft-dialog">
            <div class="propcraft-progress-title">{t('execute.running', { done: progress.done, total: progress.total })}</div>
            <div class="propcraft-progress-track"><div class="propcraft-progress-bar" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} /></div>
            <div class="propcraft-dialog-actions">
              <button class="propcraft-btn" onClick={() => plugin.cancelExecution()}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <div class="propcraft-overlay">
          <div class="propcraft-dialog">
            <div class="propcraft-progress-title">
              {result.cancelled
                ? t('execute.cancelled')
                : result.failed.length > 0
                  ? t('execute.partial', { failed: result.failed.length })
                  : t('execute.done', { count: result.succeeded.length })}
            </div>
            {result.failed.length > 0 ? (
              <div class="propcraft-failed">
                <div class="propcraft-muted">{t('execute.failedList')}</div>
                <ul>
                  {result.failed.slice(0, 20).map(item => <li key={item.path}>{item.path} — {item.error}</li>)}
                </ul>
              </div>
            ) : null}
            <div class="propcraft-dialog-actions">
              <button class="propcraft-btn" onClick={() => void undo(result.transactionId)}>{t('execute.undo')}</button>
              <button class="propcraft-btn mod-cta" onClick={() => setResult(null)}>{t('execute.close')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
