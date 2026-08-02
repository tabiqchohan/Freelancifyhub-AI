# Memory

Persistent memory layer for the FreelancifyHub AI ecosystem.

Agents use this directory to store session context, user preferences and
long-term state so they remain consistent across conversations.

- This folder is mounted as a volume in `docker-compose.yml`.
- `.gitkeep` keeps the directory in version control; runtime data is ignored
  by `.gitignore` (`logs/` and `memory/`).
