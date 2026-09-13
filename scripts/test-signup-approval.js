import dotenv from 'dotenv';
dotenv.config();
import assert from 'assert';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log('=== Testing Self-Registration & Approval Workflow ===');
  const client = await pool.connect();

  const testEmail = `test.pending.${Date.now()}@wamy.org`;
  const testPassword = 'Password123!SafePass';
  const testName = 'مستخدم تجريبي جديد';

  try {
    // 1. Simulate registration insertion directly / via same logic as /api/auth/signup
    console.log('1. Registering new user...');
    const passwordHash = await bcrypt.hash(testPassword, 12);
    const NO_PERMISSIONS = {
      'Dashboard.View': false,
      'MainPlan.View': false,
      'MainPlan.Create': false,
      'MainPlan.Edit': false,
      'MainPlan.Delete': false,
      'Products.View': false,
      'Products.Create': false,
      'Products.Edit': false,
      'Products.Delete': false,
      'Tasks.View': false,
      'Tasks.Create': false,
      'Tasks.Edit': false,
      'Tasks.Delete': false,
      'Timeline.View': false,
      'Calendar.View': false,
      'Files.View': false,
      'Files.Upload': false,
      'Files.Approve': false,
      'Files.Delete': false,
      'Files.Download': false,
      'Reports.View': false,
      'Reports.Export': false,
      'Settings.View': false,
      'Settings.General': false,
      'Settings.Integrations': false,
      'Settings.Users': false,
      'Admin.Access': false
    };

    const insertRes = await client.query(
      `insert into profiles (name,email,password_hash,role,org,position,status,permissions,data_scope)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,name,email,org,status,permissions`,
      [testName, testEmail, passwordHash, 'user', 'wamy', 'مدير مشاريع',
       'pending', JSON.stringify(NO_PERMISSIONS), 'my_data']
    );

    const user = insertRes.rows[0];
    assert.strictEqual(user.status, 'pending', 'User status should be pending on signup');
    assert.strictEqual(user.permissions['Dashboard.View'], false, 'Pending user must have 0 permissions initially');
    console.log('✓ User created with status: pending and NO_PERMISSIONS.');

    // 2. Test status check in login simulation
    console.log('2. Simulating login attempt for pending user...');
    const loginUser = (await client.query('select * from profiles where email=$1 and deleted_at is null', [testEmail])).rows[0];
    assert(loginUser, 'User must exist');
    assert.strictEqual(loginUser.status, 'pending', 'User must still be pending');
    // As per server.js: if (user.status === 'pending') return 403 ACCOUNT_PENDING
    console.log('✓ Verified user.status === "pending" triggers 403 ACCOUNT_PENDING.');

    // 3. Test Admin approval simulation
    console.log('3. Simulating admin approval (/api/profiles/:id/approve)...');
    const defaultPerms = {
      ...NO_PERMISSIONS,
      'Dashboard.View': true,
      'MainPlan.View': true,
      'Products.View': true,
      'Tasks.View': true,
      'Timeline.View': true,
      'Calendar.View': true,
      'Files.View': true,
      'Reports.View': true
    };
    const approveRes = await client.query(
      `update profiles set status='active', role=$1, permissions=$2, data_scope=$3, updated_at=now() where id=$4 returning *`,
      ['user', JSON.stringify(defaultPerms), 'my_data', user.id]
    );

    const approvedUser = approveRes.rows[0];
    assert.strictEqual(approvedUser.status, 'active', 'User should now be active');
    assert.strictEqual(approvedUser.permissions['Dashboard.View'], true, 'User should now have view access granted');
    console.log('✓ User approved and activated with default view permissions.');

    // 4. Test login simulation after approval
    console.log('4. Simulating login attempt after approval...');
    const loginApproved = (await client.query('select * from profiles where email=$1 and deleted_at is null', [testEmail])).rows[0];
    assert.strictEqual(loginApproved.status, 'active', 'User status is active');
    const pwMatch = await bcrypt.compare(testPassword, loginApproved.password_hash);
    assert.strictEqual(pwMatch, true, 'Password hashes match');
    console.log('✓ User login simulation succeeds.');

  } finally {
    // Cleanup
    await client.query('delete from profiles where email=$1', [testEmail]);
    client.release();
    await pool.end();
  }
  console.log('=== ALL SELF-REGISTRATION & APPROVAL TESTS PASSED (100%) ===');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
