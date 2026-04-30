#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { input, select } from "@inquirer/prompts";
import { Command } from "commander";
import ora from "ora";
import { scanCodex, scanCodexIndex, type ScanOptions } from "./codex-parser.ts";
import { loadConfig } from "./config.ts";
import { dateRangeFromPreset, filterEventsByDateRange, parseDateRange, type DateRange, type DateRangePreset } from "./date-range.ts";
import { terminalProjectReport, terminalRateCard, terminalThreadReport, writeCsv, writeJson, writeXlsx } from "./exporters.ts";
import { buildReports } from "./pricing.ts";
import type { ProjectReport } from "./types.ts";

const program = new Command();

program
  .name("codex-cost")
  .description("Estimate local Codex thread token usage, dollar cost, and credits")
  .version("0.1.0")
  .action(async () => {
    const action = await select<"report" | "export" | "rates">({
      message: "What do you want to do?",
      choices: [
        { name: "Report", value: "report" },
        { name: "Export", value: "export" },
        { name: "Rates", value: "rates" }
      ]
    });
    if (action === "rates") {
      const config = loadConfig();
      console.log(terminalRateCard(config, config.currency));
      return;
    }
    if (action === "export") {
      await runInteractiveExport();
      return;
    }
    await runInteractiveReport();
  });

program.command("rates").description("Print the active rate card").action(() => {
  const config = loadConfig();
  console.log(terminalRateCard(config, config.currency));
});

async function runInteractiveReport() {
  const dateRange = await selectDateRange();
  const { config, index } = await loadIndex({ status: true });
  if (index.projects.length === 0) {
    console.log("No Codex projects found.");
    return;
  }
  const projectId = await select({
    message: `Select project (${dateRange.label})`,
    choices: index.projects.map((project) => ({ name: `${project.projectName} (${project.threadCount} threads)`, value: project.projectId }))
  });
  const { reports } = await loadReports({ status: true, dateRange, scanOptions: { projectId } });
  const project = reports.find((candidate) => candidate.projectId === projectId);
  if (!project) {
    console.log(`No usage found for ${projectId} in ${dateRange.label}.`);
    return;
  }
  const threadId = await select({
    message: "Select thread",
    choices: [
      { name: "Project summary", value: "__project__" },
      ...project.threads.map((thread) => ({ name: `${thread.name} (${thread.threadId})`, value: thread.threadId }))
    ]
  });
  const thread = project.threads.find((candidate) => candidate.threadId === threadId);
  console.log(threadId === "__project__" ? terminalProjectReport(project, config.currency) : terminalThreadReport(thread!, config.currency));
}

async function runInteractiveExport() {
  const format = await select<"xlsx" | "csv" | "json">({
    message: "Select export format",
    choices: [
      { name: "Excel workbook (.xlsx)", value: "xlsx" },
      { name: "CSV (.csv)", value: "csv" },
      { name: "JSON (.json)", value: "json" }
    ]
  });
  const dateRange = await selectDateRange();
  const out = await input({
    message: "Filename",
    default: defaultExportFilename(format),
    validate: (value) => (value.trim().length > 0 ? true : "Enter a filename")
  });
  const { reports, config } = await loadReports({ status: true, dateRange });
  await writeReport(format, resolve(out), reports, config);
}

program.command("scan").option("--json", "print JSON").description("Debug parsed session counts and skipped records").action(async (options) => {
  const config = loadConfig();
  const spinner = options.json ? null : startSpinner("Scanning Codex sessions");
  const scan = await scanCodex(config);
  spinner?.succeed(`Scanned ${scan.filesRead} files and ${scan.events.length} usage events`);
  const payload = {
    filesRead: scan.filesRead,
    events: scan.events.length,
    threads: new Set(scan.events.map((event) => event.threadId)).size,
    skippedRecords: scan.skippedRecords,
    duplicateRecords: scan.duplicateRecords
  };
  console.log(options.json ? JSON.stringify(payload, null, 2) : payload);
});

program.command("report").option("--project <id>").option("--thread <thread-id>").description("Print a terminal report").action(async (options) => {
  const scanOptions: ScanOptions = options.thread ? { threadId: options.thread } : options.project ? { projectId: options.project } : {};
  const { reports, config } = await loadReports({ status: true, scanOptions });
  if (options.thread) {
    const thread = reports.flatMap((project) => project.threads).find((candidate) => candidate.threadId === options.thread);
    if (!thread) throw new Error(`Thread not found: ${options.thread}`);
    console.log(terminalThreadReport(thread, config.currency));
    return;
  }
  if (options.project) {
    const project = reports.find((candidate) => candidate.projectId === options.project);
    if (!project) throw new Error(`Project not found: ${options.project}`);
    console.log(terminalProjectReport(project, config.currency));
    return;
  }
  throw new Error("Provide --project <id> or --thread <thread-id>");
});

program.command("export").option("--format <format>", "xlsx, csv, or json", "xlsx").option("--out <file>").option("--range <range>", "all, 1d, 1w, 1m, or month name", "all").description("Export reports").action(async (options) => {
  const dateRange = parseDateRange(options.range);
  const { reports, config } = await loadReports({ status: true, dateRange });
  const format = options.format as string;
  const out = resolve(options.out ?? defaultExportFilename(format));
  await writeReport(format, out, reports, config);
});

async function writeReport(format: string, out: string, reports: ProjectReport[], config: ReturnType<typeof loadConfig>) {
  await mkdir(dirname(out), { recursive: true });
  if (format !== "json" && format !== "csv" && format !== "xlsx") throw new Error(`Unsupported format: ${format}`);
  const spinner = startSpinner(`Writing ${format.toUpperCase()} report`);
  try {
    if (format === "json") await writeJson(out, reports);
    else if (format === "csv") await writeCsv(out, reports);
    else await writeXlsx(out, reports, config);
    spinner?.succeed(`Wrote ${out}`);
  } catch (error) {
    spinner?.fail("Failed to write report");
    throw error;
  }
}

async function selectDateRange(): Promise<DateRange> {
  const dateRangePreset = await select<DateRangePreset | "month">({
    message: "Select date range",
    choices: [
      { name: "All time", value: "all" },
      { name: "Past 1 day", value: "1d" },
      { name: "Past 1 week", value: "1w" },
      { name: "Past 1 month", value: "1m" },
      { name: "Specific month...", value: "month" }
    ]
  });
  if (dateRangePreset !== "month") return dateRangeFromPreset(dateRangePreset);
  return parseDateRange(
    await input({
      message: "Month name",
      validate: (value) => {
        try {
          parseDateRange(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : "Invalid month";
        }
      }
    })
  );
}

async function loadReports(options: { status?: boolean; dateRange?: ReturnType<typeof parseDateRange>; scanOptions?: ScanOptions } = {}) {
  const { config, scan } = await loadScan(options);
  const events = options.dateRange ? filterEventsByDateRange(scan.events, options.dateRange) : scan.events;
  const spinner = options.status ? startSpinner(`Building reports from ${events.length} usage events`) : null;
  try {
    const reports = buildReports(events, config, scan.threadNames);
    spinner?.succeed(`Built ${reports.length} project reports from ${scan.filesRead} files`);
    return { config, scan, reports };
  } catch (error) {
    spinner?.fail("Failed to build reports");
    throw error;
  }
}

async function loadScan(options: { status?: boolean; scanOptions?: ScanOptions } = {}) {
  const spinner = options.status ? startSpinner("Loading configuration") : null;
  try {
    const config = loadConfig();
    spinner?.setText("Scanning Codex sessions");
    const scan = await scanCodex(config, options.scanOptions);
    spinner?.succeed(`Scanned ${scan.filesRead} files and ${scan.events.length} usage events`);
    return { config, scan };
  } catch (error) {
    spinner?.fail("Failed to scan Codex sessions");
    throw error;
  }
}

async function loadIndex(options: { status?: boolean } = {}) {
  const spinner = options.status ? startSpinner("Loading configuration") : null;
  try {
    const config = loadConfig();
    spinner?.setText("Indexing Codex sessions");
    const index = await scanCodexIndex(config);
    spinner?.succeed(`Indexed ${index.filesRead} files and ${index.projects.length} projects`);
    return { config, index };
  } catch (error) {
    spinner?.fail("Failed to index Codex sessions");
    throw error;
  }
}

type Status = {
  setText(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
};

function startSpinner(text: string): Status | null {
  if (process.stderr.isTTY) {
    const spinner = ora({ text, stream: process.stderr }).start();
    return {
      setText(nextText) {
        spinner.text = nextText;
      },
      succeed(nextText) {
        spinner.succeed(nextText);
      },
      fail(nextText) {
        spinner.fail(nextText);
      }
    };
  }
  process.stderr.write(`${text}\n`);
  return {
    setText(nextText) {
      process.stderr.write(`${nextText}\n`);
    },
    succeed(nextText) {
      process.stderr.write(`${nextText}\n`);
    },
    fail(nextText) {
      process.stderr.write(`${nextText}\n`);
    }
  };
}

function defaultExportFilename(format: string): string {
  const extension = format === "csv" || format === "json" || format === "xlsx" ? format : "xlsx";
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `codex-cost-report-${timestamp}.${extension}`;
}

try {
  await program.parseAsync();
} catch (error) {
  if (isPromptInterrupted(error)) {
    process.stderr.write("\n");
    process.exit(130);
  }
  throw error;
}

function isPromptInterrupted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ExitPromptError" ||
      error.message.includes("User force closed the prompt") ||
      error.message.includes("SIGINT"))
  );
}
