import type {
  MemoryActorGroup,
  MemoryNamespace,
  MemorySecurityLevel,
} from '../../../ag-002-memory-manager/index.js';
import type { ContextItem, ContextSourceType } from '../types/index.js';

/**
 * Future context-provider contract (prompt §16). These interfaces describe
 * providers such as AG-002 (Memory), AG-003 (Knowledge) and AG-004 (Tool).
 * Sprint 3 defines them only — nothing executes and no provider module is
 * imported.
 */

/** Base contract for any future context provider. */
export interface ContextProvider {
  /** The logical source this provider supplies. */
  readonly source: ContextSourceType;
  /** Returns context items for a request. NOT implemented in Sprint 3. */
  load(): Promise<readonly ContextItem[]>;
}

/** Future memory provider (AG-002). Interface only. */
export interface MemoryContextProvider extends ContextProvider {
  readonly source: ContextSourceType.MEMORY;
  load(input?: MemoryContextLoadInput): Promise<readonly ContextItem[]>;
}

/**
 * Request-scoped input the AG-001 orchestrator passes into the AG-002-backed
 * memory provider (prompt32 final wiring). Maps 1:1 to AG-002's authorisation
 * and retrieval contracts.
 */
export interface MemoryContextLoadInput {
  readonly requestId?: string;
  readonly traceId?: string;
  /** AG-002 actor group (access matrix, spec §7). */
  readonly actorGroup: MemoryActorGroup;
  readonly actorId?: string;
  readonly actorRole?: string;
  /** Actor's authorized namespace allow-list (fail-closed scope). */
  readonly namespaces: readonly MemoryNamespace[];
  readonly query?: string;
  readonly maxResults?: number;
  readonly contextBudgetTokens?: number;
  readonly maxRecordsPerSection?: number;
  readonly snippetLength?: number;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly projectIds?: readonly string[];
  readonly securityClearance?: MemorySecurityLevel;
}

/** Future knowledge provider (AG-003). Interface only. */
export interface KnowledgeContextProvider extends ContextProvider {
  readonly source: ContextSourceType.KNOWLEDGE;
}

/** Future tool provider (AG-004). Interface only. */
export interface ToolContextProvider extends ContextProvider {
  readonly source: ContextSourceType.TOOL;
}

/** Future user provider. Interface only. */
export interface UserContextProvider extends ContextProvider {
  readonly source: ContextSourceType.USER;
}

/** Future project provider. Interface only. */
export interface ProjectContextProvider extends ContextProvider {
  readonly source: ContextSourceType.PROJECT;
}
