/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  globalSetup: '<rootDir>/test/build.cjs',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@nestjs-docs/documentation-engine/(.*)\\.js$':
      '<rootDir>/packages/documentation-engine/src/modules/documentation/$1',
    '^@nestjs-docs/docs-indexer/(.*)\\.js$':
      '<rootDir>/apps/docs-indexer/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/apps/mcp-server/bootstrap/http.ts',
  ],
  coverageDirectory: 'coverage',
};
