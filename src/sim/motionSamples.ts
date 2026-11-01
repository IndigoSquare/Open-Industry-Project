// What the motion export (core/motion/motionExport.ts) needs of each cargo row beyond the frame: Jolt's own linear and
// angular velocity and whether the body sleeps, is held or is a unit load's piece. Read once per step for every row,
// into buffers kept between steps, so a per-step export allocates nothing while the cargo count holds.
import type Jolt from 'jolt-physics'
import { MOTION_ASLEEP, MOTION_HELD, MOTION_UNIT, type MotionBodyInfo, type MotionStepView } from '../core/motion/motionExport'
import type { BodyHolder, LiveBox } from './worldTypes'

/** what a sample reads of the world */
export interface MotionDeps {
  readonly boxes: readonly LiveBox[]
  readonly holders: ReadonlyMap<number, BodyHolder>
  readonly bodyInterface: Jolt.BodyInterface
}

export class MotionSamples implements MotionStepView {
  count = 0
  linVel = new Float32Array(0)
  angVel = new Float32Array(0)
  state = new Uint8Array(0)
  private boxes: readonly LiveBox[] = []

  /** Every row of `deps.boxes` (the frame's order) this step. The returned view is this object, valid until the next call. */
  read(deps: MotionDeps): MotionStepView {
    const n = deps.boxes.length
    if (this.state.length < n) {
      const cap = Math.max(64, n * 2)
      this.linVel = new Float32Array(cap * 3)
      this.angVel = new Float32Array(cap * 3)
      this.state = new Uint8Array(cap)
    }
    this.count = n
    this.boxes = deps.boxes
    for (let i = 0; i < n; i++) {
      const box = deps.boxes[i]!
      // a unit load's piece rides the load's body, so it reports the load's velocities
      const v = box.body.GetLinearVelocity()
      const w = box.body.GetAngularVelocity()
      this.linVel[i * 3] = v.GetX()
      this.linVel[i * 3 + 1] = v.GetY()
      this.linVel[i * 3 + 2] = v.GetZ()
      this.angVel[i * 3] = w.GetX()
      this.angVel[i * 3 + 1] = w.GetY()
      this.angVel[i * 3 + 2] = w.GetZ()
      let s = 0
      if (!deps.bodyInterface.IsActive(box.body.GetID())) s |= MOTION_ASLEEP
      if (deps.holders.has(box.id)) s |= MOTION_HELD
      if (box.unit) s |= MOTION_UNIT
      this.state[i] = s
    }
    return this
  }

  info(row: number): MotionBodyInfo {
    const box = this.boxes[row]!
    const motion = box.body.GetMotionProperties()
    return { mass: box.mass, linearDamping: motion.GetLinearDamping(), angularDamping: motion.GetAngularDamping(), product: box.product }
  }
}
