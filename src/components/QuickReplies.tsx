'use client';

// ---------------------------------------------------------------------------
// Rule-based quick reply suggestions.
// Fills input only — does NOT auto-send. User retains control to edit.
// ---------------------------------------------------------------------------

interface QuickRepliesProps {
  latestAssistantText: string;
  onSelect: (text: string) => void;
  disabled?: boolean;
}

interface SuggestionRule {
  test: (text: string) => boolean;
  suggestions: string[];
}

const RULES: SuggestionRule[] = [
  // Questions → yes/no + elaboration.
  {
    test: (t) => /\?/.test(t),
    suggestions: ['Yes!', 'No, not really', 'Tell me more'],
  },
  // Excited / positive.
  {
    test: (t) => /\b(amazing|awesome|great|wonderful|fantastic|incredible|excited|love)\b/i.test(t),
    suggestions: ['That sounds great!', 'I love that!', 'Tell me more'],
  },
  // Sad / empathetic.
  {
    test: (t) => /\b(sorry|sad|unfortunately|miss|tough|hard|difficult|painful)\b/i.test(t),
    suggestions: ['I\'m sorry to hear that', 'That must be tough', 'It\'ll get better'],
  },
  // Worried / concerned.
  {
    test: (t) => /\b(worried|nervous|anxious|scared|afraid|concern)\b/i.test(t),
    suggestions: ['Don\'t worry!', 'It\'ll be fine', 'What can we do?'],
  },
  // Funny / amused.
  {
    test: (t) => /\b(haha|lol|funny|hilarious|joke)\b/i.test(t) || t.includes('😂') || t.includes('🤣') || t.includes('😆'),
    suggestions: ['😂 That\'s hilarious!', 'Tell me another one', 'You\'re funny'],
  },
  // Greeting.
  {
    test: (t) => /\b(hello|hi|hey|greetings|howdy|welcome)\b/i.test(t) && t.length < 100,
    suggestions: ['Hey! How are you?', 'Nice to meet you!', 'What\'s up?'],
  },
  // Offering help / asking what to do.
  {
    test: (t) => /\b(help|assist|can I|would you like|shall I|want me to)\b/i.test(t),
    suggestions: ['Yes, please!', 'Not right now', 'What do you suggest?'],
  },
  // Agreement / continuation.
  {
    test: (t) => /\b(right|exactly|indeed|absolutely|definitely|of course)\b/i.test(t),
    suggestions: ['I agree!', 'Absolutely!', 'Go on...'],
  },
];

/** Default suggestions when no rule matches. */
const DEFAULT_SUGGESTIONS = ['Tell me more', 'Why?', 'That\'s interesting'];

function getSuggestions(text: string): string[] {
  if (!text || text.length < 3) return [];

  for (const rule of RULES) {
    if (rule.test(text)) {
      return rule.suggestions;
    }
  }

  return DEFAULT_SUGGESTIONS;
}

export function QuickReplies({ latestAssistantText, onSelect, disabled = false }: QuickRepliesProps) {
  const suggestions = getSuggestions(latestAssistantText);

  if (suggestions.length === 0 || disabled) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onSelect(suggestion)}
          className="text-xs px-3 py-1.5 rounded-full border border-[var(--card-border)] bg-[var(--card)] text-[var(--foreground)] hover:bg-potato-50 dark:hover:bg-potato-900/20 hover:border-potato-300 dark:hover:border-potato-700 transition-all duration-200 animate-fade-in"
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}
