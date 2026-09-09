'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { Client } = require('pg');

const filePath = path.join(__dirname, '..', 'الخطة-الزمنية-وامي-الجزء-الأول.xlsx');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
const token = 'attached-test-' + crypto.randomBytes(20).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const headers = ['م','المنتج','وصف المهمة','التاريخ','الحالة','الفئة','المسؤول عن المتابعة','ملاحظات','أيام حتى الموعد','الوضع الزمني'];

async function api(apiPath, options = {}, json = true) {
  const response = await fetch(baseUrl + apiPath, {
    ...options, headers: { Cookie: `wamy_session=${token}`, ...(options.headers || {}) }
  });
  const body = json ? await response.json() : await response.arrayBuffer();
  assert.ok(response.ok, `${apiPath}: ${response.status} ${(body && body.message) || ''}`);
  return body;
}

(async () => {
  const sourceWorkbook = new ExcelJS.Workbook();
  await sourceWorkbook.xlsx.readFile(filePath);
  const sourceSheet = sourceWorkbook.getWorksheet('المهام');
  assert.ok(sourceSheet, 'Attached workbook has no tasks sheet.');
  const sourceRows = [];
  sourceSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    sourceRows.push({
      phase: String(row.getCell(2).value || '').trim(),
      title: String(row.getCell(3).value || '').trim(),
      due: new Date(row.getCell(4).value).toISOString().slice(0, 10)
    });
  });
  assert.equal(sourceRows.length, 38);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const imported = await client.query(
      `select t.phase_name as phase,t.title,to_char(t.due_date,'YYYY-MM-DD') as due
         from tasks t join products p on p.id=t.product_id
        where t.deleted_at is null and p.code='PRD-02' and t.import_key is not null`
    );
    const importedKeys = new Set(imported.rows.map(row => [row.phase, row.title, row.due].join('|')));
    const missing = sourceRows.filter(row => !importedKeys.has([row.phase, row.title, row.due].join('|')));
    assert.deepEqual(missing, [], `Missing attached tasks: ${missing.map(row => row.title).join(', ')}`);

    const admin = (await client.query(
      `select id from profiles where deleted_at is null and status='active' and role='admin' order by created_at limit 1`
    )).rows[0];
    assert.ok(admin, 'An active administrator is required.');
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash, admin.id]);

    const sourceForm = new FormData();
    sourceForm.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    const sourcePreview = await api('/api/plans/preview', { method: 'POST', body: sourceForm });
    assert.equal(sourcePreview.format, 'wamy_tasks_v1');
    assert.equal(sourcePreview.summary.total, 38);
    assert.equal(sourcePreview.summary.duplicates, 38);

    const exportBuffer = await api('/api/plans/export', {}, false);
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(exportBuffer);
    const exportedSheet = exported.getWorksheet('المهام');
    assert.ok(exportedSheet, 'Export has no tasks sheet.');
    assert.deepEqual(headers.map((_, index) => exportedSheet.getRow(1).getCell(index + 1).text), headers);
    const databaseTaskCount = Number((await client.query(`select count(*) from tasks where deleted_at is null`)).rows[0].count);
    assert.equal(exportedSheet.actualRowCount - 1, databaseTaskCount, 'Excel export omitted database tasks.');

    const exportForm = new FormData();
    exportForm.append('file', new Blob([exportBuffer]), 'round-trip.xlsx');
    const exportPreview = await api('/api/plans/preview', { method: 'POST', body: exportForm });
    assert.equal(exportPreview.format, 'wamy_tasks_v1');
    assert.equal(exportPreview.summary.total, databaseTaskCount);
    console.log(`PASS  all 38 attached tasks present; ${databaseTaskCount}-task XLSX export and re-import preview supported`);
  } finally {
    await client.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    await client.end();
  }
})().catch(error => {
  console.error('FAIL ', error.message);
  process.exit(1);
});
