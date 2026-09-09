'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = Number(process.env.PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_NAME = IS_PRODUCTION ? '__Host-wamy_session' : 'wamy_session';

(async () => {
  let createdProjId = null;
  let createdProdId = null;
  let createdPlanItemId = null;
  let createdTaskId = null;
  let tokenHash = null;

  try {
    console.log('=== VALIDATING FULL ADMIN PERMISSIONS & CRUD OPERATIONS ===');
    
    // 1. Fetch admin user
    const admin = (await pool.query("select * from profiles where role='admin' and status='active' limit 1")).rows[0];
    assert(admin, 'No active admin user found in database');
    console.log(`PASS: Found active Admin user: ${admin.name} (${admin.email})`);

    // 2. Issue valid session
    const rawToken = crypto.randomBytes(32).toString('base64url');
    tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await pool.query(
      "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
      [tokenHash, admin.id]
    );

    const headers = {
      'Content-Type': 'application/json',
      'Cookie': `${COOKIE_NAME}=${rawToken}`,
      'Origin': `http://127.0.0.1:${PORT}`
    };

    // 3. Test PROJECT CRUD
    console.log('\n--- Testing Projects CRUD ---');
    // CREATE Project
    let res = await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: `PRJ-ADM-${Date.now().toString().slice(-4)}`,
        hierarchical_code: 'PRJ-888',
        name: 'مشروع اختبار صلاحيات المدير',
        description: 'مشروع للتأكد من صلاحيات مدير النظام',
        org: 'wamy',
        status: 'planning'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create project: ${res.status} ${errText}`);
    }
    const createdProject = await res.json();
    createdProjId = createdProject.id;
    console.log(`PASS: Admin created project: [${createdProject.hierarchical_code}] ${createdProject.name}`);

    // READ Projects
    res = await fetch(`${BASE_URL}/api/projects`, { headers });
    assert.equal(res.status, 200);
    const allProjects = await res.json();
    assert(allProjects.some(p => p.id === createdProjId));
    console.log(`PASS: Admin fetched all ${allProjects.length} projects successfully.`);

    // UPDATE Project
    res = await fetch(`${BASE_URL}/api/projects/${createdProjId}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': `"${createdProject.updated_at}"` },
      body: JSON.stringify({ name: 'مشروع اختبار صلاحيات المدير - معدل', status: 'active' })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to update project: ${res.status} ${errText}`);
    }
    const updatedProject = (await res.json())[0];
    assert.equal(updatedProject.name, 'مشروع اختبار صلاحيات المدير - معدل');
    console.log('PASS: Admin updated project successfully.');

    // 4. Test PRODUCT CRUD
    console.log('\n--- Testing Products CRUD ---');
    // CREATE Product
    res = await fetch(`${BASE_URL}/api/products`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: createdProjId,
        code: `PRD-ADM-${Date.now().toString().slice(-4)}`,
        hierarchical_code: 'PRJ-888-PLN-01-PRD-001',
        name: 'منتج اختبار صلاحيات المدير',
        plan_track: 'مسار الإنتاج الرقمي',
        content: 'وصف محتوى المنتج التجريبي',
        org: 'wamy',
        status: 'in_progress',
        manual_progress: 25
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create product: ${res.status} ${errText}`);
    }
    const createdProduct = await res.json();
    createdProdId = createdProduct.id;
    console.log(`PASS: Admin created product: [${createdProduct.hierarchical_code}] ${createdProduct.name}`);

    // READ Products
    res = await fetch(`${BASE_URL}/api/products`, { headers });
    assert.equal(res.status, 200);
    const allProducts = await res.json();
    assert(allProducts.some(p => p.id === createdProdId));
    console.log(`PASS: Admin fetched all ${allProducts.length} products.`);

    // UPDATE Product (testing with clean & full payload)
    res = await fetch(`${BASE_URL}/api/products/${createdProdId}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': `"${createdProduct.updated_at}"` },
      body: JSON.stringify({
        name: 'منتج اختبار صلاحيات المدير - معدل بالكامل',
        hierarchical_code: 'PRJ-888-PLN-01-PRD-001',
        manual_progress: 75,
        status: 'in_progress',
        project_id: createdProjId
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to update product: ${res.status} ${errText}`);
    }
    const updatedProd = (await res.json())[0];
    assert.equal(updatedProd.name, 'منتج اختبار صلاحيات المدير - معدل بالكامل');
    assert.equal(updatedProd.manual_progress, 75);
    console.log('PASS: Admin updated product successfully.');

    // 5. Test MASTER PLAN ITEMS CRUD
    console.log('\n--- Testing Master Plan Items & Milestones CRUD ---');
    // CREATE Master Plan Item
    res = await fetch(`${BASE_URL}/api/master-plan-items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: createdProjId,
        title: 'بند خطة أساس تجريبي',
        track: 'مسار الإنتاج الرقمي',
        phase: 'مرحلة الإعداد',
        planned_start: '2026-09-01',
        planned_end: '2026-09-30',
        priority: 'high'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create master plan item: ${res.status} ${errText}`);
    }
    const createdPlanItem = await res.json();
    createdPlanItemId = createdPlanItem.id;
    console.log(`PASS: Admin created plan item: [${createdPlanItem.hierarchical_code || createdPlanItem.external_id}] ${createdPlanItem.title}`);

    // UPDATE Master Plan Item
    res = await fetch(`${BASE_URL}/api/master-plan-items/${createdPlanItemId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        title: 'بند خطة أساس تجريبي - معدل',
        phase: 'مرحلة التنفيذ'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to update master plan item: ${res.status} ${errText}`);
    }
    console.log('PASS: Admin updated plan item successfully.');

    // 6. Test TASKS CRUD
    console.log('\n--- Testing Tasks CRUD & Assignment ---');
    // CREATE Task
    res = await fetch(`${BASE_URL}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: createdProjId,
        product_id: createdProdId,
        plan_item_id: createdPlanItemId,
        title: 'مهمة تجريبية لصلاحيات المدير',
        required_outputs: 'مخرج نهائي معتمد',
        scheduled_start_at: '2026-09-01T09:00:00Z',
        scheduled_due_at: '2026-09-15T17:00:00Z',
        planned_start: '2026-09-01',
        due_date: '2026-09-15',
        assignee_ids: [admin.id],
        assignee_id: admin.id,
        priority: 'high',
        org: 'wamy',
        status: 'in_progress',
        progress: 50
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create task: ${res.status} ${errText}`);
    }
    const createdTask = await res.json();
    createdTaskId = createdTask.id;
    console.log(`PASS: Admin created and assigned task: ${createdTask.title}`);

    // UPDATE Task
    res = await fetch(`${BASE_URL}/api/tasks/${createdTaskId}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': `"${createdTask.updated_at}"` },
      body: JSON.stringify({
        title: 'مهمة تجريبية لصلاحيات المدير - مكتملة',
        status: 'approved',
        progress: 100,
        notes: 'تم الاعتماد بنجاح من مدير النظام'
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to update task: ${res.status} ${errText}`);
    }
    console.log('PASS: Admin updated and approved task successfully.');

    // 7. Test DELETE operations
    console.log('\n--- Testing Delete / Archive Operations ---');
    // DELETE Task
    res = await fetch(`${BASE_URL}/api/tasks/${createdTaskId}`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    console.log('PASS: Admin deleted task successfully.');

    // DELETE Product
    res = await fetch(`${BASE_URL}/api/products/${createdProdId}`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    console.log('PASS: Admin deleted product successfully.');

    // DELETE Master Plan Item
    res = await fetch(`${BASE_URL}/api/master-plan-items/${createdPlanItemId}`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    console.log('PASS: Admin deleted master plan item successfully.');

    // DELETE Project
    res = await fetch(`${BASE_URL}/api/projects/${createdProjId}`, { method: 'DELETE', headers });
    assert.equal(res.status, 200);
    console.log('PASS: Admin deleted project successfully.');

    console.log('\n======================================================');
    console.log('ALL ADMIN PERMISSIONS & CRUD OPERATIONS VERIFIED 100%!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('VERIFICATION ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    if (tokenHash) {
      await pool.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    }
    await pool.end();
  }
})();
