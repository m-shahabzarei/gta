# Phone Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the built-in Store system application to the existing Phone overlay, with an intentionally empty localized catalog and safe Home/Store navigation.

**Architecture:** `PhoneManager` remains the single lifecycle owner and registers one deterministic Store definition during manager initialization. `PhoneAppRegistry` will track registered definitions, installed IDs, and a separate catalog set; `PhoneScene` will continue to own one modal overlay while `PhoneShell` provides a reusable home/app-view mounting surface. Store content is a focused `PhoneStoreView`, not a second scene or phone architecture.

**Tech Stack:** TypeScript strict mode, Phaser 3, procedural `Graphics`, existing `UIComponent`/`Button`/`Label`, EventBus/GameManager pause flow, `MobilePlatform` safe-area layout, existing `Strings` localization.

## Global Constraints

- Store is installed by default, marked as a system app, and cannot be uninstalled.
- The Store catalog is a distinct empty array and excludes Store itself.
- No real downloadable applications, fake cards, placeholder entries, new dependencies, or save-schema changes.
- The existing Phone overlay remains the only modal owner; gameplay remains paused through `GameState.Paused`.
- All Store-facing strings are localized for English, Spanish, and French.
- All tappable controls remain at least 44–48 logical pixels and safe-area aware.
- Preserve existing Pause, Map, Inventory, Settings, Interior, input reset, cursor, and pointer-lock behavior.

---

### Task 1: Extend Phone contracts and registry state

**Files:**
- Modify: `src/phone/PhoneTypes.ts`
- Modify: `src/phone/PhoneAppRegistry.ts`
- Modify: `src/phone/index.ts`

**Interfaces:**
- `PhoneAppDefinition` gains `systemApp`, `installable`, and optional localization key metadata.
- Registry exposes `listInstalled`, `listCatalogApps`, `isInstalled`, `canInstall`, `installApp`, and `uninstallApp` while preserving deterministic sorting and existing registration usage.

- [ ] Add system/installability metadata and a title localization key without removing existing lifecycle/view hooks.
- [ ] Keep `register()` duplicate-safe, automatically install system apps, and only add explicitly cataloged installable definitions to the catalog set.
- [ ] Implement narrow install/uninstall guards; system apps cannot be uninstalled and the Store definition is never returned by `listCatalogApps()`.
- [ ] Preserve `listAvailable()` as an installed-app compatibility alias, then export the updated contracts.

### Task 2: Register the built-in Store app and render its empty view

**Files:**
- Create: `src/ui/phone/PhoneStoreView.ts`
- Create: `src/phone/StorePhoneApp.ts`
- Modify: `src/phone/index.ts`
- Modify: `src/managers/PhoneManager.ts`

**Interfaces:**
- `StorePhoneApp` is a stable `PhoneAppDefinition` with `id: 'store'`, `systemApp: true`, `installable: false`, a procedural icon renderer, and a `createView` callback.
- `PhoneStoreView` exposes `layout(width, height)` and renders only the localized Store empty state plus a restrained procedural symbol.

- [ ] Build the empty Store view from existing graphics, labels, colors, and reduced-motion-safe UI primitives; do not create catalog entries or install controls.
- [ ] Register Store exactly once in `PhoneManager.onInit()` and leave it installed across fresh games and repeated Phone open/close cycles.
- [ ] Export the Store definition/view for future registry tests and app additions.

### Task 3: Add reusable Phone app-view navigation and localization

**Files:**
- Modify: `src/ui/phone/PhoneShell.ts`
- Modify: `src/scenes/PhoneScene.ts`
- Modify: `src/config/Strings.ts`

**Interfaces:**
- `PhoneShell.mountAppView(view, title, onBack)` mounts one app view within the existing screen frame, shows a 48px Back control, and keeps the Close control independent.
- `PhoneShell.showHome()` removes app presentation and restores installed-app home rendering.

- [ ] Localize shell labels, Store title, empty catalog message, compact message, and accessibility labels for all supported languages.
- [ ] Render Store in the existing shell; hide Home content while mounted, relayout the view on safe-area/orientation changes, and destroy the mounted view on navigation/scene shutdown.
- [ ] Make Back return Store → Home, keep Close available on every Phone screen, and make Escape behave as hierarchical back (Store → Home, Home → close); keep the phone action key as an explicit close.
- [ ] Ensure home app buttons use localized titles, descriptive accessibility data, and existing pressed feedback/hit sizes.

### Task 4: Verification and regression review

**Files:**
- Review changed files and generated plan only; no unrelated gameplay files.

- [ ] Re-read every changed file and run `git diff --check`.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run validate:mobile`, `npm run validate:gameplay`, and `npm run validate:architecture` where scripts exist.
- [ ] Manually inspect desktop/mobile Phone → Store → Back/Home → Close flow, repeated cycles, held-input safety, driving state, existing overlays, safe areas/orientation, reduced motion, and tab blur/resume.
- [ ] Record the empty catalog/save-state limitation and the future install API in the final report.
