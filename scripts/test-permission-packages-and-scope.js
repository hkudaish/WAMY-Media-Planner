'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const adminToken = `test-admin-${crypto.randomBytes(24).toString('base64url')}`;
const adminHash = crypto.createHash('sha256').update(adminToken).digest('hex');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;

async function call(path, options = {}, expected = 200, cookie = `wamy_session=${adminToken}`) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, expected, `${path}: expected ${expected} got ${response.status} - ${(body && (body.message || body.error)) || ''}`);
  return { body, response };
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let createdPkgId = null;
  let clonedPkgId = null;
  let testUserId = null;
  let testUser2Id = null;

  try {
    console.log('--- 1. Testing Admin Authentication and Seeded Packages ---');
    const admin = (await client.query(`select id from profiles where role='admin' and status='active' and deleted_at is null limit 1`)).rows[0];
    assert.ok(admin, 'Active admin user must exist');
    await client.query(`insert into sessions(token_hash, user_id, expires_at) values($1, $2, now() + interval '1 hour')`, [adminHash, admin.id]);

    const { body: pkgs } = await call('/api/permission-packages');
    assert.ok(Array.isArray(pkgs), 'Permission packages must be an array');
    assert.ok(pkgs.length >= 5, 'Should have at least 5 default seeded packages');

    const adminPkg = pkgs.find(p => p.code === 'admin_package');
    const pmPkg = pkgs.find(p => p.code === 'project_manager_package');
    const dmPkg = pkgs.find(p => p.code === 'department_manager_package');
    const thPkg = pkgs.find(p => p.code === 'team_head_package');
    const tmPkg = pkgs.find(p => p.code === 'team_member_package');

    assert.ok(adminPkg, 'admin_package must exist');
    assert.ok(pmPkg, 'project_manager_package must exist');
    assert.ok(dmPkg, 'department_manager_package must exist');
    assert.ok(thPkg, 'team_head_package must exist');
    assert.ok(tmPkg, 'team_member_package must exist');

    // Verify team_head has NO create project/plan/product/timeline
    assert.equal(thPkg.permissions['Projects.Create'], false, 'Team head cannot create projects');
    assert.equal(thPkg.permissions['Plans.Create'], false, 'Team head cannot create plans');
    assert.equal(thPkg.permissions['Products.Create'], false, 'Team head cannot create products');

    console.log('PASS  Seeded packages verified with correct role associations and restrictions');

    console.log('--- 2. Testing Permission Package CRUD & Clone ---');
    // Create Custom Package
    const newPkgPayload = {
      code: `custom_pkg_${Date.now()}`,
      name: 'باقة مخصصة لاختبار النظام',
      description: 'وصف باقة تجريبية',
      scope_type: 'مشروع',
      permissions: { 'Dashboard.View': true, 'Tasks.View': true, 'Files.View': true },
      is_active: true
    };
    const { body: createdPkg } = await call('/api/permission-packages', {
      method: 'POST',
      body: JSON.stringify(newPkgPayload)
    }, 201);

    assert.ok(createdPkg && createdPkg.id);
    assert.equal(createdPkg.name, newPkgPayload.name);
    createdPkgId = createdPkg.id;

    // Update Custom Package
    const { body: updatedPkg } = await call(`/api/permission-packages/${createdPkgId}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...createdPkg,
        name: 'باقة مخصصة محدثة',
        permissions: { ...createdPkg.permissions, 'Reports.View': true }
      })
    }, 200);
    assert.equal(updatedPkg.name, 'باقة مخصصة محدثة');
    assert.equal(updatedPkg.permissions['Reports.View'], true);

    // Clone Custom Package
    const { body: clonedPkg } = await call(`/api/permission-packages/${createdPkgId}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name: 'نسخة من الباقة المخصصة' })
    }, 201);
    assert.ok(clonedPkg && clonedPkg.id);
    assert.notEqual(clonedPkg.id, createdPkgId);
    assert.equal(clonedPkg.permissions['Reports.View'], true);
    clonedPkgId = clonedPkg.id;

    // Delete Cloned Package
    await call(`/api/permission-packages/${clonedPkgId}`, { method: 'DELETE' }, 200);
    clonedPkgId = null;

    // Prevent deletion of system packages
    await call(`/api/permission-packages/${adminPkg.id}`, { method: 'DELETE' }, 400);

    console.log('PASS  Permission Package CRUD and cloning validated');

    console.log('--- 3. Testing User Invitation & Creation with Scope and Package ---');
    // Get existing projects
    const testProjects = (await client.query(`select id, name from projects where deleted_at is null limit 2`)).rows;
    assert.ok(testProjects.length > 0, 'At least 1 project should exist');
    const assignedProjIds = testProjects.map(p => p.id);

    const testEmail1 = `pm-test-${Date.now()}@example.org`;
    const { body: inviteResult } = await call('/api/profiles/invite', {
      method: 'POST',
      body: JSON.stringify({
        name: 'مدير مشروع تجريبي',
        email: testEmail1,
        position: 'مدير محفظة',
        org: 'wamy',
        role: 'project_manager',
        scope_type: 'مشروع',
        assigned_project_ids: assignedProjIds,
        assigned_department: '',
        package_id: pmPkg.id,
        direct_permissions_allow: { 'Settings.ViewAudit': true },
        direct_permissions_deny: {}
      })
    }, 201);

    assert.ok(inviteResult && inviteResult.user);
    testUserId = inviteResult.user.id;
    assert.equal(inviteResult.user.scope_type, 'مشروع');
    assert.deepEqual(inviteResult.user.assigned_project_ids, assignedProjIds);
    assert.equal(inviteResult.user.package_id, pmPkg.id);

    // Verify DB stored correctly
    const dbUser1 = (await client.query(`select * from profiles where id = $1`, [testUserId])).rows[0];
    assert.equal(dbUser1.scope_type, 'مشروع');
    assert.deepEqual(dbUser1.assigned_project_ids, assignedProjIds);
    assert.equal(dbUser1.package_id, pmPkg.id);
    assert.equal(dbUser1.direct_permissions_allow['Settings.ViewAudit'], true);

    console.log('PASS  Project scope user created and validated in database');

    console.log('--- 4. Testing User Profile Update with Department Scope & Role Change ---');
    const { body: updateRes } = await call(`/api/profiles/${testUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'رئيس قسم الإعلام الرقمي',
        role: 'team_head',
        scope_type: 'إدارة',
        assigned_department: 'الإعلام الرقمي',
        assigned_project_ids: [],
        package_id: thPkg.id,
        direct_permissions_allow: {},
        direct_permissions_deny: {}
      })
    }, 200);

    const updatedUser = Array.isArray(updateRes) ? updateRes[0] : updateRes;
    assert.equal(updatedUser.role, 'team_head');
    assert.equal(updatedUser.scope_type, 'إدارة');
    assert.equal(updatedUser.assigned_department, 'الإعلام الرقمي');
    assert.equal(updatedUser.package_id, thPkg.id);

    console.log('PASS  User profile updated to Department scope with team_head role');

    console.log('--- 5. Testing Effective Permissions Resolution & Enforcement ---');
    // Create an active session for the updated user
    const userToken = `test-user-${crypto.randomBytes(24).toString('base64url')}`;
    const userTokenHash = crypto.createHash('sha256').update(userToken).digest('hex');
    await client.query(`update profiles set status='active' where id=$1`, [testUserId]);
    await client.query(`insert into sessions(token_hash, user_id, expires_at) values($1, $2, now() + interval '1 hour')`, [userTokenHash, testUserId]);

    const { body: meProfile } = await call('/api/profiles/me', {}, 200, `wamy_session=${userToken}`);
    assert.equal(meProfile.id, testUserId);
    assert.equal(meProfile.role, 'team_head');
    assert.equal(meProfile.scope_type, 'إدارة');
    assert.equal(meProfile.assigned_department, 'الإعلام الرقمي');
    assert.ok(meProfile.package_name, 'Package name should be attached');
    assert.equal(meProfile.effective_permissions['Projects.Create'], false, 'Should enforce team_head package restrictions');

    // Attempting an unauthorized action (create a project as team_head without Projects.Create)
    await call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: 'مشروع غير مصرح',
        code: `UNAUTH_${Date.now()}`,
        status: 'active'
      })
    }, 403, `wamy_session=${userToken}`);

    console.log('PASS  Effective permissions and authorization properly enforced at API layer');

  } finally {
    console.log('--- 6. Cleaning Up Test Data ---');
    if (testUserId) {
      await client.query(`delete from sessions where user_id=$1`, [testUserId]);
      await client.query(`delete from user_invitations where profile_id=$1`, [testUserId]);
      await client.query(`update profiles set deleted_at=now(), status='disabled' where id=$1`, [testUserId]);
    }
    if (createdPkgId) {
      await client.query(`delete from permission_packages where id=$1`, [createdPkgId]);
    }
    if (clonedPkgId) {
      await client.query(`delete from permission_packages where id=$1`, [clonedPkgId]);
    }
    await client.query(`delete from sessions where token_hash=$1`, [adminHash]);
    await client.end();
    console.log('PASS  Cleanup completed.');
  }
})();
