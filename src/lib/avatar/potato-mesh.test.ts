import { describe, it, expect } from 'vitest';
import { createPotatoAvatar } from './potato-mesh';

describe('potato-mesh', () => {
  it('creates potato avatar with all components and morph targets', () => {
    const avatar = createPotatoAvatar();

    expect(avatar.group).toBeDefined();
    expect(avatar.bodyMesh).toBeDefined();
    expect(avatar.leftEyeGroup).toBeDefined();
    expect(avatar.rightEyeGroup).toBeDefined();
    expect(avatar.mouthMesh).toBeDefined();

    // Check morph target dictionary
    expect(avatar.mouthMesh.morphTargetDictionary).toHaveProperty('happy');
    expect(avatar.mouthMesh.morphTargetDictionary).toHaveProperty('open');
    expect(avatar.mouthMesh.morphTargetDictionary).toHaveProperty('pursed');
    expect(avatar.mouthMesh.morphTargetDictionary).toHaveProperty('smirk');

    // Test setting viseme
    avatar.setViseme('happy', 0.8);
    const happyIdx = avatar.mouthMesh.morphTargetDictionary?.happy;
    expect(avatar.mouthMesh.morphTargetInfluences?.[happyIdx!]).toBeCloseTo(0.8);

    // Test blink
    avatar.setBlink(1.0);
    expect(avatar.leftEyeGroup.scale.y).toBeCloseTo(0.05);

    avatar.setBlink(0);
    expect(avatar.leftEyeGroup.scale.y).toBeCloseTo(1.0);

    // Test gaze
    avatar.setGaze(0.5, -0.5);
    expect(avatar.leftPupil.position.x).toBeGreaterThan(0);
    expect(avatar.leftPupil.position.y).toBeLessThan(0);

    // Cleanup
    avatar.dispose();
  });
});
