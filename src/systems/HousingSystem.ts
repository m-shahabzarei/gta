import type Phaser from 'phaser';
import { BaseManager } from '@/core/BaseManager';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { EventKeys } from '@/config/EventKeys';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { WORLD_HEIGHT, WORLD_WIDTH } from '@/config/Constants';
import { GameState } from '@/core/types';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Vector2 } from '@/core/types';
import {
  createHousingCatalog,
  hashHousingSeed,
  HOUSING_WORLD_SEED,
} from '@/gameplay/HousingCatalog';
import type {
  HomeEntrySnapshot,
  HomeInteriorPayload,
  HousingOwnershipState,
  PropertyDefinition,
  PropertyPurchaseReason,
  PropertyPurchaseResult,
  RealEstateOfficeDefinition,
} from '@/gameplay/types/HousingTypes';
import type { CityId } from '@/gameplay/types/WorldTypes';
import type { SaveManager } from '@/managers/SaveManager';
import type { GameManager } from '@/managers/GameManager';
import type { CameraManager } from '@/managers/CameraManager';
import type { InputManager } from '@/managers/InputManager';
import type { PlayerController } from '@/systems/PlayerController';
import type { WorldManager } from '@/systems/WorldManager';
import { createHousingReplaySnapshot } from '@/gameplay/HousingReplay';
import type {
  HousingPhase2State,
  HousingReplaySnapshot,
  PropertyUpgradeDefinition,
  PurchaseUpgradeResult,
} from '@/gameplay/types/HousingPhase2Types';
import type { HousingProgressionSystem } from './HousingProgressionSystem';
import type { HomeCustomizationSystem } from './HomeCustomizationSystem';
import type { GarageHousingAdapter } from './GarageHousingAdapter';
import type { NeighborhoodSystem } from './NeighborhoodSystem';
import type { SafehouseAdapter } from './SafehouseAdapter';

type HousingTransition = 'idle' | 'previewing' | 'entering' | 'in-home' | 'exiting';

interface RealEstateSceneData {
  cityId: CityId;
  officeId: string;
}

/** Single authority for property catalog, ownership, purchase and home flow. */
export class HousingSystem extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.Housing;
  public readonly saveId = 'housing';

  private readonly ownership = new Set<string>();
  private readonly invalidLoadedIds = new Set<string>();
  private properties: readonly PropertyDefinition[] = [];
  private offices: readonly RealEstateOfficeDefinition[] = [];
  private activeHomeId: string | null = null;
  private transition: HousingTransition = 'idle';
  private currentCity: CityId | null = null;
  private previewPropertyId: string | null = null;
  private homePropertyId: string | null = null;
  private homeSnapshot: HomeEntrySnapshot | null = null;
  private processingPurchaseRequest = false;
  private housingEventCount = 0;

  protected onInit(): void {
    const world = this.resolveWorld();
    if (world) {
      const catalog =
        world.map.properties && world.map.realEstateOffices
          ? { properties: world.map.properties, offices: world.map.realEstateOffices }
          : createHousingCatalog(world.map, HOUSING_WORLD_SEED);
      this.properties = Object.freeze(
        catalog.properties.map((property) =>
          Object.freeze({
            ...property,
            entranceWorldPosition: Object.freeze({ ...property.entranceWorldPosition }),
            previewWorldPosition: Object.freeze({ ...property.previewWorldPosition }),
            previewBounds: property.previewBounds
              ? Object.freeze({ ...property.previewBounds })
              : undefined,
            features: Object.freeze([...property.features]),
          }),
        ),
      );
      this.offices = Object.freeze(
        catalog.offices.map((office) =>
          Object.freeze({
            ...office,
            npcSpawnPosition: Object.freeze({ ...office.npcSpawnPosition }),
          }),
        ),
      );
      this.validateCatalog(world);
      for (const city of ['tehran', 'yazd', 'gilan'] as const) {
        const propertyCount = this.properties.filter((property) => property.cityId === city).length;
        const officeCount = this.offices.filter((office) => office.cityId === city).length;
        if (propertyCount < 3 || officeCount !== 1) {
          EngineDiagnostics.recordError(
            new Error(
              `Housing catalog capacity for ${city}: ${propertyCount} properties, ${officeCount} offices`,
            ),
            'housing-catalog-validation',
            ServiceKeys.Housing,
          );
        }
      }
      if (!world.map.properties || !world.map.realEstateOffices) {
        this.log.debug('housing catalog projected from generated world geometry');
      }
    }
    this.resolveSave()?.registerProvider(this);
    this.subscribe(EventKeys.RealEstateInteractionRequested, (payload) =>
      this.openRealEstate(payload),
    );
    this.subscribe(EventKeys.PropertyPreviewRequested, (payload) =>
      this.startPreview(payload.propertyId),
    );
    this.subscribe(EventKeys.PropertyPurchaseRequested, (payload) => {
      if (this.processingPurchaseRequest) return;
      this.processingPurchaseRequest = true;
      try {
        this.purchaseInternal(payload.propertyId);
      } finally {
        this.processingPurchaseRequest = false;
      }
    });
    this.subscribe(EventKeys.HomeEnterRequested, (payload) =>
      this.acceptHomeEnter(payload.propertyId, payload.playerPosition),
    );
    this.subscribe(EventKeys.HomeExitRequested, () => this.exitHomeInternal());
    // If another lifecycle owner resumes or quits while a home scene is
    // active, unwind the transition before that owner tears down scenes.
    this.subscribe(EventKeys.GameResumed, () => {
      if (this.transition === 'in-home') this.exitHomeInternal();
    });
    this.subscribe(EventKeys.GameQuitToMenu, () => {
      if (this.transition === 'in-home' || this.transition === 'entering') {
        this.failHome(this.homePropertyId ?? 'unknown', 'exit', 'game quit during home transition');
      }
    });
    this.subscribe(EventKeys.PropertyOwnershipChanged, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.PropertyUpgradeChanged, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.PropertyCustomizationApplied, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.GarageOperationCompleted, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.NeighborInteractionCompleted, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.HousingMissionOffered, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.SafehouseUseCompleted, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.HomeEnterAccepted, () => {
      this.housingEventCount += 1;
    });
    this.subscribe(EventKeys.HomeExited, () => {
      this.housingEventCount += 1;
    });
  }

  protected override onDestroy(): void {
    this.resolveSave()?.unregisterProvider(this.saveId);
  }

  public get catalog(): readonly PropertyDefinition[] {
    return this.properties;
  }

  public get officesForWorld(): readonly RealEstateOfficeDefinition[] {
    return this.offices;
  }

  public get ownershipState(): HousingOwnershipState {
    return {
      ownedPropertyIds: this.sortedOwnedIds(),
      activeHomeId: this.activeHomeId,
      schemaVersion: 1,
    };
  }

  /** Read-only aggregate view used by save diagnostics and management UI. */
  public get phase2State(): HousingPhase2State {
    const progression = ServiceLocator.tryResolve<HousingProgressionSystem>(
      ServiceKeys.HousingProgression,
    );
    const customization = ServiceLocator.tryResolve<HomeCustomizationSystem>(
      ServiceKeys.HomeCustomization,
    );
    const garage = ServiceLocator.tryResolve<GarageHousingAdapter>(ServiceKeys.GarageHousing);
    const neighborhood = ServiceLocator.tryResolve<NeighborhoodSystem>(ServiceKeys.Neighborhood);
    const safehouse = ServiceLocator.tryResolve<SafehouseAdapter>(ServiceKeys.Safehouse);
    const safehouseState: Record<string, { uses: number; cooldownTicks: number }> = {};
    for (const state of safehouse?.stateSnapshot() ?? []) {
      safehouseState[state.propertyId] = { uses: state.uses, cooldownTicks: state.cooldownTicks };
    }
    return {
      schemaVersion: 2,
      upgrades: progression?.purchasedStates() ?? [],
      customization: customization?.allCustomizations() ?? [],
      garage: garage?.allGarageSlots() ?? [],
      activeVehicleIds: this.properties
        .map((property) => garage?.activeVehicle(property.id))
        .filter((id): id is string => id !== null),
      neighbors: neighborhood?.allRelationships() ?? [],
      safehouse: safehouseState,
    };
  }

  public getProperty(propertyId: string): PropertyDefinition | undefined {
    return this.properties.find((property) => property.id === propertyId);
  }

  public getPropertiesForCity(cityId: string): readonly PropertyDefinition[] {
    return this.properties.filter((property) => property.cityId === cityId);
  }

  public isOwned(propertyId: string): boolean {
    return this.ownership.has(propertyId);
  }

  public getActiveHome(): PropertyDefinition | undefined {
    return this.activeHomeId ? this.getProperty(this.activeHomeId) : undefined;
  }

  /** Spawn anchor used by PlayerController for a new session with an active home. */
  public getActiveHomeSpawnPosition(): Vector2 | null {
    const property = this.getActiveHome();
    return property ? { ...property.entranceWorldPosition } : null;
  }

  /** Additive convenience facade; progression state remains owned by HousingProgressionSystem. */
  public getUpgradeDefinitions(propertyId: string): readonly PropertyUpgradeDefinition[] {
    return (
      ServiceLocator.tryResolve<HousingProgressionSystem>(
        ServiceKeys.HousingProgression,
      )?.getUpgradeDefinitions(propertyId) ?? []
    );
  }

  public isUpgradePurchased(propertyId: string, upgradeId: string): boolean {
    return (
      ServiceLocator.tryResolve<HousingProgressionSystem>(
        ServiceKeys.HousingProgression,
      )?.isUpgradePurchased(propertyId, upgradeId) ?? false
    );
  }

  public canPurchaseUpgrade(propertyId: string, upgradeId: string): boolean {
    return (
      ServiceLocator.tryResolve<HousingProgressionSystem>(
        ServiceKeys.HousingProgression,
      )?.canPurchaseUpgrade(propertyId, upgradeId) ?? false
    );
  }

  public purchaseUpgrade(propertyId: string, upgradeId: string): PurchaseUpgradeResult {
    return (
      ServiceLocator.tryResolve<HousingProgressionSystem>(
        ServiceKeys.HousingProgression,
      )?.purchaseUpgrade(propertyId, upgradeId) ?? {
        success: false,
        propertyId,
        upgradeId,
        reason: 'transaction-rejected',
      }
    );
  }

  /** Deterministic cross-adapter snapshot used by replay and diagnostics. */
  public createReplaySnapshot(simulationSeed = HOUSING_WORLD_SEED): HousingReplaySnapshot {
    const progression = ServiceLocator.tryResolve<HousingProgressionSystem>(
      ServiceKeys.HousingProgression,
    );
    const customization = ServiceLocator.tryResolve<HomeCustomizationSystem>(
      ServiceKeys.HomeCustomization,
    );
    const garage = ServiceLocator.tryResolve<GarageHousingAdapter>(ServiceKeys.GarageHousing);
    const neighborhood = ServiceLocator.tryResolve<NeighborhoodSystem>(ServiceKeys.Neighborhood);
    const safehouse = ServiceLocator.tryResolve<SafehouseAdapter>(ServiceKeys.Safehouse);
    const simulationTick = progression?.currentSimulationTick ?? 0;
    const data = {
      worldSeed: HOUSING_WORLD_SEED,
      simulationSeed,
      simulationTick,
      activeHomeId: this.activeHomeId,
      ownedPropertyIds: this.sortedOwnedIds(),
      upgrades: progression?.purchasedStates() ?? [],
      customization: customization?.allCustomizations() ?? [],
      garage: garage?.allGarageSlots() ?? [],
      neighbors: neighborhood?.allRelationships() ?? [],
      safehouseUses: safehouse?.totalUses() ?? 0,
      housingEventCount: this.housingEventCount,
    };
    const snapshot = createHousingReplaySnapshot(data);
    this.bus.emit(EventKeys.HousingReplaySnapshotCreated, {
      deterministicHash: snapshot.deterministicHash,
      simulationTick,
    });
    return snapshot;
  }

  /** Atomic purchase: validate everything, debit the existing wallet, then commit ownership. */
  public purchaseProperty(propertyId: string): PropertyPurchaseResult {
    if (this.processingPurchaseRequest) {
      return this.purchaseFailure(propertyId, 'transaction-rejected');
    }
    this.processingPurchaseRequest = true;
    try {
      this.bus.emit(EventKeys.PropertyPurchaseRequested, { propertyId });
      return this.purchaseInternal(propertyId);
    } finally {
      this.processingPurchaseRequest = false;
    }
  }

  private purchaseInternal(propertyId: string): PropertyPurchaseResult {
    const property = this.getProperty(propertyId);
    if (!property || !property.valid) return this.purchaseFailure(propertyId, 'invalid-property');
    if (this.ownership.has(propertyId)) return this.purchaseFailure(propertyId, 'already-owned');
    const player = this.resolvePlayer()?.player;
    if (!player) return this.purchaseFailure(propertyId, 'transaction-rejected');
    const world = this.resolveWorld();
    const city = world?.cityAt(player.sprite.x, player.sprite.y)?.id;
    if (city !== property.cityId) return this.purchaseFailure(propertyId, 'wrong-city');
    if (player.inventory.money < property.price) {
      return this.purchaseFailure(propertyId, 'insufficient-funds');
    }
    if (!player.inventory.spendMoney(property.price)) {
      return this.purchaseFailure(propertyId, 'transaction-rejected');
    }
    this.ownership.add(propertyId);
    const ownedPropertyIds = this.sortedOwnedIds();
    this.bus.emit(EventKeys.PropertyOwnershipChanged, {
      propertyId,
      owned: true,
      ownedPropertyIds,
      activeHomeId: this.activeHomeId,
    });
    this.bus.emit(EventKeys.UIToast, { message: `${property.displayName} purchased` });
    return { success: true, propertyId, reason: 'purchased' };
  }

  public setActiveHome(propertyId: string): boolean {
    if (!this.ownership.has(propertyId) || !this.getProperty(propertyId)?.valid) return false;
    this.activeHomeId = propertyId;
    this.bus.emit(EventKeys.PropertyOwnershipChanged, {
      propertyId,
      owned: true,
      ownedPropertyIds: this.sortedOwnedIds(),
      activeHomeId: this.activeHomeId,
    });
    return true;
  }

  public canEnterHome(propertyId: string, playerPosition: Vector2): boolean {
    const property = this.getProperty(propertyId);
    if (!property || !property.valid || !this.ownership.has(propertyId)) return false;
    const dx = property.entranceWorldPosition.x - playerPosition.x;
    const dy = property.entranceWorldPosition.y - playerPosition.y;
    return dx * dx + dy * dy <= property.interactionRadius * property.interactionRadius;
  }

  public requestRealEstateInteraction(
    officeId: string,
    cityId: CityId,
    playerPosition: Vector2,
  ): void {
    this.bus.emit(EventKeys.RealEstateInteractionRequested, { officeId, cityId, playerPosition });
  }

  public requestEnterHome(propertyId: string): void {
    const position = this.resolvePlayer()?.playerPosition;
    if (!position) {
      this.rejectHome(propertyId, 'transaction-rejected');
      return;
    }
    this.bus.emit(EventKeys.HomeEnterRequested, { propertyId, playerPosition: { ...position } });
  }

  public requestExitHome(): void {
    if (!this.homePropertyId) return;
    this.bus.emit(EventKeys.HomeExitRequested, { propertyId: this.homePropertyId });
  }

  public closeRealEstate(): void {
    if (!this.currentCity) return;
    this.endPreview();
    this.stopOverlay(SceneKeys.RealEstate);
    this.stopOverlay(SceneKeys.HomeManagement);
    this.stopOverlay(SceneKeys.HomeCustomization);
    this.stopOverlay(SceneKeys.Garage);
    this.bus.emit(EventKeys.RealEstateClosed, { cityId: this.currentCity });
    const game = this.resolveGame();
    if (game?.state === GameState.Paused && this.transition === 'idle') game.resumeGame();
    this.currentCity = null;
  }

  private openRealEstate(payload: RealEstateSceneData & { playerPosition: Vector2 }): void {
    const office = this.offices.find(
      (candidate) => candidate.id === payload.officeId && candidate.cityId === payload.cityId,
    );
    if (!office || this.transition === 'in-home' || this.transition === 'entering') return;
    const world = this.resolveWorld();
    const city = world?.cityAt(payload.playerPosition.x, payload.playerPosition.y)?.id;
    if (city !== payload.cityId) return;
    const dx = office.npcSpawnPosition.x - payload.playerPosition.x;
    const dy = office.npcSpawnPosition.y - payload.playerPosition.y;
    if (dx * dx + dy * dy > office.interactionRadius * office.interactionRadius) return;
    const gameplay = this.gameplayScene();
    if (!gameplay || gameplay.scene.isActive(SceneKeys.RealEstate)) return;
    this.currentCity = payload.cityId;
    const game = this.resolveGame();
    if (game?.state === GameState.Playing) game.pauseGame();
    this.resolveInput()?.resetGameplayInput();
    this.stopModalScenes(gameplay);
    gameplay.scene.launch(SceneKeys.RealEstate, { cityId: payload.cityId, officeId: office.id });
    gameplay.scene.bringToTop(SceneKeys.RealEstate);
    this.bus.emit(EventKeys.RealEstateOpened, { officeId: office.id, cityId: payload.cityId });
  }

  private startPreview(propertyId: string): void {
    const property = this.getProperty(propertyId);
    if (
      !property ||
      !property.valid ||
      this.transition === 'in-home' ||
      this.transition === 'entering' ||
      (this.currentCity !== null && property?.cityId !== this.currentCity)
    ) {
      return;
    }
    if (this.transition === 'previewing') this.endPreview();
    const camera = this.resolveCamera();
    const world = this.resolveWorld();
    if (!camera?.camera || !world) return;
    const playerPosition = this.resolvePlayer()?.playerPosition;
    if (!playerPosition) return;
    this.homeSnapshot = {
      worldPosition: { ...playerPosition },
      cameraScroll: { x: camera.camera.scrollX, y: camera.camera.scrollY },
      cameraZoom: camera.camera.zoom,
      activeSceneKey: SceneKeys.Game,
      inputMode: 'gameplay',
      previousPauseState: this.resolveGame()?.state ?? null,
    };
    world.prepareChunkAt(property.previewWorldPosition.x, property.previewWorldPosition.y);
    camera.stopFollow();
    camera.centerOn(property.previewWorldPosition.x, property.previewWorldPosition.y);
    // GameScene is paused while the modal remains open, so an Arcade camera
    // tween would not advance; apply the preview zoom deterministically.
    camera.setZoom(1.25);
    this.previewPropertyId = propertyId;
    this.transition = 'previewing';
    this.bus.emit(EventKeys.PropertyPreviewStarted, { propertyId });
  }

  public endPreview(): void {
    if (this.transition !== 'previewing' || !this.previewPropertyId) return;
    const propertyId = this.previewPropertyId;
    const snapshot = this.homeSnapshot;
    const camera = this.resolveCamera();
    const player = this.resolvePlayer()?.player;
    const world = this.resolveWorld();
    if (snapshot && camera?.camera && player) {
      world?.prepareChunkAt(snapshot.worldPosition.x, snapshot.worldPosition.y);
      camera.camera.setScroll(snapshot.cameraScroll.x, snapshot.cameraScroll.y);
      camera.setZoom(snapshot.cameraZoom);
      camera.follow(player.sprite);
    }
    this.previewPropertyId = null;
    this.homeSnapshot = null;
    this.transition = 'idle';
    this.bus.emit(EventKeys.PropertyPreviewEnded, { propertyId });
  }

  private acceptHomeEnter(propertyId: string, playerPosition: Vector2): void {
    const property = this.getProperty(propertyId);
    if (!property || !property.valid) return this.rejectHome(propertyId, 'invalid-property');
    if (
      !['home:tehran-apartment', 'home:yazd-courtyard', 'home:gilan-wooden'].includes(
        property.interiorLayoutId,
      )
    ) {
      return this.rejectHome(propertyId, 'invalid-layout');
    }
    if (!this.ownership.has(propertyId)) return this.rejectHome(propertyId, 'not-owned');
    if (this.transition !== 'idle') return this.rejectHome(propertyId, 'transition-busy');
    const world = this.resolveWorld();
    if (world?.cityAt(playerPosition.x, playerPosition.y)?.id !== property.cityId) {
      return this.rejectHome(propertyId, 'wrong-city');
    }
    if (!this.canEnterHome(propertyId, playerPosition)) {
      return this.rejectHome(propertyId, 'out-of-range');
    }
    const player = this.resolvePlayer()?.player;
    const camera = this.resolveCamera();
    if (!player || !camera?.camera) return this.rejectHome(propertyId, 'transaction-rejected');
    this.homeSnapshot = {
      worldPosition: { x: player.sprite.x, y: player.sprite.y },
      cameraScroll: { x: camera.camera.scrollX, y: camera.camera.scrollY },
      cameraZoom: camera.camera.zoom,
      activeSceneKey: SceneKeys.Game,
      inputMode: 'gameplay',
      previousPauseState: this.resolveGame()?.state ?? null,
    };
    const payload: HomeInteriorPayload = {
      propertyId,
      layoutId: property.interiorLayoutId,
      deterministicSeed:
        property.deterministicSeed ??
        hashHousingSeed(HOUSING_WORLD_SEED, property.id, property.interiorLayoutId),
      entryWorldPosition: { ...property.entranceWorldPosition },
    };
    this.transition = 'entering';
    this.homePropertyId = propertyId;
    player.stopMoving();
    player.movement.setEnabled(false);
    const body = player.sprite.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.setVelocity(0, 0);
      body.enable = false;
    }
    player.sprite.setVisible(false);
    const game = this.resolveGame();
    if (game?.state === GameState.Playing) game.pauseGame();
    this.resolveInput()?.resetGameplayInput();
    const gameplay = this.gameplayScene();
    if (!gameplay) return this.failHome(propertyId, 'enter', 'GameScene unavailable');
    this.stopModalScenes(gameplay);
    gameplay.scene.launch(SceneKeys.Interior, { home: payload });
    gameplay.scene.bringToTop(SceneKeys.Interior);
    this.transition = 'in-home';
    this.bus.emit(EventKeys.HomeEnterAccepted, { propertyId, payload });
  }

  private exitHomeInternal(): void {
    if (this.transition !== 'in-home' || !this.homePropertyId) return;
    const propertyId = this.homePropertyId;
    this.transition = 'exiting';
    const snapshot = this.homeSnapshot;
    const player = this.resolvePlayer()?.player;
    const camera = this.resolveCamera();
    const world = this.resolveWorld();
    const gameplay = this.gameplayScene();
    try {
      gameplay?.scene.stop(SceneKeys.Interior);
      if (!snapshot || !player || !camera?.camera) throw new Error('home snapshot unavailable');
      world?.prepareChunkAt(snapshot.worldPosition.x, snapshot.worldPosition.y);
      player.sprite.enableBody(
        true,
        snapshot.worldPosition.x,
        snapshot.worldPosition.y,
        true,
        true,
      );
      player.movement.setEnabled(true);
      player.stopMoving();
      player.sprite.setVisible(true);
      camera.setBounds(0, 0, world?.widthPx ?? WORLD_WIDTH, world?.heightPx ?? WORLD_HEIGHT);
      camera.camera.setScroll(snapshot.cameraScroll.x, snapshot.cameraScroll.y);
      camera.setZoom(snapshot.cameraZoom);
      camera.follow(player.sprite);
      this.restoreOutdoorPauseState(snapshot);
      this.resolveInput()?.resetGameplayInput();
      this.transition = 'idle';
      this.homeSnapshot = null;
      this.homePropertyId = null;
      this.bus.emit(EventKeys.HomeExited, { propertyId });
    } catch (error) {
      this.failHome(propertyId, 'exit', String(error));
    }
  }

  private purchaseFailure(
    propertyId: string,
    reason: PropertyPurchaseReason,
  ): PropertyPurchaseResult {
    if (reason === 'insufficient-funds') {
      this.bus.emit(EventKeys.UIToast, { message: 'Insufficient funds' });
    }
    return { success: false, propertyId, reason };
  }

  private rejectHome(
    propertyId: string,
    reason:
      PropertyPurchaseReason | 'not-owned' | 'out-of-range' | 'transition-busy' | 'invalid-layout',
  ): void {
    this.bus.emit(EventKeys.HomeEnterRejected, { propertyId, reason });
    this.bus.emit(EventKeys.UIToast, { message: `Cannot enter home: ${reason}` });
  }

  private failHome(propertyId: string, phase: 'enter' | 'exit', reason: string): void {
    const snapshot = this.homeSnapshot;
    const player = this.resolvePlayer()?.player;
    const camera = this.resolveCamera();
    if ((phase === 'enter' || phase === 'exit') && snapshot && player) {
      player.sprite.enableBody(
        true,
        snapshot.worldPosition.x,
        snapshot.worldPosition.y,
        true,
        true,
      );
      player.movement.setEnabled(true);
      player.sprite.setVisible(true);
      if (camera?.camera) {
        camera.camera.setScroll(snapshot.cameraScroll.x, snapshot.cameraScroll.y);
        camera.setZoom(snapshot.cameraZoom);
        camera.follow(player.sprite);
      }
    }
    this.restoreOutdoorPauseState(snapshot);
    this.resolveInput()?.resetGameplayInput();
    this.transition = 'idle';
    this.homePropertyId = null;
    this.homeSnapshot = null;
    EngineDiagnostics.recordError(new Error(reason), `housing:${phase}`, ServiceKeys.Housing);
    this.bus.emit(EventKeys.HomeTransitionFailed, { propertyId, phase, reason });
    this.bus.emit(EventKeys.UIToast, { message: 'Home transition failed; world restored safely.' });
  }

  /** Restore the exact game pause state captured before a home transition. */
  private restoreOutdoorPauseState(snapshot: HomeEntrySnapshot | null): void {
    const game = this.resolveGame();
    if (!game || game.state !== GameState.Paused) return;
    if (snapshot?.previousPauseState === GameState.Playing) game.resumeGame();
  }

  public serialize(): Json {
    return {
      ownedPropertyIds: this.sortedOwnedIds(),
      activeHomeId: this.activeHomeId,
      schemaVersion: 1,
    };
  }

  public deserialize(data: Json): void {
    this.ownership.clear();
    this.invalidLoadedIds.clear();
    this.activeHomeId = null;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const ids = data['ownedPropertyIds'];
    if (Array.isArray(ids)) {
      for (const value of ids) {
        if (typeof value !== 'string') continue;
        const property = this.getProperty(value);
        if (!property || !property.valid) {
          this.invalidLoadedIds.add(value);
          EngineDiagnostics.recordError(
            new Error(`Unknown property id in save: ${value}`),
            'housing-load',
            ServiceKeys.Housing,
          );
          continue;
        }
        if (this.ownership.has(value)) {
          EngineDiagnostics.recordLimitExceeded(
            'housing-duplicate-ownership',
            2,
            1,
            'ignored-duplicate-ownership',
            value,
          );
          continue;
        }
        this.ownership.add(value);
      }
    }
    const active = data['activeHomeId'];
    if (typeof active === 'string' && this.ownership.has(active)) this.activeHomeId = active;
    else if (active !== null && active !== undefined) {
      EngineDiagnostics.recordError(
        new Error(`Invalid active home id in save: ${String(active)}`),
        'housing-load',
        ServiceKeys.Housing,
      );
    }
  }

  /** Migrate saves written before housing persistence existed. */
  public onMissingSaveSection(): void {
    this.deserialize({ schemaVersion: 0 });
  }

  private sortedOwnedIds(): string[] {
    return Array.from(this.ownership).sort();
  }

  /** Validate the projected catalog against finalized world geometry once. */
  private validateCatalog(world: WorldManager): void {
    const propertyIds = new Set<string>();
    const officeIds = new Set<string>();
    const worldWidth = world.map.widthTiles * world.map.tileSize;
    const worldHeight = world.map.heightTiles * world.map.tileSize;
    for (const property of this.properties) {
      if (propertyIds.has(property.id)) {
        this.catalogError(`duplicate property id: ${property.id}`);
      }
      propertyIds.add(property.id);
      if (!property.valid) this.catalogError(`invalid property definition: ${property.id}`);
      if (!Number.isFinite(property.price) || property.price < 0) {
        this.catalogError(`invalid property price: ${property.id}`);
      }
      if (!Number.isFinite(property.interactionRadius) || property.interactionRadius <= 0) {
        this.catalogError(`invalid property interaction radius: ${property.id}`);
      }
      const entrance = property.entranceWorldPosition;
      const preview = property.previewWorldPosition;
      if (
        !Number.isFinite(entrance.x) ||
        !Number.isFinite(entrance.y) ||
        entrance.x < 0 ||
        entrance.y < 0 ||
        entrance.x >= worldWidth ||
        entrance.y >= worldHeight
      ) {
        this.catalogError(`property entrance outside world bounds: ${property.id}`);
      }
      const city = world.cityAt(entrance.x, entrance.y)?.id;
      if (city !== undefined && city !== property.cityId) {
        this.catalogError(`property entrance city mismatch: ${property.id}`);
      }
      const district = world.districtAt?.(entrance.x, entrance.y);
      if (district !== undefined && district !== property.districtId) {
        this.catalogError(`property entrance district mismatch: ${property.id}`);
      }
      if (
        world.isSolidAtWorld?.(entrance.x, entrance.y) ||
        world.isDrivableAtWorld?.(entrance.x, entrance.y)
      ) {
        this.catalogError(
          `property entrance overlaps blocked or drivable geometry: ${property.id}`,
        );
      }
      const building = world.map.urbanPlan.buildings.find(
        (candidate) => candidate.id === property.buildingId,
      );
      if (!building || building.cityId !== property.cityId) {
        this.catalogError(`property building mismatch: ${property.id}`);
      }
      if (
        !Number.isFinite(preview.x) ||
        !Number.isFinite(preview.y) ||
        preview.x < 0 ||
        preview.y < 0 ||
        preview.x >= worldWidth ||
        preview.y >= worldHeight
      ) {
        this.catalogError(`property preview outside world bounds: ${property.id}`);
      }
      if (property.previewBounds) {
        const bounds = property.previewBounds;
        if (
          !Number.isFinite(bounds.x) ||
          !Number.isFinite(bounds.y) ||
          !Number.isFinite(bounds.width) ||
          !Number.isFinite(bounds.height) ||
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          bounds.x < 0 ||
          bounds.y < 0 ||
          bounds.x + bounds.width > worldWidth ||
          bounds.y + bounds.height > worldHeight
        ) {
          this.catalogError(`property preview bounds invalid: ${property.id}`);
        }
      }
    }
    for (const office of this.offices) {
      if (officeIds.has(office.id)) this.catalogError(`duplicate office id: ${office.id}`);
      officeIds.add(office.id);
      if (!Number.isFinite(office.interactionRadius) || office.interactionRadius <= 0) {
        this.catalogError(`invalid office interaction radius: ${office.id}`);
      }
      const building = world.map.urbanPlan.buildings.find(
        (candidate) => candidate.id === office.buildingId,
      );
      if (!building || building.cityId !== office.cityId) {
        this.catalogError(`office building mismatch: ${office.id}`);
      }
    }
  }

  private catalogError(message: string): void {
    EngineDiagnostics.recordError(new Error(message), 'housing-catalog-validation', this.key);
  }

  private gameplayScene(): Phaser.Scene | null {
    try {
      return this.game.scene.getScene(SceneKeys.Game) ?? null;
    } catch {
      return null;
    }
  }

  private stopModalScenes(gameplay: Phaser.Scene): void {
    gameplay.scene.stop(SceneKeys.Pause);
    gameplay.scene.stop(SceneKeys.Map);
    gameplay.scene.stop(SceneKeys.Inventory);
    gameplay.scene.stop(SceneKeys.Phone);
    gameplay.scene.stop(SceneKeys.Settings);
    gameplay.scene.stop(SceneKeys.RealEstate);
    gameplay.scene.stop(SceneKeys.HomeManagement);
    gameplay.scene.stop(SceneKeys.HomeCustomization);
    gameplay.scene.stop(SceneKeys.Garage);
  }

  private stopOverlay(key: SceneKeys): void {
    const gameplay = this.gameplayScene();
    gameplay?.scene.stop(key);
  }

  private resolveSave(): SaveManager | null {
    return ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save);
  }

  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }

  private resolvePlayer(): PlayerController | null {
    return ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
  }

  private resolveCamera(): CameraManager | null {
    return ServiceLocator.tryResolve<CameraManager>(ServiceKeys.Camera);
  }

  private resolveGame(): GameManager | null {
    return ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game);
  }

  private resolveInput(): InputManager | null {
    return ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input);
  }
}
