export interface PropCraftSettings {
  orphanThreshold: number;
  duplicateSimilarityThreshold: number;
  excludeGlobs: string[];
  excludeTemplates: boolean;
  templateFolder: string;
  duplicateIgnoreList: string[];
  writeConcurrency: number;
  journalMaxTransactions: number;
  journalMaxBytes: number;
  debugLogging: boolean;
  locale: 'auto' | 'zh' | 'en';
  dateRegionFormat: 'MDY' | 'DMY' | 'YMD';
}

export const DEFAULT_SETTINGS: PropCraftSettings = {
  orphanThreshold: 1,
  duplicateSimilarityThreshold: 0.8,
  excludeGlobs: ['.trash/**'],
  excludeTemplates: true,
  templateFolder: '',
  duplicateIgnoreList: [],
  writeConcurrency: 8,
  journalMaxTransactions: 10,
  journalMaxBytes: 50 * 1024 * 1024,
  debugLogging: false,
  locale: 'auto',
  dateRegionFormat: 'MDY',
};
