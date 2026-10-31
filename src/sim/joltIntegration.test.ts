import initJolt from 'jolt-physics'
import type JoltType from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPackages, registerPackage } from '../core/parts/partRegistry'
import { PACKAGE_FORMAT } from '../core/parts/partPackage'
import type { PackageManifest, PartPackage } from '../core/parts/partPackage'
import { createSdkPart } from '../core/scene/scene'
import { SCENE_VERSION } from '../core/types'
import type { SdkPart } from '../core/types'
import { buildPackage } from './buildPackage'
import { SimWorld } from './world'

// How one Jolt step moves a cargo body, read from the samples an export would carry: position and linear velocity
// after each step. Jolt sets the new velocity first and then moves the body by it (semi-implicit Euler), so
// x1 = x0 + v1 * dt, not x0 + (v0 + v1) / 2 * dt. Within one step the position therefore says nothing the new
// velocity does not, and an analysis that reads a step's position change as constant-acceleration motion sees a
// jerk of -6 * dv / dt^2 that is not there. Acceleration takes two samples (dv / dt) and jerk three.
//
// Damping scales the velocity by k = 1 - c * dt after the step's forces are added: v1 = k * (v0 + a * dt). Cargo has
// no linear damping (bodyFactory.ts) and Jolt's default angular damping, so a free spin decays by k on every axis
// about a fixed axis. A drum rolling without slipping shares that damping with its linear motion through the contact,
// so it decays by 1 - c * dt * I / (I + m R^2), a third of c for a solid cylinder.
//
// An impact's time can be recovered from inside its step by intersecting the line the body came in on with the one it
// leaves on. When the gap at the start of the contact step is within Jolt's speculative contact distance, the solver
// stops the body at the wall face in that step and the intercept is the contact time to a few microseconds. When it
// is not, the body sinks into the wall, is pushed out over several steps, and rests the penetration slop deep, so the
// intercept is late by that slop over the speed.

const Jolt = await initJolt()

const HZ = 100
const DT = 1 / HZ
const G = 9.81
/** the resting penetration world.ts gives Jolt (PENETRATION_SLOP), m */
const PENETRATION_SLOP = 0.005
/** Jolt's default angular damping, which cargo keeps, per second */
const ANGULAR_DAMPING = 0.05

interface LiveBody {
  id: number
  partId: string | null
  body: JoltType.Body
}
const liveBody = (w: SimWorld, match: (b: LiveBody) => boolean): JoltType.Body => (w as unknown as { boxes: LiveBody[] }).boxes.find(match)!.body
const bodyInterface = (w: SimWorld): JoltType.BodyInterface => (w as unknown as { bodyInterface: JoltType.BodyInterface }).bodyInterface
const vec = (v: JoltType.Vec3): [number, number, number] => [v.GetX(), v.GetY(), v.GetZ()]

interface Sample {
  pos: [number, number, number]
  vel: [number, number, number]
}

/** the body's centre and linear velocity after the last step, found by its frame id */
function sample(world: SimWorld, id: number): Sample {
  const f = world.frame()
  const v = world.cargoVelocities()
  const i = Array.from(f.ids).indexOf(id)
  const j = Array.from(v.ids).indexOf(id)
  if (i < 0 || j < 0) throw new Error(`body ${id} is not in the frame`)
  return {
    pos: [f.positions[i * 3]!, f.positions[i * 3 + 1]!, f.positions[i * 3 + 2]!],
    vel: [v.velocities[j * 3]!, v.velocities[j * 3 + 1]!, v.velocities[j * 3 + 2]!],
  }
}

function record(world: SimWorld, id: number, steps: number): Sample[] {
  const out = [sample(world, id)]
  for (let n = 0; n < steps; n++) {
    world.step()
    out.push(sample(world, id))
  }
  return out
}

/** One step on one axis: the position change against the two integration rules, and the two-sample jerk that
 *  assumes constant acceleration within the step. */
function stepOnAxis(a: Sample, b: Sample, axis: 0 | 1 | 2): { dv: number; newVelResidual: number; meanVelResidual: number; twoSampleJerk: number } {
  const dx = b.pos[axis] - a.pos[axis]
  const v0 = a.vel[axis]
  const v1 = b.vel[axis]
  return {
    dv: v1 - v0,
    newVelResidual: dx - v1 * DT,
    meanVelResidual: dx - ((v0 + v1) / 2) * DT,
    twoSampleJerk: (12 * (((v0 + v1) / 2) * DT - dx)) / DT ** 3,
  }
}

/**
 * A box flying along +x at `speed` into a static wall placed so the box reaches it `phase` of the way through its
 * eighth step, with the impact's time recovered from the samples alone: the line in through the last sample before
 * the velocity changed, the line out from the first sample from which the body moves steadily by its velocity again.
 */
function wallImpact(speed: number, phase: number): { contact: number; intercept: number; window: number; restDepth: number } {
  const hx = 0.15
  const w = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [] }, { hz: HZ })
  try {
    const contact = (7 + phase) * DT
    const face = hx + speed * contact
    ;(w as unknown as { bodies: { addStaticBox(...a: number[]): unknown } }).bodies.addStaticBox(0.05, 20, 3, face + 0.05, 50, 0, 0, 0.5)
    const id = w.spawnBoxAt(0, 50, 0, hx, 0.1, 0.15)
    const body = liveBody(w, (b) => b.id === id)
    const v = new Jolt.Vec3(speed, 0, 0)
    bodyInterface(w).SetLinearVelocity(body.GetID(), v)
    Jolt.destroy(v)
    // x is untouched by gravity, so before the wall the box moves at `speed` exactly
    const x = [0]
    const vx = [speed]
    for (let n = 1; n <= 60; n++) {
      w.step()
      x.push(body.GetPosition().GetX())
      vx.push(body.GetLinearVelocity().GetX())
    }
    let n = 1
    while (Math.abs(vx[n]! - speed) < 1e-3) n++
    const steady = (m: number): boolean => Math.abs(vx[m + 1]! - vx[m]!) < 1e-3 && [1, 2].every((k) => Math.abs(x[m + k]! - x[m + k - 1]! - vx[m + k]! * DT) < 1e-5)
    let m = n + 1
    while (!steady(m)) m++
    const tIn = (n - 1) * DT
    const tOut = m * DT
    const vOut = vx[m + 1]!
    const intercept = (x[m]! - x[n - 1]! + speed * tIn - vOut * tOut) / (speed - vOut)
    return { contact, intercept, window: m - n + 1, restDepth: x[m]! - (face - hx) }
  } finally {
    w.dispose()
  }
}

/** a flat 4 m belt along +x that runs at `speed` from sim time `from` on */
function runningBelt(speed: number, from: number): PartPackage {
  const params = {
    segments: { type: 'numberList', arity: 2, default: [[4, 0]], handle: { kind: 'path', lengthCol: 0, tiltCol: 1 } },
    width: { type: 'number', default: 0.6 },
    height: { type: 'number', default: 0.17 },
  }
  const step = `const s = ctx.simTime >= ${from} ? ${speed} : 0; ctx.setSurfaceVelocity({ x: ctx.forward.x * s, y: 0, z: ctx.forward.z * s })`
  return {
    format: PACKAGE_FORMAT,
    id: 'test.running-belt',
    name: 'Running Belt',
    conveyor: { bed: 'path', surface: 'belt' },
    params,
    behavior: `definePart({ params: ${JSON.stringify(params)}, step(ctx) { ${step} } })`,
    geometry: { kind: 'drawn', bounds: { length: 4, width: 0.6, top: 0.17 }, conveys: true },
  } as unknown as PartPackage
}

/** a box dropped from 0.15 m above a belt at the origin, which runs at 0.5 m/s from sim time `from` */
function boxOnBelt(from: number): { world: SimWorld; id: number } {
  registerPackage(runningBelt(0.5, from))
  const belt = { id: 'belt', type: 'part', packageId: 'test.running-belt', position: [0, 1, 0], rotationY: 0, params: {} } as unknown as SdkPart
  const world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [belt] }, { hz: HZ })
  return { world, id: world.spawnBoxAt(0.5, 1.25, 0, 0.15, 0.1, 0.15) }
}

describe('how a Jolt step moves a cargo body', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
    clearPackages()
  })

  it('in free fall the position moves by the new velocity, and a constant gravity reads as no jerk only over three samples', () => {
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [] }, { hz: HZ })
    const id = world.spawnBoxAt(20, 5, 20, 0.15, 0.1, 0.15)
    const samples = record(world, id, 20)

    for (let n = 1; n < samples.length; n++) {
      const y = stepOnAxis(samples[n - 1]!, samples[n]!, 1)
      expect(y.dv).toBeCloseTo(-G * DT, 5)
      // the new-velocity rule holds to float32 rounding; the mean-velocity rule is off by dv * dt / 2 (0.5 mm here)
      expect(Math.abs(y.newVelResidual)).toBeLessThan(1e-5)
      expect(y.meanVelResidual).toBeCloseTo((y.dv * DT) / 2, 5)
      // so the two-sample estimate reports 6 g / dt (about 5900 m/s^3) of jerk where there is none
      expect(y.twoSampleJerk).toBeCloseTo((-6 * y.dv) / DT ** 2, -1)
      expect(Math.abs(y.twoSampleJerk)).toBeGreaterThan(5000)
      // no force acts on x or z
      for (const axis of [0, 2] as const) {
        const s = stepOnAxis(samples[n - 1]!, samples[n]!, axis)
        expect(s.dv).toBe(0)
        expect(Math.abs(s.newVelResidual)).toBeLessThan(1e-6)
      }
    }

    // over three samples the jerk of a constant acceleration is zero to float32 rounding
    for (let n = 2; n < samples.length; n++) {
      const jerk = (samples[n]!.vel[1] - 2 * samples[n - 1]!.vel[1] + samples[n - 2]!.vel[1]) / DT ** 2
      expect(Math.abs(jerk)).toBeLessThan(1)
    }
  })

  it('a belt starting under a resting box speeds it up at a constant rate: a ramp, moved by the new velocity', () => {
    const run = boxOnBelt(1)
    world = run.world
    const samples = record(world, run.id, 2 * HZ)

    // the belt carries the box up to its own speed
    expect(samples[samples.length - 1]!.vel[0]).toBeCloseTo(0.5, 3)

    const ramp: number[] = [] // the sample index after each accelerating step
    for (let n = 1; n < samples.length; n++) {
      const x = stepOnAxis(samples[n - 1]!, samples[n]!, 0)
      expect(Math.abs(x.newVelResidual)).toBeLessThan(1e-5)
      if (x.dv > 1e-3) {
        ramp.push(n)
        expect(x.meanVelResidual).toBeCloseTo((x.dv * DT) / 2, 5)
      }
    }
    // friction drives it over several steps, each adding the same speed, less than gravity would
    expect(ramp.length).toBeGreaterThan(3)
    const accel = ramp.map((n) => (samples[n]!.vel[0] - samples[n - 1]!.vel[0]) / DT)
    for (const a of accel.slice(0, -1)) expect(a).toBeCloseTo(accel[0]!, 1)
    expect(accel[0]!).toBeGreaterThan(1)
    expect(accel[0]!).toBeLessThan(G)
    // inside the ramp the three-sample jerk is zero and the two-sample one is not
    for (const n of ramp.slice(1, -2)) {
      const jerk = (samples[n + 1]!.vel[0] - 2 * samples[n]!.vel[0] + samples[n - 1]!.vel[0]) / DT ** 2
      expect(Math.abs(jerk)).toBeLessThan(1)
      expect(Math.abs(stepOnAxis(samples[n - 1]!, samples[n]!, 0).twoSampleJerk)).toBeGreaterThan(1000)
    }
  })

  it('a box landing on a running belt takes the belt speed in about one step: an impulse', () => {
    const run = boxOnBelt(0)
    world = run.world
    const samples = record(world, run.id, HZ)

    expect(samples[samples.length - 1]!.vel[0]).toBeCloseTo(0.5, 3)
    let biggest = 0
    for (let n = 1; n < samples.length; n++) {
      const x = stepOnAxis(samples[n - 1]!, samples[n]!, 0)
      expect(Math.abs(x.newVelResidual)).toBeLessThan(1e-5)
      biggest = Math.max(biggest, x.dv)
    }
    // the landing's normal impulse lets friction give most of the 0.5 m/s in a single step
    expect(biggest).toBeGreaterThan(0.4)
  })

  it('a free spin decays by k = 1 - c * dt on every axis about a fixed axis, and forces are added before damping', () => {
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [] }, { hz: HZ })
    const id = world.spawnBoxAt(20, 50, 20, 0.15, 0.1, 0.25)
    const body = liveBody(world, (b) => b.id === id)
    const motion = body.GetMotionProperties()
    expect(motion.GetLinearDamping()).toBe(0)
    expect(motion.GetAngularDamping()).toBeCloseTo(ANGULAR_DAMPING, 6)
    // linear damping on this one body, to see where it falls against gravity in the step
    motion.SetLinearDamping(0.05)
    // a spin off every principal axis of an unequal box, which would precess if the step had a gyroscopic term
    const spin = new Jolt.Vec3(3, 5, -2)
    bodyInterface(world).SetAngularVelocity(body.GetID(), spin)
    Jolt.destroy(spin)

    const k = 1 - ANGULAR_DAMPING * DT
    let w0 = [3, 5, -2]
    let vy0 = 0
    for (let n = 0; n < 50; n++) {
      world.step()
      const w1 = vec(body.GetAngularVelocity())
      for (let i = 0; i < 3; i++) expect(w1[i]! / w0[i]!).toBeCloseTo(k, 6)
      const vy1 = body.GetLinearVelocity().GetY()
      expect(vy1).toBeCloseTo(k * (vy0 - G * DT), 6) // forces first, then damping
      expect(Math.abs(vy1 - (k * vy0 - G * DT))).toBeGreaterThan(4e-5) // not damping first
      w0 = w1
      vy0 = vy1
    }
  })

  it('a shoved drum slips at a constant rate, then rolls and decays by 1 - c * dt / 3 in both v and omega', () => {
    const R = 0.29
    const manifest: PackageManifest = {
      id: 'test.drum-side',
      name: 'Drum',
      geometry: { kind: 'rig', links: [{ name: 'shell', shape: { kind: 'cylinder', radius: R, height: 0.88 }, offset: [0, 0, 0], rotation: [0, 0, Math.PI / 2] }], joints: [] },
      cargo: { friction: 0.5 },
    }
    const drum = buildPackage(manifest, "definePart({ params: { mass: { type: 'number', default: 20 }, color: { type: 'color', default: '#2a5d8f' } }, step() {} })")
    registerPackage(drum)
    world = new SimWorld(Jolt, { version: SCENE_VERSION, parts: [createSdkPart(drum, 'drum', [0, R + 0.01, 0], 0)], packages: [drum] }, { hz: HZ })
    for (let n = 0; n < HZ; n++) world.step() // settle on the floor
    const body = liveBody(world, (b) => b.partId === 'drum')
    const shove = new Jolt.Vec3(0, 0, 2)
    bodyInterface(world).SetLinearVelocity(body.GetID(), shove)
    bodyInterface(world).ResetSleepTimer(body.GetID()) // or a body that rested half a second sleeps within the step
    Jolt.destroy(shove)

    const k = 1 - ANGULAR_DAMPING * DT
    const rolling = 1 - (ANGULAR_DAMPING * DT) / 3 // I / (I + m R^2) = 1/3 for a solid cylinder
    let w0 = 0
    let v0 = 2
    const slipAlpha: number[] = []
    const slipDecel: number[] = []
    let rolled = 0
    for (let n = 0; n < 10 * HZ; n++) {
      world.step()
      const w1 = body.GetAngularVelocity().GetX()
      const v1 = body.GetLinearVelocity().GetZ()
      if (Math.abs(v1 - w1 * R) > 1e-3) {
        // slipping: friction is a constant force, so v falls linearly and omega follows k * (omega + alpha * dt)
        slipAlpha.push(w1 / k - w0)
        slipDecel.push(v1 - v0)
      } else if (w0 > 0 && Math.abs(v0 - w0 * R) < 1e-3) {
        // rolling: no constant torque; both decay geometrically at a third of the free-spin rate
        expect(w1 / w0).toBeCloseTo(rolling, 6)
        expect(v1 / v0).toBeCloseTo(rolling, 6)
        rolled++
      }
      w0 = w1
      v0 = v1
    }
    expect(slipAlpha.length).toBeGreaterThan(5)
    for (const a of slipAlpha) expect(a).toBeCloseTo(slipAlpha[0]!, 4)
    for (const d of slipDecel) expect(d).toBeCloseTo(slipDecel[0]!, 4)
    expect(rolled).toBeGreaterThan(5 * HZ)
  })

  it('a wall impact caught by a speculative contact is timed by the line intercept to within 0.1 ms', () => {
    // the gap at the start of the contact step is at most 1.5 cm in each of these
    for (const [speed, phase] of [[0.5, 0.25], [0.5, 0.5], [0.5, 0.75], [2, 0.25], [2, 0.5], [2, 0.75], [5, 0.25]] as const) {
      const hit = wallImpact(speed, phase)
      expect(hit.window, `${speed} m/s at ${phase}`).toBeLessThanOrEqual(3)
      expect(Math.abs(hit.restDepth), `${speed} m/s at ${phase}`).toBeLessThan(2e-4)
      expect(Math.abs(hit.intercept - hit.contact), `${speed} m/s at ${phase}`).toBeLessThan(1e-4)
    }
  })

  it('a fast impact past the speculative distance sinks in by the slop, so its intercept is late by slop / speed', () => {
    // 5 m/s covers 5 cm a step: the gap at the start of the contact step is 2.5 and 3.75 cm
    for (const phase of [0.5, 0.75]) {
      const hit = wallImpact(5, phase)
      // pushed out over several steps, which the residual flags, to rest inside the face
      expect(hit.window, `phase ${phase}`).toBeGreaterThan(5)
      expect(hit.restDepth, `phase ${phase}`).toBeCloseTo(PENETRATION_SLOP, 4)
      expect(hit.intercept - hit.contact, `phase ${phase}`).toBeCloseTo(PENETRATION_SLOP / 5, 4)
      // and taking the slop off the rest position gives the contact time back
      expect(Math.abs(hit.intercept - PENETRATION_SLOP / 5 - hit.contact), `phase ${phase}`).toBeLessThan(1e-4)
    }
  })
})
