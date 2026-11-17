import { useState } from 'preact/hooks';
import type { EmptyState, FillSpec, MapPropertyValuesOperation, ValueScalar, ValueTarget } from '../../domain/models';
import type { PropertyValueDistribution } from '../../domain/value-distribution';
import { scalarIdentity, valueIdentity } from '../../domain/property-value';
import { parseDecimal, containsLink } from '../../domain/value-conversion';
import { validateValueMapping } from '../../domain/value-mapping';
import type { Translate } from '../../i18n';
import { issueText } from '../text';
import { displayScalar } from '../value-format';
import { Dialog } from './Dialog';

type TargetType = 'text' | 'number' | 'boolean';
interface Row { id: number; source: ValueScalar; targetType: TargetType; targetText: string; set: boolean; manual: boolean }
const EMPTY_STATES: readonly EmptyState[] = ['missing', 'null', 'empty-text', 'empty-list'];

/** Parse an explicit target. Text accepts the empty string; number/boolean must be explicit. */
function scalarFromText(type: TargetType, text: string): { ok: true; value: ValueScalar } | { ok: false; code: 'number-format' | 'number-precision' | 'input-invalid' } {
  if (type === 'text') return { ok: true, value: { type: 'text', value: text } };
  if (type === 'boolean') {
    if (text === 'true') return { ok: true, value: { type: 'boolean', value: true } };
    if (text === 'false') return { ok: true, value: { type: 'boolean', value: false } };
    return { ok: false, code: 'input-invalid' };
  }
  if (!text.trim()) return { ok: false, code: 'input-invalid' };
  const parsed = parseDecimal(text);
  if (!parsed.ok) return { ok: false, code: parsed.precision ? 'number-precision' : 'number-format' };
  return { ok: true, value: { type: 'number', value: parsed.value as number } };
}

export function ValueMappingEditor({ keyName, mode, scopeLabel, selected, distribution, fillOnly, t, onCancel, onGenerate }: {
  keyName: string; mode: 'field' | 'member'; scopeLabel: string; selected: readonly ValueScalar[];
  distribution: PropertyValueDistribution; fillOnly: boolean; t: Translate;
  onCancel: () => void; onGenerate: (operation: MapPropertyValuesOperation) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => (fillOnly ? [] : selected.map((source, index) => ({ id: index, source, targetType: source.type, targetText: '', set: false, manual: false }))));
  const [trim, setTrim] = useState(false);
  const [caseMode, setCaseMode] = useState<'none' | 'lower' | 'upper'>('none');
  const [fillStates, setFillStates] = useState<Set<EmptyState>>(new Set());
  const [fillType, setFillType] = useState<'text' | 'number' | 'boolean' | 'list'>('text');
  const [fillText, setFillText] = useState('');
  const [error, setError] = useState<string>();

  const linked = selected.filter(value => value.type === 'text' && containsLink(value.value));
  const updateRow = (id: number, patch: Partial<Row>) => setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row));

  // The assistant only fills rows the user has not edited by hand; manual targets are preserved.
  const applyAssistant = (nextTrim: boolean, nextCase: 'none' | 'lower' | 'upper') => {
    setTrim(nextTrim); setCaseMode(nextCase);
    setRows(current => current.map(row => {
      if (row.manual || row.source.type !== 'text' || containsLink(row.source.value)) return row;
      let value = row.source.value;
      if (nextTrim) value = value.trim();
      if (nextCase === 'lower') value = value.toLowerCase();
      else if (nextCase === 'upper') value = value.toUpperCase();
      return { ...row, targetType: 'text', targetText: value, set: true };
    }));
  };

  const build = (): { operation?: MapPropertyValuesOperation; error?: string } => {
    const rules: { id: string; from: ValueScalar; to: ValueScalar }[] = [];
    for (const row of rows) {
      if (!row.set) continue;
      const parsed = scalarFromText(row.targetType, row.targetText);
      if (!parsed.ok) return { error: issueText(t, parsed.code) };
      rules.push({ id: `r${row.id}`, from: row.source, to: parsed.value });
    }
    let fill: FillSpec | undefined;
    if (mode === 'field' && fillStates.size) {
      let target: ValueTarget;
      if (fillType === 'list') {
        const members = fillText.split('\n').map(line => line.trim()).filter(Boolean).map(value => ({ type: 'text' as const, value }));
        target = { type: 'list', value: members };
      } else {
        const parsed = scalarFromText(fillType, fillText);
        if (!parsed.ok) return { error: issueText(t, parsed.code) };
        target = parsed.value;
      }
      fill = { states: EMPTY_STATES.filter(state => fillStates.has(state)), target };
    }
    if (!rules.length && !(fill && fill.states.length)) return { error: t('mapping.noChange') };
    const operation = (mode === 'field'
      ? { kind: 'mapPropertyValues', key: keyName, mode: 'field', rules, ...(fill ? { fill } : {}) }
      : { kind: 'mapPropertyValues', key: keyName, mode: 'member', rules }) as MapPropertyValuesOperation;
    const issues = validateValueMapping(operation);
    if (issues.length) return { error: issueText(t, issues[0].code) };
    return { operation };
  };

  const committed = rows.filter(row => row.set);
  const targetKeys = new Set(committed.map(row => `${row.targetType}:${row.targetText}`));
  const sourceIdentities = new Set(committed.map(row => scalarIdentity(row.source)));
  const affected = new Set<string>();
  for (const bucket of distribution.buckets) if (sourceIdentities.has(valueIdentity(bucket.raw))) for (const path of bucket.notePaths) affected.add(path);
  for (const state of EMPTY_STATES) if (fillStates.has(state)) for (const path of distribution.states[state]) affected.add(path);

  return <Dialog drawer title={t('mapping.title', { key: keyName })} closeLabel={t('common.close')} onClose={onCancel}>
    <div class="propcraft-drawer-summary" role="status"><div>{t('mapping.scope', { scope: scopeLabel })}</div></div>
    <div class="propcraft-drawer-body">
      {rows.length ? <div class="propcraft-table-wrap"><table class="propcraft-table"><thead><tr>
        <th scope="col">{t('mapping.source')}</th><th scope="col">{t('mapping.targetType')}</th><th scope="col">{t('mapping.targetValue')}</th>
      </tr></thead><tbody>{rows.map(row => <tr key={row.id}>
        <td>{displayScalar(row.source)}</td>
        <td><select class="propcraft-input" aria-label={t('mapping.targetType')} value={row.targetType} onChange={event => {
          const targetType = event.currentTarget.value as TargetType;
          updateRow(row.id, { targetType, targetText: '', set: false, manual: true });
        }}><option value="text">text</option><option value="number">number</option><option value="boolean">boolean</option></select></td>
        <td>{row.targetType === 'boolean'
          ? <select class="propcraft-input" aria-label={t('mapping.targetValue')} value={row.set ? row.targetText : ''} onChange={event => { const targetText = event.currentTarget.value; updateRow(row.id, { targetText, set: targetText !== '', manual: true }); }}><option value="">—</option><option value="true">true</option><option value="false">false</option></select>
          : <input class="propcraft-input" aria-label={t('mapping.targetValue')} placeholder={t('mapping.literalValue')} value={row.targetText} onInput={event => updateRow(row.id, { targetText: event.currentTarget.value, set: true, manual: true })} />}</td>
      </tr>)}</tbody></table></div> : null}

      {rows.some(row => row.source.type === 'text') ? <div class="propcraft-group">
        <div class="propcraft-section-title">{t('mapping.assistant')}</div>
        <label class="propcraft-check"><input type="checkbox" checked={trim} onChange={event => applyAssistant(event.currentTarget.checked, caseMode)} />{t('mapping.trim')}</label>
        <label>{t('mapping.case')} <select class="propcraft-input" value={caseMode} onChange={event => applyAssistant(trim, event.currentTarget.value as 'none' | 'lower' | 'upper')}><option value="none">{t('mapping.case.keep')}</option><option value="lower">{t('mapping.case.lower')}</option><option value="upper">{t('mapping.case.upper')}</option></select></label>
        <div class="propcraft-muted">{t('mapping.assistantHint')}</div>
        {linked.length ? <div class="propcraft-warn">{t('mapping.linked')}: {linked.map(displayScalar).join(', ')}</div> : null}
      </div> : null}

      {mode === 'field' ? <div class="propcraft-group">
        <div class="propcraft-section-title">{t('mapping.fill.title')}</div>
        {EMPTY_STATES.map(state => <label class="propcraft-check" key={state}><input type="checkbox" checked={fillStates.has(state)} onChange={event => {
          const next = new Set(fillStates); if (event.currentTarget.checked) next.add(state); else next.delete(state); setFillStates(next);
        }} />{t(`mapping.fill.${state}`)}</label>)}
        <div class="propcraft-field"><label>{t('mapping.fill.targetType')} <select class="propcraft-input" value={fillType} onChange={event => { setFillType(event.currentTarget.value as typeof fillType); setFillText(''); }}><option value="text">text</option><option value="number">number</option><option value="boolean">boolean</option><option value="list">list</option></select></label></div>
        {fillType === 'list'
          ? <textarea class="propcraft-input" aria-label={t('mapping.fill.targetValue')} placeholder={t('mapping.listTarget')} value={fillText} onInput={event => setFillText(event.currentTarget.value)} />
          : fillType === 'boolean'
            ? <select class="propcraft-input" value={fillText} onChange={event => setFillText(event.currentTarget.value)}><option value="">—</option><option value="true">true</option><option value="false">false</option></select>
            : <input class="propcraft-input" aria-label={t('mapping.fill.targetValue')} placeholder={t('mapping.literalValue')} value={fillText} onInput={event => setFillText(event.currentTarget.value)} />}
      </div> : <div class="propcraft-muted">{t('mapping.fill.memberHidden')}</div>}

      <div class="propcraft-muted">{t('mapping.predict', { sources: sourceIdentities.size, targets: targetKeys.size, notes: affected.size })}</div>
      <div class="propcraft-muted">{t('mapping.predictHint')}</div>
      {error ? <div class="propcraft-warn" role="alert">{error}</div> : null}
    </div>
    <div class="propcraft-drawer-actions">
      <button class="propcraft-btn" onClick={onCancel}>{t('mapping.cancel')}</button>
      <button class="propcraft-btn mod-cta" onClick={() => { const built = build(); if (built.error) setError(built.error); else if (built.operation) onGenerate(built.operation); }}>{t('mapping.generate')}</button>
    </div>
  </Dialog>;
}
