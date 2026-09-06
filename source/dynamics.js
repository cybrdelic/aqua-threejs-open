__M["src/dynamics.js"]=(()=>{

const { THREE }=__M["src/gpu.js"];
const { clamp, mulberry32 }=__M["src/math.js"];
/** Rigid-body heave, surge, sway, pitch, roll and yaw. Buoyancy is evaluated at
 * distributed bottom probes; drag uses velocity relative to the local wave flow.
 * Equal-opposite horizontal impulses are returned to the depth-averaged patch.
 * Vertical wake forcing remains an explicit unresolved-flow approximation.
 */
// Closed-course guidance computes a heading, never a prescribed body position.
// It keeps the demonstration hull in the persistent 128 m interaction domain.
function courseHeading(x,z) {
  const a=28,b=11,centerZ=16;
  const theta=Math.atan2((z-centerZ)/b,x/a);
  const look=theta+.28;
  return Math.atan2(-(centerZ+b*Math.sin(look)-z),a*Math.cos(look)-x);
}
function eulerAngularAcceleration(omega,torque,inertia) {
  const angularMomentum=omega.clone().multiply(inertia);
  return torque.clone().sub(omega.clone().cross(angularMomentum)).divide(inertia);
}
class FloatingBody {
  constructor(
    model,
    {
      mass = 1550,
      length = 7,
      width = 2,
      height = 0.9,
      boat = false,
      position = [-16, 0.2, 4],
      velocity = [0, 0, 0],
    } = {},
  ) {
    this.model = model;
    this.mass = mass;
    this.length = length;
    this.width = width;
    this.height = height;
    this.boat = boat;
    this.position = new THREE.Vector3(...position);
    this.velocity = new THREE.Vector3(...velocity);
    this.quaternion = new THREE.Quaternion();
    this.omega = new THREE.Vector3();
    this.inertia = new THREE.Vector3(
      (mass * (height * height + width * width)) / 12,
      (mass * (length * length + width * width)) / 12,
      (mass * (height * height + length * length)) / 12,
    );
    this.points = [];
    for (let x = 0; x < 4; x++)
      for (let z = 0; z < 2; z++)
        this.points.push(
          new THREE.Vector3(
            (x / 3 - 0.5) * length * 0.7,
            -height * 0.43,
            (z - 0.5) * width * 0.64,
          ),
        );
    this.area = (length * width * 0.64) / this.points.length;
    this.forceHistory = [];
    this.wetVolume = 0;
    this.reactionImpulse = [0, 0];
  }
  probes() {
    return this.points.map((p) =>
      p.clone().applyQuaternion(this.quaternion).add(this.position),
    );
  }
  step(dt, samples, patch, time) {
    const force = new THREE.Vector3(0, -this.mass * 9.81, 0),
      torque = new THREE.Vector3();
    this.wetVolume = 0;
    this.reactionImpulse = [0, 0];
    this.points.forEach((local, i) => {
      const arm = local.clone().applyQuaternion(this.quaternion),
        point = arm.clone().add(this.position),
        s = samples[i];
      const depth = clamp(s.height - point.y, 0, this.height),
        volume = depth * this.area;
      this.wetVolume += volume;
      const hydro = new THREE.Vector3(0, 1025 * 9.81 * volume, 0);
      const relative = this.omega
        .clone()
        .cross(arm)
        .add(this.velocity)
        .sub(new THREE.Vector3(...s.velocity));
      const drag = relative
        .clone()
        .multiplyScalar(
          -0.52 *
            1025 *
            this.area *
            (depth / this.height) *
            Math.max(0.25, relative.length()),
        );
      if (this.boat) {
        const localDrag = drag
          .clone()
          .applyQuaternion(this.quaternion.clone().invert());
        localDrag.x *= 0.22;
        localDrag.z *= 0.7;
        drag.copy(localDrag.applyQuaternion(this.quaternion));
      }
      const maxDrag = (this.mass * 12) / this.points.length;
      if (drag.length() > maxDrag) drag.setLength(maxDrag);
      const f = hydro.add(drag);
      force.add(f);
      torque.add(arm.clone().cross(f));
      const impulse = [-f.x * dt, -f.z * dt];
      this.reactionImpulse[0] += impulse[0];
      this.reactionImpulse[1] += impulse[1];
      if (depth > 0) patch.impulse(point.x, point.z, 0, 0.62, 0, impulse);
    });
    if (this.boat) {
      const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(
        this.quaternion,
      );
      const speed = forward.dot(this.velocity);
      const immersed=clamp(this.wetVolume/(this.mass/1025),0,1);
      const thrust = immersed*clamp(1000 + (4.5 - speed) * 1400, -1800, 4800);
      force.addScaledVector(forward, thrust);
      const desired = courseHeading(this.position.x,this.position.z),
        current = Math.atan2(-forward.z, forward.x);
      let error = desired - current;
      error = Math.atan2(Math.sin(error), Math.cos(error));
      torque.y += error * 8500 - this.omega.y * 6500;
      const stern = new THREE.Vector3(-this.length * 0.43, -0.1, 0)
        .applyQuaternion(this.quaternion)
        .add(this.position);
      const bow = new THREE.Vector3(this.length * 0.35, -0.1, 0)
        .applyQuaternion(this.quaternion)
        .add(this.position);
      // Motor momentum is returned as a submerged stern jet, not created freely.
      const motorImpulse=[-forward.x*thrust*dt,-forward.z*thrust*dt];
      patch.impulse(stern.x,stern.z,0,.78,0,motorImpulse);
      this.reactionImpulse[0]+=motorImpulse[0];this.reactionImpulse[1]+=motorImpulse[1];
      const factor = clamp(Math.abs(speed) / 5, 0, 1.7);
      patch.impulse(
        stern.x,
        stern.z,
        -0.014 * factor,
        0.72,
        1.4 * factor * dt,
        [0, 0],
      );
      patch.impulse(
        bow.x,
        bow.z,
        0.014 * factor,
        0.82,
        0.025 * factor * dt,
        [0, 0],
      );
      // Turbulent stern wake, transported by the same persistent patch rather than a painted decal.
      for (const side of [-1, 1]) {
        const sidePoint = new THREE.Vector3(-3.2, 0, side * 0.82)
          .applyQuaternion(this.quaternion)
          .add(this.position);
        patch.impulse(
          sidePoint.x,
          sidePoint.z,
          0.004 * factor,
          0.42,
          2.4 * factor * dt,
        );
      }
    }
    torque.addScaledVector(this.omega, -this.mass * 0.7);
    this.velocity.addScaledVector(force, dt / this.mass);
    this.position.addScaledVector(this.velocity, dt);
    const inv = this.quaternion.clone().invert(),
      localTorque = torque.clone().applyQuaternion(inv);
    localTorque.copy(eulerAngularAcceleration(this.omega.clone().applyQuaternion(inv),localTorque,this.inertia));
    this.omega.addScaledVector(
      localTorque.applyQuaternion(this.quaternion),
      dt,
    );
    const angularSpeed = this.omega.length();
    if (angularSpeed > 4) this.omega.setLength(4);
    if (angularSpeed > 1e-8) {
      const dq = new THREE.Quaternion().setFromAxisAngle(
        this.omega.clone().normalize(),
        this.omega.length() * dt,
      );
      this.quaternion.premultiply(dq).normalize();
    }
    this.model.position.copy(this.position);
    this.model.quaternion.copy(this.quaternion);
    this.model.updateMatrixWorld(true);
    return {
      position: this.position.toArray(),
      velocity: this.velocity.toArray(),
      angularVelocity: this.omega.toArray(),
      wetVolume: this.wetVolume,
      horizontalReactionImpulse: this.reactionImpulse,
    };
  }
}
class Dynamics {
  constructor(world) {
    this.world = world;
    this.bodies = [];
    this.rng = mulberry32(314159);
    this.probeCounter = 0;
  }
  reset(preset) {
    this.rng = mulberry32(314159);
    this.bodies = [];
    this.lastReports = [];
    if (preset.boat)
      this.bodies.push(
        new FloatingBody(this.world.boat, {
          boat: true,
          position: [-17, 0.2, 5],
          velocity: [3.8, 0, 0],
        }),
      );
    if (preset.buoys) {
      this.bodies.push(
        new FloatingBody(this.world.buoyModels[0], {
          mass: 610,
          length: 1.8,
          width: 1.8,
          height: 0.8,
          position: [-4, 0.05, -5],
        }),
      );
      this.bodies.push(
        new FloatingBody(this.world.buoyModels[1], {
          mass: 240,
          length: 1.6,
          width: 1.5,
          height: 0.45,
          position: [1.3, 0.02, -3],
        }),
      );
      this.bodies.push(
        new FloatingBody(this.world.buoyModels[2], {
          mass: 260,
          length: 1.3,
          width: 1.3,
          height: 0.65,
          position: [5.5, 0, -7],
        }),
      );
    }
    for (const b of this.bodies) {
      b.model.position.copy(b.position);
      b.model.quaternion.copy(b.quaternion);
      b.model.updateMatrixWorld(true);
    }
  }
  sampleAndStep(dt, time, ocean, patch, particles, preset) {
    const positions = [],
      ranges = [];
    for (const b of this.bodies) {
      ranges.push(positions.length);
      positions.push(...b.probes().map((v) => [v.x, v.z]));
    }
    const emitStart = positions.length;
    const count = preset.wind > 7 ? 48 : 0;
    for (let i = 0; i < count; i++)
      positions.push([(this.rng() - 0.5) * 108, (this.rng() - 0.5) * 108]);
    if (!positions.length) return;
    const samples = ocean.query(positions, patch.texture, patch.size);
    this.lastReports = [];
    for (let b = 0; b < this.bodies.length; b++) {
      const body = this.bodies[b];
      this.lastReports.push(
        body.step(
          dt,
          samples.slice(ranges[b], ranges[b] + body.points.length),
          patch,
          time,
        ),
      );
    }
    for (let i = emitStart; i < samples.length; i++) {
      const s = samples[i];
      if (
        s.height>preset.hs*.12 && s.velocity[1]>-.25 &&
        s.jacobian < preset.foamThreshold &&
        this.rng() < clamp((preset.foamThreshold - s.jacobian) * 3, 0, 1)
      ) {
        const p = positions[i];
        const count = 2 + Math.floor(this.rng() * 3);
        for (let j = 0; j < count; j++)
          particles.emitSpray(
            [
              p[0] + (this.rng() - 0.5) * 0.6,
              s.height + 0.025,
              p[1] + (this.rng() - 0.5) * 0.6,
            ],
            s.velocity,
            s.normal,
            preset.wind,
            s.jacobian,
          );
      }
    }
    if (preset.boat) {
      const b = this.bodies[0],
        stern = new THREE.Vector3(-3.5, -0.03, 0)
          .applyQuaternion(b.quaternion)
          .add(b.position);
      if (this.rng() < 0.75)
        for (let i = 0; i < 3; i++) {
          const side = this.rng() - 0.5,
            p = stern
              .clone()
              .add(
                new THREE.Vector3(
                  (this.rng() - 0.5) * 0.45,
                  0.02,
                  side * 1.7,
                ).applyQuaternion(b.quaternion),
              );
          particles.emitWake(p.toArray(), b.velocity.toArray(), side);
        }
    }
  }
}



return {courseHeading,eulerAngularAcceleration,FloatingBody,Dynamics};
})();
