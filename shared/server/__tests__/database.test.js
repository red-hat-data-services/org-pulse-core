import { describe, it, expect, afterEach } from 'vitest';

const { connectDatabase } = require('../database');

describe('connectDatabase — production safety', () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origUri = process.env.MONGODB_URI;

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    if (origUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = origUri;
  });

  it('refuses to start an in-memory database in production when no URI is set', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MONGODB_URI;
    // No uri via options or env -> the in-memory fallback must be refused in prod
    // rather than silently creating an ephemeral database that loses data on redeploy.
    await expect(connectDatabase({ uri: '' })).rejects.toThrow(/production/i);
  });
});
