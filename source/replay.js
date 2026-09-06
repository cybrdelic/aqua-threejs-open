__M["src/replay.js"]=(()=>{

/** Portable fixed-tick input journal. Replays are deterministic on the same
 * backend/settings; this is not a bitwise cross-GPU networking guarantee. */
class ReplayJournal {
  constructor(seed = 91317) {
    this.seed = seed;
    this.reset("lagoon");
  }
  reset(scene) {
    this.scene = scene;
    this.events = [];
    this.cursor = 0;
    this.sequence = 0;
  }
  enqueue(tick, type, payload) {
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new RangeError("A replay tick must be a nonnegative integer");
    if (!["impulse", "flag", "extinction"].includes(type))
      throw new TypeError("Unsupported replay event: " + type);
    const e = {
      tick,
      sequence: this.sequence++,
      type,
      payload: JSON.parse(JSON.stringify(payload)),
    };
    ReplayJournal.validateEvent(e);
    this.events.push(e);
    this.events.sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
    return e;
  }
  consume(tick, apply) {
    while (
      this.cursor < this.events.length &&
      this.events[this.cursor].tick <= tick
    )
      apply(this.events[this.cursor++]);
  }
  export() {
    return {
      format: "cybr-water-replay",
      version: 1,
      seed: this.seed,
      scene: this.scene,
      step: 1 / 60,
      events: JSON.parse(JSON.stringify(this.events)),
    };
  }
  load(doc) {
    if (
      doc?.format !== "cybr-water-replay" ||
      doc.version !== 1 ||
      doc.seed !== this.seed ||
      Math.abs(doc.step - 1 / 60) > 1e-12 ||
      !Array.isArray(doc.events) ||
      doc.events.length > 10000
    )
      throw new TypeError("Invalid or incompatible water replay");
    this.reset(doc.scene);
    for (const e of doc.events) {
      const added = this.enqueue(e.tick, e.type, e.payload);
      if (e.sequence !== undefined) {
        if (!Number.isSafeInteger(e.sequence) || e.sequence < 0)
          throw new TypeError("Invalid event sequence");
        added.sequence = e.sequence;
      }
    }
    if (new Set(this.events.map((e) => e.sequence)).size !== this.events.length)
      throw new TypeError("Duplicate replay sequence");
    this.events.sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
    this.sequence = 1 + Math.max(-1, ...this.events.map((e) => e.sequence));
    return this;
  }
  static validateEvent(e) {
    const p = e.payload;
    if (!p || typeof p !== "object")
      throw new TypeError("Event payload must be an object");
    if (e.type === "impulse") {
      for (const k of ["x", "z", "height", "radius", "foam"])
        if (!Number.isFinite(p[k])) throw new TypeError("Invalid impulse " + k);
      if (
        p.radius < 0.2 ||
        p.radius > 8 ||
        Math.abs(p.height) > 3 ||
        p.foam < 0 ||
        p.foam > 2
      )
        throw new RangeError("Impulse is outside supported bounds");
    }
    if (
      e.type === "flag" &&
      (!["foam", "spray", "rain", "caustics", "reflections", "taa"].includes(
        p.name,
      ) ||
        typeof p.value !== "boolean")
    )
      throw new TypeError("Invalid feature flag");
    if (
      e.type === "extinction" &&
      (!Number.isFinite(p.scale) || p.scale < 0.05 || p.scale > 8)
    )
      throw new RangeError("Invalid extinction scale");
  }
}



return {ReplayJournal};
})();
