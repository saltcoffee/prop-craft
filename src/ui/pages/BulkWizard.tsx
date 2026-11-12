import { useState } from 'preact/hooks';
import type { ConflictStrategy, PropertyValueType } from '../../domain/models';
import type { PageProps } from '../types';

function parseValue(raw: string, type: PropertyValueType): unknown {
  if (type === 'number') return Number(raw);
  if (type === 'checkbox') return raw === 'true';
  if (type === 'list') return raw.split(',').map(part => part.trim()).filter(Boolean);
  return raw;
}

export function BulkWizard({ plugin, t, onPreview }: PageProps) {
  const [scopeKind, setScopeKind] = useState<'all' | 'folder'>('folder');
  const [folder, setFolder] = useState('');
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [key, setKey] = useState('');
  const [valueType, setValueType] = useState<PropertyValueType>('text');
  const [value, setValue] = useState('');
  const [conflict, setConflict] = useState<ConflictStrategy>('skip');

  const preview = () => {
    if (!key.trim() || (scopeKind === 'folder' && !folder.trim())) {
      plugin.notify(t('wizard.missing'));
      return;
    }
    const scope = scopeKind === 'all'
      ? { kind: 'all' as const }
      : { kind: 'folder' as const, path: folder.trim(), includeSubfolders };
    const plan = plugin.planner.planAddProperty(scope, key.trim(), parseValue(value, valueType), valueType, conflict);
    onPreview(plan);
  };

  return (
    <div class="propcraft-page">
      <h2 class="propcraft-page-title">{t('wizard.title')}</h2>
      <div class="propcraft-form">
        <label class="propcraft-field">
          <span>{t('wizard.scope')}</span>
          <div class="propcraft-radios">
            <label><input type="radio" checked={scopeKind === 'all'} onChange={() => setScopeKind('all')} />{t('wizard.scopeAll')}</label>
            <label><input type="radio" checked={scopeKind === 'folder'} onChange={() => setScopeKind('folder')} />{t('wizard.scopeFolder')}</label>
          </div>
        </label>

        {scopeKind === 'folder' ? (
          <>
            <label class="propcraft-field">
              <span>{t('wizard.folder')}</span>
              <input class="propcraft-input" placeholder={t('wizard.folderPlaceholder')} value={folder} onInput={event => setFolder((event.target as HTMLInputElement).value)} />
            </label>
            <label class="propcraft-check">
              <input type="checkbox" checked={includeSubfolders} onChange={event => setIncludeSubfolders((event.target as HTMLInputElement).checked)} />
              {t('wizard.includeSubfolders')}
            </label>
          </>
        ) : null}

        <label class="propcraft-field">
          <span>{t('wizard.key')}</span>
          <input class="propcraft-input" placeholder={t('wizard.keyPlaceholder')} value={key} onInput={event => setKey((event.target as HTMLInputElement).value)} />
        </label>

        <label class="propcraft-field">
          <span>{t('wizard.valueType')}</span>
          <select class="propcraft-input" value={valueType} onChange={event => setValueType((event.target as HTMLSelectElement).value as PropertyValueType)}>
            <option value="text">text</option>
            <option value="number">number</option>
            <option value="checkbox">checkbox</option>
            <option value="list">list</option>
            <option value="date">date</option>
          </select>
        </label>

        <label class="propcraft-field">
          <span>{t('wizard.value')}</span>
          <input class="propcraft-input" value={value} onInput={event => setValue((event.target as HTMLInputElement).value)} />
        </label>

        <label class="propcraft-field">
          <span>{t('wizard.conflictPolicy')}</span>
          <select class="propcraft-input" value={conflict} onChange={event => setConflict((event.target as HTMLSelectElement).value as ConflictStrategy)}>
            <option value="skip">{t('wizard.conflict.skip')}</option>
            <option value="overwrite">{t('wizard.conflict.overwrite')}</option>
            <option value="append">{t('wizard.conflict.append')}</option>
          </select>
        </label>

        <button class="propcraft-btn mod-cta" onClick={preview}>{t('wizard.preview')}</button>
      </div>
    </div>
  );
}
