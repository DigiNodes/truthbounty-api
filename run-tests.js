require('ts-node/register');
const jest = require('jest');

const args = [
  'src/outbox/outbox.service.spec.ts',
  'src/notifications/services/notification.processor.spec.ts',
  'test/outbox-idempotent-delivery.integration.spec.ts',
  'test/load/load-budget.spec.ts',
  '--runInBand',
];

jest.run(args);
