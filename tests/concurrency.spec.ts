import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '../src/concurrency.js'

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
