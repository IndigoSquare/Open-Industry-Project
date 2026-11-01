# Docs

Design notes for the parts of the code that aren't obvious from reading it. For setup and the checks
to run before a pull request, see [CONTRIBUTING.md](../CONTRIBUTING.md). Guides for using the app
with a real PLC are on the website at [/guides/](https://www.openindustryproject.org/guides/).

## Start here

- [Technical overview](technical-overview.md) - the scene format, physics, parts and command-line tools
- [Architecture](architecture.md) - one engine, two shells: the portable core and its browser and desktop hosts
- [Part author's guide](part-authoring-guide.md) - writing a custom part against the part SDK
- [Projects](projects.md) - what a project holds, how it is saved, and how older ones load
- [Command-line tools](cli.md) - the headless CLIs, PLC oracles and PLC-in-the-loop runs
- [E2E gates, budgets and measuring](e2e-and-budgets.md) - why dev numbers lie, the build and draw budgets, the e2e harness

## Parts and the part SDK

- [Part SDK vocabulary](sdk-vocabulary.md) - the model a part is described in
- [Procedural geometry](procedural-geometry.md) - building a part's shape from parameters
- [Part gizmos](part-gizmos.md) - the handles a part gives the editor
- [Custom-part capability surface](custom-part-capability-surface.md) - what part code can and can't reach
- [SDK geometry flexibility](sdk-geometry-flexibility.md) - render flags and the geometry context
- [Seam resolvers](seam-resolvers.md) - geometry the host computes across neighbouring parts
- [Part sources](part-sources.md) - why every part a project uses is the project's own copy
- [Parts shelf](parts-shelf.md) - sharing parts between projects
- [Part libraries](part-libraries.md) - parts published outside the app: the index, signing and submissions
- [Cargo bodies](cargo-bodies.md) - cargo that declares its own shape: drums that roll, totes that nest
- [Part sandbox](part-sandbox.md) - how untrusted part code runs

## Snapping and placement

- [Snap connectors](part-snap-connectors.md) - the one model under every snap kind (read first)
- [Snap surfaces](part-snap-surfaces.md), [edges](part-snap-edges.md), [edge mounts](part-snap-edge-mount.md),
  [chains](part-snap-chain.md), [stairs](part-snap-stairs.md) and [cuts](part-snap-cuts.md)
- [Placement staging](placement-staging.md) - the placement preview is the real part
- [Conveyor incline](conveyor-incline.md) - inclined roller conveyors and the yaw-only gizmo

## Editor and scene model

- [Document and run](document-and-run.md) - what counts as an edit, and what a run owns
- [Scene composition](scene-composition.md) - parts, groups and soft parenting, and why reuse goes through parts
- [Scene-change consumers](scene-change-consumers.md) - why an edit costs what it touches, not the whole scene
- [Annotations](annotations.md) - labels pinned to a place in the scene, optionally showing a live PLC tag
- [Simulation clock](sim-clock.md) - keeping physics and the PLC on one clock
- [Project tests](project-tests.md) - regression tests for a project's control logic
- [Motion export](motion-export.md) - every moving cargo body's pose and velocities per step, for outside analysis

## PLC

- [ST conformance](st-conformance.md) - what the Structured Text engine is, and what it is not
- [Ladder](ladder.md) - IEC ladder as a front end on the ST engine
- [Motion control](motion-control.md) - the servo model and the PLCopen motion blocks
- [PLC typed storage](plc-typed-storage.md) - how the engine lays out a controller's memory
- [Device I/O](../src/plc/DEVICE-IO.md) - how parts and external PLCs exchange signals

## Desktop, collaboration and agents

- [Desktop shell](desktop-shell.md) - design notes for the Electron app in `apps/desktop/`
- [Collaborative editing](collab.md) - live rooms and invite links
- [Agent tools](agent-tools.md) - what an AI agent may do to the open editor, over MCP

## Maintainer notes

Operational records rather than design docs: useful when touching the area, not needed to contribute.

- [three.js coupling ledger](three-coupling.md) - every three.js internals patch, and the upgrade checklist
- [WebGPU instancing](webgpu-instancing.md) - the resize and duplicate hitch, its cause in three, and our mitigations
- [Hosting](cdn-runbook.md) - the Cloudflare Pages setup and its measurements
