import { appendFile, mkdir, writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const prNumber = Number(process.env.PR_NUMBER);
const expectedPrefix = process.env.ISSUE_PREFIX;
const reportDir = process.env.REPORT_DIR || "reports";

if (!token || !repository || !prNumber || !expectedPrefix) {
  throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, and ISSUE_PREFIX are required");
}

const [owner, repo] = repository.split("/");
const api = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "truthbounty-pr-guardian"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}: ${await response.text()}`);
  }
  return response.json();
};

const pr = await api(`/repos/${owner}/${repo}/pulls/${prNumber}`);
const closingPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]*(?:https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)?#?(\d+)\b/gi;
const linkedNumbers = [...new Set([...String(pr.body || "").matchAll(closingPattern)].map((match) => Number(match[1])))];

const findings = [];
const facts = {
  repository,
  pullRequest: prNumber,
  headSha: pr.head.sha,
  author: pr.user.login,
  draft: pr.draft,
  linkedIssues: linkedNumbers
};

if (pr.draft) findings.push({ severity: "notice", code: "draft", message: "Draft PRs are not merge candidates." });
if (linkedNumbers.length !== 1) {
  findings.push({
    severity: "warning",
    code: "one-task-one-pr",
    message: `Expected exactly one closing issue reference; found ${linkedNumbers.length}.`
  });
}

if (linkedNumbers.length === 1) {
  const issue = await api(`/repos/${owner}/${repo}/issues/${linkedNumbers[0]}`);
  const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
  const assignees = (issue.assignees || []).map((assignee) => assignee.login);
  const taskMatch = String(issue.title || "").match(new RegExp(`^\\s*(${expectedPrefix}-\\d{3})\\b`, "i"));
  Object.assign(facts, {
    issueNumber: issue.number,
    issueState: issue.state,
    taskId: taskMatch?.[1]?.toUpperCase() || null,
    labels,
    assignees
  });

  if (!taskMatch) findings.push({ severity: "warning", code: "task-id", message: `Linked issue title must begin with ${expectedPrefix}-NNN.` });
  if (issue.state !== "open") findings.push({ severity: "warning", code: "issue-state", message: "Linked issue is not open." });
  if (!labels.includes("Stellar Wave")) findings.push({ severity: "warning", code: "activation", message: 'Linked issue lacks the exact "Stellar Wave" activation label.' });
  if (labels.includes("wave-candidate") && labels.includes("Stellar Wave")) findings.push({ severity: "warning", code: "label-state", message: "Issue cannot be both wave-candidate and Stellar Wave." });
  if (!assignees.includes(pr.user.login)) findings.push({ severity: "warning", code: "assignment", message: `PR author @${pr.user.login} is not assigned to the linked issue; maintainer approval must be recorded.` });
}

const sensitiveFiles = [
  /^\.github\/workflows\//,
  /(?:auth|siwe|wallet|signature|settlement|reward|treasury|governance|migration|indexer|reorg|deploy)/i,
  /\.sol$/i
];
const files = [];
for (let page = 1; ; page += 1) {
  const batch = await api(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);
  files.push(...batch);
  if (batch.length < 100) break;
}
facts.changedFiles = files.map((file) => file.filename);
facts.securitySensitive = files.some((file) => sensitiveFiles.some((pattern) => pattern.test(file.filename)));
if (facts.securitySensitive) {
  findings.push({ severity: "notice", code: "human-review", message: "Security-sensitive paths changed; exact-head human maintainer approval is mandatory." });
}

const report = {
  schemaVersion: 1,
  mode: "report-only",
  generatedAt: new Date().toISOString(),
  facts,
  findings
};

await mkdir(reportDir, { recursive: true });
await writeFile(`${reportDir}/pr-guardian-${prNumber}.json`, JSON.stringify(report, null, 2) + "\n");

const rows = findings.length
  ? findings.map((finding) => `| ${finding.severity} | ${finding.code} | ${finding.message.replaceAll("|", "\\|")} |`).join("\n")
  : "| notice | clear | No policy findings at this stage. |";
const summary = `# TruthBounty PR Guardian (report only)

- Repository: \`${repository}\`
- Pull request: #${prNumber}
- Head SHA: \`${pr.head.sha}\`
- Linked task: \`${facts.taskId || "unresolved"}\`
- Security-sensitive: \`${facts.securitySensitive}\`

| Severity | Rule | Finding |
|---|---|---|
${rows}

This job does not approve, comment, label, assign, close, or merge.
`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(JSON.stringify(report, null, 2));
