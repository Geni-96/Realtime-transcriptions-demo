/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  collectCoverageFrom: ['src/background/**/*.js', 'src/sidepanel/**/*.js'],
  coverageDirectory: 'coverage'
};
