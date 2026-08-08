# Pixel City — 2D Open World (GTA 1 / 2 inspired)

A production-quality, top-down 2D open-world game built with **TypeScript**,
**Phaser 3**, **Vite** and **Arcade Physics**. Drive, shoot, run from the cops
and pull jobs across a procedurally generated pixel-art city — with a live
day/night cycle, dynamic weather, traffic, pedestrians, a 6-star wanted system
and missions.

> **All art and audio are generated procedurally at runtime** — the repo ships
> zero binary assets. Textures come from the factories in `src/graphics/`; sound
> is synthesised by `GameAudioSystem` via the WebAudio API. Real Aseprite/Tiled
> art can drop in later under the same keys without touching gameplay code.

## Quick start

```bash
npm install
npm run dev      # → http://localhost:5173, boots to the main menu
```

Then click **New Game**. See **[INSTALL.md](INSTALL.md)**,
**[BUILD.md](BUILD.md)** and **[GAMEPLAY.md](GAMEPLAY.md)** for details and
controls (WASD move, mouse aim, Space/click shoot, **F** to jack a car,
**P/Esc** to pause).

## Tech stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript (strict) |
| Engine | Phaser 3 |
| Bundler | Vite |
| Physics | Arcade Physics |
| Art | Procedural pixel art (runtime-generated) |
| Audio | Procedural WebAudio synthesis |
| Architecture | Component + Scene + Manager + Event-driven |

## Features

- **World** — a deterministic block city (roads, sidewalks, buildings, water,
  trees, street lights), tilemap collision, traffic lights, hospitals and police
  stations.
- **Player** — 8-directional movement, running, health/damage/death/respawn,
  money, inventory and five weapons.
- **NPCs** — pedestrians that wander, talk and flee; a full police force that
  chases, shoots and arrests.
- **Vehicles** — enter/exit, drive, crash, take damage and explode; ambient AI
  traffic that obeys the lights.
- **Combat** — pooled bullets, melee, blood decals, explosions, screen shake.
- **Wanted system** — 6 stars, escalation, decay and busts.
- **Missions** — markers, chained objectives (go-to / eliminate / steal /
  survive) and cash rewards.
- **Presentation** — day/night cycle, dynamic lighting, weather (rain/fog/wind),
  particles, a live HUD and minimap.
- **Menus** — main menu, pause, inventory and a full settings screen (audio,
  graphics quality, weather, display/fullscreen, VSync, language).
- **Persistence** — quick save/load and a save system that auto-discovers every
  serialisable system.

## Architecture

Strictly layered; dependencies only point downward and managers never call each
other directly — they communicate through a typed `EventBus` and resolve
collaborators via a `ServiceLocator`.

```
scenes / ui            presentation & flow (Boot → Preload → Menu → Game + UI/Pause/Settings/Inventory)
entities / components  component-based actors (Player, Pedestrian, Police, Vehicle, Projectile)
managers / systems     engine + gameplay services (world, combat, traffic, wanted, missions, audio, weather, …)
core                   contracts (EventBus, ServiceLocator, BaseManager, interfaces, types)
config / data / utils  constants, keys, catalogues (weapons/vehicles/peds/missions), helpers
graphics               procedural pixel-art factories
```

Full annotated file tree and system responsibilities: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Scripts

```bash
npm run dev        # dev server
npm run build      # type-check + production bundle → dist/
npm run preview    # preview the production build
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
npm run format     # Prettier
```

## Project status

Feature-complete and runnable. Built in phases: **Phase 1** the engine/framework,
**Phase 2** the gameplay, **Phase 3** the polish (weather, settings, menus,
docs). The whole project type-checks, lints and builds clean.

## License

MIT — see **[LICENSE](LICENSE)**.
