'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

async function ensureDatabaseMigrated(connectionString) {
  const dbUrl = connectionString || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is missing.');
  }

  const target = new URL(dbUrl);
  const databaseName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName)) {
    throw new Error('Database name must contain only letters, numbers, and underscores.');
  }
  const adminUrl = new URL(target);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
    const exists = await admin.query('select 1 from pg_database where datname=$1', [databaseName]);
    if (!exists.rowCount) await admin.query(`create database "${databaseName}"`);
  } catch (err) {
    console.warn('[DB Init] Direct database check notice:', err.message);
  } finally {
    await admin.end().catch(() => {});
  }

  const client = new Client({ connectionString: target.toString() });
  try {
    await client.connect();
    await client.query('select pg_advisory_lock(2026090501)');
    await client.query(`create table if not exists schema_migrations (
      version text primary key, checksum text not null, applied_at timestamptz not null default now()
    )`);
    const migrations = [
      ['001_production_baseline', path.join(__dirname, '..', 'database', 'schema.sql')],
      ['002_master_plans', path.join(__dirname, '..', 'database', 'migrations', '002_master_plans.sql')],
      ['003_task_workflow', path.join(__dirname, '..', 'database', 'migrations', '003_task_workflow.sql')],
      ['004_user_invitations', path.join(__dirname, '..', 'database', 'migrations', '004_user_invitations.sql')],
      ['005_granular_rbac', path.join(__dirname, '..', 'database', 'migrations', '005_granular_rbac.sql')],
      ['006_rbac_defaults', path.join(__dirname, '..', 'database', 'migrations', '006_rbac_defaults.sql')],
      ['007_enforce_task_project_relationships', path.join(__dirname, '..', 'database', 'migrations', '007_enforce_task_project_relationships.sql')],
      ['008_hierarchical_project_structure', path.join(__dirname, '..', 'database', 'migrations', '008_hierarchical_project_structure.sql')],
      ['009_performance_indexes', path.join(__dirname, '..', 'database', 'migrations', '009_performance_indexes.sql')],
      ['010_organizations_adhoc_tasks_passwords', path.join(__dirname, '..', 'database', 'migrations', '010_organizations_adhoc_tasks_passwords.sql')],
      ['011_project_team_structure_and_plan_assignments', path.join(__dirname, '..', 'database', 'migrations', '011_project_team_structure_and_plan_assignments.sql')]
    ];
    for (const [version, file] of migrations) {
      if (!fs.existsSync(file)) continue;
      const sql = fs.readFileSync(file, 'utf8');
      const normalizedSql = sql.replace(/\r\n/g, '\n').trim();
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const normChecksum = crypto.createHash('sha256').update(normalizedSql).digest('hex');
      const crlfChecksum = crypto.createHash('sha256').update(sql.replace(/\r?\n/g, '\r\n')).digest('hex');
      const applied = (await client.query('select checksum from schema_migrations where version=$1', [version])).rows[0];
      if (applied && applied.checksum !== checksum && applied.checksum !== normChecksum && applied.checksum !== crlfChecksum) {
        console.warn(`[Migration] Updating checksum for existing applied migration ${version}`);
        await client.query('update schema_migrations set checksum=$1 where version=$2', [checksum, version]);
      }
      if (!applied) {
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations(version,checksum) values($1,$2)', [version, checksum]);
          await client.query('commit');
          console.log(`Applied migration ${version}.`);
        } catch (error) {
          await client.query('rollback');
          throw error;
        }
      }
    }
    console.log('PostgreSQL schema is current.');
  } finally {
    await client.query('select pg_advisory_unlock(2026090501)').catch(() => {});
    await client.end().catch(() => {});
  }
}

module.exports = { ensureDatabaseMigrated };

if (require.main === module) {
  ensureDatabaseMigrated().catch(error => {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  });
}
