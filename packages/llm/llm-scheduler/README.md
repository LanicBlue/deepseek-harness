# `@deepseek-ai/dsh-llm-scheduler`

English | [中文](README.zh.md)

Service plugin that schedules every model call through an in-process admission plane on the `llm/stream` waterfall. Each call reserves a per-provider lane slot before the adapter boundary; lanes enforce bounded concurrency with priority-FIFO ordering over `P0`-`P4`, and physical failures degrade lane or route availability with cooldown probes that requalify real queued waiters. State is process-live: a restart starts a fresh observation epoch, and the requesting agent turns die with the process, so nothing strands.

The scheduling core is a faithful port of a battle-tested control plane: a synchronous pure state machine (admission, CAS-fenced mutation, priority-FIFO drain) plus a reservation coordinator that bridges its synchronous drain to asynchronous waiters. Two adaptations carry it onto this harness's stream protocol: failure facts derive from the harness's already-normalized `LlmFailure` taxonomy (codes like `TRANSPORT`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED` map to scheduling categories; the vendor-error classification waterfall of the original is unnecessary and absent), and the physical attempt is the `next()` of the `llm/stream` waterfall rather than an SDK call — adapters stay exactly as they are, and the existing no-retry-at-adapter discipline (`pi-ai` pins SDK `maxRetries` to zero; the DeepSeek adapter uses raw fetch) already guarantees that retry authority is central.

Every stream terminal settles the plane before its finish chunk propagates upstream, so a freed slot re-dispatches immediately. Normal stops, tool calls, and max-tokens completions prove nothing about provider health and complete silently. An error finish is normalized into into a redacted failure fact and disposed: transient classes (`transport`, `timeout`, `server_overload`) open the lane circuit; rate windows and model unavailability with a reset hint block until that time; authentication and invalid model configuration block configuration; call-scoped classes (`empty_response`, `invalid_request`, policy rejections) fail the single call and leave lane health untouched. After the disposition applies, the logical call is cancelled — retry policy (`dsh-llm-retry`) owns any re-attempt as a fresh call with its own durable budget, so a disposition-suspended orphan can never be selected as a probe or resume into an ownerless slot.

Cooldown recovery requalifies lanes through real traffic, never synthetic health requests: when the cooldown (exponential from `initialCooldownMs`, capped at `maxCooldownMs`, doubling per consecutive probe failure) elapses, the scope transitions to `probing` and the plane's highest-priority queued waiter dispatches as the probe attempt. Its success proves the scope healthy and releases the remaining waiters; its failure re-opens the circuit with a doubled cooldown. Configuration-scope blocks (`BLOCK_CONFIG`, `BLOCK_MANUAL`) never auto-recover; a lane reconfiguration resets availability to healthy, starting a new observation epoch.

```yaml
- name: '@deepseek-ai/dsh-llm-scheduler'
  config:
    priorityByPurpose:
      compaction: P0
      conversation: P1
      'session-title': P4
    lanes:
        openai:
          enabled: true
          maxConcurrency: 2
    recovery:
      initialCooldownMs: 5000
      maxCooldownMs: 300000
```

Unconfigured lanes schedule unlimited — the default composition changes no behavior until a lane is configured.

## Policy extension events

The scheduler opens its two decision points as Cordis `bail` events: policy plugins (including dynamic packages an agent defines at runtime) listen and reshape routing and adjudication without forking this package:

- `llm/scheduler-route` — consulted before every admission. A listener returning a lane key reroutes the call (time-of-day routing, maintenance windows, canary splits); return `undefined` or `false` to abstain. The winning key rewrites `options.provider` in place, so the reservation and the physical dispatch stay on one lane.
- `llm/scheduler-decide` — consulted after every error finish, before the built-in disposition table. A listener returning a `FailureDecision` wins; `{ kind: 'retarget', to, openCircuitMs? }` is executed by the gate itself: it releases the source slot, opens the source circuit when hinted, and re-admits the call on the target lane (bounded to 2 hops per call, guarding against policy loops).

Both events dispatch in listener-registration order (`ctx.on(name, listener, true)` prepends); listeners must be synchronous and side-effect free, and a listener that throws voids the whole consultation, falling back to the built-in behavior. Event facts carry routing/adjudication fields only, and failure facts arrive redacted.

```ts
// A time-of-day routing policy plugin (host half; the same code mounts
// unchanged as a dynamic package or a patch row).
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.on('llm/scheduler-route', facts =>
    isOfficePeak(facts.now) && facts.provider === 'deepseek-official'
      ? 'deepseek-backup'
      : undefined)
}
```

## Model Experience

None, as the scheduler gates and forwards stream chunks — it neither assembles nor sends provider requests and never enters any model request's data path or output.

#### KV Cache effect

None, as the scheduler neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- **Cross-provider failover** stays out: a degraded lane parks callers; route switching belongs to a future `agent/request` policy with a configured fallback chain.
- **Per-owner priority semantics.** The original derives `P0`-`P4` from durable owner types; the harness exposes only `purpose` (`compaction`, `session-title`, else conversation), so the mapping is purpose-to-class, configurable but coarser: a session's background subagent calls share `P1` with its interactive turns.
- **Durable retry budgets in the plane.** Retry counting stays entirely in `dsh-llm-retry`'s session events; the plane's transient budget exists only as probe-failure backoff.
- **Configured fallback chains** stay out for now: `retarget` executes listener-directed hops on failure (see `llm/scheduler-decide`), but a durable per-route fallback chain belongs to a future `agent/request` policy.