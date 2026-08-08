/**
 * MusicManager — owns the single, looping background-music channel.
 *
 * Unlike one-shot sound effects (see {@link SoundManager}), only one music
 * track plays at a time, and transitions between tracks are cross-faded for a
 * smooth feel. Because this manager is scene-independent, it cannot use Phaser
 * scene tweens; instead it drives all fades itself from the game loop via the
 * delta-timed {@link update} method.
 *
 * Phase 1 ships without audio assets, so every code path guards on the audio
 * cache and degrades to a logged no-op when a track is missing rather than
 * throwing.
 */
import Phaser from 'phaser';
import { BaseManager } from '@/core/BaseManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { AUDIO } from '@/config/Constants';
import { clamp, lerp } from '@/utils';

/** A Phaser sound that may expose a runtime `setVolume` method. */
type VolumeCapableSound = Phaser.Sound.BaseSound & {
  setVolume?: (value: number) => void;
};

/** An in-progress volume fade, advanced each frame by {@link MusicManager.update}. */
interface Fade {
  /** Volume the fade starts from. */
  from: number;
  /** Volume the fade ends at. */
  to: number;
  /** Accumulated time (ms) since the fade began. */
  elapsed: number;
  /** Total fade duration in milliseconds. */
  durationMs: number;
  /** Optional callback fired once the fade reaches completion. */
  onDone: (() => void) | null;
}

/**
 * Manages the background-music channel with delta-driven cross-fades.
 */
export class MusicManager extends BaseManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Music;

  /** The currently playing (or fading) music instance, if any. */
  private current: Phaser.Sound.BaseSound | null = null;

  /** The key of the current track, or the key a caller last requested. */
  private currentKeyValue: string | null = null;

  /** Target playback volume for music (0..1). */
  private musicVolume: number = AUDIO.MUSIC_VOLUME;

  /** The active fade, or `null` when no fade is in progress. */
  private fade: Fade | null = null;

  /**
   * Wire up the audio event bridge so other systems can request music
   * playback without holding a direct reference to this manager.
   */
  protected onInit(): void {
    this.subscribe(EventKeys.AudioPlayMusic, (payload) => {
      this.play(payload.key, { loop: payload.loop });
    });
    this.subscribe(EventKeys.AudioStopMusic, () => {
      this.stop();
    });
  }

  /**
   * Start playing a music track, fading it in from silence. If the requested
   * track is already the active one, this is a no-op.
   */
  public play(key: string, opts?: { loop?: boolean; fadeMs?: number }): void {
    if (this.currentKeyValue === key && this.current && this.current.isPlaying) {
      return;
    }

    if (!this.game.cache.audio.exists(key)) {
      this.log.debug(`music track '${key}' not loaded; skipping playback`);
      // Remember the request so repeated callers do not spam the log.
      this.currentKeyValue = key;
      return;
    }

    // Replace any existing track immediately; the new one fades in.
    if (this.current) {
      this.current.stop();
      this.current.destroy();
      this.current = null;
    }

    const sound = this.game.sound.add(key, { loop: opts?.loop ?? true, volume: 0 });
    this.current = sound;
    this.currentKeyValue = key;
    sound.play();
    this.bus.emit(EventKeys.AudioMusicChanged, { key });

    this.startFade(0, this.musicVolume, opts?.fadeMs ?? AUDIO.MUSIC_FADE_MS, null);
  }

  /**
   * Fade the current track out and dispose of it. Does nothing when no track
   * is active.
   */
  public stop(fadeMs?: number): void {
    if (!this.current) return;
    const sound = this.current;
    this.startFade(this.readSoundVolume(sound), 0, fadeMs ?? AUDIO.MUSIC_FADE_MS, () => {
      sound.stop();
      sound.destroy();
      if (this.current === sound) {
        this.current = null;
        this.currentKeyValue = null;
      }
    });
  }

  /**
   * Transition to a different track: fade the current one out, then fade the
   * new one in. With no track playing this collapses to a plain {@link play}.
   */
  public crossFade(key: string, fadeMs?: number): void {
    const duration = fadeMs ?? AUDIO.MUSIC_FADE_MS;
    if (this.current) {
      const outgoing = this.current;
      this.startFade(this.readSoundVolume(outgoing), 0, duration, () => {
        outgoing.stop();
        outgoing.destroy();
        if (this.current === outgoing) {
          this.current = null;
          this.currentKeyValue = null;
        }
        this.play(key, { fadeMs: duration });
      });
    } else {
      this.play(key, { fadeMs: duration });
    }
  }

  /** The target music volume (0..1). */
  public get volume(): number {
    return this.musicVolume;
  }

  /**
   * Set the target music volume. Applied immediately to the current track when
   * no fade is running; an active fade will pick up the new target on its own.
   */
  public setVolume(v: number): void {
    this.musicVolume = clamp(v, 0, 1);
    if (!this.fade && this.current) {
      this.setSoundVolume(this.current, this.musicVolume);
    }
  }

  /** Pause the current track, if any. */
  public pauseMusic(): void {
    this.current?.pause();
  }

  /** Resume the current track, if any. */
  public resumeMusic(): void {
    this.current?.resume();
  }

  /** The key of the currently active track, or `null` when silent. */
  public get currentKey(): string | null {
    return this.currentKeyValue;
  }

  /**
   * Advance any in-progress fade. Cheap early-out when no fade is active.
   */
  public update(_time: number, delta: number): void {
    const fade = this.fade;
    if (!fade) return;

    fade.elapsed += delta;
    const t = clamp(fade.elapsed / fade.durationMs, 0, 1);
    const vol = lerp(fade.from, fade.to, t);
    if (this.current) {
      this.setSoundVolume(this.current, vol);
    }

    if (t >= 1) {
      const done = fade.onDone;
      this.fade = null;
      if (done) done();
    }
  }

  /** Stop and dispose of any playing track on teardown. */
  protected onDestroy(): void {
    if (this.current) {
      this.current.stop();
      this.current.destroy();
      this.current = null;
    }
    this.currentKeyValue = null;
    this.fade = null;
  }

  /**
   * Begin a new fade, replacing any fade already in flight. A zero/negative
   * duration is treated as instantaneous so the target is reached at once.
   */
  private startFade(from: number, to: number, durationMs: number, onDone: (() => void) | null): void {
    if (durationMs <= 0) {
      if (this.current) this.setSoundVolume(this.current, to);
      this.fade = null;
      if (onDone) onDone();
      return;
    }
    this.fade = { from, to, elapsed: 0, durationMs, onDone };
  }

  /**
   * Apply a volume to a sound in a type-safe way, guarding for backends that
   * do not expose a `setVolume` method.
   */
  private setSoundVolume(sound: Phaser.Sound.BaseSound, v: number): void {
    const capable = sound as VolumeCapableSound;
    if (typeof capable.setVolume === 'function') {
      capable.setVolume(v);
    }
  }

  /**
   * Read the current volume of a sound, defaulting to the target music volume
   * when the backend does not expose one.
   */
  private readSoundVolume(sound: Phaser.Sound.BaseSound): number {
    const withVolume = sound as Phaser.Sound.BaseSound & { volume?: number };
    return typeof withVolume.volume === 'number' ? withVolume.volume : this.musicVolume;
  }
}
