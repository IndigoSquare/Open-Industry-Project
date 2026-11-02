# Motion recording

The format for storing a run's cargo motion for playback and analysis later: every body's movement as a chain of
segments, each a formula valid between two times, so a recording is a small fraction of the per-step samples it is
made from and a player can draw any moment of it directly. Nothing writes or reads this format yet. The per-step
samples it is built from are [motion-export.md](motion-export.md), and how Jolt moves a body between steps, which
the segment formulas rely on, is pinned by [joltIntegration.test.ts](../src/sim/joltIntegration.test.ts).

## Model

- A body's motion has two **channels**, translation and rotation, each a chain of **segments**. They are separate
  because they change at different times: a box on a belt translates at constant velocity and does not turn, a drum
  rolls, a box on a turntable turns in place.
- A segment is a **key** (when it starts, its type, which record) and a **record** (the formula's coefficients at
  that moment). Its end is the next key in its channel. Nothing is stored twice.
- Records of one type all have the same size and live in one **type file**, so record `i` is at
  `header + i × size` and a reader loads a type's records into one array.
- **Chunks** divide the run in time. A chunk holds the keys for its time span, each body's keys in a slice of their
  own, and for each type file the one contiguous range of records those keys use.

## Files

A recording is a folder, `<name>.oipmotion/`:

| File | Holds |
|---|---|
| `manifest.json` | format version, step rate, step count, units and axes, the type table (name, file, record size), chunk limits |
| `bodies.bin` | one row per body in the recording |
| `chunks.bin` | the chunk table, one row per chunk, appended as each chunk closes |
| `index.bin` | the chunks: each one's body table and keys |
| `seg-*.bin`, `rot-*.bin` | one file per segment type |
| `samples.bin` | step samples that raw segments and events refer to |
| `events.bin` | the transitions between segments, for analysis |

All binary fields are little-endian. Units are metres, seconds and radians; axes are right-handed with Y up, as in
OIP and Jolt. A reader for a left-handed engine (Unity) mirrors z: position `(x, y, -z)`, rotation
`(-qx, -qy, qz, qw)`, linear velocity `(vx, vy, -vz)`, angular velocity `(-wx, -wy, wz)`.

## Time

A time is a step and a fraction of a step: `t = (step + fraction) / hz`. A segment that starts on a step has
fraction 0. A segment that starts at an event inside a step (an impact) carries the fraction the writer found for
it. An integer step keeps time exact over any run length, where a float32 time loses millisecond resolution within
hours.

## Segment types

Every record's time origin is its key's time: `τ = t - t_key`. Fields are float32.

Translation:

| Type | File | Record | Bytes | Position at τ |
|---|---|---|---|---|
| rest | `seg-rest.bin` | p | 12 | `p` |
| linear | `seg-linear.bin` | p, v | 24 | `p + v τ` |
| quadratic | `seg-quadratic.bin` | p, v, a | 36 | `p + v τ + a τ² / 2` |
| damped | `seg-damped.bin` | p, v, a, λ | 40 | `p + v∞ τ + (v - v∞)(1 - e^(-λτ)) / λ`, with `v∞ = a / λ` |
| raw | `seg-raw.bin` | u32 first sample, u32 count | 8 | interpolated from `samples.bin` |

Rotation:

| Type | File | Record | Bytes | Rotation at τ |
|---|---|---|---|---|
| rest | `rot-rest.bin` | q | 16 | `q` |
| spin | `rot-spin.bin` | q, ω | 28 | `rotate(ω / |ω|, |ω| τ) · q` |
| damped spin | `rot-damped.bin` | q, ω, λ | 32 | the same with angle `|ω| (1 - e^(-λτ)) / λ` |
| raw | `rot-raw.bin` | u32 first sample, u32 count | 8 | slerp between samples |

The spin axis is fixed in world space: Jolt applies no gyroscopic torque, so a free body keeps its angular
velocity's direction. Damping is fitted by the writer as a continuous rate λ: Jolt scales a velocity by
`k = 1 - c dt` per step after adding the step's forces, and a rolling body shares its angular damping with its linear
motion (a solid cylinder decays at `c / 3`). The round-trip check below bounds how far the continuous form strays
from the steps.

A raw segment covers motion no formula fits (tumbling, contact chatter). Its samples are consecutive steps from the
key's step, in the export's sample layout (position, rotation, linear velocity, angular velocity).

## Keys

16 bytes:

```
u32  step       the step the segment starts in
f32  fraction   where in that step, 0 to 1
u8   type       index into the manifest's type table
u8   flags      1 carry-in, 2 jump, 4 end, 8 slop-corrected
u16  reserved
u32  record     index into this chunk's range of that type's file
```

- **carry-in**: the first key of a body alive at the chunk's start, at the chunk's start time.
- **jump**: the position does not continue from the previous segment (a teleport, a hold taking the body). A player
  snaps here and never blends across it.
- **end**: the body leaves the world at this time. It has no record.
- **slop-corrected**: the start time was moved back by the penetration slop over the closing speed (an impact the
  speculative contact did not catch, see joltIntegration.test.ts).

## Bodies

`bodies.bin` lists every body in the recording, so a player can create all of them before playing:

```
u32 count
per body: u32 id, f32 mass, f32 linearDamping, f32 angularDamping, f32 halfX, halfY, halfZ,
          u32 spawnStep, u32 endStep (0xffffffff if it never leaves), string product, string partId
```

A string is a u16 byte count and UTF-8 bytes. Ids are OIP frame ids: stable for a body's life and never reused.

## Chunks

`chunks.bin` has a header (u32 version, u32 type count) and one row per chunk:

```
u32 firstStep, u32 lastStep
u64 offset, u32 length            the chunk in index.bin
per type, in manifest order: u32 firstRecord, u32 recordCount
```

A chunk in `index.bin`:

```
u32 bodyCount, u32 keyCount
bodies[bodyCount]:
  u32 bodyId
  u32 transFirst, u16 transCount
  u32 rotFirst,   u16 rotCount
  u8  flags       1 alive at start, 2 spawns in this chunk, 4 ends in this chunk
keys[keyCount]    grouped by body and channel, each group in time order
```

What a chunk guarantees:

1. **Every body present has its own key slice per channel**, and for any time in the chunk the slice says exactly one
   of: not spawned yet (before its first key), in segment i, or gone (at or after an end key).
2. **A body alive at the chunk's start has a carry-in key at that time**, so its state is known without reading any
   earlier chunk. A body at rest for the whole chunk has one key per channel.
3. **Each type's records form one contiguous range.** A carry-in points at a copy of its segment's record
   re-anchored to the chunk's start (coefficients evaluated there), written at the front of the range. Loading a
   chunk is one read of its index bytes and one read per type file.
4. **A body not listed is not in the world** for the whole chunk.

### When a chunk closes

A chunk closes at the end of the first step where its size reaches the target, counting its index bytes and the
records in its ranges, but not before it spans the minimum time and not after it spans the maximum. A step's keys
never split across chunks. The manifest records the limits; the defaults are a 512 KB target, 1 s minimum and 5 min
maximum. The maximum bounds what a crash loses and how long a live reader waits in a quiet period. The size target
must stay well above the carry-in cost: 1,000 live bodies cost about 50 KB of table rows and carry-in keys per chunk
before their records.

The writer appends a record to its type file when its segment opens (once 2 or 3 samples confirm the formula), so
every record written while chunk k is open belongs to chunk k's range. Segmenting decides a few steps after the
fact (up to the raw-fallback window, about 15 steps), so a chunk closes only once the segmenter has decided every
step up to the chunk's end.

## Events

`events.bin` holds what analysis needs about each transition and playback does not: per event the body, channel,
time (step and fraction), Δv, impulse, the axis the time was found on, the other body or part, the slop-corrected
flag, and a sample range in `samples.bin` around it.

## Playback

Two rules keep every body where it belongs whatever the playback time does:

1. **A pose is a function of the time and the current key only**: `f(record, t - t_key)`. Never accumulate a
   position from one frame to the next.
2. **Every body checks its key on every frame**, resting or not.

Per frame, for each body and channel, with `c` its cursor in its slice:

```
if the slice is empty, or t is before its first key:    hidden
move c forward while the next key's time <= t, back while key c's time > t
    (binary search the slice after a jump)
if key c is an end key:                                  hidden
otherwise: visible, evaluate key c's record at t - key c's time
```

At a chunk switch, for sequential play or a jump:

1. load the chunk containing t (binary search `chunks.bin` by first step), or swap in the preloaded next one;
2. **clear** every body's slice to empty, so a body the new chunk does not list hides instead of keeping its pose;
3. **apply** the chunk's body table: each listed body's slices, cursor 0;
4. run the per-frame check, which places every body.

A player shows the last complete frame while a jump's chunk loads, never a frame with some bodies updated.

In an ECS engine this is one job over all body entities for the key check (slice, cursor, current record and type
as components, the chunk's keys as one shared array), then one job per segment type over the entities whose current
segment is that type, each reading only its own type's records. The type jobs write different entities and run
together. Translation and rotation write separate components that a final job combines.

## Checks

- **Round trip**: evaluating the segments at every step of the run reproduces the export's samples within the
  segmenter's tolerances. This is the writer's test, run against motion-export output.
- **Invariants a player can assert**: every body was checked this frame, and its key c satisfies
  `time(c) <= t < time(c + 1)`.
- **Chunk invariants a reader can assert**: each slice is in time order, a body alive at the start begins with a
  carry-in at the chunk's start time, every key's record lies inside its type's range, and keys after an end key do
  not exist.
