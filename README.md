# omp-plannotator-native

Connects native plan approval in omp (`@oh-my-pi/pi-coding-agent`) to the Plannotator browser interface.

## Features and behavior

- `/plan` only enters planning mode; this extension opens the browser review only after the model submits a plan through the native `xd://propose` interface.
- Browser **approval** hands control to the native `compact` branch and explicitly selects the `default` execution tier, even when another tier is listed first or the native slider points elsewhere.
- If the review offers no selectable `default` tier, approval is refused with a warning and the native dialog stays open; the bridge never falls back to another tier.
- Browser **rejection with feedback** hands control to the native `refine` branch.
- The native approval dialog remains available; the extension does not take it over.

## Installation / update

Install the plugin straight from GitHub:

```sh
omp plugin install github:oOSomnus/omp-plannotator-native
```

Then enable the Plannotator provider in omp and start a new session. Update or remove it with:

```sh
omp plugin upgrade omp-plannotator-native
omp plugin uninstall omp-plannotator-native
```

Manual fallback: copy only `index.ts` to `$HOME/.omp/agent/extensions/omp-plannotator-native/index.ts` (or the matching `~/.omp/profiles/<name>/agent` directory). A manual copy is independent of this repository and is not updated by `omp plugin upgrade`. Use one installation method at a time: when migrating from a manual copy, remove or disable the old extension entry before enabling the plugin, or the same plan is reviewed twice.

## Version baseline

- omp `18.12.6`
- `@plannotator/pi-extension@0.27.24`
- Development and testing use Bun; the previously used runtime was Bun `1.4.2`.

These are only the interface versions verified locally; other versions have not been verified.

## Development

From the project root:

```sh
bun install
bun run test
```

Tests import the plugin through `./index` and use the host package's public `plan-mode/plan-files` and `utils/event-bus` subpaths. `NODE_PATH` is not required, and global dependencies should not be linked.

## Usage

1. Start a new omp session to load the extension. Use the native `/plan`, not `/plannotator-plan-mode`.
2. Do not register a second bridge entry point with the same functionality, or plans will be reviewed twice.

## Boundaries and limitations

- The native approval dialog remains in place. Startup failures, plan file changes, and late approvals from old reviews do not trigger automatic execution.
- Do not edit the plan in the native dialog during browser review: the public API cannot see the overlay's in-memory edits. To change the plan, provide feedback in the browser and resubmit it.
- Closing the browser does not automatically close the native review.
- omp determines whether `compact` succeeds; small sessions may return `Nothing to compact (session too small)`. The bridge receiving approval does not mean compaction succeeded.
