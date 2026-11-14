import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChangeOperation } from '../domain/models';
import type { PreviewDecisionPatch, PreviewView } from '../domain/preview';
import { allNotesScope, type ScopeQuery, type ScopeResult } from '../domain/scope';
import { OperationError, issueCode, type IssueCode } from '../domain/errors';
import { exclusionFingerprint } from '../application/exclude';
import type { TextKey } from '../i18n';
import type PropCraftPlugin from '../main';
import { PreviewDrawer } from './components/PreviewDrawer';
import { ScopeBar } from './components/ScopeBar';
import { OperationPanel } from './components/OperationPanel';
import { Overview } from './pages/Overview';
import { PropertyGrid } from './pages/PropertyGrid';
import { TagGrid } from './pages/TagGrid';
import { BulkWizard } from './pages/BulkWizard';
import { History } from './pages/History';
import type { PageProps, TabKey } from './types';
import { issueText } from './text';
const TABS: TabKey[] = ['overview', 'properties', 'tags', 'bulk', 'history'];
const TAB_LABEL: Record<TabKey, TextKey> = { overview: 'tab.overview', properties: 'tab.properties', tags: 'tab.tags', bulk: 'tab.bulk', history: 'tab.history' };

export function App({ plugin }: { plugin: PropCraftPlugin }) {
  const t = plugin.t;
  const [, renderNotification] = useState(0);
  const [snapshot, setSnapshot] = useState(plugin.store.get()), [status, setStatus] = useState(plugin.store.status());
  const [tab, setTab] = useState<TabKey>('overview'), [query, setQuery] = useState<ScopeQuery>(allNotesScope);
  const [scope, setScope] = useState<ScopeResult | null>(null), [scopeBusy, setScopeBusy] = useState(true), [scopeError, setScopeError] = useState<IssueCode>();
  const [preview, setPreview] = useState<PreviewView | null>(null), [previewBusy, setPreviewBusy] = useState(false);
  const [operation, setOperation] = useState(plugin.coordinator.getState()), [error, setError] = useState<IssueCode>();
  const mounted = useRef(true);
  const previewRef = useRef(preview), action = useRef(false), createRequest = useRef(0), previewAbort = useRef<AbortController | null>(null);
  previewRef.current = preview;
  const ready = Boolean(scope && snapshot && scope.queryFingerprint === JSON.stringify(query) && scope.snapshotRevision === snapshot.revision && scope.settingsFingerprint === exclusionFingerprint(plugin.settings) && status === 'ready' && !scopeBusy && !scopeError);
  const current = useRef({ query, ready }); current.current = { query, ready };
  const fingerprint = exclusionFingerprint(plugin.settings);
  const lastValidity = useRef('');
  useEffect(() => {
    mounted.current = true;
    const unsub = plugin.store.subscribe(() => { setSnapshot(plugin.store.get()); setStatus(plugin.store.status()); renderNotification(value => value + 1); });
    const unsubOperations = plugin.coordinator.subscribe(setOperation);
    return () => { mounted.current = false; unsub(); unsubOperations(); previewAbort.current?.abort(); if (previewRef.current) plugin.planner.discard(previewRef.current.id); };
  }, [plugin]);
  useEffect(() => {
    const abort = new AbortController();
    setScopeBusy(true); setScopeError(undefined);
    const timer = setTimeout(() => {
      if (!snapshot || status !== 'ready') return;
      void plugin.scopeService.evaluate(query, snapshot, { requestId: snapshot.revision, signal: abort.signal }).then(result => {
        if (!abort.signal.aborted) { setScope(result); setScopeBusy(false); }
      }).catch(error => { if (!abort.signal.aborted) { setScopeError(issueCode(error, 'scope-invalid')); setScopeBusy(false); } });
    }, 100);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [query, snapshot, status, fingerprint, plugin]);
  const scopedSnapshot = useMemo(() => snapshot && scope ? plugin.scopeService.aggregate(snapshot, scope) : null, [snapshot, scope, plugin]);
  const fail = (error: unknown) => { const code = issueCode(error, 'journal-unavailable'); setError(code); plugin.notify(issueText(t, code)); };
  const changeScope = (next: ScopeQuery) => {
    previewAbort.current?.abort(); createRequest.current++;
    if (previewRef.current) plugin.planner.discard(previewRef.current.id);
    previewRef.current = null; setPreview(null); setPreviewBusy(false);
    current.current = { query: next, ready: false }; setQuery(next);
  };
  const requestPreview = async (intent: ChangeOperation) => {
    if (!current.current.ready || plugin.coordinator.isBusy()) { fail(new OperationError('scope-invalid')); return; }
    previewAbort.current?.abort(); const abort = new AbortController(); previewAbort.current = abort;
    const request = ++createRequest.current; setPreviewBusy(true); setError(undefined);
    try {
      const view = await plugin.planner.createPreview({ operation: intent, scope: current.current.query }, abort.signal);
      if (abort.signal.aborted || request !== createRequest.current) { plugin.planner.discard(view.id); return; }
      if (previewRef.current) plugin.planner.discard(previewRef.current.id);
      setPreview(view);
    } catch (error) { if (!abort.signal.aborted) fail(error); }
    finally { if (request === createRequest.current) setPreviewBusy(false); }
  };
  useEffect(() => {
    if (!preview || previewBusy || action.current) return;
    const key = `${preview.id}:${snapshot?.revision}:${fingerprint}`;
    if (lastValidity.current === key) return;
    lastValidity.current = key;
    action.current = true; setPreviewBusy(true);
    void plugin.planner.refreshValidity(preview.id, preview.revision).then(view => setPreview(view)).catch(fail).finally(() => { action.current = false; setPreviewBusy(false); });
  }, [preview?.id, snapshot?.revision, fingerprint, previewBusy]);
  const revise = async (patches: readonly PreviewDecisionPatch[]) => {
    if (action.current || !previewRef.current) return;
    action.current = true; setPreviewBusy(true);
    try { const view = previewRef.current; setPreview(await plugin.planner.revisePreview(view.id, view.revision, patches)); }
    catch (error) { fail(error); }
    finally { action.current = false; setPreviewBusy(false); }
  };
  const rebuild = async (staleOnly = false) => {
    if (action.current || !previewRef.current) return;
    action.current = true; setPreviewBusy(true);
    const id = previewRef.current.id;
    previewAbort.current?.abort(); const abort = new AbortController(); previewAbort.current = abort;
    try { const view = await plugin.planner.recreate(id, staleOnly, abort.signal); plugin.planner.discard(id); if (mounted.current) setPreview(view); else plugin.planner.discard(view.id); }
    catch (error) { if (!abort.signal.aborted) fail(error); }
    finally { action.current = false; setPreviewBusy(false); }
  };
  const apply = async () => {
    const view = previewRef.current;
    if (action.current || !view) return;
    action.current = true; setPreview(null);
    try { await plugin.coordinator.apply(view.id, view.revision); }
    catch (error) { fail(error); }
    finally { action.current = false; }
  };
  const pageProps: PageProps = { plugin, snapshot: tab === 'overview' || tab === 'history' ? snapshot : scopedSnapshot, scope, canPreview: ready && !previewBusy && !plugin.coordinator.isBusy(), t, requestPreview, setTab };
  return <div class="propcraft">
    <div class="propcraft-topbar"><div class="propcraft-tabs">{TABS.map(key => <button key={key} class={`propcraft-tab ${tab === key ? 'is-active' : ''}`} onClick={() => setTab(key)}>{t(TAB_LABEL[key])}</button>)}</div>
      <div class="propcraft-topbar-actions"><span class="propcraft-status">{status === 'indexing' ? t('overview.indexing') : status === 'stale' ? t('overview.stale') : t('overview.ready')}</span><button class="propcraft-btn" onClick={() => plugin.reindex()}>{t('overview.reindex')}</button></div></div>
    {operation.kind === 'recovery-required' ? <div class="propcraft-warn" role="status">{t('execute.required')} <button class="propcraft-link" onClick={() => setTab('history')}>{t('tab.history')}</button></div> : null}
    {error ? <div class="propcraft-warn" role="alert">{issueText(t, error)} <button class="propcraft-link" onClick={() => setTab('history')}>{t('tab.history')}</button><button class="propcraft-link" onClick={() => plugin.openSettings()}>{t('journal.capacity.settings')}</button><button class="propcraft-link" onClick={() => setError(undefined)}>{t('common.close')}</button></div> : null}
    {tab !== 'overview' && tab !== 'history' ? <ScopeBar query={query} result={scope} snapshot={snapshot} busy={!ready && !scopeError} error={scopeError} onChange={changeScope} plugin={plugin} t={t} /> : null}
    {previewBusy && !preview ? <div role="status">{t('preview.updating')}</div> : null}
    <div class="propcraft-main">
      {tab === 'overview' ? <Overview {...pageProps} /> : null}{tab === 'properties' ? <PropertyGrid {...pageProps} /> : null}{tab === 'tags' ? <TagGrid {...pageProps} /> : null}{tab === 'bulk' ? <BulkWizard {...pageProps} /> : null}{tab === 'history' ? <History {...pageProps} /> : null}
    </div>
    {preview ? <PreviewDrawer plan={preview} t={t} plugin={plugin} busy={previewBusy} dataUpdated={preview.snapshotRevision !== snapshot?.revision} onRevise={patches => void revise(patches)} onApply={() => void apply()} onCancel={() => { plugin.planner.discard(preview.id); setPreview(null); }} onRebuild={onlyStale => void rebuild(onlyStale)} /> : null}
    <OperationPanel key={operation.kind === 'result' || operation.kind === 'recovery-result' ? operation.result.transactionId : operation.kind} state={operation} plugin={plugin} t={t} onPreview={view => { if (mounted.current) setPreview(view); else plugin.planner.discard(view.id); }} />
  </div>;
}
