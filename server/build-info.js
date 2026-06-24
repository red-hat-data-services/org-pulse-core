// Populated at build time via Dockerfile ENV or at startup via git
const { execSync } = require('child_process')

function gitFallback(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim()
  } catch {
    return null
  }
}

module.exports = {
  version: process.env.APP_VERSION || require('../package.json').version,
  gitSha: process.env.GIT_SHA || gitFallback('git rev-parse HEAD'),
  buildDate: process.env.BUILD_DATE || gitFallback('git log -1 --format=%cI'),
  nodeVersion: process.version
}
