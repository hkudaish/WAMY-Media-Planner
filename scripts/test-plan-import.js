'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Client } = require('pg');

const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
const token = 'integration-' + crypto.randomBytes(18).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
let importKey = null;
let userId = null;

async function api(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { Cookie: `wamy_session=${token}`, ...(options.headers || {}) }
  });
  const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer();
  assert.ok(response.ok, `${path}: ${response.status} ${body.message || ''}`);
  return body;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const user = (await client.query(`select id,email from profiles where status='active' order by created_at limit 1`)).rows[0];
    assert.ok(user, 'An active user is required for this integration test.');
    userId = user.id;
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash, userId]);
    const product = (await client.query(`
      select p.* from products p where p.is_active and p.status not in ('completed','approved','cancelled','archived')
        and (p.allow_multiple_tasks or not exists(select 1 from tasks t where t.product_id=p.id)) order by p.code limit 1
    `)).rows[0];
    assert.ok(product, 'An available product is required.');

    const templateBuffer = await api('/api/plans/template');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuffer);
    const sheet = workbook.getWorksheet('نموذج الخطة');
    assert.ok(sheet, 'Template worksheet is missing.');
    const marker = crypto.randomBytes(6).toString('hex');
    sheet.getRow(2).values = [
      product.code, product.name, 'مرحلة اختبار', `مهمة اختبار مؤقتة ${marker}`,
      'تُحذف تلقائيًا بعد الاختبار', 'WAMY', user.email,
      '2027-07-01', '2027-07-02', 2, 'عادية', 'اختبار تكامل'
    ];
    const uploadBuffer = await workbook.xlsx.writeBuffer();
    const form = new FormData();
    form.append('file', new Blob([uploadBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'plan.xlsx');
    const preview = await api('/api/plans/preview', { method: 'POST', body: form });
    assert.equal(preview.summary.valid, 1);
    importKey = preview.rows[0].import_key;
    const imported = await api('/api/plans/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: preview.rows.filter(row => row.valid) })
    });
    assert.equal(imported.imported, 1);

    const duplicateForm = new FormData();
    duplicateForm.append('file', new Blob([uploadBuffer]), 'plan.xlsx');
    const duplicatePreview = await api('/api/plans/preview', { method: 'POST', body: duplicateForm });
    assert.equal(duplicatePreview.summary.duplicates, 1);
    console.log('PASS  template download, preview, import, and duplicate prevention');
  } finally {
    if (importKey) await client.query('delete from tasks where import_key=$1', [importKey]);
    if (userId) {
      await client.query(`set app.allow_audit_mutation='on'`);
      await client.query(`delete from activity_log where actor_id=$1 and action like 'استيراد خطة Excel:%'`, [userId]);
    }
    await client.query('delete from sessions where token_hash=$1', [tokenHash]);
    await client.end();
  }
})().catch(error => {
  console.error('FAIL ', error.message);
  process.exit(1);
});
