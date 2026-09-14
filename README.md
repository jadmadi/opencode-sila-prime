# opencode-sila-prime

An OpenCode V2 plugin that primes each session from the
[sila](https://github.com/jadmadi/sila) knowledge store. On the first prompt it
runs `sila prime` in the project directory and injects the briefing, so the
cross-tool knowledge sila has collected reaches OpenCode without running the CLI
by hand. A `/sila` command runs sila subcommands on demand.

## How it works

- On the first prompt of a session, the plugin runs `sila prime --no-color` in
  the session's project directory and prepends the output to the prompt inside a
  `<sila_memory>` wrapper.
- The briefing is truncated to a character budget (default 6000) and the call is
  killed after a timeout (default 5s), so a slow or missing sila never blocks a
  prompt for long.
- The session is marked after one attempt. A quiet project or a missing binary
  does not spawn a process on every prompt. Use `/sila` to refresh.
- The plugin shells out to the `sila` CLI. It never reads or writes sila's
  database.

## Requirements

`sila` on `PATH`, or set `SILA_BIN` to its full path. Tested against sila 0.x
and OpenCode v2.0.3.

To pin a release, replace `main` in the URL with a tag such as `v0.1.0`.

## Install

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL \
  https://raw.githubusercontent.com/jadmadi/opencode-sila-prime/main/sila-prime.ts \
  -o ~/.config/opencode/plugins/sila-prime.ts
```

For one project, put it in `.opencode/plugins/`. Reload a running server by
touching the file:

```sh
touch ~/.config/opencode/plugins/sila-prime.ts
```

## Command

| Use                          | Runs                                  |
| ---------------------------- | ------------------------------------- |
| `/sila`                      | `sila prime --no-color`               |
| `/sila sync`                 | `sila sync`, with a longer timeout    |
| `/sila search "wal mode"`    | `sila search "wal mode"`              |
| `/sila status`               | `sila status`                         |
| `/sila digest --human`       | `sila digest --human`                 |

Any arguments are passed to sila unchanged, so every subcommand works. Bare
`/sila` runs `prime`. The result is posted to the session. A non-zero exit
throws the output so the error is visible.

## Environment

| Variable             | Default | Use                                                     |
| -------------------- | ------- | ------------------------------------------------------- |
| `SILA_BIN`           | `sila`  | Path to the sila binary                                 |
| `SILA_PRIME`         | on      | `off`, `0`, or `false` disables the first-prompt inject |
| `SILA_PRIME_OFF`     | unset   | `1` disables the inject                                 |
| `SILA_PRIME_ARGS`    | unset   | Extra flags for prime, for example `--top=8`            |
| `SILA_PRIME_BUDGET`  | `6000`  | Character budget for the injected briefing              |
| `SILA_PRIME_TIMEOUT` | `5000`  | Prime timeout in milliseconds                           |
| `SILA_OUTPUT_CAP`    | `20000` | Character cap for `/sila` output                        |

## Relation to the memory plugin

[memory](https://github.com/jadmadi/opencode-memory) injects OpenCode-only project
files. This plugin injects sila's cross-tool briefing. They do different jobs and
can run together. If the two briefings feel redundant, disable one: set
`MEMORY_BUDGET` low, or set `SILA_PRIME=off` and use `/sila` on demand.

## Tests

```sh
bun test
```

## Attribution

Sila is a separate project by Jad Madi, MIT licensed. See `NOTICE`.

## License

MIT
