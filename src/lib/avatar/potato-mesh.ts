import * as THREE from 'three';

export type VisemeName = 'rest' | 'happy' | 'open' | 'pursed' | 'smirk';

export interface PotatoAvatar3D {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  leftEyeGroup: THREE.Group;
  rightEyeGroup: THREE.Group;
  leftPupil: THREE.Mesh;
  rightPupil: THREE.Mesh;
  mouthMesh: THREE.Mesh;
  setViseme(name: VisemeName, influence: number): void;
  resetVisemes(): void;
  setBlink(blinkFactor: number): void; // 0 = open, 1 = closed
  setGaze(x: number, y: number): void; // -1 to 1
  dispose(): void;
}

/**
 * Procedural pseudo-random 3D noise for organic potato lumps and eye dimples.
 */
function potatoNoise(x: number, y: number, z: number): number {
  // Harmonic low and mid frequency organic variations
  const n1 = Math.sin(x * 2.3 + y * 1.9) * Math.cos(y * 2.1 + z * 2.4) * 0.055;
  const n2 = Math.sin(x * 4.7 + z * 3.8) * Math.cos(z * 4.3 + x * 3.1) * 0.028;
  const n3 = Math.cos(x * 7.1 + y * 5.9) * Math.sin(y * 6.3 + z * 6.7) * 0.012;

  // Lumpy bottom asymmetry
  const bottomLump = y < -0.3 ? Math.sin((y + 0.3) * 3.5) * 0.035 : 0;

  // Eye dimples: subtle organic indents where eyes sit (x approx +-0.36, y approx 0.18, z approx 0.92)
  const leftEyeDist = Math.hypot(x + 0.36, y - 0.18, z - 0.92);
  const rightEyeDist = Math.hypot(x - 0.36, y - 0.18, z - 0.92);
  const dimpleLeft = Math.max(0, 0.26 - leftEyeDist) * -0.11;
  const dimpleRight = Math.max(0, 0.26 - rightEyeDist) * -0.11;

  return n1 + n2 + n3 + bottomLump + dimpleLeft + dimpleRight;
}

/**
 * Generate a procedural bump map canvas texture for subtle skin pores and micro-bumps.
 */
function createPotatoBumpTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return null;
  try {
    const canvas = document.createElement('canvas');
    if (typeof canvas.getContext !== 'function') return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Mid-gray neutral base
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 128, 128);

    // Micro-pores and subtle freckles
    for (let i = 0; i < 450; i++) {
      const px = Math.random() * 128;
      const py = Math.random() * 128;
      const r = Math.random() * 1.4 + 0.4;
      const shade = Math.floor(Math.random() * 55 + 50); // subtle darker pits
      ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 3);
    return texture;
  } catch {
    return null;
  }
}

/**
 * Build vertices for the mouth ribbon curve.
 * N segments -> (N + 1) * 2 vertices (top & bottom edges).
 */
function generateMouthPositions(viseme: VisemeName): Float32Array {
  const segments = 16;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  let ptr = 0;

  for (let i = 0; i <= segments; i++) {
    const t = -1 + 2 * (i / segments); // -1 to 1

    let x = 0;
    let yMid = -0.22;
    let z = 1.01 - 0.08 * (t * t);
    let halfThickness = 0.016;

    switch (viseme) {
      case 'happy': {
        // Wide joyful smile with lifted corners
        x = t * 0.28;
        yMid = -0.21 + 0.08 * (t * t) - 0.02;
        halfThickness = 0.018;
        break;
      }
      case 'open': {
        // Open talking mouth with an open oval gap
        x = t * 0.22;
        yMid = -0.22;
        halfThickness = 0.018 + 0.055 * (1 - t * t); // opens wide in center
        break;
      }
      case 'pursed': {
        // Pursed thinking mouth: narrow compact circle/line
        x = t * 0.12;
        yMid = -0.22;
        halfThickness = 0.014;
        break;
      }
      case 'smirk': {
        // Asymmetric wry smirk: left side raised, right side neutral
        x = t * 0.23;
        yMid = -0.22 - 0.045 * t + 0.02 * (t * t);
        halfThickness = 0.017;
        break;
      }
      case 'rest':
      default: {
        // Gentle resting smile
        x = t * 0.23;
        yMid = -0.22 + 0.035 * (t * t) - 0.01;
        halfThickness = 0.016;
        break;
      }
    }

    // Top vertex
    positions[ptr++] = x;
    positions[ptr++] = yMid + halfThickness;
    positions[ptr++] = z;

    // Bottom vertex
    positions[ptr++] = x;
    positions[ptr++] = yMid - halfThickness;
    positions[ptr++] = z;
  }

  return positions;
}

/**
 * Builds the complete 3D Potato avatar character.
 */
export function createPotatoAvatar(): PotatoAvatar3D {
  const group = new THREE.Group();

  // 1. Procedural 3D Potato Body Mesh
  const bodyGeo = new THREE.SphereGeometry(1, 48, 36);
  const posAttr = bodyGeo.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i);

    // Subtle procedural asymmetry:
    // Elongate along Y (1.22x), bulge along Z (1.08x), slightly narrow X (0.98x)
    v.x *= 0.98;
    v.y *= 1.22;
    v.z *= 1.08;

    // Procedural noise distortion on vertices for natural lumps and eye dimples
    const normal = v.clone().normalize();
    const displacement = potatoNoise(v.x, v.y, v.z);
    v.addScaledVector(normal, displacement);

    posAttr.setXYZ(i, v.x, v.y, v.z);
  }
  bodyGeo.computeVertexNormals();

  const bumpTex = createPotatoBumpTexture();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#c89658'), // Warm earthy golden-brown
    roughness: 0.8,
    metalness: 0.04,
    bumpMap: bumpTex,
    bumpScale: 0.014,
  });

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  // 2. Cute Cartoon 3D Eyes
  // Eye Materials
  const eyeWhiteMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.18,
    metalness: 0.02,
  });

  const pupilMat = new THREE.MeshStandardMaterial({
    color: 0x140e0b, // Glossy obsidian pupil
    roughness: 0.05,
    metalness: 0.12,
  });

  const glintMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
  });

  const eyeWhiteGeo = new THREE.SphereGeometry(0.18, 24, 20);
  eyeWhiteGeo.scale(1.0, 1.0, 0.65); // Flattened dome

  const pupilGeo = new THREE.SphereGeometry(0.09, 20, 16);
  pupilGeo.scale(1.0, 1.0, 0.4);

  const glintGeo = new THREE.SphereGeometry(0.03, 12, 10);
  const glintSmallGeo = new THREE.SphereGeometry(0.015, 10, 8);

  // Left Eye Assembly
  const leftEyeGroup = new THREE.Group();
  leftEyeGroup.position.set(-0.35, 0.19, 0.92);
  leftEyeGroup.rotation.y = -0.12;

  const leftWhite = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
  leftEyeGroup.add(leftWhite);

  const leftPupil = new THREE.Mesh(pupilGeo, pupilMat);
  leftPupil.position.set(0, 0, 0.09);

  const leftGlint1 = new THREE.Mesh(glintGeo, glintMat);
  leftGlint1.position.set(0.032, 0.032, 0.04);
  leftPupil.add(leftGlint1);

  const leftGlint2 = new THREE.Mesh(glintSmallGeo, glintMat);
  leftGlint2.position.set(-0.024, -0.024, 0.035);
  leftPupil.add(leftGlint2);

  leftEyeGroup.add(leftPupil);
  group.add(leftEyeGroup);

  // Right Eye Assembly
  const rightEyeGroup = new THREE.Group();
  rightEyeGroup.position.set(0.35, 0.19, 0.92);
  rightEyeGroup.rotation.y = 0.12;

  const rightWhite = new THREE.Mesh(eyeWhiteGeo.clone(), eyeWhiteMat);
  rightEyeGroup.add(rightWhite);

  const rightPupil = new THREE.Mesh(pupilGeo.clone(), pupilMat);
  rightPupil.position.set(0, 0, 0.09);

  const rightGlint1 = new THREE.Mesh(glintGeo.clone(), glintMat);
  rightGlint1.position.set(0.032, 0.032, 0.04);
  rightPupil.add(rightGlint1);

  const rightGlint2 = new THREE.Mesh(glintSmallGeo.clone(), glintMat);
  rightGlint2.position.set(-0.024, -0.024, 0.035);
  rightPupil.add(rightGlint2);

  rightEyeGroup.add(rightPupil);
  group.add(rightEyeGroup);

  // 3. Cute Blushing Cheeks
  const blushMat = new THREE.MeshBasicMaterial({
    color: 0xf4948a,
    transparent: true,
    opacity: 0.38,
  });
  const blushGeo = new THREE.CircleGeometry(0.12, 20);

  const leftBlush = new THREE.Mesh(blushGeo, blushMat);
  leftBlush.position.set(-0.48, 0.04, 0.84);
  leftBlush.rotation.y = -0.35;
  group.add(leftBlush);

  const rightBlush = new THREE.Mesh(blushGeo.clone(), blushMat);
  rightBlush.position.set(0.48, 0.04, 0.84);
  rightBlush.rotation.y = 0.35;
  group.add(rightBlush);

  // 4. Procedural Mouth Ribbon with Viseme Morph Targets
  const segments = 16;
  const mouthGeo = new THREE.BufferGeometry();
  const restPositions = generateMouthPositions('rest');
  mouthGeo.setAttribute('position', new THREE.BufferAttribute(restPositions, 3));

  // Construct ribbon indices (quads across segments)
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const top1 = i * 2;
    const bot1 = i * 2 + 1;
    const top2 = (i + 1) * 2;
    const bot2 = (i + 1) * 2 + 1;
    indices.push(top1, bot1, top2);
    indices.push(bot1, bot2, top2);
  }
  mouthGeo.setIndex(indices);

  // Morph targets: happy, open, pursed, smirk
  mouthGeo.morphAttributes.position = [
    new THREE.BufferAttribute(generateMouthPositions('happy'), 3),
    new THREE.BufferAttribute(generateMouthPositions('open'), 3),
    new THREE.BufferAttribute(generateMouthPositions('pursed'), 3),
    new THREE.BufferAttribute(generateMouthPositions('smirk'), 3),
  ];
  mouthGeo.computeVertexNormals();

  const mouthMat = new THREE.MeshStandardMaterial({
    color: 0x4a2a16, // Warm dark brown mouth line
    roughness: 0.5,
    side: THREE.DoubleSide,
  });

  const mouthMesh = new THREE.Mesh(mouthGeo, mouthMat);
  mouthMesh.morphTargetDictionary = {
    happy: 0,
    open: 1,
    pursed: 2,
    smirk: 3,
  };
  mouthMesh.morphTargetInfluences = [0, 0, 0, 0];
  group.add(mouthMesh);

  // Viseme mapping controller
  const setViseme = (name: VisemeName, influence: number) => {
    if (!mouthMesh.morphTargetInfluences) return;
    const clamped = Math.max(0, Math.min(1, influence));
    if (name === 'rest') {
      // Rest smile corresponds to base positions (all morph influences 0)
      for (let i = 0; i < mouthMesh.morphTargetInfluences.length; i++) {
        mouthMesh.morphTargetInfluences[i] = 0;
      }
      return;
    }
    const idx = mouthMesh.morphTargetDictionary?.[name];
    if (idx !== undefined) {
      mouthMesh.morphTargetInfluences[idx] = clamped;
    }
  };

  const resetVisemes = () => {
    if (!mouthMesh.morphTargetInfluences) return;
    for (let i = 0; i < mouthMesh.morphTargetInfluences.length; i++) {
      mouthMesh.morphTargetInfluences[i] = 0;
    }
  };

  // Blinking: scale eye groups Y from 1.0 (open) down to 0.05 (closed)
  const setBlink = (blinkFactor: number) => {
    const clamped = Math.max(0, Math.min(1, blinkFactor));
    const scaleY = Math.max(0.05, 1.0 - clamped * 0.95);
    leftEyeGroup.scale.y = scaleY;
    rightEyeGroup.scale.y = scaleY;
  };

  // Gaze: offset pupils smoothly (-1 to 1)
  const setGaze = (x: number, y: number) => {
    const maxOffset = 0.05;
    const ox = Math.max(-1, Math.min(1, x)) * maxOffset;
    const oy = Math.max(-1, Math.min(1, y)) * maxOffset;
    leftPupil.position.x = ox;
    leftPupil.position.y = oy;
    rightPupil.position.x = ox;
    rightPupil.position.y = oy;
  };

  // Cleanup helper
  const dispose = () => {
    bodyGeo.dispose();
    bodyMat.dispose();
    if (bumpTex) bumpTex.dispose();

    eyeWhiteGeo.dispose();
    eyeWhiteMat.dispose();
    pupilGeo.dispose();
    pupilMat.dispose();
    glintGeo.dispose();
    glintSmallGeo.dispose();
    glintMat.dispose();

    blushGeo.dispose();
    blushMat.dispose();

    mouthGeo.dispose();
    mouthMat.dispose();
  };

  return {
    group,
    bodyMesh,
    leftEyeGroup,
    rightEyeGroup,
    leftPupil,
    rightPupil,
    mouthMesh,
    setViseme,
    resetVisemes,
    setBlink,
    setGaze,
    dispose,
  };
}
