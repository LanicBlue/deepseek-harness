import { describe, expect, it } from 'vitest'
import { Coordinator, ReservationError } from '../src/coordinator.ts'
import { Plane } from '../src/plane.ts'
import { Priority } from '../src/types.ts'

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
