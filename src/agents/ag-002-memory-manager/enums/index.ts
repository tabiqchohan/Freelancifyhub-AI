/** Canonical enums for the AG-002 Shared Memory Manager (spec §4–§18). */

/** The eleven architecture-defined memory types (spec §4, prompt §2). */
export enum MemoryType {
  /** In-request working memory for the active plan. */
  ShortTerm = 'SHORT_TERM',
  /** Per-thread interaction history for continuity. */
  Conversation = 'CONVERSATION',
  /** Preferences, consent and identity preferences. */
  User = 'USER',
  /** Project/proposal/engagement state. */
  Project = 'PROJECT',
  /** Per-agent/team operational state. */
  Workspace = 'WORKSPACE',
  /** Org-level shared context. */
  Organization = 'ORGANIZATION',
  /** Pointers to knowledge-base documents (never copies). */
  KnowledgeReference = 'KNOWLEDGE_REFERENCE',
  /** Ephemeral scratch (mid-work artifacts). */
  Temporary = 'TEMPORARY',
  /** Active session context (device, session token refs). */
  Session = 'SESSION',
  /** Durable entity state + consolidated summaries. */
  LongTerm = 'LONG_TERM',
  /** Cold storage for compliance/legal (immutable). */
  Archived = 'ARCHIVED',
}

/** Lifecycle states of a memory record (spec §5, prompt §5). */
export enum MemoryLifecycleState {
  /** Pre-persist creation phase; transitions immediately to Active. */
  Created = 'CREATED',
  /** Live, readable state. */
  Active = 'ACTIVE',
  /** TTL exceeded; unreachable by normal reads. */
  Expired = 'EXPIRED',
  /** Moved to the cold/archive tier. */
  Archived = 'ARCHIVED',
  /** Terminal state (logical delete or hard purge). */
  Deleted = 'DELETED',
}

/** Architecture-defined priority model (spec §4, prompt §10). */
export enum MemoryPriority {
  Low = 'LOW',
  Medium = 'MEDIUM',
  High = 'HIGH',
  Critical = 'CRITICAL',
}

/** Architecture-defined security classification (spec §4, prompt §8). */
export enum MemorySecurityLevel {
  /** Internal operational data (not user content). */
  Internal = 'INTERNAL',
  /** Contains user/confidential content; requires audit + TLS. */
  Confidential = 'CONFIDENTIAL',
}

/** Access permissions in the architecture access matrix (spec §7). */
export enum MemoryPermission {
  Read = 'READ',
  Write = 'WRITE',
  Update = 'UPDATE',
  Delete = 'DELETE',
}

/** Ownership kinds for typed memory ownership (spec §6, prompt §6). */
export enum MemoryOwnerKind {
  User = 'USER',
  Project = 'PROJECT',
  Workspace = 'WORKSPACE',
  Organization = 'ORGANIZATION',
  Agent = 'AGENT',
  System = 'SYSTEM',
}

/** Agent groups used by the access matrix (spec §7). */
export enum MemoryActorGroup {
  /** AG-001 Master Orchestrator. */
  Orchestrator = 'ORCHESTRATOR',
  /** AG-002 Memory Manager. */
  MemoryManager = 'MEMORY_MANAGER',
  /** Client agents (blueprint agent catalog). */
  Client = 'CLIENT',
  /** Freelancer agents. */
  Freelancer = 'FREELANCER',
  /** Marketplace agents. */
  Marketplace = 'MARKETPLACE',
  /** Marketing agents. */
  Marketing = 'MARKETING',
  /** Admin agents. */
  Admin = 'ADMIN',
}

/** Storage tiers in the architecture storage strategy (spec §18). */
export enum StorageTier {
  /** Recent active keys (cache + KV). */
  Hot = 'HOT',
  /** Embeddings + metadata (future retrieval). */
  Warm = 'WARM',
  /** Archived records + event log. */
  Cold = 'COLD',
}
