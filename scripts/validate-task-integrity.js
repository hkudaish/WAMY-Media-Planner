'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const token = `task-integrity-${crypto.randomBytes(24).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5175}`;

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { Cookie: `wamy_session=${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${path}: expected ${expectedStatus}, got ${response.status} ${(body && body.message) || ''}`);
  return body;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log('--- 1. Validating Database Task Integrity ---');

    // Rule 1: No orphan tasks without project_id
    const orphanTasks = (await client.query(
      `select id, title from tasks where deleted_at is null and project_id is null`
    )).rows;
    assert.equal(orphanTasks.length, 0, `Found ${orphanTasks.length} orphan tasks without project_id.`);
    console.log('PASS: 0 orphan tasks without project_id.');

    // Rule 2: All tasks linked to valid, non-deleted projects
    const invalidProjects = (await client.query(
      `select t.id, t.title, t.project_id from tasks t
         left join projects p on p.id=t.project_id
        where t.deleted_at is null and (p.id is null or p.deleted_at is not null)`
    )).rows;
    assert.equal(invalidProjects.length, 0, `Found ${invalidProjects.length} tasks linked to invalid/deleted projects.`);
    console.log('PASS: All tasks linked to existing, active projects.');

    // Rule 3: No cross-project plan item mismatches
    const crossPlanMismatches = (await client.query(
      `select t.id, t.title, t.project_id as task_project, i.project_id as plan_project
         from tasks t
         join master_plan_items i on i.id=t.plan_item_id
        where t.deleted_at is null and t.project_id <> i.project_id`
    )).rows;
    assert.equal(crossPlanMismatches.length, 0, `Found ${crossPlanMismatches.length} cross-project plan item mismatches.`);
    console.log('PASS: 0 cross-project plan item mismatches.');

    // Rule 4: Total active tasks verification
    const totalActiveTasks = Number((await client.query('select count(*)::int as c from tasks where deleted_at is null')).rows[0].c);
    console.log(`PASS: Verified ${totalActiveTasks} active tasks with full relational integrity.`);

    console.log('--- 2. Validating API Enforcement & Orphan Prevention ---');

    const admin = (await client.query(
      `select id, name from profiles where role='admin' and status='active' and deleted_at is null order by created_at limit 1`
    )).rows[0];
    assert.ok(admin, 'An active administrator is required.');
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash, admin.id]);

    const projects = (await client.query(
      `select p.id, p.code, p.name, p.org
         from projects p
         join master_plan_items i on i.project_id=p.id and i.deleted_at is null
        where p.deleted_at is null
        group by p.id, p.code, p.name, p.org
        having count(i.id) > 0
        order by p.code limit 2`
    )).rows;
    assert.ok(projects.length >= 2, 'At least 2 active projects with plan items are required for cross-project tests.');

    const projectA = projects[0];
    const projectB = projects[1];

    const planItemA = (await client.query(
      `select id, project_id, title, planned_start, planned_end from master_plan_items where project_id=$1 and deleted_at is null limit 1`,
      [projectA.id]
    )).rows[0];
    assert.ok(planItemA, `Plan item required for project ${projectA.code}`);

    // API Test 1: Task creation without project_id must fail (400)
    const noProjectPayload = {
      title: 'مهمة بدون مشروع لا يجوز إنشاؤها',
      required_outputs: 'مخرج اختباري',
      scheduled_start_at: '2026-10-01T09:00:00.000Z',
      scheduled_due_at: '2026-10-05T17:00:00.000Z',
      assignee_id: admin.id,
      assignee_ids: [admin.id],
      priority: 'normal',
      status: 'not_started'
    };
    const rejNoProj = await request('/api/tasks', { method: 'POST', body: JSON.stringify(noProjectPayload) }, 400);
    assert.equal(rejNoProj.code, 'INVALID_INPUT');
    console.log('PASS: API rejects creating task without project_id.');

    // API Test 2: Task creation with cross-project plan_item_id must fail (400 or 403)
    const crossProjectPayload = {
      ...noProjectPayload,
      project_id: projectB.id,
      plan_item_id: planItemA.id, // belongs to projectA, but project_id is projectB
      title: 'مهمة بارتباط مشروع غير متطابق'
    };
    await request('/api/tasks', { method: 'POST', body: JSON.stringify(crossProjectPayload) }, 403);
    console.log('PASS: API rejects creating task with cross-project plan_item_id.');

    // API Test 3: Creating valid task succeeds
    const validPayload = {
      ...noProjectPayload,
      project_id: projectA.id,
      plan_item_id: planItemA.id,
      title: 'مهمة متكاملة العلاقات مع خطة المشروع',
      org: projectA.org
    };
    const createdTask = await request('/api/tasks', { method: 'POST', body: JSON.stringify(validPayload) }, 201);
    assert.equal(createdTask.project_id, projectA.id);
    assert.equal(createdTask.plan_item_id, planItemA.id);
    console.log('PASS: API successfully creates task with valid cascading project and plan item relationships.');

    // API Test 4: Task edit preventing nulling project_id
    await request(`/api/tasks/${createdTask.id}`, {
      method: 'PATCH',
      headers: { 'If-Match': `"${createdTask.updated_at}"` },
      body: JSON.stringify({ project_id: null })
    }, 400);
    console.log('PASS: API rejects removing project_id during task update.');

    // API Test 5: Clean up created test task
    await request(`/api/tasks/${createdTask.id}`, { method: 'DELETE' }, 200);
    console.log('PASS: Test task soft-deleted cleanly.');

    console.log('--- 3. Database Trigger Direct SQL Integrity ---');
    // DB Trigger Test: Direct SQL insert with NULL project_id must throw error
    let dbRejectedNull = false;
    try {
      await client.query(
        `insert into tasks(title, org, priority, status, progress, required_outputs, scheduled_start_at, scheduled_due_at)
         values('Direct SQL orphan task', 'wamy', 'normal', 'not_started', 0, 'output', now(), now() + interval '1 day')`
      );
    } catch (err) {
      dbRejectedNull = true;
    }
    assert.ok(dbRejectedNull, 'Database must reject direct SQL insert of orphan task.');
    console.log('PASS: Database constraint/trigger blocks direct SQL insert of orphan tasks.');

    console.log('\n========================================');
    console.log('ALL TASK PROJECT RELATIONAL CHECKS PASSED!');
    console.log('========================================\n');
  } finally {
    await client.query('delete from sessions where token_hash=$1', [tokenHash]);
    await client.end();
  }
})().catch(error => {
  console.error('Validation failed:', error);
  process.exit(1);
});
