import { useMemo, useState } from 'preact/hooks';
import type { ConvertTagsToPropertyOperation, TagPropertyRule, ValueScalar } from '../../domain/models';
import type { TagTreeNode, TagTreeView } from '../../domain/tag-tree';
import { validateOperation } from '../../domain/operation';
import { parseDecimal } from '../../domain/value-conversion';
import { tagIdentity } from '../../domain/normalize';
import { issueCode } from '../../domain/errors';
import type { Translate } from '../../i18n';
import type PropCraftPlugin from '../../main';
import { issueText } from '../text';
import { Dialog } from './Dialog';

type TargetType = 'text' | 'number' | 'boolean';

interface RuleDraft {
  id: string;
  tag: string;
  valueType: TargetType;
  valueText: string;
}

interface Props {
  tree: TagTreeView;
  initialNodes: readonly TagTreeNode[];
  branchLabel?: string;
  t: Translate;
  plugin: PropCraftPlugin;
  onCancel: () => void;
  onGenerate: (operation: ConvertTagsToPropertyOperation) => void;
}

function parseRuleScalar(type: TargetType, text: string): { ok: true; value: ValueScalar } | { ok: false; code: 'number-format' | 'number-precision' | 'input-invalid' } {
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

export function TagPropertyEditor({ tree, initialNodes, branchLabel, t, plugin, onCancel, onGenerate }: Props) {
  const [nextId, setNextId] = useState(initialNodes.length + 1);
  const [rows, setRows] = useState<RuleDraft[]>(() =>
    initialNodes.filter(node => !node.virtual).map((node, index) => ({
      id: `r-${index + 1}`,
      tag: node.displayTag,
      valueType: 'text',
      valueText: '',
    })),
  );
  const [key, setKey] = useState('');
  const [mode, setMode] = useState<'scalar' | 'list'>('scalar');
  const [removeSourceTags, setRemoveSourceTags] = useState(false);
  const [error, setError] = useState<string>();

  const realTagList = useMemo(() => [...tree.nodes.values()].filter(node => !node.virtual), [tree]);
  const declaredType = key.trim() ? plugin.getDeclaredType(key.trim()) : undefined;

  const estimatedNotes = useMemo(() => {
    const notes = new Set<string>();
    for (const row of rows) {
      const node = tree.nodes.get(tagIdentity(row.tag));
      if (node && !node.virtual) {
        for (const path of node.directPaths) notes.add(path);
      }
    }
    return notes.size;
  }, [rows, tree]);

  const updateRow = (id: string, patch: Partial<RuleDraft>) => {
    setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row));
    setError(undefined);
  };

  const moveRow = (index: number, delta: -1 | 1) => {
    setRows(current => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const copy = [...current];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const addRule = () => {
    setRows(current => [...current, { id: `r-${nextId}`, tag: '', valueType: 'text', valueText: '' }]);
    setNextId(value => value + 1);
    setError(undefined);
  };

  const build = (): { operation?: ConvertTagsToPropertyOperation; error?: string } => {
    if (!rows.length) return { error: t('tags.toProperty.noRules') };
    const rules: TagPropertyRule[] = [];
    for (const row of rows) {
      const parsed = parseRuleScalar(row.valueType, row.valueText);
      if (!parsed.ok) return { error: issueText(t, parsed.code) };
      rules.push({ id: row.id, tag: row.tag, value: parsed.value });
    }
    const operation: ConvertTagsToPropertyOperation = {
      kind: 'convertTagsToProperty',
      key: key.trim(),
      mode,
      rules,
      removeSourceTags,
    };
    try {
      validateOperation(operation);
      return { operation };
    } catch (err) {
      return { error: issueText(t, issueCode(err, 'input-invalid')) };
    }
  };

  return (
    <Dialog drawer title={t('tags.toProperty.title')} closeLabel={t('common.close')} onClose={onCancel}>
      <div class="propcraft-drawer-body">
        {branchLabel ? (
          <div class="propcraft-muted">
            {t('tags.toProperty.branchExpandTitle', { tag: branchLabel, count: rows.length })}
          </div>
        ) : null}

        <div class="propcraft-field">
          <label htmlFor="propcraft-tagprop-key">{t('tags.toProperty.key')}</label>
          <input
            id="propcraft-tagprop-key"
            class="propcraft-input"
            placeholder={t('tags.toProperty.keyPlaceholder')}
            value={key}
            onInput={event => { setKey(event.currentTarget.value); setError(undefined); }}
          />
          {key.trim() ? (
            <div class="propcraft-muted">
              {t('values.declaration', { value: declaredType ? `${declaredType} (${t('values.declaration.vault')})` : t('values.declaration.absent') })}
            </div>
          ) : null}
        </div>

        <div class="propcraft-field">
          <span>{t('tags.toProperty.mode')}</span>
          <div class="propcraft-radios">
            <label class="propcraft-check">
              <input type="radio" name="propcraft-tagprop-mode" checked={mode === 'scalar'} onChange={() => setMode('scalar')} />
              {t('tags.toProperty.mode.scalar')}
            </label>
            <label class="propcraft-check">
              <input type="radio" name="propcraft-tagprop-mode" checked={mode === 'list'} onChange={() => setMode('list')} />
              {t('tags.toProperty.mode.list')}
            </label>
          </div>
          {mode === 'list' ? <div class="propcraft-muted">{t('tags.toProperty.listOrderHint')}</div> : null}
        </div>

        <div class="propcraft-group">
          <div class="propcraft-section-title">{t('tags.toProperty.sourcesTitle')}</div>
          <datalist id="propcraft-real-tags-list">
            {realTagList.map(node => <option key={node.id} value={node.displayTag} />)}
          </datalist>
          {rows.map((row, index) => (
            <div class="propcraft-tagprop-rule" key={row.id}>
              <input
                class="propcraft-input"
                list="propcraft-real-tags-list"
                placeholder="#tag"
                value={row.tag}
                onInput={event => updateRow(row.id, { tag: event.currentTarget.value })}
              />
              <select
                class="propcraft-input"
                value={row.valueType}
                onChange={event => updateRow(row.id, { valueType: event.currentTarget.value as TargetType, valueText: '' })}
              >
                <option value="text">text</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
              </select>
              {row.valueType === 'boolean' ? (
                <select
                  class="propcraft-input"
                  value={row.valueText}
                  onChange={event => updateRow(row.id, { valueText: event.currentTarget.value })}
                >
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  class="propcraft-input"
                  placeholder={t('mapping.literalValue')}
                  value={row.valueText}
                  onInput={event => updateRow(row.id, { valueText: event.currentTarget.value })}
                />
              )}
              <div class="propcraft-actions">
                {mode === 'list' ? (
                  <>
                    <button type="button" class="propcraft-link" disabled={index === 0} onClick={() => moveRow(index, -1)}>{t('tags.toProperty.moveUp')}</button>
                    <button type="button" class="propcraft-link" disabled={index === rows.length - 1} onClick={() => moveRow(index, 1)}>{t('tags.toProperty.moveDown')}</button>
                  </>
                ) : null}
                <button
                  type="button"
                  class="propcraft-link mod-danger"
                  onClick={() => setRows(current => current.filter(item => item.id !== row.id))}
                >
                  {t('tags.toProperty.removeRule')}
                </button>
              </div>
            </div>
          ))}
          <button type="button" class="propcraft-btn" onClick={addRule}>{t('tags.toProperty.addRule')}</button>
        </div>

        <div class="propcraft-group">
          <label class="propcraft-check">
            <input
              type="checkbox"
              checked={removeSourceTags}
              onChange={event => setRemoveSourceTags(event.currentTarget.checked)}
            />
            {t('tags.toProperty.remove')}
          </label>
          <div class="propcraft-muted">{t('tags.toProperty.removeHint')}</div>
        </div>

        <div class="propcraft-muted">{t('tags.toProperty.estimate', { notes: estimatedNotes })}</div>
        <div class="propcraft-muted">{t('tags.references.unchecked')}</div>
        {error ? <div class="propcraft-warn" role="alert">{error}</div> : null}
      </div>

      <div class="propcraft-drawer-actions">
        <button class="propcraft-btn" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          class="propcraft-btn mod-cta"
          onClick={() => {
            const built = build();
            if (built.error) setError(built.error);
            else if (built.operation) onGenerate(built.operation);
          }}
        >
          {t('tags.toProperty.generate')}
        </button>
      </div>
    </Dialog>
  );
}
