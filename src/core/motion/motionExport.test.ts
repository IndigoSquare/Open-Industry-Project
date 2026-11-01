import { describe, expect, it } from 'vitest'
import {
  decodeMotionBatch,
  MOTION_ASLEEP,
  MOTION_HELD,
  MOTION_UNIT,
  MotionBatcher,
  SAMPLE_FLOATS,
  SAMPLE_HELD,
  SAMPLE_SLEEP,
  SAMPLE_SPAWN,
  SAMPLE_UNIT,
  SAMPLE_WAKE,
} from './motionExport'
import type { MotionBatch, MotionFrame, MotionStepView } from './motionExport'

// The batcher and its wire format against hand-built steps: which samples a body sends as it spawns, sleeps, wakes
// and leaves, that batches join end to end whatever their size, and that every value reads back as written.

interface Body {
  id: number
  x: number
  state?: number
  partId?: string | null
}

/** a frame and its motion with `bodies` in that order; each body's numbers are derived from its id and x */
function stepOf(t: number, bodies: Body[]): { frame: MotionFrame; motion: MotionStepView } {
  const n = bodies.length
  const frame: MotionFrame = {
    count: n,
    ids: Uint32Array.from(bodies.map((b) => b.id)),
    positions: Float32Array.from(bodies.flatMap((b) => [b.x, 1, -b.id])),
    quats: Float32Array.from(bodies.flatMap(() => [0, 0, 0, 1])),
    halfExtents: Float32Array.from(bodies.flatMap((b) => [0.1 * b.id, 0.2, 0.3])),
    partIds: bodies.map((b) => b.partId ?? null),
    simTime: t,
  }
  const motion: MotionStepView = {
    count: n,
    linVel: Float32Array.from(bodies.flatMap((b) => [b.x / 10, 0, 0])),
    angVel: Float32Array.from(bodies.flatMap((b) => [0, b.id, 0])),
    state: Uint8Array.from(bodies.map((b) => b.state ?? 0)),
    info: (row) => ({ mass: 5 * bodies[row]!.id, linearDamping: 0, angularDamping: 0.05, product: `test.p${bodies[row]!.id}` }),
  }
  return { frame, motion }
}

/** run `steps` steps of `scene(step)` through a batcher of `batchSteps` and decode what it sent */
function exportRun(steps: number, batchSteps: number, scene: (step: number) => Body[]): { batches: MotionBatch[]; raw: Uint8Array[] } {
  const raw: Uint8Array[] = []
  const batcher = new MotionBatcher(100, batchSteps, (m) => raw.push(m))
  for (let s = 1; s <= steps; s++) {
    const { frame, motion } = stepOf(s / 100, scene(s))
    batcher.step(s, frame, motion)
  }
  batcher.finish()
  return { batches: raw.map(decodeMotionBatch), raw }
}

/** every sample of body `id` across the batches, as (step, flags, x) */
function samplesOf(batches: MotionBatch[], id: number): { step: number; flags: number; x: number }[] {
  return batches.flatMap((b) =>
    b.runs.filter((r) => r.id === id).flatMap((r) => Array.from(r.flags, (flags, s) => ({ step: r.firstStep + s, flags, x: r.data[s * SAMPLE_FLOATS]! }))),
  )
}

describe('motion export', () => {
  it('writes every value of a sample and a new body, and reads them back as written', () => {
    const { batches, raw } = exportRun(3, 10, (s) => [{ id: 7, x: s * 0.5, partId: 'box-1' }])
    expect(batches).toHaveLength(1)
    const [b] = batches
    // the length prefix counts the bytes after it
    expect(new DataView(raw[0]!.buffer).getUint32(0, true)).toBe(raw[0]!.length - 4)
    expect(b).toMatchObject({ sequence: 0, hz: 100, firstStep: 1, stepCount: 3, gone: [] })
    expect(b!.newBodies).toEqual([{ id: 7, mass: 35, linearDamping: 0, angularDamping: expect.closeTo(0.05, 6), halfExtents: [expect.closeTo(0.7, 6), expect.closeTo(0.2, 6), expect.closeTo(0.3, 6)], product: 'test.p7', partId: 'box-1' }])
    expect(b!.runs).toHaveLength(1)
    const r = b!.runs[0]!
    expect(r.firstStep).toBe(1)
    expect(Array.from(r.flags)).toEqual([SAMPLE_SPAWN, 0, 0])
    // position, rotation (x, y, z, w), linear velocity, angular velocity
    expect(Array.from(r.data.subarray(SAMPLE_FLOATS, 2 * SAMPLE_FLOATS))).toEqual([1, 1, -7, 0, 0, 0, 1, 0.10000000149011612, 0, 0, 0, 7, 0])
  })

  it('sends a resting body once as it falls asleep, again as it wakes, and lists it when it leaves', () => {
    // body 1 moves, sleeps from step 4 to 6, moves again, and is gone after step 9; body 2 is asleep from the start
    const { batches } = exportRun(12, 100, (s) => [
      ...(s <= 9 ? [{ id: 1, x: s, state: s >= 4 && s <= 6 ? MOTION_ASLEEP : 0 }] : []),
      { id: 2, x: 0, state: MOTION_ASLEEP },
    ])
    const one = samplesOf(batches, 1)
    expect(one.map((s) => s.step)).toEqual([1, 2, 3, 4, 7, 8, 9])
    expect(one.map((s) => s.flags)).toEqual([SAMPLE_SPAWN, 0, 0, SAMPLE_SLEEP, SAMPLE_WAKE, 0, 0])
    // sleeping and waking inside one batch splits its samples into two runs
    expect(batches[0]!.runs.filter((r) => r.id === 1).map((r) => [r.firstStep, r.flags.length])).toEqual([
      [1, 4],
      [7, 3],
    ])
    // a body asleep when it first appears sends its pose once, flagged as both
    expect(samplesOf(batches, 2)).toEqual([{ step: 1, flags: SAMPLE_SPAWN | SAMPLE_SLEEP, x: 0 }])
    expect(batches[0]!.gone).toEqual([{ id: 1, lastStep: 9 }])
  })

  it('flags a held body and a unit load piece on every sample', () => {
    const { batches } = exportRun(2, 10, () => [
      { id: 1, x: 0, state: MOTION_HELD },
      { id: 2, x: 0, state: MOTION_UNIT },
    ])
    expect(samplesOf(batches, 1).map((s) => s.flags)).toEqual([SAMPLE_SPAWN | SAMPLE_HELD, SAMPLE_HELD])
    expect(samplesOf(batches, 2).map((s) => s.flags)).toEqual([SAMPLE_SPAWN | SAMPLE_UNIT, SAMPLE_UNIT])
  })

  it('joins batches end to end, so the batch size changes no sample', () => {
    const scene = (s: number): Body[] => [
      { id: 1, x: s, state: s % 37 < 10 ? MOTION_ASLEEP : 0 },
      ...(s >= 50 && s < 180 ? [{ id: 2, x: -s }] : []),
    ]
    const whole = exportRun(250, 1000, scene).batches
    for (const size of [1, 7, 100]) {
      const { batches } = exportRun(250, size, scene)
      expect(batches).toHaveLength(Math.ceil(250 / size))
      batches.forEach((b, k) => {
        expect(b.sequence).toBe(k)
        expect(b.firstStep).toBe(k * size + 1)
        expect(b.stepCount).toBe(Math.min(size, 250 - k * size))
      })
      for (const id of [1, 2]) expect(samplesOf(batches, id)).toEqual(samplesOf(whole, id))
      // each body is described once, in the batch it first appears in
      expect(batches.flatMap((b) => b.newBodies.map((n) => n.id))).toEqual([1, 2])
      expect(batches.flatMap((b) => b.gone)).toEqual([{ id: 2, lastStep: 179 }])
    }
  })

  it('refuses steps out of order, and a message that is cut short, padded or of another version', () => {
    const batcher = new MotionBatcher(100, 10, () => {})
    const { frame, motion } = stepOf(0, [{ id: 1, x: 0 }])
    batcher.step(1, frame, motion)
    expect(() => batcher.step(3, frame, motion)).toThrow(/must follow/)
    expect(() => new MotionBatcher(100, 0, () => {})).toThrow(/whole number/)

    const { raw } = exportRun(2, 10, () => [{ id: 1, x: 0 }])
    const msg = raw[0]!
    expect(() => decodeMotionBatch(msg.subarray(0, msg.length - 1))).toThrow(/length says/)
    const padded = new Uint8Array(msg.length + 1)
    padded.set(msg)
    new DataView(padded.buffer).setUint32(0, padded.length - 4, true)
    expect(() => decodeMotionBatch(padded)).toThrow(/left over/)
    const other = msg.slice()
    other[4] = 99
    expect(() => decodeMotionBatch(other)).toThrow(/version 99/)
  })
})
