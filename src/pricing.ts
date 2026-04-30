import type { CodexCostConfig, RateCard } from "./config.ts";
import { projectForThread } from "./config.ts";
import type { ProjectReport, ThreadReport, TokenTotals, UsageEvent } from "./types.ts";

const defaultRateCards: Record<string, RateCard> = {
  "gpt-5": { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  "gpt-5-nano": { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
  "gpt-5.1": { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  "gpt-5.1-codex": { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10 },
  "gpt-5.1-codex-mini": { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  "gpt-5.2": { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  "gpt-5.3-codex": { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 },
  "gpt-5.3-codex-spark": { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  "gpt-5.4": { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 },
  "gpt-5.5": { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 }
};

const ignoredReportModels = new Set(["codex-auto-review"]);

export function buildReports(events: UsageEvent[], config: CodexCostConfig, threadNames = new Map<string, string>()): ProjectReport[] {
  const reportEvents = events.filter((event) => !ignoredReportModels.has(event.model));
  const byThread = groupBy(reportEvents, (event) => event.threadId);
  const threads: ThreadReport[] = [];
  for (const [threadId, threadEvents] of byThread) {
    const cwd = firstDefined(threadEvents.map((event) => event.cwd)) ?? "";
    const project = projectForThread(config, threadId, cwd);
    const override = config.threadOverrides[threadId];
    const priced = priceEvents(threadEvents, config);
    threads.push({
      threadId,
      name: override?.name ?? threadNames.get(threadId) ?? threadEvents[0]?.threadName ?? threadId,
      projectId: project.id,
      projectName: override?.projectName ?? project.name,
      cwd,
      models: unique(threadEvents.map((event) => event.model)),
      planTypes: unique(threadEvents.map((event) => event.planType)),
      credits: latestCredits(threadEvents),
      speed: unique(threadEvents.map((event) => event.speed)).join(", "),
      timeRange: timeRange(threadEvents.map((event) => event.timestamp)),
      tokenTotals: tokenTotals(threadEvents),
      estimatedDollars: priced.dollars,
      estimatedCredits: priced.credits,
      unpriced: priced.unpriced,
      events: threadEvents
    });
  }

  const byProject = groupBy(threads, (thread) => thread.projectId);
  return Array.from(byProject, ([projectId, projectThreads]) => {
    const allEvents = projectThreads.flatMap((thread) => thread.events);
    return {
      projectId,
      projectName: projectThreads[0]?.projectName ?? projectId,
      timeRange: timeRange(allEvents.map((event) => event.timestamp)),
      threadCount: projectThreads.length,
      tokenTotals: tokenTotals(allEvents),
      estimatedDollars: sum(projectThreads.map((thread) => thread.estimatedDollars)),
      estimatedCredits: nullableSum(projectThreads.map((thread) => thread.estimatedCredits)),
      unpriced: unique(projectThreads.flatMap((thread) => thread.unpriced)),
      threads: projectThreads.sort((a, b) => a.name.localeCompare(b.name))
    };
  }).sort((a, b) => a.projectName.localeCompare(b.projectName));
}

export function priceEvents(events: UsageEvent[], config: CodexCostConfig): { dollars: number; credits: number | null; unpriced: string[] } {
  let dollars = 0;
  let credits = 0;
  let sawCredits = false;
  const unpriced = new Set<string>();
  for (const event of events) {
    const rate = config.rateCards[event.model] ?? defaultRateCards[event.model];
    if (!rate || rate.inputPerMillion === undefined || rate.outputPerMillion === undefined) {
      unpriced.add(event.model);
      continue;
    }
    dollars += perMillion(event.inputTokens - event.cachedInputTokens, rate.inputPerMillion);
    dollars += perMillion(event.cachedInputTokens, rate.cachedInputPerMillion ?? rate.inputPerMillion);
    dollars += perMillion(event.outputTokens, rate.outputPerMillion);
    dollars += perMillion(event.reasoningOutputTokens, rate.reasoningOutputPerMillion ?? rate.outputPerMillion);

    if (
      rate.creditsPerMillionInput !== undefined ||
      rate.creditsPerMillionCachedInput !== undefined ||
      rate.creditsPerMillionOutput !== undefined ||
      rate.creditsPerMillionReasoningOutput !== undefined
    ) {
      sawCredits = true;
      credits += perMillion(event.inputTokens - event.cachedInputTokens, rate.creditsPerMillionInput ?? 0);
      credits += perMillion(event.cachedInputTokens, rate.creditsPerMillionCachedInput ?? rate.creditsPerMillionInput ?? 0);
      credits += perMillion(event.outputTokens, rate.creditsPerMillionOutput ?? 0);
      credits += perMillion(event.reasoningOutputTokens, rate.creditsPerMillionReasoningOutput ?? rate.creditsPerMillionOutput ?? 0);
    }
  }
  return { dollars, credits: sawCredits ? credits : null, unpriced: Array.from(unpriced).sort() };
}

export function tokenTotals(events: UsageEvent[]): TokenTotals {
  const inputTokens = sum(events.map((event) => event.inputTokens));
  const cachedInputTokens = sum(events.map((event) => event.cachedInputTokens));
  const outputTokens = sum(events.map((event) => event.outputTokens));
  const reasoningOutputTokens = sum(events.map((event) => event.reasoningOutputTokens));
  return {
    inputTokens,
    cachedInputTokens,
    billableInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + reasoningOutputTokens
  };
}

export function allRateCards(config: CodexCostConfig): Record<string, RateCard> {
  return { ...defaultRateCards, ...config.rateCards };
}

function perMillion(tokens: number, rate: number): number {
  return (Math.max(0, tokens) / 1_000_000) * rate;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  return groups;
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function firstDefined(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function latestCredits(events: UsageEvent[]): UsageEvent["credits"] {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].credits !== undefined) return events[index].credits;
  }
  return null;
}

function timeRange(values: string[]): { start: string | null; end: string | null } {
  const sorted = values.filter(Boolean).sort();
  return { start: sorted[0] ?? null, end: sorted.at(-1) ?? null };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nullableSum(values: Array<number | null>): number | null {
  const real = values.filter((value): value is number => value !== null);
  return real.length > 0 ? sum(real) : null;
}
