export type ExpressionState =
  | 'idle'
  | 'happy'
  | 'amused'
  | 'thoughtful'
  | 'concerned'
  | 'sad'
  | 'excited'
  | 'confused'
  | 'angry'
  | 'surprised'
  | 'shy'
  | 'proud'
  | 'sleepy'
  | 'loving'
  | 'mischievous'
  | 'nervous';

export interface ExpressionScore {
  state: ExpressionState;
  intensity: number;
  source: string;
}

export type SpanKind = 'action' | 'speech';

export interface MessageSpan {
  kind: SpanKind;
  text: string;
  startIndex: number;
  endIndex: number;
}
