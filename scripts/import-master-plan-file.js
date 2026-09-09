'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const input = process.argv.slice(2).find(value => !value.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
if (!input || !fs.existsSync(path.resolve(input))) {
  console.error('Usage: npm run master-plan:import -- <workbook.xlsx> [--dry-run]');
  process.exit(1);
}
const filePath = path.resolve(input);
const token = 'master-import-' + crypto.randomBytes(24).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;

async function request(apiPath, options = {}) {
  const response = await fetch(baseUrl + apiPath, { ...options, headers: { Cookie: `wamy_session=${token}`, ...(options.headers || {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${(body && body.message) || 'Request failed'}`);
  return body;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const admin = (await client.query(`select id from profiles where deleted_at is null and status='active' and role='admin' order by created_at limit 1`)).rows[0];
    if (!admin) throw new Error('An active administrator is required.');
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash, admin.id]);
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const preview = await request('/api/master-plans/preview', { method: 'POST', body: form });
    console.log(JSON.stringify({ file: path.basename(filePath), format: preview.format, sheet: preview.sheet, ...preview.summary }, null, 2));
    if (preview.summary.invalid) {
      preview.rows.filter(row => !row.valid).forEach(row => console.error(`Row ${row.row_number}: ${row.errors.join(' | ')}`));
      throw new Error('Workbook contains invalid rows.');
    }
    if (dryRun) return;
    const result = await request('/api/master-plans/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: preview.rows, definitions: preview.definitions })
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    await client.end();
  }
})().catch(error => { console.error('Master-plan import failed:', error.message); process.exit(1); });
