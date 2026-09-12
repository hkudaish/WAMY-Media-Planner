'use strict';

const assert = require('assert');
const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const reportsEngine = require('../server/reports-engine');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://wamy_user:wamy_password@localhost:5432/wamy_planner'
});

async function runTests() {
  console.log('=== Starting Reports Engine Integration Tests ===');

  const client = await pool.connect();
  try {
    // 1. Set up test users
    const uAdmin = '00000000-0000-0000-0000-000000000001';
    const uPM = '11111111-1111-1111-1111-111111111111';
    const uHeadProj = '22222222-2222-2222-2222-222222222222';
    const uHeadPlan = '33333333-3333-3333-3333-333333333333';
    const uMember = '44444444-4444-4444-4444-444444444444';
    const uOutsider = '66666666-6666-6666-6666-666666666666';

    const testUsers = [
      { id: uAdmin, email: 'admin_rep@test.local', name: 'Admin Rep', role: 'admin', org: 'ALL' },
      { id: uPM, email: 'pm_rep@test.local', name: 'PM Rep', role: 'supervisor', org: 'WAMY' },
      { id: uHeadProj, email: 'headproj_rep@test.local', name: 'Head Proj Rep', role: 'supervisor', org: 'WAMY' },
      { id: uHeadPlan, email: 'headplan_rep@test.local', name: 'Head Plan Rep', role: 'supervisor', org: 'WAMY' },
      { id: uMember, email: 'member_rep@test.local', name: 'Member Rep', role: 'user', org: 'WAMY' },
      { id: uOutsider, email: 'outsider_rep@test.local', name: 'Outsider Rep', role: 'user', org: 'OTHER' }
    ];

    for (const u of testUsers) {
      await client.query(
        `insert into profiles (id, email, name, role, org, password_hash, status)
         values ($1, $2, $3, $4, $5, 'test_hash_placeholder', 'active')
         on conflict (id) do update set email = excluded.email, name = excluded.name, role = excluded.role, org = excluded.org, status = 'active'`,
        [u.id, u.email, u.name, u.role, u.org]
      );
    }
    console.log('✓ Test user profiles verified.');

    // 2. Create test project, plan, team head, team member, and tasks
    const projId = '77777777-7777-7777-7777-777777777777';
    await client.query('delete from projects where id = $1', [projId]);
    await client.query(
      `insert into projects (id, code, hierarchical_code, name, org, manager_id, status)
       values ($1, 'PRJ-REP-01', 'PRJ-REP-01', 'مشروع تقارير اختباري', 'WAMY', $2, 'active')`,
      [projId, uPM]
    );

    const plan1Id = '88888888-8888-8888-8888-888888888881';
    await client.query('delete from master_plan_items where id = $1', [plan1Id]);
    await client.query(
      `insert into master_plan_items (id, project_id, external_id, hierarchical_code, title, responsible_org, baseline_status)
       values ($1, $2, 'PLN-REP-01', 'PRJ-REP-01-01', 'خطة التقارير الأولى', 'WAMY', 'not_started')`,
      [plan1Id, projId]
    );

    // Team head assignment on project
    const assignHeadId = '99999999-9999-9999-9999-999999999991';
    await client.query('delete from project_team_assignments where id = $1', [assignHeadId]);
    await client.query(
      `insert into project_team_assignments (id, project_id, plan_item_id, team_head_id, scope, title, is_active)
       values ($1, $2, null, $3, 'PROJECT', 'رئيس الفريق البرمجي', true)`,
      [assignHeadId, projId, uHeadProj]
    );

    // Team member assignment under head
    const memberAssignId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await client.query('delete from project_team_members where id = $1', [memberAssignId]);
    await client.query(
      `insert into project_team_members (id, assignment_id, user_id, role_title, is_active)
       values ($1, $2, $3, 'مبرمج', true)`,
      [memberAssignId, assignHeadId, uMember]
    );

    // Create 2 tasks: 1 assigned to uMember (delayed), 1 completed
    const t1Id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01';
    const t2Id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02';
    await client.query('delete from tasks where id in ($1, $2)', [t1Id, t2Id]);
    
    // Task 1: Overdue task
    await client.query(
      `insert into tasks (id, project_id, plan_item_id, org, title, status, priority, progress, planned_start, due_date, assignee_id)
       values ($1, $2, $3, 'WAMY', 'مهمة تقرير متأخرة', 'in_progress', 'high', 40, '2026-01-01', '2026-02-01', $4)`,
      [t1Id, projId, plan1Id, uMember]
    );

    // Task 2: Completed task
    await client.query(
      `insert into tasks (id, project_id, plan_item_id, org, title, status, priority, progress, planned_start, due_date, assignee_id)
       values ($1, $2, $3, 'WAMY', 'مهمة تقرير مكتملة', 'completed', 'normal', 100, '2026-01-01', '2026-02-01', $4)`,
      [t2Id, projId, plan1Id, uMember]
    );

    console.log('✓ Test project hierarchy & tasks prepared.');

    // 3. Test Filter Metadata for Admin vs Outsider
    const adminUser = testUsers[0];
    const outsiderUser = testUsers[5];
    const pmUser = testUsers[1];

    const adminMeta = await reportsEngine.getFilterMetadata(pool, adminUser, {});
    assert(adminMeta.projects.some(p => p.id === projId), 'Admin metadata must include test project');
    assert(adminMeta.managers.some(m => m.id === uPM), 'Admin metadata must include PM');
    assert(adminMeta.team_heads.some(h => h.id === uHeadProj), 'Admin metadata must include HeadProj');
    assert(adminMeta.team_members.some(m => m.id === uMember), 'Admin metadata must include Member');
    console.log('✓ Admin filter metadata correctly returned all entities.');

    // Cascading metadata test: selecting project filters plans and heads
    const cascadeMeta = await reportsEngine.getFilterMetadata(pool, adminUser, { project_id: projId });
    assert.strictEqual(cascadeMeta.plans.length, 1, 'Cascading by project should return exactly 1 plan');
    assert.strictEqual(cascadeMeta.plans[0].id, plan1Id, 'Plan id should match');
    assert(cascadeMeta.team_heads.some(h => h.id === uHeadProj), 'Cascading by project should include project team head');
    console.log('✓ Cascading filter metadata correctly scoped by project.');

    // 4. Test RBAC Scoping for PM
    const pmRep = await reportsEngine.queryReports(pool, pmUser, { project_id: projId });
    assert.strictEqual(pmRep.summary.total_tasks, 2, 'PM should see both tasks for assigned project');
    assert.strictEqual(pmRep.summary.completed_tasks, 1, 'Completed count should be 1');
    assert.strictEqual(pmRep.summary.in_progress_tasks, 1, 'In progress count should be 1');
    assert.strictEqual(pmRep.summary.overdue_tasks, 1, 'Overdue count should be 1');
    assert.strictEqual(pmRep.summary.avg_progress, 70, 'Average progress should be (40+100)/2 = 70%');
    console.log('✓ PM query correctly returned scoped data and accurate KPIs.');

    // 5. Test Outsider Scoping (must see 0 rows)
    const outsiderRep = await reportsEngine.queryReports(pool, outsiderUser, { project_id: projId });
    assert.strictEqual(outsiderRep.summary.total_tasks, 0, 'Outsider must not see tasks in other org/unassigned project');
    assert.strictEqual(outsiderRep.rows.length, 0, 'Outsider task rows must be empty');
    console.log('✓ RBAC security isolation verified for unauthorized user.');

    // 6. Test Excel Export Generation
    const workbook = await reportsEngine.exportReportsExcel(pool, adminUser, { project_id: projId });
    assert(workbook && typeof workbook.xlsx.writeBuffer === 'function', 'Excel workbook must be valid ExcelJS instance');
    const buffer = await workbook.xlsx.writeBuffer();
    assert(buffer && buffer.length > 0, 'Excel buffer must not be empty');
    console.log(`✓ Excel export workbook generated successfully (${buffer.length} bytes).`);

    // 7. Test CSV Export Generation
    const csv = await reportsEngine.exportReportsCsv(pool, adminUser, { project_id: projId });
    assert(csv && csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM');
    assert(csv.includes('مهمة تقرير متأخرة'), 'CSV must contain task title in Arabic');
    console.log('✓ CSV export generated with UTF-8 BOM and correct Arabic content.');

    console.log('=== All Reports Engine Tests Passed! ===');
  } finally {
    client.release();
    await pool.end();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
