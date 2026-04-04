import type { ExpressionState, ExpressionScore } from './types';

interface LexiconEntry {
  state: ExpressionState;
  intensity: number;
  keywords: string[];
}

const LEXICON: LexiconEntry[] = [
  // Happy / warm
  { state: 'happy', intensity: 0.7, keywords: ['smiles', 'smile', 'grins', 'grin', 'beams', 'beam', 'winks', 'wink'] },
  { state: 'happy', intensity: 0.5, keywords: ['waves', 'wave', 'nods', 'nod', 'thumbs up'] },

  // Amused / laughing
  { state: 'amused', intensity: 0.8, keywords: ['laughs', 'laugh', 'lol', 'rofl', 'cackles', 'cackle', 'snickers', 'snicker'] },
  { state: 'amused', intensity: 0.6, keywords: ['chuckles', 'chuckle', 'giggles', 'giggle', 'snorts', 'snort'] },

  // Thoughtful / reflective
  { state: 'thoughtful', intensity: 0.6, keywords: ['thinks', 'think', 'ponders', 'ponder', 'considers', 'consider', 'contemplates', 'contemplate'] },
  { state: 'thoughtful', intensity: 0.5, keywords: ['nods slowly', 'tilts head', 'strokes chin', 'hums', 'hum', 'pauses', 'pause'] },
  { state: 'thoughtful', intensity: 0.4, keywords: ['looks up', 'stares into distance', 'gazes'] },

  // Concerned / worried
  { state: 'concerned', intensity: 0.6, keywords: ['frowns', 'frown', 'furrows brow', 'worries', 'winces', 'wince', 'grimaces', 'grimace'] },
  { state: 'concerned', intensity: 0.5, keywords: ['bites lip', 'shifts nervously', 'fidgets', 'gulps', 'gulp'] },

  // Sad
  { state: 'sad', intensity: 0.7, keywords: ['cries', 'cry', 'weeps', 'weep', 'tears up', 'sobs', 'sob'] },
  { state: 'sad', intensity: 0.5, keywords: ['sighs', 'sigh', 'droops', 'droop', 'deflates', 'wilts', 'wilt'] },
  { state: 'sad', intensity: 0.4, keywords: ['looks down', 'hangs head'] },

  // Excited
  { state: 'excited', intensity: 0.8, keywords: ['jumps', 'jump', 'bounces', 'bounce', 'leaps', 'cheers', 'cheer'] },
  { state: 'excited', intensity: 0.6, keywords: ['eyes widen', 'gasps', 'gasp', 'perks up', 'lights up', 'claps', 'clap'] },

  // Confused
  { state: 'confused', intensity: 0.6, keywords: ['scratches head', 'blinks', 'blink', 'tilts head confused', 'squints', 'squint'] },
  { state: 'confused', intensity: 0.5, keywords: ['puzzled', 'confused', 'bewildered', 'raises eyebrow', 'raises an eyebrow'] },
];

const SPEECH_KEYWORDS: { pattern: RegExp; state: ExpressionState; intensity: number }[] = [
  { pattern: /\b(haha|hehe|lol|lmao|rofl|funny)\b/i, state: 'amused', intensity: 0.4 },
  { pattern: /\b(love|adore|wonderful|amazing|awesome|great)\b/i, state: 'happy', intensity: 0.35 },
  { pattern: /\b(sad|sorry|unfortunately|miss you|heartbreak)\b/i, state: 'sad', intensity: 0.35 },
  { pattern: /\b(worry|worried|nervous|anxious|scared|afraid)\b/i, state: 'concerned', intensity: 0.35 },
  { pattern: /\b(wow|whoa|incredible|omg|no way|insane)\b/i, state: 'excited', intensity: 0.4 },
  { pattern: /\b(think|maybe|perhaps|wonder|hmm|ponder)\b/i, state: 'thoughtful', intensity: 0.3 },
  { pattern: /\b(huh|what\??|confused|weird|strange)\b/i, state: 'confused', intensity: 0.3 },
  { pattern: /[!]{2,}/, state: 'excited', intensity: 0.3 },
  { pattern: /[?]{2,}/, state: 'confused', intensity: 0.3 },
];

function normalizeAction(action: string): string {
  return action.toLowerCase().replace(/[,.'"""!?]+/g, '').trim();
}

export function scoreActionPhrase(action: string): ExpressionScore | null {
  const normalized = normalizeAction(action);

  for (const entry of LEXICON) {
    for (const keyword of entry.keywords) {
      if (normalized === keyword || normalized.includes(keyword)) {
        return {
          state: entry.state,
          intensity: entry.intensity,
          source: `action:${action}`,
        };
      }
    }
  }

  return null;
}

export function scoreSpeechText(speech: string): ExpressionScore | null {
  let best: ExpressionScore | null = null;

  for (const rule of SPEECH_KEYWORDS) {
    if (rule.pattern.test(speech)) {
      if (!best || rule.intensity > best.intensity) {
        best = {
          state: rule.state,
          intensity: rule.intensity,
          source: `text:${rule.state}`,
        };
      }
    }
  }

  return best;
}

export function isHighConfidenceAction(action: string): boolean {
  const normalized = normalizeAction(action);
  const directVerbs = [
    'smiles', 'smile', 'laughs', 'laugh', 'cries', 'cry', 'frowns', 'frown',
    'grins', 'grin', 'sighs', 'sigh', 'chuckles', 'chuckle', 'gasps', 'gasp',
    'winks', 'wink', 'giggles', 'giggle', 'sobs', 'sob', 'claps', 'clap',
  ];
  return directVerbs.some((v) => normalized === v || normalized.startsWith(v + ' '));
}
