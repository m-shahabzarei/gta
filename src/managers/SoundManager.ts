/**
 * SoundManager — engine-level sound-effect playback and audio state.
 *
 * Owns the short, one-shot SFX channel (music lives in {@link MusicManager}).
 * It listens for {@link EventKeys.AudioPlaySound} requests, applies master +
 * sfx volume, and exposes mute/volume controls that broadcast their changes on
 * the bus so the UI and other systems can stay in sync.
 *
 * Phase 1 ships no audio files, so every playback path first checks the audio
 * cache and degrades to a debug no-op when a clip is missing — nothing throws.
 */
import Phaser from 'phaser';
import { BaseManager } from '@/core/BaseManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { AUDIO } from '@/config/Constants';
import { clamp } from '@/utils';

/** Optional per-play overrides for a sound effect. */
interface SoundPlayConfig {
  /** Absolute clip volume before the master multiplier (0..1). */
  volume?: number;
  /** Whether the clip should loop until explicitly stopped. */
  loop?: boolean;
}

export class SoundManager extends BaseManager {
  /** Service-locator identity for this manager. */
  public readonly key = ServiceKeys.Sound;

  /** Base volume applied to sound effects when no per-play override is given. */
  private sfxVolume: number = AUDIO.SFX_VOLUME;

  /** Master multiplier applied on top of every channel's own volume. */
  private masterVolume = AUDIO.MASTER_VOLUME;

  /** Whether all audio output is currently muted. */
  private mutedFlag = false;

  /**
   * Wire up the audio request listener. Playback is driven entirely through
   * {@link EventKeys.AudioPlaySound} so callers never touch Phaser directly.
   */
  protected onInit(): void {
    this.subscribe(EventKeys.AudioPlaySound, (payload) => {
      this.play(payload.key, { volume: payload.volume });
    });
    this.log.debug('sound manager ready');
  }

  /**
   * Play a sound effect by cache key. When the clip is not present in the audio
   * cache (Phase 1 has no audio assets) this logs a debug no-op and returns.
   */
  public play(key: string, config?: SoundPlayConfig): void {
    if (!this.game.cache.audio.exists(key)) {
      this.log.debug(`sfx "${key}" not cached — skipping playback`);
      return;
    }
    const base = config?.volume ?? this.sfxVolume;
    this.game.sound.play(key, {
      volume: clamp(base * this.masterVolume, 0, 1),
      loop: config?.loop ?? false,
    });
  }

  /**
   * Stop every currently-playing instance of the given key. Uses the Phaser
   * base sound manager's `stopByKey` when available; otherwise a safe no-op.
   */
  public stop(key: string): void {
    const manager = this.game.sound as Partial<Phaser.Sound.BaseSoundManager>;
    if (typeof manager.stopByKey === 'function') {
      manager.stopByKey(key);
    }
  }

  /** Stop all currently-playing sounds across every channel. */
  public stopAll(): void {
    this.game.sound.stopAll();
  }

  /** The current sfx base volume (0..1), before the master multiplier. */
  public get volume(): number {
    return this.sfxVolume;
  }

  /**
   * Set the sfx base volume (clamped to 0..1) and broadcast the change so the
   * settings UI and any listeners can update.
   */
  public setVolume(v: number): void {
    this.sfxVolume = clamp(v, 0, 1);
    this.bus.emit(EventKeys.AudioVolumeChanged, {
      channel: 'sfx',
      volume: this.sfxVolume,
    });
  }

  /** Whether audio output is currently muted. */
  public get muted(): boolean {
    return this.mutedFlag;
  }

  /**
   * Mute or unmute all audio. Applies to the underlying Phaser sound manager
   * and emits {@link EventKeys.AudioMuteToggled}.
   */
  public setMuted(m: boolean): void {
    this.mutedFlag = m;
    this.game.sound.mute = m;
    this.bus.emit(EventKeys.AudioMuteToggled, { muted: m });
  }

  /** Flip the current mute state. */
  public toggleMute(): void {
    this.setMuted(!this.mutedFlag);
  }
}
