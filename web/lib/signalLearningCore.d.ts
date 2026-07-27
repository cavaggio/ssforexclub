type SignalLearningRecord = Record<string, any>;

export const HORIZONS: readonly number[];

export function normalizePair(value: unknown): string | null;

export function collectScanCandidates(payload?: SignalLearningRecord): Array<{
  item: SignalLearningRecord;
  sourceBucket: string;
  defaultStatus: string;
  sourceIndex: number;
}>;

export function buildLearningRecords(input?: {
  userId?: string;
  brokerAccountId?: string;
  environment?: string;
  engine?: string;
  scanMode?: string;
  runId?: string;
  payload?: SignalLearningRecord;
  observedAt?: Date | string;
}): {
  observations: SignalLearningRecord[];
  snapshots: SignalLearningRecord[];
};

export function gradeObservation(input: {
  observation: SignalLearningRecord;
  snapshots: SignalLearningRecord[];
  horizonMinutes: number;
}): SignalLearningRecord | null;

export function buildPairPlaybook(input: {
  pair: string;
  engine: string;
  summary: SignalLearningRecord;
  timeStats?: SignalLearningRecord[];
  confirmationStats?: SignalLearningRecord[];
  comboStats?: SignalLearningRecord[];
  regimeStats?: SignalLearningRecord[];
}, options?: SignalLearningRecord): SignalLearningRecord;
