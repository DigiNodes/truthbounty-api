/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': ['@swc/jest', { module: { type: 'commonjs' } }],
  },
  testRunner: 'jest-circus/runner',
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  transformIgnorePatterns: [
    'node_modules/(?!(@nestjs|@noble/hashes|multiformats)/)',
  ],
  testEnvironment: 'node',
};
