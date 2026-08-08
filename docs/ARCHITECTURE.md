# Architecture — Phase 1 (Engine / Framework Layer)

This document describes the complete Phase 1 architecture: the file tree, the
layering rules, and the responsibility of every manager, system and scene.
Gameplay (NPCs, traffic, vehicles, weapons, missions, wanted system) is Phase 2
and is intentionally absent here.

## Layering

Dependencies only ever point downward:

```
scenes / ui          presentation & flow
      │
managers / systems   engine services (audio, input, camera, save, lighting …)
      │
core                 contracts (EventBus, ServiceLocator, BaseManager, interfaces, types)
      │
config / utils / graphics   constants, keys, pure helpers, procedural art
```

- **Nothing** in `core`, `config`, `utils` imports from `managers`, `systems`,
  `scenes` or `ui`.
- Managers never import one another directly — they communicate via the typed
  `EventBus` and resolve collaborators lazily through the `ServiceLocator`.

## Design patterns

| Pattern            | Where                                                              |
| ------------------ | ----------------------------------------------------------------- |
| Manager pattern    | `BaseManager` + every `*Manager` / `*System`                      |
| Service Locator    | `core/ServiceLocator.ts` (typed by `config/ServiceKeys.ts`)       |
| Event-driven / Pub-Sub | `core/EventBus.ts` (typed by `core/types/EventTypes.ts`)      |
| Component pattern  | `entities/Entity.ts` + `entities/Component.ts`                    |
| Scene pattern      | `scenes/*` (Boot → Preload → MainMenu → Game + UI/Pause)          |
| State machine      | `GameManager` (`core/types/GameState.ts`)                         |
| Object pool        | `utils/Pool.ts`                                                   |
| Factory            | `graphics/PlaceholderTextureFactory.ts`, `config/GameConfig.ts`   |

## File tree

```
.
├── index.html                     # Canvas host + pixel-art CSS
├── package.json                   # Scripts & dependencies (Phaser, Vite, TS, ESLint, Prettier)
├── tsconfig.json                  # Strict app TS config (@/* → src/*)
├── tsconfig.node.json             # TS config for Vite tooling
├── vite.config.ts                 # Bundler config, @ alias, Phaser chunk
├── .eslintrc.cjs / .prettierrc.json
├── README.md
├── docs/
│   └── ARCHITECTURE.md            # This document
├── public/
│   └── assets/                    # Runtime-served art/audio/data (Phase 2 fills these)
│       ├── images/ spritesheets/ aseprite/ tilemaps/ fonts/
│       ├── audio/{music,sfx}/
│       └── data/{manifest.json, animations.json}
└── src/
    ├── main.ts                    # Entry point → Game.boot()
    ├── Game.ts                    # Bootstrap: game + managers + scenes
    ├── config/
    │   ├── Constants.ts           # World/physics/audio/time/save/colour constants
    │   ├── GameConfig.ts          # Phaser game configuration factory
    │   ├── SceneKeys.ts           # Scene identifiers
    │   ├── ServiceKeys.ts         # Service-locator keys
    │   ├── EventKeys.ts           # Global event names
    │   ├── AssetKeys.ts           # Texture/audio/font/data keys
    │   ├── DepthLayers.ts         # Rendering z-order
    │   └── InputConfig.ts         # Semantic actions + default key bindings
    ├── core/
    │   ├── EventBus.ts            # Typed pub/sub singleton
    │   ├── ServiceLocator.ts      # Typed service registry
    │   ├── BaseManager.ts         # Manager lifecycle base
    │   ├── BaseSceneManager.ts    # Scene-attachable manager base
    │   ├── ManagerRegistry.ts     # Creates/inits/ticks/destroys all managers
    │   ├── interfaces/            # IManager, IUpdatable, IDestroyable, ISerializable, ISceneAttachable
    │   └── types/                 # Common, Direction, GameState, DayPhase, HudState,
    │                              #   SaveData, AssetManifest, AnimationTypes, EventTypes
    ├── managers/
    │   ├── GameManager.ts         # High-level state machine + playtime (ISerializable)
    │   ├── ResourceManager.ts     # Manifest-driven asset loading
    │   ├── AnimationManager.ts    # Global animation registration (Aseprite/atlas/sheet)
    │   ├── SoundManager.ts        # SFX playback + volume/mute
    │   ├── MusicManager.ts        # Music with delta-driven cross-fade
    │   ├── InputManager.ts        # Action mapping, axis, edge events (scene-bound)
    │   ├── CameraManager.ts       # Follow/zoom/shake/flash/pan (scene-bound)
    │   ├── ParticleManager.ts     # Emitter creation + bursts (scene-bound)
    │   ├── SaveManager.ts         # localStorage save/load over ISerializable providers
    │   └── UIManager.ts           # HUD + toasts (scene-bound)
    ├── systems/
    │   ├── LightingSystem.ts      # Ambient tint overlay + flashes (scene-bound)
    │   └── DayNightSystem.ts      # In-game clock → time/phase/lighting events (ISerializable)
    ├── scenes/
    │   ├── BootScene.ts           # Generate placeholder textures → Preload
    │   ├── PreloadScene.ts        # Loading bar → load assets → MainMenu
    │   ├── MainMenuScene.ts       # Title + New Game / Continue / Quit
    │   ├── GameScene.ts           # Framework-demo world (no gameplay)
    │   ├── UIScene.ts             # Transparent HUD host, parallel to Game
    │   └── PauseScene.ts          # Modal pause overlay
    ├── ui/
    │   ├── UIComponent.ts         # Container-based widget base
    │   ├── components/            # Label, Button, Panel, ProgressBar
    │   └── hud/HUD.ts             # Health/money/wanted/clock/weapon HUD
    ├── entities/
    │   ├── Entity.ts              # Component host (base for Phase 2 entities)
    │   └── Component.ts           # Reusable behaviour base
    ├── graphics/
    │   └── PlaceholderTextureFactory.ts  # Procedural pixel textures (dev art)
    └── utils/
        ├── Logger.ts MathUtils.ts Random.ts Pool.ts Timer.ts
```

## Manager lifecycle

Every manager follows the same contract (`core/interfaces/IManager.ts`):

1. `constructor(game)` — cheap wiring only.
2. `init()` (→ `onInit()`) — acquire resources, subscribe to events. May be async.
3. `update(time, delta)` — optional; ticked centrally from the game STEP event.
4. `destroy()` (→ `onDestroy()`) — release resources; auto-removes subscriptions.

Scene-bound managers additionally implement `attach(scene)` / `detach()` and are
attached by the active gameplay scene, so a single instance always targets the
current scene and cleans up on `SHUTDOWN`.

## Event flow (examples)

- `InputManager` emits `input:action-down` → `GameManager` toggles pause.
- `DayNightSystem` emits `time:changed` + `lighting:changed` → `GameScene`
  forwards a HUD clock update; `LightingSystem` retints the ambient overlay.
- `ResourceManager` emits `resource:progress` → `PreloadScene` updates the bar.
- `SaveManager` gathers every `ISerializable` service automatically at save time.

## Phase 2 + 3 (delivered)

Built on the engine above, without modifying its contracts:

- **Entities/components** (`entities/`) — `Character` → `Player`/`Pedestrian`/
  `PoliceOfficer`, plus `Vehicle` and pooled `Projectile`, composed from
  `HealthComponent`, `CharacterMovementComponent`, `CharacterAnimatorComponent`,
  `WeaponComponent`, `InventoryComponent`, `PedestrianAIComponent`,
  `PoliceAIComponent`, `VehicleMovementComponent`, `TrafficAIComponent`.
- **Gameplay systems** (`systems/`) — `WorldManager` (procedural city + tilemap
  collision), `PlayerController`, `PedestrianSystem`, `VehicleSystem`,
  `TrafficSystem`, `CombatSystem`, `WantedSystem`, `MissionSystem`,
  `WeatherSystem`, `GameAudioSystem` (procedural WebAudio SFX).
- **Data** (`data/`) — weapon, vehicle, pedestrian and mission catalogues.
- **Gameplay contracts** (`gameplay/types/`) — world/combat/weapon/vehicle/npc/
  mission types + narrow service interfaces that keep components decoupled from
  systems.
- **UI/menus** — `GameHud`, `MiniMap`, and the Settings/Inventory scenes plus an
  extended pause menu.

Composition happens in `scenes/GameScene.ts` (attach systems → wire Arcade
colliders) and `core/ManagerRegistry.ts` (construct/init/tick, freezing the sim
while paused).

## Future work

Real Aseprite/Tiled art & audio can be loaded under the existing asset keys via
`ResourceManager` + the `public/assets/data/manifest.json` pipeline, replacing
the procedural placeholders without changing gameplay code.
```
