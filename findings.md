# Findings

- OpenClaw treats `BOOTSTRAP.md` as a one-time first-run ritual.
- OpenClaw guidance explicitly says to update `IDENTITY.md`, `USER.md`, and `SOUL.md` based on an interactive conversation, then delete `BOOTSTRAP.md` when done.
- Max currently stores the bootstrap template inline in `src/workspace.ts` and recreates it whenever missing.
- Because `renderProfileContext("orchestrator")` includes `BOOTSTRAP.md`, the right behavior is to seed it only for a new workspace, not continuously.
