import { en, type TextKey, type Translate } from '../i18n';
export function issueText(t: Translate, code?: string): string {
  const key = `issue.${code ?? 'no-change'}`;
  return t(Object.prototype.hasOwnProperty.call(en, key) ? key as TextKey : 'issue.journal-invalid');
}
export function stateText(t: Translate, state: string): string {
  const key = `state.${state}`;
  return Object.prototype.hasOwnProperty.call(en, key) ? t(key as TextKey) : state;
}
