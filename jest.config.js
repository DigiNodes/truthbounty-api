```javascript
/** @type {import('jest').Config} */
module.exports = {
  // [inferred] Restored opening: the fragment begins mid-object
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  moduleNameMapper: {
    '^multiformats/(.*)$': '<rootDir>/src/__mocks__/multiformats.js',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  transformIgnorePatterns: [
    'node_modules/(?!(@nestjs|@noble/hashes|multiformats)/)',
  ],
  testEnvironment: 'node',
};
```