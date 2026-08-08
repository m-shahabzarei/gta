/**
 * The Phaser {@link Phaser.Types.Core.GameConfig} for the game.
 *
 * Scenes are intentionally NOT listed here: the bootstrap (`Game.ts`) creates
 * and initialises every manager first, then adds and starts the scenes, so no
 * scene ever runs before its services exist.
 */
import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT, PHYSICS, COLORS } from './Constants';
import { detectMobileEnvironment } from '@/platform';

/** Build the immutable game configuration. */
export function createGameConfig(): Phaser.Types.Core.GameConfig {
  const mobile = detectMobileEnvironment();
  return {
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: COLORS.BACKGROUND,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    // Crisp pixel-art scaling.
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    scale: {
      // EXPAND keeps the 16:9 logical height while revealing additional world
      // on wider mobile screens. Desktop retains its exact FIT behaviour.
      mode: mobile ? Phaser.Scale.EXPAND : Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
    },
    render: {
      pixelArt: true,
      antialias: false,
      roundPixels: true,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: PHYSICS.GRAVITY_X, y: PHYSICS.GRAVITY_Y },
        debug: PHYSICS.DEBUG,
      },
    },
    input: {
      gamepad: true,
      activePointers: mobile ? 6 : 2,
    },
    // Scenes are registered dynamically after managers initialise.
    scene: [],
    // We drive our own manager loop off the game STEP event.
    autoFocus: true,
    disableContextMenu: true,
  };
}
