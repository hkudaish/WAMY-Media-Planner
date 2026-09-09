'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const babel = require('@babel/core');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'code_artifact.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const masterPlanMigration = fs.readFileSync(path.join(root, 'database', 'migrations', '002_master_plans.sql'), 'utf8');
const taskWorkflowMigration = fs.readFileSync(path.join(root, 'database', 'migrations', '003_task_workflow.sql'), 'utf8');
const invitationMigration = fs.readFileSync(path.join(root, 'database', 'migrations', '004_user_invitations.sql'), 'utf8');
const rbacMigration = fs.readFileSync(path.join(root, 'database', 'migrations', '005_granular_rbac.sql'), 'utf8');
const rbacDefaultsMigration = fs.readFileSync(path.join(root, 'database', 'migrations', '006_rbac_defaults.sql'), 'utf8');
const jsx = html.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)?.[1];

const checks = [
  ['remote database SDK removed', !/createClient\([^)]*(url|key)/i.test(html)],
  ['old browser connection setup removed', !/SetupScreen|anonKey/.test(html)],
  ['browser uses same-origin API', /fetch\('\/api' \+ path/.test(html)],
  ['system dates use English digits', /Intl\.DateTimeFormat\('en-US-u-nu-latn'/.test(html) && /gregory-nu-latn/.test(html)],
  ['login contract subtitle removed', !/عقد التواصل الاستراتيجي — الندوة WAMY &amp; إمعان/.test(html)],
  ['users are nested under settings', /function SettingsScreen[\s\S]*<UsersScreen/.test(html) && !/activeTab === 'users'/.test(html)],
  ['plan import controls are wired', /إضافة خطة جديدة/.test(html) && /تنزيل نموذج خطة/.test(html) && /PlanImportModal/.test(html)],
  ['master-plan workflow is wired', /MasterPlanScreen/.test(html) && /MasterPlanImportModal/.test(html) && /plan_item_id/.test(server)],
  ['server uses DATABASE_URL', /new Pool\(\{[\s\S]*connectionString: DATABASE_URL/.test(server)],
  ['password hashes are server-side', /bcrypt\.hash/.test(server) && /password_hash text not null/.test(schema)],
  ['schema has local sessions', /create table if not exists sessions/.test(schema)],
  ['master plans are relational and persistent', /create table if not exists projects/.test(masterPlanMigration) && /create table if not exists master_plan_items/.test(masterPlanMigration)],
  ['multi-assignee task workflow is persistent', /create table if not exists task_assignees/.test(taskWorkflowMigration) && /create table if not exists task_schedule_history/.test(taskWorkflowMigration)],
  ['task schedule history is append-only', /task_schedule_history_immutable/.test(taskWorkflowMigration)],
  ['one-time user invitations are persistent', /create table if not exists user_invitations/.test(invitationMigration) && /token_hash char\(64\)/.test(invitationMigration)],
  ['admin invitation and sharing workflow is wired', /profiles\/invite/.test(server) && /InviteUserModal/.test(html) && /wa\.me/.test(html) && /mailto:/.test(html)],
  ['granular RBAC is persistent', /data_scope/.test(rbacMigration) && /Tasks\.Approve/.test(rbacMigration) && /default_permissions/.test(rbacDefaultsMigration)],
  ['navigation is permission-driven', /permission: 'Dashboard\.View'/.test(html) && /NAV_ITEMS\.filter\(item => can\(profile, item\.permission\)\)/.test(html)],
  ['API enforces granular permissions', /can\(req\.user,'Tasks\.Edit'\)/.test(server) && /canAccessTask/.test(server) && /denied_audit_failed/.test(server)],
  ['state-changing requests validate origin', /INVALID_ORIGIN/.test(server)],
  ['login attempts are persisted', /create table if not exists login_attempts/.test(schema)],
  ['audit log is append-only', /activity_log_immutable/.test(schema)],
  ['destructive CRUD uses soft deletion', /set deleted_at=now\(\)/.test(server)],
  ['production frontend exists', fs.existsSync(path.join(root, 'dist', 'index.html'))]
];

for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
if (checks.some(([, pass]) => !pass)) process.exit(1);
try {
  babel.transformSync(jsx, { presets: ['@babel/preset-react'], filename: 'code_artifact.jsx' });
  console.log('PASS  browser JSX compiles');
} catch (error) {
  console.error(`FAIL  browser JSX: ${error.message}`);
  process.exit(1);
}

(async () => {
  if (!process.env.DATABASE_URL) return;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query(`
      select
        (select count(*)::int from products) as products,
        (select count(*)::int from tasks) as tasks,
        (select count(*)::int from profiles) as profiles,
        (select count(*)::int from projects where deleted_at is null) as projects,
        (select count(*)::int from master_plan_items where deleted_at is null) as plan_items,
        (select count(*)::int from task_assignees) as task_assignments,
        (select count(*)::int from task_schedule_history) as schedule_events
    `);
    const counts = result.rows[0];
    console.log(`PASS  PostgreSQL reachable (${counts.projects} projects, ${counts.plan_items} baseline items, ${counts.products} products, ${counts.tasks} tasks, ${counts.profiles} users, ${counts.task_assignments} assignments, ${counts.schedule_events} schedule events)`);
  } finally {
    await client.end();
  }
})().catch(error => {
  console.error(`FAIL  PostgreSQL connection: ${error.message}`);
  process.exit(1);
});
