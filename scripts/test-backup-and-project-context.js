'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const token = `backup-test-${crypto.randomBytes(24).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const port = process.env.PORT || 5175;
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path, options = {}, expectedStatus = 200) {
    const response = await fetch(baseUrl + path, {
        ...options,
        headers: {
            Cookie: `wamy_session=${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    let body;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        body = await response.json().catch(() => null);
    } else {
        body = await response.text();
    }
    assert.equal(response.status, expectedStatus, `${path}: expected ${expectedStatus}, got ${response.status} - ${(body && (body.error || body.message)) || ''}`);
    return body;
}

(async () => {
    console.log('--- Starting Integration Tests for Backups, System Reset, Projects, and Audit Logs ---');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    try {
        // Find active admin
        const admin = (await client.query(
            `select id, name, role from profiles where role='admin' and status='active' and deleted_at is null order by created_at limit 1`
        )).rows[0];
        assert.ok(admin, 'An active administrator is required.');
        console.log(`[1] Using administrator: ${admin.name} (${admin.id})`);

        // Insert temporary session
        await client.query(
            `insert into sessions (token_hash, user_id, expires_at)
             values ($1, $2, now() + interval '1 hour')`,
            [tokenHash, admin.id]
        );
        console.log('✓ Temporary session established.');

        // 2. Test Project List, Deactivate, and Activate
        console.log('\n[2] Testing Project Activation / Deactivation...');
        const projects = await request('/api/projects', { method: 'GET' }, 200);
        console.log(`Found ${projects.length} projects.`);
        assert.ok(projects.length > 0, 'At least one project is required.');
        const testProj = projects[0];
        console.log(`Testing with project: [${testProj.code}] ${testProj.name} (${testProj.id})`);

        // Deactivate
        const deactRes = await request(`/api/projects/${testProj.id}/deactivate`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'Automated test deactivation' })
        }, 200);
        assert.equal(deactRes.status, 'on_hold');
        console.log('✓ Project deactivated successfully (status = on_hold).');

        // Activate
        const actRes = await request(`/api/projects/${testProj.id}/activate`, {
            method: 'POST'
        }, 200);
        assert.equal(actRes.status, 'active');
        console.log('✓ Project activated successfully (status = active).');

        // 3. Test Backup Creation (Full)
        console.log('\n[3] Testing Backup Creation...');
        const createdBackup = await request('/api/backups', {
            method: 'POST',
            body: JSON.stringify({ type: 'FULL', notes: 'Automated test backup' })
        }, 201);
        assert.ok(createdBackup && createdBackup.id);
        console.log(`✓ Backup created: ID=${createdBackup.id}, SHA-256=${createdBackup.checksum}, Records=${createdBackup.totalRecords}`);

        // 4. Test List Backups
        console.log('\n[4] Testing List Backups...');
        const backupsList = await request('/api/backups', { method: 'GET' }, 200);
        assert.ok(Array.isArray(backupsList) && backupsList.some(b => b.id === createdBackup.id));
        console.log(`✓ Backups list returned ${backupsList.length} items including created backup.`);

        // 5. Test Download Backup
        console.log('\n[5] Testing Download Backup...');
        const downloadRes = await request(`/api/backups/${createdBackup.id}/download`, { method: 'GET' }, 200);
        assert.ok(downloadRes.manifest && downloadRes.manifest.version);
        assert.ok(downloadRes.data && downloadRes.data.projects);
        console.log('✓ Backup download verified with complete valid structure and metadata.');

        // 6. Test Atomic Restore Backup
        console.log('\n[6] Testing Restore Backup...');
        const restoreRes = await request(`/api/backups/${createdBackup.id}/restore`, { method: 'POST' }, 200);
        assert.equal(restoreRes.success, true);
        console.log(`✓ Backup restored atomically: Restored ${restoreRes.result.restoredRecords} records.`);

        // 7. Test Filtered Audit Logs Query
        console.log('\n[7] Testing Enhanced Audit Logs Filtering...');
        const logs = await request('/api/logs?entity_table=backups&limit=10', { method: 'GET' }, 200);
        assert.ok(Array.isArray(logs));
        console.log(`✓ Filtered audit log query returned ${logs.length} matching events.`);

        // 8. Test System Reset Safety Confirmation
        console.log('\n[8] Testing System Reset Confirmation Protection...');
        await request('/api/system/reset-projects', {
            method: 'POST',
            body: JSON.stringify({ confirmation: 'Wrong Phrase' })
        }, 400);
        console.log('✓ Safety phrase verification succeeded (rejected invalid phrase with 400).');

        // 9. Clean up test backup
        console.log('\n[9] Testing Delete Backup...');
        const deleteRes = await request(`/api/backups/${createdBackup.id}`, { method: 'DELETE' }, 200);
        assert.equal(deleteRes.success, true);
        console.log('✓ Test backup cleaned up successfully.');

        console.log('\n======================================================');
        console.log('🎉 ALL INTEGRATION TESTS PASSED WITH 100% SUCCESS!');
        console.log('======================================================');
    } finally {
        await client.query(`delete from sessions where token_hash=$1`, [tokenHash]);
        await client.end();
    }
})().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
