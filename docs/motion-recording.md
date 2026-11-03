# Motion recording

The format for storing a run's cargo motion for playback and analysis later: every body's movement as chains of
segments, each a formula valid between two times, so a recording is a small fraction of the per-step samples it is
made from and a player can draw any moment of it directly. Nothing writes or reads this format yet. The per-step
samples it is built from are [motion-export.md](motion-export.md), and how Jolt moves a body between steps, which
the segment formulas rely on, is pinned by [joltIntegration.test.ts](../src/sim/joltIntegration.test.ts).

## Model

- The recording is laid out for a player's fixed pool of entities: its rows and channels belong to **slots**, each
  showing one body at a time and many over a recording (see Slots).
- A slot has five **channels**: visibility, translation along X, along Y and along Z, and rotation. Each is a chain of
  **segments**. Translation is split by axis because the axes change independently: a box bouncing as it slides
  changes Y at every bounce and X not at all, and one noisy axis does not force the others onto raw steps. Rotation is
  one channel, because rotations about different axes do not add independently.
- A segment is a **key** (when it starts, its type, which record) and a **record** (the formula's coefficients at
  that moment). Its end is the next key in its channel. Nothing is stored twice.
- Records of one type all have the same size and live in that type's **type file**, split into numbered parts, so a
  reader loads a type's records into one array and finds record `i` at `i × size`. The three translation channels
  share the translation types and their files.
- **Reels** divide the run in time. A reel holds a row for every slot, with its **carry state** (where every channel
  stands at the reel's start) and its keys for the changes inside the reel, each channel's in a slice of its own, and
  for each type the one contiguous range of records those keys use. A reel is a unit of this file format
  only. It is unrelated to the chunks Unity's Entities package stores entities in.

## Files

A recording is a folder, `<name>.oipmotion/`:

| File | Holds |
|---|---|
| `manifest.json` | format version, step rate, step count, units and axes, the position origin and quantum, the type table (name, file stem, record size), reel and part limits, the compression of each part, the pool size N and the reel cap, and once the recording is finished each type's largest range in any reel |
| `bodies.bin` | one row per body in the recording, with the slot the writer gave it |
| `reels.bin` | the reel table, one row per reel, appended as each reel closes |
| `index.bin` | the reels: each one's slot rows, with carry states, and keys |
| `seg-<type>.<part>.bin`, `rot-<type>.<part>.bin` | one series of parts per segment type, e.g. `seg-linear.000.bin` |
| `events.bin` | the transitions between segments, for analysis |
| `event-samples.bin` | the step samples around each event, with velocities, for analysis |

All binary fields are little-endian. Units are metres, seconds and radians; axes are right-handed with Y up, as in
OIP and Jolt. A reader for a left-handed engine (Unity) decodes first, then mirrors z: the Z channel's values negate,
rotation `(-qx, -qy, qz, qw)`, angular velocity `(-wx, -wy, wz)`.

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
- Reel and part boundaries, spawn and end steps in `bodies.bin` are whole steps and stay `u32` step numbers.

## Packed values

Three kinds of value are stored packed: raw positions, every quaternion (raw steps, the `q₀` of rotation records and
carry states) and keys. A formula's rates stay float32: velocities, accelerations and damping rates are multiplied by
τ, so a rounding error in them grows over a long segment (a half-float velocity drifts about 1 cm in 10 s at 2 m/s).
A starting position or orientation is not multiplied by τ, so packing it costs nothing as the segment runs.

### Raw positions: fixed point, one axis in a u32

```
u32  i       value = origin[axis] + i × quantum
```

The manifest holds the `origin` (three float64, metres) and the `quantum` (metres, default 0.01 mm). The writer
takes the scene's bounds with a margin (10 m by default, so a body falling off the line stays inside) and puts the
origin at their low corner. 2³² steps of 0.01 mm span 42.9 km, so the quantum is never coarsened for size. Rounding
moves a raw position by at most half a quantum. A body that leaves the recorded volume is ended there, and
`events.bin` records that it left. Decoding is done in float64 and the result taken to float32.

### Quaternions: smallest three, 20 bits per component

```
bits  0-1   which component of (x, y, z, w) was dropped
bits  2-21  the first remaining component, in (x, y, z, w) order
bits 22-41  the second
bits 42-61  the third
bit   62    sign: 1 negates the whole decoded quaternion
bit   63    0
```

A unit quaternion's components satisfy `x² + y² + z² + w² = 1`, so one can be rebuilt from the other three. The writer
drops the largest in magnitude, negating the whole quaternion first if that one is negative, so the dropped component
is never negative, and sets the sign bit when it negated. The other three then lie within ±1/√2, stored as
`round((c + 1/√2) / √2 × (2²⁰ - 1))`. The reader maps them back, rebuilds the dropped one as
`sqrt(max(0, 1 - a² - b² - c²))`, and negates all four when the sign bit is set, so it gets back the sign the writer
chose (see Sign continuity). The rotation is off by at most about 0.0002°.

### Keys: tick and packed fields, 8 bytes

```
u32  tick       when the segment starts, in ticks from the reel's first step
u32  packed     bits  0-23  record   index into this reel's range of that type's records
                bits 24-27  type     index into the manifest's type table (up to 16 types)
                bits 28-31  flags    1 jump, 2 slop-corrected
```

The key is two `u32`, so a reader in any language takes it without 64-bit arithmetic. 24 bits of record index is
16,777,215 records in one reel's range, far above what the size cap allows of the smallest record (4 bytes).

- **jump**: the value does not continue from the previous segment (a teleport, a hold taking the body, a slot showing a
  new body). A player snaps here and never blends across it.
- **slop-corrected**: the start time was moved back by the penetration slop over the closing speed (an impact the
  speculative contact did not catch, see joltIntegration.test.ts).

## Segment types

Every record's time origin is its key's time: `τ = t - t_key`. Rates and positions in formula records are float32;
quaternions are packed. There are 15 types, 2 visibility, 5 translation and 8 rotation, within the key's 16.

### Translation, per axis

| Type | File stem | Record | Bytes | Value at τ |
|---|---|---|---|---|
| rest | `seg-rest` | p | 4 | `p` |
| linear | `seg-linear` | p, v | 8 | `p + v τ` |
| quadratic | `seg-quadratic` | p, v, a | 12 | `p + v τ + a τ² / 2` |
| damped | `seg-damped` | p, v, a, λ | 16 | `p + v∞ τ + (v - v∞)(1 - e^(-λτ)) / λ`, with `v∞ = a / λ` |
| raw | `seg-raw` | fixed-point position, one per step | 4 | linear between the two step records either side of t |

Damping is fitted by the writer as a continuous rate λ: Jolt scales a velocity by `k = 1 - c dt` per step after adding
the step's forces, and a rolling body shares its angular damping with its linear motion (a solid cylinder decays at
`c / 3`). The round-trip check below bounds how far the continuous form strays from the steps.

One event can change several axes: an impact stops X and starts friction on Z. The writer gives every axis it
changes a key at the event's one time, found on the axis with the largest change in velocity, so the axes of one event
never disagree about when it happened. An axis the event did not change keeps its segment.

### Rotation

A rotation segment is the orientation at its start, `q₀`, turned on by the angular velocity, which is world-frame as
Jolt reports it. Turning by a rotation vector `r` (axis × angle) is `exp(r) = (r/|r| · sin(|r|/2), cos(|r|/2))`, with
`exp(0)` no rotation; near zero a reader uses the series `(r/2 · (1 - |r|²/48), 1 - |r|²/8)`. `exp` takes any angle,
so a body that turns many times in one segment needs no extra keys.

**Rotation-vector types**, the general family:

| Type | File stem | Record | Bytes | Rotation at τ |
|---|---|---|---|---|
| rest | `rot-rest` | q₀ | 8 | `q₀` |
| spin | `rot-spin` | q₀, ω | 20 | `exp(ω τ) · q₀` |
| accel | `rot-accel` | q₀, ω, α | 32 | `exp(ω τ + α τ² / 2) · q₀` |
| damped | `rot-damped` | q₀, ω, α, λ | 36 | `exp(ω∞ τ + (ω - ω∞)(1 - e^(-λτ)) / λ) · q₀`, with `ω∞ = α / λ` |
| raw | `rot-raw` | packed rotation, one per step | 8 | normalised linear between the two step records either side of t |

ω and α are 3-vectors. Each type is exact while the axis stays fixed: Jolt applies no gyroscopic torque, so a free body
keeps its angular velocity's direction, and a spin, a spin-up or a body rolling to a stop keeps its axis. When the axis
turns (a box toppling while it turns, a body precessing in contact) the rotation vector's curvature follows the drift,
and the writer keeps the segment only while the round trip holds; then it starts a new one or falls back to raw. Within
a segment the angular velocity is `ṙ(τ)`: exact for a fixed axis, close otherwise. Jolt's own per-step angular
velocity is in `event-samples.bin`.

**Single-axis types**, for a body turning about one axis: an upright box on a turntable or spur (world Y), a drum
rolling about its own length (body X, at any heading). They store scalar rates, are exact for every profile, and the
writer uses them whenever the axis stays within tolerance of one axis:

| Type | File stem | Record | Bytes | Rotation at τ |
|---|---|---|---|---|
| axis spin | `rot-axis-spin` | axis, q₀, ω | 16 | `θ(τ) = ω τ` |
| axis accel | `rot-axis-accel` | axis, q₀, ω, α | 20 | `θ(τ) = ω τ + α τ² / 2` |
| axis damped | `rot-axis-damped` | axis, q₀, ω, α, λ | 24 | `θ(τ) = ω∞ τ + (ω - ω∞)(1 - e^(-λτ)) / λ`, with `ω∞ = α / λ` |

```
u8   axis      bits 0-1: 0 X, 1 Y, 2 Z
               bit  2:   0 a world axis: q = exp(e θ) · q₀
                         1 the body's own axis: q = q₀ · exp(e θ)
               bits 3-7: 0
u8×3 0
u64  q₀        packed rotation at the segment's start
f32  ω, α, λ   as the type has them: scalar rates about the axis, rad/s, rad/s², 1/s
```

`e` is the unit vector of the axis. θ is the angle turned since the segment's start, so `θ(τ)` read on its own is the
heading change of an upright box or how far a drum has rolled. A rest needs no single-axis type: `rot-rest` holds any
orientation in 8 bytes.

### Sign continuity

A quaternion `q` and `-q` are the same rotation. Interpolating between two that differ in sign goes the long way
round, a near full turn between two near equal orientations, and a curve through stored values jumps. So the writer
chooses every stored quaternion's sign to continue from the one before it: it stores `-q` when `q · previous < 0`.
That holds for each raw step against the step before it, for each segment's `q₀` against where the previous segment
ends (a spin past one turn ends at `-q₀`, and the next segment continues from that), and for each carry state against
where the slot stands at the end of the previous reel. It does not hold across a jump, where a slot takes a new body. The packed sign bit carries the chosen sign through packing. A
reader can then interpolate between any two neighbouring stored values directly.

### Raw segments

A raw segment covers motion no formula fits (tumbling, contact chatter, a stack settling). It stores the channel's
value at every simulation step and nothing is fitted, so playback reproduces the simulation at every step to the
packing's precision.

- Its records are one per step, consecutive in its type's range: one axis's positions in `seg-raw`, rotations in
  `rot-raw`. A channel stores only its own values, so a box bouncing on Y while it slides steadily on X stores raw Y
  only.
- It starts and ends on whole steps: its key's tick is a multiple of 256, and the writer moves the start of the
  segment after it to a whole step too. Its records run from its start step to the next key's step inclusive, so the
  last record is the next segment's starting value and the count is `(nextKey.tick - start) / 256 + 1`. A raw segment
  before its slot is hidden stops at that step.
- Between steps it is linear only. With `u = (t - t_start) × hz`, `n = floor(u)` and `a = u - n`, on the decoded
  values:
  - position: `p[n] + (p[n+1] - p[n]) × a`
  - rotation: `normalise(q[n] × (1 - a) + s × q[n+1] × a)`, where `s` is -1 when `q[n] · q[n+1] < 0` and 1
    otherwise. With sign continuity `s` is always 1; the check is a guard. Between steps a body turns a few degrees at
    most, so this stays within a hair of slerp.
- It carries no velocities. Where one is wanted, `(p[n+1] - p[n]) × hz` is Jolt's velocity for step n + 1, apart
  from position corrections (joltIntegration.test.ts) and the quantum. Velocities for analysis are in
  `event-samples.bin`.

At 100 Hz a raw axis costs 0.4 KB a second and a raw rotation 0.8 KB.

## Slots

A player draws the recording with a fixed pool of entities, created once before playing and reused as bodies come and
go. The recording is laid out for that pool: its rows and channels belong to **slots**, not to bodies.

- The **pool size** N is the most bodies present at once anywhere in the recording, and the manifest records it. Every
  reel has exactly N rows, and row i is slot i.
- When a body appears, the writer gives it the lowest free slot; when it leaves, the slot is free again. A slot shows
  one body at a time and many bodies over a recording.
- The writer needs N when it opens the recording, since every reel's rows depend on it. A headless run can count it
  with a first pass, because a headless run of a project repeats exactly. A live recording is given N as a setting;
  a body that arrives when every slot is taken is not recorded, and `events.bin` records the overflow.
- Which body a slot shows at a given time is not part of the rows or keys, and is to be specified separately.
  `bodies.bin` records each body's slot, spawn and end as the writer assigned them, for analysis.

## Bodies

`bodies.bin` lists every body in the recording:

```
u32 count
per body: u32 id, u32 slot, f32 mass, f32 linearDamping, f32 angularDamping, f32 halfX, halfY, halfZ,
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
u32 keyCount
slots[N], 144 bytes each, row i is slot i:
  u8  flags, u8×3 0   flags: 1 shown at the reel's start, 2 jump at start (it did not continue from the previous
                      reel's pose)
  per channel (visibility, x, y, z, rotation): u32 first, u32 count     its slice of keys
  carry state, 100 bytes
keys[keyCount]       grouped by slot and channel, each slice in time order
```

### Visibility channel

Visibility is a channel with its own key slice, checked like the others. It has two types, **shown** and **hidden**,
which carry no record (the key's record field is 0). Its state at the reel's start is flag 1 of the row. A slot can be
shown and hidden any number of times in a reel.

- While a slot is hidden its motion channels are not evaluated, and their state is ignored.
- When a slot is shown with a body that did not stand there a moment before (a new body, or one the slot did not
  show), the writer puts, at the same tick as the shown key, one key in each motion channel with that body's starting
  state, flagged **jump**. Nothing blends across it.
- When a slot is hidden, its motion channels need no keys.

### Carry state

Where every motion channel stands at the reel's start, for a slot shown then. Each channel's segment is re-anchored
there (coefficients evaluated at that time), so the carry state is valid from the reel's start until the channel's
first key in the reel, or to the reel's end when the slice is empty. For a slot hidden at the reel's start it is all
zero.

```
translation, per axis (x, then y, then z), 20 bytes each:
  u8    type          rest, linear, quadratic, damped or raw
  u8×3  0
  f32   c0, c1, c2, c3
        rest p · linear p, v · quadratic p, v, a · damped p, v, a, λ
        raw: c0 holds the u32 index of the axis's first record in this reel's seg-raw range

rotation, 40 bytes:
  u8    type          any rotation type
  u8    axis          as the single-axis record, 0 for the other types
  u8×2  0
  u64   q₀            packed, its sign continuing from the previous reel's end
  f32   r0 ... r6     rotation-vector: ω (3), α (3), λ · single-axis: ω, α, λ, then 0 ·
                      raw: r0 holds the u32 index of its first record in this reel's rot-raw range
```

A slot whose channels do not change in the reel has empty slices: its row covers the whole reel. A slot that rests,
rides a belt steadily or stays hidden costs its 144-byte row and nothing else.

### What a reel guarantees

1. **Every slot has a row**, and for any time in the reel the row says either hidden, or shown with one segment per
   motion channel, the carry state's or a key's.
2. **No reel needs an earlier one**: the row holds every channel's state at the reel's start.
3. **Each type's records form one contiguous range in one part.** A raw segment carried in has its records from the
   reel's start step, the first being the step record the previous reel ends with. A raw segment that runs past a
   reel's end has its records to the first step at or after that end in the reel, so its last interval can be drawn
   without the next reel. Loading a reel is one read of its index bytes and one read per type.
4. **A reel is never larger than the cap**, counting its index bytes and its records before compression, except a
   reel of a single step whose keys alone exceed it.

### When a reel closes

A reel closes at the end of the first step that brings it to the size cap, or that brings its span to the maximum
time, whichever comes first. It does not close earlier than the minimum time span unless the cap forces it. A step's
keys never split across reels.

Every reel carries all N rows, so the cap follows the pool size and is the same for every reel of a recording:

```
cap = max(minimumCap, N × 144 × rowFactor)
```

That keeps the rows to at most `1 / rowFactor` of a reel at any pool size, while a small cell keeps small reels. The
defaults are a 512 KB minimum cap, a row factor of 8, a 1 s minimum span and an 8.5 min maximum, recorded in the
manifest with the cap they give; they are starting values to tune with the measurements under Checks. With them, a pool
of 100 gives 512 KB reels, 1,000 gives 1.2 MB and 10,000 gives 11.5 MB. The maximum span bounds what a crash loses and
how long a live reader waits in a quiet period, whatever the cap.

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

`events.bin` holds what analysis needs about each transition and playback does not: per event the body and its slot,
the channels it changed, its time (a `u64` tick count from step 0), Δv per axis, impulse, the axis the time was found
on, the other body or part, the slop-corrected flag, whether the body left the recorded volume or found no free slot,
and a range in `event-samples.bin`: the steps around it with position, rotation, linear velocity and angular velocity
as float32, in the export's sample layout. These stay unpacked because residuals and impulses are measured at the
10 µm level.

## Reading

A player keeps two buffers per type, current and next, plus two for the index bytes, allocated once and reused for
the whole playback, so memory stays flat however long the recording is. A finished recording's manifest gives each
type's largest range in any reel, which sizes its buffers. While a recording is still being written, a reader sizes
them from each reel's row in the reel table as it arrives, growing a buffer when a reel needs more, so memory follows
the largest reel seen so far. The index buffers are sized from the cap.

- while reel k plays, current holds its ranges and next is filled with reel k + 1's in the background;
- at the boundary the two swap, and the old current becomes the next one to fill;
- a jump fills the spare with the target reel, then swaps.

A reel whose single step exceeds the cap is the one case where a buffer grows. A reader grows it once rather than
fail. Packed records stay packed in the buffers and are decoded when a key copies them into a slot's state.

## Playback

A player creates N entities, one per slot, before playing, and never creates or destroys one during playback. Two
rules keep every slot right whatever the playback time does:

1. **A pose is a function of the time and each channel's current segment only**: `f(coefficients, t - t_start)`.
   Never accumulate a value from one frame to the next.
2. **Every slot checks every channel on every frame**, shown or hidden, moving or resting.

### A slot's state

Each slot holds, per channel, the segment in force:

```
start, next       ticks: the segment holds for start <= T < next
type              its type (for visibility: shown or hidden)
coefficients      decoded: c0..c3 for an axis, q₀ and rates for rotation; none for visibility
raw index         for a raw segment, its first record in the current reel's range
cursor            its position in the channel's key slice
```

`next` is the channel's next key's tick, or the reel's end when no key follows. Coefficients live with the slot,
copied from a record when its key comes due, so evaluation reads the slot's own state and touches the type buffers only
for raw segments.

### Per frame

The player turns its playback time into ticks from the current reel's first step, `T`. Then, for every slot:

```
for each channel, visibility first:
    if start <= T < next:                                  still valid: nothing to look up
    else move the cursor forward or back to the key with tick <= T < next key's tick
         (binary search the slice after a jump; before the first key, the row's carry state),
         copy that key's record into the channel's state
if visibility is hidden:                                   hide the entity
else: show it, evaluate each motion channel at τ = (T - start) / (256 × hz), combine into the pose
```

### At a reel change

For sequential play or a jump:

1. swap in the preloaded next reel, or load the reel containing t (binary search `reels.bin` by first step);
2. **apply** all N rows: each slot's visibility from its flags, its slices with cursors before their first key, and
   its carry state copied into every motion channel's state (decoded once here);
3. run the per-frame check, which places every slot, and write every slot's pose and visibility once.

Every slot has a row in every reel, so applying the rows sets every entity and none can keep a stale pose. A player
shows the last complete frame while a jump's reel loads, never a frame with some slots updated.

### Making the per-frame check cheap

The check runs for every slot every frame; these keep it to microseconds with thousands of slots.

- **Tight interval arrays.** Keep each channel's `start` and `next` for all slots in their own arrays, and run the
  check as a compiled parallel loop over them (a Burst job in Unity). Two integer comparisons per channel, which a
  compiler turns into SIMD over several slots at once. Only channels that fail it go on to move a cursor.
- **A transition list per reel.** A reel's keys are known when it loads. Sort them by tick into one array of
  `(tick, slot, channel)`; in forward play one pointer walks it, and each frame applies the keys with `tick <= T`
  directly. The work then follows how many channels change, not how many slots exist. It feeds the updates; the
  interval check still confirms every slot.
- **A bound per group of slots.** Keep, for each block of slots stored together (an ECS chunk in Unity), the smallest
  `next` among them. While T is below it in forward play, every slot in the block is proven valid by one comparison.
- **Write on change.** Evaluate every shown slot, but write its pose only when it changed, and its visibility only when
  it changed. A resting slot writes once when its segment starts, so the renderer re-uploads only what moved. The reel
  apply step writes every slot once.
- **No structural changes.** Showing and hiding are a change of state (an enableable component or a render flag in
  Unity), and switching segment type changes a slot's fields, never its set of components, so an ECS engine never moves
  an entity between chunks.
- **No per-slot coroutines or callbacks.** Managed per-object stepping or a delegate per key costs more than the check
  it replaces, runs on one thread, and leaves a slot with no pending callback unchecked. The transition list gives the
  same effect as data.

In Unity, a frame is: the key-check job over all slots (interval arrays, then the transition list), one evaluation job
over the shown slots' channel states, and a final job that combines translation and rotation into the transform and
writes the poses and visibility that changed. In debug builds an assertion pass confirms every slot satisfies
`start <= T < next` on every channel.

## Checks

- **Round trip**: evaluating the segments at every step of the run reproduces the export's samples within the
  segmenter's tolerances. A raw segment reproduces them within half a quantum per axis and the rotation packing's
  0.0002°. This is the writer's test, run against motion-export output.
- **Packing**: encoding then decoding a position lands within half a quantum, a rotation within the packing's error,
  and a quaternion of either sign decodes to the same quaternion, sign included.
- **Sign continuity**: every stored quaternion has a non-negative dot product with the one before it in its slot's
  channel, across steps, segments and reels, except across a jump.
- **Carry state**: a shown slot's carry state evaluated at the reel's start matches where the previous reel's segments
  put it at that time, within the packing's precision, unless its row has the jump flag.
- **Slots**: no two bodies hold a slot at once, the most bodies shown at any time is at most N, and every shown key
  that brings a new body is followed at the same tick by a jump key in each motion channel.
- **Invariants a player can assert**: every slot was checked this frame, and every channel satisfies
  `start <= T < next`.
- **Reel invariants a reader can assert**: there are exactly N rows, each slice is in time order, every key's record
  lies inside its type's range, and the reel is within the cap.
- **Tuning the reel limits**: the minimum cap and row factor are measured, not assumed. Record representative runs (a
  small cell, the demo cell with about 1,000 bodies, a large stress scene) and measure:
  1. the time to load and decode the largest reel on the target machine, which must stay well under one frame
     (about 16 ms), since a jump waits for it;
  2. the share of each reel spent on slot rows, against `1 / rowFactor`;
  3. the recording's total size at a few row factors, to see where a larger factor stops shrinking it.
