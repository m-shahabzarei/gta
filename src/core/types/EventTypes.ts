/**
 * Strongly-typed payload contracts for every {@link EventKeys} value.
 *
 * The {@link EventBus} is generic over this map, so `emit`/`on` are checked at
 * compile time: emitting the wrong payload — or subscribing with the wrong
 * handler signature — is a type error, not a runtime surprise.
 *
 * Events that carry no data map to `void`.
 */
import { EventKeys } from '@/config/EventKeys';
import { InputAction } from '@/config/InputConfig';
import type { GameState } from './GameState';
import type { DayPhase } from './DayPhase';
import type { HudState } from './HudState';
import type { Vector2 } from './Common';
import type { GameSettings, WeatherMode } from '@/config/Settings';
import type { VehicleKind } from '@/gameplay/types/VehicleTypes';
import type { WeaponId } from '@/gameplay/types/WeaponTypes';
import type { PickupKind } from '@/gameplay/types/PickupTypes';
import type { InteriorKind } from '@/gameplay/types/InteriorTypes';
import type { InteractionContext } from '@/gameplay/types/InteractionTypes';
import type { SnappBookingState, SnappQuote, SnappTrackingSnapshot } from '@/gameplay/transit';
import type { InteriorAmbienceKind } from '@/gameplay/types/WorldTypes';
import type {
  DamageAttribution,
  PlayerVitalsChangeReason,
  PlayerVitalsSnapshot,
} from '@/gameplay/types/CombatTypes';
import type {
  CrimeIncident,
  CrimeObservation,
  CrimeReport,
  CrimeType,
} from '@/gameplay/types/CrimeTypes';

/** Audio channel identifiers for volume control. */
export type AudioChannel = 'master' | 'music' | 'sfx';

/** The kinds of entity that can take damage. */
export type DamageableKind =
  'player' | 'pedestrian' | 'police' | 'vehicle' | 'animal' | 'helicopter';

export type { CrimeType } from '@/gameplay/types/CrimeTypes';

/** Maps each event key to the exact shape of its payload. */
export interface EventPayloadMap {
  // Game lifecycle
  [EventKeys.GameBooted]: void;
  [EventKeys.GameStateChanged]: { previous: GameState; current: GameState };
  [EventKeys.GamePaused]: void;
  [EventKeys.GameResumed]: void;
  [EventKeys.GameMapRequested]: void;
  [EventKeys.GameInventoryRequested]: void;
  [EventKeys.GamePhoneRequested]: void;
  [EventKeys.GameInteriorRequested]: { kind: InteriorKind };
  [EventKeys.GameNew]: void;
  [EventKeys.GameQuitToMenu]: void;

  // Scene flow
  [EventKeys.SceneReady]: { key: string };
  [EventKeys.SceneShutdown]: { key: string };
  [EventKeys.SceneTransition]: { from: string; to: string };

  // Resource loading
  [EventKeys.ResourceLoadStart]: { total: number };
  [EventKeys.ResourceProgress]: { progress: number };
  [EventKeys.ResourceFileComplete]: { key: string; type: string };
  [EventKeys.ResourceLoadComplete]: void;
  [EventKeys.ResourceLoadError]: { key: string };

  // Save / load
  [EventKeys.SaveRequested]: { slot: number };
  [EventKeys.SaveCompleted]: { slot: number };
  [EventKeys.SaveLoadRequested]: { slot: number };
  [EventKeys.SaveLoadCompleted]: { slot: number };
  [EventKeys.SaveDeleted]: { slot: number };
  [EventKeys.SaveError]: { message: string };

  // Input
  [EventKeys.InputActionDown]: { action: InputAction };
  [EventKeys.InputActionUp]: { action: InputAction };
  [EventKeys.InputAxisChanged]: { x: number; y: number };

  // Audio
  [EventKeys.AudioPlaySound]: { key: string; volume?: number };
  [EventKeys.AudioPlayMusic]: { key: string; loop?: boolean };
  [EventKeys.AudioStopMusic]: void;
  [EventKeys.AudioMusicChanged]: { key: string };
  [EventKeys.AudioVolumeChanged]: { channel: AudioChannel; volume: number };
  [EventKeys.AudioMuteToggled]: { muted: boolean };

  // UI / HUD
  [EventKeys.UIShowHud]: void;
  [EventKeys.UIHideHud]: void;
  [EventKeys.UIToast]: { message: string; durationMs?: number };
  [EventKeys.UIHudUpdate]: Partial<HudState>;
  [EventKeys.InteractionPromptChanged]: { text: string | null };
  [EventKeys.InteractionContextChanged]: { context: InteractionContext | null };
  [EventKeys.WaypointChanged]: { target: Vector2 | null };

  // Day / night & lighting
  [EventKeys.TimeChanged]: { hour: number; minute: number; normalized: number };
  [EventKeys.TimePhaseChanged]: { phase: DayPhase };
  [EventKeys.LightingChanged]: { ambient: number; tint: number };

  // Camera
  [EventKeys.CameraShake]: { durationMs: number; intensity: number };
  [EventKeys.CameraFlash]: { durationMs: number; color?: number };
  [EventKeys.CameraFollow]: { targetId: string | null };
  [EventKeys.CameraZoom]: { zoom: number; durationMs?: number };

  // World
  [EventKeys.WorldReady]: void;
  [EventKeys.WorldStreamChanged]: void;
  [EventKeys.InteriorAmbienceChanged]: { kind: InteriorAmbienceKind | null };

  // Player
  [EventKeys.PlayerSpawned]: { x: number; y: number };
  [EventKeys.PlayerDamaged]: { amount: number; health: number };
  [EventKeys.PlayerDied]: { position: Vector2 };
  [EventKeys.PlayerRespawned]: { x: number; y: number };
  [EventKeys.PlayerHealthChanged]: { health: number; maxHealth: number };
  [EventKeys.PlayerVitalsChanged]: PlayerVitalsSnapshot & { reason: PlayerVitalsChangeReason };
  [EventKeys.PlayerEnteredVehicle]: {
    vehicleId: number;
    seat: import('@/gameplay/types').VehicleSeat;
    mode: 'driver' | 'passenger';
  };
  [EventKeys.PlayerExitedVehicle]: { vehicleId: number };
  [EventKeys.PlayerInteract]: { x: number; y: number };

  // Economy / inventory
  [EventKeys.MoneyChanged]: { total: number; delta: number };
  [EventKeys.WeaponSwitched]: { weaponId: string; index: number };
  [EventKeys.WeaponAmmoChanged]: { weaponId: string; ammo: number; reserve: number };
  [EventKeys.WeaponFired]: {
    weaponId: string;
    x: number;
    y: number;
    angle: number;
    fromPlayer: boolean;
    attribution: DamageAttribution;
  };
  [EventKeys.WeaponDropped]: { weaponId: WeaponId; ammo: number; position: Vector2 };
  [EventKeys.WeaponReloadStarted]: { weaponId: string; durationMs: number };
  [EventKeys.WeaponReloadFinished]: { weaponId: string };
  [EventKeys.PlayerArmorChanged]: { armor: number; maxArmor: number };

  // Combat
  [EventKeys.EntityDamaged]: {
    targetId: number;
    kind: DamageableKind;
    amount: number;
    health: number;
    position: Vector2;
  };
  [EventKeys.EntityKilled]: {
    targetId: number;
    kind: DamageableKind;
    position: Vector2;
    byPlayer: boolean;
    attribution: DamageAttribution;
  };
  [EventKeys.BloodSpill]: { x: number; y: number };
  [EventKeys.ExplosionSpawned]: {
    x: number;
    y: number;
    radius: number;
    attribution: DamageAttribution;
  };
  [EventKeys.HitConfirmed]: { x: number; y: number; fatal: boolean };

  // Pedestrian AI
  [EventKeys.PedestrianDowned]: { entityId: number; position: Vector2 };

  // Vehicles
  [EventKeys.VehicleDamaged]: { vehicleId: number; health: number; maxHealth: number };
  [EventKeys.VehicleDestroyed]: { vehicleId: number; position: Vector2; byPlayer: boolean };
  [EventKeys.VehicleEntered]: { vehicleId: number; byPlayer: boolean };
  [EventKeys.VehicleExited]: { vehicleId: number; byPlayer: boolean };
  [EventKeys.VehicleCollision]: { x: number; y: number; intensity: number; byPlayer: boolean };
  [EventKeys.TireSkidChanged]: { active: boolean };
  [EventKeys.HornSounded]: { kind: VehicleKind };
  [EventKeys.VehicleDoor]: { open: boolean; vehicleId?: number; seat?: string };
  [EventKeys.VehicleSpawned]: { vehicleId: number; kind: VehicleKind };
  [EventKeys.VehicleRemoved]: { vehicleId: number };
  [EventKeys.VehicleOccupancyChanged]: { vehicleId: number; occupantCount: number };

  // Snapp ride-hailing
  [EventKeys.SnappDestinationSelected]: { bookingId: string; destinationId: string };
  [EventKeys.SnappQuoteCreated]: { bookingId: string; quote: SnappQuote };
  [EventKeys.SnappPaymentCompleted]: { bookingId: string; transactionId: string; amount: number };
  [EventKeys.SnappPaymentFailed]: { bookingId: string; reason: string };
  [EventKeys.SnappDriverAssigned]: { bookingId: string; vehicleId: number };
  [EventKeys.SnappDriverEnRoute]: { bookingId: string; vehicleId: number };
  [EventKeys.SnappDriverArrived]: {
    bookingId: string;
    vehicleId: number;
    pickupPosition: Vector2;
    pickupAnchor: Vector2;
    walkingDistancePx: number;
    pickupAnchorLabel: string;
  };
  [EventKeys.SnappBoardingStarted]: { bookingId: string; vehicleId: number };
  [EventKeys.SnappRideStarted]: { bookingId: string; vehicleId: number };
  [EventKeys.SnappRideArrived]: { bookingId: string; vehicleId: number };
  [EventKeys.SnappRideCompleted]: { bookingId: string; vehicleId: number };
  [EventKeys.SnappBookingCancelled]: { bookingId: string; refunded: boolean };
  [EventKeys.SnappBookingFailed]: { bookingId: string; reason: string; refunded: boolean };
  [EventKeys.SnappRefundIssued]: { bookingId: string; transactionId: string; amount: number; state: SnappBookingState };
  [EventKeys.SnappTrackingUpdated]: SnappTrackingSnapshot;

  // Crime & wanted
  [EventKeys.CrimeCommitted]: {
    crime: CrimeType;
    position: Vector2;
    attribution: DamageAttribution;
  };
  [EventKeys.CrimeCreated]: CrimeIncident;
  [EventKeys.CrimeObserved]: CrimeObservation;
  [EventKeys.CrimeReported]: CrimeReport;
  [EventKeys.WantedChanged]: { level: number };
  [EventKeys.WantedSearchChanged]: { searching: boolean };
  [EventKeys.PlayerBusted]: { position: Vector2 };

  // Missions
  [EventKeys.MissionOffered]: { missionId: string; title: string };
  [EventKeys.MissionStarted]: { missionId: string; title: string };
  [EventKeys.MissionObjectiveChanged]: { text: string; progress: number; total: number };
  [EventKeys.MissionCompleted]: { missionId: string; reward: number };
  [EventKeys.MissionFailed]: { missionId: string; reason: string };
  [EventKeys.MissionTargetChanged]: { target: Vector2 | null };

  // Pickups & collectibles
  [EventKeys.PickupCollected]: { kind: PickupKind; x: number; y: number };
  [EventKeys.CollectibleFound]: { found: number; total: number };

  // Ambient audio cues
  [EventKeys.Footstep]: { x: number; y: number; running: boolean };
  [EventKeys.EngineStateChanged]: { running: boolean; vehicleKind?: VehicleKind };

  // Settings & weather
  [EventKeys.SettingsChanged]: { settings: GameSettings };
  [EventKeys.WeatherChanged]: { weather: WeatherMode };
  [EventKeys.ThunderStrike]: { intensity: number };
}

/** The set of event keys whose payload is `void` (emit takes no data). */
export type VoidEventKey = {
  [K in keyof EventPayloadMap]: EventPayloadMap[K] extends void ? K : never;
}[keyof EventPayloadMap];
