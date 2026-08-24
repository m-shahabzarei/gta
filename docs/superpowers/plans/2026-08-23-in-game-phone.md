# In-Game Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lifecycle-safe, empty in-game smartphone shell that can be opened from gameplay on desktop, mobile touch, keyboard, and gamepad without recreating or leaking the world scene.

**Architecture:** `PhoneManager` owns phone intent/lifecycle and an empty `PhoneAppRegistry`; `GameManager` owns the existing `Playing` → `Paused` transition and emits a typed phone request. `GameScene` launches/stops a single `PhoneScene` overlay while preserving the existing `GameState.Paused` simulation freeze. `PhoneScene` delegates responsive pixel-art rendering to reusable `PhoneShell` UI and never imports gameplay systems.

**Tech Stack:** TypeScript strict mode, Phaser 3 scenes/Graphics/UI components, existing EventBus/ServiceLocator/ManagerRegistry/MobilePlatform, no new dependencies.

## Global Constraints

- The in-game phone is independent from `MobilePlatform`.
- The initial registry is empty; no fake app icons, cards, or placeholder applications are rendered.
- The phone uses the existing `GameState.Paused` behavior and does not change save schema.
- Opening is restricted to active gameplay; conflicting modal overlays are rejected by state guards.
- Pointer, keyboard, touch, joystick, vehicle, attack, and pointer-lock input must not leak through the overlay.
- Touch targets are at least 48 logical pixels and respect `MobilePlatform` safe-area layout.
- Open/close motion is short, interruptible, and reduced when `prefers-reduced-motion` is enabled.

### Task 1: Contracts and lifecycle events

**Files:**
- Modify: `src/config/InputConfig.ts`, `src/config/EventKeys.ts`, `src/core/types/EventTypes.ts`, `src/config/SceneKeys.ts`, `src/config/ServiceKeys.ts`, `src/managers/GameManager.ts`, `src/managers/InputManager.ts`
- Create: `src/phone/PhoneTypes.ts`, `src/phone/PhoneAppRegistry.ts`, `src/managers/PhoneManager.ts`

**Interfaces:**
- `InputAction.OpenPhone` is bound to `N` by default and has a dedicated gamepad mapping.
- `EventKeys.GamePhoneRequested` carries `void`.
- `GameManager.openPhone()` transitions only from `Playing` to `Paused` and emits `GamePhoneRequested`.
- `PhoneManager.openPhone()` returns `boolean`, resets gameplay/touch input, and delegates to `GameManager`; `closePhone()` resumes only a phone-owned pause.
- `PhoneAppDefinition` exposes stable `id`, `title`, optional `iconKey`, `sortOrder`, availability, open/close hooks, view creation, update, optional JSON state serialization, and `pauseGameplay` policy.
- `PhoneAppRegistry` supports register/unregister/list and starts empty.

- [x] Add the semantic action, event payload, scene/service identifiers, and input reset API.
- [x] Add the typed future-app contracts and registry implementation with duplicate-id protection.
- [x] Add `PhoneManager` to the service lifecycle and input-event subscription.
- [x] Run `npm run typecheck`.

### Task 2: Scene integration and desktop/mobile entry points

**Files:**
- Modify: `src/core/ManagerRegistry.ts`, `src/Game.ts`, `src/scenes/index.ts`, `src/scenes/GameScene.ts`, `src/scenes/UIScene.ts`, `src/ui/mobile/MobileControls.ts`, `src/ui/mobile/MobileActionButton.ts`, `src/ui/components/Button.ts`
- Create: `src/scenes/PhoneScene.ts`

**Interfaces:**
- `PhoneScene` is registered once under `SceneKeys.Phone`, launched by `GameScene` on `GamePhoneRequested`, and stopped by the existing `GameResumed` path.
- `UIScene` owns a desktop-only `Phone` button; `MobileControls` owns a mobile-only semantic `OpenPhone` action button, with no direct PhoneScene coupling.

- [x] Add `PhoneManager` to `ManagerRegistry` and register `PhoneScene` in bootstrap/scene exports.
- [x] Extend GameScene overlay arbitration to stop other modal scenes, reset input, launch/bring-to-top PhoneScene, and stop PhoneScene on resume/quit.
- [x] Add desktop button state gating to `UIScene` and a mobile touch button/layout entry to `MobileControls`.
- [x] Add pressed-state feedback/event propagation safety to the reusable `Button` primitive.
- [x] Run `npm run typecheck` and `npm run lint`.

### Task 3: Responsive phone shell and cleanup

**Files:**
- Create: `src/ui/phone/PhoneShell.ts`, `src/ui/phone/index.ts`
- Modify: `src/scenes/PhoneScene.ts`

**Interfaces:**
- `PhoneShell.layout(width, height, safe)` keeps a centered portrait 9:16 body inside safe insets and exposes a 48px+ close target.
- `PhoneScene` renders only the shell/system area/empty state, supports Escape/close, uses a modal scrim, and calls `PhoneManager.closePhone()` after a short exit animation.

- [x] Draw the dark pixel-art body, separated screen, system area, close affordance, and home indicator with procedural Graphics and existing color/depth tokens.
- [x] Render the empty registry state as text only; do not create app icons/cards.
- [x] Recompute layout on `MobilePlatform.onLayoutChanged`, release pointer lock on open, and restore cursor through existing `UIScene` state handling on close.
- [x] Use 180–300ms enter and 120–220ms exit opacity/scale tweens, reduced to immediate transitions under reduced motion, and cancel all listeners/tweens on shutdown.
- [x] Run typecheck/lint/build and the existing mobile/gameplay/architecture validators.

### Verification and regression review

- [ ] Manually exercise desktop and mobile-landscape open/close, on-foot and driving, held movement/attack, Escape/close, repeated cycles, modal conflicts, orientation/safe-area changes, and browser blur/resume. (The in-app browser could not load the local Vite URL in this environment.)
- [x] Confirm manager tick is skipped in `Paused`, GameScene remains alive, no duplicate PhoneScene/listeners/tweens/display objects accumulate, and save files are unchanged by code-path review.
