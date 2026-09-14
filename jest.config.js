const jestJupyterLab = require('@jupyterlab/testutils/lib/jest-config');

const esModules = [
  '@jupyter/',
  '@jupyterlab/',
  '@lumino/',
  '@microsoft/fast-',
  'lit',
  'nanoid'
].join('|');
const baseConfig = jestJupyterLab(__dirname);

module.exports = {
  ...baseConfig,
  automock: false,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  modulePathIgnorePatterns: [
    '<rootDir>/jupyter_aiterminal/labextension/'
  ],
  testRegex: 'src/.*\\.spec\\.ts$',
  transformIgnorePatterns: [`/node_modules/(?!${esModules}).+`]
};
