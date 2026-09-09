'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const hours = Number(process.env.BACKUP_INTERVAL_HOURS || 6);
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
if (!Number.isFinite(hours) || hours < 1) throw new Error('BACKUP_INTERVAL_HOURS must be at least 1.');
fs.mkdirSync(backupDir, { recursive: true });

async function alert(message) {
  if (!process.env.BACKUP_ALERT_WEBHOOK) return;
  try {
    await fetch(process.env.BACKUP_ALERT_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, service: 'wamy-media-planner-backup' })
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'backup_alert_failed', message: error.message }));
  }
}

function runBackup() {
  const child = spawn(process.execPath, [path.join(__dirname, 'backup-db.js')], { stdio: 'inherit', env: process.env });
  child.on('exit', async code => {
    if (code === 0) return;
    const status = { ok: false, failed_at: new Date().toISOString(), exit_code: code };
    fs.writeFileSync(path.join(backupDir, '.backup-status.json'), JSON.stringify(status));
    console.error(JSON.stringify({ level: 'error', event: 'backup_failed', exit_code: code }));
    await alert(`WAMY database backup failed with exit code ${code}.`);
  });
}

runBackup();
setInterval(runBackup, hours * 3600000).unref();
process.stdin.resume();
