require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-must-be-32-chars-long-123456';
const PORT = process.env.PORT || '5175';
process.env.APP_ORIGIN = process.env.APP_ORIGIN || `http://127.0.0.1:${PORT}`;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/wamy_media_merged'
});

async function runTests() {
    console.log('=== RUNNING ENHANCED FEATURES TEST SUITE ===\n');

    let adminUser, regularUser, adminSessionToken, userSessionToken;

    // 1. Setup test users and sessions
    console.log('1. Setting up test users and sessions...');
    const testAdminEmail = `admin_test_${Date.now()}@wamy.org`;
    const testUserEmail = `user_test_${Date.now()}@wamy.org`;
    const initialAdminPass = 'InitialAdminPass123!';
    const initialUserPass = 'InitialUserPass123!';

    const adminHash = await bcrypt.hash(initialAdminPass, 10);
    const userHash = await bcrypt.hash(initialUserPass, 10);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const adminRes = await client.query(`
            INSERT INTO profiles (email, password_hash, name, role, org, data_scope, status, permissions)
            VALUES ($1, $2, 'Test Admin', 'admin', 'wamy', 'all_data', 'active', '{}'::jsonb)
            RETURNING *
        `, [testAdminEmail, adminHash]);
        adminUser = adminRes.rows[0];

        const userRes = await client.query(`
            INSERT INTO profiles (email, password_hash, name, role, org, data_scope, status, permissions)
            VALUES ($1, $2, 'Test User', 'user', 'wamy', 'my_data', 'active', '{"Tasks.View":true,"Tasks.Create":true}'::jsonb)
            RETURNING *
        `, [testUserEmail, userHash]);
        regularUser = userRes.rows[0];

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    const BASE_URL = `http://127.0.0.1:${process.env.PORT}`;

    // Helper for API calls
    async function api(path, options = {}, token = null) {
        const headers = {
            'Content-Type': 'application/json',
            'Origin': process.env.APP_ORIGIN,
            ...(options.headers || {})
        };
        if (token) {
            headers['Cookie'] = `wamy_session=${token}`;
        }
        const res = await fetch(`${BASE_URL}${path}`, {
            ...options,
            headers
        });

        const setCookie = res.headers.get('set-cookie');
        let sessionCookie = null;
        if (setCookie) {
            const match = setCookie.match(/wamy_session=([^;]+)/);
            if (match) sessionCookie = match[1];
        }

        let data = null;
        const text = await res.text();
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = text;
        }

        return { status: res.status, ok: res.ok, data, sessionCookie };
    }

    // Login admin
    console.log('Logging in admin and regular user...');
    const adminLogin = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: testAdminEmail, password: initialAdminPass })
    });
    assert.strictEqual(adminLogin.status, 200, 'Admin login should succeed');
    adminSessionToken = adminLogin.sessionCookie;

    // Login regular user
    const userLogin = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: testUserEmail, password: initialUserPass })
    });
    assert.strictEqual(userLogin.status, 200, 'User login should succeed');
    userSessionToken = userLogin.sessionCookie;

    console.log('PASS: Authentication setup completed.\n');

    // -------------------------------------------------------------
    // SECTION A: PASSWORD MANAGEMENT
    // -------------------------------------------------------------
    console.log('--- SECTION A: PASSWORD MANAGEMENT ---');

    // A.1: Self-service password change - Validation errors
    console.log('Testing self-service password change validation...');
    const shortPass = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: initialUserPass, newPassword: 'short' })
    }, userSessionToken);
    assert.strictEqual(shortPass.status, 400, 'Should reject password under 12 characters');
    const shortPassMsg = shortPass.data.message || shortPass.data.error || '';
    assert.ok(shortPassMsg.includes('12'), 'Error should mention 12 characters minimum');

    const wrongCurrent = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'WrongPassword123!', newPassword: 'ValidNewPassword123!' })
    }, userSessionToken);
    assert.strictEqual(wrongCurrent.status, 401, 'Should reject wrong current password with 401');

    // A.2: Self-service password change - Success & session invalidation
    console.log('Testing successful self-service password change and other session revocation...');
    // Create a second concurrent session for the regular user
    const secondLogin = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: testUserEmail, password: initialUserPass })
    });
    assert.strictEqual(secondLogin.status, 200);
    const secondUserSessionToken = secondLogin.sessionCookie;

    const newPass = 'BrandNewValidPassword2026!';
    const changeSuccess = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: initialUserPass, newPassword: newPass })
    }, userSessionToken);
    assert.strictEqual(changeSuccess.status, 200, 'Should change password successfully');

    // Verify second session is now invalidated
    const secondSessionTest = await api('/api/profiles/me', {}, secondUserSessionToken);
    assert.strictEqual(secondSessionTest.status, 401, 'Other concurrent sessions should be invalidated');

    // Verify new login works with new password
    const newLogin = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: testUserEmail, password: newPass })
    });
    assert.strictEqual(newLogin.status, 200, 'Login with new password should succeed');
    userSessionToken = newLogin.sessionCookie;

    // A.3: Admin password reset
    console.log('Testing Admin password reset...');
    const nonAdminReset = await api(`/api/profiles/${regularUser.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'AdminResetPassword123!' })
    }, userSessionToken);
    assert.strictEqual(nonAdminReset.status, 403, 'Non-admin cannot reset passwords');

    const adminResetPass = 'AdminForcedResetPass2026!';
    const adminReset = await api(`/api/profiles/${regularUser.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: adminResetPass })
    }, adminSessionToken);
    assert.strictEqual(adminReset.status, 200, 'Admin reset password should succeed');

    // Verify target user's session was invalidated by admin reset
    const userSessionAfterAdminReset = await api('/api/profiles/me', {}, userSessionToken);
    assert.strictEqual(userSessionAfterAdminReset.status, 401, 'Target user session should be invalidated after admin reset');

    // Verify user can log in with the admin reset password
    const loginAfterAdminReset = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: testUserEmail, password: adminResetPass })
    });
    assert.strictEqual(loginAfterAdminReset.status, 200, 'Login with admin-reset password should succeed');
    userSessionToken = loginAfterAdminReset.sessionCookie;

    console.log('PASS: Password management verified 100%.\n');

    // -------------------------------------------------------------
    // SECTION B: DYNAMIC ORGANIZATIONS REGISTRY
    // -------------------------------------------------------------
    console.log('--- SECTION B: DYNAMIC ORGANIZATIONS REGISTRY ---');

    // B.1: List organizations
    console.log('Testing listing organizations...');
    const orgsList = await api('/api/organizations', {}, userSessionToken);
    assert.strictEqual(orgsList.status, 200, 'Should fetch organizations');
    assert.ok(Array.isArray(orgsList.data), 'Data should be an array');
    const codes = orgsList.data.map(o => o.code);
    assert.ok(codes.includes('wamy'), 'Should include wamy');
    assert.ok(codes.includes('imaan'), 'Should include imaan');

    // B.2: Non-admin cannot create org
    console.log('Testing organization creation permissions...');
    const forbiddenOrgCreate = await api('/api/organizations', {
        method: 'POST',
        body: JSON.stringify({ code: 'partner1', name: 'Partner 1', short_name: 'P1' })
    }, userSessionToken);
    assert.strictEqual(forbiddenOrgCreate.status, 403, 'Non-admin without permission should be 403');

    // B.3: Admin creates new org
    console.log('Testing Admin organization creation and validation...');
    const invalidCodeOrg = await api('/api/organizations', {
        method: 'POST',
        body: JSON.stringify({ code: 'Invalid Code With Spaces', name: 'Bad Org' })
    }, adminSessionToken);
    assert.strictEqual(invalidCodeOrg.status, 400, 'Should reject invalid code format');

    const testOrgCode = `org_${Date.now().toString().slice(-6)}`;
    const createOrgRes = await api('/api/organizations', {
        method: 'POST',
        body: JSON.stringify({
            code: testOrgCode,
            name: 'منظمة الشراكة الدولية للشباب',
            short_name: 'شراكة',
            color: '#8b5cf6'
        })
    }, adminSessionToken);
    assert.strictEqual(createOrgRes.status, 201, 'Should create organization');
    const createdOrg = createOrgRes.data;
    assert.strictEqual(createdOrg.code, testOrgCode);

    // B.4: Update organization
    console.log('Testing organization update...');
    const updateOrgRes = await api(`/api/organizations/${createdOrg.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'مؤسسة الشراكة الدولية المحدثة', short_name: 'شراكة+' })
    }, adminSessionToken);
    assert.strictEqual(updateOrgRes.status, 200, 'Should update organization');
    assert.strictEqual(updateOrgRes.data.name, 'مؤسسة الشراكة الدولية المحدثة');

    // B.5: Deactivation
    console.log('Testing organization deactivation...');
    const deactivateRes = await api(`/api/organizations/${createdOrg.id}/deactivate`, {
        method: 'POST'
    }, adminSessionToken);
    assert.strictEqual(deactivateRes.status, 200, 'Should deactivate organization');
    assert.strictEqual(deactivateRes.data.is_active, false);

    // B.6: Activation
    console.log('Testing organization activation...');
    const activateRes = await api(`/api/organizations/${createdOrg.id}/activate`, {
        method: 'POST'
    }, adminSessionToken);
    assert.strictEqual(activateRes.status, 200, 'Should reactivate organization');
    assert.strictEqual(activateRes.data.is_active, true);

    // B.7: Dependency check on deletion
    console.log('Testing dependency protection on organization deletion...');
    // Create a project assigned to this org
    const projWithOrg = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
            code: `PRJ-ORG-${Date.now().toString().slice(-4)}`,
            name: 'مشروع جهة تجريبية',
            org: testOrgCode,
            classification: 'استراتيجي'
        })
    }, adminSessionToken);
    assert.strictEqual(projWithOrg.status, 201, 'Should create project under test org');
    const createdProj = projWithOrg.data;
    assert.strictEqual(createdProj.classification, 'استراتيجي', 'Classification field should be stored');

    // Attempt to delete org while project exists
    const blockedDelete = await api(`/api/organizations/${createdOrg.id}`, {
        method: 'DELETE'
    }, adminSessionToken);
    assert.strictEqual(blockedDelete.status, 409, 'Should block deletion with 409 Conflict when dependencies exist');
    const blockedDeleteMsg = blockedDelete.data.message || blockedDelete.data.error || '';
    assert.ok(blockedDeleteMsg.includes('مرتبط'), 'Error should explain linked records exist');

    // Clean up project
    await api(`/api/projects/${createdProj.id}`, { method: 'DELETE' }, adminSessionToken);

    // Now delete org
    const successDelete = await api(`/api/organizations/${createdOrg.id}`, {
        method: 'DELETE'
    }, adminSessionToken);
    assert.strictEqual(successDelete.status, 200, 'Should delete organization with no dependencies');

    console.log('PASS: Dynamic organizations verified 100%.\n');

    // -------------------------------------------------------------
    // SECTION C: STANDALONE / AD-HOC TASKS
    // -------------------------------------------------------------
    console.log('--- SECTION C: STANDALONE / AD-HOC TASKS ---');

    // C.1: Create ad-hoc standalone task
    console.log('Testing ad-hoc task creation with transparent system project auto-linking...');
    const adhocTaskRes = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
            task_mode: 'adhoc',
            title: 'مهمة تشغيلية عاجلة بدون مشروع مسبق',
            required_outputs: 'تسليم التقرير السريع',
            org: 'wamy',
            scheduled_start_at: new Date().toISOString(),
            scheduled_due_at: new Date(Date.now() + 86400000).toISOString(),
            assignee_ids: [regularUser.id]
        })
    }, adminSessionToken);

    assert.strictEqual(adhocTaskRes.status, 201, 'Should create ad-hoc task');
    const adhocTask = adhocTaskRes.data;
    assert.strictEqual(adhocTask.task_mode, 'adhoc', 'task_mode should be adhoc');
    assert.ok(adhocTask.project_id, 'Server should have transparently linked task to a system project');

    // Verify the linked system project properties
    const sysProjRes = await pool.query('SELECT * FROM projects WHERE id = $1', [adhocTask.project_id]);
    assert.strictEqual(sysProjRes.rows.length, 1, 'System project should exist in DB');
    const sysProj = sysProjRes.rows[0];
    assert.strictEqual(sysProj.is_system, true, 'is_system should be true');
    assert.ok(sysProj.system_key.startsWith('adhoc:'), 'system_key should match adhoc prefix');

    // C.2: Verify ad-hoc task list behavior
    console.log('Testing tasks list query...');
    const tasksList = await api('/api/tasks', {}, adminSessionToken);
    assert.strictEqual(tasksList.status, 200);
    const foundAdhoc = tasksList.data.find(t => t.id === adhocTask.id);
    assert.ok(foundAdhoc, 'Ad-hoc task should appear in task list');
    assert.strictEqual(foundAdhoc.task_mode, 'adhoc');

    // C.3: Linking an ad-hoc task to a structured project
    console.log('Testing linking adhoc task to a structured project...');
    const realProj = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
            code: `PRJ-REAL-${Date.now().toString().slice(-4)}`,
            name: 'مشروع ربط المهام المعتمد',
            org: 'wamy'
        })
    }, adminSessionToken);
    assert.strictEqual(realProj.status, 201);

    // Update ad-hoc task to link to real project
    const updateTaskRes = await api(`/api/tasks/${adhocTask.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
            project_id: realProj.data.id,
            title: 'مهمة تم ربطها بالمشروع المعتمد'
        })
    }, adminSessionToken);
    assert.strictEqual(updateTaskRes.status, 200);
    const updatedTask = Array.isArray(updateTaskRes.data) ? updateTaskRes.data[0] : updateTaskRes.data;
    assert.strictEqual(updatedTask.project_id, realProj.data.id);
    assert.strictEqual(updatedTask.task_mode, 'structured', 'Task mode should convert to structured when linked to a regular project');

    // Clean up
    await api(`/api/tasks/${adhocTask.id}`, { method: 'DELETE' }, adminSessionToken);
    await api(`/api/projects/${realProj.data.id}`, { method: 'DELETE' }, adminSessionToken);

    console.log('PASS: Standalone / Ad-hoc tasks verified 100%.\n');

    // -------------------------------------------------------------
    // SECTION D: SYSTEM PROJECT SAFETY
    // -------------------------------------------------------------
    console.log('--- SECTION D: SYSTEM PROJECT SAFETY ---');

    console.log('Testing that system projects cannot be deleted or mutated directly...');
    const sysProjId = sysProj.id;
    const sysProjDelete = await api(`/api/projects/${sysProjId}`, {
        method: 'DELETE'
    }, adminSessionToken);
    assert.strictEqual(sysProjDelete.status, 400, 'Direct deletion of system projects should be prohibited');
    const sysProjDeleteMsg = sysProjDelete.data.message || sysProjDelete.data.error || '';
    assert.ok(sysProjDeleteMsg.includes('النظام'), 'Error should state system project cannot be deleted');

    const sysProjUpdate = await api(`/api/projects/${sysProjId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Hacked System Project' })
    }, adminSessionToken);
    assert.strictEqual(sysProjUpdate.status, 400, 'Direct modification of system projects should be prohibited');

    console.log('PASS: System project safety verified 100%.\n');

    // Cleanup test users
    console.log('Cleaning up test users...');
    await pool.query('DELETE FROM sessions WHERE user_id IN ($1, $2)', [adminUser.id, regularUser.id]);
    await pool.query('UPDATE profiles SET deleted_at = now(), status = $1 WHERE id IN ($2, $3)', ['disabled', adminUser.id, regularUser.id]);

    await pool.end();

    console.log('================================================================');
    console.log('ALL ENHANCED FEATURES VERIFIED SUCCESSFULLY (PASS)!');
    console.log('================================================================');
}

runTests().catch(err => {
    console.error('TEST FAILED:', err);
    process.exit(1);
});
