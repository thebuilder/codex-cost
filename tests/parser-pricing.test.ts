import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { scanCodex } from "../src/codex-parser.ts";
import type { CodexCostConfig } from "../src/config.ts";
import { filterEventsByDateRange, parseDateRange } from "../src/date-range.ts";
import { allRateCards, buildReports } from "../src/pricing.ts";

const fixtureCodexHome = resolve("tests/fixtures/codex");

function fixtureConfig(overrides: Partial<CodexCostConfig> = {}): CodexCostConfig {
  return {
    codexHome: fixtureCodexHome,
    currency: "USD",
    projectRules: [
      { id: "client-a", name: "Client A", pathPrefix: "/work/client-a" },
      { id: "client-b", name: "Client B", pathPrefix: "/work/client-b" }
    ],
    threadOverrides: {},
    rateCards: {
      "gpt-5.4-mini": {
        inputPerMillion: 0.25,
        cachedInputPerMillion: 0.025,
        outputPerMillion: 2,
        reasoningOutputPerMillion: 2,
        creditsPerMillionInput: 1,
        creditsPerMillionCachedInput: 0.1,
        creditsPerMillionOutput: 4
      }
    },
    speedOverrides: {},
    ...overrides
  };
}

test("parses codex JSONL usage, names, duplicates, credits, and speed", async () => {
  const scan = await scanCodex(fixtureConfig());
  assert.equal(scan.filesRead, 3);
  assert.equal(scan.events.length, 5);
  assert.equal(scan.duplicateRecords, 1);
  assert.equal(scan.skippedRecords, 0);
  assert.equal(scan.threadNames.get("credit-thread"), "Renamed Credit Thread");

  const first = scan.events.find((event) => event.threadId === "fixture-thread" && event.model === "gpt-5.4-mini");
  assert.equal(first?.turnId, "turn-1");
  assert.equal(first?.startedAt, "2026-04-12T10:01:00.000Z");
  assert.equal(first?.durationMs, 60_000);
  assert.equal(first?.planType, "prolite");
  assert.equal(first?.credits, null);
  assert.equal(first?.speed, "unknown");

  const credit = scan.events.find((event) => event.threadId === "credit-thread");
  assert.deepEqual(credit?.credits, { hasCredits: true, balance: 41 });
});

test("builds reports with billable input, pricing, unpriced models, and override attribution", async () => {
  const config = fixtureConfig({
    threadOverrides: {
      "fixture-thread": { projectId: "override-project", projectName: "Override Project", name: "Override Name" }
    },
    speedOverrides: {
      "credit-thread": "fast"
    }
  });
  const scan = await scanCodex(config);
  const reports = buildReports(scan.events, config, scan.threadNames);
  const overrideProject = reports.find((project) => project.projectId === "override-project");
  const clientB = reports.find((project) => project.projectId === "client-b");
  assert.ok(overrideProject);
  assert.ok(clientB);
  assert.equal(reports.some((project) => project.threads.some((thread) => thread.models.includes("codex-auto-review"))), false);

  const thread = overrideProject.threads[0];
  assert.equal(thread.name, "Override Name");
  assert.equal(thread.tokenTotals.inputTokens, 1500);
  assert.equal(thread.durationMs, 120_000);
  assert.equal(thread.tokenTotals.cachedInputTokens, 400);
  assert.equal(thread.tokenTotals.billableInputTokens, 1100);
  assert.deepEqual(thread.unpriced, ["unknown-local-model"]);
  assert.equal(thread.estimatedDollars, 0.00066);
  assert.equal(thread.estimatedCredits, 0.00164);

  const creditThread = clientB.threads[0];
  assert.equal(creditThread.speed, "fast");
  assert.deepEqual(creditThread.credits, { hasCredits: true, balance: 41 });
});

test("filters usage events by interactive date range presets", async () => {
  const scan = await scanCodex(fixtureConfig());
  const now = new Date("2026-04-14T09:02:00.000Z");

  assert.equal(filterEventsByDateRange(scan.events, "all", now).length, 5);
  assert.deepEqual(
    filterEventsByDateRange(scan.events, "1d", now).map((event) => event.threadId).sort(),
    ["auto-review-thread", "credit-thread"]
  );
  assert.equal(filterEventsByDateRange(scan.events, "1w", now).length, 5);
  assert.equal(filterEventsByDateRange(scan.events, "1m", now).length, 5);
});

test("parses month names as nearest current or past month", () => {
  const now = new Date("2026-04-30T12:00:00.000Z");
  const april = parseDateRange("april", now);
  assert.equal(april.label, "April 2026");
  assert.equal(april.start?.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(april.end?.toISOString(), "2026-05-01T00:00:00.000Z");

  const may = parseDateRange("may", now);
  assert.equal(may.label, "May 2025");
  assert.equal(may.start?.toISOString(), "2025-05-01T00:00:00.000Z");
  assert.equal(may.end?.toISOString(), "2025-06-01T00:00:00.000Z");
});

test("ignores stale usage timing gaps", async () => {
  const scan = await scanCodex(fixtureConfig());
  const event = scan.events.find((candidate) => candidate.threadId === "fixture-thread" && candidate.turnId === "turn-stale");
  assert.equal(event?.durationMs, null);

  const reports = buildReports(scan.events, fixtureConfig(), scan.threadNames);
  const thread = reports.flatMap((project) => project.threads).find((candidate) => candidate.threadId === "fixture-thread");
  assert.equal(thread?.durationMs, 120_000);
});

test("scan command and xlsx export work against fixtures", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "codex-cost-"));
  try {
    const configPath = join(tmp, "codex-cost.config.json");
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        configPath,
        JSON.stringify({
          codexHome: fixtureCodexHome,
          projectRules: [{ id: "client-a", pathPrefix: "/work/client-a" }],
          rateCards: fixtureConfig().rateCards
        })
      )
    );
    const { execFileSync } = await import("node:child_process");
    const scanOut = execFileSync(process.execPath, [resolve("src/cli.ts"), "scan", "--json"], { cwd: tmp, encoding: "utf8" });
    assert.equal(JSON.parse(scanOut).events, 5);
    const ratesOut = execFileSync(process.execPath, [resolve("src/cli.ts"), "rates"], { cwd: tmp, encoding: "utf8" });
    assert.match(ratesOut, /Rate card/);
    assert.match(ratesOut, /gpt-5\.4-mini/);
    assert.ok(ratesOut.indexOf("gpt-5.5") < ratesOut.indexOf("gpt-5.4"));
    execFileSync(process.execPath, [resolve("src/cli.ts"), "export"], { cwd: tmp, encoding: "utf8" });
    const { readdir } = await import("node:fs/promises");
    assert.equal((await readdir(tmp)).some((name) => /^codex-cost-report-.+\.xlsx$/.test(name)), true);
    const xlsxPath = join(tmp, "report.xlsx");
    execFileSync(process.execPath, [resolve("src/cli.ts"), "export", "--out", xlsxPath], { cwd: tmp, encoding: "utf8" });
    const csvPath = join(tmp, "report.csv");
    execFileSync(process.execPath, [resolve("src/cli.ts"), "export", "--format", "csv", "--out", csvPath], { cwd: tmp, encoding: "utf8" });
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(xlsxPath), true);
    assert.equal(existsSync(csvPath), true);
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const summary = workbook.getWorksheet("Summary");
    assert.ok(summary);
    const grandTotalRow = summary.getRow(summary.rowCount);
    const formula = (grandTotalRow.getCell(2).value as { formula?: string }).formula;
    assert.equal(formula, `SUM(B2:B${summary.rowCount - 1})`);
    const sheetXml = execFileSync("unzip", ["-p", xlsxPath, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
    assert.match(sheetXml, /<col min="1" max="1" width="\d+/);
    assert.match(sheetXml, /<tableParts count="1">/);
    const threads = workbook.getWorksheet("Threads");
    assert.ok(threads);
    const threadHeaders = (threads.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(threadHeaders, ["Project", "Thread", "Work Time", "Cost / Hour", "Models", "Plan Types", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"]);
    const { readFile } = await import("node:fs/promises");
    assert.deepEqual((await readFile(csvPath, "utf8")).split("\n")[0].split(","), threadHeaders);
    assert.equal(threadHeaders.includes("Project ID"), false);
    assert.equal(threadHeaders.includes("Thread ID"), false);
    assert.equal(threadHeaders.includes("Credits"), false);
    assert.equal(threadHeaders.includes("Estimated Credits"), false);
    assert.equal(threadHeaders.includes("cwd"), false);
    assert.equal(threadHeaders.includes("Speed"), false);
    assert.equal(threadHeaders.includes("Unpriced"), false);
    const turnHeaders = (workbook.getWorksheet("Turns")?.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(turnHeaders, ["Timestamp", "Started At", "Work Time", "Thread", "Turn ID", "Model", "Plan Type", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"]);
    assert.equal(workbook.getWorksheet("RawEvents"), undefined);
    assert.equal(workbook.getWorksheet("Turns")?.getCell("C2").value, "1m 0s");
    assert.match((workbook.getWorksheet("Turns")?.getCell("L2").value as { formula?: string }).formula ?? "", /VLOOKUP\(F2,RateCard!\$A:\$E,2,FALSE\)/);
    assert.match((threads.getCell("K2").value as { formula?: string }).formula ?? "", /SUMIF\(Turns!\$D:\$D,B2,Turns!\$L:\$L\)/);
    assert.match((workbook.getWorksheet("Projects")?.getCell("K2").value as { formula?: string }).formula ?? "", /SUMIF\(Threads!\$A:\$A,A2,Threads!\$K:\$K\)/);
    assert.match((summary.getCell("I2").value as { formula?: string }).formula ?? "", /SUMIF\(Projects!\$A:\$A,A2,Projects!\$K:\$K\)/);
    assert.equal(workbook.getWorksheet("RateCard")?.getCell("B2").numFmt, "$#,##0.000");
    assert.equal(workbook.getWorksheet("Turns")?.getCell("L2").numFmt, "$#,##0.000000");
    assert.equal(threads.getCell("D2").numFmt, "$#,##0.000000");
    assert.equal(threads.getCell("K2").numFmt, "$#,##0.000000");
    assert.equal(threads.getCell("K2").fill.type, "pattern");
    assert.equal(workbook.getWorksheet("Projects")?.getCell("E2").numFmt, "$#,##0.000000");
    assert.equal(workbook.getWorksheet("Projects")?.getCell("K2").numFmt, "$#,##0.000000");
    assert.equal(summary.getCell("D2").numFmt, "$#,##0.000000");
    assert.equal(summary.getCell("I2").numFmt, "$#,##0.000000");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("default dollar rate card matches current known OpenAI API rates", () => {
  const rates = allRateCards(fixtureConfig({ rateCards: {} }));
  assert.deepEqual(rates["gpt-5.5"], { inputPerMillion: 5, cachedInputPerMillion: 0.5, outputPerMillion: 30 });
  assert.deepEqual(rates["gpt-5.4"], { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15 });
  assert.deepEqual(rates["gpt-5.4-mini"], { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 });
  assert.deepEqual(rates["gpt-5.3-codex"], { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 });
  assert.deepEqual(rates["gpt-5.2"], { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14 });
});
