// OpenCode V2 sila-prime plugin.
//
// Runs `sila prime` in the session's project directory on the first prompt of a
// session and injects the briefing as <sila_memory>. This lets the cross-tool
// sila knowledge store prime OpenCode without running the CLI by hand. The
// plugin also registers a /sila command that runs a sila subcommand and posts
// the result to the session.
//
// The runtime does not resolve @opencode/plugin, so this file exports a plain
// { id, setup } object and uses Bun globals. It shells out to the sila CLI and
// never reads or writes sila's database directly.

const DEFAULT_BUDGET = 6000
const DEFAULT_PRIME_TIMEOUT = 5000
const DEFAULT_COMMAND_TIMEOUT = 30000
const LONG_COMMAND_TIMEOUT = 180000
const DEFAULT_OUTPUT_CAP = 20000
const LONG_COMMANDS = new Set(["sync", "watch", "live", "ingest", "dream", "reconcile", "vacuum", "update"])
const OPEN = "<sila_memory>\n"
const CLOSE = "\n</sila_memory>"

type RunResult = { ok: boolean; output: string }
type Runner = (args: string[], cwd: string, timeoutMs: number) => Promise<RunResult>

function silaBin(): string {
  return process.env.SILA_BIN || "sila"
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function primeDisabled(): boolean {
  if (process.env.SILA_PRIME_OFF === "1") return true
  const value = (process.env.SILA_PRIME || "").toLowerCase()
  return value === "off" || value === "0" || value === "false"
}

function injectionBudget(): number {
  return numberEnv("SILA_PRIME_BUDGET", DEFAULT_BUDGET)
}

function primeTimeout(): number {
  return numberEnv("SILA_PRIME_TIMEOUT", DEFAULT_PRIME_TIMEOUT)
}

function outputCap(): number {
  return numberEnv("SILA_OUTPUT_CAP", DEFAULT_OUTPUT_CAP)
}

function primeArgs(): string[] {
  const extra = (process.env.SILA_PRIME_ARGS || "").split(/\s+/).filter(Boolean)
  return ["prime", "--no-color", ...extra]
}

function wrapBriefing(output: string, budget: number): string {
  const text = (output || "").trim()
  if (!text) return ""
  const room = budget - OPEN.length - CLOSE.length
  if (room <= 0) return ""
  const body = text.length > room ? text.slice(0, room) : text
  return `${OPEN}${body}${CLOSE}`
}

function projectCwd(ctx: any): string {
  const directory = ctx?.location?.directory
  return typeof directory === "string" && directory.length > 0 ? directory : process.cwd()
}

function clipOutput(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n(truncated at ${cap} characters)`
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return tokens
}

function commandArgs(text: unknown): { args: string[]; timeoutMs: number } {
  const raw = typeof text === "string" ? text.trim() : ""
  const tokens = raw ? tokenize(raw) : []
  const args = tokens.length > 0 ? tokens : ["prime", "--no-color"]
  const timeoutMs = LONG_COMMANDS.has(args[0]) ? LONG_COMMAND_TIMEOUT : DEFAULT_COMMAND_TIMEOUT
  return { args, timeoutMs }
}

async function defaultRunner(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  let proc: any
  try {
    proc = Bun.spawn([silaBin(), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return { ok: false, output: `could not start ${silaBin()}: ${error}` }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {}
  }, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    if (timedOut) return { ok: false, output: `${silaBin()} ${args.join(" ")} timed out after ${timeoutMs}ms` }
    const output = (stdout || "").trim()
    const error = (stderr || "").trim()
    return { ok: code === 0, output: output || error }
  } catch (error) {
    return { ok: false, output: `${silaBin()} failed: ${error}` }
  } finally {
    clearTimeout(timer)
  }
}

function resolveRunner(ctx: any): Runner {
  return typeof ctx?.silaRunner === "function" ? ctx.silaRunner : defaultRunner
}

const plugin = {
  id: "sila-prime",
  async setup(ctx: any) {
    const run = resolveRunner(ctx)

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "sila",
        description: "Run a sila command (default: prime)",
        execute: async ({ prompt, sessionID }: any) => {
          const { args, timeoutMs } = commandArgs(prompt?.text)
          const result = await run(args, projectCwd(ctx), timeoutMs)
          const output = result.output || "(sila returned no output)"
          if (!result.ok) throw new Error(output)
          await ctx.session.prompt({ sessionID, text: clipOutput(output, outputCap()) })
        },
      })
    })

    await ctx.session.hook("prompt", async (event: any) => {
      if (!event?.prompt) return
      if (primeDisabled()) return
      const key = `sila-prime/injected/${event.sessionID}`
      if (await ctx.storage.get(key)) return
      let injection = ""
      try {
        const result = await run(primeArgs(), projectCwd(ctx), primeTimeout())
        if (result.ok) injection = wrapBriefing(result.output, injectionBudget())
      } catch (error) {
        console.error(`sila-prime: prime failed: ${error}`)
      }
      // Mark the session after one attempt, even when the briefing is empty or
      // the run failed, so a quiet or missing sila does not add work on every
      // prompt. Use /sila to refresh on demand.
      try {
        await ctx.storage.set(key, true)
      } catch (error) {
        console.error(`sila-prime: could not record the session: ${error}`)
      }
      if (!injection) return
      event.prompt.text = `${injection}\n\n${event.prompt.text ?? ""}`
    })
  },
}

export { commandArgs, defaultRunner, injectionBudget, primeArgs, primeDisabled, tokenize, wrapBriefing }
export default plugin
