const assert = require('assert');
const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://wamy_user:wamy_password@localhost:5432/wamy_planner'
});

async function runTests() {
  console.log('=== Starting Project Team Hierarchy & Scoping Integration Tests ===');

  const client = await pool.connect();
  try {
    // 1. Create test users: Admin, PM, HeadProject, HeadPlan, Member1, Member2, Outsider
    const uAdmin = '00000000-0000-0000-0000-000000000001';
    const uPM = '11111111-1111-1111-1111-111111111111';
    const uHeadProj = '22222222-2222-2222-2222-222222222222';
    const uHeadPlan = '33333333-3333-3333-3333-333333333333';
    const uMember1 = '44444444-4444-4444-4444-444444444444';
    const uMember2 = '55555555-5555-5555-5555-555555555555';
    const uOutsider = '66666666-6666-6666-6666-666666666666';

    const testUsers = [
      { id: uAdmin, email: 'admin_test@test.local', name: 'Admin Test', role: 'admin', org: 'ALL' },
      { id: uPM, email: 'pm_test@test.local', name: 'PM Test', role: 'supervisor', org: 'WAMY' },
      { id: uHeadProj, email: 'headproj_test@test.local', name: 'Head Proj Test', role: 'supervisor', org: 'WAMY' },
      { id: uHeadPlan, email: 'headplan_test@test.local', name: 'Head Plan Test', role: 'supervisor', org: 'WAMY' },
      { id: uMember1, email: 'member1_test@test.local', name: 'Member 1 Test', role: 'user', org: 'WAMY' },
      { id: uMember2, email: 'member2_test@test.local', name: 'Member 2 Test', role: 'user', org: 'WAMY' },
      { id: uOutsider, email: 'outsider_test@test.local', name: 'Outsider Test', role: 'user', org: 'OTHER' }
    ];

    for (const u of testUsers) {
      await client.query(
        `insert into profiles (id, email, name, role, org, password_hash, status)
         values ($1, $2, $3, $4, $5, 'test_hash_placeholder', 'active')
         on conflict (id) do update set email = excluded.email, name = excluded.name, role = excluded.role, org = excluded.org, status = 'active'`,
        [u.id, u.email, u.name, u.role, u.org]
      );
    }
    console.log('✓ Test profiles initialized.');

    // 2. Create test project assigned to PM
    const projId = '77777777-7777-7777-7777-777777777777';
    await client.query('delete from projects where id = $1', [projId]);
    const projRes = await client.query(
      `insert into projects (id, code, hierarchical_code, name, org, manager_id, status)
       values ($1, 'PRJ-TEAM-TEST', 'PRJ-TEAM-TEST', 'مشروع اختبار هيكل الفريق', 'WAMY', $2, 'active')
       returning *`,
      [projId, uPM]
    );
    assert.strictEqual(projRes.rows[0].manager_id, uPM, 'Project manager must be uPM');
    console.log('✓ Project created with direct manager_id.');

    // 3. Create test plan items
    const plan1Id = '88888888-8888-8888-8888-888888888881';
    const plan2Id = '88888888-8888-8888-8888-888888888882';
    await client.query('delete from master_plan_items where id in ($1, $2)', [plan1Id, plan2Id]);
    await client.query(
      `insert into master_plan_items (id, external_id, project_id, title, track, responsible_org)
       values ($1, 'PLAN-EXT-1', $2, 'خطة الإنتاج المرئي', 'الإعلام', 'WAMY'),
              ($3, 'PLAN-EXT-2', $2, 'خطة النشر الرقمي', 'التسويق', 'WAMY')`,
      [plan1Id, projId, plan2Id]
    );
    console.log('✓ Plan items created under project.');

    // 4. Create Project-wide Team Head assignment
    const asgnProjRes = await client.query(
      `insert into project_team_assignments (project_id, scope, team_head_id, title, notes, created_by)
       values ($1, 'PROJECT', $2, 'مشرف عام المشاريع', 'إشراف على كامل المشروع', $3)
       returning *`,
      [projId, uHeadProj, uPM]
    );
    const asgnProjId = asgnProjRes.rows[0].id;
    assert.strictEqual(asgnProjRes.rows[0].scope, 'PROJECT');
    assert.strictEqual(asgnProjRes.rows[0].plan_item_id, null);
    console.log('✓ Project-wide Team Head assignment created.');

    // 5. Create Plan-specific Team Head assignment
    const asgnPlanRes = await client.query(
      `insert into project_team_assignments (project_id, scope, plan_item_id, team_head_id, title, notes, created_by)
       values ($1, 'PLAN', $2, $3, 'مشرف مسار الإنتاج المرئي', 'إشراف على خطة الإنتاج', $4)
       returning *`,
      [projId, plan1Id, uHeadPlan, uPM]
    );
    const asgnPlanId = asgnPlanRes.rows[0].id;
    assert.strictEqual(asgnPlanRes.rows[0].scope, 'PLAN');
    assert.strictEqual(asgnPlanRes.rows[0].plan_item_id, plan1Id);
    console.log('✓ Plan-specific Team Head assignment created.');

    // 6. Add members under Team Heads
    const mem1Res = await client.query(
      `insert into project_team_members (assignment_id, user_id, role_title, notes, created_by)
       values ($1, $2, 'مخرج ومصمم', 'عضو فريق الإنتاج', $3)
       returning *`,
      [asgnPlanId, uMember1, uHeadPlan]
    );
    assert.strictEqual(mem1Res.rows[0].user_id, uMember1);

    const mem2Res = await client.query(
      `insert into project_team_members (assignment_id, user_id, role_title, notes, created_by)
       values ($1, $2, 'منسق عام', 'عضو فريق المشروع', $3)
       returning *`,
      [asgnProjId, uMember2, uHeadProj]
    );
    assert.strictEqual(mem2Res.rows[0].user_id, uMember2);
    console.log('✓ Team members linked under respective team heads.');

    // 7. Verify aggregated counts query on projects
    const countCheck = await client.query(
      `select p.id,
              count(distinct pta.id) filter (where pta.deleted_at is null and pta.is_active = true) as team_heads_count,
              count(distinct ptm.id) filter (where ptm.deleted_at is null and ptm.is_active = true) as team_members_count
         from projects p
         left join project_team_assignments pta on pta.project_id = p.id
         left join project_team_members ptm on ptm.assignment_id = pta.id
        where p.id = $1
        group by p.id`,
      [projId]
    );
    assert.strictEqual(Number(countCheck.rows[0].team_heads_count), 2, 'Should have 2 team heads');
    assert.strictEqual(Number(countCheck.rows[0].team_members_count), 2, 'Should have 2 team members');
    console.log('✓ Project team_heads_count and team_members_count correctly calculated.');

    // 8. Test RBAC plan item scoping for Plan-specific Team Head
    const planAccessForHeadPlan = await client.query(
      `select distinct pi.id, pi.title
         from master_plan_items pi
        where pi.project_id = $1
          and (
            pi.id in (select plan_item_id from project_team_assignments where team_head_id = $2 and scope = 'PLAN' and deleted_at is null and is_active = true)
            or pi.project_id in (select project_id from project_team_assignments where team_head_id = $2 and scope = 'PROJECT' and deleted_at is null and is_active = true)
          )`,
      [projId, uHeadPlan]
    );
    assert.strictEqual(planAccessForHeadPlan.rows.length, 1, 'Plan-specific head must only access their assigned plan');
    assert.strictEqual(planAccessForHeadPlan.rows[0].id, plan1Id);
    console.log('✓ Plan-specific head scoped strictly to assigned plan item.');

    // 9. Test RBAC plan item scoping for Project-wide Team Head
    const planAccessForHeadProj = await client.query(
      `select distinct pi.id, pi.title
         from master_plan_items pi
        where pi.project_id = $1
          and (
            pi.id in (select plan_item_id from project_team_assignments where team_head_id = $2 and scope = 'PLAN' and deleted_at is null and is_active = true)
            or pi.project_id in (select project_id from project_team_assignments where team_head_id = $2 and scope = 'PROJECT' and deleted_at is null and is_active = true)
          )`,
      [projId, uHeadProj]
    );
    assert.strictEqual(planAccessForHeadProj.rows.length, 2, 'Project-wide head must access all plans under project');
    console.log('✓ Project-wide head accesses all plans under project.');

    // 10. Clean up test records
    await client.query('delete from project_team_members where assignment_id in ($1, $2)', [asgnProjId, asgnPlanId]);
    await client.query('delete from project_team_assignments where project_id = $1', [projId]);
    await client.query('delete from master_plan_items where project_id = $1', [projId]);
    await client.query('delete from projects where id = $1', [projId]);
    console.log('✓ Test cleanup completed.');

    console.log('\n=== ALL PROJECT TEAM HIERARCHY TESTS PASSED SUCCESSFULLY! ===\n');
  } finally {
    client.release();
    await pool.end();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
