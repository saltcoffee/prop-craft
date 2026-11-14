import { parse, stringify } from 'yaml';
export class TFile {}
export class TFolder {}
export const normalizePath = (path: string): string => path.replace(/\/+/g, '/');
export const parseYaml = (source: string): unknown => parse(source, { uniqueKeys: true });
export const stringifyYaml = (value: unknown): string => stringify(value);
export function getFrontMatterInfo(source: string) {
  const first = /^---[ \t]*\r?\n/.exec(source);
  if (first) {
    const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
    close.lastIndex = first[0].length;
    const end = close.exec(source);
    if (end) return { exists: true, frontmatter: source.slice(first[0].length, end.index), from: first[0].length, to: end.index, contentStart: end.index + end[0].length };
  }
  return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
}
