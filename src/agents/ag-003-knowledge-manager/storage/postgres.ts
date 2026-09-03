import type pg from 'pg';
import { KnowledgeStorageError, KnowledgeConflictError } from '../errors/index.js';
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentFilter,
  KnowledgeDocumentPage,
  KnowledgePagination,
  KnowledgeVersion,
} from '../types/index.js';
import { migrateKnowledgeSchema, KNOWLEDGE_SCHEMA_VERSION } from './schema.js';

/**
 * AG-003 PostgreSQL repository. Operates on the shared Neon pool alongside
 * AG-002's memory_records. Uses its own set of tables (knowledge_*).
 * No credentials or connection strings are logged.
 */

export interface PostgresKnowledgeRepositoryOptions {
  readonly pool: pg.Pool;
}

function rowToDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    title: String(row.title),
    content: String(row.content),
    contentType: String(row.content_type) as KnowledgeDocument['contentType'],
    source: (typeof row.source === 'string'
      ? JSON.parse(row.source)
      : row.source) as KnowledgeDocument['source'],
    metadata: (typeof row.metadata === 'string'
      ? JSON.parse(row.metadata as string)
      : row.metadata) as KnowledgeDocument['metadata'],
    lifecycle: String(row.lifecycle) as KnowledgeDocument['lifecycle'],
    securityLevel: String(row.security_level) as KnowledgeDocument['securityLevel'],
    version: Number(row.version),
    contentHash: String(row.content_hash),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    createdBy: String(row.created_by),
    updatedBy: String(row.updated_by),
    traceId: String(row.trace_id),
  };
}

function rowToVersion(row: Record<string, unknown>): KnowledgeVersion {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    versionNumber: Number(row.version_number),
    title: String(row.title),
    content: String(row.content),
    contentType: String(row.content_type) as KnowledgeVersion['contentType'],
    source: (typeof row.source === 'string'
      ? JSON.parse(row.source)
      : row.source) as KnowledgeVersion['source'],
    metadata: (typeof row.metadata === 'string'
      ? JSON.parse(row.metadata as string)
      : row.metadata) as KnowledgeVersion['metadata'],
    securityLevel: String(row.security_level) as KnowledgeVersion['securityLevel'],
    contentHash: String(row.content_hash),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    traceId: String(row.trace_id),
  };
}

function rowToChunk(row: Record<string, unknown>): KnowledgeChunk {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    versionId: String(row.version_id),
    versionNumber: Number(row.version_number),
    chunkIndex: Number(row.chunk_index),
    content: String(row.content),
    contentHash: String(row.content_hash),
    metadata: (typeof row.metadata === 'string'
      ? JSON.parse(row.metadata as string)
      : row.metadata) as KnowledgeChunk['metadata'],
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * Real PostgreSQL repository for knowledge documents, versions, and chunks.
 */
export class PostgresKnowledgeRepository {
  readonly name = 'postgres-knowledge-repository';
  private readonly pool: pg.Pool;

  constructor(options: PostgresKnowledgeRepositoryOptions) {
    this.pool = options.pool;
  }

  get poolForRepository(): pg.Pool {
    return this.pool;
  }

  /** Apply knowledge schema migrations. */
  async migrate(): Promise<number> {
    return migrateKnowledgeSchema(this.pool);
  }

  /** Create a new document. */
  async create(document: KnowledgeDocument): Promise<KnowledgeDocument> {
    const sql = `INSERT INTO knowledge_documents
      (id, namespace, title, content, content_type, source, metadata, lifecycle, security_level, version, content_hash, created_at, updated_at, created_by, updated_by, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`;
    const params = [
      document.id,
      document.namespace,
      document.title,
      document.content,
      document.contentType,
      JSON.stringify(document.source),
      JSON.stringify(document.metadata),
      document.lifecycle,
      document.securityLevel,
      document.version,
      document.contentHash,
      document.createdAt,
      document.updatedAt,
      document.createdBy,
      document.updatedBy,
      document.traceId,
    ];
    try {
      const res = await this.pool.query(sql, params);
      return rowToDocument(res.rows[0] as Record<string, unknown>);
    } catch (err: unknown) {
      const error = err as { code?: string; constraint?: string; message?: string };
      if (error.code === '23505' || (error.constraint ?? '').includes('namespace_title')) {
        throw new KnowledgeConflictError(
          `Document with title "${document.title}" already exists in namespace "${document.namespace}"`,
          { details: { namespace: document.namespace, title: document.title } },
        );
      }
      throw new KnowledgeStorageError('Failed to create knowledge document', { cause: err });
    }
  }

  /** Get a document by ID. */
  async getById(id: string): Promise<KnowledgeDocument | undefined> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_documents WHERE id = $1',
      [id],
    );
    if (res.rows.length === 0) return undefined;
    return rowToDocument(res.rows[0]!);
  }

  /** Get the current (latest) version for a document. */
  async getCurrentVersion(documentId: string): Promise<KnowledgeVersion | undefined> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1',
      [documentId],
    );
    if (res.rows.length === 0) return undefined;
    return rowToVersion(res.rows[0]!);
  }

  /** Get a specific version by document ID and version number. */
  async getVersion(
    documentId: string,
    versionNumber: number,
  ): Promise<KnowledgeVersion | undefined> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, versionNumber],
    );
    if (res.rows.length === 0) return undefined;
    return rowToVersion(res.rows[0]!);
  }

  /** Create a version record. */
  async createVersion(version: KnowledgeVersion): Promise<KnowledgeVersion> {
    const sql = `INSERT INTO knowledge_versions
      (id, document_id, version_number, title, content, content_type, source, metadata, security_level, content_hash, created_at, created_by, trace_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`;
    const params = [
      version.id,
      version.documentId,
      version.versionNumber,
      version.title,
      version.content,
      version.contentType,
      JSON.stringify(version.source),
      JSON.stringify(version.metadata),
      version.securityLevel,
      version.contentHash,
      version.createdAt,
      version.createdBy,
      version.traceId,
    ];
    try {
      const res = await this.pool.query(sql, params);
      return rowToVersion(res.rows[0] as Record<string, unknown>);
    } catch (err: unknown) {
      const error = err as { code?: string; constraint?: string; message?: string };
      if (error.code === '23505' || (error.constraint ?? '').includes('version_unique')) {
        throw new KnowledgeConflictError(
          `Version ${version.versionNumber} already exists for document ${version.documentId}`,
          { details: { documentId: version.documentId, versionNumber: version.versionNumber } },
        );
      }
      throw new KnowledgeStorageError('Failed to create knowledge version', { cause: err });
    }
  }

  /** List versions for a document. */
  async listVersions(documentId: string): Promise<readonly KnowledgeVersion[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_versions WHERE document_id = $1 ORDER BY version_number ASC',
      [documentId],
    );
    return res.rows.map((r) => rowToVersion(r));
  }

  /** Update document (lifecycle, version, etc.). */
  async updateDocument(document: KnowledgeDocument): Promise<KnowledgeDocument> {
    const sql = `UPDATE knowledge_documents SET
      title = $2, content = $3, content_type = $4, source = $5, metadata = $6,
      lifecycle = $7, security_level = $8, version = $9, content_hash = $10,
      updated_at = $11, updated_by = $12, trace_id = $13
      WHERE id = $1 RETURNING *`;
    const params = [
      document.id,
      document.title,
      document.content,
      document.contentType,
      JSON.stringify(document.source),
      JSON.stringify(document.metadata),
      document.lifecycle,
      document.securityLevel,
      document.version,
      document.contentHash,
      document.updatedAt,
      document.updatedBy,
      document.traceId,
    ];
    try {
      const res = await this.pool.query(sql, params);
      if (res.rows.length === 0) {
        return document;
      }
      return rowToDocument(res.rows[0] as Record<string, unknown>);
    } catch (err) {
      throw new KnowledgeStorageError('Failed to update knowledge document', { cause: err });
    }
  }

  /** List documents with filtering and pagination. */
  async list(
    filter: KnowledgeDocumentFilter = {},
    pagination: KnowledgePagination = { offset: 0, limit: 50 },
  ): Promise<KnowledgeDocumentPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.namespace !== undefined) {
      params.push(filter.namespace);
      conditions.push(`namespace = $${params.length}`);
    }
    if (filter.lifecycle !== undefined) {
      params.push(filter.lifecycle);
      conditions.push(`lifecycle = $${params.length}`);
    }
    if (filter.securityLevel !== undefined) {
      params.push(filter.securityLevel);
      conditions.push(`security_level = $${params.length}`);
    }
    if (filter.contentType !== undefined) {
      params.push(filter.contentType);
      conditions.push(`content_type = $${params.length}`);
    }
    if (filter.createdBy !== undefined) {
      params.push(filter.createdBy);
      conditions.push(`created_by = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = pagination.sortBy ?? 'created_at';
    const sortDir = pagination.sortDirection ?? 'asc';
    const orderClause = `ORDER BY ${sortBy} ${sortDir} NULLS LAST`;

    const countRes = await this.pool.query<{ count: string | number }>(
      `SELECT count(*)::bigint as count FROM knowledge_documents ${whereClause}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const limit = Math.max(1, Math.min(pagination.limit, 100));
    const offset = Math.max(0, pagination.offset);

    const dataRes = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM knowledge_documents ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    return {
      items: dataRes.rows.map((r) => rowToDocument(r)),
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  /** Delete a document (hard delete). */
  async deleteDocument(id: string): Promise<boolean> {
    const res = await this.pool.query(
      'DELETE FROM knowledge_documents WHERE id = $1 RETURNING id',
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Create chunks for a version. */
  async createChunks(chunks: readonly KnowledgeChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const sql = `INSERT INTO knowledge_chunks
      (id, document_id, version_id, version_number, chunk_index, content, content_hash, metadata, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    for (const chunk of chunks) {
      try {
        await this.pool.query(sql, [
          chunk.id,
          chunk.documentId,
          chunk.versionId,
          chunk.versionNumber,
          chunk.chunkIndex,
          chunk.content,
          chunk.contentHash,
          JSON.stringify(chunk.metadata),
          chunk.createdAt,
        ]);
      } catch (err) {
        throw new KnowledgeStorageError('Failed to create knowledge chunk', { cause: err });
      }
    }
  }

  /** Get chunks for a version. */
  async getChunksByVersionId(versionId: string): Promise<readonly KnowledgeChunk[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_chunks WHERE version_id = $1 ORDER BY chunk_index ASC',
      [versionId],
    );
    return res.rows.map((r) => rowToChunk(r));
  }

  /** Get chunks for a document. */
  async getChunksByDocumentId(documentId: string): Promise<readonly KnowledgeChunk[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM knowledge_chunks WHERE document_id = $1 ORDER BY version_number DESC, chunk_index ASC',
      [documentId],
    );
    return res.rows.map((r) => rowToChunk(r));
  }

  /** Health check — no credentials surfaced. */
  async healthAsync(): Promise<{ healthy: boolean; version: number; message: string }> {
    try {
      await this.pool.query('SELECT 1');
      return {
        healthy: true,
        version: KNOWLEDGE_SCHEMA_VERSION,
        message: 'knowledge repository healthy',
      };
    } catch {
      return {
        healthy: false,
        version: 0,
        message: 'knowledge repository unavailable',
      };
    }
  }

  /** Erase all knowledge in a namespace. */
  async eraseByNamespace(namespace: string): Promise<number> {
    const res = await this.pool.query('DELETE FROM knowledge_documents WHERE namespace = $1', [
      namespace,
    ]);
    return res.rowCount ?? 0;
  }

  /** Close the pool. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
