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
      ["Work time", formatDuration(project.durationMs)],
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
      ["Work time", formatDuration(thread.durationMs)],
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
    ["Project", "Thread", "Work Time", "Models", "Plan Types", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"]
  ];
  for (const thread of reports.flatMap((project) => project.threads)) {
    rows.push([
      thread.projectName,
      thread.name,
      formatDuration(thread.durationMs),
      thread.models.join(";"),
      thread.planTypes.join(";"),
      String(thread.tokenTotals.inputTokens),
      String(thread.tokenTotals.cachedInputTokens),
      String(thread.tokenTotals.outputTokens),
      String(thread.tokenTotals.reasoningOutputTokens),
      String(thread.estimatedDollars)
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
  addTable(summary, "SummaryTable", ["Project", "Threads", "Work Time", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"], reports.map((project, index) => summaryRow(project, index + 2)));
  summary.addRow([
    "Grand Total",
    { formula: `SUM(B2:B${summaryLastProjectRow})` },
    formatDuration(sum(reports.map((project) => project.durationMs))),
    { formula: `SUM(D2:D${summaryLastProjectRow})` },
    { formula: `SUM(E2:E${summaryLastProjectRow})` },
    { formula: `SUM(F2:F${summaryLastProjectRow})` },
    { formula: `SUM(G2:G${summaryLastProjectRow})` },
    { formula: `SUM(H2:H${summaryLastProjectRow})` }
  ]);

  addTable(
    workbook.addWorksheet("Projects"),
    "ProjectsTable",
    ["Project Name", "Start", "End", "Work Time", "Threads", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"],
    reports.map((project, index) => projectRow(project, index + 2))
  );
  addTable(
    workbook.addWorksheet("Threads"),
    "ThreadsTable",
    ["Project", "Thread", "Work Time", "Models", "Plan Types", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"],
    threads.map((thread, index) => threadRow(thread, index + 2))
  );
  addTable(
    workbook.addWorksheet("Turns"),
    "TurnsTable",
    ["Timestamp", "Started At", "Work Time", "Thread", "Turn ID", "Model", "Plan Type", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"],
    events.map(({ event, thread }, index) => eventRow(event, thread, index + 2))
  );
  addTable(
    workbook.addWorksheet("RateCard"),
    "RateCardTable",
    ["Model", "Input $/M", "Cached Input $/M", "Output $/M", "Reasoning Output $/M"],
    Object.entries(allRateCards(config)).map(([model, rate]) => [model, rate.inputPerMillion ?? "", rate.cachedInputPerMillion ?? "", rate.outputPerMillion ?? "", rate.reasoningOutputPerMillion ?? ""])
  );

  styleWorkbook(workbook);
  formatColumn(summary, 8, "$#,##0.000000");
  formatColumns(summary, [2, 4, 5, 6, 7], "#,##0");
  formatColumns(workbook.getWorksheet("Projects"), [5, 6, 7, 8, 9], "#,##0");
  formatColumns(workbook.getWorksheet("Threads"), [6, 7, 8, 9], "#,##0");
  formatColumns(workbook.getWorksheet("Turns"), [8, 9, 10, 11], "#,##0");
  formatColumns(workbook.getWorksheet("Projects"), [2, 3], "yyyy-mm-dd");
  formatColumns(workbook.getWorksheet("Turns"), [1, 2], "yyyy-mm-dd hh:mm:ss");
  formatColumn(workbook.getWorksheet("Projects"), 10, "$#,##0.000000");
  formatColumn(workbook.getWorksheet("Threads"), 10, "$#,##0.000000");
  formatColumn(workbook.getWorksheet("Turns"), 12, "$#,##0.000000");
  for (const column of [2, 3, 4, 5]) {
    formatColumn(workbook.getWorksheet("RateCard"), column, "$#,##0.000");
  }
  flagUnpricedCostCells(workbook.getWorksheet("Projects"), reports, 10);
  flagUnpricedCostCells(workbook.getWorksheet("Threads"), threads, 10);
  await workbook.xlsx.writeFile(path);
}

function styleWorkbook(workbook: ExcelJS.Workbook): void {
  const widths: Record<string, number[]> = {
    Summary: [28, 12, 14, 16, 16, 16, 16, 18],
    Projects: [28, 14, 14, 14, 12, 16, 16, 16, 16, 18],
    Threads: [22, 36, 14, 28, 22, 16, 16, 16, 16, 18],
    Turns: [22, 22, 14, 36, 28, 20, 18, 16, 16, 16, 16, 18],
    RateCard: [24, 16, 18, 16, 20]
  };

  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.properties.defaultRowHeight = 18;
    sheet.getRow(1).height = 22;
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).alignment = { vertical: "middle" };
    sheet.columns.forEach((column, index) => {
      column.width = widths[sheet.name]?.[index] ?? inferColumnWidth(column);
      column.hidden = false;
      column.alignment = { vertical: "middle" };
    });
  }

  const summary = workbook.getWorksheet("Summary");
  boldColumn(summary, 1);
  boldColumn(workbook.getWorksheet("Projects"), 1);
  const total = summary?.lastRow;
  if (total) {
    for (let columnNumber = 1; columnNumber <= 8; columnNumber++) {
      const cell = total.getCell(columnNumber);
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
      cell.border = { top: { style: "thin", color: { argb: "FF60A5FA" } } };
    }
  }
}

function inferColumnWidth(column: Partial<ExcelJS.Column>): number {
  const widths = Array.from(column.values ?? [], (value) => String(value ?? "").length + 2);
  return Math.min(48, Math.max(12, ...widths.filter(Number.isFinite)));
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

function formatColumns(sheet: ExcelJS.Worksheet | undefined, columnNumbers: number[], format: string): void {
  for (const columnNumber of columnNumbers) {
    formatColumn(sheet, columnNumber, format);
  }
}

function boldColumn(sheet: ExcelJS.Worksheet | undefined, columnNumber: number): void {
  sheet?.getColumn(columnNumber).eachCell((cell, rowNumber) => {
    if (rowNumber > 1) cell.font = { ...(cell.font ?? {}), bold: true };
  });
}

function flagUnpricedCostCells(sheet: ExcelJS.Worksheet | undefined, rows: Array<{ unpriced: string[] }>, columnNumber: number): void {
  if (!sheet) return;
  rows.forEach((row, index) => {
    if (row.unpriced.length === 0) return;
    const cell = sheet.getCell(index + 2, columnNumber);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE4E6" } };
    cell.font = { ...(cell.font ?? {}), color: { argb: "FF991B1B" } };
    cell.note = `Unknown model rate: ${row.unpriced.join(", ")}`;
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
    head: ["Thread", "Cost", "Tokens", "Time", "Models"].map((label) => pc.bold(label)),
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
      formatDuration(thread.durationMs),
      thread.models.join(", ")
    ]);
  }
  const hiddenCount = threads.length - visibleThreads.length;
  return hiddenCount > 0 ? `${table.toString()}\n${pc.dim(`Showing top ${visibleThreads.length} threads by cost. ${hiddenCount} more in exports.`)}` : table.toString();
}

function threadTableWidths(threads: ThreadReport[], currency: string): [number, number, number, number, number] {
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
  const timeWidth = 12;
  const threadWidth = Math.max(24, available - costWidth - tokenWidth - timeWidth - modelWidth);
  return [threadWidth, costWidth, tokenWidth, timeWidth, modelWidth];
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

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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
    durationMs: project.durationMs,
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
    durationMs: thread.durationMs,
    tokenTotals: thread.tokenTotals,
    estimatedDollars: thread.estimatedDollars,
    unpriced: thread.unpriced,
    turns: thread.events.map((event) => ({
      timestamp: event.timestamp,
      startedAt: event.startedAt,
      durationMs: event.durationMs,
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
    formatDuration(project.durationMs),
    project.tokenTotals.inputTokens,
    project.tokenTotals.cachedInputTokens,
    project.tokenTotals.outputTokens,
    project.tokenTotals.reasoningOutputTokens,
    { formula: `SUMIF(Projects!$A:$A,A${rowNumber},Projects!$J:$J)` }
  ];
}

function projectRow(project: ProjectReport, rowNumber: number): any[] {
  return [
    project.projectName,
    project.timeRange.start,
    project.timeRange.end,
    formatDuration(project.durationMs),
    project.threadCount,
    project.tokenTotals.inputTokens,
    project.tokenTotals.cachedInputTokens,
    project.tokenTotals.outputTokens,
    project.tokenTotals.reasoningOutputTokens,
    { formula: `SUMIF(Threads!$A:$A,A${rowNumber},Threads!$J:$J)` }
  ];
}

function threadRow(thread: ThreadReport, rowNumber: number): any[] {
  return [
    thread.projectName,
    thread.name,
    formatDuration(thread.durationMs),
    thread.models.join("; "),
    thread.planTypes.join("; "),
    thread.tokenTotals.inputTokens,
    thread.tokenTotals.cachedInputTokens,
    thread.tokenTotals.outputTokens,
    thread.tokenTotals.reasoningOutputTokens,
    { formula: `SUMIF(Turns!$D:$D,B${rowNumber},Turns!$L:$L)` }
  ];
}

function eventRow(event: UsageEvent, thread: ThreadReport, rowNumber: number): any[] {
  return [
    event.timestamp,
    event.startedAt ?? "",
    event.durationMs === null ? "" : formatDuration(event.durationMs),
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
  const model = `F${rowNumber}`;
  const input = `H${rowNumber}`;
  const cached = `I${rowNumber}`;
  const output = `J${rowNumber}`;
  const reasoning = `K${rowNumber}`;
  const inputRate = `VLOOKUP(${model},RateCard!$A:$E,2,FALSE)`;
  const cachedRate = `VLOOKUP(${model},RateCard!$A:$E,3,FALSE)`;
  const outputRate = `VLOOKUP(${model},RateCard!$A:$E,4,FALSE)`;
  const reasoningRate = `VLOOKUP(${model},RateCard!$A:$E,5,FALSE)`;
  return `IFERROR(((${input}-${cached})*${inputRate}+${cached}*${cachedRate}+${output}*${outputRate}+${reasoning}*IF(${reasoningRate}="",${outputRate},${reasoningRate}))/1000000,"")`;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatRate(value: number | undefined, currency: string): string {
  if (value === undefined) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
}
