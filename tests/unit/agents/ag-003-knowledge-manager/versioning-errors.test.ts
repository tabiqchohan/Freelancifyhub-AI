import { describe, expect, it } from 'vitest';

import {
  KnowledgeValidationError,
  KnowledgeNotFoundError,
  KnowledgeAccessDeniedError,
  KnowledgeLifecycleTransitionError,
  KnowledgeStorageError,
  KnowledgeConflictError,
  KnowledgeError,
} from '../../../../src/agents/ag-003-knowledge-manager/errors/index.js';
import {
  createInitialVersion,
  createNewVersion,
} from '../../../../src/agents/ag-003-knowledge-manager/versioning/index.js';
import {
  KnowledgeContentType,
  KnowledgeLifecycleState,
  KnowledgeSecurityLevel,
  KnowledgeSourceType,
} from '../../../../src/agents/ag-003-knowledge-manager/enums/index.js';
import { computeContentHash } from '../../../../src/agents/ag-003-knowledge-manager/utils/checksum.js';
import type { KnowledgeDocument } from '../../../../src/agents/ag-003-knowledge-manager/types/index.js';

const errorTypes = [
  KnowledgeValidationError,
  KnowledgeNotFoundError,
  KnowledgeAccessDeniedError,
  KnowledgeLifecycleTransitionError,
  KnowledgeStorageError,
  KnowledgeConflictError,
];

describe('AG-003 errors - hierarchy shape', () => {
  it('every error extends the KnowledgeError base', () => {
    for (const Type of errorTypes) {
      const error = new Type('boom');
      expect(error).toBeInstanceOf(KnowledgeError);
      expect(error).toBeInstanceOf(Type);
      expect(error.name).toBe(Type.name);
    }
  });

  it('carries message, code and retryable default', () => {
    const error = new KnowledgeValidationError('bad');
    expect(error.code).toBe('KNOWLEDGE_VALIDATION_ERROR');
    expect(error.retryable).toBe(false);
  });

  it('storage errors are retryable', () => {
    const error = new KnowledgeStorageError('db down');
    expect(error.retryable).toBe(true);
  });

  it('exposes safe details', () => {
    const error = new KnowledgeAccessDeniedError('denied', { details: { namespace: 'user:1' } });
    expect(error.details).toEqual({ namespace: 'user:1' });
  });
});

function makeDoc(): KnowledgeDocument {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    id: 'knowledge_1',
    namespace: 'user:1',
    title: 'Doc',
    content: 'content',
    contentType: KnowledgeContentType.PlainText,
    source: { sourceType: KnowledgeSourceType.System },
    metadata: {},
    lifecycle: KnowledgeLifecycleState.Active,
    securityLevel: KnowledgeSecurityLevel.Internal,
    version: 1,
    contentHash: computeContentHash('content'),
    createdAt: at,
    updatedAt: at,
    createdBy: 'sys',
    updatedBy: 'sys',
    traceId: 'trace',
  };
}

describe('AG-003 versioning - immutable versions, deterministic numbers', () => {
  it('createInitialVersion starts at version 1', () => {
    const doc = makeDoc();
    const v = createInitialVersion(doc, 'sys');
    expect(v.versionNumber).toBe(1);
    expect(v.documentId).toBe(doc.id);
    expect(v.contentHash).toBe(doc.contentHash);
  });

  it('createNewVersion increments monotonically', () => {
    const doc = makeDoc();
    const v1 = createInitialVersion(doc, 'sys');
    const v2 = createNewVersion(
      doc.id,
      v1,
      'newer content',
      'Doc',
      {},
      KnowledgeContentType.PlainText,
      KnowledgeSecurityLevel.Internal,
      { sourceType: KnowledgeSourceType.System },
      'sys',
      '2026-01-02T00:00:00.000Z',
      'trace',
    );
    expect(v2.versionNumber).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });
});
