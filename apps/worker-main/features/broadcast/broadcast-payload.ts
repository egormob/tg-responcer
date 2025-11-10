export interface BroadcastAudienceFilter {
  readonly chatIds?: readonly string[];
  readonly userIds?: readonly string[];
  readonly languageCodes?: readonly string[];
}

export interface BroadcastMessagePayload {
  readonly text: string;
  readonly filters?: BroadcastAudienceFilter;
  readonly metadata?: Record<string, unknown>;
}

export interface BroadcastPayloadDraft {
  text: string;
  filters?: BroadcastAudienceFilter;
  metadata?: Record<string, unknown>;
}

export interface BuildBroadcastPayloadOptions {
  maxTextLength?: number;
}

export const DEFAULT_MAX_TEXT_LENGTH = 4096;

const cloneMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) {
    return undefined;
  }

  return { ...metadata };
};

const normalizeAudienceList = (
  values: readonly string[] | undefined,
  field: string,
): string[] | undefined => {
  if (values === undefined) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );

  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return normalized;
};

const normalizeFilters = (
  filters: BroadcastAudienceFilter | undefined,
): BroadcastAudienceFilter | undefined => {
  if (!filters) {
    return undefined;
  }

  const chatIds = normalizeAudienceList(filters.chatIds, 'filters.chatIds');
  const userIds = normalizeAudienceList(filters.userIds, 'filters.userIds');
  const languageCodes = normalizeAudienceList(filters.languageCodes, 'filters.languageCodes');

  if (!chatIds && !userIds && !languageCodes) {
    throw new Error('filters must specify at least one selector');
  }

  return { chatIds, userIds, languageCodes } satisfies BroadcastAudienceFilter;
};

export const buildBroadcastPayload = (
  draft: BroadcastPayloadDraft,
  options: BuildBroadcastPayloadOptions = {},
): BroadcastMessagePayload => {
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  const text = draft.text.trim();
  if (text.length === 0) {
    throw new Error('text must not be empty');
  }

  if (text.length > maxTextLength) {
    throw new Error(`text must not exceed ${maxTextLength} characters`);
  }

  const filters = normalizeFilters(draft.filters);
  const metadata = cloneMetadata(draft.metadata);

  return { text, filters, metadata } satisfies BroadcastMessagePayload;
};
