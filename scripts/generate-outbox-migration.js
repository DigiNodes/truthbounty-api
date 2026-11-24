// One-off helper used to (re)generate the OutboxEvent migration SQL (V2-BE-048).
//
// Usage: node scripts/generate-outbox-migration.js
//
// Steps performed:
//   1. Writes prisma/schema.nooutbox.tmp.prisma — a copy of prisma/schema.prisma with the
//      OutboxEvent model block removed (representing the pre-change schema state).
//   2. Runs `npx prisma migrate diff --from-schema-datamodel <prev> --to-schema-datamodel <current>`
//      to produce the SQL printed below prisma/migrations/<timestamp>_add_outbox_event/migration.sql
//      (copy the printed SQL into the migration file manually or pipe it).
//   3. The temp schema copy is deleted afterwards.
//
// This keeps migrations deterministic without requiring a live database connection.

const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const tmpPath = path.join(__dirname, '..', 'prisma', 'schema.nooutbox.tmp.prisma');

const src = fs.readFileSync(schemaPath, 'utf8');

// Locate the OutboxEvent model block (line-ending agnostic) and strip it along with
// its comment banner through the end of the closing brace.
const modelStart = src.indexOf('model OutboxEvent');
if (modelStart === -1) {
  console.error('Could not locate the OutboxEvent model block in prisma/schema.prisma');
  process.exit(1);
}
// Walk back from `model OutboxEvent` to the start of the banner comment (a line of
// dashes followed by the "Transactional Outbox" heading line).
const headingIdx = src.lastIndexOf('// Transactional Outbox', modelStart);
const dashesIdx = src.lastIndexOf('// ---', headingIdx);
const bannerStart = dashesIdx !== -1 && modelStart - dashesIdx < 200 ? dashesIdx : modelStart;
const closingBrace = src.indexOf('}', src.indexOf('{', modelStart));
const lineEnd = src.indexOf('\n', closingBrace);
const stripped = src.slice(0, bannerStart) + src.slice(lineEnd + 1);

fs.writeFileSync(tmpPath, stripped, 'utf8');
console.log('Wrote', tmpPath);
console.log('Next step:');
console.log(
  '  npx prisma migrate diff --from-schema prisma/schema.nooutbox.tmp.prisma ' +
    '--to-schema prisma/schema.prisma --script',
);
