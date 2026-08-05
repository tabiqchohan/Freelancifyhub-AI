import type { AgentRequest } from '../interfaces/index.js';
import type { AgentResponse } from '../interfaces/index.js';
import { validateWithSchema } from '../utils/schema.js';
import { agentRequestSchema } from '../schemas/index.js';
import { agentResponseSchema } from '../schemas/index.js';

/** Validates a request against the shared agent request schema. */
export function validateAgentRequest(input: unknown): AgentRequest {
  return validateWithSchema(agentRequestSchema, input) as AgentRequest;
}

/** Validates a response against the shared agent response schema. */
export function validateAgentResponse(input: unknown): AgentResponse {
  return validateWithSchema(agentResponseSchema, input) as AgentResponse;
}
