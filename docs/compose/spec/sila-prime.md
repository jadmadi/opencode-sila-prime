---
feature: sila-prime
status: in-progress
updated: 2026-09-13
branch: feat/sila-prime
commits:
---

# sila-prime

## [S1] Problem

Sila keeps a cross-tool knowledge store: transcripts, distilled claims,
handoffs, memos, and docs from seven agent CLIs plus git. Its `prime` command
delivers that context to any harness in about 300ms. OpenCode can reach the same
store over MCP, but nothing injects a briefing at session start, so the user
still runs `sila prime` by hand or starts with no cross-tool context.

## [S2] Design

A single-file OpenCode V2 plugin that shells out to the `sila` CLI. It does not
touch sila's database, so it keeps working across sila versions and stays
dependency-free.

- First prompt: the plugin runs `sila prime --no-color` in the session's
  project directory, wraps the output in `<sila_memory>`, and prepends it to
  `event.prompt.text`. It injects once per session, tracked in `ctx.storage`.
- Resilience: the runner has a timeout and captures both streams. The hook
  catches failures. The session is marked after one attempt, so a quiet project
  or a missing binary does not spawn on every prompt.
- Budget and environment: `SILA_PRIME_BUDGET` caps the injected characters,
  `SILA_PRIME_TIMEOUT` caps the run, `SILA_BIN` points at the binary,
  `SILA_PRIME_ARGS` adds flags, and `SILA_PRIME` or `SILA_PRIME_OFF` disables
  the inject.
- Command: `/sila <args>` runs a sila subcommand and posts the output. Bare
  `/sila` runs prime. Slow subcommands (`sync`, `watch`, `ingest`, `dream`,
  `vacuum`, `update`) get a longer timeout. A non-zero exit throws the output so
  the error is visible.
- Test seam: `ctx.silaRunner` overrides the process runner. Tests inject a fake
  and never spawn sila.

## [S3] Out of Scope

- Reading or writing `knowledge.db` directly.
- Registering sila's MCP tools. That is configuration, not a plugin.
- Auto-sync or watch. `/sila sync` runs on demand.
- Per-project budgets or per-directory sila project mapping.

## Tasks

- [ ] T1: a process runner that spawns sila with a timeout and reports ok and
      output - acceptance: echo returns its output, a slow command is killed and
      reported, and a missing binary is reported without throwing (covers: S2)
- [ ] T2: a character-budget wrapper for the briefing - acceptance: the wrapped
      text fits the budget, and empty or too-small budgets return nothing
      (covers: S2)
- [ ] T3: the first-prompt hook injects once per session - acceptance: the first
      prompt gets the wrapper, the second is untouched, a disabled or empty
      briefing injects nothing, and a throwing runner does not break the prompt
      (covers: S2; depends: T1, T2)
- [ ] T4: the `/sila` command with a prime default, quoted arguments, slow
      subcommand timeouts, and an error on failure - acceptance: each case is
      covered by a test (covers: S2; depends: T1)
- [ ] T5: README, AGENTS, CONTRIBUTING, NOTICE, and package.json - acceptance:
      each exists and names sila (covers: S2)
