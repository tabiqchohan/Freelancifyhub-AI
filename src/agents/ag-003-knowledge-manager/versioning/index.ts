import type { KnowledgeDocument, KnowledgeVersion } from '../types/index.js';
import { createKnowledgeVersionId } from '../utils/ids.js';
import { computeContentHash } from '../utils/checksum.js';

/**
 * Deterministic versioning for knowledge documents.
 * Version numbers start at 1 and are monotonically increasing.
 * Historical versions are immutable — creating a new version does not
 * overwrite any previous version.
 */

/** Creates the initial version (v1) for a new document. */
export function createInitialVersion(
  document: KnowledgeDocument,
  createdBy: string,
): KnowledgeVersion {
  return {
    id: createKnowledgeVersionId(),
    documentId: document.id,
    versionNumber: 1,
    title: document.title,
    content: document.content,
    contentType: document.contentType,
    source: document.source,
    metadata: document.metadata,
    securityLevel: document.securityLevel,
    contentHash: document.contentHash,
    createdAt: document.createdAt,
    createdBy,
    traceId: document.traceId,
  };
}

/** Creates a new version from updated document data. */
export function createNewVersion(
  documentId: string,
  previousVersion: KnowledgeVersion,
  newContent: string,
  newTitle: string,
  metadata: KnowledgeDocument['metadata'],
  contentType: KnowledgeDocument['contentType'],
  securityLevel: KnowledgeDocument['securityLevel'],
  source: KnowledgeDocument['source'],
  createdBy: string,
  createdAt: string,
  traceId: string,
): KnowledgeVersion {
  return {
    id: createKnowledgeVersionId(),
    documentId,
    versionNumber: previousVersion.versionNumber + 1,
    title: newTitle,
    content: newContent,
    contentType,
    source,
    metadata,
    securityLevel,
    contentHash: computeContentHash(newContent),
    createdAt,
    createdBy,
    traceId,
  };
}

/** Result of creating a new document version. */
export interface VersionCreationResult {
  readonly document: KnowledgeDocument;
  readonly version: KnowledgeVersion;
}

/** Result of getting version information. */
export interface VersionRetrievalResult {
  readonly current: KnowledgeVersion;
  readonly versions: readonly KnowledgeVersion[];
}
