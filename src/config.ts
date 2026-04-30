import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

const rateSchema = z.object({
  inputPerMillion: z.number().nonnegative().optional(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  reasoningOutputPerMillion: z.number().nonnegative().optional(),
  creditsPerMillionInput: z.number().nonnegative().optional(),
  creditsPerMillionCachedInput: z.number().nonnegative().optional(),
  creditsPerMillionOutput: z.number().nonnegative().optional(),
  creditsPerMillionReasoningOutput: z.number().nonnegative().optional()
});

const configSchema = z.object({
  codexHome: z.string().default(join(homedir(), ".codex")),
  currency: z.string().default("USD"),
  projectRules: z
    .array(z.object({ id: z.string(), name: z.string().optional(), pathPrefix: z.string() }))
    .default([]),
  threadOverrides: z
    .record(z.string(), z.object({ projectId: z.string().optional(), projectName: z.string().optional(), name: z.string().optional() }))
    .default({}),
  rateCards: z.record(z.string(), rateSchema).default({}),
  speedOverrides: z.record(z.string(), z.string()).default({})
});

export type CodexCostConfig = z.infer<typeof configSchema>;
export type RateCard = z.infer<typeof rateSchema>;

export function loadConfig(cwd = process.cwd()): CodexCostConfig {
  const localPath = resolve(cwd, "codex-cost.config.json");
  const userPath = join(homedir(), ".config", "codex-cost", "config.json");
  const path = existsSync(localPath) ? localPath : existsSync(userPath) ? userPath : null;
  const raw = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  const parsed = configSchema.parse(raw);
  return {
    ...parsed,
    codexHome: resolve(expandHome(parsed.codexHome)),
    projectRules: parsed.projectRules.map((rule) => ({ ...rule, pathPrefix: resolve(expandHome(rule.pathPrefix)) }))
  };
}

export function projectForThread(config: CodexCostConfig, threadId: string, cwd?: string): { id: string; name: string } {
  const override = config.threadOverrides[threadId];
  if (override?.projectId) {
    return { id: override.projectId, name: override.projectName ?? override.projectId };
  }

  const resolvedCwd = cwd ? resolve(expandHome(cwd)) : "";
  const rule = config.projectRules.find((candidate) => resolvedCwd.startsWith(candidate.pathPrefix));
  if (rule) return { id: rule.id, name: rule.name ?? rule.id };

  const fallback = resolvedCwd ? basename(resolvedCwd) : "unknown";
  return { id: fallback || "unknown", name: fallback || "unknown" };
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}
