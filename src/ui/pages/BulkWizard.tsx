import { useState } from 'preact/hooks';
import type { ChangeOperation, ConflictStrategy, PropertyValueType } from '../../domain/models';
import { validateOperation } from '../../domain/operation';
import { issueCode, OperationError } from '../../domain/errors';
import { issueText } from '../text';
import type { PageProps } from '../types';

export function BulkWizard({ t, requestPreview, canPreview }: PageProps) {
  const [key, setKey] = useState(''), [valueType, setValueType] = useState<PropertyValueType>('text'), [value, setValue] = useState('');
  const [conflict, setConflict] = useState<ConflictStrategy>('skip'), [touched, setTouched] = useState(false);
  let operation: ChangeOperation | undefined, error: string | undefined;
  try {
    if (valueType === 'number' && !value.trim()) throw new OperationError('input-invalid');
    const parsed = valueType === 'number' ? Number(value) : valueType === 'checkbox' ? value === 'true' : valueType === 'list' ? value.split(',').map(part => part.trim()).filter(Boolean) : value;
    operation = { kind: 'addProperty', key: key.trim(), value: parsed, valueType, onConflict: conflict };
    validateOperation(operation);
  } catch (issue) { error = issueText(t, issueCode(issue, 'input-invalid')); }
  return <div class="propcraft-page"><h2 class="propcraft-page-title">{t('wizard.title')}</h2><div class="propcraft-muted">{t('scope.current')}</div>
    <div class="propcraft-form">
      <label class="propcraft-field"><span>{t('wizard.key')}</span><input class="propcraft-input" placeholder={t('wizard.keyPlaceholder')} value={key} onInput={event => { setKey(event.currentTarget.value); setTouched(true); }} /></label>
      <label class="propcraft-field"><span>{t('wizard.valueType')}</span><select class="propcraft-input" value={valueType} onChange={event => { const next = event.currentTarget.value as PropertyValueType; setValueType(next); if (next === 'checkbox') setValue('false'); setTouched(true); }}>
        {(['text', 'number', 'checkbox', 'list', 'date', 'datetime'] as const).map(type => <option value={type} key={type}>{type}</option>)}
      </select></label>
      <label class="propcraft-field"><span>{t('wizard.value')}</span>{valueType === 'checkbox' ? <select class="propcraft-input" value={value} onChange={event => setValue(event.currentTarget.value)}><option value="false">false</option><option value="true">true</option></select>
        : <input class="propcraft-input" type={valueType === 'number' ? 'number' : 'text'} value={value} onInput={event => { setValue(event.currentTarget.value); setTouched(true); }} />}</label>
      <label class="propcraft-field"><span>{t('wizard.conflictPolicy')}</span><select class="propcraft-input" value={conflict} onChange={event => setConflict(event.currentTarget.value as ConflictStrategy)}>
        <option value="skip">{t('wizard.conflict.skip')}</option><option value="overwrite">{t('wizard.conflict.overwrite')}</option><option value="append">{t('wizard.conflict.append')}</option>
      </select></label>
      {touched && error ? <div class="propcraft-warn" role="alert">{error}</div> : null}
      <button class="propcraft-btn mod-cta" disabled={!canPreview || Boolean(error)} onClick={() => { if (operation && !error) void requestPreview(operation); }}>{t('wizard.preview')}</button>
    </div>
  </div>;
}
