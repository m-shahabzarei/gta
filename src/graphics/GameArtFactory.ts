/**
 * Aggregates every gameplay art factory behind one call.
 *
 * Invoked once from {@link BootScene} after the Phase-1 placeholder textures are
 * generated, so all procedural pixel art (tiles, characters, vehicles, effects,
 * props, weapon icons) exists before any gameplay scene renders. Real Aseprite/
 * Tiled art can later be loaded under the same {@link TextureKeys} to replace
 * these procedurally-generated placeholders without touching consumer code.
 */
import type Phaser from 'phaser';
import { TilesetFactory } from './TilesetFactory';
import { CharacterTextureFactory } from './CharacterTextureFactory';
import { AnimalTextureFactory } from './AnimalTextureFactory';
import { VehicleTextureFactory } from './VehicleTextureFactory';
import { EffectTextureFactory } from './EffectTextureFactory';
import { PropTextureFactory } from './PropTextureFactory';
import { IconTextureFactory } from './IconTextureFactory';
import { EnvironmentTextureFactory } from './EnvironmentTextureFactory';

export class GameArtFactory {
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every gameplay texture (idempotent — each factory skips existing keys). */
  public generateAll(): void {
    new TilesetFactory(this.scene).generateAll();
    new CharacterTextureFactory(this.scene).generateAll();
    new AnimalTextureFactory(this.scene).generateAll();
    new VehicleTextureFactory(this.scene).generateAll();
    new EffectTextureFactory(this.scene).generateAll();
    new PropTextureFactory(this.scene).generateAll();
    new EnvironmentTextureFactory(this.scene).generateAll();
    new IconTextureFactory(this.scene).generateAll();
  }
}
