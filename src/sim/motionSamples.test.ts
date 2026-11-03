import initJolt from 'jolt-physics'
import type Jolt from 'jolt-physics'
import { afterEach, describe, expect, it } from 'vitest'
import { MOTION_ASLEEP, MOTION_HELD, MOTION_UNIT } from '../core/motion/motionExport'
import { SCENE_VERSION } from '../core/types'
import { SimWorld } from './world'

// What the motion export reads of a real world each step (motionSamples.ts): Jolt's velocities row for row with the
// frame, and the sleep, hold and unit-load state, as a box falls, lands and sleeps, is pinned, and is joined to another.

const J = await initJolt()

interface LiveBody {
  id: number
  body: Jolt.Body
}
const bodyOf = (w: SimWorld, id: number): Jolt.Body => (w as unknown as { boxes: LiveBody[] }).boxes.find((b) => b.id === id)!.body
/** the row of body `id` in this step's frame */
const rowOf = (w: SimWorld, id: number): number => Array.from(w.frame().ids).indexOf(id)

describe('motion samples', () => {
  let world: SimWorld | null = null
  afterEach(() => {
    world?.dispose()
    world = null
  })

  it("reports each row's Jolt velocities, and the box's sleep once it has landed and rested", () => {
    world = new SimWorld(J, { version: SCENE_VERSION, parts: [] }, { hz: 100 })
    const id = world.spawnBoxAt(0, 1, 0, 0.15, 0.1, 0.15)
    const spun = world.spawnBoxAt(3, 100, 0, 0.15, 0.1, 0.15) // still falling after 3 s
    const spin = new J.Vec3(0, 2, 0)
    ;(world as unknown as { bodyInterface: Jolt.BodyInterface }).bodyInterface.SetAngularVelocity(bodyOf(world, spun).GetID(), spin)
    J.destroy(spin)

    let sleptAt = -1
    for (let n = 1; n <= 300; n++) {
      world.step()
      const m = world.motionStep()
      expect(m.count).toBe(world.frame().count)
      for (const bid of [id, spun]) {
        const row = rowOf(world, bid)
        const v = bodyOf(world, bid).GetLinearVelocity()
        const w = bodyOf(world, bid).GetAngularVelocity()
        expect(Array.from(m.linVel.subarray(row * 3, row * 3 + 3))).toEqual([v.GetX(), v.GetY(), v.GetZ()].map(Math.fround))
        expect(Array.from(m.angVel.subarray(row * 3, row * 3 + 3))).toEqual([w.GetX(), w.GetY(), w.GetZ()].map(Math.fround))
      }
      const asleep = (m.state[rowOf(world, id)]! & MOTION_ASLEEP) !== 0
      if (asleep && sleptAt < 0) sleptAt = n
      if (sleptAt > 0) expect(asleep).toBe(true)
    }
    // the box drops 0.9 m in about 0.4 s and rests half a second before Jolt puts it to sleep
    expect(sleptAt).toBeGreaterThan(80)
    expect(sleptAt).toBeLessThan(200)
    expect(world.motionStep().state[rowOf(world, spun)]! & MOTION_ASLEEP).toBe(0)
    expect(world.motionStep().info(rowOf(world, id))).toEqual({ mass: expect.any(Number), linearDamping: 0, angularDamping: expect.closeTo(0.05, 6), product: 'oip.box' })
  })

  it('flags a pinned body as held, and the pieces of a unit load', () => {
    world = new SimWorld(J, { version: SCENE_VERSION, parts: [] }, { hz: 100 })
    const pinned = world.spawnBoxAt(0, 1, 0, 0.15, 0.1, 0.15)
    const a = world.spawnBoxAt(3, 0.1, 0, 0.15, 0.1, 0.15)
    const b = world.spawnBoxAt(3, 0.3, 0, 0.15, 0.1, 0.15)
    world.step()
    expect(world.pinBody(pinned, true)).toBe(true)
    const rows = [a, b].map((id) => rowOf(world!, id))
    expect((world as unknown as { cargo: { joinRows(rows: number[]): unknown } }).cargo.joinRows(rows)).not.toBeNull()
    world.step()
    const m = world.motionStep()
    expect(m.state[rowOf(world, pinned)]! & MOTION_HELD).toBe(MOTION_HELD)
    for (const id of [a, b]) expect(m.state[rowOf(world, id)]! & MOTION_UNIT).toBe(MOTION_UNIT)
    expect(world.pinBody(pinned, false)).toBe(true)
    world.step()
    expect(world.motionStep().state[rowOf(world, pinned)]! & MOTION_HELD).toBe(0)
  })
})
