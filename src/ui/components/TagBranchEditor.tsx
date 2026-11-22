import { useMemo, useState } from 'preact/hooks';
import type { MigrateTagBranchOperation } from '../../domain/models';
import type { TagTreeNode, TagTreeView } from '../../domain/tag-tree';
import { compileTagBranch, mapBranchTag } from '../../domain/tag-migration';
import { isTagInBranch } from '../../domain/normalize';
import { issueCode } from '../../domain/errors';
import type { Translate } from '../../i18n';
import { issueText } from '../text';
import { Dialog } from './Dialog';

interface Props {
  tree: TagTreeView;
  sourceNode: TagTreeNode;
  initialIncludeDescendants: boolean;
  initialTarget?: string;
  t: Translate;
  onCancel: () => void;
  onGenerate: (operation: MigrateTagBranchOperation) => void;
}

export function TagBranchEditor({
  tree,
  sourceNode,
  initialIncludeDescendants,
  initialTarget,
  t,
  onCancel,
  onGenerate,
}: Props) {
  const lockedDescendants = sourceNode.virtual;
  const [includeDescendants, setIncludeDescendants] = useState(lockedDescendants ? true : initialIncludeDescendants);
  const [target, setTarget] = useState(initialTarget ?? sourceNode.displayTag);

  const effectiveDescendants = lockedDescendants ? true : includeDescendants;

  const evaluation = useMemo(() => {
    const operation: MigrateTagBranchOperation = {
      kind: 'migrateTagBranch',
      from: sourceNode.displayTag,
      to: target,
      includeDescendants: effectiveDescendants,
    };
    try {
      const compiled = compileTagBranch(operation);
      const sourceNodes = [...tree.nodes.values()]
        .filter(node => !node.virtual && isTagInBranch(node.displayTag, compiled.from, compiled.includeDescendants));
      const noteSet = new Set<string>();
      const rows: {
        sourceId: string;
        variants: readonly string[];
        targets: string[];
        noteCount: number;
        collisionInScope: boolean;
        overlap: boolean;
      }[] = [];

      for (const node of sourceNodes) {
        for (const path of node.directPaths) noteSet.add(path);
        const mappedTargets = new Set<string>();
        let collisionInScope = false;
        let overlap = false;
        if (!compiled.sameIdentity) {
          for (const raw of node.rawVariants) {
            const mapped = mapBranchTag(raw, compiled);
            if (!mapped) continue;
            mappedTargets.add(mapped.toRaw);
            if (mapped.overlap) overlap = true;
            const existing = tree.nodes.get(mapped.targetId);
            if (existing && !existing.virtual) collisionInScope = true;
          }
        }
        rows.push({
          sourceId: node.id,
          variants: node.rawVariants,
          targets: [...mappedTargets],
          noteCount: node.directPaths.length,
          collisionInScope,
          overlap,
        });
      }

      return {
        ok: true as const,
        operation: { ...operation, from: compiled.from, to: compiled.to },
        sameIdentity: compiled.sameIdentity,
        noteCount: noteSet.size,
        rows,
        anyOverlap: rows.some(row => row.overlap),
      };
    } catch (error) {
      return {
        ok: false as const,
        code: issueCode(error, 'tag-path-invalid'),
      };
    }
  }, [tree, sourceNode, target, effectiveDescendants]);

  return (
    <Dialog drawer title={t('tags.migrate.title')} closeLabel={t('common.close')} onClose={onCancel}>
      <div class="propcraft-drawer-body">
        <div class="propcraft-field">
          <span>{t('tags.migrate.source')}</span>
          <strong class="propcraft-path">{sourceNode.displayTag}</strong>
          {sourceNode.virtual ? <div class="propcraft-muted">{t('tags.migrate.virtualLocked')}</div> : null}
        </div>

        <div class="propcraft-field">
          <span>{t('tags.migrate.mode')}</span>
          <div class="propcraft-radios">
            <label class="propcraft-check">
              <input
                type="radio"
                name="propcraft-branch-mode"
                checked={!effectiveDescendants}
                disabled={lockedDescendants}
                onChange={() => setIncludeDescendants(false)}
              />
              {t('tags.migrate.exact')}
            </label>
            <label class="propcraft-check">
              <input
                type="radio"
                name="propcraft-branch-mode"
                checked={effectiveDescendants}
                onChange={() => setIncludeDescendants(true)}
              />
              {t('tags.migrate.descendants')}
            </label>
          </div>
          <div class="propcraft-muted">{t('tags.migrate.modeHint')}</div>
        </div>

        <div class="propcraft-field">
          <label htmlFor="propcraft-branch-target">{t('tags.migrate.target')}</label>
          <input
            id="propcraft-branch-target"
            class="propcraft-input"
            placeholder={t('tags.migrate.targetPlaceholder')}
            value={target}
            onInput={event => setTarget(event.currentTarget.value)}
          />
        </div>

        {!evaluation.ok ? (
          <div class="propcraft-warn" role="alert">{issueText(t, evaluation.code)}</div>
        ) : (
          <>
            {evaluation.sameIdentity ? <div class="propcraft-muted">{t('tags.migrate.sameIdentity')}</div> : null}
            {evaluation.anyOverlap ? <div class="propcraft-warn">{t('tags.migrate.overlapWarn')}</div> : null}
            <div class="propcraft-muted">
              {t('tags.migrate.estimate', { tags: evaluation.rows.length, notes: evaluation.noteCount })}
            </div>
            {!evaluation.sameIdentity && evaluation.rows.length > 0 ? (
              <div class="propcraft-table-wrap">
                <table class="propcraft-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('tags.migrate.col.from')}</th>
                      <th scope="col">{t('tags.migrate.col.to')}</th>
                      <th scope="col" class="num">{t('tags.migrate.col.notes')}</th>
                      <th scope="col">{t('tags.migrate.col.collision')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evaluation.rows.map(row => (
                      <tr key={row.sourceId}>
                        <td class="propcraft-path">{row.variants.join(', ')}</td>
                        <td class="propcraft-path">{row.targets.join(', ')}</td>
                        <td class="num">{row.noteCount}</td>
                        <td>{row.collisionInScope ? t('tags.migrate.fmMergeNote') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}

        <div class="propcraft-muted">{t('tags.references.unchecked')}</div>
      </div>

      <div class="propcraft-drawer-actions">
        <button class="propcraft-btn" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          class="propcraft-btn mod-cta"
          disabled={!evaluation.ok || evaluation.sameIdentity}
          onClick={() => { if (evaluation.ok && !evaluation.sameIdentity) onGenerate(evaluation.operation); }}
        >
          {t('tags.migrate.generate')}
        </button>
      </div>
    </Dialog>
  );
}
