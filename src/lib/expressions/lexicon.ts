import type { ExpressionState, ExpressionScore } from './types';

interface LexiconEntry {
  state: ExpressionState;
  intensity: number;
  keywords: string[];
}

const LEXICON: LexiconEntry[] = [
  // -----------------------------------------------------------------------
  // Happy / warm
  // -----------------------------------------------------------------------
  { state: 'happy', intensity: 0.7, keywords: ['smiles', 'smile', 'grins', 'grin', 'beams', 'beam', 'winks', 'wink'] },
  { state: 'happy', intensity: 0.5, keywords: ['waves', 'wave', 'nods', 'nod', 'thumbs up'] },

  // -----------------------------------------------------------------------
  // Amused / laughing
  // -----------------------------------------------------------------------
  { state: 'amused', intensity: 0.8, keywords: ['laughs', 'laugh', 'lol', 'rofl', 'cackles', 'cackle', 'snickers', 'snicker'] },
  { state: 'amused', intensity: 0.6, keywords: ['chuckles', 'chuckle', 'giggles', 'giggle', 'snorts', 'snort'] },

  // -----------------------------------------------------------------------
  // Thoughtful / reflective
  // -----------------------------------------------------------------------
  { state: 'thoughtful', intensity: 0.6, keywords: ['thinks', 'think', 'ponders', 'ponder', 'considers', 'consider', 'contemplates', 'contemplate'] },
  { state: 'thoughtful', intensity: 0.5, keywords: ['nods slowly', 'tilts head', 'strokes chin', 'hums', 'hum', 'pauses', 'pause'] },
  { state: 'thoughtful', intensity: 0.4, keywords: ['looks up', 'stares into distance', 'gazes'] },

  // -----------------------------------------------------------------------
  // Concerned / worried
  // -----------------------------------------------------------------------
  { state: 'concerned', intensity: 0.6, keywords: ['frowns', 'frown', 'furrows brow', 'worries', 'winces', 'wince', 'grimaces', 'grimace'] },
  { state: 'concerned', intensity: 0.5, keywords: ['bites lip', 'shifts nervously', 'fidgets', 'gulps', 'gulp'] },

  // -----------------------------------------------------------------------
  // Sad
  // -----------------------------------------------------------------------
  { state: 'sad', intensity: 0.7, keywords: ['cries', 'cry', 'weeps', 'weep', 'tears up', 'sobs', 'sob'] },
  { state: 'sad', intensity: 0.5, keywords: ['sighs', 'sigh', 'droops', 'droop', 'deflates', 'wilts', 'wilt'] },
  { state: 'sad', intensity: 0.4, keywords: ['looks down', 'hangs head'] },

  // -----------------------------------------------------------------------
  // Excited
  // -----------------------------------------------------------------------
  { state: 'excited', intensity: 0.8, keywords: ['jumps', 'jump', 'bounces', 'bounce', 'leaps', 'cheers', 'cheer'] },
  { state: 'excited', intensity: 0.6, keywords: ['eyes widen', 'gasps', 'gasp', 'perks up', 'lights up', 'claps', 'clap'] },

  // -----------------------------------------------------------------------
  // Confused
  // -----------------------------------------------------------------------
  { state: 'confused', intensity: 0.6, keywords: ['scratches head', 'blinks', 'blink', 'tilts head confused', 'squints', 'squint'] },
  { state: 'confused', intensity: 0.5, keywords: ['puzzled', 'confused', 'bewildered', 'raises eyebrow', 'raises an eyebrow'] },

  // -----------------------------------------------------------------------
  // Angry (NEW)
  // -----------------------------------------------------------------------
  { state: 'angry', intensity: 0.8, keywords: ['scowls', 'scowl', 'glares', 'glare', 'seethes', 'seethe', 'growls', 'growl', 'snarls', 'snarl'] },
  { state: 'angry', intensity: 0.6, keywords: ['grumbles', 'grumble', 'huffs', 'huff', 'clenches fists', 'clenches jaw', 'slams'] },
  { state: 'angry', intensity: 0.5, keywords: ['crosses arms', 'narrows eyes', 'glowers', 'fumes'] },

  // -----------------------------------------------------------------------
  // Surprised (NEW)
  // -----------------------------------------------------------------------
  { state: 'surprised', intensity: 0.8, keywords: ['jaw drops', 'startled', 'stunned', 'double takes', 'double take', 'freezes'] },
  { state: 'surprised', intensity: 0.6, keywords: ['eyes go wide', 'taken aback', 'recoils', 'recoil', 'whoa', 'oh my'] },

  // -----------------------------------------------------------------------
  // Shy (NEW)
  // -----------------------------------------------------------------------
  { state: 'shy', intensity: 0.7, keywords: ['blushes', 'blush', 'hides face', 'looks away', 'averts gaze', 'covers face'] },
  { state: 'shy', intensity: 0.5, keywords: ['fiddles', 'fiddle', 'peeks', 'peek', 'murmurs', 'whispers shyly', 'twiddles thumbs'] },

  // -----------------------------------------------------------------------
  // Proud (NEW)
  // -----------------------------------------------------------------------
  { state: 'proud', intensity: 0.7, keywords: ['stands tall', 'beams proudly', 'puffs chest', 'puffs up', 'struts'] },
  { state: 'proud', intensity: 0.5, keywords: ['takes a bow', 'bows', 'bows proudly', 'flexes', 'flex', 'polishes nails'] },

  // -----------------------------------------------------------------------
  // Sleepy (NEW)
  // -----------------------------------------------------------------------
  { state: 'sleepy', intensity: 0.7, keywords: ['yawns', 'yawn', 'drowsy', 'nods off', 'falls asleep', 'snores', 'snore'] },
  { state: 'sleepy', intensity: 0.5, keywords: ['stretches', 'stretch', 'rubs eyes', 'blinks sleepily', 'dozes', 'doze'] },

  // -----------------------------------------------------------------------
  // Loving (NEW)
  // -----------------------------------------------------------------------
  { state: 'loving', intensity: 0.8, keywords: ['hugs', 'hug', 'heart eyes', 'adores', 'adore', 'embraces', 'embrace', 'snuggles', 'snuggle'] },
  { state: 'loving', intensity: 0.6, keywords: ['blows kiss', 'holds hands', 'gazes lovingly', 'strokes cheek', 'cuddles', 'cuddle'] },

  // -----------------------------------------------------------------------
  // Mischievous (NEW)
  // -----------------------------------------------------------------------
  { state: 'mischievous', intensity: 0.7, keywords: ['snickers', 'grins slyly', 'grins mischievously', 'plots', 'schemes', 'rubs hands together'] },
  { state: 'mischievous', intensity: 0.5, keywords: ['smirks', 'smirk', 'winks mischievously', 'nudges', 'nudge', 'waggles eyebrows'] },

  // -----------------------------------------------------------------------
  // Nervous (NEW)
  // -----------------------------------------------------------------------
  { state: 'nervous', intensity: 0.7, keywords: ['trembles', 'tremble', 'shakes', 'shake', 'panics', 'panic', 'freaks out'] },
  { state: 'nervous', intensity: 0.5, keywords: ['sweats', 'sweat', 'stammers', 'stammer', 'stutters', 'stutter', 'wrings hands'] },
  { state: 'nervous', intensity: 0.4, keywords: ['taps foot', 'shifts weight', 'glances around nervously', 'twists fingers'] },
];

const SPEECH_KEYWORDS: { pattern: RegExp; state: ExpressionState; intensity: number }[] = [
  // Original patterns
  { pattern: /\b(haha|hehe|lol|lmao|rofl|funny)\b/i, state: 'amused', intensity: 0.4 },
  { pattern: /\b(love|adore|wonderful|amazing|awesome|great)\b/i, state: 'happy', intensity: 0.35 },
  { pattern: /\b(sad|sorry|unfortunately|miss you|heartbreak)\b/i, state: 'sad', intensity: 0.35 },
  { pattern: /\b(worry|worried|nervous|anxious|scared|afraid)\b/i, state: 'concerned', intensity: 0.35 },
  { pattern: /\b(wow|whoa|incredible|omg|no way|insane)\b/i, state: 'excited', intensity: 0.4 },
  { pattern: /\b(think|maybe|perhaps|wonder|hmm|ponder)\b/i, state: 'thoughtful', intensity: 0.3 },
  { pattern: /\b(huh|what\??|confused|weird|strange)\b/i, state: 'confused', intensity: 0.3 },
  { pattern: /[!]{2,}/, state: 'excited', intensity: 0.3 },
  { pattern: /[?]{2,}/, state: 'confused', intensity: 0.3 },

  // New patterns for new states
  { pattern: /\b(angry|furious|rage|hate|annoyed|irritated|mad)\b/i, state: 'angry', intensity: 0.4 },
  { pattern: /\b(surprised|shocked|unbelievable|unexpected|astonishing)\b/i, state: 'surprised', intensity: 0.4 },
  { pattern: /\b(shy|embarrassed|bashful|flustered|blushing)\b/i, state: 'shy', intensity: 0.35 },
  { pattern: /\b(proud|accomplished|achieved|victory|nailed it|crushed it)\b/i, state: 'proud', intensity: 0.35 },
  { pattern: /\b(sleepy|tired|exhausted|yawn|drowsy|zzz)\b/i, state: 'sleepy', intensity: 0.35 },
  { pattern: /\b(love you|heart|sweetheart|darling|dear|precious|cherish)\b/i, state: 'loving', intensity: 0.4 },
  { pattern: /\b(heh|sneaky|trick|prank|mwahaha|devious)\b/i, state: 'mischievous', intensity: 0.35 },
  { pattern: /\b(nervous|anxious|tense|jittery|on edge|panicking)\b/i, state: 'nervous', intensity: 0.35 },
];

function normalizeAction(action: string): string {
  return action.toLowerCase().replace(/[,.'""!?]+/g, '').trim();
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
    // New high-confidence verbs
    'scowls', 'scowl', 'glares', 'glare', 'growls', 'growl',
    'yawns', 'yawn', 'hugs', 'hug', 'trembles', 'tremble',
    'blushes', 'blush', 'snickers', 'smirks', 'smirk',
    'shakes', 'shake', 'snores', 'snore',
  ];
  return directVerbs.some((v) => normalized === v || normalized.startsWith(v + ' '));
}
