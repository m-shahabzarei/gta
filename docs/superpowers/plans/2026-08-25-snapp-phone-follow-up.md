# Snapp Phone Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Snapp app visually contained, lifecycle-safe across Phone closure, clock-consistent, and usable for the configured two-minute pickup window and in-world boarding, with a reusable portrait/landscape Phone presentation contract.

**Architecture:** `TransportationSystem` remains the sole owner of booking, vehicle, timeout, refund, and boarding state. `PhoneScene`, `PhoneShell`, and `SnappPhoneView` own only presentation and input; they read authoritative snapshots and never cancel on teardown. Phaser GeometryMasks provide shell and map clipping, while a bounded service clock advances once per ManagerRegistry frame in both normal and controlled Phone-open updates.

**Tech Stack:** TypeScript strict mode, Phaser 3 Graphics/GeometryMask/Zone, existing EventBus, ServiceLocator, ManagerRegistry, PhoneShell, TrafficSystem, VehicleOccupantSystem, MobilePlatform, and localization.

## Global Constraints

- Do not add a parallel taxi, booking, event bus, map, or simulation system.
- Do not introduce external dependencies, browser fullscreen, or Screen Orientation APIs.
- Preserve existing Snapp events, turquoise vehicle entities, save root, and unrelated overlays/gameplay.
- UI teardown, navigation, rotation, and Phone closure must never cancel, fail, refund, reset, or reassign a booking.
- All controls remain safe-area aware, keyboard/touch accessible, and at least 44 logical pixels.

---

### Task 1: Authoritative Snapp service clock and pickup wait deadline

**Files:**
- Modify: `src/systems/TransportationSystem.ts`
- Modify: `src/gameplay/transit/TransitConfig.ts`
- Modify: `src/gameplay/transit/SnappTypes.ts`
- Modify: `src/config/Strings.ts`
- Modify: `src/core/types/EventTypes.ts` only if a new typed toast payload is required

**Interfaces:**
- Add a private monotonic `serviceClockMs` advanced once by bounded `delta` per manager update path.
- Use that value for `stateSince`, recovery deadlines, pickup timeout, boarding timeout, tracking timestamps, and Snapp wait countdown.
- Add `passengerPickupWaitMs: 120_000` to `SNAPP_CONFIG`.
- Extend booking/tracking snapshots with `driverArrivedAtServiceMs`, `pickupDeadlineServiceMs`, and `pickupWaitRemainingMs`; migrate old saves with safe defaults.
- Set the deadline only after exact taxi arrival at the pickup lane stop; cancel once at the deadline, refund once, return the same taxi to service, and emit one cancellation plus a UI toast.

- [x] Replace `scene.time.now` comparisons with service-clock values and pass clock time to taxi/service updates.
- [x] Guard state transitions and terminal refund/cancel paths by booking id/state so duplicate events remain impossible.
- [x] Keep created/quote timestamps save-compatible; they are not used as frame deadlines.
- [x] Verify old snapshots normalize without changing the transport save root.

### Task 2: Exact Snapp interaction and Phone-independent boarding

**Files:**
- Modify: `src/systems/TransportationSystem.ts`
- Modify: `src/ui/phone/SnappPhoneView.ts`
- Modify: `src/config/Strings.ts`

**Interfaces:**
- `interactionAt()` returns `ENTER SNAPP  E` only for the active booking’s assigned vehicle while `DRIVER_ARRIVED`/waiting and in range.
- `requestSnappBoarding(vehicleId)` remains the single authoritative entry point and validates range, exact booking id, and occupant state.

- [x] Route normal interaction through the existing occupant transition without selecting unrelated taxis.
- [x] Make Snapp’s BOARD VEHICLE action close Phone only after the authoritative request succeeds; otherwise keep the view open with the real failure reason.
- [x] Ensure successful boarding stops the wait timer and transitions `DRIVER_ARRIVED → PASSENGER_BOARDING → RIDING` without UI teardown side effects.
- [x] Confirm `onDetach`, `onShutdown`, app close, and view destroy do not call booking mutation methods during normal Phone lifecycle.

### Task 3: Real shell and map clipping with repeatable cleanup

**Files:**
- Modify: `src/ui/phone/PhoneShell.ts`
- Modify: `src/ui/phone/SnappPhoneView.ts`

**Interfaces:**
- PhoneShell owns/replaces a screen GeometryMask on every layout and destroys the old Graphics/GeometryMask on relayout and destroy.
- Snapp view owns `mapViewportContainer`, `mapWorldLayer`, `mapOverlayLayer`, and a map GeometryMask matching `mapRect`; world roads/routes/markers stay in the masked layer while controls/legend stay in the overlay layer.

- [x] Reparent all map world drawing under the masked layer and keep input Zone exactly over `mapRect`.
- [x] Clamp map center/zoom to finite world bounds and preserve projection through relayout.
- [x] Stop propagation for map pointer/wheel input and ignore outside-map input.
- [x] Dispose masks, mask Graphics, Zones, and listeners before rerender/re-layout/destroy; avoid per-frame allocations by redrawing existing Graphics only.
- [x] Validate portrait, small-screen, and expanded layouts do not produce negative dimensions.

### Task 4: Generic Phone presentation mode and Snapp expanded map

**Files:**
- Modify: `src/phone/PhoneTypes.ts`
- Modify: `src/scenes/PhoneScene.ts`
- Modify: `src/ui/phone/PhoneShell.ts`
- Modify: `src/ui/phone/SnappPhoneView.ts`
- Modify: `src/config/Strings.ts`

**Interfaces:**
- Extend `PhoneAppContext` with `setPresentationMode`, `getPresentationMode`, and `exitExpandedMode`.
- PhoneScene owns presentation state and delegates shell layout; Snapp requests `landscape-fullscreen` without touching scene internals.

- [x] Reflow the mounted shell/view in-place, preserve booking/map state, and return to portrait on the next Phone open.
- [x] Make Escape/Back exit expanded mode first, then normal app/home navigation; never cancel rides.
- [x] Keep both expanded and portrait masks/control hit zones aligned with safe areas and 44px targets.
- [x] Use reduced-motion-aware 150–300ms transitions and kill interrupted tweens during relayout/teardown.

### Task 5: Verification and regression pass

**Files:**
- Re-read every changed file; no unrelated refactors.

- [x] Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run validate:transit`, `npm run validate:traffic`, `npm run validate:gameplay`, `npm run validate:mobile`, `npm run validate:architecture`, and `git diff --check`.
- [ ] Manually exercise portrait/fullscreen map containment, close/reopen during approach and arrival, in-world boarding, exact 119/120 second timeout, mixed-clock regression, and 20 fullscreen toggles (interactive browser/gameplay run was not available in this session).
- [x] Confirm no duplicate listeners/masks/timers/tweens and that no cancellation/refund event is emitted by Phone lifecycle operations.
