import {
  MemoryActorGroup,
  MemoryPermission,
  MemorySecurityLevel,
  MemoryType,
} from '../enums/index.js';
import type { MemoryNamespace } from '../types/index.js';

/**
 * Memory access control foundation (spec §7, prompt §7). Implements the
 * authorization contract only — no authentication, no identity provider, no
 * user-account integration in this sprint.
 */

/** An actor requesting an operation on memory. */
export interface MemoryActor {
  /** Agent group from the access matrix (spec §7). */
  readonly group: MemoryActorGroup;
  /** Optional stable identity (future identity integration). */
  readonly id?: string;
  /**
   * Explicit allow-list of namespaces this actor may touch. Fail-closed: an
   * actor without a matching entry is denied 100% (spec §7, AC-MEM-2).
   */
  readonly namespaces?: readonly MemoryNamespace[];
}

/** The memory target an access decision is made against. */
export interface MemoryAccessCheckTarget {
  readonly namespace: MemoryNamespace;
  readonly type: MemoryType;
  readonly securityLevel: MemorySecurityLevel;
}

/** Input to a single access decision. */
export interface MemoryAccessCheckInput {
  readonly actor: MemoryActor;
  readonly permission: MemoryPermission;
  readonly target: MemoryAccessCheckTarget;
}

/** Authorization contract (fail-closed by design). */
export interface MemoryAccessPolicy {
  readonly name: string;
  can(input: MemoryAccessCheckInput): boolean;
}

/**
 * The architecture access matrix (spec §7): permissions per agent group ×
 * memory type. `(own)`/`(role)` scope modifiers are represented by the actor's
 * namespace allow-list, not by the matrix. User-memory `W*` grants for
 * AG-002/Admin are consent/retention writes only.
 */
export const MEMORY_ACCESS_MATRIX: Readonly<
  Record<MemoryActorGroup, Readonly<Record<MemoryType, readonly MemoryPermission[]>>>
> = {
  [MemoryActorGroup.Orchestrator]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Read],
    [MemoryType.Project]: [MemoryPermission.Read],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [MemoryPermission.Read],
    [MemoryType.Session]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.LongTerm]: [MemoryPermission.Read],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.MemoryManager]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Conversation]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.User]: [MemoryPermission.Write],
    [MemoryType.Project]: [MemoryPermission.Write],
    [MemoryType.Workspace]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Organization]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read, MemoryPermission.Write],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Archived]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
  },
  [MemoryActorGroup.Client]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.User]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Project]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Write],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Freelancer]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.User]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Project]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Write],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Marketplace]: {
    [MemoryType.ShortTerm]: [MemoryPermission.Read],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Read],
    [MemoryType.Project]: [MemoryPermission.Read, MemoryPermission.Write, MemoryPermission.Update],
    [MemoryType.Workspace]: [MemoryPermission.Read],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read, MemoryPermission.Write],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Write],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Marketing]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Read],
    [MemoryType.Project]: [MemoryPermission.Read],
    [MemoryType.Workspace]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Organization]: [MemoryPermission.Read],
    [MemoryType.KnowledgeReference]: [MemoryPermission.Read],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [MemoryPermission.Read],
    [MemoryType.Archived]: [MemoryPermission.Read],
  },
  [MemoryActorGroup.Admin]: {
    [MemoryType.ShortTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Conversation]: [MemoryPermission.Read],
    [MemoryType.User]: [MemoryPermission.Write],
    [MemoryType.Project]: [MemoryPermission.Read],
    [MemoryType.Workspace]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Organization]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.KnowledgeReference]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Temporary]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
    ],
    [MemoryType.Session]: [MemoryPermission.Read],
    [MemoryType.LongTerm]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
    [MemoryType.Archived]: [
      MemoryPermission.Read,
      MemoryPermission.Write,
      MemoryPermission.Update,
      MemoryPermission.Delete,
    ],
  },
};

/** Deterministic matrix-based policy. Fail-closed on both matrix and scope. */
export class MatrixMemoryAccessPolicy implements MemoryAccessPolicy {
  readonly name = 'matrix-memory-access-policy';

  can(input: MemoryAccessCheckInput): boolean {
    const { actor, permission, target } = input;

    if (!this.matrixGrants(actor.group, target.type, permission)) {
      return false;
    }

    return this.actorHasScope(actor, target.namespace);
  }

  private matrixGrants(
    group: MemoryActorGroup,
    type: MemoryType,
    permission: MemoryPermission,
  ): boolean {
    return (MEMORY_ACCESS_MATRIX[group]?.[type] ?? []).includes(permission);
  }

  private actorHasScope(actor: MemoryActor, namespace: MemoryNamespace): boolean {
    const namespaces = actor.namespaces;
    if (namespaces === undefined || namespaces.length === 0) {
      return false;
    }
    return namespaces.includes(namespace);
  }
}

/** Whether a security level requires audit + encryption controls (AC-MEM-9). */
export function isConfidentialSecurityLevel(level: MemorySecurityLevel): boolean {
  return level === MemorySecurityLevel.Confidential;
}

/** Whether a memory type is classified confidential (spec §4). */
export function isConfidentialType(type: MemoryType): boolean {
  switch (type) {
    case MemoryType.ShortTerm:
    case MemoryType.Workspace:
    case MemoryType.KnowledgeReference:
    case MemoryType.Temporary:
      return false;
    case MemoryType.Conversation:
    case MemoryType.User:
    case MemoryType.Project:
    case MemoryType.Organization:
    case MemoryType.Session:
    case MemoryType.LongTerm:
    case MemoryType.Archived:
      return true;
  }
}
