# Installing Pixel City

## Prerequisites

- **Node.js 18+** (developed on Node 20). Check with `node --version`.
- **npm 9+** (ships with Node). Check with `npm --version`.
- A modern browser with WebGL2 (Chrome, Edge, Firefox, Safari).

No native toolchain, GPU SDK, or asset pipeline is required — all art and audio
are generated procedurally at runtime, so there is nothing to download or unpack.

## Install

```bash
# 1. Get the code
cd "path/to/Gta"

# 2. Install dependencies (Phaser, Vite, TypeScript, ESLint, Prettier)
npm install
```

That's it. `npm install` is the only setup step.

## Run the game (development)

```bash
npm run dev
```

Vite prints a local URL (default <http://localhost:5173>) and opens it. The game
boots straight to the main menu; click **New Game** to play.

## Run the game (production preview)

```bash
npm run build      # type-check + bundle into dist/
npm run preview    # serve the built bundle locally
```

See [BUILD.md](BUILD.md) for the full build/deploy details and
[GAMEPLAY.md](GAMEPLAY.md) for controls.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `npm install` fails on network | retry, or set a registry mirror via `npm config set registry ...` |
| Blank screen / no audio | click the page once — browsers suspend WebAudio until a user gesture |
| Type errors after edits | run `npm run typecheck` to see them all |
| Port 5173 in use | `npm run dev -- --port 5200` |
