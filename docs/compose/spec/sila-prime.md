---
feature: sila-prime
status: delivered
updated: 2026-09-13
branch: feat/sila-prime
commits: bd39ada..7d9e6bd
---

# sila-prime

## Report

**What was built** - A single-file OpenCode V2 plugin that runs `sila prime
--no-color` in the session's project directory on the first prompt and prepends
the briefing to `event.prompt.text` inside a `<sila_memory>` wrapper. It injects
once per session and marks the session after one attempt, so a quiet project or
a missing binary does not spawn a process on every prompt. It also registers a
`/sila` command that runs a sila subcommand and posts the output; a non-zero
exit throws the clipped output. The process runner has a hard timeout, captures
both streams, and never reads sila's database.

**Verification** - `bun test`: 37 pass, 0 fail, 71 assertions. Live: the runner
returned real briefings for the sila repo (1954 chars) and this project
(1039 chars, cross-tool facts attributed to opencode). The timeout was
independently reproduced at 202ms with a child that traps and ignores SIGTERM,
and at 301ms with a grandchild that holds the pipe. Two review rounds. The first
found one critical: the timeout sent SIGTERM and then still awaited the streams,
so a signal-ignoring child or a child that inherited the pipe could hang the
prompt past the deadline. It also found three mediums (the hook could throw on
`ctx.storage.get`, a missing session id shared one storage key, and two
concurrent first prompts could double-inject) and six lows. All were fixed and
re-reviewed as resolved; the re-review confirmed the critical and mediums with
its own probes and added three residual lows (an abandoned child handle,
space-separated flag values, and stderr on success), which were also fixed.

**Journey log**

1. The first runner awaited `new Response(proc.stdout).text()` after a SIGTERM.
   A child that ignored the signal, or a grandchild that held the write end,
   kept the read pending, so the "timeout" did not bound the prompt. The runner
   now races the work against a deadline promise and escalates to `kill(9)`.
2. The hook read `ctx.storage.get` outside every try, so a broken store rejected
   the prompt. It is now wrapped, and a read failure skips priming.
3. `event.sessionID` could be missing, collapsing every sessionless event onto
   one key. The hook now requires a string session id.
4. Two concurrent first prompts both saw the flag unset and both injected. An
   in-flight `Set` now dedupes them, so exactly one injection happens.
5. `LONG_COMMANDS` named `watch` and `reconcile`, which are not top-level sila
   commands. It now names `sync`, `live`, `ingest`, `dream`, `vacuum`, `update`,
   and `doc`, and matches any argument, not only the first.
6. `SILA_PRIME_ARGS` was split on whitespace, so a quoted value broke. It now
   reuses the command tokenizer.
7. stderr was dropped whenever stdout was present, hiding the real error on a
   failed `/sila`. Failures now join both streams; successes stay on stdout.

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
  `event.prompt.text`. It injects once per session, tracked in `ctx.storage`,
  with an in-flight set to cover concurrent first prompts.
- Resilience: the runner races the streams and the exit against a hard deadline
  and escalates to `kill(9)`, so the prompt never waits past the timeout even
  when the child ignores the signal or a grandchild holds the pipe. The hook
  catches every failure and never rejects. The session is marked after one
  attempt, so a quiet project or a missing binary does not spawn on every
  prompt.
- Budget and environment: `SILA_PRIME_BUDGET` caps the injected characters,
  `SILA_PRIME_TIMEOUT` caps the run, `SILA_BIN` points at the binary,
  `SILA_PRIME_ARGS` adds flags as shell-style tokens, and `SILA_PRIME` or
  `SILA_PRIME_OFF` disables the inject.
- Command: `/sila <args>` runs a sila subcommand and posts the output. Bare
  `/sila` runs prime. Slow subcommands (`sync`, `live`, `ingest`, `dream`,
  `vacuum`, `update`, `doc`) get a longer timeout, matched anywhere in the
  argument list. A non-zero exit throws the clipped output so the error is
  visible.
- Test seam: `ctx.silaRunner` overrides the process runner. Tests inject a fake
  and never spawn sila.

## [S3] Out of Scope

- Reading or writing `knowledge.db` directly.
- Registering sila's MCP tools. That is configuration, not a plugin.
- Auto-sync or watch. `/sila sync` runs on demand.
- Per-project budgets or per-directory sila project mapping.

## Tasks

- [x] T1: a process runner that spawns sila with a hard timeout and reports ok
      and output - acceptance: echo returns its output, a slow command that
      ignores the signal returns at the deadline, a child that holds the pipe
      does not block, and a missing binary is reported without throwing (covers:
      S2)
- [x] T2: a character-budget wrapper for the briefing - acceptance: the wrapped
      text fits the budget, and empty or too-small budgets return nothing
      (covers: S2)
- [x] T3: the first-prompt hook injects once per session - acceptance: the first
      prompt gets the wrapper, the second is untouched, a disabled or empty
      briefing injects nothing, concurrent first prompts inject once, and a
      throwing runner or unreadable store does not break the prompt (covers: S2;
      depends: T1, T2)
- [x] T4: the `/sila` command with a prime default, quoted arguments, slow
      subcommand timeouts, and an error on failure - acceptance: each case is
      covered by a test (covers: S2; depends: T1)
- [x] T5: README, AGENTS, CONTRIBUTING, NOTICE, and package.json - acceptance:
      each exists and names sila (covers: S2)
