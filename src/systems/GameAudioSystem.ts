/**
 * GameAudioSystem — fully procedural WebAudio sound-effect synthesiser.
 *
 * The game ships no audio files, so every gameplay cue is generated at runtime
 * with the browser WebAudio API. Highlights:
 *  - **Engine**: a layered oscillator drone whose pitch and filter cutoff track
 *    the driven vehicle's speed each frame, with simulated gear bands (revs
 *    climb within a gear, dip on the shift) and a distinct high buzz for
 *    motorcycles versus a deep rumble for heavy vehicles.
 *  - **Tire skid**: a looping band-passed noise bed gated on the skid state.
 *  - **Sirens**: a self-oscillating two-tone police wail scaled to the wanted
 *    level.
 *  - One-shots for gunfire, explosions, crashes, horns, car doors, reloads,
 *    pickups, hit-markers, footsteps and thunder.
 *
 * The whole subsystem degrades gracefully: with no {@link AudioContext} every
 * method is a no-op. The context is created suspended and resumed on the first
 * user gesture, satisfying browser autoplay policies.
 */
import { BaseManager } from '@/core/BaseManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { AUDIO } from '@/config/Constants';
import { WEAPONS } from '@/data';
import {
  WeaponCategory,
  type EngineKind,
  type InteriorAmbienceKind,
  type VehicleKind,
  type WeaponDef,
  getPlayerRef,
} from '@/gameplay/types';
import { clamp } from '@/utils';

/** Constructor shape shared by `AudioContext` and legacy `webkitAudioContext`. */
type AudioContextCtor = new () => AudioContext;

/** Parameters for a single filtered white-noise burst. */
interface NoiseBurstConfig {
  durationMs: number;
  filterType: BiquadFilterType;
  frequency: number;
  q: number;
  gain: number;
}

/** Parameters for a single enveloped oscillator tone. */
interface ToneConfig {
  type: OscillatorType;
  frequency: number;
  endFrequency?: number;
  durationMs: number;
  gain: number;
}

/** A running looped source group (siren). */
interface AudioLoop {
  readonly oscillators: OscillatorNode[];
  readonly gain: GainNode;
}

/** The live engine synth nodes, modulated per frame. */
interface EngineSynth {
  base: OscillatorNode;
  harmonic: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  kind: EngineKind;
}

/** The live tire-skid noise bed. */
interface SkidSynth {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

/** Minimal view of the player controller used to read the driven vehicle. */
interface DrivenVehicleProvider {
  currentVehicle?: {
    def: { maxSpeed: number; engine: EngineKind };
    movement: { speed: number };
  } | null;
}

const MAX_SIMULTANEOUS_ONE_SHOTS = 18;
const SFX_HEARING_RADIUS_SQ = 1400 * 1400;

export class GameAudioSystem extends BaseManager {
  /** Service-locator identity for this system. */
  public readonly key = ServiceKeys.GameAudio;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private masterVolume: number = AUDIO.MASTER_VOLUME * AUDIO.SFX_VOLUME;
  private mutedFlag = false;

  private engine: EngineSynth | null = null;
  private skid: SkidSynth | null = null;
  private sirenLoop: AudioLoop | null = null;
  private interiorLoop: AudioLoop | null = null;
  private regionalLoop: AudioLoop | null = null;
  private interiorKind: InteriorAmbienceKind | null = null;
  private regionalId = '';

  /** Smoothed engine revs (0..1) so pitch changes are not jittery. */
  private engineRev = 0;
  private activeOneShots = 0;

  private readonly gestureHandler = (): void => this.resumeContext();

  /** Create the audio context and wire every gameplay-audio subscription. */
  protected onInit(): void {
    this.createContext();

    this.subscribe(EventKeys.InputActionDown, this.gestureHandler);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.gestureHandler, { once: true });
      window.addEventListener('keydown', this.gestureHandler, { once: true });
    }

    this.subscribe(EventKeys.WeaponFired, (p) => {
      if (this.canHear(p.x, p.y)) this.playGunshot(p.weaponId);
    });
    this.subscribe(EventKeys.ExplosionSpawned, (p) => {
      if (this.canHear(p.x, p.y)) this.playBoom();
    });
    this.subscribe(EventKeys.VehicleDestroyed, () => this.playBoom());
    this.subscribe(EventKeys.Footstep, () => this.playFootstep());
    this.subscribe(EventKeys.EntityKilled, (p) => {
      if (this.canHear(p.position.x, p.position.y)) this.playThud();
    });
    this.subscribe(EventKeys.PlayerDamaged, () => this.playThud());
    this.subscribe(EventKeys.EngineStateChanged, (p) => this.setEngine(p.running, p.vehicleKind));
    this.subscribe(EventKeys.WantedChanged, (p) => this.setSiren(p.level));
    this.subscribe(EventKeys.TireSkidChanged, (p) => this.setSkid(p.active));
    this.subscribe(EventKeys.VehicleCollision, (p) => {
      if (this.canHear(p.x, p.y)) this.playCrash(p.intensity);
    });
    this.subscribe(EventKeys.HornSounded, (p) => this.playHorn(p.kind));
    this.subscribe(EventKeys.VehicleDoor, (p) => this.playDoor(p.open));
    this.subscribe(EventKeys.InteriorAmbienceChanged, (p) => this.setInteriorAmbience(p.kind));
    this.subscribe(EventKeys.WeaponReloadStarted, () => this.playReload());
    this.subscribe(EventKeys.PickupCollected, () => this.playPickup());
    this.subscribe(EventKeys.HitConfirmed, () => this.playHitTick());
    this.subscribe(EventKeys.ThunderStrike, (p) => this.playThunder(p.intensity));

    this.subscribe(EventKeys.AudioMuteToggled, (p) => {
      this.mutedFlag = p.muted;
      this.applyMasterGain();
    });
    this.subscribe(EventKeys.AudioVolumeChanged, (p) => {
      if (p.channel === 'master' || p.channel === 'sfx') {
        this.masterVolume = clamp(p.volume, 0, 1);
        this.applyMasterGain();
      }
    });

    this.log.debug(this.ctx ? 'procedural audio ready' : 'audio context unavailable — muted');
  }

  /** Stop all loops, remove gesture hooks and close the audio context. */
  protected onDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.gestureHandler);
      window.removeEventListener('keydown', this.gestureHandler);
    }
    this.stopEngine();
    this.setSkid(false);
    this.stopLoop(this.sirenLoop);
    this.stopLoop(this.interiorLoop);
    this.stopLoop(this.regionalLoop);
    this.sirenLoop = null;
    this.interiorLoop = null;
    this.regionalLoop = null;
    this.interiorKind = null;
    this.regionalId = '';
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.master = null;
    this.noiseBuffer = null;
    this.activeOneShots = 0;
  }

  /** Per-frame: modulate the running engine from the driven vehicle's speed. */
  public update(_time: number, delta: number): void {
    this.updateRegionalAmbience();
    const engine = this.engine;
    const ctx = this.ctx;
    if (!engine || !ctx) return;

    const provider = ServiceLocator.tryResolve(
      ServiceKeys.Player,
    ) as unknown as DrivenVehicleProvider | null;
    const vehicle = provider?.currentVehicle ?? null;
    const speedRatio = vehicle
      ? clamp(Math.abs(vehicle.movement.speed) / Math.max(1, vehicle.def.maxSpeed), 0, 1)
      : 0;

    // Simulated gears: four bands; revs climb within a band then dip on shift.
    const GEARS = 4;
    const band = Math.min(GEARS - 1, Math.floor(speedRatio * GEARS));
    const within = speedRatio * GEARS - band;
    const targetRev = 0.25 + within * 0.75;

    // Smooth toward the target so shifts glide.
    const k = Math.min(1, delta / 120);
    this.engineRev += (targetRev - this.engineRev) * k;

    const now = ctx.currentTime;
    const isBike = engine.kind === 'motorcycle';
    const isHeavy = engine.kind === 'heavy';
    const baseHz = isBike ? 120 : isHeavy ? 46 : 62;
    const rangeHz = isBike ? 260 : isHeavy ? 90 : 150;
    const freq = baseHz + this.engineRev * rangeHz;
    engine.base.frequency.setTargetAtTime(freq, now, 0.05);
    engine.harmonic.frequency.setTargetAtTime(freq * (isBike ? 2.02 : 1.5), now, 0.05);
    engine.filter.frequency.setTargetAtTime(
      300 + this.engineRev * 900 + speedRatio * 400,
      now,
      0.06,
    );
    engine.gain.gain.setTargetAtTime(0.14 + speedRatio * 0.1, now, 0.08);
  }

  // ── Context plumbing ─────────────────────────────────────────────────────────

  /** Crossfade a subtle procedural regional bed as the player drives between biomes. */
  private updateRegionalAmbience(): void {
    const ctx = this.ctx;
    const master = this.master;
    const position = getPlayerRef()?.playerPosition ?? null;
    if (!ctx || !master || !position) return;
    const world = ServiceLocator.tryResolve(ServiceKeys.World) as {
      cityAt?(x: number, y: number): { id: string } | null;
      districtAt?(x: number, y: number): string;
    } | null;
    const city = world?.cityAt?.(position.x, position.y) ?? null;
    const key = city?.id ?? world?.districtAt?.(position.x, position.y) ?? 'highway';
    if (key === this.regionalId) return;

    if (this.regionalLoop) this.fadeOutLoop(this.regionalLoop, 0.7);
    this.regionalLoop = null;
    this.regionalId = key;

    const profile =
      key === 'gilan'
        ? { base: 196, overtone: 293, gain: 0.032, type: 'sine' as OscillatorType }
        : key === 'yazd' || key === 'desert'
          ? { base: 118, overtone: 177, gain: 0.022, type: 'triangle' as OscillatorType }
          : key === 'tehran'
            ? { base: 72, overtone: 108, gain: 0.018, type: 'sawtooth' as OscillatorType }
            : { base: 146, overtone: 219, gain: 0.016, type: 'sine' as OscillatorType };

    const base = ctx.createOscillator();
    base.type = profile.type;
    base.frequency.value = profile.base;
    const overtone = ctx.createOscillator();
    overtone.type = 'sine';
    overtone.frequency.value = profile.overtone;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = key === 'gilan' ? 0.24 : 0.1;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = key === 'gilan' ? 12 : 5;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(profile.gain, now + 0.8);

    lfo.connect(lfoGain);
    lfoGain.connect(overtone.frequency);
    base.connect(gain);
    overtone.connect(gain);
    gain.connect(master);
    base.start(now);
    overtone.start(now);
    lfo.start(now);
    this.regionalLoop = { oscillators: [base, overtone, lfo], gain };
  }

  private createContext(): void {
    const ctor = this.resolveContextCtor();
    if (!ctor) return;
    try {
      const ctx = new ctor();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.applyMasterGain();
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  private resolveContextCtor(): AudioContextCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
      AudioContext?: AudioContextCtor;
      webkitAudioContext?: AudioContextCtor;
    };
    return w.AudioContext ?? w.webkitAudioContext ?? null;
  }

  private resumeContext(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
  }

  private applyMasterGain(): void {
    if (!this.master || !this.ctx) return;
    const target = this.mutedFlag ? 0 : clamp(this.masterVolume, 0, 1);
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(target, now, 0.02);
  }

  private getNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.noiseBuffer) return this.noiseBuffer;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate));
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  // ── One-shot primitives ──────────────────────────────────────────────────────

  private playNoiseBurst(cfg: NoiseBurstConfig): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    if (!this.reserveOneShot()) return;
    const buffer = this.getNoiseBuffer();
    if (!buffer) {
      this.releaseOneShot();
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = cfg.filterType;
    filter.frequency.value = cfg.frequency;
    filter.Q.value = cfg.q;
    const env = ctx.createGain();

    const now = ctx.currentTime;
    const dur = Math.max(0.01, cfg.durationMs / 1000);
    const attack = Math.min(0.006, dur * 0.25);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(cfg.gain, now + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    source.connect(filter);
    filter.connect(env);
    env.connect(master);
    source.start(now);
    source.stop(now + dur + 0.02);
    source.onended = (): void => {
      source.disconnect();
      filter.disconnect();
      env.disconnect();
      this.releaseOneShot();
    };
  }

  private playTone(cfg: ToneConfig): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    if (!this.reserveOneShot()) return;

    const osc = ctx.createOscillator();
    osc.type = cfg.type;
    const env = ctx.createGain();

    const now = ctx.currentTime;
    const dur = Math.max(0.01, cfg.durationMs / 1000);
    const endFreq = Math.max(1, cfg.endFrequency ?? cfg.frequency);
    osc.frequency.setValueAtTime(Math.max(1, cfg.frequency), now);
    if (endFreq !== cfg.frequency) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, now + dur);
    }
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(cfg.gain, now + Math.min(0.008, dur * 0.3));
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(env);
    env.connect(master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
    osc.onended = (): void => {
      osc.disconnect();
      env.disconnect();
      this.releaseOneShot();
    };
  }

  private canHear(x: number, y: number): boolean {
    const player = getPlayerRef()?.playerPosition;
    if (!player) return true;
    const dx = x - player.x;
    const dy = y - player.y;
    return dx * dx + dy * dy <= SFX_HEARING_RADIUS_SQ;
  }

  private reserveOneShot(): boolean {
    if (this.activeOneShots >= MAX_SIMULTANEOUS_ONE_SHOTS) return false;
    this.activeOneShots++;
    return true;
  }

  private releaseOneShot(): void {
    this.activeOneShots = Math.max(0, this.activeOneShots - 1);
  }

  // ── Weapon / combat cues ─────────────────────────────────────────────────────

  private playGunshot(weaponId: string): void {
    if (!this.ctx) return;
    const def = this.lookupWeapon(weaponId);
    const category = def?.category ?? WeaponCategory.Pistol;
    const jitter = 0.92 + Math.random() * 0.16;

    switch (category) {
      case WeaponCategory.Melee:
        this.playNoiseBurst({
          durationMs: 70,
          filterType: 'lowpass',
          frequency: 420 * jitter,
          q: 0.7,
          gain: 0.28,
        });
        this.playTone({
          type: 'sine',
          frequency: 150,
          endFrequency: 70,
          durationMs: 90,
          gain: 0.2,
        });
        return;
      case WeaponCategory.Shotgun:
        this.playNoiseBurst({
          durationMs: 260,
          filterType: 'lowpass',
          frequency: 950 * jitter,
          q: 0.9,
          gain: 0.5,
        });
        this.playTone({
          type: 'sine',
          frequency: 130,
          endFrequency: 55,
          durationMs: 180,
          gain: 0.32,
        });
        return;
      case WeaponCategory.SMG:
        this.playNoiseBurst({
          durationMs: 55,
          filterType: 'bandpass',
          frequency: 1850 * jitter,
          q: 2.4,
          gain: 0.34,
        });
        return;
      case WeaponCategory.Sniper:
        this.playNoiseBurst({
          durationMs: 200,
          filterType: 'bandpass',
          frequency: 1100 * jitter,
          q: 1.2,
          gain: 0.55,
        });
        this.playTone({
          type: 'sine',
          frequency: 90,
          endFrequency: 40,
          durationMs: 260,
          gain: 0.4,
        });
        return;
      case WeaponCategory.Heavy:
        this.playNoiseBurst({
          durationMs: 120,
          filterType: 'lowpass',
          frequency: 700 * jitter,
          q: 0.8,
          gain: 0.4,
        });
        this.playTone({
          type: 'sawtooth',
          frequency: 180,
          endFrequency: 90,
          durationMs: 200,
          gain: 0.28,
        });
        return;
      case WeaponCategory.Thrown:
        this.playTone({
          type: 'sine',
          frequency: 260,
          endFrequency: 180,
          durationMs: 120,
          gain: 0.16,
        });
        return;
      case WeaponCategory.Rifle:
        this.playNoiseBurst({
          durationMs: 130,
          filterType: 'bandpass',
          frequency: 1500 * jitter,
          q: 1.6,
          gain: 0.42,
        });
        this.playTone({
          type: 'triangle',
          frequency: 240,
          endFrequency: 120,
          durationMs: 90,
          gain: 0.16,
        });
        return;
      case WeaponCategory.Pistol:
      default:
        this.playNoiseBurst({
          durationMs: 110,
          filterType: 'bandpass',
          frequency: 1250 * jitter,
          q: 1.8,
          gain: 0.4,
        });
        this.playTone({
          type: 'triangle',
          frequency: 200,
          endFrequency: 110,
          durationMs: 70,
          gain: 0.14,
        });
        return;
    }
  }

  private playBoom(): void {
    if (!this.ctx) return;
    this.playNoiseBurst({
      durationMs: 620,
      filterType: 'lowpass',
      frequency: 220,
      q: 1.0,
      gain: 0.55,
    });
    this.playTone({ type: 'sine', frequency: 120, endFrequency: 38, durationMs: 520, gain: 0.5 });
  }

  private playFootstep(): void {
    if (!this.ctx) return;
    this.playNoiseBurst({
      durationMs: 32,
      filterType: 'lowpass',
      frequency: 300 * (0.85 + Math.random() * 0.3),
      q: 0.8,
      gain: 0.09,
    });
  }

  private playThud(): void {
    if (!this.ctx) return;
    this.playNoiseBurst({
      durationMs: 90,
      filterType: 'lowpass',
      frequency: 260,
      q: 0.9,
      gain: 0.22,
    });
    this.playTone({ type: 'sine', frequency: 95, endFrequency: 48, durationMs: 130, gain: 0.26 });
  }

  /** Two-click magazine-swap clack. */
  private playReload(): void {
    if (!this.ctx) return;
    this.playNoiseBurst({
      durationMs: 40,
      filterType: 'bandpass',
      frequency: 2600,
      q: 3,
      gain: 0.14,
    });
    window.setTimeout(() => {
      this.playNoiseBurst({
        durationMs: 55,
        filterType: 'bandpass',
        frequency: 1800,
        q: 3,
        gain: 0.16,
      });
    }, 220);
  }

  /** Bright rising blip when a pickup is collected. */
  private playPickup(): void {
    if (!this.ctx) return;
    this.playTone({
      type: 'triangle',
      frequency: 620,
      endFrequency: 1080,
      durationMs: 140,
      gain: 0.16,
    });
    this.playTone({ type: 'sine', frequency: 900, endFrequency: 1400, durationMs: 120, gain: 0.1 });
  }

  /** Tiny high tick confirming a player hit. */
  private playHitTick(): void {
    if (!this.ctx) return;
    this.playTone({
      type: 'square',
      frequency: 1500,
      endFrequency: 1300,
      durationMs: 40,
      gain: 0.06,
    });
  }

  /** Rolling low thunder rumble, intensity-scaled. */
  private playThunder(intensity: number): void {
    if (!this.ctx) return;
    const g = clamp(intensity, 0.2, 1);
    this.playNoiseBurst({
      durationMs: 900 + g * 700,
      filterType: 'lowpass',
      frequency: 160,
      q: 0.6,
      gain: 0.35 * g,
    });
    this.playTone({
      type: 'sine',
      frequency: 70,
      endFrequency: 30,
      durationMs: 1100,
      gain: 0.3 * g,
    });
  }

  // ── Vehicle cues ─────────────────────────────────────────────────────────────

  /** Metallic crash: filtered noise + low thud, intensity-scaled. */
  private playCrash(intensity: number): void {
    if (!this.ctx) return;
    const g = clamp(intensity, 0.15, 1);
    this.playNoiseBurst({
      durationMs: 180,
      filterType: 'bandpass',
      frequency: 2200,
      q: 1.2,
      gain: 0.4 * g,
    });
    this.playNoiseBurst({
      durationMs: 120,
      filterType: 'highpass',
      frequency: 3200,
      q: 0.7,
      gain: 0.2 * g,
    });
    this.playTone({
      type: 'sine',
      frequency: 140,
      endFrequency: 60,
      durationMs: 200,
      gain: 0.3 * g,
    });
  }

  /** Two-tone horn; heavier vehicles honk lower. */
  private playHorn(kind: VehicleKind): void {
    if (!this.ctx) return;
    const low =
      kind === 'bus' ||
      kind === 'truck' ||
      kind === 'delivery' ||
      kind === 'construction' ||
      kind === 'fireTruck';
    const f = low ? 300 : 440;
    this.playTone({ type: 'square', frequency: f, durationMs: 260, gain: 0.12 });
    this.playTone({ type: 'square', frequency: f * 1.25, durationMs: 260, gain: 0.1 });
  }

  /** Car door open/close thunk. */
  private playDoor(open: boolean): void {
    if (!this.ctx) return;
    this.playNoiseBurst({
      durationMs: open ? 60 : 90,
      filterType: 'lowpass',
      frequency: open ? 900 : 500,
      q: 0.8,
      gain: 0.14,
    });
    if (!open) {
      this.playTone({ type: 'sine', frequency: 120, endFrequency: 70, durationMs: 90, gain: 0.14 });
    }
  }

  /** Start or stop the engine synth for the given engine kind. */
  private setEngine(running: boolean, vehicleKind?: VehicleKind): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (!running || vehicleKind === undefined) {
      this.stopEngine();
      return;
    }
    const engineKind = this.engineKindFor(vehicleKind);
    if (engineKind === 'none') {
      // Human-powered (bicycle): no engine.
      this.stopEngine();
      return;
    }
    if (this.engine) return;

    const base = ctx.createOscillator();
    base.type = engineKind === 'motorcycle' ? 'square' : 'sawtooth';
    base.frequency.value = 62;
    const harmonic = ctx.createOscillator();
    harmonic.type = 'sawtooth';
    harmonic.frequency.value = 93;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 3;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.12);

    base.connect(filter);
    harmonic.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    base.start(now);
    harmonic.start(now);
    this.engine = { base, harmonic, filter, gain, kind: engineKind };
    this.engineRev = 0.25;
  }

  /** Fade and stop the engine synth. */
  private stopEngine(): void {
    const engine = this.engine;
    const ctx = this.ctx;
    if (!engine || !ctx) {
      this.engine = null;
      return;
    }
    const now = ctx.currentTime;
    engine.gain.gain.cancelScheduledValues(now);
    engine.gain.gain.setValueAtTime(Math.max(0.0001, engine.gain.gain.value), now);
    engine.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    try {
      engine.base.stop(now + 0.2);
      engine.harmonic.stop(now + 0.2);
    } catch {
      // already stopped
    }
    const { base, harmonic, filter, gain } = engine;
    window.setTimeout(() => {
      base.disconnect();
      harmonic.disconnect();
      filter.disconnect();
      gain.disconnect();
    }, 260);
    this.engine = null;
  }

  /** Map a vehicle kind to its engine audio family. */
  private engineKindFor(kind: VehicleKind): EngineKind {
    switch (kind) {
      case 'motorcycle':
      case 'scooter':
        return 'motorcycle';
      case 'bicycle':
        return 'none';
      case 'sports':
      case 'luxury':
      case 'muscle':
      case 'police':
        return 'sport';
      case 'truck':
      case 'delivery':
      case 'construction':
      case 'bus':
      case 'ambulance':
      case 'fireTruck':
      case 'policeSuv':
        return 'heavy';
      default:
        return 'car';
    }
  }

  /** Start or stop the looping tire-skid noise bed. */
  private setSkid(active: boolean): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (!active) {
      const skid = this.skid;
      if (skid) {
        const now = ctx.currentTime;
        skid.gain.gain.cancelScheduledValues(now);
        skid.gain.gain.setValueAtTime(Math.max(0.0001, skid.gain.gain.value), now);
        skid.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        try {
          skid.source.stop(now + 0.14);
        } catch {
          // already stopped
        }
        const { source, filter, gain } = skid;
        window.setTimeout(() => {
          source.disconnect();
          filter.disconnect();
          gain.disconnect();
        }, 200);
        this.skid = null;
      }
      return;
    }
    if (this.skid) return;

    const buffer = this.getNoiseBuffer();
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 1.4;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(now);
    this.skid = { source, filter, gain };
  }

  /** Start / stop the two-tone police siren by wanted level. */
  private setSiren(level: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (level <= 0) {
      if (this.sirenLoop) {
        this.fadeOutLoop(this.sirenLoop, 0.25);
        this.sirenLoop = null;
      }
      return;
    }
    if (this.sirenLoop) return;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 700;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.13, now + 0.2);

    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    lfo.start(now);
    this.sirenLoop = { oscillators: [osc, lfo], gain };
  }

  private fadeOutLoop(loop: AudioLoop, fadeSeconds: number): void {
    if (!this.ctx) {
      this.stopLoop(loop);
      return;
    }
    const now = this.ctx.currentTime;
    loop.gain.gain.cancelScheduledValues(now);
    loop.gain.gain.setValueAtTime(Math.max(0.0001, loop.gain.gain.value), now);
    loop.gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
    for (const osc of loop.oscillators) {
      try {
        osc.stop(now + fadeSeconds + 0.02);
      } catch {
        // Already stopped — safe to ignore.
      }
    }
    const { gain, oscillators } = loop;
    window.setTimeout(
      () => {
        for (const osc of oscillators) osc.disconnect();
        gain.disconnect();
      },
      Math.ceil((fadeSeconds + 0.05) * 1000),
    );
  }

  private stopLoop(loop: AudioLoop | null): void {
    if (!loop) return;
    for (const osc of loop.oscillators) {
      try {
        osc.stop();
      } catch {
        // Already stopped — safe to ignore.
      }
      osc.disconnect();
    }
    loop.gain.disconnect();
  }

  /** Start / stop a subtle procedural room tone for real interiors. */
  private setInteriorAmbience(kind: InteriorAmbienceKind | null): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    if (kind === this.interiorKind) return;

    if (this.interiorLoop) {
      this.fadeOutLoop(this.interiorLoop, 0.35);
      this.interiorLoop = null;
    }
    this.interiorKind = kind;
    if (!kind) return;

    const freq = kind === 'medical' ? 118 : kind === 'police' ? 84 : kind === 'garage' ? 66 : 142;
    const pulse = kind === 'medical' ? 1.1 : kind === 'garage' ? 0.45 : 0.75;

    const base = ctx.createOscillator();
    base.type = kind === 'garage' ? 'sawtooth' : 'sine';
    base.frequency.value = freq;
    const overtone = ctx.createOscillator();
    overtone.type = 'triangle';
    overtone.frequency.value = freq * 2.01;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = pulse;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = kind === 'medical' ? 7 : 3;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(kind === 'garage' ? 0.055 : 0.04, now + 0.45);

    lfo.connect(lfoGain);
    lfoGain.connect(overtone.frequency);
    base.connect(gain);
    overtone.connect(gain);
    gain.connect(master);
    base.start(now);
    overtone.start(now);
    lfo.start(now);
    this.interiorLoop = { oscillators: [base, overtone, lfo], gain };
  }

  private lookupWeapon(weaponId: string): WeaponDef | undefined {
    return (WEAPONS as Record<string, WeaponDef | undefined>)[weaponId];
  }
}
