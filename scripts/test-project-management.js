'use strict';

require('dotenv').config();
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const projectHierarchyIO = require('../server/project-hierarchy-io');

async function test() {
  console.log('--- Starting Project Management & Hierarchy IO Tests ---');

  // 1. Test template generation for all 4 entities
  for (const entity of ['projects', 'project-plans', 'project-products', 'project-phases']) {
    const buffer = await projectHierarchyIO.generateTemplate(entity, { pool });
    assert.ok(buffer && buffer.length > 0, `Template for ${entity} generated buffer`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    assert.ok(wb.worksheets.length >= 2, `Template for ${entity} has at least 2 sheets`);
    assert.ok(wb.getWorksheet('تعليمات'), `Template for ${entity} has instructions sheet`);
    console.log(`✓ Template generated successfully: ${entity} (${buffer.length} bytes, ${wb.worksheets[0].name})`);
  }

  // 2. Test export data for all 4 entities
  for (const entity of ['projects', 'project-plans', 'project-products', 'project-phases']) {
    const buffer = await projectHierarchyIO.exportData(entity, { pool });
    assert.ok(buffer && buffer.length > 0, `Export for ${entity} generated buffer`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    console.log(`✓ Data exported successfully: ${entity} (${wb.worksheets[0].rowCount} rows)`);
  }

  // 3. Test Preview & Commit for Projects
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  const testProjCode = `PRJ-TEST-${rand}`;
  const testProjHCode = `PRJ-${rand}`;
  const wbProj = new ExcelJS.Workbook();
  const wsProj = wbProj.addWorksheet('المشاريع');
  wsProj.addRow(['رمز المشروع', 'الرمز الهرمي', 'اسم المشروع', 'الوصف', 'الأهداف الاستراتيجية', 'الرؤية', 'الرسالة', 'الجهة المسؤولة', 'البريد الإلكتروني لمدير المشروع', 'الحالة', 'تاريخ البدء', 'تاريخ النهاية', 'الميزانية', 'العملة', 'الملاحظات']);
  wsProj.addRow([testProjCode, testProjHCode, 'مشروع تجريبي مؤقت للاختبار', 'وصف المشروع', 'الهدف', 'الرؤية', 'الرسالة', 'WAMY', '', 'نشط', '2026-09-01', '2027-06-30', 50000, 'SAR', 'ملاحظات تجريبية']);
  const projBuf = await wbProj.xlsx.writeBuffer();

  const previewProj = await projectHierarchyIO.previewImport('projects', projBuf, { pool });
  assert.equal(previewProj.summary.valid, 1, 'Project import preview has 1 valid row');
  assert.equal(previewProj.summary.invalid, 0, 'Project import preview has 0 invalid rows');
  console.log(`✓ Project preview validation passed: ${previewProj.rows[0].code}`);

  const mockAdminUser = (await pool.query(`select id, name, email, org, role from profiles where status='active' and role='admin' limit 1`)).rows[0];
  const mockReq = { user: mockAdminUser, ip: '127.0.0.1', requestId: 'test-req-1' };
  async function mockWriteAudit(client, req, action, type, entity_table, entity_id, details) {
    await client.query(`insert into activity_log (actor_id, actor_name, org, action, type, entity_table, entity_id, details, request_id, ip_address)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [req.user.id, req.user.name, req.user.org, action, type, entity_table, entity_id ? String(entity_id) : null, details ? JSON.stringify(details) : null, req.requestId, req.ip]);
  }

  const commitProj = await projectHierarchyIO.commitImport('projects', { rows: previewProj.rows, mode: 'add_only' }, { pool, user: mockAdminUser, req: mockReq, writeAudit: mockWriteAudit });
  assert.equal(commitProj.inserted, 1, 'Project committed successfully');
  console.log(`✓ Project commit passed: 1 inserted`);

  const createdProject = (await pool.query(`select * from projects where code = $1 and deleted_at is null`, [testProjCode])).rows[0];
  assert.ok(createdProject, 'Project found in database');

  // 4. Test Preview & Commit for Plans
  const testPlanCode = `${testProjHCode}-PLN-01`;
  const wbPlan = new ExcelJS.Workbook();
  const wsPlan = wbPlan.addWorksheet('خطط ومسارات المشاريع');
  wsPlan.addRow(['رمز الخطة / المسار', 'اسم الخطة / المسار', 'رمز المشروع المرتبط', 'الوصف', 'الجهة المسؤولة', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'الملاحظات']);
  wsPlan.addRow([testPlanCode, 'مسار التطوير التجريبي', testProjCode, 'وصف المسار', 'WAMY', '2026-09-01', '2027-01-30', 'قيد التنفيذ', 'ملاحظات المسار']);
  const planBuf = await wbPlan.xlsx.writeBuffer();

  const previewPlan = await projectHierarchyIO.previewImport('project-plans', planBuf, { pool });
  assert.equal(previewPlan.summary.valid, 1, 'Plan preview has 1 valid row');
  console.log(`✓ Plan preview validation passed: ${previewPlan.rows[0].plan_code}`);

  const commitPlan = await projectHierarchyIO.commitImport('project-plans', { rows: previewPlan.rows, mode: 'add_only' }, { pool, user: mockAdminUser, req: mockReq, writeAudit: mockWriteAudit });
  assert.equal(commitPlan.inserted, 1, 'Plan committed successfully');
  console.log(`✓ Plan commit passed: 1 inserted`);

  // 5. Test Preview & Commit for Products
  const testPrdCode = `${testProjHCode}-PLN-01-PRD-001`;
  const wbPrd = new ExcelJS.Workbook();
  const wsPrd = wbPrd.addWorksheet('منتجات ومخرجات المشاريع');
  wsPrd.addRow(['رمز المنتج', 'اسم المنتج', 'رمز المشروع', 'رمز الخطة / المسار', 'الوصف', 'المخرجات المطلوبة', 'الكمية المستهدفة', 'الجهة المسؤولة', 'البريد الإلكتروني لمسؤول المتابعة', 'تاريخ البدء', 'تاريخ الاستحقاق', 'الحالة', 'السماح بمهام متعددة', 'الملاحظات']);
  wsPrd.addRow([testPrdCode, 'منتج اختباري معتمد', testProjCode, testPlanCode, 'وصف المنتج', 'مخرج تجريبي', '10', 'WAMY', '', '2026-09-01', '2026-11-30', 'قيد التنفيذ', 'نعم', 'ملاحظات المنتج']);
  const prdBuf = await wbPrd.xlsx.writeBuffer();

  const previewPrd = await projectHierarchyIO.previewImport('project-products', prdBuf, { pool });
  assert.equal(previewPrd.summary.valid, 1, 'Product preview has 1 valid row');
  console.log(`✓ Product preview validation passed: ${previewPrd.rows[0].product_code}`);

  const commitPrd = await projectHierarchyIO.commitImport('project-products', { rows: previewPrd.rows, mode: 'add_only' }, { pool, user: mockAdminUser, req: mockReq, writeAudit: mockWriteAudit });
  assert.equal(commitPrd.inserted, 1, 'Product committed successfully');
  console.log(`✓ Product commit passed: 1 inserted`);

  // 6. Test Preview & Commit for Phases
  const testPhsCode = `${testProjHCode}-PLN-01-PRD-001-PHS-01`;
  const wbPhs = new ExcelJS.Workbook();
  const wsPhs = wbPhs.addWorksheet('مراحل ومعالم المشاريع');
  wsPhs.addRow(['رمز المرحلة / المعلم', 'اسم المرحلة / المعلم', 'النوع', 'رمز المشروع', 'رمز الخطة / المسار', 'رمز المنتج المرتبط', 'الوصف', 'تاريخ البدء', 'تاريخ الاستحقاق', 'المدة بالأيام', 'الجهة المسؤولة', 'الأولوية', 'الحالة', 'الملاحظات']);
  wsPhs.addRow([testPhsCode, 'مرحلة التحضير الميداني', 'مرحلة تنفيذ', testProjCode, testPlanCode, testPrdCode, 'وصف المرحلة', '2026-09-01', '2026-10-15', 45, 'WAMY', 'عادية', 'لم تبدأ', 'ملاحظات']);
  const phsBuf = await wbPhs.xlsx.writeBuffer();

  const previewPhs = await projectHierarchyIO.previewImport('project-phases', phsBuf, { pool });
  assert.equal(previewPhs.summary.valid, 1, 'Phase preview has 1 valid row');
  console.log(`✓ Phase preview validation passed: ${previewPhs.rows[0].phase_code}`);

  const commitPhs = await projectHierarchyIO.commitImport('project-phases', { rows: previewPhs.rows, mode: 'add_only' }, { pool, user: mockAdminUser, req: mockReq, writeAudit: mockWriteAudit });
  assert.equal(commitPhs.inserted, 1, 'Phase committed successfully');
  console.log(`✓ Phase commit passed: 1 inserted`);

  // 7. Test Dependencies & Safe Deletion
  const deps = await projectHierarchyIO.getProjectDependencies(createdProject.id, pool);
  console.log('Project dependencies count:', deps);
  assert.ok(deps.products >= 1, 'Has linked products');
  assert.ok(deps.plans >= 1, 'Has linked plans/phases');

  // Clean up test records
  await pool.query(`delete from master_plan_items where project_id = $1`, [createdProject.id]);
  await pool.query(`delete from products where project_id = $1`, [createdProject.id]);
  await pool.query(`delete from projects where id = $1`, [createdProject.id]);
  console.log('✓ Cleanup completed');

  console.log('\nALL 7 PROJECT MANAGEMENT & HIERARCHY IO TESTS PASSED! 🎉');
  await pool.end();
}

test().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
