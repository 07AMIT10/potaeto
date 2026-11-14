'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { createPotatoAvatar, type PotatoAvatar3D, type VisemeName } from '@/lib/avatar/potato-mesh';
import { PotatoPhysicsController, triggerHapticPoke } from '@/lib/avatar/potato-physics';
import { AvatarFace } from '@/components/AvatarFace';
import type { ExpressionState } from '@/lib/expressions/types';

export interface Potato3DCanvasProps {
  expression?: ExpressionState;
  mouthOpenOverride?: number;
  isTalking?: boolean;
  className?: string;
  width?: number | string;
  height?: number | string;
  interactive?: boolean;
  onPoke?: () => void;
}

function checkWebGLSupport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl') || canvas.getContext('webgl2'))
    );
  } catch {
    return false;
  }
}

function createContactShadowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return null;
  try {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(45, 28, 16, 0.4)');
    grad.addColorStop(0.55, 'rgba(45, 28, 16, 0.14)');
    grad.addColorStop(1, 'rgba(45, 28, 16, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    return new THREE.CanvasTexture(c);
  } catch {
    return null;
  }
}

export function Potato3DCanvas({
  expression = 'idle',
  mouthOpenOverride,
  isTalking = false,
  className = '',
  width = '100%',
  height = 360,
  interactive = true,
  onPoke,
}: Potato3DCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasWebGL, setHasWebGL] = useState(() => checkWebGLSupport());

  // References for live props inside the render loop
  const propsRef = useRef({ expression, mouthOpenOverride, isTalking, onPoke });
  propsRef.current = { expression, mouthOpenOverride, isTalking, onPoke };

  useEffect(() => {
    if (!checkWebGLSupport()) {
      setHasWebGL(false);
    }
  }, []);

  useEffect(() => {
    if (!hasWebGL) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setHasWebGL(false);
      return;
    }

    renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 3.8);

    // Studio Lighting
    const ambientLight = new THREE.AmbientLight(0xfff6ea, 0.8);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xfffaee, 1.35);
    keyLight.position.set(2.8, 3.6, 3.5);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x98c6ff, 0.7);
    rimLight.position.set(-2.8, 1.8, -2.5);
    scene.add(rimLight);

    const underBounceLight = new THREE.PointLight(0xffdfb8, 0.4, 6);
    underBounceLight.position.set(0, -1.8, 1.2);
    scene.add(underBounceLight);

    // Contact shadow plane
    const shadowTex = createContactShadowTexture();
    const shadowGeo = new THREE.PlaneGeometry(2.3, 2.3);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = -1.25;
    scene.add(shadowMesh);

    // 3D Potato Avatar
    let avatar: PotatoAvatar3D;
    try {
      avatar = createPotatoAvatar();
      scene.add(avatar.group);
    } catch {
      setHasWebGL(false);
      renderer.dispose();
      return;
    }

    // Physics Simulation Engine
    const physics = new PotatoPhysicsController();

    // Resize handling
    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(rect.width, 100);
      const h = Math.max(rect.height || (typeof height === 'number' ? height : 360), 100);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    updateSize();

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });
    resizeObserver.observe(container);

    // Pointer interaction variables
    let isPointerDown = false;
    let startX = 0;
    let startY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (!interactive) return;
      isPointerDown = true;
      startX = e.clientX;
      startY = e.clientY;
      physics.startDrag();
      physics.poke(-2.5);
      triggerHapticPoke();
      propsRef.current.onPoke?.();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture fallback
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      // Gaze coordinates (-1 to 1)
      const gx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const gy = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      physics.setTargetGaze(gx, gy);

      if (isPointerDown) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        physics.drag(dx, dy);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (isPointerDown) {
        isPointerDown = false;
        physics.releaseDrag();
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // Fallback
        }
      }
    };

    // Global window gaze tracking when pointer hovers anywhere
    const onWindowPointerMove = (e: MouseEvent) => {
      if (isPointerDown) return;
      const rect = container.getBoundingClientRect();
      const gx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const gy = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      physics.setTargetGaze(gx, gy);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', onWindowPointerMove, { passive: true });
    }

    // Animation Render Loop
    let animId: number;
    const clock = new THREE.Clock();

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      const state = physics.update(dt);

      // Apply physics state
      avatar.group.scale.set(state.scale.x, state.scale.y, state.scale.z);
      avatar.group.rotation.set(state.rotation.x, state.rotation.y, state.rotation.z);
      avatar.setBlink(state.blinkFactor);
      avatar.setGaze(state.gaze.x, state.gaze.y);

      // Shadow adjusts with squash
      shadowMesh.scale.set(state.scale.x, state.scale.z, 1.0);

      // Determine active viseme
      const { expression: expr, mouthOpenOverride: mouthOpen, isTalking: talking } = propsRef.current;
      avatar.resetVisemes();

      if (talking || (mouthOpen !== undefined && mouthOpen > 0.15)) {
        avatar.setViseme('open', mouthOpen ?? 0.85);
      } else {
        let viseme: VisemeName = 'rest';
        let influence = 0.8;

        switch (expr) {
          case 'happy':
          case 'amused':
          case 'excited':
            viseme = 'happy';
            influence = 0.95;
            break;
          case 'thoughtful':
          case 'sleepy':
            viseme = 'pursed';
            influence = 0.85;
            break;
          case 'mischievous':
          case 'surprised':
          case 'confused':
            viseme = 'smirk';
            influence = 0.85;
            break;
          default:
            viseme = 'rest';
            influence = 0.8;
            break;
        }
        avatar.setViseme(viseme, influence);
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      if (typeof window !== 'undefined') {
        window.removeEventListener('mousemove', onWindowPointerMove);
      }

      avatar.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      if (shadowTex) shadowTex.dispose();
      renderer.dispose();
    };
  }, [hasWebGL, height, interactive]);

  if (!hasWebGL) {
    const avatarPx = typeof height === 'number' ? Math.min(height, 240) : 220;
    return (
      <div
        className={`flex items-center justify-center p-4 ${className}`}
        style={{ width, height }}
        data-testid="potato-2d-fallback"
      >
        <AvatarFace
          template="potato"
          expression={expression}
          mouthOpenOverride={mouthOpenOverride}
          size={avatarPx}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center justify-center select-none touch-none overflow-hidden ${className}`}
      style={{ width, height }}
      data-testid="potato-3d-canvas-container"
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab active:cursor-grabbing outline-none"
        aria-label="Interactive 3D Potato Avatar. Drag to wobble, click to poke."
        role="img"
      />
    </div>
  );
}
