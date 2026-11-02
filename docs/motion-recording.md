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
- Records of one type all have the same size and live in that type's **type file**, split into numbered parts, so a
  reader loads a type's records into one array and finds record `i` at `i × size`.
- **Reels** divide the run in time. A reel holds the keys for its time span, each body's keys in a slice of their
  own, and for each type the one contiguous range of records those keys use. A reel is a unit of this file format
  only. It is unrelated to the chunks Unity's Entities package stores entities in.

## Files

A recording is a folder, `<name>.oipmotion/`:

| File | Holds |
|---|---|
| `manifest.json` | format version, step rate, step count, units and axes, the position origin and quantum, the type table (name, file stem, record size), reel and part limits, the compression of each part |
| `bodies.bin` | one row per body in the recording |
| `reels.bin` | the reel table, one row per reel, appended as each reel closes |
| `index.bin` | the reels: each one's body table and keys |
| `seg-<type>.<part>.bin`, `rot-<type>.<part>.bin` | one series of parts per segment type, e.g. `seg-linear.000.bin` |
| `events.bin` | the transitions between segments, for analysis |
| `event-samples.bin` | the step samples around each event, with velocities, for analysis |

All binary fields are little-endian. Units are metres, seconds and radians; axes are right-handed with Y up, as in
OIP and Jolt. A reader for a left-handed engine (Unity) decodes first, then mirrors z: position `(x, y, -z)`, rotation
`(-qx, -qy, qz, qw)`, linear velocity `(vx, vy, -vz)`, angular velocity `(-wx, -wy, wz)`.

## Time

A time is a whole number of **ticks**, 256 to a step: fixed point, with the step in the high bits and the fraction of
a step in the low 8.

```
tick     = step × 256 + round(fraction × 256)
step     = tick >> 8
fraction = (tick & 255) / 256
seconds  = tick / (256 × hz)
```

A tick is 65 µs at 60 Hz, the slowest step rate, 39 µs at 100 Hz and 3.9 µs at 1000 Hz, so an event time is within
0.1 ms at every rate. A segment that starts on a step has a tick that is a multiple of 256; one that starts at an event
inside a step (an impact) carries the fraction the writer found for it, rounded to the nearest tick. Integers keep
every time exact over any run length, where a float32 time loses millisecond resolution within hours, and two times
compare in one integer comparison. Ticks count per step rather than per microsecond so that every step is a whole
number of ticks at every step rate (a 60 Hz step is not a whole number of microseconds).

- **Within a reel** a time is a `u32` tick count from the reel's first step. 2³² ticks is 16,777,216 steps, which is
  4.6 hours at 1000 Hz, so it is never what limits a reel's length.
- **Across the recording** (events) a time is a `u64` tick count from step 0.
- Reel and part boundaries, spawn and end steps are whole steps and stay `u32` step numbers.

## Packed values

Three values are stored packed, each in a `u64` read as one integer. The formula records are not packed: their
velocities, accelerations and damping rates are multiplied by τ, so a rounding error in them grows over a long segment
(a half-float velocity drifts about 1 cm in 10 s at 2 m/s), and they are few next to raw records and keys.

### Raw positions: fixed point, 21 bits per axis

```
bits  0-20  ix      x = origin.x + ix × quantum
bits 21-41  iy      y = origin.y + iy × quantum
bits 42-62  iz      z = origin.z + iz × quantum
bit   63    0
```

The manifest holds the `origin` (three float64, metres) and the `quantum` (metres). The writer picks them when the
recording starts: the recorded volume is the scene's bounds with a margin (10 m by default, so a body falling off the
line stays inside), the origin is its low corner, and the quantum is the first of 0.05, 0.1, 0.2, 0.4, ... mm whose
2²¹ steps cover the volume's longest side:

| Quantum | Span per axis |
|---|---|
| 0.05 mm | 105 m |
| 0.1 mm | 210 m |
| 0.2 mm | 419 m |
| 0.4 mm | 839 m |

Rounding moves a raw position by at most half a quantum per axis. A body that leaves the recorded volume is ended there
with an end key, and `events.bin` records that it left. Decoding is done in float64 and the result taken to float32.

### Raw rotations: smallest three, 20 bits per component

```
bits  0-1   which component of (x, y, z, w) was dropped
bits  2-21  the first remaining component, in (x, y, z, w) order
bits 22-41  the second
bits 42-61  the third
bits 62-63  0
```

A unit quaternion's components satisfy `x² + y² + z² + w² = 1`, so one can be rebuilt from the other three. The writer
drops the largest in magnitude, negating the whole quaternion first if that one is negative (q and -q are the same
rotation), so the dropped component is never negative. The other three then lie within ±1/√2, stored as
`round((c + 1/√2) / √2 × (2²⁰ - 1))`. The reader maps them back and rebuilds the dropped one as
`sqrt(max(0, 1 - a² - b² - c²))`. The rotation is off by at most about 0.0002°.

### Keys: tick and packed fields, 8 bytes

```
u32  tick       when the segment starts, in ticks from the reel's first step
u32  packed     bits  0-23  record   index into this reel's range of that type's records
                bits 24-27  type     index into the manifest's type table (up to 16 types)
                bits 28-31  flags    1 carry-in, 2 jump, 4 end, 8 slop-corrected
```

The key is two `u32`, so a reader in any language takes it without 64-bit arithmetic. 24 bits of record index is
16,777,215 records in one reel's range, far above what the size cap allows of the smallest record (8 bytes).

## Segment types

Every record's time origin is its key's time: `τ = t - t_key`. Formula fields are float32.

Translation:

| Type | File stem | Record | Bytes | Position at τ |
|---|---|---|---|---|
| rest | `seg-rest` | p | 12 | `p` |
| linear | `seg-linear` | p, v | 24 | `p + v τ` |
| quadratic | `seg-quadratic` | p, v, a | 36 | `p + v τ + a τ² / 2` |
| damped | `seg-damped` | p, v, a, λ | 40 | `p + v∞ τ + (v - v∞)(1 - e^(-λτ)) / λ`, with `v∞ = a / λ` |
| raw | `seg-raw` | packed position, one per step | 8 | linear between the two step records either side of t |

Rotation:

| Type | File stem | Record | Bytes | Rotation at τ |
|---|---|---|---|---|
| rest | `rot-rest` | q | 16 | `q` |
| spin | `rot-spin` | q, ω | 28 | `rotate(ω / |ω|, |ω| τ) · q` |
| damped spin | `rot-damped` | q, ω, λ | 32 | the same with angle `|ω| (1 - e^(-λτ)) / λ` |
| raw | `rot-raw` | packed rotation, one per step | 8 | normalised linear between the two step records either side of t |

The spin axis is fixed in world space: Jolt applies no gyroscopic torque, so a free body keeps its angular
velocity's direction. Damping is fitted by the writer as a continuous rate λ: Jolt scales a velocity by
`k = 1 - c dt` per step after adding the step's forces, and a rolling body shares its angular damping with its linear
motion (a solid cylinder decays at `c / 3`). The round-trip check below bounds how far the continuous form strays
from the steps.

### Raw segments

A raw segment covers motion no formula fits (tumbling, contact chatter, a stack settling). It stores the body's pose
at every simulation step and nothing is fitted, so playback reproduces the simulation at every step to the packing's
precision.

- Its records are one per step, consecutive in its type's range: positions in `seg-raw`, rotations in `rot-raw`. A
  channel stores only its own values, so a body whose rotation is raw and whose translation is linear stores no
  positions.
- It starts and ends on whole steps: its key's tick is a multiple of 256, and the writer moves the start of the
  segment after it to a whole step too. Its records run from its key's step to the next key's step inclusive, so the
  last record is the next segment's starting pose and the count is `(nextKey.tick - key.tick) / 256 + 1`. A raw
  segment before an end key stops at the end key's step.
- Between steps it is linear only. With `u = (t - t_key) × hz`, `n = floor(u)` and `a = u - n`, on the decoded
  values:
  - position: `p[n] + (p[n+1] - p[n]) × a`
  - rotation: `normalise(q[n] × (1 - a) + s × q[n+1] × a)`, where `s` is -1 when `q[n] · q[n+1] < 0` and 1
    otherwise, so it turns the short way. Between steps a body turns a few degrees at most, so this stays within a
    hair of slerp.
- It carries no velocities. Where one is wanted, `(p[n+1] - p[n]) × hz` is Jolt's velocity for step n + 1, apart
  from position corrections (joltIntegration.test.ts) and the quantum. Velocities for analysis are in
  `event-samples.bin`.

At 100 Hz a raw translation costs 0.8 KB a second and a raw rotation 0.8 KB.

## Key flags

- **carry-in**: the first key of a body alive at the reel's start, at tick 0.
- **jump**: the position does not continue from the previous segment (a teleport, a hold taking the body). A player
  snaps here and never blends across it.
- **end**: the body leaves the world at this time, or leaves the recorded volume. It has no record.
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

## Reels

`reels.bin` has a header (u32 version, u32 type count) and one row per reel:

```
u32 firstStep, u32 lastStep
u64 offset, u32 length            the reel in index.bin
per type, in manifest order: u16 part, u32 byteOffset, u32 byteLength, u32 recordCount
```

`byteOffset` and `byteLength` locate the reel's range in that part file, as stored: for an uncompressed part
`byteLength` is `recordCount × size`, for a compressed one it is the compressed frame's length.

A reel in `index.bin`:

```
u32 bodyCount, u32 keyCount
bodies[bodyCount]:
  u32 bodyId
  u32 transFirst, u16 transCount
  u32 rotFirst,   u16 rotCount
  u8  flags       1 alive at start, 2 spawns in this reel, 4 ends in this reel
keys[keyCount]    grouped by body and channel, each group in time order
```

What a reel guarantees:

1. **Every body present has its own key slice per channel**, and for any time in the reel the slice says exactly one
   of: not spawned yet (before its first key), in segment i, or gone (at or after an end key).
2. **A body alive at the reel's start has a carry-in key at that time**, so its state is known without reading any
   earlier reel. A body at rest for the whole reel has one key per channel.
3. **Each type's records form one contiguous range in one part.** A carry-in points at a copy of its segment's record
   re-anchored to the reel's start (coefficients evaluated there), written at the front of the range. For a raw
   segment the carry-in's records are its steps from the reel's start, the first being the step record the previous
   reel ends with. A raw segment that runs past a reel's end has its records to the first step at or after that end in
   the reel, so its last interval can be drawn without the next reel. Loading a reel is one read of its index bytes and
   one read per type.
4. **A body not listed is not in the world** for the whole reel.
5. **A reel is never larger than the cap**, counting its index bytes and its records before compression, except a
   reel of a single step whose keys alone exceed it.

### When a reel closes

A reel closes at the end of the first step that brings it to the size cap, or that brings its span to the maximum
time, whichever comes first. It does not close earlier than the minimum time span unless the cap forces it: the cap
wins, so a player can size its buffers from the cap. A step's keys never split across reels. The manifest records the
limits; the defaults are a 512 KB cap, 1 s minimum and 8.5 min maximum. The maximum bounds what a crash loses and how
long a live reader waits in a quiet period. The cap must stay well above the carry-in cost: 1,000 live bodies cost
about 30 KB of table rows and carry-in keys per reel before their records.

Uncompressed, the writer appends a record to its type's open part when its segment opens (once 2 or 3 samples
confirm the formula), so every record written while reel k is open belongs to reel k's range. Compressed, it holds the
reel's records, at most the cap, and writes each type's range as one frame when the reel closes. Segmenting decides a
few steps after the fact (up to the raw-fallback window, about 15 steps), so a reel closes only once the segmenter has
decided every step up to the reel's end.

### Parts

A type's part closes, and the next number opens, once it reaches the part limit (default 256 MB), but only at a reel
boundary, so no reel's range spans two parts. Types roll over independently. A part starts with a 16-byte header
(magic `OIPM`, u16 version, u16 type, u16 compression, 6 reserved bytes). A closed part never changes, so it can be
copied, checksummed or uploaded while the recording continues, and a recording that keeps a rolling window deletes its
oldest parts; `reels.bin` shows which reels that leaves unplayable.

### Compression

A part may be compressed, chosen per part and recorded in its header and the manifest: `0` none, `1` LZ4, `2` Zstandard.
Each reel's range in a compressed part is one independent frame, so a reel is still one read per type, decompressed
into the type's buffer. Packed integers compress well, raw floats poorly, so compression helps raw parts most. It costs
CPU when a reel loads and nothing during playback.

## Events

`events.bin` holds what analysis needs about each transition and playback does not: per event the body, channel,
time (a `u64` tick count from step 0), Δv, impulse, the axis the time was found on, the other body or part, the
slop-corrected flag, whether the body left the recorded volume, and a range in `event-samples.bin`: the steps around
it with position, rotation, linear velocity and angular velocity as float32, in the export's sample layout. These stay
unpacked because residuals and impulses are measured at the 10 µm level.

## Reading

A player keeps two buffers per type, current and next, each sized from the cap (`cap / record size` records), plus
two for the index bytes. They are allocated once and reused for the whole playback, so memory stays flat however long
the recording is:

- while reel k plays, current holds its ranges and next is filled with reel k + 1's in the background;
- at the boundary the two swap, and the old current becomes the next one to fill;
- a jump fills the spare with the target reel, then swaps.

A reel whose single step exceeds the cap is the one case where a buffer grows. A reader grows it once rather than
fail. Packed records stay packed in the buffers and are decoded where they are evaluated.

## Playback

Two rules keep every body where it belongs whatever the playback time does:

1. **A pose is a function of the time and the current key only**: `f(record, t - t_key)`. Never accumulate a
   position from one frame to the next.
2. **Every body checks its key on every frame**, resting or not.

Per frame, the player turns its playback time into ticks from the current reel's first step, `T`. Then for each body
and channel, with `c` its cursor in its slice:

```
if the slice is empty, or T is before its first key's tick:    hidden
move c forward while the next key's tick <= T, back while key c's tick > T
    (binary search the slice after a jump)
if key c is an end key:                                        hidden
otherwise: visible, evaluate key c's record at τ = (T - key c's tick) / (256 × hz)
```

At a reel change, for sequential play or a jump:

1. swap in the preloaded next reel, or load the reel containing t (binary search `reels.bin` by first step);
2. **clear** every body's slice to empty, so a body the new reel does not list hides instead of keeping its pose;
3. **apply** the reel's body table: each listed body's slices, cursor 0;
4. run the per-frame check, which places every body.

A player shows the last complete frame while a jump's reel loads, never a frame with some bodies updated.

In an ECS engine this is one job over all body entities for the key check (slice, cursor, current record and type
as components, the reel's keys as one shared array), then one job per segment type over the entities whose current
segment is that type, each reading only its own type's records. The type jobs write different entities and run
together. Translation and rotation write separate components that a final job combines.

## Checks

- **Round trip**: evaluating the segments at every step of the run reproduces the export's samples within the
  segmenter's tolerances. A raw segment reproduces them within half a quantum per axis and the rotation packing's
  0.0002°. This is the writer's test, run against motion-export output.
- **Packing**: encoding then decoding a position lands within half a quantum on each axis, a rotation within the
  packing's error, and a quaternion with a negative largest component decodes to the same rotation.
- **Invariants a player can assert**: every body was checked this frame, and its key c satisfies
  `tick(c) <= T < tick(c + 1)`.
- **Reel invariants a reader can assert**: each slice is in time order, a body alive at the start begins with a
  carry-in at the reel's start time, every key's record lies inside its type's range, keys after an end key do not
  exist, and the reel is within the cap.
