import { MemoryPriority, MemoryType } from '../enums/index.js';
import type { Clock } from '../clock/index.js';
import type { MemoryRecord } from '../types/index.js';

/**
 * Scorer contract for deterministic relevance scoring (Sprint 4, prompt §11).
 * Scores must be in range [0, 1] where 0 = irrelevant, 1 = highly relevant.
 */
export interface Scorer {
  readonly name: string;
  score(record: import('../types/index.js').MemoryRecord, query: string, now: Date): number;
}

/**
 * Configuration for the default scorer weights.
 */
export interface ScorerWeights {
  readonly exactMatch: number;
  readonly tokenMatch: number;
  readonly phraseMatch: number;
  readonly typeWeight: number;
  readonly recencyWeight: number;
  readonly priorityWeight: number;
  readonly scopeWeight: number;
}

/**
 * Default deterministic scorer implementing the architecture's ranking strategy
 * (spec §8): weighted combination of relevance + recency + importance + confidence.
 */
export class DefaultScorer implements Scorer {
  readonly name = 'default-scorer';

  private readonly weights: ScorerWeights;
  private readonly clock: Clock;

  constructor(clock: Clock, weights?: Partial<ScorerWeights>) {
    this.clock = clock;
    this.weights = {
      exactMatch: weights?.exactMatch ?? 0.3,
      tokenMatch: weights?.tokenMatch ?? 0.25,
      phraseMatch: weights?.phraseMatch ?? 0.15,
      typeWeight: weights?.typeWeight ?? 0.1,
      recencyWeight: weights?.recencyWeight ?? 0.1,
      priorityWeight: weights?.priorityWeight ?? 0.05,
      scopeWeight: weights?.scopeWeight ?? 0.05,
    };
  }

  score(record: import('../types/index.js').MemoryRecord, query: string, now: Date = this.clock.getNow()): number {
    if (!query || query.trim().length === 0) {
      return this.baseScore(record, now);
    }

    const normalizedQuery = this.normalizeQuery(query);
    if (!normalizedQuery) {
      return this.baseScore(record, now);
    }

    const content = this.extractSearchableContent(record);
    if (!content) {
      return this.baseScore(record, now);
    }

    let score = 0;

    // Exact match signal
    if (content.toLowerCase().includes(normalizedQuery.toLowerCase())) {
      score += this.weights.exactMatch;
    }

    // Token match signal
    const queryTokens = normalizedQuery.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const contentTokens = content.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const matchedTokens = queryTokens.filter(qt => contentTokens.some(ct => ct.includes(qt)));
    if (queryTokens.length > 0) {
      score += this.weights.tokenMatch * (matchedTokens.length / queryTokens.length);
    }

    // Phrase match signal (query as contiguous phrase)
    if (content.toLowerCase().includes(normalizedQuery.toLowerCase())) {
      score += this.weights.phraseMatch;
    }

    // Type weight
    score += this.weights.typeWeight * this.typeScore(record.type);

    // Recency weight
    score += this.weights.recencyWeight * this.recencyScore(record, now);

    // Priority weight
    score += this.weights.priorityWeight * this.priorityScore(record.priority);

    // Scope weight (placeholder - could be enhanced with project/workspace relevance)
    score += this.weights.scopeWeight * 0.5;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, score));
  }

  private baseScore(record: import('../types/index.js').MemoryRecord, now: Date): number {
    return (
      this.weights.typeWeight * this.typeScore(record.type) +
      this.weights.recencyWeight * this.recencyScore(record, now) +
      this.weights.priorityWeight * this.priorityScore(record.priority) +
      this.weights.scopeWeight * 0.5
    );
  }

  private typeScore(type: import('../enums/index.js').MemoryType): number {
    // Architecture-defined priorities (spec §4)
    switch (type) {
      case 'CONVERSATION':
      case 'USER':
      case 'PROJECT':
      case 'LONG_TERM':
        return 1.0;
      case 'KNOWLEDGE_REFERENCE':
      case 'SESSION':
        return 0.8;
      case 'SHORT_TERM':
      case 'WORKSPACE':
      case 'ORGANIZATION':
        return 0.6;
      case 'TEMPORARY':
      case 'ARCHIVED':
        return 0.4;
      default:
        return 0.5;
    }
  }

  private recencyScore(record: import('../types/index.js').MemoryRecord, now: Date): number {
    const recordTime = new Date(record.updatedAt).getTime();
    const ageMs = now.getTime() - recordTime;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    
    // Exponential decay: score = e^(-age/30) so 30 days -> ~0.37, 7 days -> ~0.79
    return Math.exp(-ageDays / 30);
  }

  private priorityScore(priority: import('../enums/index.js').MemoryPriority): number {
    switch (priority) {
      case 'CRITICAL': return 1.0;
      case 'HIGH': return 0.75;
      case 'MEDIUM': return 0.5;
      case 'LOW': return 0.25;
      default: return 0.5;
    }
  }

  private normalizeQuery(query: string): string {
    return query
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '');
  }

  private extractSearchableContent(record: import('../types/index.js').MemoryRecord): string {
    const parts: string[] = [];
    
    if (record.content) {
      parts.push(typeof record.content === 'string' 
        ? record.content 
        : JSON.stringify(record.content));
    }
    
    parts.push(record.key);
    parts.push(record.type);
    
    for (const value of Object.values(record.metadata ?? {})) {
      if (typeof value === 'string') {
        parts.push(value);
      }
    }
    
    return parts.join(' ');
  }
}