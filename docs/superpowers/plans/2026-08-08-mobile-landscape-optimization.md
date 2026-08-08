# Mobile Landscape Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-quality, landscape-only mobile control and HUD layer that feeds the existing gameplay input path while leaving desktop controls and presentation unchanged.

**Architecture:** Keep `InputManager` as the sole gameplay input state and add touch as another source beside keyboard and gamepad. A cached platform service owns mobile detection, orientation, safe-area measurements, and haptics; `UIScene` creates a persistent Phaser mobile HUD only on verified touch/mobile devices and switches that HUD between on-foot and vehicle modes from existing gameplay context.

**Tech Stack:** TypeScript 5, Phaser 3.80, Vite 5, Phaser Scale/Input APIs, browser Pointer/Orientation/Vibration APIs, existing event bus and service locator.

## Global Constraints

- Preserve all keyboard, mouse, and gamepad controls.
- Never create or show mobile controls on desktop.
- Use landscape only; portrait displays a blocking rotate-device overlay.
- Preserve the pixel-art renderer (`pixelArt`, `roundPixels`, no antialiasing) and avoid sprite distortion.
- Reuse player, combat, interaction, vehicle-entry, and vehicle-physics systems.
- Use event-driven touch ownership with no per-frame UI allocation.
- Respect notches, rounded corners, browser navigation regions, and variable landscape aspect ratios.
- Do not alter unrelated world, traffic, police, NPC, or streaming behavior.

---

## Audited Runtime Flow

- `src/config/InputConfig.ts` defines semantic actions and desktop bindings.
- `src/managers/InputManager.ts` merges keyboard/gamepad state, emits edges, and exposes movement/aim axes.
- `src/systems/PlayerController.ts` is the only authority translating input into on-foot movement, facing, firing, reload, interaction, and vehicle entry/exit.
- `src/entities/components/VehicleMovementComponent.ts` already accepts normalized throttle, steer, and hard-brake requests.
- `src/systems/InteractionSystem.ts` already centralizes nearby vehicles and generic interaction targets.
- `src/scenes/UIScene.ts` owns the always-on gameplay overlay; `GameHud` and `MiniMap` are persistent children.
- `src/config/GameConfig.ts` uses a fixed 1280x720 pixel-art canvas with `FIT`; there is no current device detection or responsive safe-area layer.
- `src/managers/CameraManager.ts` follows the player/vehicle at integer-rounded pixel-art settings. Aspect changes do not require separate camera logic.
- Existing menus use Phaser pointer input but desktop-sized hit targets.

### Task 1: Cached Mobile Platform Layer

**Files:**
- Create: `src/platform/MobilePlatform.ts`
- Create: `src/platform/index.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/config/GameConfig.ts`
- Modify: `index.html`

**Interfaces:**
- Produces: `MobilePlatform.isMobile`, `isPortrait`, `safeArea`, `layout(scene)`, `vibrate(ms)`, and `onLayoutChanged(listener)`.
- Produces: cached `detectMobileEnvironment()` for pre-manager game configuration.

- [ ] Detect touch support once from `maxTouchPoints` plus coarse pointer/mobile UA signals.
- [ ] Configure mobile-only `Phaser.Scale.EXPAND`; keep desktop `FIT` unchanged.
- [ ] Measure CSS `env(safe-area-inset-*)` on resize/orientation events, not per frame.
- [ ] Create a DOM rotate-device overlay only when `isMobile && isPortrait` and reset touch state while blocked.
- [ ] Add `viewport-fit=cover`, overflow suppression, and canvas touch-action rules.
- [ ] Attempt landscape orientation locking only after a mobile user gesture and tolerate unsupported APIs.

**Verification:** `npm run typecheck`, desktop emulation reports `isMobile=false`, mobile landscape reports controls allowed, mobile portrait reports blocked.

### Task 2: Unified Touch Input Source

**Files:**
- Modify: `src/config/InputConfig.ts`
- Modify: `src/managers/InputManager.ts`
- Modify: `src/systems/PlayerController.ts`

**Interfaces:**
- Produces: `setTouchMoveAxis(x, y)`, `setTouchAimAxis(x, y)`, `setTouchAction(action, down)`, and `resetTouchInput()`.
- Adds: semantic `Handbrake` action used by keyboard/gamepad/touch through the existing vehicle controller.

- [ ] Store touch axes/actions in stable fields/sets owned by `InputManager`.
- [ ] Merge touch with keyboard/gamepad in `getAxis`, `getAimVector`, and action edge detection.
- [ ] Clamp and normalize all axes and apply a single touch dead zone in the HUD layer.
- [ ] Reset touch on scene detach, blur, visibility loss, orientation block, and HUD shutdown.
- [ ] Make `PlayerController` call the existing `VehicleMovementComponent.brake()` for `Handbrake`.
- [ ] Verify simultaneous movement and attack action states without duplicate edges.

**Verification:** Typecheck plus a validation probe that injects touch movement/action state and confirms keyboard bindings remain active.

### Task 3: Mobile HUD Controls

**Files:**
- Create: `src/ui/mobile/MobileActionButton.ts`
- Create: `src/ui/mobile/VirtualJoystick.ts`
- Create: `src/ui/mobile/MobileControls.ts`
- Create: `src/ui/mobile/index.ts`
- Modify: `src/scenes/UIScene.ts`

**Interfaces:**
- `VirtualJoystick` owns one pointer ID, radial dead-zone remapping, normalized output, and neutral reset.
- `MobileActionButton` owns one pointer ID, hold/pulse behavior, pressed feedback, and optional drag aiming.
- `MobileControls` owns the on-foot/vehicle layout and writes only to `InputManager`.

- [ ] Allocate extra Phaser pointers once for simultaneous joystick/button input.
- [ ] Build a lower-left fixed joystick with an expanded activation zone and resolution-independent layout.
- [ ] Build circular lower-right action controls with vector game icons, translucent contrast, pressed scale/alpha feedback, and accessible labels in object metadata.
- [ ] On foot, show attack, contextual interact/enter, reload/weapon-cycle when useful, map, and pause; use full joystick deflection for sprint.
- [ ] Let attack-button dragging set aim while a simple hold fires in the current facing direction.
- [ ] In a vehicle, change the left control to steering and show accelerator, brake/reverse, handbrake, horn, and exit.
- [ ] Ensure each pointer remains owned until release and cannot operate another control.
- [ ] Reset every held action on pointer cancellation, game-out, blur, hidden document, portrait transition, or scene shutdown.
- [ ] Re-layout existing objects only on scale/safe-area changes; never rebuild controls per frame.

**Verification:** synthetic two-pointer scenarios for move+shoot and steer+accelerate; release/cancel leaves all axes/actions neutral.

### Task 4: Context and Responsive HUD Layout

**Files:**
- Modify: `src/config/EventKeys.ts`
- Modify: `src/core/types/EventTypes.ts`
- Modify: `src/systems/InteractionSystem.ts`
- Modify: `src/ui/hud/GameHud.ts`
- Modify: `src/ui/hud/MiniMap.ts`
- Modify: `src/scenes/UIScene.ts`

**Interfaces:**
- Produces: typed `InteractionContextChanged` event with target kind/text.
- Produces: `GameHud.setMobileLayout(layout)` and `MiniMap.setMobileLayout(layout)` without changing desktop constructor behavior.

- [ ] Emit interaction context only when the selected target changes.
- [ ] Show enter only for a nearby usable vehicle, exit only while driving, and generic interaction only for other usable targets.
- [ ] Hide the keyboard-specific interaction prompt on mobile while retaining desktop prompt text.
- [ ] Move/compact status widgets and minimap into safe top-edge zones on mobile; preserve their desktop positions exactly.
- [ ] Keep mission/toast/objective feedback in the unobstructed center corridor.
- [ ] Make the minimap/mobile map control avoid the joystick and action cluster.

**Verification:** context transitions `none -> interaction -> vehicle -> driving -> on-foot` update visibility without creating new controls.

### Task 5: Mobile Settings and Menus

**Files:**
- Modify: `src/config/Settings.ts`
- Modify: `src/managers/SettingsManager.ts`
- Modify: `src/scenes/SettingsScene.ts`
- Modify: `src/ui/components/Button.ts`
- Modify: `src/scenes/MainMenuScene.ts`
- Modify: `src/scenes/PauseScene.ts`
- Modify: `src/scenes/MapScene.ts`

**Interfaces:**
- Adds settings: control opacity, control scale, joystick scale, movement sensitivity, aim sensitivity, and vibration.
- Adds mobile-aware button hit sizing while desktop dimensions remain unchanged.

- [ ] Persist and sanitize mobile control settings with bounded defaults.
- [ ] Add mobile-only compact settings rows/cycles for control size, opacity, sensitivity, and vibration.
- [ ] Apply settings without reconstructing the HUD.
- [ ] Increase mobile menu hit targets and use landscape-safe spacing/grid layouts.
- [ ] Keep keyboard shortcuts and desktop layouts unchanged.

**Verification:** settings survive reload, invalid storage values fall back/clamp, and mobile menu targets are at least 44 CSS pixels after display scaling.

### Task 6: Automated Validation and Browser QA

**Files:**
- Create: `scripts/mobile-controls-validation.ts`
- Create: `scripts/run-mobile-controls-validation.mjs`
- Create: `scripts/mobile-browser-smoke.ps1`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run validate:mobile` for structural/state validation.
- Produces: a CDP smoke probe for desktop, mobile landscape, portrait, and multi-touch state.

- [ ] Validate no mobile HUD is created under desktop metrics.
- [ ] Validate mobile HUD appears under coarse touch/mobile emulation.
- [ ] Validate portrait overlay visibility and landscape recovery.
- [ ] Validate safe-area/layout bounds at 16:9, 19.5:9, and 21:9 logical viewports.
- [ ] Validate joystick dead zone, normalization, neutral reset, and separate pointer ownership.
- [ ] Validate on-foot and vehicle action modes.
- [ ] Validate desktop keyboard movement/fire/interaction/vehicle bindings and all existing gameplay validation suites.
- [ ] Capture desktop and mobile screenshots and inspect for overlap, clipping, blank canvas, or blurry/stretched rendering.
- [ ] Compare frame/system diagnostics before and after; mobile HUD must allocate no per-frame display objects or collections.

**Run:**

```powershell
npm run typecheck
npm run lint
npm run validate:mobile
npm run validate:gameplay
npm run validate:traffic
npm run validate:police
npm run build
powershell -ExecutionPolicy Bypass -File scripts/mobile-browser-smoke.ps1
```

Expected: all static and gameplay gates pass; desktop has no mobile controls; mobile landscape supports simultaneous control; portrait blocks gameplay and recovers on rotation.
