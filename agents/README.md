# Agents

This directory holds the AI agent definitions for the FreelancifyHub ecosystem.

Each subdirectory is an OpenClaw-compatible agent directory. The recommended
layout follows the OpenClaw "agent dir trio":

- `agent.md` — identity, role, boundaries and rules for the agent.
- `SOUL.md` — long-term behavioral traits and goals (optional).
- `AGENTS.md` — cross-agent handoff rules (optional).

Agents consume prompts from `../prompts`, workflows from `../workflows`,
knowledge from `../knowledge` and memory from `../memory`.

## Adding an agent

1. Create `agents/<agent-id>/agent.md`.
2. Register the agent in `clawd.json` under `agents.list`.
3. Validate with `openclaw config validate`.

## Current agents

- `freelancify-core/` — orchestrator agent (skeleton, see its `agent.md`).
