# AGENTS.md

Guidance for agents working in this repository.

## What this is

An OpenCode V2 plugin (`sila-prime.ts`) that runs `sila prime` on the first
prompt of a session and injects the briefing, plus a `/sila` command that runs a
sila subcommand and posts the result. No build step, no dependencies, MIT.

## Local development

```sh
bun test
cp sila-prime.ts ~/.config/opencode/plugins/sila-prime.ts
touch ~/.config/opencode/plugins/sila-prime.ts
```

Check the server log when something is off:

```sh
grep sila-prime ~/.local/share/opencode/log/opencode.log | tail
```

## Hard constraints

- Do not import `@opencode/plugin`. Export a plain `{ id, setup }` object.
- Keep the plugin dependency-free. Use Bun globals.
- Shell out to the `sila` CLI. Never read or write `knowledge.db` directly.
- The prompt hook must not throw and must not block a prompt for long. The
  runner races the run against a hard deadline, escalates to `kill(9)`, and the
  hook catches failures.
- Inject at most once per session. A process-wide `primed` set claims the
  session before the first await, and `ctx.storage` carries the mark across
  reloads and processes. Both use the key `sila-prime/injected/<id>`. Ignore
  events for another location, because the server holds one instance per
  location and every instance receives every event. Mark the session after one
  attempt so a quiet or missing sila does not spawn on every prompt.

## API notes

- `ctx.location.directory` is the session directory and the working directory
  for the sila call. Sila infers the project from it.
- `ctx.session.hook("prompt", cb)` can rewrite `event.prompt.text`.
- `ctx.session.prompt({ sessionID, text })` posts command output to the session.
- A command surfaces an error by throwing.
- `ctx.silaRunner` is a test seam: a function `(args, cwd, timeoutMs) =>
  Promise<{ ok, output }>`. When absent, the plugin uses `defaultRunner`, which
  spawns the CLI through `Bun.spawn`.
- `resetPrimed()` clears the process-wide claim set. Tests call it in
  `afterEach`.

## Layout

- `numberEnv`, `primeDisabled`, `primeArgs`, `injectionBudget` - environment.
- `wrapBriefing`, `tokenize`, `commandArgs`, `isLongCommand` - pure helpers.
- `clipOutput` - caps command output.
- `defaultRunner` - spawns sila, races the work against a hard deadline, and
  captures stdout and stderr.
- `resetPrimed` - clears the process-wide claim set, for tests.
- `setup` - registers the `/sila` command and the prompt hook.
- `sila-prime.test.ts` - tests with a fake ctx and an injected runner.

## Releasing

- Semantic commit messages. Changes through a feature branch and a PR.
- Keep `NOTICE` accurate.
