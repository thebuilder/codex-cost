import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { scanCodex } from "../src/codex-parser.ts";
import type { CodexCostConfig } from "../src/config.ts";
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
  assert.equal(scan.events.length, 4);
  assert.equal(scan.duplicateRecords, 1);
  assert.equal(scan.skippedRecords, 0);
  assert.equal(scan.threadNames.get("credit-thread"), "Renamed Credit Thread");

  const first = scan.events.find((event) => event.threadId === "fixture-thread" && event.model === "gpt-5.4-mini");
  assert.equal(first?.turnId, "turn-1");
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
  assert.equal(thread.tokenTotals.cachedInputTokens, 400);
  assert.equal(thread.tokenTotals.billableInputTokens, 1100);
  assert.deepEqual(thread.unpriced, ["unknown-local-model"]);
  assert.equal(thread.estimatedDollars, 0.00066);
  assert.equal(thread.estimatedCredits, 0.00164);

  const creditThread = clientB.threads[0];
  assert.equal(creditThread.speed, "fast");
  assert.deepEqual(creditThread.credits, { hasCredits: true, balance: 41 });
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
    assert.equal(JSON.parse(scanOut).events, 4);
    const xlsxPath = join(tmp, "report.xlsx");
    execFileSync(process.execPath, [resolve("src/cli.ts"), "export", "--format", "xlsx", "--out", xlsxPath], { cwd: tmp, encoding: "utf8" });
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
    assert.deepEqual(threadHeaders, ["Project", "Thread", "Models", "Plan Types", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars", "Unpriced"]);
    const { readFile } = await import("node:fs/promises");
    assert.deepEqual((await readFile(csvPath, "utf8")).split("\n")[0].split(","), threadHeaders);
    assert.equal(threadHeaders.includes("Project ID"), false);
    assert.equal(threadHeaders.includes("Thread ID"), false);
    assert.equal(threadHeaders.includes("Credits"), false);
    assert.equal(threadHeaders.includes("Estimated Credits"), false);
    assert.equal(threadHeaders.includes("cwd"), false);
    assert.equal(threadHeaders.includes("Speed"), false);
    const turnHeaders = (workbook.getWorksheet("Turns")?.getRow(1).values as unknown[]).slice(1);
    assert.deepEqual(turnHeaders, ["Timestamp", "Thread", "Turn ID", "Model", "Plan Type", "Input", "Cached", "Output", "Reasoning", "Estimated Dollars"]);
    assert.equal(workbook.getWorksheet("RawEvents"), undefined);
    assert.match((workbook.getWorksheet("Turns")?.getCell("J2").value as { formula?: string }).formula ?? "", /VLOOKUP\(D2,RateCard!\$A:\$E,2,FALSE\)/);
    assert.match((threads.getCell("I2").value as { formula?: string }).formula ?? "", /SUMIF\(Turns!\$B:\$B,B2,Turns!\$J:\$J\)/);
    assert.match((workbook.getWorksheet("Projects")?.getCell("I2").value as { formula?: string }).formula ?? "", /SUMIF\(Threads!\$A:\$A,A2,Threads!\$I:\$I\)/);
    assert.match((summary.getCell("G2").value as { formula?: string }).formula ?? "", /SUMIF\(Projects!\$A:\$A,A2,Projects!\$I:\$I\)/);
    assert.equal(workbook.getWorksheet("RateCard")?.getCell("B2").numFmt, "$#,##0.000");
    assert.equal(workbook.getWorksheet("Turns")?.getCell("J2").numFmt, "$#,##0.000000");
    assert.equal(threads.getCell("I2").numFmt, "$#,##0.000000");
    assert.equal(workbook.getWorksheet("Projects")?.getCell("I2").numFmt, "$#,##0.000000");
    assert.equal(summary.getCell("G2").numFmt, "$#,##0.000000");
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
