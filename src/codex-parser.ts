import { createReadStream, existsSync, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { projectForThread, type CodexCostConfig } from "./config.ts";
import type { ScanResult, UsageEvent } from "./types.ts";

type ThreadState = {
  threadId?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  turnId?: string;
  turnStartedAt?: string;
  lastUsageAt?: string;
  planType?: string;
  credits?: UsageEvent["credits"];
};

export type ScanOptions = {
  projectId?: string;
  threadId?: string;
};

export type CodexIndex = {
  filesRead: number;
  threadNames: Map<string, string>;
  projects: Array<{ projectId: string; projectName: string; threadCount: number }>;
};

const maxUsageGapMs = 30 * 60 * 1000;

export async function scanCodex(config: CodexCostConfig, options: ScanOptions = {}): Promise<ScanResult> {
  const threadNames = await readThreadNames(join(config.codexHome, "session_index.jsonl"));
  const files = [
    ...(await findJsonlFiles(join(config.codexHome, "sessions"))),
    ...(await findJsonlFiles(join(config.codexHome, "archived_sessions")))
  ];

  const events: UsageEvent[] = [];
  let skippedRecords = 0;
  let duplicateRecords = 0;
  const seen = new Set<string>();

  for (const file of files) {
    const state: ThreadState = {};
    for await (const record of readJsonl(file)) {
      if (!record) {
        skippedRecords++;
        continue;
      }
      const type = record.type;
      if (type === "session_meta") {
        const payload = record.payload ?? record;
        state.threadId = stringValue(payload.id) ?? state.threadId;
        state.cwd = stringValue(payload.cwd) ?? stringValue(payload.working_dir) ?? state.cwd;
        state.planType = readPlanType(payload) ?? state.planType;
        state.credits = readCredits(payload) ?? state.credits ?? null;
        if (shouldSkipRemainingFile(config, state, options)) break;
        continue;
      }
      if (type === "turn_context") {
        const payload = record.payload ?? record;
        state.cwd = stringValue(payload.cwd) ?? state.cwd;
        state.model = stringValue(payload.model) ?? state.model;
        state.effort = stringValue(payload.effort) ?? stringValue(payload.reasoning_effort) ?? state.effort;
        state.turnId = stringValue(payload.turn_id) ?? stringValue(payload.id) ?? state.turnId;
        state.turnStartedAt = stringValue(record.timestamp) ?? stringValue(payload.timestamp) ?? state.turnStartedAt;
        state.lastUsageAt = undefined;
        state.planType = readPlanType(payload) ?? state.planType;
        state.credits = readCredits(payload) ?? state.credits ?? null;
        if (shouldSkipRemainingFile(config, state, options)) break;
        continue;
      }
      if (type === "thread_name_updated") {
        const payload = record.payload ?? record;
        const id = stringValue(payload.thread_id) ?? state.threadId;
        const name = stringValue(payload.name) ?? stringValue(payload.thread_name);
        if (id && name) threadNames.set(id, name);
        continue;
      }
      if (type !== "event_msg" || record.payload?.type !== "token_count") continue;

      const usage = record.payload.last_token_usage ?? record.payload.info?.last_token_usage;
      const threadId = stringValue(record.payload.thread_id) ?? state.threadId;
      if (!usage || !threadId) {
        skippedRecords++;
        continue;
      }
      if (!matchesScanOptions(config, state, threadId, options)) continue;
      const timestamp = stringValue(record.timestamp) ?? stringValue(record.payload.timestamp) ?? "";
      const dedupeKey = `${threadId}:${timestamp}:${JSON.stringify(usage)}`;
      if (seen.has(dedupeKey)) {
        duplicateRecords++;
        continue;
      }
      seen.add(dedupeKey);

      const model = stringValue(usage.model) ?? stringValue(record.payload.model) ?? state.model ?? "unknown";
      const startedAt = state.lastUsageAt ?? state.turnStartedAt;
      const eventDurationMs = durationMs(startedAt, timestamp);
      events.push({
        timestamp,
        startedAt,
        durationMs: eventDurationMs,
        threadId,
        threadName: threadNames.get(threadId),
        turnId: stringValue(record.payload.turn_id) ?? state.turnId,
        cwd: state.cwd,
        model,
        effort: state.effort,
        speed: config.speedOverrides[threadId] ?? config.speedOverrides[model] ?? "unknown",
        planType: readPlanType(record.payload) ?? state.planType ?? "unknown",
        credits: readCredits(record.payload) ?? state.credits ?? null,
        inputTokens: numberValue(usage.input_tokens),
        cachedInputTokens: numberValue(usage.cached_input_tokens),
        outputTokens: numberValue(usage.output_tokens),
        reasoningOutputTokens: numberValue(usage.reasoning_output_tokens),
        sourceFile: file
      });
      state.lastUsageAt = timestamp;
    }
  }

  return { events, skippedRecords, duplicateRecords, filesRead: files.length, threadNames };
}

export async function scanCodexIndex(config: CodexCostConfig): Promise<CodexIndex> {
  const threadNames = await readThreadNames(join(config.codexHome, "session_index.jsonl"));
  const files = [
    ...(await findJsonlFiles(join(config.codexHome, "sessions"))),
    ...(await findJsonlFiles(join(config.codexHome, "archived_sessions")))
  ];
  const projects = new Map<string, { projectId: string; projectName: string; threadIds: Set<string> }>();

  for (const file of files) {
    const state: ThreadState = {};
    for await (const record of readJsonl(file)) {
      if (!record) continue;
      const type = record.type;
      if (type === "session_meta") {
        const payload = record.payload ?? record;
        state.threadId = stringValue(payload.id) ?? state.threadId;
        state.cwd = stringValue(payload.cwd) ?? stringValue(payload.working_dir) ?? state.cwd;
      } else if (type === "turn_context") {
        const payload = record.payload ?? record;
        state.cwd = stringValue(payload.cwd) ?? state.cwd;
        state.threadId = stringValue(payload.thread_id) ?? state.threadId;
      } else if (type === "thread_name_updated") {
        const payload = record.payload ?? record;
        const id = stringValue(payload.thread_id) ?? state.threadId;
        const name = stringValue(payload.name) ?? stringValue(payload.thread_name);
        if (id && name) threadNames.set(id, name);
      }

      if (state.threadId && state.cwd) {
        const project = projectForThread(config, state.threadId, state.cwd);
        const existing = projects.get(project.id) ?? { projectId: project.id, projectName: project.name, threadIds: new Set<string>() };
        existing.threadIds.add(state.threadId);
        projects.set(project.id, existing);
        break;
      }
    }
  }

  return {
    filesRead: files.length,
    threadNames,
    projects: Array.from(projects.values(), (project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      threadCount: project.threadIds.size
    })).sort((left, right) => left.projectName.localeCompare(right.projectName))
  };
}

function matchesScanOptions(config: CodexCostConfig, state: ThreadState, threadId: string, options: ScanOptions): boolean {
  if (options.threadId && threadId !== options.threadId) return false;
  if (options.projectId && projectForThread(config, threadId, state.cwd).id !== options.projectId) return false;
  return true;
}

function shouldSkipRemainingFile(config: CodexCostConfig, state: ThreadState, options: ScanOptions): boolean {
  if (options.threadId && state.threadId && state.threadId !== options.threadId) return true;
  if (!options.projectId || !state.threadId || !state.cwd) return false;
  return projectForThread(config, state.threadId, state.cwd).id !== options.projectId;
}

async function readThreadNames(path: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!existsSync(path)) return names;
  for await (const record of readJsonl(path)) {
    const payload = record?.payload ?? record;
    const id = stringValue(payload?.id) ?? stringValue(payload?.thread_id) ?? stringValue(payload?.session_id);
    const name = stringValue(payload?.name) ?? stringValue(payload?.thread_name) ?? stringValue(payload?.title);
    if (id && name) names.set(id, name);
  }
  return names;
}

async function* readJsonl(path: string): AsyncGenerator<any | null> {
  const input = createReadStream(path, "utf8");
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      yield null;
    }
  }
}

async function findJsonlFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return findJsonlFiles(path);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
    })
  );
  return results.flat().sort();
}

function readPlanType(value: any): string | undefined {
  return stringValue(value?.plan_type) ?? stringValue(value?.rate_limits?.plan_type);
}

function readCredits(value: any): UsageEvent["credits"] | undefined {
  const credits = value?.credits ?? value?.rate_limits?.credits;
  if (credits === undefined) return undefined;
  if (credits === null) return null;
  return {
    hasCredits: typeof credits.has_credits === "boolean" ? credits.has_credits : null,
    balance: typeof credits.balance === "number" ? credits.balance : null
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function durationMs(start: string | undefined, end: string): number | null {
  if (!start || !end) return null;
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
  const duration = endTime - startTime;
  return duration <= maxUsageGapMs ? duration : null;
}
