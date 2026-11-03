// Per-step cargo motion for an outside analyser (docs/motion-export.md): every moving body's pose and Jolt velocities
// at every physics step, collected into batches of a fixed number of steps and written as one binary message each.
//
// A body is sampled on every step it is awake. Falling asleep sends its last pose once, flagged, and nothing more
// until it wakes, so a resting line costs nothing. A body's first sample carries what it is (mass, damping, size,
// product) in the batch it first appears in, and a body that leaves is listed with its last step. Steps are absolute
// (the run's step count), so batches join end to end and their size changes nothing a consumer computes.
//
// Fields are fixed-width little-endian, so a reader in any language (a C# BinaryReader) takes them in order.

import type { BoxFrame } from '../frame'

export const MOTION_FORMAT_VERSION = 1
/** the one message type so far */
export const MOTION_BATCH = 1

/** what the sim says of a body this step (MotionStepView.state) */
export const MOTION_ASLEEP = 1
/** held by a gripper, the pilot or a pin: its motion is set by the holder, not by physics */
export const MOTION_HELD = 2
/** a piece of a unit load: its pose is its own, its velocities are the load's body */
export const MOTION_UNIT = 4

/** a sample's flags: the body's first sample */
export const SAMPLE_SPAWN = 1
/** the first sample after it slept: it was at rest until this step */
export const SAMPLE_WAKE = 2
/** its last sample before sleeping: it rests here, with no samples, until a WAKE */
export const SAMPLE_SLEEP = 4
export const SAMPLE_HELD = 8
export const SAMPLE_UNIT = 16

/** floats per sample after its flags byte: position, rotation (x, y, z, w), linear velocity, angular velocity */
export const SAMPLE_FLOATS = 13

/** what a body is, sent once */
export interface MotionBodyInfo {
  /** kg, the body's own (a unit load's piece: the piece's) */
  mass: number
  /** Jolt's per-second damping factors on the body */
  linearDamping: number
  angularDamping: number
  /** the package id of the product it was placed or spawned as, '' for a bare body */
  product: string
}

/** One step of every cargo row's velocities and state, index-aligned with the frame (sim/motionSamples.ts). */
export interface MotionStepView {
  readonly count: number
  /** 3 per row, m/s */
  readonly linVel: Float32Array
  /** 3 per row, rad/s */
  readonly angVel: Float32Array
  /** MOTION_* bits per row */
  readonly state: Uint8Array
  /** what row `row` is, asked only the first time a body is seen */
  info(row: number): MotionBodyInfo
}

export type MotionFrame = Pick<BoxFrame, 'count' | 'ids' | 'positions' | 'quats' | 'halfExtents' | 'partIds' | 'simTime'>

interface Run {
  id: number
  firstStep: number
  flags: number[]
  data: number[]
}

interface NewBody extends MotionBodyInfo {
  id: number
  halfExtents: [number, number, number]
  partId: string
}

/**
 * Collects steps into batches of `batchSteps` and hands each to `emit` as one message (with its length prefix).
 * Feed it every step in order with {@link step}; {@link finish} sends the last, short batch.
 */
export class MotionBatcher {
  /** samples written so far, across every batch */
  samples = 0
  private sequence = 0
  /** the first step of the batch being collected, or null before any */
  private batchFirst: number | null = null
  private lastStep = 0
  /** every body seen and not yet gone: asleep at its last step, and the step it was last in the frame */
  private readonly known = new Map<number, { asleep: boolean; seen: number }>()
  private runs: Run[] = []
  private readonly openRun = new Map<number, Run>()
  private newBodies: NewBody[] = []
  private gone: { id: number; lastStep: number }[] = []

  constructor(
    private readonly hz: number,
    private readonly batchSteps: number,
    private readonly emit: (message: Uint8Array) => void,
  ) {
    if (!Number.isInteger(batchSteps) || batchSteps < 1) throw new Error(`batch size must be a whole number of steps, not ${batchSteps}`)
  }

  /** The frame and motion after step `step` (1 = after the first physics step). Steps must come one after another. */
  step(step: number, frame: Readonly<MotionFrame>, motion: MotionStepView): void {
    if (motion.count !== frame.count) throw new Error(`motion has ${motion.count} rows, the frame ${frame.count}`)
    if (this.batchFirst === null) this.batchFirst = step
    else if (step !== this.lastStep + 1) throw new Error(`step ${step} after step ${this.lastStep}: steps must follow one another`)
    this.lastStep = step

    for (let i = 0; i < frame.count; i++) {
      const id = frame.ids[i]!
      const state = motion.state[i]!
      const asleep = (state & MOTION_ASLEEP) !== 0
      const was = this.known.get(id)
      let flags = 0
      if (!was) {
        flags |= SAMPLE_SPAWN | (asleep ? SAMPLE_SLEEP : 0)
        const h = frame.halfExtents
        this.newBodies.push({ id, ...motion.info(i), halfExtents: [h[i * 3]!, h[i * 3 + 1]!, h[i * 3 + 2]!], partId: frame.partIds[i] ?? '' })
        this.known.set(id, { asleep, seen: step })
      } else {
        if (asleep && !was.asleep) flags |= SAMPLE_SLEEP
        else if (!asleep && was.asleep) flags |= SAMPLE_WAKE
        else if (asleep) {
          was.seen = step
          continue // resting: nothing to send
        }
        was.asleep = asleep
        was.seen = step
      }
      if (state & MOTION_HELD) flags |= SAMPLE_HELD
      if (state & MOTION_UNIT) flags |= SAMPLE_UNIT
      this.sample(id, step, flags, frame, motion, i)
    }

    for (const [id, k] of this.known) {
      if (k.seen === step) continue
      this.gone.push({ id, lastStep: step - 1 })
      this.known.delete(id)
      this.openRun.delete(id)
    }

    if (step - this.batchFirst + 1 >= this.batchSteps) this.flush()
  }

  /** Send what is collected as a last, shorter batch (a run ending between batch boundaries). */
  finish(): void {
    if (this.batchFirst !== null && this.lastStep >= this.batchFirst) this.flush()
  }

  private sample(id: number, step: number, flags: number, frame: Readonly<MotionFrame>, motion: MotionStepView, i: number): void {
    let run = this.openRun.get(id)
    if (!run || run.firstStep + run.flags.length !== step) {
      run = { id, firstStep: step, flags: [], data: [] }
      this.runs.push(run)
      this.openRun.set(id, run)
    }
    run.flags.push(flags)
    this.samples++
    const d = run.data
    const p = frame.positions
    const q = frame.quats
    d.push(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!, q[i * 4]!, q[i * 4 + 1]!, q[i * 4 + 2]!, q[i * 4 + 3]!)
    d.push(motion.linVel[i * 3]!, motion.linVel[i * 3 + 1]!, motion.linVel[i * 3 + 2]!)
    d.push(motion.angVel[i * 3]!, motion.angVel[i * 3 + 1]!, motion.angVel[i * 3 + 2]!)
  }

  private flush(): void {
    const first = this.batchFirst!
    this.emit(encodeBatch({ sequence: this.sequence++, hz: this.hz, firstStep: first, stepCount: this.lastStep - first + 1, newBodies: this.newBodies, runs: this.runs, gone: this.gone }))
    this.batchFirst = this.lastStep + 1
    this.runs = []
    this.openRun.clear() // a run never crosses a batch: the next batch starts each body's samples afresh
    this.newBodies = []
    this.gone = []
  }
}

/** A batch as {@link decodeMotionBatch} reads it. */
export interface MotionBatch {
  sequence: number
  hz: number
  firstStep: number
  stepCount: number
  newBodies: NewBody[]
  /** each body's samples on consecutive steps; a body has more than one run when it slept and woke in the batch */
  runs: { id: number; firstStep: number; flags: Uint8Array; data: Float32Array }[]
  gone: { id: number; lastStep: number }[]
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/** the bytes of a string with its u16 length */
const strBytes = (s: string): Uint8Array => {
  const b = utf8Encoder.encode(s)
  if (b.length > 0xffff) throw new Error('motion export: a string longer than 65535 bytes')
  return b
}

function encodeBatch(b: { sequence: number; hz: number; firstStep: number; stepCount: number; newBodies: NewBody[]; runs: Run[]; gone: { id: number; lastStep: number }[] }): Uint8Array {
  const names = b.newBodies.map((n) => [strBytes(n.product), strBytes(n.partId)] as const)
  let size = 4 + 1 + 1 + 2 + 4 * 3 // length, version, type, hz, sequence, first step, step count
  size += 4 + names.reduce((s, [p, part]) => s + 4 + 4 * 6 + 2 + p.length + 2 + part.length, 0)
  size += 4 + b.runs.reduce((s, r) => s + 12 + r.flags.length * (1 + 4 * SAMPLE_FLOATS), 0)
  size += 4 + b.gone.length * 8

  const buf = new Uint8Array(size)
  const v = new DataView(buf.buffer)
  let n = 0
  const u8 = (x: number): void => void v.setUint8(n++, x)
  const u16 = (x: number): void => {
    v.setUint16(n, x, true)
    n += 2
  }
  const u32 = (x: number): void => {
    v.setUint32(n, x, true)
    n += 4
  }
  const f32 = (x: number): void => {
    v.setFloat32(n, x, true)
    n += 4
  }
  const str = (s: Uint8Array): void => {
    u16(s.length)
    buf.set(s, n)
    n += s.length
  }

  u32(size - 4) // the length prefix counts the bytes after it
  u8(MOTION_FORMAT_VERSION)
  u8(MOTION_BATCH)
  u16(b.hz)
  u32(b.sequence)
  u32(b.firstStep)
  u32(b.stepCount)
  u32(b.newBodies.length)
  b.newBodies.forEach((nb, k) => {
    u32(nb.id)
    f32(nb.mass)
    f32(nb.linearDamping)
    f32(nb.angularDamping)
    for (const h of nb.halfExtents) f32(h)
    str(names[k]![0])
    str(names[k]![1])
  })
  u32(b.runs.length)
  for (const r of b.runs) {
    u32(r.id)
    u32(r.firstStep)
    u32(r.flags.length)
    for (let s = 0; s < r.flags.length; s++) {
      u8(r.flags[s]!)
      for (let k = 0; k < SAMPLE_FLOATS; k++) f32(r.data[s * SAMPLE_FLOATS + k]!)
    }
  }
  u32(b.gone.length)
  for (const g of b.gone) {
    u32(g.id)
    u32(g.lastStep)
  }
  return buf
}

/** Read one message, its length prefix included. Throws on a message that is short, long or of another version. */
export function decodeMotionBatch(msg: Uint8Array): MotionBatch {
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength)
  let n = 0
  const need = (k: number): void => {
    if (n + k > msg.byteLength) throw new Error('motion batch: message ends early')
  }
  const u8 = (): number => {
    need(1)
    return v.getUint8(n++)
  }
  const u16 = (): number => {
    need(2)
    const x = v.getUint16(n, true)
    n += 2
    return x
  }
  const u32 = (): number => {
    need(4)
    const x = v.getUint32(n, true)
    n += 4
    return x
  }
  const f32 = (): number => {
    need(4)
    const x = v.getFloat32(n, true)
    n += 4
    return x
  }
  const str = (): string => {
    const len = u16()
    need(len)
    const s = utf8Decoder.decode(msg.subarray(n, n + len))
    n += len
    return s
  }

  const length = u32()
  if (length !== msg.byteLength - 4) throw new Error(`motion batch: length says ${length} bytes, the message has ${msg.byteLength - 4}`)
  const version = u8()
  if (version !== MOTION_FORMAT_VERSION) throw new Error(`motion batch: format version ${version}, this reader knows ${MOTION_FORMAT_VERSION}`)
  const type = u8()
  if (type !== MOTION_BATCH) throw new Error(`motion batch: message type ${type}`)
  const hz = u16()
  const sequence = u32()
  const firstStep = u32()
  const stepCount = u32()
  const newBodies: NewBody[] = []
  for (let k = u32(); k > 0; k--) {
    const id = u32()
    const mass = f32()
    const linearDamping = f32()
    const angularDamping = f32()
    const halfExtents: [number, number, number] = [f32(), f32(), f32()]
    newBodies.push({ id, mass, linearDamping, angularDamping, halfExtents, product: str(), partId: str() })
  }
  const runs: MotionBatch['runs'] = []
  for (let k = u32(); k > 0; k--) {
    const id = u32()
    const first = u32()
    const count = u32()
    const flags = new Uint8Array(count)
    const data = new Float32Array(count * SAMPLE_FLOATS)
    for (let s = 0; s < count; s++) {
      flags[s] = u8()
      for (let f = 0; f < SAMPLE_FLOATS; f++) data[s * SAMPLE_FLOATS + f] = f32()
    }
    runs.push({ id, firstStep: first, flags, data })
  }
  const gone: MotionBatch['gone'] = []
  for (let k = u32(); k > 0; k--) gone.push({ id: u32(), lastStep: u32() })
  if (n !== msg.byteLength) throw new Error(`motion batch: ${msg.byteLength - n} bytes left over`)
  return { sequence, hz, firstStep, stepCount, newBodies, runs, gone }
}
