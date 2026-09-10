'use strict';

require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const email = String(process.env.USER_EMAIL || '').trim().toLowerCase();
const password = String(process.env.USER_PASSWORD || '');
const name = String(process.env.USER_NAME || '').trim();
const role = process.env.USER_ROLE || 'user';
const org = process.env.USER_ORG || 'wamy';
const status = process.env.USER_STATUS || 'active';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) throw new Error('USER_EMAIL is invalid.');
if (!name || name.length > 200) throw new Error('USER_NAME is required and must be at most 200 characters.');
if (password.length < 12 || password.length > 200) throw new Error('USER_PASSWORD must be between 12 and 200 characters.');
if (!['admin','supervisor','project_manager','department_manager','team_lead','user','reviewer','approver','read_only'].includes(role)) throw new Error('USER_ROLE is invalid.');
if (!['wamy', 'imaan'].includes(org)) throw new Error('USER_ORG is invalid.');
if (!['pending', 'active', 'disabled'].includes(status)) throw new Error('USER_STATUS is invalid.');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await client.query(
      `insert into profiles(name,email,password_hash,role,org,status,permissions,data_scope)
       values($1,$2,$3,$4,$5,$6,default_permissions(),$7)
       on conflict (lower(email)) do update set
         name=excluded.name,
         password_hash=excluded.password_hash,
         role=excluded.role,
         org=excluded.org,
         status='active',
         deleted_at=null,
         updated_at=now()
       returning id,email,role,org,status,data_scope`,
      [name, email, passwordHash, role, org, status, role === 'admin' ? 'all_data' : 'my_data']
    );
    await client.query('delete from login_attempts where lower(email)=$1', [email]);
    await client.query(
      `insert into activity_log(actor_name,org,action,type,entity_table,entity_id,details)
       values('deployment operator',$1,'إنشاء/تحديث مستخدم عبر أداة التشغيل','CREATE','profiles',$2,$3)`,
      [org, rows[0].id, { email, role, status }]
    );
    await client.query('commit');
    console.log(JSON.stringify({ event: 'user_saved', user: rows[0] }));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { await client.end(); }
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
