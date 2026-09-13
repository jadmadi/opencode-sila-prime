import { afterEach, describe, expect, test } from "bun:test"
import plugin, {
  commandArgs,
  defaultRunner,
  injectionBudget,
  primeArgs,
  primeDisabled,
  tokenize,
  wrapBriefing,
} from "./sila-prime.ts"

const ENV_KEYS = ["SILA_BIN", "SILA_PRIME", "SILA_PRIME_OFF", "SILA_PRIME_ARGS", "SILA_PRIME_BUDGET", "SILA_PRIME_TIMEOUT"]

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

type RunResult = { ok: boolean; output: string }
type Runner = (args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>

function makeCtx(run: Runner) {
  const commands: any[] = []
  const hooks: Record<string, any> = {}
  const store = new Map<string, unknown>()
  const prompts: any[] = []
  const calls: Array<{ args: string[]; cwd: string; timeoutMs: number }> = []
  const ctx: any = {
    location: { directory: "/tmp/project", project: { id: "proj" } },
    silaRunner: async (args: string[], cwd: string, timeoutMs: number) => {
      calls.push({ args, cwd, timeoutMs })
      return run(args, cwd, timeoutMs)
    },
    command: { transform: (callback: any) => callback({ add: (definition: any) => commands.push(definition) }) },
    session: {
      hook: async (name: string, callback: any) => void (hooks[name] = callback),
      prompt: async (input: any) => void prompts.push(input),
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
  }
  return { ctx, commands, hooks, prompts, calls }
}

async function boot(run: Runner) {
  const harness = makeCtx(run)
  await (plugin as any).setup(harness.ctx)
  return harness
}

const ok = (output: string): RunResult => ({ ok: true, output })
const fail = (output: string): RunResult => ({ ok: false, output })
const command = (commands: any[], name: string) => commands.find((entry) => entry.name === name)

describe("wrapBriefing", () => {
  test("wraps non-empty output", () => {
    expect(wrapBriefing("PROJECT MEMORY", 1000)).toBe("<sila_memory>\nPROJECT MEMORY\n</sila_memory>")
  })

  test("returns nothing for empty or whitespace output", () => {
    expect(wrapBriefing("", 1000)).toBe("")
    expect(wrapBriefing("   \n  ", 1000)).toBe("")
  })

  test("truncates at the budget", () => {
    const result = wrapBriefing("x".repeat(200), 80)
    expect(result.length).toBeLessThanOrEqual(80)
    expect(result.startsWith("<sila_memory>")).toBe(true)
    expect(result.endsWith("</sila_memory>")).toBe(true)
  })

  test("returns nothing when the budget cannot fit the wrapper", () => {
    expect(wrapBriefing("hello", 10)).toBe("")
  })
})

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("search wal mode")).toEqual(["search", "wal", "mode"])
  })

  test("keeps quoted arguments together", () => {
    expect(tokenize('search "wal mode" --omni')).toEqual(["search", "wal mode", "--omni"])
    expect(tokenize("handoff 'a summary'")).toEqual(["handoff", "a summary"])
  })

  test("returns nothing for empty input", () => {
    expect(tokenize("")).toEqual([])
  })
})

describe("commandArgs", () => {
  test("defaults to prime", () => {
    expect(commandArgs("")).toEqual({ args: ["prime", "--no-color"], timeoutMs: 30000 })
    expect(commandArgs(undefined)).toEqual({ args: ["prime", "--no-color"], timeoutMs: 30000 })
  })

  test("passes a subcommand through", () => {
    expect(commandArgs("status")).toEqual({ args: ["status"], timeoutMs: 30000 })
  })

  test("gives slow subcommands a long timeout", () => {
    expect(commandArgs("sync").timeoutMs).toBe(180000)
    expect(commandArgs("ingest --project=x").timeoutMs).toBe(180000)
  })

  test("tokenizes quoted arguments", () => {
    expect(commandArgs('search "wal mode"')).toEqual({ args: ["search", "wal mode"], timeoutMs: 30000 })
  })
})

describe("environment", () => {
  test("prime defaults to no color and appends SILA_PRIME_ARGS", () => {
    expect(primeArgs()).toEqual(["prime", "--no-color"])
    process.env.SILA_PRIME_ARGS = "--top=8 --json"
    expect(primeArgs()).toEqual(["prime", "--no-color", "--top=8", "--json"])
  })

  test("prime is enabled by default and disabled by flag or value", () => {
    expect(primeDisabled()).toBe(false)
    process.env.SILA_PRIME = "off"
    expect(primeDisabled()).toBe(true)
    delete process.env.SILA_PRIME
    process.env.SILA_PRIME_OFF = "1"
    expect(primeDisabled()).toBe(true)
  })

  test("budget falls back when the value is not a positive number", () => {
    expect(injectionBudget()).toBe(6000)
    process.env.SILA_PRIME_BUDGET = "1200"
    expect(injectionBudget()).toBe(1200)
    process.env.SILA_PRIME_BUDGET = "nope"
    expect(injectionBudget()).toBe(6000)
  })
})

describe("defaultRunner", () => {
  test("returns stdout from a successful command", async () => {
    process.env.SILA_BIN = "echo"
    const result = await defaultRunner(["prime"], process.cwd(), 2000)
    expect(result).toEqual({ ok: true, output: "prime" })
  })

  test("kills a command that runs past its timeout", async () => {
    process.env.SILA_BIN = "sleep"
    const result = await defaultRunner(["5"], process.cwd(), 150)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/timed out after 150ms/)
  })

  test("reports a binary that cannot start", async () => {
    process.env.SILA_BIN = "/nonexistent/sila-does-not-exist"
    const result = await defaultRunner(["prime"], process.cwd(), 2000)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/could not start/)
  })
})

describe("command", () => {
  test("registers /sila", async () => {
    const { commands } = await boot(async () => ok("x"))
    expect(commands.map((entry) => entry.name)).toEqual(["sila"])
  })

  test("runs prime by default and posts the output", async () => {
    const { commands, prompts, calls } = await boot(async () => ok("BRIEFING"))
    await command(commands, "sila").execute({ sessionID: "ses_1", prompt: { text: "" } })
    expect(calls[0].args).toEqual(["prime", "--no-color"])
    expect(calls[0].cwd).toBe("/tmp/project")
    expect(prompts[0]).toEqual({ sessionID: "ses_1", text: "BRIEFING" })
  })

  test("passes a subcommand through", async () => {
    const { commands, calls } = await boot(async () => ok("results"))
    await command(commands, "sila").execute({ sessionID: "ses_1", prompt: { text: 'search "wal mode"' } })
    expect(calls[0].args).toEqual(["search", "wal mode"])
  })

  test("throws the output when sila fails", async () => {
    const { commands, prompts } = await boot(async () => fail("database is locked"))
    await expect(command(commands, "sila").execute({ sessionID: "ses_1", prompt: { text: "status" } })).rejects.toThrow(
      "database is locked",
    )
    expect(prompts).toHaveLength(0)
  })

  test("posts a notice when sila returns no output", async () => {
    const { commands, prompts } = await boot(async () => ok(""))
    await command(commands, "sila").execute({ sessionID: "ses_1" })
    expect(prompts[0].text).toBe("(sila returned no output)")
  })
})

describe("prompt hook", () => {
  test("injects the briefing once on the first prompt", async () => {
    const { hooks, calls } = await boot(async () => ok("PROJECT MEMORY"))
    const first = { sessionID: "ses_1", prompt: { text: "hello" } }
    await hooks.prompt(first)
    expect(first.prompt.text).toContain("<sila_memory>")
    expect(first.prompt.text).toContain("PROJECT MEMORY")
    expect(first.prompt.text.endsWith("hello")).toBe(true)
    const second = { sessionID: "ses_1", prompt: { text: "again" } }
    await hooks.prompt(second)
    expect(second.prompt.text).toBe("again")
    expect(calls).toHaveLength(1)
  })

  test("does not inject when prime is disabled", async () => {
    process.env.SILA_PRIME = "off"
    const { hooks, calls } = await boot(async () => ok("PROJECT MEMORY"))
    const event = { sessionID: "ses_1", prompt: { text: "hello" } }
    await hooks.prompt(event)
    expect(event.prompt.text).toBe("hello")
    expect(calls).toHaveLength(0)
  })

  test("does not inject an empty briefing and does not run again", async () => {
    const { hooks, calls } = await boot(async () => ok("   "))
    const first = { sessionID: "ses_1", prompt: { text: "hello" } }
    await hooks.prompt(first)
    expect(first.prompt.text).toBe("hello")
    await hooks.prompt({ sessionID: "ses_1", prompt: { text: "again" } })
    expect(calls).toHaveLength(1)
  })

  test("does not retry a failed run and keeps the prompt", async () => {
    const { hooks, calls } = await boot(async () => fail("sila is missing"))
    const first = { sessionID: "ses_1", prompt: { text: "hello" } }
    await hooks.prompt(first)
    expect(first.prompt.text).toBe("hello")
    await hooks.prompt({ sessionID: "ses_1", prompt: { text: "again" } })
    expect(calls).toHaveLength(1)
  })

  test("does not throw when the runner throws", async () => {
    const { hooks } = await boot(async () => {
      throw new Error("boom")
    })
    const event = { sessionID: "ses_1", prompt: { text: "hello" } }
    await hooks.prompt(event)
    expect(event.prompt.text).toBe("hello")
  })

  test("ignores an event without a prompt", async () => {
    const { hooks, calls } = await boot(async () => ok("PROJECT MEMORY"))
    await hooks.prompt({ sessionID: "ses_2" })
    expect(calls).toHaveLength(0)
  })
})
