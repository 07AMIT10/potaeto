# Expression System Design — Potaeto Chat

**Date:** 2026-04-05
**Status:** Approved (verbal), implementing

---

## Problem

Chat messages contain `*action*` tags (e.g., `*chuckles*`, `*nods slowly*`) that describe the character's physical/emotional state. These are rendered as plain text today. We want to **visually portray** these as animated expressions on a potato face avatar.

## Architecture

```
Message text
    │
    ▼
┌──────────┐     ┌──────────┐     ┌────────────┐     ┌────────────┐
│  Parser  │────▶│  Lexicon  │────▶│  Fusion &  │────▶│  Potato    │
│ (regex)  │     │ (action → │     │  State     │     │  Face SVG  │
│          │     │  emotion) │     │  Machine   │     │  Component │
└──────────┘     └──────────┘     └────────────┘     └────────────┘
                                        │
                                  smoothing +
                                  hysteresis
```

### Signal fusion (Hybrid — approach 3 + 2)

- **Primary** (`w=0.60`): Explicit `*action*` tag → direct emotion mapping
- **Secondary** (`w=0.30`): Speech text → lightweight keyword/heuristic classifier
- **Tertiary** (`w=0.10`): Previous expression state → continuity bias

When action confidence is very high (exact verb match), `w_action` rises to `0.75`.

### Expression states (MVP)

| State | Eyes | Mouth | Extras |
|-------|------|-------|--------|
| `idle` | normal | slight smile | — |
| `happy` | soft squint | wide smile | blush |
| `amused` | squint | open grin | — |
| `thoughtful` | one raised | small/flat | head tilt |
| `concerned` | worried | slight frown | sweat |
| `sad` | droopy | downturned | — |
| `excited` | wide | big open | sparkle |
| `confused` | one up one down | wavy | ? mark |

### Temporal smoothing

- **Hysteresis**: New state must exceed current by `Δ ≥ 0.15` confidence
- **Min hold**: `900ms` before allowing transition
- **Decay to idle**: `1.5s` ease-out after message completes
- **Transition animation**: `300ms` CSS transition on all face parts

### Rendering

- **PotatoFace**: Inline SVG (40×40) to the left of assistant message bubbles
- **MessageContent**: Renders `*action*` text in italic + muted color; speech text normal
- **Streaming**: Re-parse accumulated text on each chunk; animate face as new `*...*` spans close

### File structure

```
src/lib/expressions/
  types.ts          — Shared types (ExpressionState, Span, etc.)
  parser.ts         — Regex extraction of action/speech spans
  lexicon.ts        — Action phrase → emotion state + intensity
  useExpression.ts  — React hook: parser + lexicon + state machine

src/components/
  PotatoFace.tsx    — SVG potato face, prop-driven expression
  MessageContent.tsx — Rich text renderer (styled *action* spans)
```

### Metadata contract (future: persist to DB)

```json
{
  "expressions": [
    { "state": "thoughtful", "intensity": 0.62, "source": "action:nods slowly" }
  ]
}
```

### Standards alignment

- Emotion labels inspired by GoEmotions 27-category taxonomy
- Representation concepts from W3C EmotionML (category + intensity + confidence)
- Future TTS: prosody via SSML pitch/rate/volume controls

---

## Non-goals (for now)

- External emotion classifier API (keep client-side heuristic)
- Persistent expression metadata in messages table
- 3D avatar / WebGL
- Voice/TTS integration
