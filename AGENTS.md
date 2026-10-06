# AGENTS.md — compulsory rules for all AI agents

This repo is worked on by multiple agents: **Antigravity**, **Kilo**, **opencode**, **Codex**, and any future agent.

## Mandatory workflow

### 1. Before ANY code/file change
- Read `AGENT_LOG.md` in full (or at least the last 20 entries).
- Note what other agents already changed so you do not clash or undo work.

### 2. While working
- Prefer editing existing files over creating new ones.
- Do not delete another agent's work without a log entry explaining why.
- Keep changes small and scoped to the user's request.

### 3. After ANY change (create / edit / delete)
Append one entry to `AGENT_LOG.md` using the format in that file:

```
### YYYY-MM-DD HH:MM — <agent-name>
- **Task:** ...
- **Files:** ...
- **Changes:** ...
- **Verified:** ...
- **Notes:** ...
```

- Use your real agent name (e.g. `codex`, `kilo`, `antigravity`, `opencode`).
- Never rewrite or remove other agents' log entries.
- If you break something, log it in **Notes** so the next agent can fix it.

### 4. If you are a NEW agent type in the future
- Still follow this file.
- Still read `AGENT_LOG.md` before edits.
- Still append a log entry after every change.

## Quick paste prompt (for any new AI tool)

```
You are working in the CLIPPER GAME repo with other AI agents.

STRICT RULES:
1. Before changing ANY file, read AGENT_LOG.md (recent entries).
2. After ANY create/edit/delete, append an entry to AGENT_LOG.md
   with your agent name, task, files, changes, verification, notes.
3. Never remove or rewrite other agents' log entries.
4. Do not undo another agent's work unless the user asks; log any conflict.
5. Match existing code style; do not add comments unless asked.

Start by reading AGENT_LOG.md, then do only what the user asked.
```

## Log location
- `AGENT_LOG.md` (repo root)
