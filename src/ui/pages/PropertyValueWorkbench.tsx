import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { VaultSnapshot } from '../../domain/models';
import type { ScopeResult } from '../../domain/scope';
import type { ChangeOperation } from '../../domain/models';
import type { PropertyValueDistribution } from '../../domain/value-distribution';
import { scalarFromRaw, type EmptyState, type ValueScalar } from '../../domain/property-value';
import { issueCode, type IssueCode } from '../../domain/errors';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { issueText } from '../text';
import { displayValue } from '../value-format';
import { ValueMappingEditor } from '../components/ValueMappingEditor';
import { ValueConversionEditor } from '../components/ValueConversionEditor';
import { ValueNoteList } from '../components/ValueNoteList';

const PAGE = 100;
const STATE_ROWS: readonly EmptyState[] = ['missing', 'null', 'empty-text', 'empty-list'];
const TYPE_OPTIONS = ['text', 'number', 'boolean', 'list', 'null', 'object'] as const;

interface Drilldown { title: string; paths: readonly string[] }

export function PropertyValueWorkbench({ plugin, snapshot, scope, keyName, t, canPreview, requestPreview, onBack }: {
  plugin: PropCraftPlugin; snapshot: VaultSnapshot | null; scope: ScopeResult | null; keyName: string;
  t: Translate; canPreview: boolean; requestPreview: (operation: ChangeOperation) => Promise<void>; onBack: () => void;
}) {
  const [mode, setMode] = useState<'field' | 'member'>('field');
  const [distribution, setDistribution] = useState<PropertyValueDistribution | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<IssueCode>();
  const [search, setSearch] = useState(''), [typeFilter, setTypeFilter] = useState<string>('all'), [limit, setLimit] = useState(PAGE);
  const [selection, setSelection] = useState({ ids: new Set<string>(), removedCount: 0 });
  const selected = selection.ids;
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null);
  const [editor, setEditor] = useState<'map' | 'convert' | null>(null), [fillOnly, setFillOnly] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef(0), abort = useRef<AbortController | null>(null);
  const revision = snapshot?.revision, fingerprint = scope?.queryFingerprint, settingsFingerprint = scope?.settingsFingerprint;

  useEffect(() => {
    setSelection({ ids: new Set(), removedCount: 0 }); setEditor(null); setDrilldown(null);
  }, [keyName, mode, fingerprint, settingsFingerprint]);

  useEffect(() => {
    if (!snapshot || !scope || snapshot.revision !== scope.snapshotRevision) return;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const id = ++request.current;
    setLoading(true); setError(undefined);
    plugin.valueService.analyze(snapshot, scope, { key: keyName, mode }, { requestId: id, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted || id !== request.current) return;
        const available = new Set(result.buckets.map(bucket => bucket.id));
        setDistribution(result);
        setSelection(current => {
          const ids = new Set([...current.ids].filter(value => available.has(value)));
          return { ids, removedCount: current.ids.size - ids.size };
        });
        setLoading(false);
      })
      .catch(err => { if (!controller.signal.aborted && id === request.current) { setError(issueCode(err, 'metadata-stale')); setLoading(false); } });
    return () => controller.abort();
  }, [plugin, snapshot, scope, keyName, mode, revision, fingerprint, settingsFingerprint, reload]);

  const visible = useMemo(() => {
    if (!distribution) return [];
    const needle = search.trim().toLowerCase();
    return distribution.buckets.filter(bucket => {
      if (typeFilter !== 'all' && bucket.actualType !== typeFilter) return false;
      if (!needle) return true;
      return displayValue(bucket.raw).toLowerCase().includes(needle);
    });
  }, [distribution, search, typeFilter]);

  const selectedScalars: ValueScalar[] = useMemo(() => {
    if (!distribution) return [];
    return distribution.buckets.filter(bucket => selected.has(bucket.id)).flatMap(bucket => {
      const scalar = scalarFromRaw(bucket.raw);
      if (!scalar) return [];
      if (mode === 'field' && scalar.type === 'text' && scalar.value === '') return [];
      return [scalar];
    });
  }, [distribution, selected, mode]);

  const selectedPaths = (ids: readonly string[]): string[] => {
    if (!distribution) return [];
    return distribution.buckets.filter(bucket => ids.includes(bucket.id)).flatMap(bucket => bucket.notePaths);
  };
  const toggle = (id: string) => setSelection(current => { const ids = new Set(current.ids); if (ids.has(id)) ids.delete(id); else ids.add(id); return { ids, removedCount: 0 }; });
  const scopeLabel = !scope ? '' : scope.summary.base.kind === 'all' ? t('scope.all') : `${scope.summary.base.path}/ · ${scope.summary.effective}`;
  const declaration = distribution?.declaration;
  const declarationText = !declaration ? '' : declaration.kind === 'known'
    ? t('values.declaration', { value: `${declaration.type} (${t('values.declaration.vault')})` })
    : declaration.kind === 'absent' ? t('values.declaration', { value: t('values.declaration.absent') })
      : t('values.declaration.unavailable');

  const startMap = (onlyFill: boolean) => { setFillOnly(onlyFill); setEditor('map'); };
  const generate = (operation: ChangeOperation) => { setEditor(null); void requestPreview(operation); };

  const header = <div>
    <button class="propcraft-link" onClick={onBack}>← {t('values.back')}</button>
    <h2 class="propcraft-page-title">{t('values.title', { key: keyName })}</h2>
    <div class="propcraft-muted">{scopeLabel}</div>
    {declarationText ? <div class="propcraft-muted">{declarationText}</div> : null}
    {distribution ? <div class="propcraft-muted">{t('values.counts', {
      counted: distribution.countedNoteCount, missing: distribution.states.missing.length,
      unreadable: distribution.unreadablePaths.length, unknown: distribution.scopeUnknownPaths.length,
    })}</div> : null}
    <div class="propcraft-toolbar">
      <button class={`propcraft-btn ${mode === 'field' ? 'mod-cta' : ''}`} onClick={() => setMode('field')}>{t('values.mode.field')}</button>
      <button class={`propcraft-btn ${mode === 'member' ? 'mod-cta' : ''}`} onClick={() => setMode('member')}>{t('values.mode.member')}</button>
      <button class="propcraft-btn" onClick={() => { setLimit(PAGE); setReload(value => value + 1); }}>{t('values.refresh')}</button>
    </div>
  </div>;

  const memberSummary = mode === 'member' && distribution
    ? <div class="propcraft-muted">{t('values.member.summary', { list: distribution.listNoteCount, empty: distribution.states['empty-list'].length, nonList: distribution.nonListPresentNoteCount })}</div>
    : null;

  const body = loading && !distribution ? <div role="status">{t('values.loading')}</div>
    : error ? <div class="propcraft-warn" role="alert">{issueText(t, error)}</div>
      : !distribution ? null
        : distribution.countedNoteCount === 0 && distribution.unreadablePaths.length === 0 ? <div class="propcraft-empty">{t('values.empty')}</div>
          : <div>
            <div class="propcraft-toolbar">
              <input class="propcraft-input" placeholder={t('values.search')} value={search} onInput={event => { setSearch(event.currentTarget.value); setLimit(PAGE); }} />
              <select class="propcraft-input" value={typeFilter} onChange={event => { setTypeFilter(event.currentTarget.value); setLimit(PAGE); }}>
                <option value="all">{t('values.type.all')}</option>
                {TYPE_OPTIONS.map(type => <option value={type} key={type}>{type}</option>)}
              </select>
              <button class="propcraft-btn" disabled={!visible.length} onClick={() => setSelection({ ids: new Set([...selected, ...visible.map(bucket => bucket.id)]), removedCount: 0 })}>{t('values.selectVisible', { count: visible.length })}</button>
              <button class="propcraft-btn" disabled={!selected.size} onClick={() => setSelection({ ids: new Set(), removedCount: 0 })}>{t('values.clearSelection')}</button>
            </div>
            {visible.length === 0 ? <div class="propcraft-empty">{t('values.noMatch')}</div> : <div class="propcraft-table-wrap"><table class="propcraft-table"><thead><tr>
              <th scope="col">{t('values.col.select')}</th><th scope="col">{t('values.col.value')}</th><th scope="col">{t('values.col.type')}</th><th scope="col" class="num">{t('values.col.notes')}</th><th scope="col">{t('values.col.open')}</th>
            </tr></thead><tbody>{visible.slice(0, limit).map(bucket => <tr key={bucket.id}>
              <td><input type="checkbox" checked={selected.has(bucket.id)} onChange={() => toggle(bucket.id)} /></td>
              <td class="propcraft-path">{displayValue(bucket.raw)}</td>
              <td>{bucket.actualType}</td>
              <td class="num"><button class="propcraft-link" onClick={() => setDrilldown({ title: t('values.note.title', { value: displayValue(bucket.raw) }), paths: bucket.notePaths })}>{bucket.notePaths.length}</button></td>
              <td>{bucket.notePaths[0] ? <button class="propcraft-link" onClick={() => void plugin.openNote(bucket.notePaths[0])}>{t('values.note.open')}</button> : null}</td>
            </tr>)}</tbody></table></div>}
            {visible.length > limit ? <button class="propcraft-btn" onClick={() => setLimit(limit + PAGE)}>{t('preview.more')}</button> : null}

            {mode === 'field' ? <div class="propcraft-group">
              <div class="propcraft-section-title">{t('values.states.title')}</div>
              {STATE_ROWS.map(state => <div class="propcraft-field" key={state}><span>{t(`values.state.${state}`)}: {distribution.states[state].length}</span>
                {distribution.states[state].length ? <button class="propcraft-link" onClick={() => setDrilldown({ title: t('values.states.title'), paths: distribution.states[state] })}>{t('values.open', { count: distribution.states[state].length })}</button> : null}</div>)}
              {distribution.states.whitespace.length ? <div class="propcraft-field"><span>{t('values.state.whitespace')}: {distribution.states.whitespace.length}</span><button class="propcraft-link" onClick={() => setDrilldown({ title: t('values.state.whitespace'), paths: distribution.states.whitespace })}>{t('values.open', { count: distribution.states.whitespace.length })}</button></div> : null}
              {distribution.unreadablePaths.length ? <div class="propcraft-field"><span>{t('values.state.unreadable')}: {distribution.unreadablePaths.length}</span><button class="propcraft-link" onClick={() => setDrilldown({ title: t('values.state.unreadable'), paths: distribution.unreadablePaths })}>{t('values.open', { count: distribution.unreadablePaths.length })}</button></div> : null}
              {distribution.scopeUnknownPaths.length ? <div class="propcraft-field"><span>{t('values.state.unknown')}: {distribution.scopeUnknownPaths.length}</span><button class="propcraft-link" onClick={() => setDrilldown({ title: t('values.state.unknown'), paths: distribution.scopeUnknownPaths })}>{t('values.open', { count: distribution.scopeUnknownPaths.length })}</button></div> : null}
            </div> : null}

            <div class="propcraft-drawer-summary">
              <div>{t('values.selected', { count: selected.size, notes: new Set(selectedPaths([...selected])).size })}</div>
              {selected.size ? <button class="propcraft-link" onClick={() => setDrilldown({ title: t('values.title', { key: keyName }), paths: selectedPaths([...selected]) })}>{t('values.open', { count: new Set(selectedPaths([...selected])).size })}</button> : null}
              {selected.size && selectedScalars.length === 0 ? <div class="propcraft-muted">{t('values.empty')}</div> : null}
            </div>
            <div class="propcraft-toolbar">
              <button class="propcraft-btn" disabled={!canPreview || !selectedScalars.length} onClick={() => startMap(false)}>{t('values.mapAction')}</button>
              {mode === 'field' ? <button class="propcraft-btn" disabled={!canPreview} onClick={() => startMap(true)}>{t('mapping.fill.title')}</button> : null}
              <button class="propcraft-btn" disabled={!canPreview || !selectedScalars.length || mode !== 'field'} onClick={() => setEditor('convert')}>{t('values.convertAction')}</button>
            </div>
          </div>;

  return <div class="propcraft-page">
    {header}
    {memberSummary}
    {selection.removedCount ? <div class="propcraft-muted" role="status">{t('values.selectionRemoved', { count: selection.removedCount })}</div> : null}
    <div class="propcraft-main">{body}</div>
    {distribution && editor === 'map' ? <ValueMappingEditor keyName={keyName} mode={mode} scopeLabel={scopeLabel} selected={selectedScalars} distribution={distribution} fillOnly={fillOnly} t={t} onCancel={() => setEditor(null)} onGenerate={generate} /> : null}
    {distribution && editor === 'convert' ? <ValueConversionEditor keyName={keyName} mode={mode} distribution={distribution} selected={selectedScalars} t={t} onCancel={() => setEditor(null)} onGenerate={generate} /> : null}
    {drilldown ? <ValueNoteList title={drilldown.title} paths={drilldown.paths} plugin={plugin} t={t} onClose={() => setDrilldown(null)} /> : null}
  </div>;
}
