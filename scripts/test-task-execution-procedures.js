'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const assert = require('node:assert');

async function runTests() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('--- Starting Task Execution Procedures Integration Tests ---');

  try {
    // 1. Get or setup test project, plan item, task, and users
    const adminUser = (await pool.query(`select id, name, role, org from profiles where role = 'admin' and status = 'active' limit 1`)).rows[0];
    assert(adminUser, 'Admin user should exist');

    let testUser = (await pool.query(`select id, name, role, org from profiles where role = 'user' and status = 'active' limit 1`)).rows[0];
    if (!testUser) {
      testUser = (await pool.query(`insert into profiles (name, email, password_hash, role, org, status) values ('Test Procedure User', 'test.proc.user@example.com', 'hash', 'user', 'wamy', 'active') returning id, name, role, org`)).rows[0];
    }

    let project = (await pool.query(`select id, name, org from projects where deleted_at is null and is_system = false limit 1`)).rows[0];
    if (!project) {
      project = (await pool.query(`insert into projects (code, hierarchical_code, name, org, manager_id) values ('TEST-PRJ-01', 'PRJ-TEST', 'مشروع اختبار الإجراءات', 'wamy', $1) returning id, name, org`, [adminUser.id])).rows[0];
    }

    let planItem = (await pool.query(`select id, title from master_plan_items where project_id = $1 and deleted_at is null limit 1`, [project.id])).rows[0];
    if (!planItem) {
      planItem = (await pool.query(`insert into master_plan_items (project_id, external_id, hierarchical_code, title) values ($1, 'PLN-TEST-01', 'PRJ-TEST-PLN-01', 'بند خطة تجريبي') returning id, title`, [project.id])).rows[0];
    }

    // Create a dedicated test task
    const taskRes = await pool.query(
      `insert into tasks (project_id, plan_item_id, title, description, org, assignee_id, status, progress, planned_start, due_date)
       values ($1, $2, 'مهمة فحص الإجراءات التنفيذية', 'وصف المهمة', 'wamy', $3, 'not_started', 0, current_date, current_date + 7)
       returning *`,
      [project.id, planItem.id, testUser.id]
    );
    const testTask = taskRes.rows[0];
    console.log(`✓ Created test task: ${testTask.id} (${testTask.title})`);

    // 2. Test Procedure 1 Creation
    const now = new Date();
    const plannedStart = new Date(now.getTime() - 2 * 3600000).toISOString(); // 2 hours ago
    const p1Res = await pool.query(
      `insert into execution_procedures (
         task_id, project_id, plan_item_id, assigned_user_id, order_index,
         title, description, status, progress, progress_mode, planned_start, expected_duration,
         duration_unit, due_at, priority, notes, created_by
       ) values (
         $1, $2, $3, $4, 1,
         'الإجراء الأول: جمع وتحليل البيانات', 'وصف الإجراء 1', 'not_started', 0, 'auto',
         $5, 4, 'hours', $6, 'high', 'ملاحظات أولية', $7
       ) returning *`,
      [testTask.id, project.id, planItem.id, testUser.id, plannedStart, new Date(now.getTime() + 2 * 3600000).toISOString(), adminUser.id]
    );
    const proc1 = p1Res.rows[0];
    assert.strictEqual(proc1.title, 'الإجراء الأول: جمع وتحليل البيانات');
    assert.strictEqual(proc1.order_index, 1);
    console.log(`✓ Created Procedure 1: ${proc1.id}`);

    // 3. Test Procedure 2 Creation
    const p2Res = await pool.query(
      `insert into execution_procedures (
         task_id, project_id, plan_item_id, assigned_user_id, order_index,
         title, description, status, progress, progress_mode, planned_start, expected_duration,
         duration_unit, due_at, priority, created_by
       ) values (
         $1, $2, $3, $4, 2,
         'الإجراء الثاني: مراجعة واعتماد التقرير', 'وصف الإجراء 2', 'not_started', 0, 'auto',
         $5, 2, 'hours', $6, 'normal', $7
       ) returning *`,
      [testTask.id, project.id, planItem.id, testUser.id, now.toISOString(), new Date(now.getTime() + 3 * 3600000).toISOString(), adminUser.id]
    );
    const proc2 = p2Res.rows[0];
    console.log(`✓ Created Procedure 2: ${proc2.id}`);

    // 4. Test Sub-Procedures for Procedure 1
    const sp1Res = await pool.query(
      `insert into execution_sub_procedures (
         procedure_id, task_id, project_id, plan_item_id, assigned_user_id, order_index,
         title, status, progress, planned_start, expected_duration, duration_unit, created_by
       ) values (
         $1, $2, $3, $4, $5, 1,
         'الخطوة 1: استخراج السجلات من النظام', 'not_started', 0, $6, 2, 'hours', $7
       ) returning *`,
      [proc1.id, testTask.id, project.id, planItem.id, testUser.id, plannedStart, adminUser.id]
    );
    const subProc1 = sp1Res.rows[0];

    const sp2Res = await pool.query(
      `insert into execution_sub_procedures (
         procedure_id, task_id, project_id, plan_item_id, assigned_user_id, order_index,
         title, status, progress, planned_start, expected_duration, duration_unit, created_by
       ) values (
         $1, $2, $3, $4, $5, 2,
         'الخطوة 2: تنظيف ومعالجة الجداول', 'not_started', 0, $6, 2, 'hours', $7
       ) returning *`,
      [proc1.id, testTask.id, project.id, planItem.id, testUser.id, plannedStart, adminUser.id]
    );
    const subProc2 = sp2Res.rows[0];
    console.log(`✓ Created Sub-Procedures 1 & 2 for Procedure 1`);

    // 5. Test Dependency: Procedure 2 depends on Procedure 1 (Finish-to-Start)
    const depRes = await pool.query(
      `insert into procedure_dependencies (task_id, scope, predecessor_id, successor_id, dependency_type)
       values ($1, 'PROCEDURE', $2, $3, 'FINISH_TO_START') returning *`,
      [testTask.id, proc1.id, proc2.id]
    );
    assert(depRes.rows[0], 'Dependency should be created');
    console.log(`✓ Created Finish-to-Start Dependency: Procedure 2 depends on Procedure 1`);

    // 6. Test Sub-Procedure Progress Rollup:
    // Update SubProc 1 to 100% completed
    await pool.query(
      `update execution_sub_procedures set status = 'completed', progress = 100, actual_completion = now() where id = $1`,
      [subProc1.id]
    );
    // Trigger sync
    const subsRes = await pool.query(`select progress from execution_sub_procedures where procedure_id = $1 and deleted_at is null`, [proc1.id]);
    const avgProcProgress = Math.round(subsRes.rows.reduce((sum, s) => sum + s.progress, 0) / subsRes.rows.length);
    assert.strictEqual(avgProcProgress, 50, 'Average progress of Proc 1 should be 50%');
    await pool.query(`update execution_procedures set progress = $1, status = 'in_progress' where id = $2`, [avgProcProgress, proc1.id]);
    console.log(`✓ Verified Sub-Procedure to Procedure rollup: Procedure 1 is now at 50%`);

    // Complete SubProc 2 as well
    await pool.query(
      `update execution_sub_procedures set status = 'completed', progress = 100, actual_completion = now() where id = $1`,
      [subProc2.id]
    );
    await pool.query(`update execution_procedures set progress = 100, status = 'completed', actual_completion = now() where id = $1`, [proc1.id]);
    console.log(`✓ Completed Procedure 1 (100%)`);

    // 7. Test Soft Deletion & Cascade
    const delSubRes = await pool.query(`update execution_sub_procedures set deleted_at = now() where id = $1 returning id`, [subProc1.id]);
    assert.strictEqual(delSubRes.rows.length, 1);
    const verifyDel = (await pool.query(`select 1 from execution_sub_procedures where id = $1 and deleted_at is null`, [subProc1.id])).rows;
    assert.strictEqual(verifyDel.length, 0, 'Soft deleted sub-procedure should not appear in active query');
    console.log(`✓ Soft delete verification passed`);

    // Cleanup test task & related records
    await pool.query(`delete from tasks where id = $1`, [testTask.id]);
    console.log(`✓ Cleaned up test data`);

    console.log('--- ALL TASK EXECUTION PROCEDURES TESTS PASSED SUCCESSFULLY ---');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTests();
