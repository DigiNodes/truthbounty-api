// dependency-cruiser.config.js
module.exports = {
  forbidden: [
    {
      name: 'http-ws-cannot-mutate-protocol',
      severity: 'error',
      comment: 'HTTP and WebSocket layers must never act as protocol authorities or invoke direct contract mutations.',
      from: { path: '^src/(controllers|gateways|realtime)/' },
      to: { path: '^src/(contracts/mutations|blockchain/signer|authority)/' }
    },
    {
      name: 'projections-strict-read-model',
      severity: 'error',
      comment: 'Projections and queries must remain read-only event-derived views.',
      from: { path: '^src/(projections|queries)/' },
      to: { path: '^src/(mutations|commands)/' }
    }
  ],
  options: {
    doNotFollow: { path: ['node_modules', 'dist'] },
    tsConfig: { fileName: 'tsconfig.json' },
    reporterOptions: { dot: { collapsePattern: 'node_modules/[^/]+' } }
  }
};