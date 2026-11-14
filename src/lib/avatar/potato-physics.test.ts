import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PotatoPhysicsController, triggerHapticPoke } from './potato-physics';

describe('potato-physics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with default neutral state', () => {
    const physics = new PotatoPhysicsController();
    const state = physics.update(0.016);

    expect(state.scale.x).toBeCloseTo(1.0, 1);
    expect(state.scale.y).toBeCloseTo(1.0, 1);
    expect(state.scale.z).toBeCloseTo(1.0, 1);
    expect(state.gaze.x).toBe(0);
    expect(state.gaze.y).toBe(0);
    expect(state.blinkFactor).toBeGreaterThanOrEqual(0);
    expect(state.blinkFactor).toBeLessThanOrEqual(1);
    expect(state.isDragging).toBe(false);
  });

  it('squashes on poke and recovers over time', () => {
    const physics = new PotatoPhysicsController();
    physics.poke(-2.5);

    // Initial state after poke tick should show squash
    const stateSquashed = physics.update(0.02);
    expect(stateSquashed.scale.y).toBeLessThan(1.0);
    expect(stateSquashed.scale.x).toBeGreaterThan(1.0); // Volume preservation
    expect(stateSquashed.isPoked).toBe(true);

    // Simulate 2 seconds of physics damping
    for (let i = 0; i < 120; i++) {
      physics.update(0.016);
    }

    const stateRecovered = physics.update(0.016);
    expect(stateRecovered.scale.y).toBeCloseTo(1.0, 1);
    expect(stateRecovered.isPoked).toBe(false);
  });

  it('tracks drag displacement and releases with spring motion', () => {
    const physics = new PotatoPhysicsController();
    physics.startDrag();
    expect(physics.update(0.016).isDragging).toBe(true);

    // Drag down 60px
    physics.drag(20, 60);
    const dragDownState = physics.update(0.016);
    expect(dragDownState.scale.y).toBeLessThan(1.0);

    // Release drag
    physics.releaseDrag();
    expect(physics.update(0.016).isDragging).toBe(false);
  });

  it('tracks gaze coordinates smoothly towards target', () => {
    const physics = new PotatoPhysicsController();
    physics.setTargetGaze(0.8, -0.6);

    // Step a few frames
    for (let i = 0; i < 20; i++) {
      physics.update(0.016);
    }

    const state = physics.update(0.016);
    expect(state.gaze.x).toBeGreaterThan(0.5);
    expect(state.gaze.y).toBeLessThan(-0.3);
  });

  it('triggers haptic vibration safely', () => {
    const vibrateMock = vi.fn();
    Object.defineProperty(navigator, 'vibrate', {
      value: vibrateMock,
      configurable: true,
      writable: true,
    });

    triggerHapticPoke();
    expect(vibrateMock).toHaveBeenCalledWith([15]);
  });
});
