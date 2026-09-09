'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const databaseUrl = process.env.DATABASE_URL;
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const copyDir = process.env.BACKUP_COPY_DIR && path.resolve(process.env.BACKUP_COPY_DIR);
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;

if (!databaseUrl) throw new Error('DATABASE_URL is required.');
if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error('BACKUP_RETENTION_DAYS must be at least 1.');
if (process.env.NODE_ENV === 'production' && !/^[a-fA-F0-9]{64}$/.test(encryptionKey || '')) {
  throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hexadecimal characters in production.');
}

function databaseArgs(url, output) {
  return ['--format=custom', '--no-owner', '--no-acl', '--file', output,
    '--host', url.hostname, '--port', url.port || '5432', '--username', decodeURIComponent(url.username),
    '--dbname', decodeURIComponent(url.pathname.slice(1))];
}

function encryptFile(source, destination, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const input = fs.readFileSync(source);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  fs.writeFileSync(destination, Buffer.concat([Buffer.from('WAMYBK01'), iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
}

function prune(directory) {
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^wamy-.*\.dump(?:\.enc)?$/.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
  }
}

const url = new URL(databaseUrl);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const rawPath = path.join(backupDir, `wamy-${stamp}.dump`);
const result = spawnSync('pg_dump', databaseArgs(url, rawPath), {
  stdio: 'inherit', env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }
});
if (result.status !== 0) {
  if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('pg_dump was not found. Install PostgreSQL client tools or run the provided backup container.');
  }
  throw new Error(`pg_dump failed with exit code ${result.status}.`);
}

let finalPath = rawPath;
if (encryptionKey) {
  finalPath = rawPath + '.enc';
  encryptFile(rawPath, finalPath, encryptionKey);
  fs.unlinkSync(rawPath);
}
if (copyDir) {
  fs.mkdirSync(copyDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(finalPath, path.join(copyDir, path.basename(finalPath)));
  prune(copyDir);
}
prune(backupDir);
fs.writeFileSync(path.join(backupDir, '.backup-status.json'), JSON.stringify({
  ok: true, completed_at: new Date().toISOString(), file: path.basename(finalPath),
  bytes: fs.statSync(finalPath).size, encrypted: Boolean(encryptionKey), offsite_copy: Boolean(copyDir)
}));
console.log(JSON.stringify({ level: 'info', event: 'backup_completed', file: path.basename(finalPath),
  bytes: fs.statSync(finalPath).size, encrypted: Boolean(encryptionKey), offsite_copy: Boolean(copyDir) }));
