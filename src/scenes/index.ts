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
] as const;
