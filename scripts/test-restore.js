'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

function run(command, args, env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

function decrypt(source, destination) {
  const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!/^[a-fA-F0-9]{64}$/.test(key || '')) throw new Error('A valid BACKUP_ENCRYPTION_KEY is required.');
  const input = fs.readFileSync(source);
  if (input.subarray(0, 8).toString() !== 'WAMYBK01') throw new Error('Invalid encrypted backup header.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), input.subarray(8, 20));
  decipher.setAuthTag(input.subarray(20, 36));
  fs.writeFileSync(destination, Buffer.concat([decipher.update(input.subarray(36)), decipher.final()]), { mode: 0o600 });
}

(async () => {
  const started = Date.now();
  const latest = fs.readdirSync(backupDir)
    .filter(name => /^wamy-.*\.dump(?:\.enc)?$/.test(name))
    .map(name => ({ name, mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!latest) throw new Error(`No backup found in ${backupDir}.`);

  const source = path.join(backupDir, latest.name);
  const temporary = path.join(os.tmpdir(), `wamy-restore-${process.pid}.dump`);
  if (latest.name.endsWith('.enc')) decrypt(source, temporary); else fs.copyFileSync(source, temporary);

  const target = new URL(databaseUrl);
  const originalName = decodeURIComponent(target.pathname.slice(1));
  const targetUser = decodeURIComponent(target.username);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(targetUser)) throw new Error('Database username is not a safe PostgreSQL identifier.');
  const restoreName = `${originalName}_restore_test_${Date.now()}`;
  const adminUrl = new URL(process.env.RESTORE_ADMIN_URL || target.toString()); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  let adminConnected = false;
  const passwordEnv = { ...process.env, PGPASSWORD: decodeURIComponent(target.password) };
  try {
    await admin.connect();
    adminConnected = true;
    await admin.query(`create database "${restoreName}" owner "${targetUser}"`);
    run('pg_restore', ['--exit-on-error', '--no-owner', '--no-acl', '--host', target.hostname,
      '--port', target.port || '5432', '--username', decodeURIComponent(target.username), '--dbname', restoreName, temporary], passwordEnv);
    const restoredUrl = new URL(target); restoredUrl.pathname = '/' + restoreName;
    const restored = new Client({ connectionString: restoredUrl.toString() });
    await restored.connect();
    const { rows } = await restored.query(`select
      (select count(*)::int from profiles) profiles,
      (select count(*)::int from products) products,
      (select count(*)::int from tasks) tasks,
      (select count(*)::int from files) files,
      (select count(*)::int from activity_log) audit_events`);
    const broken = await restored.query(`select count(*)::int broken from tasks t left join products p on p.id=t.product_id where t.product_id is not null and p.id is null`);
    await restored.end();
    if (broken.rows[0].broken) throw new Error('Restored database contains broken task/product references.');
    console.log(JSON.stringify({ level: 'info', event: 'restore_test_passed', source: latest.name,
      duration_seconds: Math.round((Date.now() - started) / 1000), counts: rows[0] }));
  } finally {
    if (adminConnected) {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1`, [restoreName]).catch(() => {});
      await admin.query(`drop database if exists "${restoreName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
    fs.rmSync(temporary, { force: true });
  }
})().catch(error => {
  console.error(JSON.stringify({ level: 'error', event: 'restore_test_failed', message: error.message }));
  process.exit(1);
});
