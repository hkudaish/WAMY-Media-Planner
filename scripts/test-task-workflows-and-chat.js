const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function runTests() {
    console.log('=== Starting Task Workflows & Hierarchical Chat Verification ===\n');

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Get or create test users
        console.log('1. Setting up test actors across hierarchy...');
        let adminUser = (await client.query("SELECT * FROM profiles WHERE role = 'admin' AND status = 'active' LIMIT 1")).rows[0];
        let supervisorUser = (await client.query("SELECT * FROM profiles WHERE role = 'supervisor' AND status = 'active' LIMIT 1")).rows[0];
        let normalUser = (await client.query("SELECT * FROM profiles WHERE role = 'user' AND status = 'active' LIMIT 1")).rows[0];

        if (!adminUser) {
            adminUser = (await client.query(`
                INSERT INTO profiles (email, name, role, status, org)
                VALUES ('test_admin@wamy.org', 'مدير النظام التجريبي', 'admin', 'active', 'wamy')
                RETURNING *
            `)).rows[0];
        }

        if (!supervisorUser) {
            supervisorUser = (await client.query(`
                INSERT INTO profiles (email, name, role, status, org)
                VALUES ('test_supervisor@wamy.org', 'المشرف التجريبي', 'supervisor', 'active', 'wamy')
                RETURNING *
            `)).rows[0];
        }

        if (!normalUser) {
            normalUser = (await client.query(`
                INSERT INTO profiles (email, name, role, status, org)
                VALUES ('test_assignee@wamy.org', 'المنفذ التجريبي', 'user', 'active', 'wamy')
                RETURNING *
            `)).rows[0];
        }

        console.log(`   Admin: ${adminUser.name} (${adminUser.id})`);
        console.log(`   Supervisor: ${supervisorUser.name} (${supervisorUser.id})`);
        console.log(`   Assignee: ${normalUser.name} (${normalUser.id})`);

        // Get an active project
        let project = (await client.query("SELECT * FROM projects WHERE status = 'active' LIMIT 1")).rows[0];
        if (!project) {
            project = (await client.query(`
                INSERT INTO projects (code, name, org, status)
                VALUES ('PRJ-TEST', 'مشروع اختبار دورة العمل', 'wamy', 'active')
                RETURNING *
            `)).rows[0];
        }

        // 2. Test Task Creation with 'not_started' status
        console.log('\n2. Testing Task Creation with unified status (not_started)...');
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 7);

        const taskRes = await client.query(`
            INSERT INTO tasks (
                title, description, project_id, org, status, priority, progress,
                assignee_id, scheduled_start_at, scheduled_due_at,
                original_due_at, planned_start, due_date, created_by
            ) VALUES (
                'مهمة إنتاج وتصميم المطبوعات', 'تصميم وإنتاج البروشور التعريفي',
                $1, 'wamy', 'not_started', 'high', 0,
                $2, NOW(), $3,
                $3, CURRENT_DATE, CURRENT_DATE + 7, $4
            ) RETURNING *
        `, [project.id, normalUser.id, dueDate.toISOString(), adminUser.id]);

        let task = taskRes.rows[0];
        console.log(`   Task created: ID=${task.id}, Status=${task.status}`);
        if (task.status !== 'not_started') throw new Error(`Expected status not_started, got ${task.status}`);

        // 3. Test Starting Task -> in_progress
        console.log('\n3. Testing Start Task Execution -> in_progress...');
        const startRes = await client.query(`
            UPDATE tasks
            SET status = 'in_progress', actual_start_at = NOW(), started_by_id = $1, updated_at = NOW()
            WHERE id = $2 RETURNING *
        `, [normalUser.id, task.id]);
        task = startRes.rows[0];
        console.log(`   Task started: Status=${task.status}, ActualStart=${task.actual_start_at}`);
        if (task.status !== 'in_progress' || !task.actual_start_at) throw new Error('Failed to transition task to in_progress');

        // 4. Test Holding Task -> on_hold
        console.log('\n4. Testing Task Hold -> on_hold...');
        const resumeExpected = new Date();
        resumeExpected.setDate(resumeExpected.getDate() + 2);
        const holdRes = await client.query(`
            UPDATE tasks
            SET status = 'on_hold', hold_reason = 'بانتظار موافقة المحتوى النهائي',
                hold_at = NOW(), hold_by_id = $1, expected_resume_at = $2, updated_at = NOW()
            WHERE id = $3 RETURNING *
        `, [normalUser.id, resumeExpected.toISOString(), task.id]);
        task = holdRes.rows[0];
        console.log(`   Task placed on hold: Status=${task.status}, Reason=${task.hold_reason}`);
        if (task.status !== 'on_hold') throw new Error('Failed to transition task to on_hold');

        // 5. Test Resuming Task -> in_progress
        console.log('\n5. Testing Resume Task -> in_progress...');
        const resumeRes = await client.query(`
            UPDATE tasks
            SET status = 'in_progress', hold_reason = NULL, hold_at = NULL, hold_by_id = NULL,
                expected_resume_at = NULL, updated_at = NOW()
            WHERE id = $1 RETURNING *
        `, [task.id]);
        task = resumeRes.rows[0];
        console.log(`   Task resumed: Status=${task.status}`);
        if (task.status !== 'in_progress') throw new Error('Failed to resume task to in_progress');

        // 6. Test Requesting Extension
        console.log('\n6. Testing Task Extension Request...');
        const newRequestedDue = new Date(dueDate);
        newRequestedDue.setDate(newRequestedDue.getDate() + 5);

        const extReqRes = await client.query(`
            INSERT INTO task_extension_requests (
                task_id, requested_by_id, original_due_at, requested_due_at, reason, status
            ) VALUES (
                $1, $2, $3, $4, 'تعديل التصاميم وفق متطلبات الإدارة', 'pending_review'
            ) RETURNING *
        `, [task.id, normalUser.id, task.scheduled_due_at, newRequestedDue.toISOString()]);
        const extReq = extReqRes.rows[0];
        console.log(`   Extension request created: ID=${extReq.id}, Status=${extReq.status}`);

        // Review Extension Request (Approve)
        console.log('   Reviewing Extension Request (Superior Approve)...');
        await client.query(`
            UPDATE task_extension_requests
            SET status = 'approved', reviewed_by_id = $1, reviewed_at = NOW(), review_note = 'موافق على التمديد'
            WHERE id = $2
        `, [supervisorUser.id, extReq.id]);

        await client.query(`
            INSERT INTO task_schedule_history (
                task_id, previous_start_at, new_start_at, previous_due_at, new_due_at, changed_by, change_reason
            ) VALUES (
                $1, $2, $2, $3, $4, $5, $6
            )
        `, [task.id, task.scheduled_start_at, task.scheduled_due_at, newRequestedDue.toISOString(), supervisorUser.id, 'موافقة على طلب التمديد']);

        const extUpdateTaskRes = await client.query(`
            UPDATE tasks
            SET scheduled_due_at = $1, due_date = $2, extension_count = COALESCE(extension_count, 0) + 1, updated_at = NOW()
            WHERE id = $3 RETURNING *
        `, [newRequestedDue.toISOString(), newRequestedDue.toISOString().slice(0, 10), task.id]);
        task = extUpdateTaskRes.rows[0];
        console.log(`   Task updated with extension: DueDate=${task.scheduled_due_at}, Extensions=${task.extension_count}`);
        if (task.extension_count !== 1) throw new Error('Extension count not incremented');

        // 7. Test Submitting Completion -> awaiting_approval
        console.log('\n7. Testing Submit Completion -> awaiting_approval...');
        const compReqRes = await client.query(`
            INSERT INTO task_completion_requests (
                task_id, submitted_by_id, deliverable_description, completion_note, attachments, status
            ) VALUES (
                $1, $2, 'تم إنجاز التصاميم والمطبوعات بجودة عالية وتسليم النسخ للجهة',
                'يرجى مراجعة النسخ واعتماد الإنجاز', '["https://drive.google.com/test-files/brochure.pdf"]'::jsonb, 'pending_review'
            ) RETURNING *
        `, [task.id, normalUser.id]);
        const compReq = compReqRes.rows[0];

        const compSubmitRes = await client.query(`
            UPDATE tasks
            SET status = 'awaiting_approval', completion_submitted_at = NOW(), completion_submitted_by_id = $1, updated_at = NOW()
            WHERE id = $2 RETURNING *
        `, [normalUser.id, task.id]);
        task = compSubmitRes.rows[0];
        console.log(`   Task submitted for completion: Status=${task.status}, RequestID=${compReq.id}`);
        if (task.status !== 'awaiting_approval') throw new Error('Expected status awaiting_approval');

        // 8. Test Review Completion: Request Revision -> needs_revision
        console.log('\n8. Testing Review Completion: Request Revision -> needs_revision...');
        await client.query(`
            UPDATE task_completion_requests
            SET status = 'revision_requested', reviewed_by_id = $1, reviewed_at = NOW(), review_note = 'يرجى تعديل ألوان الشعار لتطابق الهوية الرسمية'
            WHERE id = $2
        `, [supervisorUser.id, compReq.id]);

        const revTaskRes = await client.query(`
            UPDATE tasks
            SET status = 'needs_revision', updated_at = NOW()
            WHERE id = $1 RETURNING *
        `, [task.id]);
        task = revTaskRes.rows[0];
        console.log(`   Task returned for revision: Status=${task.status}`);
        if (task.status !== 'needs_revision') throw new Error('Expected status needs_revision');

        // Re-submit & Final Approve -> completed_approved
        console.log('   Re-submitting & Final Approval -> completed_approved (100% progress)...');
        await client.query(`
            UPDATE tasks
            SET status = 'completed_approved', progress = 100, completion_approved_at = NOW(),
                completion_approved_by_id = $1, updated_at = NOW()
            WHERE id = $2
        `, [adminUser.id, task.id]);

        task = (await client.query('SELECT * FROM tasks WHERE id = $1', [task.id])).rows[0];
        console.log(`   Task Approved: Status=${task.status}, Progress=${task.progress}%`);
        if (task.status !== 'completed_approved' || task.progress !== 100) throw new Error('Expected completed_approved and progress=100');

        // 9. Test Reassignment & History Tracking
        console.log('\n9. Testing Task Reassignment & History...');
        await client.query(`
            INSERT INTO task_assignment_history (
                task_id, previous_assignee_ids, new_assignee_ids, reassigned_by_id, reason
            ) VALUES (
                $1, $2, $3, $4, 'إعادة الإسناد لمتابعة التوزيع الدوري'
            )
        `, [task.id, JSON.stringify([normalUser.id]), JSON.stringify([supervisorUser.id]), adminUser.id]);

        const asgnHistory = (await client.query('SELECT * FROM task_assignment_history WHERE task_id = $1', [task.id])).rows;
        console.log(`   Assignment history entries recorded: ${asgnHistory.length}`);
        if (asgnHistory.length === 0) throw new Error('Assignment history not logged');

        // 10. Test Hierarchical Chat System
        console.log('\n10. Testing Hierarchical & Task Chat System...');
        // Create Task Conversation
        const convRes = await client.query(`
            INSERT INTO chat_conversations (
                type, task_id, title, created_by_id
            ) VALUES (
                'TASK', $1, $2, $3
            ) RETURNING *
        `, [task.id, `مناقشة: ${task.title}`, adminUser.id]);
        const conv = convRes.rows[0];
        console.log(`   Task-linked conversation created: ID=${conv.id}`);

        // Add Participants
        await client.query(`
            INSERT INTO chat_participants (conversation_id, user_id, role_in_conversation)
            VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')
            ON CONFLICT DO NOTHING
        `, [conv.id, adminUser.id, supervisorUser.id, normalUser.id]);

        // Send Message with Mentions
        const msgText = `السلام عليكم @user:${supervisorUser.id} يرجى متابعة المخرج الخاص بـ @task:${task.id} للتأكد من الجودة.`;
        const msgRes = await client.query(`
            INSERT INTO chat_messages (
                conversation_id, sender_id, message
            ) VALUES (
                $1, $2, $3
            ) RETURNING *
        `, [conv.id, adminUser.id, msgText]);
        const msg = msgRes.rows[0];
        console.log(`   Message sent: ID=${msg.id}, Message=${msg.message}`);

        // Record Reference Entity
        await client.query(`
            INSERT INTO chat_message_references (message_id, reference_type, reference_id, reference_title)
            VALUES ($1, 'USER', $2, $3), ($1, 'TASK', $4, $5)
        `, [msg.id, supervisorUser.id, supervisorUser.name, task.id, task.title]);

        const refs = (await client.query('SELECT * FROM chat_message_references WHERE message_id = $1', [msg.id])).rows;
        console.log(`   Extracted entity references count: ${refs.length}`);
        if (refs.length !== 2) throw new Error('Expected 2 message references');

        // Test Mark as Read
        await client.query(`
            UPDATE chat_participants
            SET last_read_at = NOW()
            WHERE conversation_id = $1 AND user_id = $2
        `, [conv.id, supervisorUser.id]);
        console.log('   Read receipt updated successfully');

        // Rollback test transaction to keep DB clean
        await client.query('ROLLBACK');
        console.log('\n✓ All Task Workflows and Chat system verifications PASSED successfully!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('\n❌ Test failed with error:', err);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

runTests();
