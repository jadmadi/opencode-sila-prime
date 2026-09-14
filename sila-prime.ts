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

const VERSION = "0.1.1"

const DEFAULT_BUDGET = 6000
const DEFAULT_PRIME_TIMEOUT = 5000
const DEFAULT_COMMAND_TIMEOUT = 30000
const LONG_COMMAND_TIMEOUT = 180000
const DEFAULT_OUTPUT_CAP = 20000
const LONG_COMMANDS = new Set(["sync", "live", "ingest", "dream", "vacuum", "update", "doc"])
const OPEN = "<sila_memory>\n"
const CLOSE = "\n</sila_memory>"

// One server process can hold several plugin instances, one per location. A
// process-wide set dedupes them so a single prompt is primed once. Storage
// carries the mark across reloads and processes; this set closes the window
// where two live instances read the store before either writes.
const primed = new Set<string>()

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
  return ["prime", "--no-color", ...tokenize(process.env.SILA_PRIME_ARGS || "")]
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

function isLongCommand(args: string[]): boolean {
  return args.some((arg) => LONG_COMMANDS.has(arg))
}

function commandArgs(text: unknown): { args: string[]; timeoutMs: number } {
  const raw = typeof text === "string" ? text.trim() : ""
  const tokens = raw ? tokenize(raw) : []
  const args = tokens.length > 0 ? tokens : ["prime", "--no-color"]
  const timeoutMs = isLongCommand(args) ? LONG_COMMAND_TIMEOUT : DEFAULT_COMMAND_TIMEOUT
  return { args, timeoutMs }
}

async function defaultRunner(args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  let proc: any
  try {
    proc = Bun.spawn([silaBin(), ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    proc.unref?.()
  } catch (error) {
    return { ok: false, output: `could not start ${silaBin()}: ${error}` }
  }
  const completed = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { code, out: (stdout || "").trim(), err: (stderr || "").trim() }
  })()
  // The read only finishes when the child closes both pipes. A child that
  // ignores the signal, or a grandchild that inherits the pipe, can keep them
  // open past the timeout, so the deadline is raced against the work and the
  // prompt returns without waiting for the streams. The promise is left to
  // settle on its own.
  completed.catch(() => {})
  let timer: any
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const result = await Promise.race([completed, deadline])
    if (result === null) {
      try {
        proc.kill(9)
      } catch {}
      return { ok: false, output: `${silaBin()} ${args.join(" ")} timed out after ${timeoutMs}ms` }
    }
    const output = result.code === 0 ? result.out || result.err : [result.out, result.err].filter(Boolean).join("\n")
    return { ok: result.code === 0, output }
  } catch (error) {
    return { ok: false, output: `${silaBin()} failed: ${error}` }
  } finally {
    clearTimeout(timer)
  }
}

function resolveRunner(ctx: any): Runner {
  return typeof ctx?.silaRunner === "function" ? ctx.silaRunner : defaultRunner
}

function resetPrimed(): void {
  primed.clear()
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
          if (!result.ok) throw new Error(clipOutput(output, outputCap()))
          await ctx.session.prompt({ sessionID, text: clipOutput(output, outputCap()) })
        },
      })
    })

    await ctx.session.hook("prompt", async (event: any) => {
      if (!event?.prompt || typeof event.prompt.text !== "string") return
      if (typeof event.sessionID !== "string" || event.sessionID.length === 0) return
      if (primeDisabled()) return
      // Each plugin instance is bound to one location. Ignore events for other
      // locations so instances do not each prime the same prompt.
      const location = event?.location?.directory
      if (location && ctx.location?.directory && location !== ctx.location.directory) return
      const key = `sila-prime/injected/${event.sessionID}`
      // Add before the first await so sibling instances in this process see the
      // claim immediately.
      if (primed.has(key)) return
      primed.add(key)
      let alreadyInjected: unknown
      try {
        alreadyInjected = await ctx.storage.get(key)
      } catch (error) {
        console.error(`sila-prime: could not read session state: ${error}`)
        return
      }
      if (alreadyInjected) return
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
      if (injection) event.prompt.text = `${injection}\n\n${event.prompt.text}`
    })
  },
}

export { commandArgs, defaultRunner, injectionBudget, primeArgs, primeDisabled, resetPrimed, tokenize, wrapBriefing, VERSION }
export default plugin
