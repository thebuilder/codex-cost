import { writeFile } from "node:fs/promises";
import Table from "cli-table3";
import ExcelJS from "exceljs";
import pc from "picocolors";
import type { CodexCostConfig } from "./config.ts";
import { allRateCards } from "./pricing.ts";
import type { ProjectReport, ThreadReport, UsageEvent } from "./types.ts";

export function terminalProjectReport(project: ProjectReport, currency: string): string {
  return [
    title(project.projectName),
    metaTable(withUnknownModelWarning(project.unpriced, [
      ["Project", project.projectId],
      ["Range", formatRange(project.timeRange)],
      ["Threads", formatInteger(project.threadCount)],
      ["Estimated", pc.green(formatMoney(project.estimatedDollars, currency))]
    ])),
    "",
    tokenTable(project.tokenTotals),
    "",
    threadSummaryTable(project.threads, currency)
  ].join("\n");
}

export function terminalThreadReport(thread: ThreadReport, currency: string): string {
  return [
    title(thread.name),
    metaTable(withUnknownModelWarning(thread.unpriced, [
      ["Project", `${thread.projectName} (${thread.projectId})`],
      ["cwd", thread.cwd || "n/a"],
      ["Range", formatRange(thread.timeRange)],
      ["Models", thread.models.join(", ") || "unknown"],
      ["Plan", thread.planTypes.join(", ") || "unknown"],
      ["Estimated", pc.green(formatMoney(thread.estimatedDollars, currency))]
    ])),
    "",
    tokenTable(thread.tokenTotals)
  ].join("\n");
}

export function terminalRateCard(config: CodexCostConfig, currency: string): string {
  const table = new Table({
    head: ["Model", "Input /M", "Cached /M", "Output /M", "Reasoning /M"].map((label) => pc.bold(label)),
    chars: minimalTableChars(),
    style: { head: [], border: [] }
  });
  for (const [model, rate] of Object.entries(allRateCards(config)).sort(([left], [right]) => compareRateModels(left, right))) {
    table.push([
      model,
      formatRate(rate.inputPerMillion, currency),
      formatRate(rate.cachedInputPerMillion, currency),
      formatRate(rate.outputPerMillion, currency),
      rate.reasoningOutputPerMillion === undefined ? pc.dim("same as output") : formatRate(rate.reasoningOutputPerMillion, currency)
    ]);
  }
  return [title("Rate card"), table.toString()].join("\n");
}

export async function writeJson(path: string, reports: ProjectReport[]): Promise<void> {
  await writeFile(path, `${JSON.stringify({ projects: reports.map(jsonProject) }, null, 2)}\n`);
}

export async function writeCsv(path: string, reports: ProjectReport[]): Promise<void> {
  const rows = [
    ["Project", "Thread", "Models", "Plan Types", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars", "Unpriced"]
  ];
  for (const thread of reports.flatMap((project) => project.threads)) {
    rows.push([
      thread.projectName,
      thread.name,
      thread.models.join(";"),
      thread.planTypes.join(";"),
      String(thread.tokenTotals.inputTokens),
      String(thread.tokenTotals.cachedInputTokens),
      String(thread.tokenTotals.outputTokens),
      String(thread.tokenTotals.reasoningOutputTokens),
      String(thread.estimatedDollars),
      thread.unpriced.join(";")
    ]);
  }
  await writeFile(path, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`);
}

export async function writeXlsx(path: string, reports: ProjectReport[], config: CodexCostConfig): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "codex-cost";
  workbook.calcProperties.fullCalcOnLoad = true;
  const summaryLastProjectRow = Math.max(2, reports.length + 1);
  const threads = reports.flatMap((project) => project.threads);
  const events = threads.flatMap((thread) => thread.events.map((event) => ({ event, thread })));

  const summary = workbook.addWorksheet("Summary");
  addTable(summary, "SummaryTable", ["Project", "Threads", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"], reports.map((project, index) => summaryRow(project, index + 2)));
  summary.addRow([
    "Grand Total",
    { formula: `SUM(B2:B${summaryLastProjectRow})` },
    { formula: `SUM(C2:C${summaryLastProjectRow})` },
    { formula: `SUM(D2:D${summaryLastProjectRow})` },
    { formula: `SUM(E2:E${summaryLastProjectRow})` },
    { formula: `SUM(F2:F${summaryLastProjectRow})` },
    { formula: `SUM(G2:G${summaryLastProjectRow})` }
  ]);

  addTable(
    workbook.addWorksheet("Projects"),
    "ProjectsTable",
    ["Project Name", "Start", "End", "Threads", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars", "Unpriced"],
    reports.map((project, index) => projectRow(project, index + 2))
  );
  addTable(
    workbook.addWorksheet("Threads"),
    "ThreadsTable",
    ["Project", "Thread", "Models", "Plan Types", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars", "Unpriced"],
    threads.map((thread, index) => threadRow(thread, index + 2))
  );
  addTable(
    workbook.addWorksheet("Turns"),
    "TurnsTable",
    ["Timestamp", "Thread", "Turn ID", "Model", "Plan Type", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"],
    events.map(({ event, thread }, index) => eventRow(event, thread, index + 2))
  );
  addTable(
    workbook.addWorksheet("RateCard"),
    "RateCardTable",
    ["Model", "Input $/M", "Cached Input $/M", "Output $/M", "Reasoning Output $/M"],
    Object.entries(allRateCards(config)).map(([model, rate]) => [model, rate.inputPerMillion ?? "", rate.cachedInputPerMillion ?? "", rate.outputPerMillion ?? "", rate.reasoningOutputPerMillion ?? ""])
  );

  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => {
      const widths = Array.from(column.values ?? [], (value) => String(value ?? "").length + 2);
      column.width = Math.min(48, Math.max(12, ...widths.filter(Number.isFinite)));
      column.hidden = false;
    });
  }
  formatColumn(summary, 7, "$#,##0.000000");
  formatColumn(workbook.getWorksheet("Projects"), 9, "$#,##0.000000");
  formatColumn(workbook.getWorksheet("Threads"), 9, "$#,##0.000000");
  formatColumn(workbook.getWorksheet("Turns"), 10, "$#,##0.000000");
  for (const column of [2, 3, 4, 5]) {
    formatColumn(workbook.getWorksheet("RateCard"), column, "$#,##0.000");
  }
  await workbook.xlsx.writeFile(path);
}

function addTable(sheet: ExcelJS.Worksheet, name: string, headers: string[], rows: any[][]): void {
  sheet.addTable({
    name,
    ref: "A1",
    headerRow: true,
    totalsRow: false,
    style: {
      theme: "TableStyleMedium2",
      showRowStripes: true
    },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows
  });
}

function formatColumn(sheet: ExcelJS.Worksheet | undefined, columnNumber: number, format: string): void {
  sheet?.getColumn(columnNumber).eachCell((cell, rowNumber) => {
    if (rowNumber > 1) cell.numFmt = format;
  });
}

function title(value: string): string {
  return pc.bold(pc.cyan(value));
}

function metaTable(rows: Array<[string, string]>): string {
  const table = new Table({
    chars: minimalTableChars(),
    style: { head: [], border: [] },
    colWidths: [14, Math.min(96, Math.max(40, terminalWidth() - 18))],
    wordWrap: true
  });
  for (const [label, value] of rows) {
    table.push([pc.dim(label), value]);
  }
  return table.toString();
}

function tokenTable(totals: ThreadReport["tokenTotals"]): string {
  const table = new Table({
    head: ["Input", "Cached", "Billable", "Output", "Reasoning", "Total"].map((label) => pc.bold(label)),
    chars: minimalTableChars(),
    style: { head: [], border: [] }
  });
  table.push([
    formatInteger(totals.inputTokens),
    formatInteger(totals.cachedInputTokens),
    formatInteger(totals.billableInputTokens),
    formatInteger(totals.outputTokens),
    formatInteger(totals.reasoningOutputTokens),
    formatInteger(totals.totalTokens)
  ]);
  return table.toString();
}

function threadSummaryTable(threads: ThreadReport[], currency: string): string {
  const visibleThreads = [...threads].sort((a, b) => b.estimatedDollars - a.estimatedDollars).slice(0, 50);
  const widths = threadTableWidths(visibleThreads, currency);
  const table = new Table({
    head: ["Thread", "Cost", "Tokens", "Models"].map((label) => pc.bold(label)),
    chars: minimalTableChars(),
    style: { head: [], border: [] },
    colWidths: widths,
    wordWrap: true
  });
  for (const thread of visibleThreads) {
    table.push([
      thread.name,
      pc.green(formatMoney(thread.estimatedDollars, currency)),
      formatInteger(thread.tokenTotals.totalTokens),
      thread.models.join(", ")
    ]);
  }
  const hiddenCount = threads.length - visibleThreads.length;
  return hiddenCount > 0 ? `${table.toString()}\n${pc.dim(`Showing top ${visibleThreads.length} threads by cost. ${hiddenCount} more in exports.`)}` : table.toString();
}

function threadTableWidths(threads: ThreadReport[], currency: string): [number, number, number, number] {
  const gapWidth = 6;
  const available = Math.min(132, Math.max(90, terminalWidth())) - gapWidth;
  const costWidth = clamp(
    Math.max(12, ...threads.map((thread) => formatMoney(thread.estimatedDollars, currency).length + 2)),
    14,
    22
  );
  const tokenWidth = clamp(
    Math.max(10, ...threads.map((thread) => formatInteger(thread.tokenTotals.totalTokens).length + 2)),
    16,
    20
  );
  const modelWidth = clamp(
    Math.max(16, ...threads.map((thread) => thread.models.join(", ").length + 2)),
    20,
    38
  );
  const threadWidth = Math.max(24, available - costWidth - tokenWidth - modelWidth);
  return [threadWidth, costWidth, tokenWidth, modelWidth];
}

function terminalWidth(): number {
  return process.stdout.columns || Number(process.env.COLUMNS) || 120;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function compareRateModels(left: string, right: string): number {
  const leftParts = parseGptVersion(left);
  const rightParts = parseGptVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const diff = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.localeCompare(right);
}

function parseGptVersion(model: string): number[] {
  const match = /^gpt-(\d+(?:\.\d+)*)/.exec(model);
  return match ? match[1].split(".").map(Number) : [];
}

function minimalTableChars() {
  return {
    top: "",
    "top-mid": "",
    "top-left": "",
    "top-right": "",
    bottom: "",
    "bottom-mid": "",
    "bottom-left": "",
    "bottom-right": "",
    left: "",
    "left-mid": "",
    mid: "",
    "mid-mid": "",
    right: "",
    "right-mid": "",
    middle: "  "
  };
}

function formatRange(range: { start: string | null; end: string | null }): string {
  return `${formatDate(range.start)} -> ${formatDate(range.end)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function withUnknownModelWarning(models: string[], rows: Array<[string, string]>): Array<[string, string]> {
  if (!models.length) return rows;
  return [...rows, ["Warning", pc.yellow(`Unknown model rate: ${models.join(", ")}`)]];
}

function jsonProject(project: ProjectReport) {
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    timeRange: project.timeRange,
    threadCount: project.threadCount,
    tokenTotals: project.tokenTotals,
    estimatedDollars: project.estimatedDollars,
    unpriced: project.unpriced,
    threads: project.threads.map(jsonThread)
  };
}

function jsonThread(thread: ThreadReport) {
  return {
    name: thread.name,
    projectId: thread.projectId,
    projectName: thread.projectName,
    cwd: thread.cwd,
    models: thread.models,
    planTypes: thread.planTypes,
    speed: thread.speed,
    timeRange: thread.timeRange,
    tokenTotals: thread.tokenTotals,
    estimatedDollars: thread.estimatedDollars,
    unpriced: thread.unpriced,
    turns: thread.events.map((event) => ({
      timestamp: event.timestamp,
      turnId: event.turnId,
      model: event.model,
      planType: event.planType,
      inputTokens: event.inputTokens,
      cachedInputTokens: event.cachedInputTokens,
      outputTokens: event.outputTokens,
      reasoningOutputTokens: event.reasoningOutputTokens
    }))
  };
}

function summaryRow(project: ProjectReport, rowNumber: number): any[] {
  return [
    project.projectName,
    project.threadCount,
    project.tokenTotals.inputTokens,
    project.tokenTotals.cachedInputTokens,
    project.tokenTotals.outputTokens,
    project.tokenTotals.reasoningOutputTokens,
    { formula: `SUMIF(Projects!$A:$A,A${rowNumber},Projects!$I:$I)` }
  ];
}

function projectRow(project: ProjectReport, rowNumber: number): any[] {
  return [
    project.projectName,
    project.timeRange.start,
    project.timeRange.end,
    project.threadCount,
    project.tokenTotals.inputTokens,
    project.tokenTotals.cachedInputTokens,
    project.tokenTotals.outputTokens,
    project.tokenTotals.reasoningOutputTokens,
    { formula: `SUMIF(Threads!$A:$A,A${rowNumber},Threads!$I:$I)` },
    project.unpriced.join("; ")
  ];
}

function threadRow(thread: ThreadReport, rowNumber: number): any[] {
  return [
    thread.projectName,
    thread.name,
    thread.models.join("; "),
    thread.planTypes.join("; "),
    thread.tokenTotals.inputTokens,
    thread.tokenTotals.cachedInputTokens,
    thread.tokenTotals.outputTokens,
    thread.tokenTotals.reasoningOutputTokens,
    { formula: `SUMIF(Turns!$B:$B,B${rowNumber},Turns!$J:$J)` },
    thread.unpriced.join("; ")
  ];
}

function eventRow(event: UsageEvent, thread: ThreadReport, rowNumber: number): any[] {
  return [
    event.timestamp,
    thread.name,
    event.turnId ?? "",
    event.model,
    event.planType,
    event.inputTokens,
    event.cachedInputTokens,
    event.outputTokens,
    event.reasoningOutputTokens,
    { formula: dollarFormula(rowNumber) }
  ];
}

function dollarFormula(rowNumber: number): string {
  const model = `D${rowNumber}`;
  const input = `F${rowNumber}`;
  const cached = `G${rowNumber}`;
  const output = `H${rowNumber}`;
  const reasoning = `I${rowNumber}`;
  const inputRate = `VLOOKUP(${model},RateCard!$A:$E,2,FALSE)`;
  const cachedRate = `VLOOKUP(${model},RateCard!$A:$E,3,FALSE)`;
  const outputRate = `VLOOKUP(${model},RateCard!$A:$E,4,FALSE)`;
  const reasoningRate = `VLOOKUP(${model},RateCard!$A:$E,5,FALSE)`;
  return `IFERROR(((${input}-${cached})*${inputRate}+${cached}*${cachedRate}+${output}*${outputRate}+${reasoning}*IF(${reasoningRate}="",${outputRate},${reasoningRate}))/1000000,"")`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatRate(value: number | undefined, currency: string): string {
  if (value === undefined) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
}
