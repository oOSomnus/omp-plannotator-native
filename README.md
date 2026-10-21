# omp-plannotator-native

Connects native plan approval in omp (`@oh-my-pi/pi-coding-agent`) to the Plannotator browser interface.

## Features and behavior

- `/plan` only enters planning mode; this extension opens the browser review only after the model submits a plan through the native `xd://propose` interface.
- Browser **approval** hands control to the native `compact` branch to continue execution.
- Browser **rejection with feedback** hands control to the native `refine` branch.
- The native approval dialog remains available; the extension does not take it over.

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

## Manual installation / update

Run from the project root:

```sh
mkdir -p "$HOME/.omp/agent/extensions/omp-plannotator-native"
cp -i index.ts "$HOME/.omp/agent/extensions/omp-plannotator-native/index.ts"
```

Install only the `index.ts` entry point, not the tests or this project's `node_modules`. `cp -i` prompts before overwriting an existing file.

The project source and installed copy are independent: changes to this project do not automatically update the installation. Run the copy command above again to update it.

## Usage

1. Also enable the Plannotator provider in omp.
2. Start a new omp session to load the extension. Use the native `/plan`, not `/plannotator-plan-mode`.
3. Do not register a second bridge entry point with the same functionality, or plans will be reviewed twice.

## Boundaries and limitations

- The native approval dialog remains in place. Startup failures, plan file changes, and late approvals from old reviews do not trigger automatic execution.
- Do not edit the plan in the native dialog during browser review: the public API cannot see the overlay's in-memory edits. To change the plan, provide feedback in the browser and resubmit it.
- Closing the browser does not automatically close the native review.
- omp determines whether `compact` succeeds; small sessions may return `Nothing to compact (session too small)`. The bridge receiving approval does not mean compaction succeeded.
