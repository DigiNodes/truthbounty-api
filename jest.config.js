/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': ['@swc/jest', { module: { type: 'commonjs' } }],
  },
  testRunner: 'jest-circus/runner',
  moduleDirectories: ['node_modules', '<rootDir>/node_modules'],
  moduleNameMapper: {
    '.*[/\\\\]load-package\\.util(\\.js)?$': '<rootDir>/src/__mocks__/load-package.util.js',
    '.*[/\\\\]swagger-ui(\\.js)?$': '<rootDir>/src/__mocks__/swagger-ui.js',
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  transformIgnorePatterns: [
    'node_modules/(?!(@nestjs|@noble/hashes|multiformats)/)',
  ],
  testEnvironment: 'node',
};
