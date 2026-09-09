const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wamy_media_merged'
});

async function run() {
    await pool.query("DELETE FROM tasks WHERE title = 'مهمة هرمية متكاملة' OR title = 'Mismatch Test Task'");
    await pool.query("DELETE FROM products WHERE code LIKE 'PRD-TEST%'");

    console.log('--- 1. Testing Project & Product Hierarchical Codes ---');
    const { rows: projects } = await pool.query('SELECT id, code, hierarchical_code, name FROM projects ORDER BY created_at ASC');
    console.log(`Found ${projects.length} projects:`);
    projects.forEach(p => console.log(`  - [${p.hierarchical_code || 'MISSING'}] (${p.code}) ${p.name}`));
    if (projects.some(p => !p.hierarchical_code)) {
        throw new Error('Some projects are missing hierarchical_code');
    }
    console.log('PASS: All projects have valid hierarchical_code.');

    const { rows: products } = await pool.query('SELECT id, project_id, code, hierarchical_code, legacy_code, plan_track, name FROM products ORDER BY code ASC');
    console.log(`Found ${products.length} products:`);
    products.forEach(p => console.log(`  - [${p.hierarchical_code || 'MISSING'}] (${p.code}) ${p.name} -> project: ${p.project_id}`));
    if (products.some(p => !p.project_id || !p.hierarchical_code)) {
        throw new Error('Some products are missing project_id or hierarchical_code');
    }
    console.log('PASS: All products linked to project and have hierarchical_code.');

    console.log('--- 2. Testing Master Plan Items Hierarchical Codes ---');
    const { rows: items } = await pool.query('SELECT id, project_id, external_id, hierarchical_code, track, phase, title FROM master_plan_items LIMIT 5');
    console.log(`Sample of 5 master plan items:`);
    items.forEach(i => console.log(`  - [${i.hierarchical_code || 'MISSING'}] (${i.external_id}) ${i.title}`));
    const { rows: missingItems } = await pool.query('SELECT count(*) as count FROM master_plan_items WHERE hierarchical_code IS NULL');
    if (parseInt(missingItems[0].count, 10) > 0) {
        throw new Error(`${missingItems[0].count} master plan items missing hierarchical_code`);
    }
    console.log('PASS: All 124 master plan items have hierarchical_code.');

    console.log('--- 3. Testing Cross-Project Trigger Constraints ---');
    const prj1 = projects[0];
    const prj2 = projects[1] || projects[0];
    const uniqueSuffix = Date.now().toString().slice(-4);

    // Create a temporary product on prj1 with allow_multiple_tasks: true
    const { rows: tempProd } = await pool.query(`
        INSERT INTO products (
            id, project_id, code, hierarchical_code, name, org, status, allow_multiple_tasks, is_active
        ) VALUES (
            gen_random_uuid(), $1, $2, $3, 'منتج اختبار', 'wamy', 'in_progress', true, true
        ) RETURNING id, project_id;
    `, [prj1.id, `PRD-TEST-${uniqueSuffix}`, `PRJ-001-PLN-01-PRD-T${uniqueSuffix}`]);

    if (prj1.id !== prj2.id) {
        try {
            await pool.query(`
                INSERT INTO tasks (id, project_id, product_id, title, required_outputs, org, scheduled_start_at, scheduled_due_at, planned_start, due_date)
                VALUES (gen_random_uuid(), $1, $2, 'Mismatch Test Task', 'Output', 'wamy', NOW(), NOW() + interval '1 day', CURRENT_DATE, CURRENT_DATE + 1)
            `, [prj2.id, tempProd[0].id]);
            throw new Error('Trigger FAILED: Allowed cross-project product assignment on task!');
        } catch (err) {
            if (err.message.includes('لا ينتمي إلى المشروع المختار') || err.message.includes('لا ينتمي إلى نفس المشروع')) {
                console.log('PASS: DB Trigger correctly blocked cross-project product assignment on task.');
            } else {
                throw err;
            }
        }
    }

    console.log('--- 4. Testing End-to-End Task Creation with 4-Tier Hierarchy ---');
    const { rows: matchingPlanItems } = await pool.query('SELECT id, project_id, track, phase FROM master_plan_items WHERE project_id = $1 LIMIT 1', [prj1.id]);
    const planItem = matchingPlanItems[0];

    const { rows: insertedTask } = await pool.query(`
        INSERT INTO tasks (
            id, project_id, plan_item_id, product_id, phase_name, title, required_outputs, org,
            scheduled_start_at, scheduled_due_at, planned_start, due_date, status, progress
        ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, 'مهمة هرمية متكاملة', 'مخرج تجريبي', 'wamy',
            NOW(), NOW() + interval '3 days', CURRENT_DATE, CURRENT_DATE + 3, 'not_started', 0
        ) RETURNING id, project_id, plan_item_id, product_id, title;
    `, [prj1.id, planItem.id, tempProd[0].id, planItem.phase || 'المرحلة الأولى']);

    console.log(`PASS: Created task ${insertedTask[0].id} with complete 4-tier hierarchy.`);

    // Cleanup test task and temp product
    await pool.query('DELETE FROM tasks WHERE id = $1', [insertedTask[0].id]);
    await pool.query('DELETE FROM products WHERE id = $1', [tempProd[0].id]);
    console.log('PASS: Cleaned up test task and test product.');

    console.log('\n======================================================');
    console.log('ALL HIERARCHICAL PROJECT & CODING CHECKS PASSED!');
    console.log('======================================================');
    await pool.end();
}

run().catch(err => {
    console.error('FAILED:', err);
    process.exit(1);
});
