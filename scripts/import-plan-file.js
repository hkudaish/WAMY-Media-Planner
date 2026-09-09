'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const input = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const dryRun = process.argv.includes('--dry-run');
if (!input) {
  console.error('Usage: npm run plan:import:file -- <workbook.xlsx> [--dry-run]');
  process.exit(1);
}
const filePath = path.resolve(input);
if (!fs.existsSync(filePath)) {
  console.error(`Workbook not found: ${filePath}`);
  process.exit(1);
}

const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
const token = 'operator-import-' + crypto.randomBytes(24).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

async function request(apiPath, options = {}) {
  const response = await fetch(baseUrl + apiPath, {
    ...options,
    headers: { Cookie: `wamy_session=${token}`, ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${(body && body.message) || 'Request failed'}`);
  return body;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const user = (await client.query(
      `select id from profiles
        where deleted_at is null and status='active'
          and (role='admin' or coalesce((permissions->>'Plans.Import')::boolean,false))
        order by case role when 'admin' then 0 else 1 end,created_at limit 1`
    )).rows[0];
    if (!user) throw new Error('No active user with task import permission exists.');
    await client.query(
      `insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`,
      [tokenHash, user.id]
    );
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }), path.basename(filePath));
    const preview = await request('/api/plans/preview', { method: 'POST', body: form });
    console.log(JSON.stringify({ format: preview.format, ...preview.summary }, null, 2));
    if (preview.summary.invalid) {
      preview.rows.filter(row => !row.valid).forEach(row => console.error(`Row ${row.row_number}: ${row.errors.join(' | ')}`));
      throw new Error('Workbook has invalid rows; nothing was imported.');
    }
    if (dryRun) return;
    const result = await request('/api/plans/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: preview.rows })
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    await client.end();
  }
})().catch(error => {
  console.error('Plan import failed:', error.message);
  process.exit(1);
});
