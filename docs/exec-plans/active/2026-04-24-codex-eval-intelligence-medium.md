# Codex Eval Intelligence Medium

## Background

Bridge-driven Codex evaluations inherit Codex CLI defaults unless the bridge
passes explicit options. The current user-level Codex config sets
`model_reasoning_effort = "xhigh"`, and evaluation logs show quick/full eval
runs using `reasoning effort: xhigh`.

## Goal

Set Codex bridge evaluations to medium intelligence/reasoning effort by default.

## Scope

- Bridge real-mode Codex evaluations.
- Quick `newgrad_quick` and full A-G evaluation subprocesses.
- Bridge docs for the override.

Out of scope: changing the user's global `~/.codex/config.toml` or Claude/SDK
evaluation paths.

## Assumptions

- "intelligence" maps to the Codex CLI `model_reasoning_effort` setting.
- `medium` should be the repo default, with an environment override for future
  experiments.

## Implementation Steps

1. Add bridge config for `CAREER_OPS_CODEX_REASONING_EFFORT`.
   Verify: typecheck catches all config consumers.
2. Pass `-c model_reasoning_effort="medium"` to Codex quick and full evals.
   Verify: focused unit tests inspect command args.
3. Document the default.
   Verify: docs mention the env var and default.

## Verification Approach

- Focused bridge tests for Codex command construction.
- Bridge typecheck.
- `git diff --check`.

## Progress Log

- 2026-04-24: Created plan after user requested medium intelligence for Codex
  evaluations. Located the current source of `xhigh` as user-level Codex config
  inherited by bridge subprocesses.
- 2026-04-24: Added `codexReasoningEffort` to bridge config, defaulting to
  `medium` with `CAREER_OPS_CODEX_REASONING_EFFORT` as the override. Full and
  quick Codex evaluation plans now pass `-c model_reasoning_effort="medium"`.
- 2026-04-24: Added a focused unit test that inspects both Codex command
  shapes. Documented the default in `docs/BROWSER_EXTENSION.md`.

## Key Decisions

- Use bridge-level CLI config rather than editing global Codex config, so the
  change is repository-local and applies only to career-ops evaluations.

## Risks and Blockers

- If Codex CLI renames `model_reasoning_effort`, the bridge will pass a stale
  config key. This should be visible in evaluation logs and testable with a
  minimal Codex probe.

## Final Outcome

Completed. Codex bridge evaluations now use medium reasoning effort by default
without modifying user-level Codex config.

Verification passed:

- `npm --prefix bridge test -- src/adapters/claude-pipeline.test.ts src/batch/merge-tracker.test.ts`
- `npm --prefix bridge run typecheck`
- `codex exec -c 'model_reasoning_effort="medium"' --help`
- `git diff --check`
