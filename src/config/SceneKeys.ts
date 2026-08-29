/**
 * Canonical identifiers for every Phaser {@link Phaser.Scene} in the game.
 *
 * Using a frozen enum instead of raw string literals guarantees that scene
 * transitions (`scene.start`, `scene.launch`, `scene.stop`) are always
 * type-checked and refactor-safe.
 */
export enum SceneKeys {
  /** Bootstraps the game: generates placeholder textures and core registry. */
  Boot = 'BootScene',
  /** Loads all declared assets and shows the loading progress bar. */
  Preload = 'PreloadScene',
  /** Title screen and top-level navigation. */
  MainMenu = 'MainMenuScene',
  /** The world/gameplay scene (framework demo in Phase 1). */
  Game = 'GameScene',
  /** Persistent, transparent scene that renders the HUD above the world. */
  UI = 'UIScene',
  /** Modal pause overlay launched on top of {@link SceneKeys.Game}. */
  Pause = 'PauseScene',
  /** Full-screen world map overlay. */
  Map = 'MapScene',
  /** Modal audio/gameplay settings overlay. */
  Settings = 'SettingsScene',
  /** Modal inventory (weapons / money) overlay. */
  Inventory = 'InventoryScene',
  /** Modal in-game smartphone overlay. */
  Phone = 'PhoneScene',
  /** Enterable building interior scene. */
  Interior = 'InteriorScene',
  /** Real-estate catalog modal overlay. */
  RealEstate = 'RealEstateScene',
  /** Phase 2 owned-home management modal. */
  HomeManagement = 'HomeManagementScene',
  /** Phase 2 slot-based interior customization modal. */
  HomeCustomization = 'HomeCustomizationScene',
  /** Phase 2 garage storage modal. */
  Garage = 'GarageScene',
}
