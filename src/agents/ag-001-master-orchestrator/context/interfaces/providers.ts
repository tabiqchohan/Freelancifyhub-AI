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
