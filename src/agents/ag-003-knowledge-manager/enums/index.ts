/** Canonical enums for the AG-003 Knowledge Manager subsystem (Sprint 15). */

/** Knowledge document lifecycle states. */
export enum KnowledgeLifecycleState {
  Active = 'ACTIVE',
  Archived = 'ARCHIVED',
  Expired = 'EXPIRED',
  Deleted = 'DELETED',
}

/** Knowledge source types — extensible via string values. */
export enum KnowledgeSourceType {
  ManualText = 'manual_text',
  Markdown = 'markdown',
  Document = 'document',
  UrlReference = 'url_reference',
  ApplicationGenerated = 'application_generated',
  System = 'system',
}

/** Security classification for knowledge documents. */
export enum KnowledgeSecurityLevel {
  Internal = 'INTERNAL',
  Confidential = 'CONFIDENTIAL',
}

/** Permission kinds for knowledge operations. */
export enum KnowledgePermission {
  Read = 'READ',
  Create = 'CREATE',
  UpdateVersion = 'UPDATE_VERSION',
  Archive = 'ARCHIVE',
  Restore = 'RESTORE',
  Expire = 'EXPIRE',
  DeleteErase = 'DELETE_ERASE',
  LifecycleManage = 'LIFECYCLE_MANAGE',
}

/** Actor groups that may interact with knowledge. */
export enum KnowledgeActorGroup {
  Orchestrator = 'ORCHESTRATOR',
  MemoryManager = 'MEMORY_MANAGER',
  KnowledgeManager = 'KNOWLEDGE_MANAGER',
  Client = 'CLIENT',
  Freelancer = 'FREELANCER',
  Marketplace = 'MARKETPLACE',
  Marketing = 'MARKETING',
  Admin = 'ADMIN',
}

/** Event types emitted by the knowledge subsystem. */
export enum KnowledgeEventType {
  Created = 'KNOWLEDGE_CREATED',
  VersionCreated = 'KNOWLEDGE_VERSION_CREATED',
  Updated = 'KNOWLEDGE_UPDATED',
  Archived = 'KNOWLEDGE_ARCHIVED',
  Restored = 'KNOWLEDGE_RESTORED',
  Expired = 'KNOWLEDGE_EXPIRED',
  Deleted = 'KNOWLEDGE_DELETED',
  Retrieved = 'KNOWLEDGE_RETRIEVED',
  AccessDenied = 'KNOWLEDGE_ACCESS_DENIED',
}

/** Content types supported by knowledge documents. */
export enum KnowledgeContentType {
  PlainText = 'plain_text',
  Markdown = 'markdown',
  Json = 'json',
  Html = 'html',
}
