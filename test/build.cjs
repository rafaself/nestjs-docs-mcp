const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

// Rebuild the actual entry point on every test run, including watch mode.
module.exports = () => {
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build'],
    { cwd: resolve(__dirname, '..'), stdio: 'inherit' },
  );
};
