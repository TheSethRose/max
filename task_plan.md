# Task Plan

## Goal
Implement an OpenClaw-style one-time `BOOTSTRAP.md` flow for Max so a new workspace gets an interactive onboarding ritual that fills/refines `~/.max/workspace/profile/` files, then allows `BOOTSTRAP.md` to be deleted permanently without being recreated on every startup.

## Phases
- [x] Research current Max profile/bootstrap behavior and OpenClaw reference
- [ ] Design one-time bootstrap seeding and deletion semantics
- [ ] Implement repo-tracked bootstrap template and loader
- [ ] Update setup/docs to explain interactive bootstrap flow
- [ ] Validate with typecheck/build

## Design constraints
- `BOOTSTRAP.md` should be tracked in the repo by default
- Workspace profile files remain user-owned in `~/.max/workspace/profile/`
- Bootstrap should guide an interactive conversation, not a rigid form
- Deleting workspace `BOOTSTRAP.md` after onboarding must be respected
- Avoid leaking user-specific data into Max source

## Notes
- Current `ensureWorkspaceProfile()` seeds `BOOTSTRAP.md` every time it is missing, which conflicts with one-time ritual behavior.
