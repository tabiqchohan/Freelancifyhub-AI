import type { MemoryConfig } from '../config/schema.js';
import { MemoryPriority, MemorySecurityLevel, MemoryType } from '../enums/index.js';
import type { MemoryRetentionPolicy } from '../types/index.js';

/**
 * Per-type classification defaults derived from the architecture attribute
 * table (spec §4): priority, security level, retention policy, default TTL and
 * size cap. Single source of truth for the record defaults the service applies
 * when the caller does not supply an explicit value.
 */

/** Default priority per memory type (spec §4). */
export function defaultPriorityFor(type: MemoryType): MemoryPriority {
  switch (type) {
    case MemoryType.User:
    case MemoryType.Project:
      return MemoryPriority.Critical;
    case MemoryType.ShortTerm:
    case MemoryType.Conversation:
    case MemoryType.KnowledgeReference:
    case MemoryType.LongTerm:
      return MemoryPriority.High;
    case MemoryType.Workspace:
    case MemoryType.Organization:
    case MemoryType.Session:
      return MemoryPriority.Medium;
    case MemoryType.Temporary:
    case MemoryType.Archived:
      return MemoryPriority.Low;
  }
}

/** Default security classification per memory type (spec §4). */
export function defaultSecurityLevelFor(type: MemoryType): MemorySecurityLevel {
  switch (type) {
    case MemoryType.ShortTerm:
    case MemoryType.Workspace:
    case MemoryType.KnowledgeReference:
    case MemoryType.Temporary:
      return MemorySecurityLevel.Internal;
    case MemoryType.Conversation:
    case MemoryType.User:
    case MemoryType.Project:
    case MemoryType.Organization:
    case MemoryType.Session:
    case MemoryType.LongTerm:
    case MemoryType.Archived:
      return MemorySecurityLevel.Confidential;
  }
}

/** Default retention policy per memory type (spec §4). */
export function defaultRetentionFor(type: MemoryType): MemoryRetentionPolicy {
  switch (type) {
    case MemoryType.ShortTerm:
      return { kind: 'none' };
    case MemoryType.Conversation:
      return { kind: 'rolling_window', description: 'Rolling window + incremental summaries' };
    case MemoryType.User:
      return { kind: 'until_deletion', description: 'Until deletion request (right to forget)' };
    case MemoryType.Project:
      return { kind: 'milestone_summaries', description: 'Milestone summaries; archive on close' };
    case MemoryType.Workspace:
      return { kind: 'versioned', description: 'Versioned; archived on workspace close' };
    case MemoryType.Organization:
      return { kind: 'until_deletion', description: 'Until org deletion' };
    case MemoryType.KnowledgeReference:
      return { kind: 'invalidation', description: 'Invalidated on KB version bump' };
    case MemoryType.Temporary:
      return { kind: 'none' };
    case MemoryType.Session:
      return { kind: 'none', description: 'Purged at logout/expiry' };
    case MemoryType.LongTerm:
      return {
        kind: 'annual_consolidation',
        description: 'Annual consolidation; compliance holds',
      };
    case MemoryType.Archived:
      return { kind: 'legal_hold', description: 'Legal hold + expiry; immutable (WORM)' };
  }
}

/** Default TTL per memory type (spec §4; Conversation/Temporary only). */
export function defaultTtlMsFor(
  type: MemoryType,
  config?: Pick<MemoryConfig, 'MEMORY_TTL_CONVERSATION_MS' | 'MEMORY_TTL_TEMPORARY_MS'>,
): number | undefined {
  switch (type) {
    case MemoryType.Conversation:
      return config?.MEMORY_TTL_CONVERSATION_MS;
    case MemoryType.Temporary:
      return config?.MEMORY_TTL_TEMPORARY_MS;
    default:
      return undefined;
  }
}

/** Default per-type size cap (bytes) — informational (spec §4). */
export function defaultSizeLimitFor(type: MemoryType): number {
  switch (type) {
    case MemoryType.ShortTerm:
      return 64 * 1024;
    case MemoryType.User:
      return 512 * 1024;
    case MemoryType.Project:
      return 2 * 1024 * 1024;
    case MemoryType.Workspace:
      return 1024 * 1024;
    case MemoryType.Organization:
      return 4 * 1024 * 1024;
    case MemoryType.KnowledgeReference:
    case MemoryType.Temporary:
    case MemoryType.Session:
      return 32 * 1024;
    case MemoryType.LongTerm:
      return 10 * 1024 * 1024;
    case MemoryType.Conversation:
    case MemoryType.Archived:
      return Number.POSITIVE_INFINITY;
  }
}
