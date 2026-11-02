/**
 * PDF Parsing Provider Type Definitions
 */

/**
 * PDF Provider IDs
 */
export type PDFProviderId = 'unpdf' | 'mineru' | 'mineru-cloud' | 'alidocmind' | 'vision-ocr';

/**
 * PDF Provider Configuration
 */
export interface PDFProviderConfig {
  id: PDFProviderId;
  name: string;
  requiresApiKey: boolean;
  baseUrl?: string;
  icon?: string;
  features: string[]; // ['text', 'images', 'tables', 'formulas', 'layout-analysis', etc.]
}

/**
 * PDF Parser Configuration for API calls
 */
export interface PDFParserConfig {
  providerId: PDFProviderId;
  /**
   * For cloud parsers this is the parser service's key. For `vision-ocr` it
   * doubles as the language-model key (that provider IS a model call), so the
   * existing settings form and route plumbing carry its credentials unchanged.
   */
  apiKey?: string;
  /** Parser service endpoint; for `vision-ocr`, the language-model endpoint. */
  baseUrl?: string;
  /**
   * Language model to transcribe pages with, for providers that call a model
   * (`vision-ocr`). Empty falls back to server-managed model resolution.
   */
  model?: string;
  /** Aliyun AccessKey ID (AliDocMind) */
  accessKeyId?: string;
  /** Aliyun AccessKey Secret (AliDocMind) */
  accessKeySecret?: string;
  /**
   * Allow AliDocMind to fall back to ALIDOCMIND_ACCESS_KEY_ID/SECRET env vars.
   * Off by default; enable only in a trusted server/dev/test context.
   */
  allowEnvFallback?: boolean;
  /** Skip image extraction when the caller needs text only. */
  textOnly?: boolean;
  /**
   * The base URL is server configuration, not caller input: it may reach a
   * local network without ALLOW_LOCAL_NETWORKS (cloud metadata stays refused).
   */
  managed?: boolean;
}

// Note: ParsedPdfContent is imported from @/lib/types/pdf to avoid duplication
