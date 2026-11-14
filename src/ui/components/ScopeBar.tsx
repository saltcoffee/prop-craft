import { useState } from 'preact/hooks';
import type { ScopeCondition, ScopeQuery, ScopeResult } from '../../domain/scope';
import type { VaultSnapshot } from '../../domain/models';
import type { Translate } from '../../i18n';
import type { IssueCode } from '../../domain/errors';
import { issueText } from '../text';
import { ScopeFileList } from './ScopeFileList';
import type PropCraftPlugin from '../../main';

export function ScopeBar({ query, result, snapshot, busy, error, onChange, plugin, t }: {
  query: ScopeQuery; result: ScopeResult | null; snapshot: VaultSnapshot | null; busy: boolean; error?: IssueCode;
  onChange: (query: ScopeQuery) => void; plugin: PropCraftPlugin; t: Translate;
}) {
  const [showFiles, setShowFiles] = useState(false);
  const update = (condition: ScopeCondition) => onChange({ ...query, conditions: query.conditions.map(c => c.id === condition.id ? condition : c) });
  const add = (kind: 'tag' | 'property') => {
    const id = crypto.randomUUID();
    const condition: ScopeCondition = kind === 'tag' ? { id, kind, tag: '', operator: 'contains', includeDescendants: false } : { id, kind, key: '', operator: 'exists' };
    onChange({ ...query, conditions: [...query.conditions, condition] });
  };
  return <section class="propcraft-scope" aria-label={t('scope.title')} aria-busy={busy}>
    <div class="propcraft-toolbar">
      <strong>{t('scope.title')}</strong>
      <label>{t('scope.folder')} <select class="propcraft-input" value={query.base.kind === 'all' ? 'all' : `folder:${query.base.path}`} onChange={event => {
        const value = event.currentTarget.value;
        onChange({ ...query, base: value === 'all' ? { kind: 'all' } : { kind: 'folder', path: value.slice(7), includeSubfolders: true } });
      }}>
        <option value="all">{t('scope.all')}</option>
        {query.base.kind === 'folder' && !snapshot?.folders.includes(query.base.path) ? <option value={`folder:${query.base.path}`}>{query.base.path}</option> : null}
        {(snapshot?.folders ?? []).map(folder => <option key={folder} value={`folder:${folder}`}>{folder}/</option>)}
      </select></label>
      {query.base.kind === 'folder' ? <label class="propcraft-check"><input type="checkbox" checked={query.base.includeSubfolders} onChange={event => {
        if (query.base.kind === 'folder') onChange({ ...query, base: { ...query.base, includeSubfolders: event.currentTarget.checked } });
      }} />{t('scope.subfolders')}</label> : null}
      <button class="propcraft-link" onClick={() => onChange({ base: { kind: 'all' }, conditions: [], manuallyExcludedPaths: [] })}>{t('scope.reset')}</button>
    </div>
    <div class="propcraft-muted">{t('scope.and')}</div>
    {query.conditions.map(condition => <div class="propcraft-condition" key={condition.id}>
      {condition.kind === 'tag' ? <>
        <select class="propcraft-input" aria-label={t('scope.operator')} value={condition.operator} onChange={event => update({ ...condition, operator: event.currentTarget.value as 'contains' | 'not-contains' })}>
          <option value="contains">{t('scope.contains')}</option><option value="not-contains">{t('scope.notContains')}</option>
        </select>
        <input class="propcraft-input" aria-label={t('scope.tag')} placeholder="#book" list="propcraft-scope-tags" value={condition.tag} onInput={event => update({ ...condition, tag: event.currentTarget.value })} />
        <label class="propcraft-check"><input type="checkbox" checked={condition.includeDescendants} onChange={event => update({ ...condition, includeDescendants: event.currentTarget.checked })} />{t('scope.descendants')}</label>
      </> : <>
        <input class="propcraft-input" aria-label={t('scope.property')} placeholder={t('scope.property')} list="propcraft-scope-keys" value={condition.key} onInput={event => update({ ...condition, key: event.currentTarget.value })} />
        <select class="propcraft-input" aria-label={t('scope.operator')} value={condition.operator} onChange={event => {
          const operator = event.currentTarget.value as 'exists' | 'missing' | 'empty' | 'equals';
          update(operator === 'equals' ? { ...condition, operator, value: '' } : { ...condition, operator });
        }}>
          <option value="exists">{t('scope.exists')}</option><option value="missing">{t('scope.missing')}</option><option value="empty">{t('scope.empty')}</option><option value="equals">{t('scope.equals')}</option>
        </select>
        {condition.operator === 'equals' ? <>
          <select class="propcraft-input" aria-label={t('scope.valueType')} value={typeof condition.value} onChange={event => update({ ...condition, value: event.currentTarget.value === 'boolean' ? false : event.currentTarget.value === 'number' ? NaN : '' })}>
            <option value="string">text</option><option value="number">number</option><option value="boolean">boolean</option>
          </select>
          {typeof condition.value === 'boolean' ? <select class="propcraft-input" aria-label={t('scope.value')} value={String(condition.value)} onChange={event => update({ ...condition, value: event.currentTarget.value === 'true' })}><option value="false">false</option><option value="true">true</option></select>
            : <input class="propcraft-input" aria-label={t('scope.value')} type={typeof condition.value === 'number' ? 'number' : 'text'} value={typeof condition.value === 'number' && !Number.isFinite(condition.value) ? '' : condition.value} onInput={event => update({ ...condition, value: typeof condition.value === 'number' ? event.currentTarget.value.trim() === '' ? NaN : Number(event.currentTarget.value) : event.currentTarget.value })} />}
        </> : null}
      </>}
      <button class="propcraft-link" aria-label={t('scope.remove')} onClick={() => onChange({ ...query, conditions: query.conditions.filter(c => c.id !== condition.id) })}>✕</button>
    </div>)}
    <datalist id="propcraft-scope-keys">{[...(snapshot?.properties.keys() ?? [])].map(key => <option value={key} key={key} />)}</datalist>
    <datalist id="propcraft-scope-tags">{[...(snapshot?.tags.keys() ?? [])].map(tag => <option value={tag} key={tag} />)}</datalist>
    <div class="propcraft-toolbar"><button class="propcraft-btn" onClick={() => add('tag')}>{t('scope.addTag')}</button><button class="propcraft-btn" onClick={() => add('property')}>{t('scope.addProperty')}</button></div>
    <div class={busy ? 'propcraft-muted' : ''} role="status">
      {busy ? <div>{t('scope.updating')}</div> : null}
      {error ? <div class="propcraft-warn" role="alert">{issueText(t, error)}</div> : null}
      {result ? <div>{t('scope.counts', { matched: result.summary.matched, manual: result.summary.manual, effective: result.summary.effective, unknown: result.summary.unknown })} · {t('scope.global', { count: result.globallyExcludedPaths.length })}</div> : null}
      {!busy && !error && result && !result.effectivePaths.length ? <div>{t('scope.emptyResult')}</div> : null}
    </div>
    <div class="propcraft-toolbar"><button class="propcraft-link" disabled={!result || busy || Boolean(error)} onClick={() => setShowFiles(true)}>{t('scope.files')}</button><button class="propcraft-link" onClick={() => plugin.openSettings()}>{t('scope.settings')}</button></div>
    {showFiles && result ? <ScopeFileList query={query} result={result} snapshot={snapshot} onChange={onChange} onClose={() => setShowFiles(false)} plugin={plugin} t={t} /> : null}
  </section>;
}
