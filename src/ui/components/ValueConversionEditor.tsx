import { useState } from 'preact/hooks';
import type { ConvertPropertyTypeOperation, ValueConversion, ValueScalar } from '../../domain/models';
import type { PropertyValueDistribution } from '../../domain/value-distribution';
import { scalarIdentity, scalarToRaw } from '../../domain/property-value';
import { analyzeConversion } from '../../domain/value-conversion';
import { isChangeOperation } from '../../domain/operation';
import type { Translate } from '../../i18n';
import { issueText } from '../text';
import { displayScalar } from '../value-format';
import { Dialog } from './Dialog';

const KIND_LABEL: Record<ValueConversion['kind'], 'conversion.kind.text-to-number' | 'conversion.kind.wrap-list' | 'conversion.kind.split-list' | 'conversion.kind.normalize-date'> = {
  'text-to-number': 'conversion.kind.text-to-number',
  'wrap-list': 'conversion.kind.wrap-list',
  'split-list': 'conversion.kind.split-list',
  'normalize-date': 'conversion.kind.normalize-date',
};
const STATUS: Record<string, 'conversion.status.ready' | 'conversion.status.confirm' | 'conversion.status.fail' | 'conversion.status.noop'> = {
  ready: 'conversion.status.ready', 'needs-confirmation': 'conversion.status.confirm', unconvertible: 'conversion.status.fail', noop: 'conversion.status.noop',
};

export function ValueConversionEditor({ keyName, mode, distribution, selected, t, onCancel, onGenerate }: {
  keyName: string; mode: 'field' | 'member'; distribution: PropertyValueDistribution; selected: readonly ValueScalar[];
  t: Translate; onCancel: () => void; onGenerate: (operation: ConvertPropertyTypeOperation) => void;
}) {
  const [kind, setKind] = useState<ValueConversion['kind']>('text-to-number');
  const [delimiterKind, setDelimiterKind] = useState<'literal' | 'newline'>('literal');
  const [delimiterText, setDelimiterText] = useState(';');
  const [trimItems, setTrimItems] = useState(false);
  const [dropEmptyItems, setDropEmptyItems] = useState(false);
  const [dateTarget, setDateTarget] = useState<'date' | 'datetime'>('date');
  const [region, setRegion] = useState<'MDY' | 'DMY' | 'YMD'>('MDY');
  const [error, setError] = useState<string>();

  const conversion: ValueConversion = kind === 'split-list'
    ? { kind, delimiter: delimiterKind === 'newline' ? { kind: 'newline' } : { kind: 'literal', value: delimiterText }, trimItems, dropEmptyItems }
    : kind === 'normalize-date' ? { kind, target: dateTarget, regionFormat: region }
      : { kind };

  const noteCount = new Map(distribution.buckets.map(bucket => [bucket.id, bucket.notePaths.length]));
  const trials = selected.map(source => ({ source, analysis: analyzeConversion(scalarToRaw(source), conversion), notes: noteCount.get(scalarIdentity(source)) ?? 0 }));

  const build = (): { operation?: ConvertPropertyTypeOperation; error?: string } => {
    if (kind === 'split-list' && delimiterKind === 'literal' && !delimiterText) return { error: t('conversion.literalEmpty') };
    const sources = kind === 'wrap-list' ? [...selected] : selected.filter(source => source.type === 'text');
    if (!sources.length) return { error: t('conversion.noSelection') };
    const operation: ConvertPropertyTypeOperation = { kind: 'convertPropertyType', key: keyName, sources, conversion };
    if (!isChangeOperation(operation)) return { error: issueText(t, 'input-invalid') };
    return { operation };
  };

  return <Dialog drawer title={t('conversion.title', { key: keyName })} closeLabel={t('common.close')} onClose={onCancel}>
    <div class="propcraft-drawer-summary" role="status"><div>{t('conversion.source', { count: selected.length })}</div></div>
    <div class="propcraft-drawer-body">
      {mode === 'member' ? <div class="propcraft-warn">{t('conversion.memberHint')}</div> : <>
        <div class="propcraft-field"><label>{t('conversion.kind')} <select class="propcraft-input" value={kind} onChange={event => setKind(event.currentTarget.value as ValueConversion['kind'])}>
          {(Object.keys(KIND_LABEL) as ValueConversion['kind'][]).map(key => <option value={key} key={key}>{t(KIND_LABEL[key])}</option>)}
        </select></label></div>
        {kind === 'split-list' ? <div class="propcraft-group">
          <div class="propcraft-field"><label>{t('conversion.delimiter')} <select class="propcraft-input" value={delimiterKind} onChange={event => setDelimiterKind(event.currentTarget.value as 'literal' | 'newline')}><option value="literal">{t('conversion.delimiter.literal')}</option><option value="newline">{t('conversion.delimiter.newline')}</option></select></label></div>
          {delimiterKind === 'literal' ? <input class="propcraft-input" aria-label={t('conversion.delimiterValue')} placeholder={t('conversion.delimiterValue')} value={delimiterText} onInput={event => setDelimiterText(event.currentTarget.value)} /> : null}
          <label class="propcraft-check"><input type="checkbox" checked={trimItems} onChange={event => setTrimItems(event.currentTarget.checked)} />{t('conversion.trimItems')}</label>
          <label class="propcraft-check"><input type="checkbox" checked={dropEmptyItems} onChange={event => setDropEmptyItems(event.currentTarget.checked)} />{t('conversion.dropEmptyItems')}</label>
        </div> : null}
        {kind === 'normalize-date' ? <div class="propcraft-group">
          <div class="propcraft-field"><label>{t('conversion.dateTarget')} <select class="propcraft-input" value={dateTarget} onChange={event => setDateTarget(event.currentTarget.value as 'date' | 'datetime')}><option value="date">YYYY-MM-DD</option><option value="datetime">YYYY-MM-DDTHH:mm</option></select></label></div>
          <div class="propcraft-field"><label>{t('conversion.region')} <select class="propcraft-input" value={region} onChange={event => setRegion(event.currentTarget.value as 'MDY' | 'DMY' | 'YMD')}><option value="MDY">MM/DD/YYYY</option><option value="DMY">DD/MM/YYYY</option><option value="YMD">YYYY/MM/DD</option></select></label></div>
        </div> : null}

        <div class="propcraft-section-title">{t('conversion.trial')}</div>
        <div class="propcraft-table-wrap"><table class="propcraft-table"><thead><tr>
          <th scope="col">{t('conversion.trialColumn.source')}</th><th scope="col">{t('conversion.trialColumn.result')}</th><th scope="col" class="num">{t('conversion.trialColumn.notes')}</th><th scope="col">{t('conversion.trialColumn.status')}</th>
        </tr></thead><tbody>{trials.map((trial, index) => <tr key={index}>
          <td>{displayScalar(trial.source)}</td>
          <td>{trial.analysis.candidate === undefined ? '—' : JSON.stringify(trial.analysis.candidate)}</td>
          <td class="num">{trial.notes}</td>
          <td>{t(STATUS[trial.analysis.outcome])}{trial.analysis.issues[0] ? <div class="propcraft-muted">{issueText(t, trial.analysis.issues[0].code)}</div> : null}</td>
        </tr>)}</tbody></table></div>
        <div class="propcraft-muted">{t('conversion.previewNote')}</div>
        {error ? <div class="propcraft-warn" role="alert">{error}</div> : null}
      </>}
    </div>
    <div class="propcraft-drawer-actions">
      <button class="propcraft-btn" onClick={onCancel}>{t('conversion.cancel')}</button>
      <button class="propcraft-btn mod-cta" disabled={mode === 'member'} onClick={() => { const built = build(); if (built.error) setError(built.error); else if (built.operation) onGenerate(built.operation); }}>{t('conversion.generate')}</button>
    </div>
  </Dialog>;
}
