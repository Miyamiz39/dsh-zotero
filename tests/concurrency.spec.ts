import { describe, expect, it } from 'vitest'
import { ConcurrencyGate, GateAbortedError, mapWithConcurrency } from '../src/concurrency.js'

describe('mapWithConcurrency', () => {
  it('preserves input order under concurrency', async () => {
    const result = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value))
      return value * 10
    })
    expect(result).toEqual([30, 10, 20])
  })

  it('propagates the first worker rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('worker boom')
        return value
      }),
    ).rejects.toThrow('worker boom')
  })

  it('rejects a non-integer or non-positive concurrency', async () => {
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
      /positive integer/,
    )
    await expect(mapWithConcurrency([1], -2, async (value) => value)).rejects.toThrow(
      /positive integer/,
    )
    await expect(mapWithConcurrency([1], 1.5, async (value) => value)).rejects.toThrow(
      /positive integer/,
    )
  })
})

describe('ConcurrencyGate', () => {
  it('lets at most its limit through and hands slots on in arrival order', async () => {
    const gate = new ConcurrencyGate(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    const hold = async (id: number): Promise<void> => {
      const release = await gate.acquire()
      active += 1
      peak = Math.max(peak, active)
      order.push(id)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      release()
    }
    await Promise.all([1, 2, 3, 4].map(hold))
    expect(peak).toBe(2)
    expect([...order].sort()).toEqual([1, 2, 3, 4])
  })

  it('releases once, no matter how often the release is called', async () => {
    const gate = new ConcurrencyGate(1)
    const release = await gate.acquire()
    release()
    release()
    // A second acquire would hang if the double release had handed out a slot.
    const second = await gate.acquire()
    second()
  })

  it('refuses a waiter whose signal is already aborted', async () => {
    const gate = new ConcurrencyGate(1)
    await expect(gate.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(GateAbortedError)
  })

  it('drops a queued waiter on abort instead of consuming its slot', async () => {
    const gate = new ConcurrencyGate(1)
    const release = await gate.acquire()
    const controller = new AbortController()
    const queued = gate.acquire(controller.signal)
    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(GateAbortedError)
    // The aborted waiter left the queue, so the next holder runs immediately.
    release()
    const next = await gate.acquire()
    next()
  })

  it('rejects a non-integer or non-positive limit', () => {
    expect(() => new ConcurrencyGate(0)).toThrow(/positive integer/)
    expect(() => new ConcurrencyGate(1.5)).toThrow(/positive integer/)
  })
})
