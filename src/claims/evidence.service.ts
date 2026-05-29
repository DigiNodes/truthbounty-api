import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  query: string;
  description: string;
  executionTime: number;
  rowsReturned: number;
}

interface BenchmarkFile {
  timestamp: string;
  results: BenchmarkResult[];
  summary: {
    totalQueries: number;
    successful: number;
    totalTime: number;
    avgTime: number;
  };
}

interface QueryDiff {
  description: string;
  before: number;
  after: number;
  diff: number;
  percent: number;
  rowsBefore: number;
  rowsAfter: number;
}

interface ComparisonReport {
  before: BenchmarkFile;
  after: BenchmarkFile;
  diffs: QueryDiff[];
  totalTimeDiff: number;
  totalTimePercent: number;
  avgTimeDiff: number;
  avgTimePercent: number;
  improvements: QueryDiff[];
  regressions: QueryDiff[];
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const COL = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

function c(color: keyof typeof COL, text: string): string {
  return `${COL[color]}${text}${COL.reset}`;
}

function bold(text: string): string {
  return `${COL.bold}${text}${COL.reset}`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(2)}ms`;
}

function formatChange(diff: number, percent: number): string {
  const sign = diff > 0 ? "+" : "";
  const pStr = `${sign}${percent.toFixed(1)}%`;
  const mStr = `${sign}${formatMs(diff)}`;

  if (diff < 0) return c("green", `▼ ${mStr} (${pStr})`);
  if (diff > 0) return c("red", `▲ ${mStr} (${pStr})`);
  return c("gray", `─ no change`);
}

function bar(percent: number, width = 20): string {
  const improvement = Math.min(Math.abs(percent), 100) / 100;
  const filled = Math.round(improvement * width);
  const empty = width - filled;
  const color: keyof typeof COL = percent < 0 ? "green" : "red";
  return c(color, "█".repeat(filled)) + c("gray", "░".repeat(empty));
}

function hr(char = "─", width = 100): string {
  return c("gray", char.repeat(width));
}

// ─── Core logic ───────────────────────────────────────────────────────────────

function buildReport(before: BenchmarkFile, after: BenchmarkFile): ComparisonReport {
  const diffs: QueryDiff[] = [];

  for (const b of before.results) {
    if (b.executionTime < 0) continue;
    const a = after.results.find((r) => r.description === b.description);
    if (!a || a.executionTime < 0) continue;

    const diff = a.executionTime - b.executionTime;
    const percent = (diff / b.executionTime) * 100;
    diffs.push({
      description: b.description,
      before: b.executionTime,
      after: a.executionTime,
      diff,
      percent,
      rowsBefore: b.rowsReturned,
      rowsAfter: a.rowsReturned,
    });
  }

  const totalTimeDiff = after.summary.totalTime - before.summary.totalTime;
  const totalTimePercent = (totalTimeDiff / before.summary.totalTime) * 100;
  const avgTimeDiff = after.summary.avgTime - before.summary.avgTime;
  const avgTimePercent = (avgTimeDiff / before.summary.avgTime) * 100;

  const improvements = [...diffs].filter((d) => d.percent < 0).sort((a, b) => a.percent - b.percent);
  const regressions = [...diffs].filter((d) => d.percent > 0).sort((a, b) => b.percent - a.percent);

  return { before, after, diffs, totalTimeDiff, totalTimePercent, avgTimeDiff, avgTimePercent, improvements, regressions };
}

// ─── Printer ─────────────────────────────────────────────────────────────────

function printReport(report: ComparisonReport): void {
  const { before, after, diffs, totalTimeDiff, totalTimePercent, avgTimeDiff, avgTimePercent, improvements, regressions } = report;

  // Header
  console.log("\n" + hr("═"));
  console.log(bold("  📊  BENCHMARK COMPARISON REPORT"));
  console.log(hr("═"));
  console.log(`  ${c("gray", "Before:")} ${before.timestamp}   ${c("gray", "After:")} ${after.timestamp}`);

  // Summary cards
  console.log("\n" + hr());
  console.log(bold("  Overall Summary"));
  console.log(hr());

  const summaryRows: [string, string, string, string][] = [
    ["Metric", "Before", "After", "Change"],
    ["Total time", formatMs(before.summary.totalTime), formatMs(after.summary.totalTime), formatChange(totalTimeDiff, totalTimePercent)],
    ["Avg time", formatMs(before.summary.avgTime), formatMs(after.summary.avgTime), formatChange(avgTimeDiff, avgTimePercent)],
    ["Queries run", String(before.summary.totalQueries), String(after.summary.totalQueries), "─"],
    ["Successful", String(before.summary.successful), String(after.summary.successful), "─"],
  ];

  const colW = [22, 12, 12, 30];
  for (const [i, row] of summaryRows.entries()) {
    const line = row.map((cell, ci) => (ci === 3 ? cell : cell.padEnd(colW[ci]))).join("  ");
    console.log("  " + (i === 0 ? bold(c("cyan", line)) : line));
  }

  // Per-query table
  console.log("\n" + hr());
  console.log(bold("  Per-Query Breakdown"));
  console.log(hr());

  const header = [
    "Query".padEnd(46),
    "Before".padStart(10),
    "After".padStart(10),
    "Rows".padStart(7),
    "  Change",
  ].join("  ");
  console.log("  " + bold(c("cyan", header)));
  console.log(hr());

  for (const d of diffs) {
    const rowChange =
      d.rowsAfter !== d.rowsBefore
        ? c("yellow", ` (rows: ${d.rowsBefore}→${d.rowsAfter})`)
        : c("gray", ` (${d.rowsAfter})`);

    const line = [
      d.description.substring(0, 44).padEnd(46),
      formatMs(d.before).padStart(10),
      formatMs(d.after).padStart(10),
      rowChange.padStart(7),
      "  " + formatChange(d.diff, d.percent),
    ].join("  ");

    console.log("  " + line);
  }

  // Improvements
  if (improvements.length > 0) {
    console.log("\n" + hr());
    console.log(bold(`  🚀  Top Improvements  (${improvements.length} queries faster)`));
    console.log(hr());

    for (const [i, item] of improvements.slice(0, 5).entries()) {
      const pct = Math.abs(item.percent);
      console.log(`  ${c("green", `${i + 1}.`)} ${item.description}`);
      console.log(`     ${bar(item.percent)} ${c("green", `${pct.toFixed(1)}% faster`)}  ${c("gray", `(${formatMs(item.before)} → ${formatMs(item.after)})`)}`);
    }
  }

  // Regressions
  if (regressions.length > 0) {
    console.log("\n" + hr());
    console.log(bold(`  ⚠️   Regressions  (${regressions.length} queries slower)`));
    console.log(hr());

    for (const [i, item] of regressions.slice(0, 5).entries()) {
      console.log(`  ${c("red", `${i + 1}.`)} ${item.description}`);
      console.log(`     ${bar(item.percent)} ${c("red", `${item.percent.toFixed(1)}% slower`)}  ${c("gray", `(${formatMs(item.before)} → ${formatMs(item.after)})`)}`);
    }
  }

  // Rating
  console.log("\n" + hr("═"));
  printRating(avgTimePercent, improvements.length, regressions.length, diffs.length);
  console.log(hr("═") + "\n");
}

function printRating(avgPct: number, improved: number, regressed: number, total: number): void {
  let rating: string;
  if (avgPct < -50) rating = c("green", "🌟🌟🌟  EXCELLENT — Queries are dramatically faster");
  else if (avgPct < -25) rating = c("green", "🌟🌟  GREAT — Substantial performance improvement");
  else if (avgPct < -10) rating = c("green", "🌟  GOOD — Noticeable performance improvement");
  else if (avgPct < 0) rating = c("green", "✅  IMPROVED — Slight performance improvement");
  else if (avgPct < 10) rating = c("yellow", "⚠️   NEUTRAL — Minimal performance change");
  else rating = c("red", "❌  DEGRADED — Performance has decreased");

  const improvedPct = total > 0 ? ((improved / total) * 100).toFixed(0) : "0";
  const regressedPct = total > 0 ? ((regressed / total) * 100).toFixed(0) : "0";

  console.log(`  ${bold("Rating:")} ${rating}`);
  console.log(
    `  ${c("gray", `${improved}/${total} queries improved (${improvedPct}%)`)}` +
    (regressed > 0 ? `  ${c("gray", `·  ${regressed} regressed (${regressedPct}%)`)}` : "")
  );
}

// ─── JSON export ─────────────────────────────────────────────────────────────

function exportReport(report: ComparisonReport, outputPath: string): void {
  const json = {
    generatedAt: new Date().toISOString(),
    before: report.before.timestamp,
    after: report.after.timestamp,
    summary: {
      totalTimeChange: { ms: report.totalTimeDiff, percent: report.totalTimePercent },
      avgTimeChange: { ms: report.avgTimeDiff, percent: report.avgTimePercent },
      queriesImproved: report.improvements.length,
      queriesRegressed: report.regressions.length,
      queriesUnchanged: report.diffs.length - report.improvements.length - report.regressions.length,
    },
    topImprovements: report.improvements.slice(0, 10).map((d) => ({
      description: d.description,
      beforeMs: d.before,
      afterMs: d.after,
      improvementPercent: Math.abs(d.percent),
    })),
    topRegressions: report.regressions.slice(0, 10).map((d) => ({
      description: d.description,
      beforeMs: d.before,
      afterMs: d.after,
      regressionPercent: d.percent,
    })),
    allDiffs: report.diffs,
  };

  fs.writeFileSync(outputPath, JSON.stringify(json, null, 2));
  console.log(`\n  ${c("cyan", "📄")} Report exported to ${c("cyan", outputPath)}\n`);
}

// ─── BenchmarkComparator class ────────────────────────────────────────────────

export class BenchmarkComparator {
  private readonly resultsDir: string;

  constructor(resultsDir?: string) {
    this.resultsDir = resultsDir ?? path.join(process.cwd(), "benchmark-results");
  }

  compareFiles(beforeFile: string, afterFile: string, opts: { export?: string } = {}): void {
    const before = this.loadBenchmark(beforeFile);
    const after = this.loadBenchmark(afterFile);

    if (!before || !after) {
      console.error(c("red", "❌  Could not load one or both benchmark files."));
      process.exit(1);
    }

    const report = buildReport(before, after);
    printReport(report);

    if (opts.export) {
      exportReport(report, opts.export);
    }
  }

  private loadBenchmark(filename: string): BenchmarkFile | null {
    const filePath = path.isAbsolute(filename) ? filename : path.join(this.resultsDir, filename);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content) as BenchmarkFile;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(c("red", `  Error loading "${filename}": ${msg}`));
      return null;
    }
  }

  listAvailableBenchmarks(): string[] {
    if (!fs.existsSync(this.resultsDir)) {
      console.log(c("yellow", "  No benchmark-results directory found."));
      return [];
    }

    return fs
      .readdirSync(this.resultsDir)
      .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
      .sort();
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const comparator = new BenchmarkComparator();
  const args = process.argv.slice(2);

  // Parse flags
  const exportFlag = args.indexOf("--export");
  let exportPath: string | undefined;
  let positional = args;

  if (exportFlag !== -1) {
    exportPath = args[exportFlag + 1];
    if (!exportPath) {
      console.error(c("red", "❌  --export requires a file path argument"));
      process.exit(1);
    }
    positional = args.filter((_, i) => i !== exportFlag && i !== exportFlag + 1);
  }

  if (positional.length === 0) {
    console.log(bold("\n  📁  Available benchmark files:\n"));
    const files = comparator.listAvailableBenchmarks();

    if (files.length === 0) {
      console.log(c("yellow", '  No benchmark files found. Run "npm run benchmark:indexes" first.\n'));
      return;
    }

    files.forEach((file, i) => {
      console.log(`  ${c("gray", `${i + 1}.`)} ${file}`);
    });

    console.log(c("gray", "\n  Usage:   npm run benchmark:compare <before> <after> [--export out.json]"));
    console.log(c("gray", "  Example: npm run benchmark:compare benchmark-2024-01-01.json benchmark-2024-01-02.json\n"));
    return;
  }

  if (positional.length !== 2) {
    console.error(c("red", "❌  Please provide exactly two benchmark files to compare."));
    console.error(c("gray", "  Usage: npm run benchmark:compare <before-file> <after-file>"));
    process.exit(1);
  }

  const [beforeFile, afterFile] = positional;
  comparator.compareFiles(beforeFile, afterFile, { export: exportPath });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(c("red", `❌  Unexpected error: ${err.message}`));
    process.exit(1);
  });
}