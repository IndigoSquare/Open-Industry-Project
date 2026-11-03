// Per-step cargo motion of a project's run, for an outside analyser (docs/motion-export.md):
//
//   npm run motion-export -- <project-folder> --out <file|-> [--duration <s>] [--only <test>] [--batch <steps>]
//
// Steps the project headless, as test-project does (the same runner, so the same deterministic run), and writes every
// moving cargo body's pose and Jolt velocities at every step, in batches of `--batch` steps (default: one second of
// the project's step rate), one length-prefixed binary message per batch. `--out -` writes to stdout, so a program
// that starts this as a child process reads the stream as it is made, and a reader that falls behind slows the run
// rather than the stream piling up in memory. A summary goes to stderr.
//
// With `--only <test>` the run is that test's: its duration, inputs and faults drive the line (its checks are not
// reported; test-project is for that). Without it the project runs untouched for `--duration` seconds (default 10).
// Exit 0 = written, 2 = usage or IO error, 3 = the project failed to load or the run could not start.

import { closeSync, openSync, statSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { declareBuiltIns } from './lib/builtIns.mjs'
import { collectTests, listedTestPaths, pickTests, readTestSpecs } from './lib/projectTests.mjs'
import { readProjectFolder } from './lib/projectFolderFiles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const USAGE = 'usage: npm run motion-export -- <project-folder> --out <file|-> [--duration <seconds>] [--only <test>] [--batch <steps>]'
const EXIT_USAGE = 2
const EXIT_UNRUNNABLE = 3
const valued = new Set(['--out', '--duration', '--only', '--batch'])
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? null) : null
}
const out = flag('--out')
const only = flag('--only')
const duration = flag('--duration') === null ? 10 : Number(flag('--duration'))
const batchArg = flag('--batch') === null ? null : Number(flag('--batch'))
const target = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
// anything else: an unknown flag, or a second folder
const unknown = args.filter((a, i) => (a.startsWith('--') ? !valued.has(a) : a !== target && !valued.has(args[i - 1])))
if (!target || !out || !(duration > 0) || (batchArg !== null && !(Number.isInteger(batchArg) && batchArg > 0)) || (only !== null && flag('--duration') !== null) || unknown.length > 0) {
  if (only !== null && flag('--duration') !== null) console.error('✗ --duration and --only: a test runs for its own duration')
  if (unknown.length > 0) console.error(`✗ not understood: ${unknown.join(' ')}`)
  console.error(USAGE)
  process.exit(EXIT_USAGE)
}
try {
  if (!statSync(target).isDirectory()) throw new Error()
} catch {
  console.error(`✗ not a project folder: ${target}`)
  process.exit(EXIT_USAGE)
}

let fd
try {
  fd = out === '-' ? 1 : openSync(out, 'w')
} catch (e) {
  console.error(`✗ cannot write ${out}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(EXIT_USAGE)
}

const vite = await createServer({
  configFile: false,
  root: repo,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})

let code = 0
try {
  await declareBuiltIns(vite)
  const { folderFilesToProject } = await vite.ssrLoadModule('/src/core/project/projectFolder.ts')
  const { validateTestSpec } = await vite.ssrLoadModule('/src/core/project/projectTest.ts')
  const { MotionBatcher } = await vite.ssrLoadModule('/src/core/motion/motionExport.ts')
  const { runProjectTest } = await vite.ssrLoadModule('/src/editor/project/projectTestRunner.ts')
  const { validatePart, formatPartDiagnostics } = await vite.ssrLoadModule('/src/sim/validatePart.ts')
  const { toSimRate } = await vite.ssrLoadModule('/src/core/types/base.ts')
  const initJolt = (await vite.ssrLoadModule('jolt-physics')).default

  const bakePart = (manifestJson, behaviorJs) => {
    let manifest
    try {
      manifest = JSON.parse(manifestJson)
    } catch {
      return { error: 'manifest.json is not valid JSON' }
    }
    const r = validatePart(manifest, behaviorJs)
    return r.ok && r.package ? { package: r.package } : { error: formatPartDiagnostics(r.diagnostics) }
  }
  const loaded = folderFilesToProject(readProjectFolder(target), { bakePart })
  if (!loaded.ok) {
    console.error(`✗ project failed to load:\n${loaded.errors.map((e) => `  - ${e}`).join('\n')}`)
    process.exit(EXIT_UNRUNNABLE)
  }
  if (loaded.splitOff) console.error(`note: this folder holds ${1 + loaded.splitOff.length} scenes, from before a project held one; exporting "${loaded.project.name}"`)

  // the run: one test's, or the project left to run
  let project = loaded.project
  let spec = { name: 'motion export', duration, checks: [] }
  if (only !== null) {
    const { all, bad } = collectTests(loaded, listedTestPaths(target), readTestSpecs(target), validateTestSpec)
    const { specs, unreadable } = pickTests(all, bad, only)
    for (const b of unreadable) for (const line of b.lines) console.error(line)
    if (specs.length !== 1) {
      console.error(specs.length === 0 ? `✗ no test matches --only "${only}"` : `✗ --only "${only}" matches ${specs.length} tests: ${specs.map((s) => s.file ?? s.name).join(', ')}`)
      process.exit(EXIT_USAGE)
    }
    project = specs[0].project
    spec = { ...specs[0].spec, checks: [] }
  }

  // the rate the runner steps it at (projectTestRunner.ts prepareScene)
  const hz = toSimRate(project.simHz)
  const batchSteps = batchArg ?? hz
  let batches = 0
  let bytes = 0
  const bodies = new Set()
  const batcher = new MotionBatcher(hz, batchSteps, (msg) => {
    for (let n = 0; n < msg.length; ) n += writeSync(fd, msg, n)
    batches++
    bytes += msg.length
  })
  const Jolt = await initJolt()
  try {
    runProjectTest(Jolt, project, spec, {
      flowFacts: false,
      onFrame: (frame, extras) => {
        const motion = extras.motion()
        for (let i = 0; i < frame.count; i++) bodies.add(frame.ids[i])
        batcher.step(Math.round(frame.simTime * hz), frame, motion)
      },
    })
  } catch (e) {
    console.error(`✗ the run could not start: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(EXIT_UNRUNNABLE)
  }
  batcher.finish()
  console.error(`motion-export: ${Math.round(spec.duration * hz)} steps at ${hz} Hz, ${bodies.size} cargo bodies, ${batcher.samples} samples, ${batches} batches of ${batchSteps} steps, ${bytes} bytes${out === '-' ? '' : ` -> ${out}`}`)
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  code = EXIT_UNRUNNABLE
} finally {
  if (fd !== undefined && fd !== 1) closeSync(fd)
  await vite.close()
}
process.exit(code)

