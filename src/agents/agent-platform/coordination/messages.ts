/**
 * Sprint 20 — Multi-Agent Coordination & Collaboration. Controlled,
 * authorized coordination messages (Sprint 20 §10).
 *
 * Messages are bounded (server-imposed byte cap), validated, append-only,
 * and only ever exchanged between participating agents of the same
 * coordination. Send/read calls enforce participant membership, so an
 * unrelated agent cannot read a coordination's shared state.
 */

import { CoordinationMessageValidationError } from './errors.js';
import { assertMessageSize } from './schemas.js';
import { type CoordinationMessage, type AgentTask } from './types.js';

export type { CoordinationMessage };

/** Options for the message bus. */
export interface CoordinationMessageBusOptions {
  readonly maxMessagesPerCoordination?: number;
  readonly maxMessageBytes?: number;
}

/** A sent/received message record (kept in a single append-only log). */
export interface StoredCoordinationMessage extends CoordinationMessage {
  readonly deliveredTo?: readonly string[];
}

/** Authorized, bounded coordination message bus (Sprint 20 §10). */
export class CoordinationMessageBus {
  readonly name = 'coordination-message-bus';
  readonly backend = 'in-memory';

  private readonly messages: StoredCoordinationMessage[] = [];
  private readonly byId = new Map<string, StoredCoordinationMessage>();
  private readonly maxMessagesPerCoordination: number;
  private readonly maxMessageBytes: number;

  constructor(options: CoordinationMessageBusOptions = {}) {
    this.maxMessagesPerCoordination = options.maxMessagesPerCoordination ?? 256;
    this.maxMessageBytes = options.maxMessageBytes ?? 32 * 1024;
  }

  /** Sends a validated, bounded message between participating agents. */
  send(
    message: CoordinationMessage,
    participants: readonly AgentTask[],
    currentAgentId?: string,
  ): StoredCoordinationMessage {
    if (!isParticipant(participants, message.sender)) {
      throw new CoordinationMessageValidationError(
        `sender ${message.sender} is not a participating agent in ${message.coordinationId}`,
        { sender: message.sender, coordinationId: message.coordinationId },
      );
    }
    if (message.recipient !== '*' && !isParticipant(participants, message.recipient)) {
      throw new CoordinationMessageValidationError(
        `recipient ${message.recipient} is not a participating agent in ${message.coordinationId}`,
        { recipient: message.recipient, coordinationId: message.coordinationId },
      );
    }
    if (currentAgentId !== undefined && currentAgentId !== message.sender) {
      throw new CoordinationMessageValidationError(
        `agent ${currentAgentId} may not send as ${message.sender}`,
        { sender: message.sender, currentAgentId },
      );
    }
    assertMessageSize(message.payload, this.maxMessageBytes);

    const count = this.messages.filter((m) => m.coordinationId === message.coordinationId).length;
    if (count >= this.maxMessagesPerCoordination) {
      throw new CoordinationMessageValidationError(
        `coordination ${message.coordinationId} exceeded message limit`,
        { limit: this.maxMessagesPerCoordination },
      );
    }

    const stored: StoredCoordinationMessage = { ...message };
    this.messages.push(stored);
    this.byId.set(message.messageId, stored);
    return stored;
  }

  /** Read access for a participant: only messages they may see. */
  read(
    coordinationId: string,
    reader: string,
    participants: readonly AgentTask[],
    limit = 20,
  ): readonly StoredCoordinationMessage[] {
    if (!isParticipant(participants, reader)) {
      throw new CoordinationMessageValidationError(
        `agent ${reader} is not a participant of coordination ${coordinationId}`,
        { reader, coordinationId },
      );
    }
    return this.messages
      .filter((m) => m.coordinationId === coordinationId)
      .filter((m) => m.sender === reader || m.recipient === reader || m.recipient === '*')
      .slice(-Math.max(1, limit));
  }

  /** Count of messages for a coordination. */
  count(coordinationId: string): number {
    return this.messages.filter((m) => m.coordinationId === coordinationId).length;
  }

  /** Clear all messages (tests only — never called at runtime). */
  clear(): void {
    this.messages.length = 0;
    this.byId.clear();
  }
}

/** True when the agent id belongs to the coordination's participants. */
export function isParticipant(
  participants: readonly { agentId: string }[],
  agentId: string,
): boolean {
  return participants.some((task) => task.agentId === agentId);
}
