/**
 * Scene-bound manager for particle emitters.
 *
 * Wraps Phaser's particle system so gameplay code can spawn short-lived visual
 * bursts (impacts, sparks, dust) or long-lived custom emitters without dealing
 * with texture keys, depth sorting, or lifecycle cleanup directly.
 *
 * Every emitter it creates is depth-sorted onto {@link DepthLayers.Particles}
 * and tracked in an internal set so it can be torn down when the scene detaches.
 * All burst textures use the procedural {@link TextureKeys.Particle} swatch, so
 * this works in Phase 1 with no real art assets present.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { Pool } from '@/utils/Pool';

export class ParticleManager extends BaseSceneManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Particle;

  /** Every emitter this manager currently owns. */
  private readonly emitters = new Set<Phaser.GameObjects.Particles.ParticleEmitter>();

  /** Reused one-shot burst emitter; avoids allocating an emitter per impact. */
  private burstEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private imagePool: Pool<Phaser.GameObjects.Image> | null = null;
  private readonly imageLeases = new Map<Phaser.GameObjects.Image, number>();

  /** No game-level resources to acquire; emitters are scene-scoped. */
  protected onInit(): void {}

  /** Nothing to pre-build on attach; the base class stores the scene. */
  protected onAttach(scene: Phaser.Scene): void {
    this.imagePool = new Pool(
      () => scene.add.image(0, 0, TextureKeys.Particle).setActive(false).setVisible(false),
      (image) => {
        scene.tweens.killTweensOf(image);
        image
          .setActive(false)
          .setVisible(false)
          .setAlpha(1)
          .setScale(1)
          .setRotation(0)
          .setScrollFactor(1)
          .setOrigin(0.5)
          .setBlendMode(Phaser.BlendModes.NORMAL)
          .clearTint();
      },
      32,
    );
  }

  /** Destroy every emitter when the scene goes away. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.clear();
  }

  /**
   * Fire a one-shot radial burst of particles at world position (x, y).
   *
   * @param x     World x-coordinate of the burst origin.
   * @param y     World y-coordinate of the burst origin.
   * @param count Number of particles to emit (default 12).
   */
  public burst(x: number, y: number, count = 12): void {
    if (!this.scene) return;
    const emitter = this.ensureBurstEmitter();
    if (!emitter) return;
    emitter.explode(count, x, y);
  }

  /**
   * Create a tracked, depth-sorted particle emitter using the procedural
   * particle texture. Returns `null` when no scene is attached.
   *
   * @param config Phaser particle emitter configuration.
   */
  public createEmitter(
    config: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig,
  ): Phaser.GameObjects.Particles.ParticleEmitter | null {
    if (!this.scene) return null;
    if (this.emitters.size >= ENGINE_LIMITS.MAX_PARTICLE_EMITTERS) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_PARTICLE_EMITTERS',
        this.emitters.size + 1,
        ENGINE_LIMITS.MAX_PARTICLE_EMITTERS,
        'rejected-particle-emitter',
        'ParticleManager',
      );
      return null;
    }
    const emitter = this.scene.add.particles(0, 0, TextureKeys.Particle, config);
    emitter.setDepth(DepthLayers.Particles);
    this.emitters.add(emitter);
    return emitter;
  }

  /** Destroy and forget every emitter this manager owns. */
  public clear(): void {
    for (const emitter of this.emitters) emitter.destroy();
    this.emitters.clear();
    this.burstEmitter = null;
    this.imageLeases.clear();
    this.imagePool?.destroy((image) => image.destroy());
    this.imagePool = null;
  }

  public get activeParticleCount(): number {
    let total = 0;
    for (const emitter of this.emitters) total += emitter.getAliveParticleCount();
    return total + (this.imagePool?.activeCount ?? 0);
  }

  public acquireImage(
    texture: string,
    x: number,
    y: number,
    lifetimeMs = 0,
  ): Phaser.GameObjects.Image | null {
    if ((this.imagePool?.activeCount ?? 0) >= ENGINE_LIMITS.MAX_PARTICLE_IMAGES) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_PARTICLE_IMAGES',
        (this.imagePool?.activeCount ?? 0) + 1,
        ENGINE_LIMITS.MAX_PARTICLE_IMAGES,
        'rejected-particle-image',
        texture,
      );
      return null;
    }
    const image = this.imagePool?.acquire();
    if (!image) return null;
    if (lifetimeMs > 0) {
      this.imageLeases.set(image, (this.scene?.time.now ?? performance.now()) + lifetimeMs);
    }
    return image.setTexture(texture).setPosition(x, y).setActive(true).setVisible(true);
  }

  public releaseImage(image: Phaser.GameObjects.Image): void {
    this.imageLeases.delete(image);
    this.imagePool?.release(image);
  }

  public update(time: number, _delta: number): void {
    for (const [image, expiresAt] of this.imageLeases) {
      if (time >= expiresAt) this.releaseImage(image);
    }
  }

  private ensureBurstEmitter(): Phaser.GameObjects.Particles.ParticleEmitter | null {
    if (this.burstEmitter && this.burstEmitter.active) return this.burstEmitter;
    this.burstEmitter = this.createEmitter({
      speed: { min: 40, max: 140 },
      lifespan: 600,
      scale: { start: 0.6, end: 0 },
      blendMode: 'ADD',
      emitting: false,
    });
    return this.burstEmitter;
  }
}
