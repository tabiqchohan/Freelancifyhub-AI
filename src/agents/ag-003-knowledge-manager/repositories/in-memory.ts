import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentFilter,
  KnowledgeDocumentPage,
  KnowledgePagination,
  KnowledgeVersion,
} from '../types/index.js';

/**
 * In-memory repository for knowledge documents, versions, and chunks.
 * Non-durable — test infrastructure only.
 */
export class InMemoryKnowledgeRepository {
  readonly name = 'in-memory-knowledge-repository';
  private readonly documents = new Map<string, KnowledgeDocument>();
  private readonly versions = new Map<string, KnowledgeVersion[]>();
  private readonly chunks = new Map<string, KnowledgeChunk[]>();

  async create(document: KnowledgeDocument): Promise<KnowledgeDocument> {
    const existing = this.findByNamespaceTitle(document.namespace, document.title);
    if (existing !== undefined) {
      throw new Error(
        `Document with title "${document.title}" already exists in namespace "${document.namespace}"`,
      );
    }
    this.documents.set(document.id, document);
    return document;
  }

  async getById(id: string): Promise<KnowledgeDocument | undefined> {
    return this.documents.get(id);
  }

  async getCurrentVersion(documentId: string): Promise<KnowledgeVersion | undefined> {
    const versions = this.versions.get(documentId);
    if (versions === undefined || versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  async getVersion(
    documentId: string,
    versionNumber: number,
  ): Promise<KnowledgeVersion | undefined> {
    const versions = this.versions.get(documentId);
    if (versions === undefined) return undefined;
    return versions.find((v) => v.versionNumber === versionNumber);
  }

  async createVersion(version: KnowledgeVersion): Promise<KnowledgeVersion> {
    const existing = await this.getVersion(version.documentId, version.versionNumber);
    if (existing !== undefined) {
      throw new Error(
        `Version ${version.versionNumber} already exists for document ${version.documentId}`,
      );
    }
    const versions = this.versions.get(version.documentId) ?? [];
    versions.push(version);
    this.versions.set(version.documentId, versions);
    return version;
  }

  async listVersions(documentId: string): Promise<readonly KnowledgeVersion[]> {
    return [...(this.versions.get(documentId) ?? [])].sort(
      (a, b) => a.versionNumber - b.versionNumber,
    );
  }

  async updateDocument(document: KnowledgeDocument): Promise<KnowledgeDocument> {
    this.documents.set(document.id, document);
    return document;
  }

  async list(
    filter: KnowledgeDocumentFilter = {},
    pagination: KnowledgePagination = { offset: 0, limit: 50 },
  ): Promise<KnowledgeDocumentPage> {
    let items = Array.from(this.documents.values());

    if (filter.namespace !== undefined) {
      items = items.filter((d) => d.namespace === filter.namespace);
    }
    if (filter.lifecycle !== undefined) {
      items = items.filter((d) => d.lifecycle === filter.lifecycle);
    }
    if (filter.securityLevel !== undefined) {
      items = items.filter((d) => d.securityLevel === filter.securityLevel);
    }
    if (filter.contentType !== undefined) {
      items = items.filter((d) => d.contentType === filter.contentType);
    }
    if (filter.createdBy !== undefined) {
      items = items.filter((d) => d.createdBy === filter.createdBy);
    }

    items.sort((a, b) => {
      const sortBy = pagination.sortBy ?? 'created_at';
      const dir = pagination.sortDirection === 'desc' ? -1 : 1;
      const key =
        sortBy === 'updated_at' ? 'updatedAt' : sortBy === 'title' ? 'title' : 'createdAt';
      const aVal = a[key];
      const bVal = b[key];
      if (aVal === bVal) return 0;
      return aVal < bVal ? -dir : dir;
    });

    const total = items.length;
    const offset = Math.max(0, pagination.offset);
    const limit = Math.max(1, pagination.limit);
    const paged = items.slice(offset, offset + limit);

    return {
      items: paged,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  async deleteDocument(id: string): Promise<boolean> {
    return this.documents.delete(id);
  }

  async createChunks(chunks: readonly KnowledgeChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const existing = this.chunks.get(chunk.versionId) ?? [];
      existing.push(chunk);
      this.chunks.set(chunk.versionId, existing);
    }
  }

  async getChunksByVersionId(versionId: string): Promise<readonly KnowledgeChunk[]> {
    return [...(this.chunks.get(versionId) ?? [])].sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async getChunksByDocumentId(documentId: string): Promise<readonly KnowledgeChunk[]> {
    const allChunks: KnowledgeChunk[] = [];
    for (const chunks of this.chunks.values()) {
      if (chunks.length > 0 && chunks[0]?.documentId === documentId) {
        allChunks.push(...chunks);
      }
    }
    return allChunks.sort(
      (a, b) => b.versionNumber - a.versionNumber || a.chunkIndex - b.chunkIndex,
    );
  }

  async healthAsync(): Promise<{ healthy: boolean; message: string }> {
    return { healthy: true, message: 'in-memory knowledge repository healthy' };
  }

  async eraseByNamespace(namespace: string): Promise<number> {
    let count = 0;
    for (const [id, doc] of this.documents) {
      if (doc.namespace === namespace) {
        this.documents.delete(id);
        this.versions.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Test helper: clears all data. */
  clear(): void {
    this.documents.clear();
    this.versions.clear();
    this.chunks.clear();
  }

  private findByNamespaceTitle(namespace: string, title: string): KnowledgeDocument | undefined {
    for (const doc of this.documents.values()) {
      if (doc.namespace === namespace && doc.title === title) {
        return doc;
      }
    }
    return undefined;
  }
}
