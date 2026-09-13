const http = require('http');
const assert = require('assert');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/wamy_media_merged'
});

async function runTests() {
  console.log('=== Starting User Hierarchy and Unified Positions Tests ===\n');

  try {
    // Clean up any lingering test records
    await pool.query(`DELETE FROM profiles WHERE email LIKE 'test_%@wamy.test'`);

    // 1. Verify Database Schema and Migration
    const columnRes = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'profiles' AND column_name = 'reports_to_id'
    `);
    assert.strictEqual(columnRes.rows.length, 1, 'reports_to_id column must exist in profiles table');
    console.log('✔ Schema check: reports_to_id column verified in profiles');

    // 2. Query distinct positions in database
    const positionsRes = await pool.query(`
      SELECT DISTINCT position FROM profiles WHERE deleted_at IS NULL AND position IS NOT NULL
    `);
    console.log('✔ Current positions in DB:', positionsRes.rows.map(r => r.position));

    // 3. Test API / Database Hierarchy logic directly
    // Create test manager (department_manager)
    const mgrRes = await pool.query(`
      INSERT INTO profiles (email, name, role, position, department, status, org, password_hash)
      VALUES ('test_dept_mgr@wamy.test', 'مدير الإدارة التجريبي', 'department_manager', 'مدير إدارة', 'الإدارة العامة للإعلام', 'active', 'wamy', 'dummy_hash')
      RETURNING id, name, role, position
    `);
    const deptMgrId = mgrRes.rows[0].id;
    console.log('✔ Created test Department Manager:', mgrRes.rows[0].name, `(${deptMgrId})`);

    // Create test subordinate (team_head) reporting to deptMgr
    const headRes = await pool.query(`
      INSERT INTO profiles (email, name, role, position, department, status, org, reports_to_id, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, name, role, position, reports_to_id
    `, ['test_team_head@wamy.test', 'رئيس القسم التجريبي', 'team_head', 'رئيس قسم', 'الإدارة العامة للإعلام', 'active', 'wamy', deptMgrId, 'dummy_hash']);
    const teamHeadId = headRes.rows[0].id;
    assert.strictEqual(headRes.rows[0].reports_to_id, deptMgrId);
    console.log('✔ Created test Team Head reporting to Dept Manager:', headRes.rows[0].name);

    // Create test member (team_member) reporting to teamHead
    const memberRes = await pool.query(`
      INSERT INTO profiles (email, name, role, position, department, status, org, reports_to_id, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, name, role, position, reports_to_id
    `, ['test_member@wamy.test', 'موظف القسم التجريبي', 'team_member', 'موظف قسم', 'الإدارة العامة للإعلام', 'active', 'wamy', teamHeadId, 'dummy_hash']);
    const memberId = memberRes.rows[0].id;
    assert.strictEqual(memberRes.rows[0].reports_to_id, teamHeadId);
    console.log('✔ Created test Team Member reporting to Team Head:', memberRes.rows[0].name);

    // 4. Test Manager Joins and direct_reports_count query as used in server.js
    const hierarchyQuery = await pool.query(`
      SELECT p.id, p.name, p.role, p.position, p.reports_to_id,
             mgr.name as manager_name, mgr.role as manager_role, mgr.position as manager_position,
             (SELECT count(*)::int FROM profiles sub WHERE sub.reports_to_id = p.id AND sub.deleted_at IS NULL) as direct_reports_count
      FROM profiles p
      LEFT JOIN profiles mgr ON mgr.id = p.reports_to_id
      WHERE p.id IN ($1, $2, $3)
      ORDER BY p.created_at ASC
    `, [deptMgrId, teamHeadId, memberId]);

    const mgrRow = hierarchyQuery.rows.find(r => r.id === deptMgrId);
    const headRow = hierarchyQuery.rows.find(r => r.id === teamHeadId);
    const memberRow = hierarchyQuery.rows.find(r => r.id === memberId);

    assert.strictEqual(mgrRow.direct_reports_count, 1, 'Department Manager should have 1 direct report (team_head)');
    assert.strictEqual(headRow.manager_name, 'مدير الإدارة التجريبي');
    assert.strictEqual(headRow.manager_position, 'مدير إدارة');
    assert.strictEqual(headRow.direct_reports_count, 1, 'Team Head should have 1 direct report (team_member)');
    assert.strictEqual(memberRow.manager_name, 'رئيس القسم التجريبي');
    assert.strictEqual(memberRow.manager_position, 'رئيس قسم');
    assert.strictEqual(memberRow.direct_reports_count, 0, 'Team Member should have 0 direct reports');

    console.log('✔ Successfully verified hierarchical relationship and joins across 3 levels:');
    console.log(`   - Dept Manager: ${mgrRow.name} -> direct reports: ${mgrRow.direct_reports_count}`);
    console.log(`   - Team Head: ${headRow.name} (Manager: ${headRow.manager_name}) -> direct reports: ${headRow.direct_reports_count}`);
    console.log(`   - Team Member: ${memberRow.name} (Manager: ${memberRow.manager_name}) -> direct reports: ${memberRow.direct_reports_count}`);

    // Cleanup test records
    await pool.query(`DELETE FROM profiles WHERE id IN ($1, $2, $3)`, [deptMgrId, teamHeadId, memberId]);
    console.log('✔ Cleaned up test profiles successfully');

    console.log('\n🎉 ALL USER HIERARCHY AND UNIFIED POSITION TESTS PASSED SUCCESSFULLY! 🎉\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runTests();
