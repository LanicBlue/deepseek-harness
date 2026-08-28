import { describe, expect, it } from 'vitest'
import { Coordinator, ReservationError } from '../src/coordinator.ts'
import { Plane } from '../src/plane.ts'
import { FailureCategory, LaneStatus, Priority } from '../src/types.ts'

describe('Coordinator', () => {
  it('resolves immediately when the lane has capacity', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true })
    const coordinator = new Coordinator(plane)
    const reservation = await coordinator.reserve('openai', Priority.P2)
    expect(reservation.lane).toBe('openai')
  })

  it('queues when the lane is saturated and resolves on release', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    const first = await coordinator.reserve('openai', Priority.P2)
    const secondPromise = coordinator.reserve('openai', Priority.P2)
    // Defer to the next tick so the queue is established before we release.
    await Promise.resolve()
    coordinator.release(first)
    const second = await secondPromise
    expect(second.lane).toBe('openai')
  })

  it('rejects a disabled lane', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: false })
    const coordinator = new Coordinator(plane)
    await expect(coordinator.reserve('openai', Priority.P2)).rejects.toBeInstanceOf(ReservationError)
  })

  it('rejects when the signal aborts before admission', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    await coordinator.reserve('openai', Priority.P2)
    const controller = new AbortController()
    controller.abort()
    await expect(
      coordinator.reserve('openai', Priority.P2, controller.signal),
    ).rejects.toBeInstanceOf(ReservationError)
  })

  it('rejects a queued waiter when its signal aborts', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    await coordinator.reserve('openai', Priority.P2)
    const controller = new AbortController()
    const pending = coordinator.reserve('openai', Priority.P2, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ReservationError)
  })

  it('an aborted queued waiter leaves no ghost in the plane queue', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    const admitted = await coordinator.reserve('openai', Priority.P2)
    const controller = new AbortController()
    const ghost = coordinator.reserve('openai', Priority.P0, controller.signal)
    const real = coordinator.reserve('openai', Priority.P3)
    await Promise.resolve()
    expect(plane.status().totalQueued).toBe(2)
    controller.abort()
    await expect(ghost).rejects.toBeInstanceOf(ReservationError)
    // The aborted waiter is gone from the plane queue, not just the pending map.
    expect(plane.status().totalQueued).toBe(1)
    // Releasing the in-flight slot promotes the REAL waiter, not the ghost:
    // the slot is delivered and the queue drains.
    coordinator.release(admitted)
    const promoted = await real
    expect(promoted.lane).toBe('openai')
    expect(plane.status().totalQueued).toBe(0)
  })

  it('promoteProbeWaiter resolves the parked waiter instead of hanging it', async () => {
    const plane = new Plane({ recovery: { initialCooldownMs: 1_000, maxCooldownMs: 10_000 } })
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    const admitted = await coordinator.reserve('openai', Priority.P2)
    const waiter = coordinator.reserve('openai', Priority.P1)
    await Promise.resolve()
    // Circuit opens, cooldown elapses, the lane transitions to probing.
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 1_000 },
      'openai',
      { code: 'TRANSPORT', message: 'boom' },
      0,
      'boom',
    )
    plane.advanceClock(2_000)
    expect(plane.status().lanes[0]?.status).toBe(LaneStatus.PROBING)
    coordinator.promoteProbeWaiter('openai')
    // The parked promise settles with a grant on the probing lane…
    const probe = await waiter
    expect(probe.lane).toBe('openai')
    expect(plane.status().totalInFlight).toBe(2)
    coordinator.release(admitted)
    // A successful probe settle restores the lane to healthy.
    coordinator.release(probe)
    expect(plane.status().lanes[0]?.status).toBe(LaneStatus.HEALTHY)
    expect(plane.status().totalInFlight).toBe(0)
  })

  it('a failed probe settle re-opens the circuit with a doubled cooldown', async () => {
    const plane = new Plane({ recovery: { initialCooldownMs: 1_000, maxCooldownMs: 10_000 } })
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    await coordinator.reserve('openai', Priority.P2)
    const waiter = coordinator.reserve('openai', Priority.P1)
    await Promise.resolve()
    plane.applyDecision(
      { kind: 'open_circuit', category: FailureCategory.TRANSIENT, cooldownMs: 1_000 },
      'openai',
      { code: 'TRANSPORT', message: 'boom' },
      0,
      'boom',
    )
    plane.advanceClock(2_000)
    coordinator.promoteProbeWaiter('openai')
    const probe = await waiter
    coordinator.release(probe, false)
    const lane = plane.status().lanes[0]
    expect(lane?.status).toBe(LaneStatus.CIRCUIT_OPEN)
    // Doubled from the 1_000 ms initial cooldown.
    expect(lane?.cooldownUntilMs).toBeGreaterThanOrEqual(2_000)
  })

  it('disposeAll rejects every pending reservation', async () => {
    const plane = new Plane({})
    plane.registerLane('openai', { enabled: true, maxConcurrency: 1 })
    const coordinator = new Coordinator(plane)
    await coordinator.reserve('openai', Priority.P2)
    const pending = coordinator.reserve('openai', Priority.P2)
    await Promise.resolve()
    coordinator.disposeAll('test')
    await expect(pending).rejects.toBeInstanceOf(ReservationError)
  })
})
