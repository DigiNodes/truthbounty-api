import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;

// Records are evidence, never a replacement for the independent npm audit gate.
export function validateException(record, now = new Date()) {
  const errors = [];
  for (const field of ['advisory', 'owner', 'approvedBy', 'rationale']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      errors.push(`Missing exception ${field}`);
    }
  }
  if (
    !/^https:\/\/github\.com\/DigiNodes\/truthbounty-api\/(issues|pull)\/\d+#(issuecomment|discussion_r)-\d+$/.test(
      record.approvalUrl ?? '',
    )
  ) {
    errors.push('Missing maintainer approval permalink');
  }
  const approved = Date.parse(record.approvedAt);
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(approved) || !Number.isFinite(expires)) {
    errors.push('Exception approval and expiry must be dated');
  } else {
    if (approved > now.getTime())
      errors.push('Exception approval is in the future');
    if (expires <= now.getTime()) errors.push('Exception has expired');
    if (expires <= approved || expires - approved > 90 * DAY) {
      errors.push('Exception must expire within 90 days of approval');
    }
  }
  if (record.severity === 'critical' && record.reachability === 'reachable') {
    errors.push('Reachable critical findings cannot be waived');
  }
  return errors;
}

export function validateInventory(inventory, lock, now = new Date()) {
  const errors = [];
  if (!Array.isArray(inventory.findings) || inventory.findings.length === 0) {
    return ['Finding inventory is missing'];
  }
  for (const finding of inventory.findings) {
    if (
      !finding.owner ||
      !finding.evidence?.length ||
      !finding.advisories?.length
    ) {
      errors.push(
        `${finding.package}: missing ownership, reachability, or advisory evidence`,
      );
    }
    if (!['fixed', 'open'].includes(finding.status)) {
      errors.push(`${finding.package}: unsupported finding status`);
    }
    if (!finding.resolutions?.length) {
      errors.push(`${finding.package}: missing lockfile resolutions`);
      continue;
    }
    for (const resolution of finding.resolutions) {
      const entry = lock.packages?.[resolution.path];
      if (!entry || entry.version !== resolution.version) {
        errors.push(`${finding.package}: reviewed lockfile resolution changed`);
      }
      if (finding.reachability === 'dev-only' && entry?.dev !== true) {
        errors.push(
          `${finding.package}: claimed dev-only dependency is in the production graph`,
        );
      }
    }
    if (
      finding.status === 'open' &&
      ['high', 'critical'].includes(finding.severity)
    ) {
      errors.push(
        `${finding.package}: high/critical remediation is incomplete`,
      );
    }
  }
  if (!Array.isArray(inventory.approvedExceptions)) {
    errors.push('Exception inventory is missing');
  } else {
    for (const record of inventory.approvedExceptions) {
      errors.push(...validateException(record, now));
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const inventory = JSON.parse(
      readFileSync(
        new URL('../docs/security/dependency-baseline.json', import.meta.url),
      ),
    );
    const lock = JSON.parse(
      readFileSync(new URL('../package-lock.json', import.meta.url)),
    );
    const errors = validateInventory(inventory, lock);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        'Dependency inventory and exception metadata are valid; npm audit remains required.',
      );
    }
  } catch {
    console.error('Dependency inventory could not be validated.');
    process.exitCode = 1;
  }
}
