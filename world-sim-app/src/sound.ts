/**
 * The horn and the bell, made audible.
 *
 * Lives in the app rather than in `world-sim` because the library has no DOM
 * dependency and should not acquire one. The library says *whether* a horn is
 * sounding this instant — `hornSounding(train.lights)`, which knows the Rule 14
 * pattern and the silences in it — and this file turns that boolean into a
 * noise. Nothing about the pattern is decided here.
 *
 * Synthesised rather than sampled, for one practical reason: the artifact has to
 * be self-contained, and a recording of a K5LA is a megabyte. What is here is a
 * five-note chord of detuned sawtooths through a low-pass, which is close enough
 * to a five-chime horn to be recognisable and is about forty lines.
 *
 * Browsers will not start audio without a gesture, so the context is created
 * lazily on the first click and everything before that is silently dropped.
 */

/** A five-chime horn, roughly a K5LA: a minor chord with a major sixth on top. */
const CHIME_HZ = [311.1, 370.0, 440.0, 523.3, 622.3];

export class Sound {
  private ctx: AudioContext | null = null;
  private hornGain: GainNode | null = null;
  private master: GainNode | null = null;
  private bellTimer = 0;
  private wasSounding = false;
  private alertGain: GainNode | null = null;
  private alertOsc: OscillatorNode | null = null;
  private enabled = true;

  /**
   * Called from a user gesture. Before this there is no audio context at all,
   * which is what the autoplay policy requires rather than a nicety.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    // The horn runs continuously and is gated by its gain, because starting and
    // stopping oscillators for every blast clicks audibly.
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    gain.connect(filter);
    filter.connect(this.master);
    for (const hz of CHIME_HZ) {
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz;
        osc.detune.value = detune;
        const voice = ctx.createGain();
        // The low chimes carry; the high ones are what make it cut.
        voice.gain.value = 0.11;
        osc.connect(voice);
        voice.connect(gain);
        osc.start();
      }
    }
    this.hornGain = gain;

    // The alerter: a plain electronic warble, deliberately unpleasant and
    // deliberately nothing like the horn. It is the one sound in the cab that
    // means *you* have stopped doing something.
    const alert = ctx.createGain();
    alert.gain.value = 0;
    alert.connect(this.master);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1050;
    const shaper = ctx.createGain();
    shaper.gain.value = 0.09;
    osc.connect(shaper);
    shaper.connect(alert);
    osc.start();
    this.alertGain = alert;
    this.alertOsc = osc;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
  }

  get on(): boolean {
    return this.enabled;
  }

  /**
   * Follow the simulation. `sounding` comes from `hornSounding`, so the gaps
   * between the elements of a Rule 14 signal are already in it.
   *
   * `dt` is simulated seconds, so the bell keeps its cadence relative to the
   * horn when the rate multiplier is turned up. That is arguably wrong — a real
   * bell rings in real time — but a bell that fell out of step with a horn
   * sounding four times too fast would be worse.
   */
  update(
    sounding: boolean,
    bell: boolean,
    dt: number,
    /** 'quiet' | 'asking' | 'penalty' — what the alerter is doing. */
    alerter: string = 'quiet',
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.hornGain) return;
    const now = ctx.currentTime;

    // Asking: an intermittent beep. Penalty: continuous, because by then it is
    // not asking any more, it is telling you what it has done.
    if (this.alertGain && this.alertOsc) {
      const on =
        alerter === 'penalty' ? true : alerter === 'asking' ? Math.floor(now * 2) % 2 === 0 : false;
      this.alertOsc.frequency.setValueAtTime(alerter === 'penalty' ? 760 : 1050, now);
      this.alertGain.gain.setTargetAtTime(on ? 0.5 : 0, now, 0.01);
    }

    if (sounding !== this.wasSounding) {
      // A short ramp rather than a step: an air horn takes a moment to come up
      // and a moment to die, and a square gate on a sawtooth chord clicks.
      this.hornGain.gain.cancelScheduledValues(now);
      this.hornGain.gain.setValueAtTime(this.hornGain.gain.value, now);
      this.hornGain.gain.linearRampToValueAtTime(sounding ? 0.42 : 0, now + (sounding ? 0.05 : 0.09));
      this.wasSounding = sounding;
    }

    if (!bell) {
      this.bellTimer = 0;
      return;
    }
    // About 80 strikes a minute, which is roughly a locomotive bell.
    this.bellTimer -= dt;
    if (this.bellTimer <= 0) {
      this.bellTimer = 0.75;
      this.strike();
    }
  }

  /** One bell strike: two inharmonic partials with a fast decay. */
  private strike(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(0.3, now + 0.004);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    out.connect(this.master);
    // Inharmonic, which is what makes struck metal sound like metal rather than
    // like a flute.
    for (const [hz, level] of [[694, 1], [1042, 0.55], [1875, 0.22], [2510, 0.12]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const voice = ctx.createGain();
      voice.gain.value = level;
      osc.connect(voice);
      voice.connect(out);
      osc.start(now);
      osc.stop(now + 1);
    }
  }
}
