'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ExpressionState, ExpressionScore } from './types';
import { extractActionTexts } from './parser';
import { scoreActionPhrase, scoreSpeechText, isHighConfidenceAction } from './lexicon';

const W_ACTION = 0.60;
const W_ACTION_HIGH = 0.75;
const W_TEXT = 0.30;
const W_HISTORY = 0.10;
const HYSTERESIS_DELTA = 0.15;
const MIN_HOLD_MS = 900;
const DECAY_TO_IDLE_MS = 1500;

interface ExpressionOutput {
  state: ExpressionState;
  intensity: number;
}

function pickBestScore(
  actionScores: ExpressionScore[],
  textScore: ExpressionScore | null,
  prevState: ExpressionState,
): ExpressionOutput {
  const bestAction = actionScores.length > 0
    ? actionScores.reduce((a, b) => (b.intensity > a.intensity ? b : a))
    : null;

  const highConf = bestAction?.source.startsWith('action:') &&
    isHighConfidenceAction(bestAction.source.replace('action:', ''));

  const wAct = highConf ? W_ACTION_HIGH : W_ACTION;
  const wTxt = highConf ? (1 - wAct - W_HISTORY) : W_TEXT;

  const candidates = new Map<ExpressionState, number>();

  if (bestAction) {
    const prev = candidates.get(bestAction.state) ?? 0;
    candidates.set(bestAction.state, prev + wAct * bestAction.intensity);
  }

  if (textScore) {
    const prev = candidates.get(textScore.state) ?? 0;
    candidates.set(textScore.state, prev + wTxt * textScore.intensity);
  }

  if (prevState !== 'idle') {
    const prev = candidates.get(prevState) ?? 0;
    candidates.set(prevState, prev + W_HISTORY * 0.5);
  }

  let bestState: ExpressionState = 'idle';
  let bestIntensity = 0;

  candidates.forEach((score, state) => {
    if (score > bestIntensity) {
      bestState = state;
      bestIntensity = score;
    }
  });

  return { state: bestState, intensity: Math.min(bestIntensity, 1) };
}

export function useExpression(messageText: string, isStreaming: boolean) {
  const [expression, setExpression] = useState<ExpressionOutput>({ state: 'idle', intensity: 0 });
  const prevStateRef = useRef<ExpressionState>('idle');
  const lastChangeRef = useRef<number>(0);
  const decayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const computeExpression = useCallback((text: string) => {
    const actions = extractActionTexts(text);
    const actionScores = actions
      .map(scoreActionPhrase)
      .filter((s): s is ExpressionScore => s !== null);

    const speechOnly = text.replace(/\*[^*]{1,120}\*/g, '');
    const textScore = scoreSpeechText(speechOnly);

    return pickBestScore(actionScores, textScore, prevStateRef.current);
  }, []);

  useEffect(() => {
    if (!messageText) {
      setExpression({ state: 'idle', intensity: 0 });
      prevStateRef.current = 'idle';
      return;
    }

    const result = computeExpression(messageText);
    const now = Date.now();
    const timeSinceLast = now - lastChangeRef.current;

    if (result.state !== prevStateRef.current) {
      const currentIntensity = expression.intensity;
      const delta = result.intensity - currentIntensity;

      if (delta >= HYSTERESIS_DELTA || timeSinceLast > MIN_HOLD_MS) {
        setExpression(result);
        prevStateRef.current = result.state;
        lastChangeRef.current = now;
      }
    } else if (Math.abs(result.intensity - expression.intensity) > 0.05) {
      setExpression(result);
    }
  }, [messageText, computeExpression, expression.intensity]);

  useEffect(() => {
    if (decayTimerRef.current) clearTimeout(decayTimerRef.current);

    if (!isStreaming && expression.state !== 'idle') {
      decayTimerRef.current = setTimeout(() => {
        setExpression({ state: 'idle', intensity: 0 });
        prevStateRef.current = 'idle';
      }, DECAY_TO_IDLE_MS);
    }

    return () => {
      if (decayTimerRef.current) clearTimeout(decayTimerRef.current);
    };
  }, [isStreaming, expression.state]);

  return expression;
}

export function resolveExpression(text: string): ExpressionOutput {
  const actions = extractActionTexts(text);
  const actionScores = actions
    .map(scoreActionPhrase)
    .filter((s): s is ExpressionScore => s !== null);

  const speechOnly = text.replace(/\*[^*]{1,120}\*/g, '');
  const textScore = scoreSpeechText(speechOnly);

  return pickBestScore(actionScores, textScore, 'idle');
}
