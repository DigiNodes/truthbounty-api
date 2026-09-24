import { appendFile, mkdir, writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const expectedPrefix = process.env.ISSUE_PREFIX;
const reportDir = process.env.REPORT_DIR || "reports";
const maxTask = Number(process.env.MAX_TASK || 150);

if (!token || !repository || !expectedPrefix) {
  throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and ISSUE_PREFIX are required");
}

const [owner, repo] = repository.split("/");
const api = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "truthbounty-issue-auditor"
    }
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}: ${await response.text()}`);
  return response.json();
};

const all = [];
for (let page = 1; ; page += 1) {
  const batch = await api(`/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`);
  all.push(...batch.filter((item) => !item.pull_request));
  if (batch.length < 100) break;
}

const taskPattern = new RegExp(`^\\s*(${expectedPrefix})-(\\d{3})\\b`, "i");
const requiredHeadings = [
  "## Overview",
  "## Problem Context",
  "## Technical Scope",
  "## Security and Architecture Requirements",
  "## Required Tests",
  "## Acceptance Criteria",
  "## Dependencies",
  "## Non-Goals",
  "## Complexity and Review",
  "# 🏷 Labels"
];
const byId = new Map();
const tasks = [];
const findings = [];

for (const issue of all) {
  const match = String(issue.title || "").match(taskPattern);
  if (!match) continue;
  const number = Number(match[2]);
  const id = `${expectedPrefix}-${String(number).padStart(3, "0")}`;
  const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
  const body = String(issue.body || "");
  const missingHeadings = requiredHeadings.filter((heading) => !body.includes(heading));
  const complexity = labels.filter((label) => /^complexity-(low|medium|high)$/.test(label));
  const record = { id, issueNumber: issue.number, state: issue.state, labels, assignees: (issue.assignees || []).map((a) => a.login), missingHeadings };
  tasks.push(record);
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(record);

  if (number < 1 || number > maxTask) findings.push({ severity: "warning", code: "range", id, message: `Task number is outside 001-${String(maxTask).padStart(3, "0")}.` });
  if (missingHeadings.length) findings.push({ severity: "warning", code: "structure", id, message: `Missing headings: ${missingHeadings.join(", ")}` });
  if (complexity.length !== 1) findings.push({ severity: "warning", code: "complexity", id, message: `Expected one complexity label; found ${complexity.length}.` });
  if (labels.includes("Stellar Wave") && labels.includes("wave-candidate")) findings.push({ severity: "warning", code: "label-state", id, message: "Issue is simultaneously active and a candidate." });
  if (labels.includes("Stellar Wave") && issue.state === "open" && record.assignees.length === 0) findings.push({ severity: "warning", code: "active-unassigned", id, message: "Active Wave issue has no assignee." });
}

for (const [id, records] of byId) {
  if (records.length > 1) findings.push({ severity: "warning", code: "duplicate", id, message: `Duplicate task ID appears ${records.length} times.` });
}
for (let number = 1; number <= maxTask; number += 1) {
  const id = `${expectedPrefix}-${String(number).padStart(3, "0")}`;
  if (!byId.has(id)) findings.push({ severity: "warning", code: "gap", id, message: "Expected task ID is missing." });
}

const active = tasks.filter((task) => task.state === "open" && task.labels.includes("Stellar Wave")).length;
const candidates = tasks.filter((task) => task.state === "open" && task.labels.includes("wave-candidate")).length;
const report = {
  schemaVersion: 1,
  mode: "report-only",
  generatedAt: new Date().toISOString(),
  repository,
  prefix: expectedPrefix,
  totals: { tasks: tasks.length, active, candidates, findings: findings.length },
  findings,
  tasks
};

await mkdir(reportDir, { recursive: true });
await writeFile(`${reportDir}/issue-audit.json`, JSON.stringify(report, null, 2) + "\n");

const grouped = Object.groupBy(findings, (finding) => finding.code);
const rows = Object.entries(grouped).map(([code, entries]) => `| ${code} | ${entries.length} |`).join("\n") || "| clear | 0 |";
const summary = `# TruthBounty issue inventory audit (report only)

- Repository: \`${repository}\`
- V2 tasks found: **${tasks.length}**
- Open active tasks: **${active}**
- Open candidates: **${candidates}**
- Findings: **${findings.length}**

| Rule | Count |
|---|---:|
${rows}

The JSON artifact contains exact issue-level findings. This job performs no mutations.
`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(JSON.stringify(report.totals));
