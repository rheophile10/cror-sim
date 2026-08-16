/**
 * What happened, in order.
 *
 * This is the seam between the physical layer and the rules layer, and it is the
 * most consequential thing in the conductor feature. `world-sim` knows where
 * everything is; `CROR/sim` knows what the rules require. Neither depends on the
 * other and neither should — so what crosses between them is a **record of acts**.
 *
 * The vocabulary is deliberately `CROR/sim`'s. Its `entities/events.ts` already
 * names exactly what a conductor does — `turned`, `examined`, `point-and-call`,
 * `confirmed`, `coupled`, `handbrake-applied`, `left`, `trailed-through` — and it
 * names them because the rules are written about those acts. A task in this
 * package that completes without emitting one of these is a task the rules layer
 * can never see, so the task set was chosen to fit the vocabulary rather than the
 * other way round.
 *
 * Three things this deliberately does not do:
 *
 * **No verdicts.** An event says the switch was turned at 14:32 by this person
 * standing here. Whether that discharged 104(b) or broke it is not a question
 * this layer has the rulebook to answer, and the moment it starts answering it
 * the two models have merged.
 *
 * **No dependency.** Nothing here imports `CROR/sim`, and `CROR/sim` imports
 * nothing here. The vocabulary matches by agreement, not by a shared type; an
 * adapter living outside both packages can walk this log and produce that
 * package's `WorldEvent`s. That is the cost of keeping them separable and it is
 * worth paying.
 *
 * **No unit conversion.** Distances here are metres, because everything in this
 * package is. `CROR/sim` counts in feet. The adapter converts; neither model
 * relaxes its own rule.
 */

/**
 * The act vocabulary. Every one of these is a thing somebody does that some rule
 * in CROR is written about.
 */
export type EventKind =
  /** 104(b): the switch was turned. */
  | 'turned'
  /** 104(b), 104.1(e), 104.4(b): the points were examined from the ground. */
  | 'examined'
  /** 104(b): the four-step point and call. */
  | 'point-and-call'
  /** 104(b): secured with an approved device. */
  | 'secured'
  /** 104(h), 104(i)(iv): left locked, which is not the same as secured. */
  | 'locked'
  | 'unlocked'
  /** 104.5: a derail placed in or taken off the derailing position. */
  | 'derail-set'
  | 'derail-removed'
  /** 112: a handbrake applied or released on a specific car. */
  | 'handbrake-applied'
  | 'handbrake-released'
  /** Got on, got off, took the seat, left the seat. */
  | 'boarded'
  | 'dismounted'
  | 'took-controls'
  | 'left-controls'
  /** Arrived somewhere on foot. Carries the distance and how long it took. */
  | 'arrived'
  /** 26: a blue signal displayed or removed. */
  | 'blue-signal-displayed'
  | 'blue-signal-removed'
  /** A movement passed a fixed signal; see `signals.ts` for what is recorded. */
  | 'passed-signal'
  /** 104.1(e): trailed through a spring switch. */
  | 'trailed-through'
  /** 113: cars coupled together, or a cut made. */
  | 'coupled'
  | 'uncoupled'
  | 'drawbars-aligned'
  /** The air: hoses, cocks, retainers, and cutting a car's brakes out. */
  | 'hose-connected'
  | 'hose-disconnected'
  | 'angle-cock-opened'
  | 'angle-cock-closed'
  | 'retainer-set'
  /**
   * The release rod pulled: a car's air dumped so it will roll.
   *
   * The most consequential thing a person can do to a standing cut, and the
   * reason 112 counts handbrakes. `detail.handbrake` says whether anything was
   * holding it afterwards.
   */
  | 'bled'
  | 'brake-cut-out'
  | 'brake-cut-in'
  /** The pipe went to atmosphere and the brakes went on by themselves. */
  | 'emergency-brake'
  /**
   * The alerter timed out and applied the brakes. Not an act by anybody — the
   * absence of one, which is what makes it worth recording.
   */
  | 'penalty-brake'
  /** The alerter is asking, and has not been answered yet. */
  | 'alerter-warning'
  /** Somebody answered it. */
  | 'acknowledged'
  /** The pneumatic control switch opened, and later closed. No power between. */
  | 'pcs-open'
  | 'pcs-reset'
  /** 62: the independent set and the reverser centred before leaving the seat. */
  | 'set-and-centred'
  | 'bailed-off'
  /** 14: a horn signal was sounded. The detail carries which one. */
  | 'horn'
  /** The bell, and the lights. 17 and the crossing rules turn on these. */
  | 'bell-on'
  | 'bell-off'
  | 'headlight'
  | 'ditch-lights'
  /**
   * Somebody is standing at a crossing stopping the road by hand.
   *
   * The act that matters when a warning system has failed, because it is then
   * the only thing between a movement and the traffic.
   */
  | 'crossing-protected'
  | 'crossing-released'
  /**
   * An animal was killed — by a movement, or on a road.
   *
   * Recorded because a strike is a reportable thing and because it is the only
   * evidence left: the animal is simply lying there afterwards.
   */
  | 'animal-struck'
  /** A road vehicle was written off, generally by a moose. */
  | 'vehicle-wrecked'
  /**
   * A stretch of railway has gone into the water, or come back out of it.
   *
   * Nothing on a train can see one coming, which is why the rules about
   * washouts are about reporting them and protecting them rather than about
   * observing them.
   */
  | 'washout'
  | 'washout-cleared'
  /** Somebody was hurt. */
  | 'injured'
  /** A task could not be done, and why. Not a rule violation — a physical fact. */
  | 'refused';

export interface WorldEvent {
  kind: EventKind;
  /** Simulated time it happened, seconds since the scene loaded. */
  at: number;
  /** Who did it: a person id. Absent where the railway did it to itself. */
  by?: string;
  /** What it was done to: a node id, a car id, a train id, a signal id. */
  subject?: string;
  /** Where it happened, in track coordinates. Metres. */
  where?: { track: string; at: number };
  /** Anything else the act carries. Kept loose on purpose; the adapter reads it. */
  detail?: Record<string, string | number | boolean>;
}

/**
 * The log.
 *
 * Bounded, because a long session would otherwise grow it without limit and
 * nothing in this package reads the far end of it. A rules layer that wants the
 * whole tour should drain `since()` as it goes.
 */
export class EventLog {
  private events: WorldEvent[] = [];
  /** Events emitted during the most recent step, for a UI to react to. */
  recent: WorldEvent[] = [];

  constructor(private readonly limit = 2000) {}

  emit(event: WorldEvent): WorldEvent {
    this.events.push(event);
    this.recent.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return event;
  }

  /** Called by `World` at the top of each step. */
  beginStep(): void {
    this.recent = [];
  }

  all(): readonly WorldEvent[] {
    return this.events;
  }

  /** Everything at or after a simulated time. */
  since(time: number): WorldEvent[] {
    return this.events.filter((e) => e.at >= time);
  }

  /** Everything one person did, in order. */
  by(personId: string): WorldEvent[] {
    return this.events.filter((e) => e.by === personId);
  }

  /** Everything done to one thing, in order. */
  about(subject: string): WorldEvent[] {
    return this.events.filter((e) => e.subject === subject);
  }

  clear(): void {
    this.events = [];
    this.recent = [];
  }
}
