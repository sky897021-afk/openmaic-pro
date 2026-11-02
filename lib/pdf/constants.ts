/**
 * PDF Provider Constants
 * Separated from pdf-providers.ts to avoid importing sharp in client components
 */

import type { PDFProviderId, PDFProviderConfig } from './types';

export const MINERU_CLOUD_DEFAULT_BASE = 'https://mineru.net/api/v4';
export const ALIDOCMIND_DEFAULT_BASE = 'https://docmind-api.cn-hangzhou.aliyuncs.com';

/**
 * PDF Provider Registry
 */
export const PDF_PROVIDERS: Record<PDFProviderId, PDFProviderConfig> = {
  unpdf: {
    id: 'unpdf',
    name: 'unpdf',
    requiresApiKey: false,
    icon: '/logos/unpdf.svg',
    features: ['text', 'images', 'metadata'],
  },

  mineru: {
    id: 'mineru',
    name: 'MinerU',
    requiresApiKey: false,
    icon: '/logos/mineru.png',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis'],
  },

  'mineru-cloud': {
    id: 'mineru-cloud',
    name: 'MinerU (Cloud)',
    requiresApiKey: true,
    icon: '/logos/mineru.png',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis'],
  },

  alidocmind: {
    id: 'alidocmind',
    name: 'AliDocMind',
    requiresApiKey: true,
    icon: '/logos/aliyun.svg',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis', 'ocr'],
  },

  // Local first pass (unpdf text layer), then a vision model for the pages that
  // have no text. `requiresApiKey: false` because credentials are optional: a
  // request may carry its own model/endpoint/key, and otherwise the call falls
  // back to the server-managed model — so this provider must NOT be rejected by
  // parsePDF's requiresApiKey gate when nothing is filled in. Listed last so it
  // never displaces unpdf as the default.
  'vision-ocr': {
    id: 'vision-ocr',
    name: 'Vision OCR',
    requiresApiKey: false,
    features: ['text', 'images', 'tables', 'formulas', 'ocr'],
  },
};

/**
 * Get all available PDF providers
 */
export function getAllPDFProviders(): PDFProviderConfig[] {
  return Object.values(PDF_PROVIDERS);
}

/**
 * Get PDF provider by ID
 */
export function getPDFProvider(providerId: PDFProviderId): PDFProviderConfig | undefined {
  return PDF_PROVIDERS[providerId];
}
