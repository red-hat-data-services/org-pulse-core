/**
 * ESLint rule: no-module-process-env
 *
 * Prevents modules from accessing process.env for secrets.
 * Module code should use context.secrets or context.resolveSecret() instead.
 *
 * Non-secret configuration variables (DEMO_MODE, NODE_ENV, etc.) are allowed.
 * Test files are excluded via the ESLint config (ignores pattern).
 */

const ALLOWED = new Set([
  'DEMO_MODE',
  'NODE_ENV',
  'API_PORT',
  'HTTPS_PROXY',
  'https_proxy',
  'JIRA_HOST',
  'JIRA_STORY_POINTS_FIELD',
  'GITLAB_BASE_URL',
  'PROXY_AUTH_SECRET'
])

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow process.env access for secrets in module code'
    },
    messages: {
      forbidden: 'Use context.secrets or context.resolveSecret() instead of process.env.{{name}} in module code.',
      forbiddenComputed: 'Use context.resolveSecret(varName) instead of process.env[varName] in module code.'
    }
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.object.type === 'MemberExpression' &&
            node.object.object.name === 'process' &&
            node.object.property.name === 'env') {
          // Static access: process.env.SOME_VAR
          if (!node.computed && node.property.type === 'Identifier' && !ALLOWED.has(node.property.name)) {
            context.report({ node, messageId: 'forbidden', data: { name: node.property.name } })
          }
          // Computed access: process.env[varName]
          if (node.computed) {
            context.report({ node, messageId: 'forbiddenComputed' })
          }
        }
      }
    }
  }
}
