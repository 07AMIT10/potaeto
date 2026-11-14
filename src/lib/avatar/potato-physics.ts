/**
 * Potato Physics Simulation Engine
 *
 * Implements:
 * 1. Damped harmonic spring-mass simulation for squash-and-stretch wobble on pointer/touch drag & poke.
 * 2. Gaze tracking: pupils smoothly track pointer/touch coordinates across the screen with spring damping.
 * 3. Natural blinking timer (every 3–5 seconds) and subtle idle breathing squash/stretch (Y ± 2%).
 * 4. Haptic vibration trigger (`navigator.vibrate?.([15])`) on poke/touch.
 */

export interface PotatoPhysicsState {
  scale: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  gaze: { x: number; y: number };
  blinkFactor: number;
  isDragging: boolean;
  isPoked: boolean;
}

/**
 * Trigger subtle haptic vibration on mobile devices / supported platforms.
 */
export function triggerHapticPoke(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([15]);
    } catch {
      // Ignore vibration error on restricted contexts
    }
  }
}

export class PotatoPhysicsController {
  // Spring-mass parameters
  private stiffness = 160;
  private damping = 11;

  // Squash state (Y axis displacement and velocity)
  private squashY = 0;
  private squashVelocityY = 0;

  // Wobble tilt state (rotation around Z and X axes)
  private tiltZ = 0;
  private tiltVelocityZ = 0;
  private tiltX = 0;
  private tiltVelocityX = 0;

  // Gaze tracking state (with spring damping)
  private targetGazeX = 0;
  private targetGazeY = 0;
  private currentGazeX = 0;
  private currentGazeY = 0;
  private gazeVelocityX = 0;
  private gazeVelocityY = 0;
  private gazeStiffness = 110;
  private gazeDamping = 14;

  // Blinking timer state
  private blinkTimer = 3.5;
  private isBlinking = false;
  private blinkProgress = 0;
  private readonly blinkDuration = 0.16; // 160ms blink

  // Breathing state
  private breathingTime = 0;
  private readonly breathingFrequency = 1.96; // ~3.2s period

  // Interaction flags
  private dragging = false;
  private poked = false;
  private pokeDecayTimer = 0;

  constructor() {
    this.resetBlinkTimer();
  }

  private resetBlinkTimer(doubleBlink = false): void {
    if (doubleBlink) {
      this.blinkTimer = 0.22; // Quick secondary blink
    } else {
      // Random interval between 3.0 and 5.0 seconds
      this.blinkTimer = 3.0 + Math.random() * 2.0;
    }
  }

  /**
   * Register a touch/click poke impulse on the potato.
   */
  poke(forceY = -2.4): void {
    triggerHapticPoke();
    this.squashVelocityY = forceY;
    // Add subtle organic asymmetric tilt on poke
    this.tiltVelocityZ += (Math.random() - 0.5) * 1.5;
    this.tiltVelocityX += (Math.random() - 0.5) * 0.8;
    this.poked = true;
    this.pokeDecayTimer = 0.25;
  }

  /**
   * Start dragging the potato.
   */
  startDrag(): void {
    this.dragging = true;
    triggerHapticPoke();
  }

  /**
   * Update drag displacement in pixels/viewport units.
   */
  drag(deltaX: number, deltaY: number): void {
    if (!this.dragging) return;

    // Dragging down compresses Y, dragging up stretches Y
    const targetSquash = -deltaY * 0.0035;
    this.squashY = Math.max(-0.45, Math.min(0.55, targetSquash));

    // Dragging horizontally tilts sideways
    this.tiltZ = Math.max(-0.4, Math.min(0.4, -deltaX * 0.0025));
    this.tiltX = Math.max(-0.3, Math.min(0.3, deltaY * 0.0015));

    // Reset velocities during direct drag
    this.squashVelocityY = 0;
    this.tiltVelocityZ = 0;
    this.tiltVelocityX = 0;
  }

  /**
   * Release drag and let the spring-mass system oscillate to rest.
   */
  releaseDrag(releaseVelocityY = 0): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.squashVelocityY = releaseVelocityY;
  }

  /**
   * Set target gaze coordinate (-1 to 1).
   */
  setTargetGaze(x: number, y: number): void {
    this.targetGazeX = Math.max(-1, Math.min(1, x));
    this.targetGazeY = Math.max(-1, Math.min(1, y));
  }

  /**
   * Advance simulation by deltaTime (in seconds).
   */
  update(deltaTime: number): PotatoPhysicsState {
    const dt = Math.max(0.001, Math.min(0.05, deltaTime));

    // 1. Spring-mass squash & stretch simulation (when not dragging)
    if (!this.dragging) {
      const springForceY = -this.stiffness * this.squashY;
      const dampingForceY = -this.damping * this.squashVelocityY;
      const accelY = springForceY + dampingForceY;

      this.squashVelocityY += accelY * dt;
      this.squashY += this.squashVelocityY * dt;

      // Tilt Z spring
      const springForceZ = -this.stiffness * 0.8 * this.tiltZ;
      const dampingForceZ = -this.damping * 0.9 * this.tiltVelocityZ;
      this.tiltVelocityZ += (springForceZ + dampingForceZ) * dt;
      this.tiltZ += this.tiltVelocityZ * dt;

      // Tilt X spring
      const springForceX = -this.stiffness * 0.8 * this.tiltX;
      const dampingForceX = -this.damping * 0.9 * this.tiltVelocityX;
      this.tiltVelocityX += (springForceX + dampingForceX) * dt;
      this.tiltX += this.tiltVelocityX * dt;
    }

    // 2. Idle breathing simulation (Y ± 2%)
    this.breathingTime += dt;
    const breathCycle = Math.sin(this.breathingTime * this.breathingFrequency);
    const breathY = breathCycle * 0.02; // ±2% breathing
    const breathXZ = -breathY * 0.5; // Slight volume preservation

    // Combined scale calculation
    const currentSquashY = Math.max(-0.6, Math.min(0.8, this.squashY));
    const totalScaleY = Math.max(0.4, (1.0 + currentSquashY) * (1.0 + breathY));
    // Volume preservation: when Y squashes, X and Z stretch
    const stretchXZ = 1.0 - currentSquashY * 0.45;
    const totalScaleX = Math.max(0.5, stretchXZ * (1.0 + breathXZ));
    const totalScaleZ = Math.max(0.5, stretchXZ * (1.0 + breathXZ));

    // 3. Smooth gaze tracking spring
    const gazeAccelX = -this.gazeStiffness * (this.currentGazeX - this.targetGazeX) - this.gazeDamping * this.gazeVelocityX;
    this.gazeVelocityX += gazeAccelX * dt;
    this.currentGazeX += this.gazeVelocityX * dt;

    const gazeAccelY = -this.gazeStiffness * (this.currentGazeY - this.targetGazeY) - this.gazeDamping * this.gazeVelocityY;
    this.gazeVelocityY += gazeAccelY * dt;
    this.currentGazeY += this.gazeVelocityY * dt;

    // 4. Natural blinking timer (3-5s timer + 160ms animation)
    let blinkFactor = 0;
    if (this.isBlinking) {
      this.blinkProgress += dt;
      if (this.blinkProgress >= this.blinkDuration) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        // 18% chance of double-blink
        this.resetBlinkTimer(Math.random() < 0.18);
      } else {
        // Smooth sine arch 0 -> 1 -> 0
        blinkFactor = Math.sin((this.blinkProgress / this.blinkDuration) * Math.PI);
      }
    } else {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.isBlinking = true;
        this.blinkProgress = 0;
      }
    }

    // 5. Poke state decay
    if (this.pokeDecayTimer > 0) {
      this.pokeDecayTimer -= dt;
      if (this.pokeDecayTimer <= 0) {
        this.poked = false;
      }
    }

    return {
      scale: {
        x: totalScaleX,
        y: totalScaleY,
        z: totalScaleZ,
      },
      rotation: {
        x: this.tiltX,
        y: this.currentGazeX * 0.15, // Head tilts slightly with gaze
        z: this.tiltZ,
      },
      gaze: {
        x: Math.max(-1, Math.min(1, this.currentGazeX)),
        y: Math.max(-1, Math.min(1, this.currentGazeY)),
      },
      blinkFactor: Math.max(0, Math.min(1, blinkFactor)),
      isDragging: this.dragging,
      isPoked: this.poked,
    };
  }
}
