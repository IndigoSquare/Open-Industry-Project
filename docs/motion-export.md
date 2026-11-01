# Motion export

`npm run motion-export` writes every moving cargo body's pose and velocities at every physics step of a project's
run, for analysis outside the app (an acceleration or impact analyser, a Unity scene). It steps the project headless
through the project-test runner, so the run is the one `test-project` makes: deterministic, at the project's own step
rate. The format is [core/motion/motionExport.ts](../src/core/motion/motionExport.ts); the per-step reading is
[sim/motionSamples.ts](../src/sim/motionSamples.ts).

```
npm run motion-export -- <project-folder> --out <file|-> [--duration <s>] [--only <test>] [--batch <steps>]
```

- `--out -` writes to stdout. A program that starts the export as a child process reads the batches as they are made,
  and a reader that falls behind slows the run instead of the stream piling up in memory. The summary goes to stderr.
- `--only <test>` runs one of the project's tests: its duration, inputs and faults drive the line. Its checks are not
  reported; `test-project` is for that. Without it the project runs untouched for `--duration` seconds (default 10).
  A line that needs a start signal moves nothing without a test to give it.
- `--batch` is counted in steps (default: one second at the project's rate), so a sped-up or slowed run never changes
  what a batch holds.

## What is sent

A body is sampled on every step it is awake. A body that falls asleep sends its last pose once, flagged, and nothing
more until it wakes, so a line at rest costs nothing. The steps are absolute (1 = after the first physics step, time
`step / hz`), so batches join end to end and a body's samples carry on across them unchanged.

A sample is the body's centre and rotation after the step, and Jolt's own linear and angular velocity. Jolt moves a body
by its new velocity (`x1 = x0 + v1 * dt`, pinned by [joltIntegration.test.ts](../src/sim/joltIntegration.test.ts)), so
`x1 - x0 - v1 * dt` is near zero for a body the solver moved and is the position correction where it is not: a landing,
a push out of a wall or a stack.

Flags on each sample (bits):

| Bit | Name | Meaning |
|---|---|---|
| 1 | SPAWN | the body's first sample; its description is in this batch's new bodies |
| 2 | WAKE | the first sample after it slept; it rested at its SLEEP pose until this step |
| 4 | SLEEP | its last sample before sleeping; no samples follow until a WAKE |
| 8 | HELD | a gripper, the pilot or a pin holds it: the holder sets its motion, not physics |
| 16 | UNIT | a piece of a unit load: its pose is its own, its velocities are the load's body |

A body asleep when it first appears sends one sample flagged SPAWN and SLEEP.

## Wire format

One message per batch, little-endian, fixed-width fields read in order. A string is a u16 byte count and UTF-8 bytes.

```
u32  length            bytes after this field
u8   version           1
u8   type              1 = batch
u16  hz                the project's step rate
u32  sequence          0, 1, 2, ...
u32  firstStep         the batch covers firstStep .. firstStep + stepCount - 1
u32  stepCount         the batch size; the last batch of a run may be shorter
u32  newBodyCount
     per body:  u32 id, f32 mass (kg), f32 linearDamping, f32 angularDamping (per second),
                f32 halfX, f32 halfY, f32 halfZ (m), string product (package id), string partId ('' if spawned)
u32  runCount
     per run:   u32 id, u32 firstStep, u32 sampleCount,
                then per sample: u8 flags, 13 x f32
                  position x, y, z (m), rotation x, y, z, w,
                  linear velocity x, y, z (m/s), angular velocity x, y, z (rad/s)
u32  goneCount
     per body:  u32 id, u32 lastStep   a body that left the world after its last step
```

A run is one body's samples on consecutive steps within a batch. A body that sleeps and wakes inside a batch has two
runs; a body never has a run across two batches. Ids are frame ids: stable for a body's life and never reused.
Y is up. Cargo has no linear damping and Jolt's default angular damping (0.05 per second);
[joltIntegration.test.ts](../src/sim/joltIntegration.test.ts) pins how damping enters a step.

`decodeMotionBatch` in motionExport.ts reads one message, and is the reference a reader in another language can be
checked against.

## Size

A sample is 53 bytes. At 100 Hz a moving body is 5.3 KB a second; a body at rest is nothing.
