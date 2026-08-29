/**
 * Barrel export for every scene, plus the ordered list used at bootstrap.
 */
import { BootScene } from './BootScene';
import { PreloadScene } from './PreloadScene';
import { MainMenuScene } from './MainMenuScene';
import { GameScene } from './GameScene';
import { UIScene } from './UIScene';
import { PauseScene } from './PauseScene';
import { MapScene } from './MapScene';
import { SettingsScene } from './SettingsScene';
import { InventoryScene } from './InventoryScene';
import { PhoneScene } from './PhoneScene';
import { InteriorScene } from './InteriorScene';
import { RealEstateScene } from './RealEstateScene';
import { HomeManagementScene } from './HomeManagementScene';
import { HomeCustomizationScene } from './HomeCustomizationScene';
import { GarageScene } from './GarageScene';

export {
  BootScene,
  PreloadScene,
  MainMenuScene,
  GameScene,
  UIScene,
  PauseScene,
  MapScene,
  SettingsScene,
  InventoryScene,
  PhoneScene,
  InteriorScene,
  RealEstateScene,
  HomeManagementScene,
  HomeCustomizationScene,
  GarageScene,
};

/**
 * All scene classes in registration order. The first entry (Boot) is the entry
 * scene the bootstrap starts once managers are ready.
 */
export const SCENE_CLASSES = [
  BootScene,
  PreloadScene,
  MainMenuScene,
  GameScene,
  UIScene,
  PauseScene,
  MapScene,
  SettingsScene,
  InventoryScene,
  PhoneScene,
  InteriorScene,
  RealEstateScene,
  HomeManagementScene,
  HomeCustomizationScene,
  GarageScene,
] as const;
