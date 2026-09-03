/**
 * The IM command surface the bridge consumes, as one interface plus the
 * child-process implementation. IM is used exactly as shipped (v0.3.0
 * semantics): every command is a one-shot process whose workspace is the
 * nearest ancestor `.im/` of its cwd, so every runner call pins the workspace
 * by running the child inside it. Tests substitute the interface; nothing
 * else in the package spawns processes.
 * @module @deepseek-ai/dsh-im-bridge/im-cli
 */

import { spawn } from 'node:child_process'
import type { Config } from './index.ts'

/** One completed `im receive --wait` cycle. */
export interface ReceiveCycle {
  /** The cycle's complete stdout. */
  readonly stdout: string
  /** The child's exit code (im exits 0 both on delivery and on timeout). */
  readonly code: number
}

/**
 * The IM commands the bridge runs, one method each.
 *
 * Members join through {@link join} only after {@link roster} shows the exact
 * id absent — `im join` auto-suffixes a taken active id (`dsh-plan` becomes
 * `dsh-plan-2`), which would silently fork the member identity the loops
 * then listen on.
 */
export interface ImRunner {
  /** Run `im agents` and return its stdout (`  <id> — <status> [tier]` rows). */
  roster(workspace: string): Promise<string>
  /** Run `im join <id>`; must be preceded by a {@link roster} check. */
  join(workspace: string, memberId: string): Promise<void>
  /**
   * Run one `im receive <memberId> --wait --timeout <sec>` cycle. The child
   * dies on abort; a killed cycle resolves with whatever stdout it printed.
   */
  receive(workspace: string, memberId: string, signal: AbortSignal): Promise<ReceiveCycle>
  /** Run `im mission show <missionId> --for <memberId>` and return its stdout. */
  missionShow(workspace: string, memberId: string, missionId: string): Promise<string>
}

/**
 * Whether one roster stdout lists the exact member id.
 *
 * Row-anchored rather than substring: `dsh-plan` must not match the roster
 * line of `dsh-plan-2`, and the id cannot appear as a station or tier word.
 * @param rosterStdout - stdout of a completed `im agents` run.
 * @param memberId - the exact member id to look for.
 * @returns true when a roster row leads with the id.
 */
export function rosterHasMember(rosterStdout: string, memberId: string): boolean {
  return rosterStdout
    .split('\n')
    .some(line => line.startsWith(`  ${memberId} — `))
}

/** Spawn `im` once, collect stdout, and fail loud on a nonzero exit. */
function runIm(
  config: Config,
  workspace: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.imBin, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    let stderr = ''
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const aborted = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', aborted, { once: true })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', aborted)
      reject(new Error(`im-bridge: cannot run ${JSON.stringify(config.imBin)}: ${String(error)}`))
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', aborted)
      if (code === 0) {
        resolve({ stdout, code })
        return
      }
      if (signal?.aborted === true) {
        // A cycle killed mid-listen is the loop's own shutdown, not an im
        // failure; hand back the partial stdout and let the caller stop.
        resolve({ stdout, code: code ?? -1 })
        return
      }
      reject(new Error(
        `im-bridge: im ${args.join(' ')} in ${workspace} exited ${String(code)}: ${stderr.trim()}`,
      ))
    })
  })
}

/** {@link ImRunner} over real `im` child processes. */
export class ProcessImRunner implements ImRunner {
  private readonly config: Config

  constructor(config: Config) {
    this.config = config
  }

  async roster(workspace: string): Promise<string> {
    const { stdout } = await runIm(this.config, workspace, ['agents'])
    return stdout
  }

  async join(workspace: string, memberId: string): Promise<void> {
    await runIm(this.config, workspace, ['join', memberId])
  }

  async receive(workspace: string, memberId: string, signal: AbortSignal): Promise<ReceiveCycle> {
    const timeoutSec = String(Math.max(1, Math.trunc(this.config.receiveTimeoutSec)))
    return await runIm(
      this.config,
      workspace,
      ['receive', memberId, '--wait', '--timeout', timeoutSec],
      signal,
    )
  }

  async missionShow(workspace: string, memberId: string, missionId: string): Promise<string> {
    const { stdout } = await runIm(
      this.config,
      workspace,
      ['mission', 'show', missionId, '--for', memberId],
    )
    return stdout
  }
}
