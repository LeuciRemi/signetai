export interface NormalizedMemoryContent {
	storageContent: string;
	normalizedContent: string;
	hashBasis: string;
	contentHash: string;
}

export function normalizeContentForStorage(content: string): string;
export function deriveNormalizedContent(storageContent: string): string;
export function normalizeAndHashContent(
	content: string,
): NormalizedMemoryContent;
