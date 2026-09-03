/**
 * Parsing of `im receive <id> --wait` stdout into the closed set of note
 * kinds the bridge routes on. The formats below are the v0.3.0 CLI contract,
 * live-verified: one cycle prints either an arrival block, one membership or
 * mission-ended notice, or the idle timeout line — never a mix, since the
 * CLI returns after the first delivery.
 * @module @deepseek-ai/dsh-im-bridge/notes
 */

/** A mission arrival pinned to one station the member guards. */
export interface ArrivalNote {
  readonly kind: 'arrival'
  /** Station key the mission sits at. */
  readonly station: string
  /** The arrived mission id (`ms_…`). */
  readonly missionId: string
}

/** A workspace notice about a mission the member participated in. */
export interface MissionEndedNote {
  readonly kind: 'mission-ended'
  /** The ended mission id. */
  readonly missionId: string
}

/** The member was removed or archived; the loop must stop and not re-hang. */
export interface MembershipEndNote {
  readonly kind: 'membership-end'
}

/** The receive cycle timed out with nothing to deliver. */
export interface TimeoutNote {
  readonly kind: 'timeout'
}

/** One parsed line of receive output. */
export type ImNote = ArrivalNote | MissionEndedNote | MembershipEndNote | TimeoutNote

/** `[station <key>] [ms_…] <from> → <to> (round: <outcome>)` and its peers. */
const ARRIVAL = /^\[station (?<station>\S+)\] \[(?<missionId>ms_\S+)\] \S+ → \S+ \(round: .+\)$/
/** `[from workspace] [ms_…] mission ended: <disposition> (<outcome>)`. */
const MISSION_ENDED = /^\[from workspace\] \[(?<missionId>ms_\S+)\] mission ended: .+$/
/** The membership-end farewell the CLI prints before exiting its loop. */
const MEMBERSHIP_END = /^\[membership\] you are no longer an active member/
/** The idle-cycle line every timeout exit prints. */
const TIMED_OUT = /^No new messages \(timed out after \d+s\)\.$/

/**
 * Parse one receive cycle's stdout into the notes it carries.
 *
 * Guidance lines (`  → Run: …`) and any line that matches no known format
 * are dropped rather than guessed at: the bridge acts only on shapes the IM
 * CLI is known to print, and an unrecognized line is more likely a new CLI
 * format than a routing input. An empty output (a killed child) parses to an
 * empty list — the caller treats it as one more cycle.
 * @param stdout - the complete stdout of one exited `im receive` child.
 * @returns the recognized notes, in printed order.
 */
export function parseReceiveStdout(stdout: string): ImNote[] {
  const notes: ImNote[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '') continue
    let match = ARRIVAL.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      notes.push({ kind: 'arrival', station: match[1], missionId: match[2] })
      continue
    }
    match = MISSION_ENDED.exec(line)
    if (match?.[1] !== undefined) {
      notes.push({ kind: 'mission-ended', missionId: match[1] })
      continue
    }
    if (MEMBERSHIP_END.test(line)) {
      notes.push({ kind: 'membership-end' })
      continue
    }
    if (TIMED_OUT.test(line)) notes.push({ kind: 'timeout' })
  }
  return notes
}
