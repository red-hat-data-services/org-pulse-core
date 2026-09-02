import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

const { startServer } = require('../dev-server');
const { disconnectDatabase } = require('../../shared/server/database');

describe('startServer database migration', () => {
  let dataDir;
  let server;
  let previousDbName;
  let previousAdminEmails;
  let previousMongoUri;
  let previousNodeEnv;

  beforeEach(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'org-pulse-startup-'));
    previousDbName = process.env.DB_NAME;
    previousAdminEmails = process.env.ADMIN_EMAILS;
    previousMongoUri = process.env.MONGODB_URI;
    previousNodeEnv = process.env.NODE_ENV;
    process.env.DB_NAME = `startup_migration_${process.pid}_${Date.now()}`;
    process.env.ADMIN_EMAILS = 'seeded@example.com';
    await fs.promises.writeFile(path.join(dataDir, 'roles.json'), JSON.stringify({
      assignments: {
        'custom@example.com': {
          roles: ['release-manager'],
          assignedBy: 'legacy-owner',
          assignedAt: '2026-01-01T00:00:00Z'
        }
      }
    }));
  });

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (mongoose.connection.readyState === 1) await mongoose.connection.db.dropDatabase();
    await disconnectDatabase();
    if (previousDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = previousDbName;
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
    if (previousMongoUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousMongoUri;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    server = null;
  });

  it('imports legacy roles before startup role seeding', async () => {
    server = await startServer({ dataDir, modulePaths: [], platformPaths: [], port: 0 });

    const custom = await mongoose.connection.collection('core__roles').findOne({ email: 'custom@example.com' });
    expect(custom).toMatchObject({ roles: ['release-manager'], assignedBy: 'legacy-owner' });
    expect(await mongoose.connection.collection('core__roles').findOne({ email: 'seeded@example.com' })).toBeNull();
    expect(await mongoose.connection.collection('_migrations').findOne({ _id: 'legacy-files-to-mongodb' })).toMatchObject({ status: 'complete' });
  });

  it('uses file storage when MONGODB_URI is unset', async () => {
    delete process.env.MONGODB_URI;
    process.env.NODE_ENV = 'production';
    server = await startServer({ dataDir, modulePaths: [], platformPaths: [], port: 0 });

    expect(mongoose.connection.readyState).toBe(0);
    await expect(fs.promises.access(path.join(dataDir, 'modules-config.json'))).resolves.toBeUndefined();
  });
});
