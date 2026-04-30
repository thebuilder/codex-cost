export type TokenTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  billableInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type CreditsStatus = {
  hasCredits: boolean | null;
  balance: number | null;
};

export type UsageEvent = {
  timestamp: string;
  startedAt?: string;
  durationMs: number | null;
  threadId: string;
  threadName?: string;
  turnId?: string;
  cwd?: string;
  model: string;
  effort?: string;
  speed: string;
  planType: string;
  credits: CreditsStatus | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  sourceFile: string;
};

export type ThreadReport = {
  threadId: string;
  name: string;
  projectId: string;
  projectName: string;
  cwd: string;
  models: string[];
  planTypes: string[];
  credits: CreditsStatus | null;
  speed: string;
  timeRange: { start: string | null; end: string | null };
  durationMs: number;
  tokenTotals: TokenTotals;
  estimatedDollars: number;
  estimatedCredits: number | null;
  unpriced: string[];
  events: UsageEvent[];
};

export type ProjectReport = {
  projectId: string;
  projectName: string;
  timeRange: { start: string | null; end: string | null };
  durationMs: number;
  threadCount: number;
  tokenTotals: TokenTotals;
  estimatedDollars: number;
  estimatedCredits: number | null;
  unpriced: string[];
  threads: ThreadReport[];
};

export type ScanResult = {
  events: UsageEvent[];
  skippedRecords: number;
  duplicateRecords: number;
  filesRead: number;
  threadNames: Map<string, string>;
};
