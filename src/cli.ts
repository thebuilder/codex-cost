#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { select } from "@inquirer/prompts";
import { Command } from "commander";
import { scanCodex } from "./codex-parser.ts";
import { loadConfig } from "./config.ts";
import { terminalProjectReport, terminalThreadReport, writeCsv, writeJson, writeXlsx } from "./exporters.ts";
import { buildReports } from "./pricing.ts";

const program = new Command();

program
  .name("codex-cost")
  .description("Estimate local Codex thread token usage, dollar cost, and credits")
  .version("0.1.0")
  .action(async () => {
    const { reports, config } = await loadReports();
    const projectId = await select({
      message: "Select project",
      choices: reports.map((project) => ({ name: `${project.projectName} (${project.threadCount} threads)`, value: project.projectId }))
    });
    const project = reports.find((candidate) => candidate.projectId === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const threadId = await select({
      message: "Select thread",
      choices: [
        { name: "Project summary", value: "__project__" },
        ...project.threads.map((thread) => ({ name: `${thread.name} (${thread.threadId})`, value: thread.threadId }))
      ]
    });
    console.log(threadId === "__project__" ? terminalProjectReport(project, config.currency) : terminalThreadReport(project.threads.find((thread) => thread.threadId === threadId)!, config.currency));
  });

program.command("scan").option("--json", "print JSON").description("Debug parsed session counts and skipped records").action(async (options) => {
  const config = loadConfig();
  const scan = await scanCodex(config);
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
  const { reports, config } = await loadReports();
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

program.command("export").requiredOption("--format <format>", "xlsx, csv, or json").requiredOption("--out <file>").description("Export reports").action(async (options) => {
  const { reports, config } = await loadReports();
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  if (options.format === "json") await writeJson(out, reports);
  else if (options.format === "csv") await writeCsv(out, reports);
  else if (options.format === "xlsx") await writeXlsx(out, reports, config);
  else throw new Error(`Unsupported format: ${options.format}`);
  console.log(`Wrote ${out}`);
});

async function loadReports() {
  const config = loadConfig();
  const scan = await scanCodex(config);
  return { config, scan, reports: buildReports(scan.events, config, scan.threadNames) };
}

await program.parseAsync();
