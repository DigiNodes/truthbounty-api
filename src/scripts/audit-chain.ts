#!/usr/bin/env node
/**
 * CLI Commands: verification, checkpoint, export, and corruption-report
 * for security/administrative audit record streams.
 *
 * Usage examples:
 *   ts-node src/scripts/audit-chain.ts verify --stream admin_security
 *   ts-node src/scripts/audit-chain.ts verify --input export.json
 *   ts-node src/scripts/audit-chain.ts checkpoint --stream admin_security
 *   ts-node src/scripts/audit-chain.ts export --stream admin_security --out export.json
 *   ts-node src/scripts/audit-chain.ts corruption-report --stream admin_security
 *   ts-node src/scripts/audit-chain.ts corruption-report --input corrupted.json
 *
 * Notice: This CLI explicitly documents that hash chaining provides tamper evidence
 * and append-only integrity without claiming decentralized blockchain immutability.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AuditStreamService,
  InMemoryAuditStreamStore,
} from '../audit/stream/audit-stream.service';
import { AuditKeyRegistry } from '../audit/stream/audit-key-registry';
import {
  AuditStreamExport,
  AuditStreamRecord,
  AUDIT_STREAM_DISCLAIMER,
} from '../audit/stream/audit-stream.types';

function parseArg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function getSecretKey(): string {
  const secret = process.env.AUDIT_HASH_SECRET ?? 'truthbounty-audit-default-secret-key-32chars';
  return secret;
}

async function main() {
  const command = process.argv[2];
  if (!command || command.startsWith('--') || ['-h', '--help', 'help'].includes(command)) {
    console.log(`
TruthBounty Audit Chain CLI
Usage: ts-node src/scripts/audit-chain.ts <command> [options]

Commands:
  verify              Verify hash chain integrity across records
  checkpoint          Create and pin a stream checkpoint at head or sequence
  export              Export secret-free audit stream evidence
  corruption-report   Diagnose and classify stream mutations and corruptions

Options:
  --stream <id>       Stream ID (e.g. admin_security, default: admin_security)
  --key-id <id>       HMAC Key ID (default: key-default)
  --secret <key>      HMAC secret (or env AUDIT_HASH_SECRET)
  --from <seq>        From sequence number
  --to <seq>          To sequence number
  --in <path>         Input export/records file
  --out <path>        Output export file path
  --json              Output raw JSON
  --help, -h          Show this help

Notice: ${AUDIT_STREAM_DISCLAIMER}
    `);
    process.exit(0);
  }

  const streamId = parseArg('stream', 'admin_security')!;
  const keyId = parseArg('key-id', 'key-default')!;
  const secret = parseArg('secret', getSecretKey())!;
  const jsonMode = hasFlag('json');
  const inputPath = parseArg('in') ?? parseArg('input');
  const outputPath = parseArg('out') ?? parseArg('output');
  const fromSeq = parseArg('from') ? Number(parseArg('from')) : undefined;
  const toSeq = parseArg('to') ? Number(parseArg('to')) : undefined;

  const registry = new AuditKeyRegistry([{ keyId, secret, active: true }]);
  const store = new InMemoryAuditStreamStore();
  const service = new AuditStreamService(registry, store);

  // If input file is provided, load records into store
  if (inputPath) {
    const fullPath = path.resolve(process.cwd(), inputPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Input file does not exist: ${fullPath}`);
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed.format === 'truthbounty-audit-stream-export-v1') {
      const exportData = parsed as AuditStreamExport;
      for (const r of exportData.records) {
        await store.saveRecord(r);
      }
      for (const cp of exportData.checkpoints ?? []) {
        await store.saveCheckpoint(cp);
      }
    } else if (Array.isArray(parsed)) {
      for (const r of parsed as AuditStreamRecord[]) {
        await store.saveRecord(r);
      }
    } else {
      throw new Error('Unrecognized input file format. Expected AuditStreamExport or AuditStreamRecord array.');
    }
  }

  switch (command) {
    case 'verify': {
      const report = await service.verify(streamId, {
        fromSequence: fromSeq,
        toSequence: toSeq,
      });

      if (jsonMode) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        console.log(`\n=== Audit Chain Verification: ${streamId} ===`);
        console.log(`Status:          ${report.valid ? 'VALID' : 'INVALID'}`);
        console.log(`Records Checked: ${report.recordsChecked}`);
        console.log(`Sequence Range:  ${report.fromSequence} .. ${report.toSequence}`);
        console.log(`Head Hash:       ${report.headHash ?? 'N/A'}`);
        if (!report.valid && report.firstInvalid) {
          console.log(`First Invalid:   Seq ${report.firstInvalid.sequence} (${report.firstInvalid.reason})`);
        }
        if (report.errors.length) {
          console.log(`Errors:          ${report.errors.join('; ')}`);
        }
        console.log(`\nNote: ${report.disclaimer}\n`);
      }

      if (!report.valid) {
        process.exit(1);
      }
      break;
    }

    case 'checkpoint': {
      const targetSeq = parseArg('sequence') ? Number(parseArg('sequence')) : undefined;
      const cp = await service.createCheckpoint(streamId, targetSeq);

      if (jsonMode) {
        process.stdout.write(JSON.stringify(cp, null, 2) + '\n');
      } else {
        console.log(`\n=== Stream Checkpoint Created ===`);
        console.log(`Stream:          ${cp.streamId}`);
        console.log(`Sequence:        ${cp.sequence}`);
        console.log(`Head Hash:       ${cp.headHash}`);
        console.log(`Timestamp:       ${cp.timestamp}`);
        console.log(`Checkpoint Hash: ${cp.checkpointHash}`);
        console.log(`Key ID:          ${cp.keyId}`);
        console.log(`Chain ID:        ${cp.chainContext.chainId}`);
        console.log(`Release ID:      ${cp.chainContext.releaseId}`);
        console.log(`Deployment Block:${cp.chainContext.deploymentBlock}`);
        console.log(`Checksum:        ${cp.chainContext.artifactChecksum}`);
        console.log(`\nNote: ${AUDIT_STREAM_DISCLAIMER}\n`);
      }
      break;
    }

    case 'export': {
      const exported = await service.export(streamId, {
        fromSequence: fromSeq,
        toSequence: toSeq,
      });

      const serialized = JSON.stringify(exported, null, 2);

      if (outputPath) {
        const fullOut = path.resolve(process.cwd(), outputPath);
        fs.writeFileSync(fullOut, serialized, 'utf8');
        console.log(`Exported ${exported.recordCount} records to ${outputPath} (secret-free verified).`);
      } else {
        process.stdout.write(serialized + '\n');
      }
      break;
    }

    case 'corruption-report':
    case 'report': {
      const report = await service.diagnoseCorruption(streamId);

      if (jsonMode) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        console.log(`\n=== Audit Corruption Diagnostic Report: ${streamId} ===`);
        console.log(`Status:           ${report.status}`);
        console.log(`Analyzed Records: ${report.recordsAnalyzed}`);
        console.log(`Detected Anomaly: ${report.corruptionsFound.length}`);
        console.log(`Summary:          ${report.summary}`);

        if (report.corruptionsFound.length > 0) {
          console.log('\n--- Detected Corruptions ---');
          for (const c of report.corruptionsFound) {
            console.log(`- [Seq ${c.sequence}] ${c.corruptionType}: ${c.description}`);
            if (c.expected !== undefined) console.log(`  Expected: ${JSON.stringify(c.expected)}`);
            if (c.actual !== undefined)   console.log(`  Actual:   ${JSON.stringify(c.actual)}`);
          }
        }
        console.log(`\nNote: ${report.disclaimer}\n`);
      }

      if (report.status === 'CORRUPTED') {
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Audit chain error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
