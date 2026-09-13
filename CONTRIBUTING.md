# Contributing

Thanks for helping improve opencode-sila-prime.

## Setup

```sh
git clone https://github.com/jadmadi/opencode-sila-prime
cd opencode-sila-prime
bun test
```

Bun is a deliberate exception to the global no-bun rule here: the plugin runs
inside OpenCode, which embeds Bun. The tests need `echo` and `sleep`, which are
present on Linux and macOS.

## Rules

- No imports in the plugin. Export a plain `{ id, setup }` object.
- Keep the plugin dependency-free and use Bun globals.
- The plugin shells out to the `sila` CLI. It never reads or writes sila's
  database directly.
- Add a test for any behavior you change. Inject a fake runner through
  `ctx.silaRunner` instead of spawning a process.

## Reporting a bug

Open an issue with your OpenCode version from `opencode2 --version`, your sila
version from `sila --version`, the command or prompt you used, and the result.

## Sending a change

1. Branch: `git checkout -b fix/short-description`.
2. Make the change and add tests.
3. Run `bun test`.
4. Use a semantic commit message.
5. Open a pull request against `main`.

## License

By contributing, you agree that your work is released under the MIT License.
