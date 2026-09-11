'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const multer = require('multer');
const { readWorkbook: readRawWorkbook } = require('./scripts/ooxml-reader');
const { Pool, types } = require('pg');
const projectHierarchyIO = require('./server/project-hierarchy-io');
const backupManager = require('./server/backup-manager');

// PostgreSQL DATE has no time zone. Keep it as YYYY-MM-DD instead of letting
// JavaScript shift local midnight to the previous UTC day during JSON output.
types.setTypeParser(1082, value => value);

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const IS_HTTPS = PUBLIC_ORIGIN.startsWith('https://');
const COOKIE_NAME = IS_HTTPS ? '__Host-wamy_session' : 'wamy_session';
const SESSION_DAYS = 7;
const INVITATION_HOURS = Math.min(Math.max(Number(process.env.INVITATION_HOURS || 168), 1), 720);
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_MAX_IP_FAILURES = 50;
const ALLOWED_ORIGINS = new Set([
  PUBLIC_ORIGIN,
  ...String(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  ...(IS_PRODUCTION ? [] : [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
]);
const PERMISSION_KEYS = [
  'Dashboard.View','MainPlan.View','Products.View','Tasks.View','Timeline.View','Calendar.View','Files.View','Reports.View','Settings.View','Audit.View','AuditLog.View',
  'Projects.View','Projects.Create','Projects.Edit','Projects.Delete','Projects.Archive','Projects.Activate','Projects.Deactivate',
  'Plans.View','Plans.Create','Plans.Import','Plans.Edit','Plans.Archive','Plans.Export',
  'Products.Create','Products.Edit','Products.Delete','Milestones.View','Milestones.Create','Milestones.Edit','Milestones.Delete',
  'Tasks.Create','Tasks.Edit','Tasks.Assign','Tasks.Delete','Tasks.Start','Tasks.Complete','Tasks.Approve','Tasks.Close',
  'Reports.Export','Reports.ExecutiveView','Reports.FinancialView','Reports.TeamPerformanceView',
  'Files.Upload','Files.Download','Files.Edit','Files.Delete','Files.Approve','Files.MoveToApproved',
  'Calendar.Create','Calendar.Edit','Calendar.Delete','Calendar.ManageSchedule',
  'Settings.General','Settings.Users','Settings.Roles','Settings.Permissions','Settings.Departments','Settings.Organizations','Settings.Backup','Settings.Security','Settings.Integrations',
  'Organizations.View','Organizations.Create','Organizations.Edit','Organizations.Activate','Organizations.Deactivate','Organizations.Delete',
  'Backup.View','Backup.Create','Backup.Restore','Backup.Download','Backup.Delete','System.Reset'
];
const ALL_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map(key => [key,true]));
const NO_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map(key => [key,false]));

if (!DATABASE_URL) {
  console.error('DATABASE_URL is missing. Copy .env.example to .env and update it.');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('PORT must be a valid TCP port.');
  process.exit(1);
}
if (IS_PRODUCTION) {
  const database = new URL(DATABASE_URL);
  if (!PUBLIC_ORIGIN.startsWith('https://') && !/^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(PUBLIC_ORIGIN) && !PUBLIC_ORIGIN.startsWith('http://localhost') && !PUBLIC_ORIGIN.startsWith('http://127.0.0.1')) {
    console.error('PUBLIC_ORIGIN must use HTTPS in production when using a domain name.');
    process.exit(1);
  }
  if (!database.password || ['postgres', 'password', 'changeme'].includes(decodeURIComponent(database.password).toLowerCase())) {
    console.error('Refusing to start production with a missing or default database password.');
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000),
  application_name: 'wamy-media-planner'
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  const suppliedRequestId = String(req.headers['x-request-id'] || '');
  req.requestId = /^[a-zA-Z0-9._-]{1,100}$/.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' https://accounts.google.com https://apis.google.com${IS_PRODUCTION ? '' : " 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://accounts.google.com https://www.googleapis.com https://content.googleapis.com",
    "frame-src https://accounts.google.com https://docs.google.com https://drive.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (IS_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      event: 'http_request', request_id: req.requestId, method: req.method,
      path: req.originalUrl.split('?')[0], status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10, user_id: req.user && req.user.id
    }));
    if (res.statusCode === 403 && req.user && req.path.startsWith('/api/')) {
      pool.query(
        `insert into activity_log(actor_id,actor_name,org,action,type,entity_table,details,request_id,ip_address)
         values($1,$2,$3,$4,'AUTH','authorization',$5,$6,$7)`,
        [req.user.id, req.user.name, req.user.org, `محاولة وصول غير مصرح بها: ${req.method} ${req.path}`,
         { method: req.method, path: req.path, status: res.statusCode }, req.requestId, req.ip]
      ).catch(error => console.error(JSON.stringify({ level:'error', event:'denied_audit_failed', request_id:req.requestId, message:error.message })));
    }
  });
  next();
});

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin && !IS_PRODUCTION) return next();
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ code: 'INVALID_ORIGIN', message: 'مصدر الطلب غير مسموح.' });
  }
  next();
});

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(item => item.trim().split('='))
    .filter(parts => parts.length === 2).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicProfile(row) {
  if (!row) return null;
  const { password_hash, token_hash, expires_at, ...safe } = row;
  return safe;
}

function sessionPayload(profile) {
  return { session: { user: { id: profile.id, email: profile.email } } };
}

async function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `insert into sessions (token_hash,user_id,expires_at)
     values ($1,$2,now() + ($3 || ' days')::interval)`,
    [tokenHash(token), userId, SESSION_DAYS]
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_HTTPS,
    maxAge: SESSION_DAYS * 86400000,
    path: '/'
  });
}

async function loadUser(req, _res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return next();
    const { rows } = await pool.query(
      `select p.* from sessions s join profiles p on p.id=s.user_id
       where s.token_hash=$1 and s.expires_at > now() and p.deleted_at is null`,
      [tokenHash(token)]
    );
    req.sessionToken = token;
    req.user = rows[0] || null;
    next();
  } catch (error) { next(error); }
}
app.use('/api', loadUser);

function requireSession(req, res, next) {
  if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول.' });
  next();
}

function requireActive(req, res, next) {
  if (!req.user) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول.' });
  if (req.user.status !== 'active') return res.status(403).json({ code: 'FORBIDDEN', message: 'الحساب غير نشط.' });
  next();
}

function isAdmin(user) { return Boolean(user && user.role === 'admin' && user.status === 'active'); }
function isSupervisor(user) { return Boolean(user && user.role === 'supervisor' && user.status === 'active'); }
const LEGACY_PERMISSION_MAP = {
  'Tasks.Create':'canCreateTasks','Tasks.Edit':'canCreateTasks','Tasks.Assign':'canCreateTasks','Plans.Import':'canCreateTasks',
  'Files.Approve':'canApproveFiles','Files.MoveToApproved':'canApproveFiles','Settings.Users':'canEditUsers',
  'Settings.Permissions':'canEditUsers','Reports.Export':'canExportReports','Settings.Integrations':'canManageSettings',
  'Organizations.View':'canManageSettings','Organizations.Create':'canManageSettings','Organizations.Edit':'canManageSettings',
  'Organizations.Delete':'canManageSettings','Organizations.Activate':'canManageSettings','Organizations.Deactivate':'canManageSettings',
  'AuditLog.View':'Audit.View',
  'Backup.View':'Settings.Backup','Backup.Create':'Settings.Backup','Backup.Restore':'Settings.Backup','Backup.Download':'Settings.Backup','Backup.Delete':'Settings.Backup',
  'Projects.Activate':'Projects.Edit','Projects.Deactivate':'Projects.Edit'
};
function can(user, permission) {
  if (isAdmin(user)) return true;
  const permissions = (user && user.permissions) || {};
  if (Object.prototype.hasOwnProperty.call(permissions, permission)) return permissions[permission] === true;
  return Boolean(LEGACY_PERMISSION_MAP[permission] && permissions[LEGACY_PERMISSION_MAP[permission]]);
}
function canAny(user, ...permissions) { return permissions.some(permission => can(user,permission)); }
function hasAllData(user) { return isAdmin(user) || user.data_scope === 'all_data'; }
function forbid(res) { return res.status(403).json({ code: 'FORBIDDEN', message: 'ليست لديك الصلاحية لتنفيذ هذه العملية.' }); }

const ENUMS = {
  role: new Set(['admin','supervisor','project_manager','department_manager','team_lead','user','reviewer','approver','read_only']),
  userStatus: new Set(['pending', 'active', 'disabled']),
  org: new Set(['wamy', 'imaan']),
  taskStatus: new Set(['not_started', 'in_progress', 'blocked', 'completed', 'approved']),
  productStatus: new Set(['not_started', 'in_progress', 'completed', 'approved', 'cancelled', 'archived']),
  priority: new Set(['low', 'normal', 'high', 'critical']),
  fileFolder: new Set(['proposals', 'approved']),
  fileStatus: new Set(['draft', 'under_review', 'ready_for_approval', 'approved', 'rejected']),
  taskMode: new Set(['structured', 'adhoc'])
};

function invalid(res, message) {
  return res.status(400).json({ code: 'INVALID_INPUT', message });
}

function expectedVersion(req) {
  const value = String(req.headers['if-match'] || '').trim();
  if (!value) return null;
  const unquoted = value.replace(/^W\//, '').replace(/^"|"$/g, '');
  const timestamp = Date.parse(unquoted);
  return Number.isNaN(timestamp) ? false : timestamp;
}

function versionConflict(res) {
  return res.status(409).json({
    code: 'EDIT_CONFLICT',
    message: 'عدّل مستخدم آخر هذا السجل. تم تحديث البيانات؛ راجع التغييرات ثم أعد المحاولة.'
  });
}

function versionMatches(req, row) {
  const expected = expectedVersion(req);
  if (expected === false) return false;
  return expected === null || expected === new Date(row.updated_at).getTime();
}

function validatePatch(name, body, creating = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'صيغة البيانات غير صالحة.';
  const textLimits = {
    name: 200, title: 300, email: 320, position: 200, department: 200, team: 200, code: 60, content: 10000,
    description: 20000, goal: 5000, required_outputs: 10000, target_qty: 500, recurrence: 500, phase_name: 300,
    notes: 20000, size_label: 100, file_type: 200, version: 100,
    hierarchical_code: 100, legacy_code: 100, plan_track: 200, classification: 100,
    avatar_url: 2000, drive_url: 2000, drive_view_link: 2000, drive_icon_link: 2000,
    mime_type: 300, drive_file_id: 500, drive_parent_id: 500,
    drive_folder_id: 500, drive_proposals_folder_id: 500, drive_approved_folder_id: 500
  };
  for (const [key, limit] of Object.entries(textLimits)) {
    if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > limit)) return `${key} غير صالح أو طويل جدًا.`;
  }
  const enumChecks = [
    ['role', ENUMS.role], ['status', name === 'tasks' ? ENUMS.taskStatus : name === 'products' ? ENUMS.productStatus : name === 'files' ? ENUMS.fileStatus : ENUMS.userStatus],
    ['priority', ENUMS.priority], ['folder', ENUMS.fileFolder], ['task_mode', ENUMS.taskMode]
  ];
  for (const [key, values] of enumChecks) {
    if (body[key] != null && !values.has(body[key])) return `${key} يحتوي على قيمة غير مسموحة.`;
  }
  if (body.org != null) {
    if (typeof body.org !== 'string' || !/^[a-z0-9_-]{2,50}$/i.test(body.org.trim())) return 'الجهة غير صالحة.';
  }
  if (name === 'tasks') {
    for (const key of ['priority','status']) {
      if (Object.prototype.hasOwnProperty.call(body, key) && body[key] == null) return `${key} حقل إلزامي ولا يقبل قيمة فارغة.`;
    }
  }
  for (const key of ['progress', 'manual_progress']) {
    if (body[key] != null && (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > 100)) return `${key} يجب أن يكون بين 0 و100.`;
  }
  for (const key of ['active_duration', 'active_duration_days']) {
    if (body[key] != null && (!Number.isInteger(body[key]) || body[key] < 1 || body[key] > 10000)) return `${key} يجب أن يكون عدد أيام صالحًا.`;
  }
  for (const key of ['planned_start', 'start_date', 'due_date']) {
    if (body[key] != null && !isoDate(body[key])) return `${key} يجب أن يكون تاريخًا بصيغة YYYY-MM-DD.`;
  }
  for (const key of ['scheduled_start_at', 'scheduled_due_at']) {
    if (body[key] != null && (typeof body[key] !== 'string' || Number.isNaN(Date.parse(body[key])))) return `${key} يجب أن يكون تاريخًا ووقتًا صالحين.`;
  }
  if (body.scheduled_start_at && body.scheduled_due_at && Date.parse(body.scheduled_due_at) < Date.parse(body.scheduled_start_at)) {
    return 'موعد استحقاق المهمة لا يمكن أن يسبق وقت بدايتها.';
  }
  const start = body.planned_start || body.start_date;
  if (start && body.due_date && body.due_date < start) return 'تاريخ الاستحقاق لا يمكن أن يسبق تاريخ البدء.';
  if (body.email != null && !/^\S+@\S+\.\S+$/.test(body.email.trim())) return 'البريد الإلكتروني غير صالح.';
  if (body.permissions != null) {
    if (typeof body.permissions !== 'object' || Array.isArray(body.permissions)
      || Object.keys(body.permissions).some(key => !(key in ALL_PERMISSIONS) || typeof body.permissions[key] !== 'boolean')) {
      return 'بنية الصلاحيات غير صالحة.';
    }
  }
  if (body.data_scope != null && !['my_data','my_team','my_department','my_project','all_data'].includes(body.data_scope)) return 'نطاق البيانات غير صالح.';
  if (name === 'products') {
    if (body.project_id != null && (typeof body.project_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.project_id))) return 'معرف المشروع غير صالح.';
  }
  if (name === 'tasks') {
    if (body.project_id != null && (typeof body.project_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.project_id))) return 'معرف المشروع غير صالح.';
    if (body.plan_item_id != null && (typeof body.plan_item_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.plan_item_id))) return 'معرف بند الخطة غير صالح.';
    if (body.product_id != null && (typeof body.product_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.product_id))) return 'معرف المنتج غير صالح.';
    if (!creating && Object.prototype.hasOwnProperty.call(body, 'project_id') && !body.project_id) return 'لا يمكن إزالة ارتباط المهمة بالمشروع.';
  }
  if (creating && name === 'tasks') {
    if (!String(body.title || '').trim()) return 'اسم المهمة مطلوب.';
    if (body.task_mode !== 'adhoc' && !body.project_id) return 'يجب ربط المهمة بمشروع معتمد.';
    if (!String(body.required_outputs || '').trim()) return 'المخرجات المطلوبة للمهمة إلزامية.';
    if (!body.scheduled_start_at || !body.scheduled_due_at) return 'تزمين المهمة المعتمد إلزامي.';
    if (!body.assignee_id) return 'يجب إسناد المهمة إلى مسؤول واحد على الأقل.';
  }
  if (creating && name === 'products' && (!String(body.code || '').trim() || !String(body.name || '').trim())) return 'رمز المنتج واسمه مطلوبان.';
  if (creating && name === 'files' && !String(body.name || '').trim()) return 'اسم الملف مطلوب.';
  return null;
}

async function writeAudit(client, req, action, type, entityTable = null, entityId = null, details = {}) {
  const actor = req.user;
  await client.query(
    `insert into activity_log (actor_id,actor_name,org,action,type,entity_table,entity_id,details,request_id,ip_address)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actor && actor.id, actor && actor.name, actor && actor.org, action, type,
     entityTable, entityId && String(entityId), details, req.requestId, req.ip]
  );
}

async function loginBlocked(email, ip) {
  const { rows } = await pool.query(
    `select
       count(*) filter(where lower(email)=lower($2))::int as account_failures,
       count(*) filter(where ip_address=$3)::int as ip_failures
     from login_attempts
     where succeeded=false and attempted_at > now() - ($1 || ' minutes')::interval
       and (lower(email)=lower($2) or ip_address=$3)`,
    [LOGIN_WINDOW_MINUTES, email, ip]
  );
  return rows[0].account_failures >= LOGIN_MAX_FAILURES || rows[0].ip_failures >= LOGIN_MAX_IP_FAILURES;
}

async function recordLogin(email, ip, succeeded, userId = null) {
  await pool.query(
    'insert into login_attempts(email,ip_address,succeeded,user_id) values ($1,$2,$3,$4)',
    [email.slice(0, 320), ip, succeeded, userId]
  );
  if (succeeded) {
    await pool.query('delete from login_attempts where lower(email)=lower($1) and succeeded=false', [email]);
  }
}

function cleanObject(source, allowed) {
  return Object.fromEntries(allowed.filter(key => Object.prototype.hasOwnProperty.call(source || {}, key))
    .map(key => [key, source[key] === '' ? null : source[key]]));
}

function updateStatement(table, id, patch, allowed) {
  const values = cleanObject(patch, allowed);
  const keys = Object.keys(values);
  if (!keys.length) return null;
  return {
    text: `update ${table} set ${keys.map((key, index) => `${key}=$${index + 1}`).join(',')} where id=$${keys.length + 1} returning *`,
    values: [...keys.map(key => values[key]), id]
  };
}

function insertStatement(table, body, allowed, forced = {}) {
  const values = { ...cleanObject(body, allowed), ...forced };
  const keys = Object.keys(values);
  return {
    text: `insert into ${table} (${keys.join(',')}) values (${keys.map((_, index) => `$${index + 1}`).join(',')}) returning *`,
    values: keys.map(key => values[key])
  };
}

const PRIORITY_LABELS = new Map([
  ['منخفضة', 'low'], ['low', 'low'], ['عادية', 'normal'], ['normal', 'normal'],
  ['عاجلة', 'high'], ['high', 'high'], ['حرجة', 'critical'], ['critical', 'critical']
]);
const ORG_LABELS = new Map([['الندوة', 'wamy'], ['الندوة wamy', 'wamy'], ['wamy', 'wamy'], ['إمعان', 'imaan'], ['imaan', 'imaan']]);
const TASK_STATUS_LABELS = new Map([
  ['لم تبدأ', 'not_started'], ['not_started', 'not_started'],
  ['قيد التنفيذ', 'in_progress'], ['in_progress', 'in_progress'],
  ['متعثرة', 'blocked'], ['blocked', 'blocked'],
  ['منجزة', 'completed'], ['مكتملة', 'completed'], ['completed', 'completed'],
  ['معتمدة', 'approved'], ['approved', 'approved']
]);
const TASK_STATUS_EXPORT = {
  not_started: 'لم تبدأ', in_progress: 'قيد التنفيذ', blocked: 'متعثرة',
  completed: 'منجزة', approved: 'معتمدة'
};
const STANDARD_PLAN_HEADERS = ['رمز المنتج','اسم المنتج','اسم المرحلة','اسم المهمة','وصف المهمة','الجهة المسؤولة','بريد المسؤول','تاريخ البدء','تاريخ الاستحقاق','المدة بالأيام','الأولوية','الملاحظات'];
const LEGACY_PLAN_HEADERS = ['م','المنتج','وصف المهمة','التاريخ','الحالة','الفئة','المسؤول عن المتابعة','ملاحظات','أيام حتى الموعد','الوضع الزمني'];
const MASTER_PLAN_HEADERS = ['معرف_السجل','المعرف_الأب','رمز_المشروع','اسم_المشروع','نوع_البند','المسار','المرحلة','المنتج_أو_المخرج','مضمون_المنتج','الوصف_التفصيلي','الكمية','الوحدة','الجهة_المسؤولة','تاريخ_البداية_المخطط','تاريخ_الاستحقاق','المدة','وحدة_المدة','الزمن_كما_ورد','التكرار','مؤشر_الأداء','المستهدف','الأولوية','حالة_التنفيذ','ملاحظات_الاستيراد'];

function excelCellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.result != null) return excelCellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim();
  }
  return String(value).trim();
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(text + 'T00:00:00Z');
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

function taskFingerprint(row) {
  const canonical = [row.product_id, row.phase_name, row.title, row.planned_start, row.due_date]
    .map(value => String(value || '').trim().toLowerCase()).join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function validatePlanRows(inputRows) {
  const [{ rows: products }, { rows: users }, { rows: existing }] = await Promise.all([
    pool.query('select id,code,name,org,status,is_active,allow_multiple_tasks from products where deleted_at is null order by code'),
    pool.query(`select id,name,email,status from profiles where deleted_at is null order by name`),
    pool.query(`select id,product_id,status,import_key,phase_name,title,planned_start,due_date from tasks where deleted_at is null`)
  ]);
  const productByCode = new Map(products.map(product => [product.code.toLowerCase(), product]));
  const productByName = new Map(products.map(product => [product.name.trim().toLowerCase(), product]));
  const userByEmail = new Map(users.map(user => [user.email.toLowerCase(), user]));
  const userByName = new Map(users.map(user => [user.name.trim().toLowerCase(), user]));
  const fingerprints = new Set(existing.map(task => task.import_key || taskFingerprint(task)).filter(Boolean));
  const occupiedProducts = new Set(existing.map(task => task.product_id).filter(Boolean));
  const batchProducts = new Set();

  return inputRows.map((source, index) => {
    const errors = [];
    const productCode = String(source.product_code || '').trim().toLowerCase();
    const productName = String(source.product_name || '').trim().toLowerCase();
    const product = productByCode.get(productCode) || productByName.get(productName);
    const title = String(source.title || '').trim();
    const assigneeEmail = String(source.assignee_email || '').trim().toLowerCase();
    const assigneeName = String(source.assignee_name || '').trim().toLowerCase();
    const assignee = assigneeEmail ? userByEmail.get(assigneeEmail) : assigneeName ? userByName.get(assigneeName) : null;
    const orgText = String(source.org || '').trim();
    const org = ORG_LABELS.get(orgText.toLowerCase()) || ORG_LABELS.get(orgText);
    const priority = PRIORITY_LABELS.get(String(source.priority || 'عادية').trim().toLowerCase())
      || PRIORITY_LABELS.get(String(source.priority || 'عادية').trim());
    const plannedStart = source.planned_start ? isoDate(source.planned_start) : null;
    const dueDate = source.due_date ? isoDate(source.due_date) : null;
    const duration = source.active_duration === '' || source.active_duration == null
      ? null : Number(source.active_duration);
    const status = TASK_STATUS_LABELS.get(String(source.status || 'not_started').trim().toLowerCase())
      || TASK_STATUS_LABELS.get(String(source.status || 'not_started').trim());

    if (!product) errors.push('المنتج غير موجود؛ استخدم الرمز أو الاسم المعتمد في النموذج.');
    if (!title) errors.push('اسم المهمة مطلوب.');
    if (!org) errors.push('الجهة غير صحيحة؛ استخدم WAMY أو إمعان.');
    if ((assigneeEmail || assigneeName) && (!assignee || assignee.status !== 'active')) errors.push('المسؤول غير موجود أو حسابه غير نشط.');
    if (source.planned_start && !plannedStart) errors.push('تاريخ البدء غير صحيح؛ استخدم YYYY-MM-DD.');
    if (source.due_date && !dueDate) errors.push('تاريخ الاستحقاق غير صحيح؛ استخدم YYYY-MM-DD.');
    if (!source.due_date) errors.push('تاريخ الاستحقاق مطلوب.');
    if (plannedStart && dueDate && dueDate < plannedStart) errors.push('تاريخ الاستحقاق يسبق تاريخ البدء.');
    if (!priority) errors.push('الأولوية غير صحيحة.');
    if (!status) errors.push('حالة المهمة غير صحيحة.');
    if (duration != null && (!Number.isInteger(duration) || duration < 1 || duration > 2000)) errors.push('المدة يجب أن تكون عدد أيام من 1 إلى 2000.');
    if (product && (!product.is_active || ['completed', 'approved', 'cancelled', 'archived'].includes(product.status))) errors.push('المنتج مغلق أو ملغى أو مؤرشف أو غير نشط.');
    if (product && !product.allow_multiple_tasks && (occupiedProducts.has(product.id) || batchProducts.has(product.id))) {
      errors.push('المنتج لا يسمح بأكثر من مهمة وقد ارتبط بمهمة مسبقًا.');
    }

    const row = {
      row_number: source.row_number || index + 2,
      product_id: product ? product.id : null,
      product_code: product ? product.code : String(source.product_code || ''),
      product_name: product ? product.name : String(source.product_name || ''),
      phase_name: String(source.phase_name || '').trim() || null,
      title,
      description: String(source.description || '').trim() || null,
      org: org || null,
      assignee_id: assignee ? assignee.id : null,
      assignee_name: assignee ? assignee.name : null,
      assignee_email: assigneeEmail || null,
      planned_start: plannedStart,
      due_date: dueDate,
      active_duration: duration,
      priority: priority || null,
      status: status || null,
      progress: ['completed', 'approved'].includes(status) ? 100 : Number(source.progress) || 0,
      notes: String(source.notes || '').trim() || null
    };
    row.import_key = product && title ? taskFingerprint(row) : null;
    const duplicate = Boolean(row.import_key && fingerprints.has(row.import_key));
    if (duplicate) errors.push('هذه المهمة مستوردة أو موجودة مسبقًا.');
    if (row.import_key) fingerprints.add(row.import_key);
    if (product && !errors.length) batchProducts.add(product.id);
    return { ...row, valid: errors.length === 0, duplicate, errors };
  });
}

const FIELDS = {
  profiles: ['name','email','role','org','position','department','team','data_scope','status','permissions','avatar_url'],
  projects: ['code','hierarchical_code','name','description','objective','vision','mission','org','manager_id','planned_start','planned_end','status','budget','currency','source_notes','classification'],
  products: ['code','hierarchical_code','legacy_code','project_id','plan_track','name','content','target_qty','org','manager_id','start_date','due_date','status','manual_progress','active_duration_days','recurrence','allow_multiple_tasks','is_active','drive_folder_id','drive_proposals_folder_id','drive_approved_folder_id'],
  tasks: ['product_id','project_id','plan_item_id','title','description','goal','required_outputs','org','assignee_id','priority','status','progress','planned_start','due_date','scheduled_start_at','scheduled_due_at','actual_completion','active_duration','phase_name','notes','import_key','created_by','task_mode'],
  files: ['name','product_id','folder','size_label','file_type','uploader_id','org','drive_url','version','status','approved_by','approved_at','drive_file_id','drive_view_link','drive_icon_link','mime_type','size_bytes','drive_parent_id'],
  organizations: ['code','name','name_en','description','is_active'],
  settings: ['drive_client_id','drive_picker_api_key','drive_root_folder_id','drive_root_folder_name','updated_by']
};

async function getOrCreateAdhocSystemProject(client, orgCode, actorId) {
  const normalizedOrg = String(orgCode || 'wamy').toLowerCase().trim();
  const systemKey = `adhoc:${normalizedOrg}`;
  
  const existing = await client.query(
    `select id, code, hierarchical_code, name, org, is_system, system_key
       from projects
      where system_key = $1 and deleted_at is null
      limit 1`,
    [systemKey]
  );
  if (existing.rows[0]) return existing.rows[0];

  const softDeleted = await client.query(
    `update projects
        set deleted_at = null, updated_at = now()
      where system_key = $1
      returning id, code, hierarchical_code, name, org, is_system, system_key`,
    [systemKey]
  );
  if (softDeleted.rows[0]) return softDeleted.rows[0];

  const orgRow = (await client.query(
    `select name from organizations where lower(code) = $1 limit 1`,
    [normalizedOrg]
  )).rows[0];
  const orgName = (orgRow && orgRow.name) || (normalizedOrg === 'imaan' ? 'إمعان' : 'الندوة العالمية للشباب الإسلامي');
  const prjCode = `SYS-ADHOC-${normalizedOrg.toUpperCase()}`;
  const prjName = `المهام التشغيلية المستقلة - ${orgName}`;

  const inserted = await client.query(
    `insert into projects (code, hierarchical_code, name, description, org, status, is_system, system_key, created_by)
     values ($1, $1, $2, 'مشروع نظامي مخصص لاحتواء المهام التشغيلية المستقلة لضمان تكامل القيود وقواعد البيانات', $3, 'active', true, $4, $5)
     returning id, code, hierarchical_code, name, org, is_system, system_key`,
    [prjCode, prjName, normalizedOrg, systemKey, actorId]
  );
  return inserted.rows[0];
}

app.get('/api/health/live', (_req, res) => res.json({ ok: true }));
app.get(['/api/health', '/api/health/ready'], async (_req, res, next) => {
  try { await pool.query('select 1'); res.json({ ok: true, database: 'postgresql' }); } catch (error) { next(error); }
});

app.get('/api/auth/session', (req, res) => {
  res.json(req.user ? sessionPayload(req.user) : { session: null });
});

app.post('/api/auth/signup', async (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  const org = req.body.org === 'imaan' ? 'imaan' : 'wamy';
  const position = String(req.body.position || '').trim() || null;
  if (!/^\S+@\S+\.\S+$/.test(email) || !name || email.length > 320 || name.length > 200) return res.status(400).json({ message: 'الاسم والبريد الإلكتروني مطلوبان.' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ message: 'كلمة المرور يجب أن تكون بين 12 و200 حرف.' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(20260904)`);
    const first = Number((await client.query('select count(*)::int as count from profiles')).rows[0].count) === 0;
    if (IS_PRODUCTION && first && (!process.env.BOOTSTRAP_ADMIN_TOKEN
      || req.headers['x-bootstrap-token'] !== process.env.BOOTSTRAP_ADMIN_TOKEN)) {
      await client.query('rollback');
      return res.status(403).json({ code: 'BOOTSTRAP_REQUIRED', message: 'يلزم رمز التهيئة لإنشاء مدير النظام الأول.' });
    }
    if (IS_PRODUCTION && !first && process.env.ALLOW_PUBLIC_SIGNUP !== 'true') {
      await client.query('rollback');
      return res.status(403).json({ code: 'SIGNUP_DISABLED', message: 'إنشاء الحسابات العامة معطل.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await client.query(
      `insert into profiles (name,email,password_hash,role,org,position,status,permissions,data_scope)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,name,email,org,status`,
      [name, email, passwordHash, first ? 'admin' : 'user', org, position,
       first ? 'active' : 'pending', first ? ALL_PERMISSIONS : { ...NO_PERMISSIONS, 'Dashboard.View': true }, first ? 'all_data' : 'my_data']
    );
    await client.query(
      `insert into activity_log(actor_id,actor_name,org,action,type,entity_table,entity_id,details,request_id,ip_address)
       values($1,$2,$3,$4,'AUTH','profiles',$1,$5,$6,$7)`,
      [result.rows[0].id, result.rows[0].name, result.rows[0].org, 'إنشاء حساب',
       { first_admin: first, initial_status: result.rows[0].status }, req.requestId, req.ip]
    );
    await client.query('commit');
    res.status(201).json({ user: result.rows[0], firstAdmin: first });
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') return res.status(409).json({ code: error.code, message: 'User already registered' });
    next(error);
  } finally { client.release(); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (await loginBlocked(email, req.ip)) {
      console.warn(JSON.stringify({ level: 'warn', event: 'login_throttled', request_id: req.requestId, ip: req.ip }));
      return res.status(429).json({ code: 'LOGIN_THROTTLED', message: 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.' });
    }
    const { rows } = await pool.query('select * from profiles where lower(email)=$1 and deleted_at is null', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
      await recordLogin(email, req.ip, false, user && user.id);
      console.warn(JSON.stringify({ level: 'warn', event: 'login_failed', request_id: req.requestId, ip: req.ip,
        user_id: user && user.id }));
      return res.status(401).json({ message: 'Invalid login credentials' });
    }
    if (user.status !== 'active') {
      await recordLogin(email, req.ip, false, user.id);
      console.warn(JSON.stringify({ level: 'warn', event: 'login_inactive', request_id: req.requestId, ip: req.ip,
        user_id: user.id }));
      return res.status(403).json({ code: 'ACCOUNT_INACTIVE', message: 'الحساب غير نشط.' });
    }
    await recordLogin(email, req.ip, true, user.id);
    await issueSession(res, user.id);
    req.user = user;
    await writeAudit(pool, req, 'تسجيل الدخول', 'AUTH', 'profiles', user.id);
    res.json(sessionPayload(user));
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireSession, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await writeAudit(client, req, 'تسجيل الخروج', 'AUTH', 'profiles', req.user.id);
    await client.query('delete from sessions where token_hash=$1', [tokenHash(req.sessionToken)]);
    await client.query('commit');
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.status(204).end();
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.post('/api/auth/change-password', requireSession, requireActive, async (req, res, next) => {
  const currentPassword = String(req.body.current_password || req.body.currentPassword || '');
  const newPassword = String(req.body.new_password || req.body.newPassword || '');
  if (!currentPassword) return invalid(res, 'كلمة المرور الحالية مطلوبة.');
  if (newPassword.length < 12 || newPassword.length > 200) {
    return invalid(res, 'كلمة المرور الجديدة يجب أن تكون بين 12 و200 حرف.');
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const userRow = (await client.query('select id, password_hash, email from profiles where id=$1 for update', [req.user.id])).rows[0];
    if (!userRow || !(await bcrypt.compare(currentPassword, userRow.password_hash))) {
      await client.query('rollback');
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', message: 'كلمة المرور الحالية غير صحيحة.' });
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await client.query('update profiles set password_hash=$1, updated_at=now() where id=$2', [newHash, req.user.id]);
    if (req.sessionToken) {
      await client.query('delete from sessions where user_id=$1 and token_hash<>$2', [req.user.id, tokenHash(req.sessionToken)]);
    }
    await writeAudit(client, req, 'تغيير كلمة المرور', 'AUTH', 'profiles', req.user.id, { email: userRow.email });
    await client.query('commit');
    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح.' });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.get('/api/profiles/me', requireSession, (req, res) => res.json(publicProfile(req.user)));
app.get('/api/profiles', requireActive, async (req, res, next) => {
  if (!can(req.user,'Settings.Users')) return forbid(res);
  try {
    const privileged = isAdmin(req.user) || hasAllData(req.user);
    const { rows } = await pool.query(
      `select p.id,p.name,p.email,p.role,p.org,p.position,p.department,p.team,p.data_scope,p.status,p.permissions,p.avatar_url,p.created_at,p.updated_at,
              (select max(i.expires_at) from user_invitations i where i.profile_id=p.id
                and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()) as invitation_expires_at
       from profiles p where p.deleted_at is null and ($1::boolean or p.org=$2) order by p.name`,
      [privileged, req.user.org]
    );
    res.json(rows);
  } catch (error) { next(error); }
});

app.post('/api/profiles/invite', requireActive, async (req, res, next) => {
  if (!isAdmin(req.user)) return forbid(res);
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const position = String(req.body.position || '').trim() || null;
  const department = String(req.body.department || '').trim() || null;
  const team = String(req.body.team || '').trim() || null;
  const dataScope = ['my_data','my_team','my_department','my_project','all_data'].includes(req.body.data_scope) ? req.body.data_scope : 'my_data';
  const role = ENUMS.role.has(req.body.role) ? req.body.role : 'user';
  const org = ENUMS.org.has(req.body.org) ? req.body.org : 'wamy';
  const requestedPermissions = req.body.permissions == null ? {} : req.body.permissions;
  const permissions = role === 'admin' ? ALL_PERMISSIONS : { ...NO_PERMISSIONS, ...requestedPermissions };
  const validationError = validatePatch('profiles', { name,email,position,department,team,data_scope:dataScope,role,org,permissions });
  if (validationError) return invalid(res, validationError);
  if (!name || name.length > 200 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 320) return invalid(res, 'الاسم والبريد الإلكتروني الصحيح مطلوبان.');
  if (req.body.profile_id && !/^[0-9a-f-]{36}$/i.test(req.body.profile_id)) return invalid(res, 'معرّف المستخدم غير صالح.');

  const token = crypto.randomBytes(32).toString('base64url');
  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 12);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [email]);
    const existing = (await client.query(
      req.body.profile_id
        ? `select * from profiles where deleted_at is null and id=$1 and lower(email)=$2 for update`
        : `select * from profiles where deleted_at is null and lower(email)=$1 for update`,
      req.body.profile_id ? [req.body.profile_id,email] : [email]
    )).rows[0];
    if (existing && existing.status === 'active') {
      await client.query('rollback');
      return res.status(409).json({ code: 'USER_ACTIVE', message: 'هذا المستخدم نشط بالفعل؛ يمكنك تعديل صلاحياته من القائمة.' });
    }
    if (!existing && req.body.profile_id) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المستخدم غير موجود أو أن البريد لا يطابق حسابه.' });
    }
    const profile = existing
      ? (await client.query(
          `update profiles set name=$1,email=$2,password_hash=$3,role=$4,org=$5,position=$6,department=$7,team=$8,data_scope=$9,status='pending',permissions=$10
            where id=$11 returning *`, [name,email,unusablePassword,role,org,position,department,team,dataScope,permissions,existing.id]
        )).rows[0]
      : (await client.query(
          `insert into profiles(name,email,password_hash,role,org,position,department,team,data_scope,status,permissions)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10) returning *`, [name,email,unusablePassword,role,org,position,department,team,dataScope,permissions]
        )).rows[0];
    await client.query(
      `update user_invitations set revoked_at=now() where profile_id=$1 and accepted_at is null and revoked_at is null`,
      [profile.id]
    );
    const invitation = (await client.query(
      `insert into user_invitations(profile_id,token_hash,created_by,expires_at)
       values($1,$2,$3,now()+($4 || ' hours')::interval) returning id,expires_at`,
      [profile.id,tokenHash(token),req.user.id,INVITATION_HOURS]
    )).rows[0];
    await writeAudit(client, req, existing ? 'إعادة إصدار دعوة مستخدم' : 'إضافة مستخدم وإصدار دعوة', 'CREATE', 'profiles', profile.id, {
      email,role,org,data_scope:dataScope,permissions,invitation_id: invitation.id,expires_at: invitation.expires_at
    });
    await client.query('commit');
    const base = PUBLIC_ORIGIN.replace(/\/$/, '');
    res.status(existing ? 200 : 201).json({
      user: publicProfile(profile), invitation_url: `${base}/?invite=${encodeURIComponent(token)}`,
      expires_at: invitation.expires_at
    });
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') return res.status(409).json({ code: error.code, message: 'البريد الإلكتروني مستخدم مسبقًا.' });
    next(error);
  } finally { client.release(); }
});

app.get('/api/auth/invitations/:token', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select p.name,p.email,p.position,p.role,p.org,i.expires_at
         from user_invitations i join profiles p on p.id=i.profile_id
        where i.token_hash=$1 and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
          and p.deleted_at is null and p.status='pending'`, [tokenHash(String(req.params.token || ''))]
    );
    if (!rows[0]) return res.status(404).json({ code: 'INVITATION_INVALID', message: 'رابط الدعوة غير صالح أو منتهي الصلاحية.' });
    res.json(rows[0]);
  } catch (error) { next(error); }
});

app.post('/api/auth/invitations/:token/accept', async (req, res, next) => {
  const password = String(req.body.password || '');
  if (password.length < 12 || password.length > 200) return invalid(res, 'كلمة المرور يجب أن تكون بين 12 و200 حرف.');
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  let profile;
  try {
    await client.query('begin');
    const invitation = (await client.query(
      `select i.id,i.profile_id from user_invitations i join profiles p on p.id=i.profile_id
        where i.token_hash=$1 and i.accepted_at is null and i.revoked_at is null and i.expires_at>now()
          and p.deleted_at is null and p.status='pending' for update`, [tokenHash(String(req.params.token || ''))]
    )).rows[0];
    if (!invitation) {
      await client.query('rollback');
      return res.status(404).json({ code: 'INVITATION_INVALID', message: 'رابط الدعوة غير صالح أو منتهي الصلاحية.' });
    }
    profile = (await client.query(
      `update profiles set password_hash=$1,status='active' where id=$2 returning *`, [passwordHash,invitation.profile_id]
    )).rows[0];
    await client.query('update user_invitations set accepted_at=now() where id=$1', [invitation.id]);
    req.user = profile;
    await writeAudit(client, req, 'قبول دعوة وتفعيل الحساب', 'AUTH', 'profiles', profile.id, { invitation_id: invitation.id });
    await client.query('commit');
    await issueSession(res, profile.id);
    res.json({ ...sessionPayload(profile), user: publicProfile(profile) });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});
app.patch('/api/profiles/:id', requireActive, async (req, res, next) => {
  const self = req.params.id === req.user.id;
  if (!self && !can(req.user, 'Settings.Users')) return forbid(res);
  if (!self && !isAdmin(req.user)) {
    const target = (await pool.query('select org from profiles where id=$1 and deleted_at is null', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ message: 'المستخدم غير موجود.' });
    if (!self && !isAdmin(req.user) && target.org !== req.user.org) return forbid(res);
  }
  const validationError = validatePatch('profiles', req.body);
  if (validationError) return invalid(res, validationError);
  const allowed = self ? ['name','position','avatar_url']
    : isAdmin(req.user) ? FIELDS.profiles : ['name','email','org','position','status','avatar_url'];
  const query = updateStatement('profiles', req.params.id, req.body, allowed);
  if (!query) return res.status(400).json({ message: 'لا توجد حقول صالحة للتحديث.' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = (await client.query(
      `select updated_at,${allowed.join(',')} from profiles where id=$1 and deleted_at is null for update`, [req.params.id]
    )).rows[0];
    if (before && !versionMatches(req, before)) {
      await client.query('rollback');
      return versionConflict(res);
    }
    const { rows } = await client.query(query);
    if (!rows.length) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المستخدم غير موجود.' });
    }
    const changedFields = Object.keys(cleanObject(req.body, allowed));
    await writeAudit(client, req, 'تحديث مستخدم', 'UPDATE', 'profiles', rows[0].id, {
      changed_fields: changedFields,
      before: Object.fromEntries(changedFields.map(key => [key, before && before[key]])),
      after: Object.fromEntries(changedFields.map(key => [key, rows[0][key]]))
    });
    await client.query('commit');
    res.json([publicProfile(rows[0])]);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});
app.delete('/api/profiles/:id', requireActive, async (req, res, next) => {
  if (!isAdmin(req.user) || req.params.id === req.user.id) return forbid(res);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`update profiles set status='disabled',deleted_at=now() where id=$1 and deleted_at is null returning id`, [req.params.id]);
    if (!rows.length) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المستخدم غير موجود.' });
    }
    await client.query('delete from sessions where user_id=$1', [req.params.id]);
    await client.query(`update user_invitations set revoked_at=coalesce(revoked_at,now()) where profile_id=$1 and accepted_at is null`, [req.params.id]);
    await writeAudit(client, req, 'أرشفة مستخدم', 'DELETE', 'profiles', req.params.id);
    await client.query('commit');
    res.json(rows);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.post('/api/profiles/:id/reset-password', requireActive, async (req, res, next) => {
  if (!isAdmin(req.user)) return forbid(res);
  const targetId = req.params.id;
  const newPassword = String(req.body.new_password || req.body.newPassword || '');
  if (newPassword.length < 12 || newPassword.length > 200) {
    return invalid(res, 'كلمة المرور الجديدة يجب أن تكون بين 12 و200 حرف.');
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const targetUser = (await client.query('select id, name, email from profiles where id=$1 and deleted_at is null for update', [targetId])).rows[0];
    if (!targetUser) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المستخدم غير موجود.' });
    }
    const newHash = await bcrypt.hash(newPassword, 12);
    await client.query('update profiles set password_hash=$1, updated_at=now() where id=$2', [newHash, targetId]);
    await client.query('delete from sessions where user_id=$1', [targetId]);
    await writeAudit(client, req, `إعادة تعيين كلمة مرور المستخدم: ${targetUser.name}`, 'AUTH', 'profiles', targetId, {
      target_email: targetUser.email,
      target_name: targetUser.name
    });
    await client.query('commit');
    res.json({ success: true, message: 'تمت إعادة تعيين كلمة المرور بنجاح وإلغاء جميع الجلسات النشطة للمستخدم.' });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------------------------
// Organizations Endpoints
// -----------------------------------------------------------------------------
app.get('/api/organizations', requireActive, async (req, res, next) => {
  try {
    const includeInactive = req.query.include_inactive === 'true' && canAny(req.user, 'Organizations.Edit', 'Settings.General');
    const { rows } = await pool.query(
      `select o.*,
              coalesce(p_cnt.cnt, 0)::int as profiles_count,
              coalesce(prj_cnt.cnt, 0)::int as projects_count,
              coalesce(t_cnt.cnt, 0)::int as tasks_count
         from organizations o
         left join (
           select org, count(*) as cnt from profiles where deleted_at is null group by org
         ) p_cnt on lower(p_cnt.org) = lower(o.code)
         left join (
           select org, count(*) as cnt from projects where deleted_at is null and is_system = false group by org
         ) prj_cnt on lower(prj_cnt.org) = lower(o.code)
         left join (
           select org, count(*) as cnt from tasks where deleted_at is null group by org
         ) t_cnt on lower(t_cnt.org) = lower(o.code)
        where o.deleted_at is null and ($1::boolean or o.is_active = true)
        order by o.code`,
      [includeInactive]
    );
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/organizations', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Organizations.Create')) return forbid(res);
  const code = String(req.body.code || '').trim().toLowerCase();
  const name = String(req.body.name || req.body.name_ar || '').trim();
  const nameAr = String(req.body.name_ar || req.body.name || '').trim();
  const nameEn = String(req.body.name_en || '').trim() || null;
  const shortName = String(req.body.short_name || '').trim() || null;
  const description = String(req.body.description || '').trim() || null;
  const color = String(req.body.color || '#3b82f6').trim();
  const isActive = req.body.is_active !== false;

  if (!code || !/^[a-z0-9_-]{2,50}$/.test(code)) {
    return invalid(res, 'رمز الجهة يجب أن يتكون من 2 إلى 50 حرفًا إنجليزيًا أو أرقام بدون مسافات.');
  }
  if (!name || name.length > 200) {
    return invalid(res, 'اسم الجهة مطلوب وألا يتجاوز 200 حرف.');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into organizations (code, name, name_ar, name_en, short_name, description, color, is_active, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [code, name, nameAr, nameEn, shortName, description, color, isActive, req.user.id]
    );
    await writeAudit(client, req, `إضافة جهة جديدة: ${name} (${code})`, 'CREATE', 'organizations', rows[0].id, { code, name });
    await client.query('commit');
    res.status(201).json(rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') return res.status(409).json({ code: 'DUPLICATE_ORG', message: 'رمز أو اسم الجهة مستخدم مسبقًا.' });
    next(error);
  } finally {
    client.release();
  }
});

app.patch('/api/organizations/:id', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Organizations.Edit')) return forbid(res);
  const allowed = ['name', 'name_ar', 'name_en', 'short_name', 'description', 'color', 'logo_url', 'is_active', 'sort_order'];
  const query = updateStatement('organizations', req.params.id, req.body, allowed);
  if (!query) return invalid(res, 'لا توجد حقول صالحة للتحديث.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = (await client.query('select * from organizations where id=$1 and deleted_at is null for update', [req.params.id])).rows[0];
    if (!before) { await client.query('rollback'); return res.status(404).json({ message: 'الجهة غير موجودة.' }); }
    if (!versionMatches(req, before)) { await client.query('rollback'); return versionConflict(res); }
    const { rows } = await client.query(query);
    await writeAudit(client, req, `تعديل بيانات الجهة: ${rows[0].name}`, 'UPDATE', 'organizations', req.params.id, {
      changed_fields: Object.keys(cleanObject(req.body, allowed))
    });
    await client.query('commit');
    res.json(rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') return res.status(409).json({ code: 'DUPLICATE_ORG', message: 'اسم الجهة مستخدم مسبقًا.' });
    next(error);
  } finally {
    client.release();
  }
});

app.post('/api/organizations/:id/activate', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Organizations.Activate', 'Organizations.Edit')) return forbid(res);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`update organizations set is_active=true, updated_at=now() where id=$1 and deleted_at is null returning *`, [req.params.id]);
    if (!rows[0]) { await client.query('rollback'); return res.status(404).json({ message: 'الجهة غير موجودة.' }); }
    await writeAudit(client, req, `تفعيل الجهة: ${rows[0].name}`, 'UPDATE', 'organizations', req.params.id);
    await client.query('commit');
    res.json(rows[0]);
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

app.post('/api/organizations/:id/deactivate', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Organizations.Deactivate', 'Organizations.Edit')) return forbid(res);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`update organizations set is_active=false, updated_at=now() where id=$1 and deleted_at is null returning *`, [req.params.id]);
    if (!rows[0]) { await client.query('rollback'); return res.status(404).json({ message: 'الجهة غير موجودة.' }); }
    await writeAudit(client, req, `تعطيل الجهة: ${rows[0].name}`, 'UPDATE', 'organizations', req.params.id);
    await client.query('commit');
    res.json(rows[0]);
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

app.delete('/api/organizations/:id', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Organizations.Delete') && !isAdmin(req.user)) return forbid(res);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const org = (await client.query('select * from organizations where id=$1 and deleted_at is null for update', [req.params.id])).rows[0];
    if (!org) { await client.query('rollback'); return res.status(404).json({ message: 'الجهة غير موجودة.' }); }
    
    const [pRes, prjRes, tRes, prdRes, fRes] = await Promise.all([
      client.query('select count(*)::int as cnt from profiles where org=$1 and deleted_at is null', [org.code]),
      client.query('select count(*)::int as cnt from projects where org=$1 and deleted_at is null and is_system=false', [org.code]),
      client.query('select count(*)::int as cnt from tasks where org=$1 and deleted_at is null', [org.code]),
      client.query('select count(*)::int as cnt from products where org=$1 and deleted_at is null', [org.code]),
      client.query('select count(*)::int as cnt from files where org=$1 and deleted_at is null', [org.code])
    ]);
    const deps = {
      users: pRes.rows[0].cnt,
      projects: prjRes.rows[0].cnt,
      tasks: tRes.rows[0].cnt,
      products: prdRes.rows[0].cnt,
      files: fRes.rows[0].cnt
    };
    const totalDeps = deps.users + deps.projects + deps.tasks + deps.products + deps.files;
    if (totalDeps > 0) {
      await client.query('rollback');
      return res.status(409).json({
        code: 'ORG_HAS_DEPENDENCIES',
        message: 'لا يمكن حذف هذه الجهة لوجود سجلات ومستخدمين مرتبطين بها. يمكنك تعطيل الجهة بدلاً من الحذف.',
        dependencies: deps,
        can_deactivate: true
      });
    }

    const { rows } = await client.query('update organizations set deleted_at=now(), is_active=false where id=$1 returning id, name, code', [req.params.id]);
    await writeAudit(client, req, `حذف جهة: ${org.name} (${org.code})`, 'DELETE', 'organizations', req.params.id);
    await client.query('commit');
    res.json({ success: true, deleted: rows[0] });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
});

app.get('/api/projects', requireActive, async (req, res, next) => {
  if (!canAny(req.user,'Projects.View','MainPlan.View','Plans.View','Tasks.View','Tasks.Create','Timeline.View','Calendar.View','Reports.View','Dashboard.View')) return forbid(res);
  try {
    const privileged = hasAllData(req.user);
    const includeSystem = req.query.include_system === 'true';
    const { rows } = await pool.query(
      `select p.*,
              coalesce(plans.cnt, 0)::int as plans_count,
              coalesce(plans.cnt, 0)::int as plan_items_count,
              coalesce(prds.cnt, 0)::int as products_count,
              coalesce(phases.cnt, 0)::int as phases_count,
              coalesce(tasks.cnt, 0)::int as tasks_count,
              coalesce(tasks.progress, 0)::int as progress,
              mgr.name as manager_name,
              mgr.email as manager_email
         from projects p
         left join profiles mgr on mgr.id = p.manager_id
         left join (
           select project_id, count(distinct coalesce(nullif(trim(track), ''), id::text)) as cnt
           from master_plan_items where deleted_at is null group by project_id
         ) plans on plans.project_id = p.id
         left join (
           select project_id, count(*) as cnt
           from products where deleted_at is null group by project_id
         ) prds on prds.project_id = p.id
         left join (
           select project_id, count(*) as cnt
           from master_plan_items
           where deleted_at is null
             and (item_type in ('مرحلة تنفيذ', 'معلم رئيسي', 'معلم اعتماد', 'مرحلة/خطة', 'مرحلة/مشروع') or lower(coalesce(item_type, '')) like '%مرحلة%' or lower(coalesce(item_type, '')) like '%معلم%')
           group by project_id
         ) phases on phases.project_id = p.id
         left join (
           select project_id, count(*) as cnt, round(avg(progress))::int as progress
           from tasks where deleted_at is null group by project_id
         ) tasks on tasks.project_id = p.id
        where p.deleted_at is null
          and (p.is_system = false or $5::boolean)
          and ($1::boolean or p.manager_id=$3
          or ($4='my_project' and p.manager_id=$3)
          or ($4 in ('my_team','my_department') and p.org=$2))
        order by coalesce(p.hierarchical_code, p.code)`,
      [privileged, req.user.org, req.user.id, req.user.data_scope || 'my_data', includeSystem]
    );
    res.json(rows);
  } catch (error) { next(error); }
});

app.get('/api/projects/:id/dependencies', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Projects.View', 'Projects.Delete', 'Projects.Edit')) return forbid(res);
  try {
    const deps = await projectHierarchyIO.getProjectDependencies(req.params.id, pool);
    res.json(deps);
  } catch (error) { next(error); }
});

app.post('/api/projects', requireActive, async (req, res, next) => {
  if (!can(req.user,'Projects.Create')) return forbid(res);
  const code = String(req.body.code || '').trim();
  const name = String(req.body.name || '').trim();
  if (!code || !name || code.length > 100 || name.length > 300) return invalid(res, 'رمز المشروع واسمه مطلوبان.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const countResult = await client.query('select count(*)::int as cnt from projects where is_system = false');
    const autoHCode = `PRJ-${String((countResult.rows[0].cnt || 0) + 1).padStart(3, '0')}`;
    const hierarchicalCode = String(req.body.hierarchical_code || '').trim() || (code.startsWith('PRJ-') ? code : autoHCode);

    const { rows } = await client.query(
      `insert into projects(code,hierarchical_code,name,description,objective,vision,mission,org,manager_id,planned_start,planned_end,status,budget,currency,source_notes,classification,created_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
      [code,hierarchicalCode,name,req.body.description || null,req.body.objective || null,req.body.vision || null,req.body.mission || null,
       req.body.org || 'wamy',req.body.manager_id || null,req.body.planned_start || null,req.body.planned_end || null,
       ['planning','active','on_hold','completed','cancelled'].includes(req.body.status) ? req.body.status : 'planning',
       req.body.budget || null,req.body.currency || null,req.body.source_notes || null,req.body.classification || null,req.user.id]
    );
    await writeAudit(client, req, 'إنشاء مشروع وخطة رئيسية', 'CREATE', 'projects', rows[0].id, { code, hierarchical_code: hierarchicalCode });
    await client.query('commit');
    res.status(201).json(rows[0]);
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505') return res.status(409).json({ code: 'DUPLICATE_PROJECT', message: 'رمز المشروع مستخدم مسبقًا.' });
    next(error);
  } finally { client.release(); }
});

app.delete('/api/projects/:id', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Projects.Delete')) return forbid(res);
  const checkProj = (await pool.query('select is_system from projects where id=$1 and deleted_at is null', [req.params.id])).rows[0];
  if (checkProj && checkProj.is_system) {
    return res.status(400).json({ code: 'SYSTEM_PROJECT_PROTECTED', message: 'لا يمكن حذف المشاريع النظامية للمهام المستقلة.' });
  }
  const force = req.query.force === 'true' || (req.body && req.body.force === true);
  const deps = await projectHierarchyIO.getProjectDependencies(req.params.id, pool);
  const hasDependencies = deps.tasks > 0 || deps.products > 0 || deps.plans > 0 || deps.files > 0;
  if (hasDependencies && !force) {
    return res.status(409).json({
      code: 'PROJECT_HAS_DEPENDENCIES',
      message: 'لا يمكن حذف المشروع لوجود بيانات تشغيلية أو تاريخية مرتبطة به. يرجى أرشفة المشروع بدلاً من الحذف للحفاظ على سجلات التنفيذ.',
      counts: deps,
      can_archive: true
    });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('update tasks set deleted_at=coalesce(deleted_at,now()) where project_id=$1 and deleted_at is null', [req.params.id]);
    await client.query('update products set deleted_at=coalesce(deleted_at,now()) where project_id=$1 and deleted_at is null', [req.params.id]);
    await client.query('update master_plan_items set deleted_at=coalesce(deleted_at,now()) where project_id=$1 and deleted_at is null', [req.params.id]);
    const { rows } = await client.query('update projects set deleted_at=now() where id=$1 and deleted_at is null and is_system=false returning id, name, code', [req.params.id]);
    if (!rows.length) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المشروع غير موجود أو أنه مشروع نظامي محمي.' });
    }
    await writeAudit(client, req, 'حذف مشروع', 'DELETE', 'projects', req.params.id, { name: rows[0].name, code: rows[0].code, deleted_dependencies: deps });
    await client.query('commit');
    res.json({ success: true, deleted: rows[0], dependencies: deps });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.post('/api/projects/:id/archive', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Projects.Edit')) return forbid(res);
  const checkProj = (await pool.query('select is_system from projects where id=$1 and deleted_at is null', [req.params.id])).rows[0];
  if (checkProj && checkProj.is_system) {
    return res.status(400).json({ code: 'SYSTEM_PROJECT_PROTECTED', message: 'لا يمكن أرشفة أو تعديل المشاريع النظامية للمهام المستقلة.' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`update projects set status='cancelled', updated_at=now() where id=$1 and deleted_at is null and is_system=false returning *`, [req.params.id]);
    if (!rows.length) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المشروع غير موجود.' });
    }
    await writeAudit(client, req, 'أرشفة مشروع', 'UPDATE', 'projects', req.params.id, { name: rows[0].name, code: rows[0].code });
    await client.query('commit');
    res.json(rows[0]);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.post('/api/projects/:id/activate', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Projects.Activate', 'Projects.Edit')) return forbid(res);
  const checkProj = (await pool.query('select is_system from projects where id=$1 and deleted_at is null', [req.params.id])).rows[0];
  if (checkProj && checkProj.is_system) {
    return res.status(400).json({ code: 'SYSTEM_PROJECT_PROTECTED', message: 'المشاريع النظامية نشطة دائمًا ولا يمكن تغيير حالتها يدويًا.' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`update projects set status='active', updated_at=now() where id=$1 and deleted_at is null and is_system=false returning *`, [req.params.id]);
    if (!rows.length) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المشروع غير موجود.' });
    }
    await writeAudit(client, req, 'تفعيل مشروع', 'UPDATE', 'projects', req.params.id, { name: rows[0].name, code: rows[0].code });
    await client.query('commit');
    res.json(rows[0]);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.post('/api/projects/:id/deactivate', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Projects.Deactivate', 'Projects.Edit', 'Projects.Archive')) return forbid(res);
  const checkProj = (await pool.query('select is_system from projects where id=$1 and deleted_at is null', [req.params.id])).rows[0];
  if (checkProj && checkProj.is_system) {
    return res.status(400).json({ code: 'SYSTEM_PROJECT_PROTECTED', message: 'لا يمكن تعطيل المشاريع النظامية للمهام المستقلة.' });
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`update projects set status='on_hold', updated_at=now() where id=$1 and deleted_at is null and is_system=false returning *`, [req.params.id]);
    if (!rows.length) {
      await client.query('rollback');
      return res.status(404).json({ message: 'المشروع غير موجود.' });
    }
    await writeAudit(client, req, 'تعطيل مشروع', 'UPDATE', 'projects', req.params.id, { name: rows[0].name, code: rows[0].code });
    await client.query('commit');
    res.json(rows[0]);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.patch('/api/projects/:id', requireActive, async (req, res, next) => {
  if (!can(req.user,'Projects.Edit')) return forbid(res);
  const allowed = ['code','hierarchical_code','name','description','objective','vision','mission','org','manager_id','planned_start','planned_end','status','budget','currency','source_notes','classification'];
  const query = updateStatement('projects', req.params.id, req.body, allowed);
  if (!query) return invalid(res, 'لا توجد حقول صالحة للتحديث.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = (await client.query('select * from projects where id=$1 and deleted_at is null for update', [req.params.id])).rows[0];
    if (!before) { await client.query('rollback'); return res.status(404).json({ message: 'المشروع غير موجود.' }); }
    if (before.is_system) {
      await client.query('rollback');
      return res.status(400).json({ code: 'SYSTEM_PROJECT_PROTECTED', message: 'لا يمكن تعديل المشاريع النظامية للمهام المستقلة.' });
    }
    if (!versionMatches(req, before)) { await client.query('rollback'); return versionConflict(res); }
    const rows = (await client.query(query)).rows;
    await writeAudit(client, req, 'تحديث الخطة الرئيسية', 'UPDATE', 'projects', req.params.id, { changed_fields: Object.keys(cleanObject(req.body, allowed)) });
    await client.query('commit');
    res.json(rows);
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

// -----------------------------------------------------------------------------
// Hierarchical Excel Templates, Exports, and Imports (Projects, Plans, Products, Phases)
// -----------------------------------------------------------------------------
const HIERARCHY_ENTITIES = ['projects', 'project-plans', 'project-products', 'project-phases'];

app.get('/api/templates/:entity', requireActive, async (req, res, next) => {
  const entity = req.params.entity;
  if (!HIERARCHY_ENTITIES.includes(entity)) return res.status(404).json({ message: 'النموذج غير موجود.' });
  if (!canAny(req.user, 'Projects.Create', 'Projects.Import', 'Projects.View', 'Plans.Create', 'Plans.Import', 'Products.Create')) return forbid(res);
  try {
    const buffer = await projectHierarchyIO.generateTemplate(entity, { pool, user: req.user });
    const filenameMap = {
      'projects': 'نموذج-المشاريع.xlsx',
      'project-plans': 'نموذج-خطط-المشاريع.xlsx',
      'project-products': 'نموذج-منتجات-المشاريع.xlsx',
      'project-phases': 'نموذج-مراحل-المشاريع.xlsx'
    };
    const filename = filenameMap[entity] || `${entity}-template.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${entity}-template.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (error) { next(error); }
});

app.get('/api/export/:entity', requireActive, async (req, res, next) => {
  const entity = req.params.entity;
  if (!HIERARCHY_ENTITIES.includes(entity)) return res.status(404).json({ message: 'نوع البيانات غير موجود.' });
  if (!canAny(req.user, 'Projects.View', 'Projects.Export', 'Reports.Export', 'Plans.Export')) return forbid(res);
  try {
    const buffer = await projectHierarchyIO.exportData(entity, { pool, user: req.user });
    const filenameMap = {
      'projects': 'تصدير-المشاريع.xlsx',
      'project-plans': 'تصدير-خطط-المشاريع.xlsx',
      'project-products': 'تصدير-منتجات-المشاريع.xlsx',
      'project-phases': 'تصدير-مراحل-المشاريع.xlsx'
    };
    const filename = filenameMap[entity] || `${entity}-export.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${entity}-export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(Buffer.from(buffer));
  } catch (error) { next(error); }
});

app.post('/api/import/:entity/preview', requireActive, upload.single('file'), async (req, res, next) => {
  const entity = req.params.entity;
  if (!HIERARCHY_ENTITIES.includes(entity)) return res.status(404).json({ message: 'نوع البيانات غير موجود.' });
  if (!canAny(req.user, 'Projects.Import', 'Plans.Import', 'Products.Create', 'Projects.Create')) return forbid(res);
  if (!req.file) return res.status(400).json({ message: 'يرجى اختيار ملف Excel بصيغة XLSX.' });
  try {
    const preview = await projectHierarchyIO.previewImport(entity, req.file.buffer, { pool, user: req.user });
    res.json(preview);
  } catch (error) {
    if (/zip|xlsx|central directory|invalid/i.test(error.message)) {
      return res.status(400).json({ message: 'تعذّرت قراءة الملف. تأكد من استخدام ملف Excel (XLSX) صالح.' });
    }
    next(error);
  }
});

app.post('/api/import/:entity/commit', requireActive, async (req, res, next) => {
  const entity = req.params.entity;
  if (!HIERARCHY_ENTITIES.includes(entity)) return res.status(404).json({ message: 'نوع البيانات غير موجود.' });
  if (!canAny(req.user, 'Projects.Import', 'Plans.Import', 'Products.Create', 'Projects.Create')) return forbid(res);
  try {
    const result = await projectHierarchyIO.commitImport(entity, req.body, { pool, user: req.user, req, writeAudit });
    res.status(201).json(result);
  } catch (error) { next(error); }
});


app.post('/api/master-plan-items', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Plans.Create')) return forbid(res);
  const body = req.body || {};
  if (!body.project_id || !body.title) return invalid(res, 'المشروع وعنوان البند مطلوبان.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const countRes = await client.query('select count(*)::int as cnt from master_plan_items where project_id=$1', [body.project_id]);
    const proj = (await client.query('select code, hierarchical_code from projects where id=$1', [body.project_id])).rows[0];
    const projHCode = (proj && (proj.hierarchical_code || proj.code)) || 'PRJ-001';
    const autoExternalId = `P${(proj && proj.code) || '1'}-ITEM-${(countRes.rows[0].cnt || 0) + 1}`;
    const autoHCode = `${projHCode}-PLN-01-PRD-${String((countRes.rows[0].cnt || 0) + 1).padStart(3, '0')}`;
    
    const { rows } = await client.query(
      `insert into master_plan_items(project_id, external_id, hierarchical_code, parent_external_id, item_type, track, phase, title, content, description, quantity, unit, responsible_org, planned_start, planned_end, duration, duration_unit, original_timing, recurrence, kpi, target, priority, baseline_status, import_notes)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning *`,
      [body.project_id, body.external_id || autoExternalId, body.hierarchical_code || autoHCode, body.parent_external_id || null,
       body.item_type || null, body.track || null, body.phase || null, body.title, body.content || null, body.description || null,
       body.quantity != null ? Number(body.quantity) : null, body.unit || null, body.responsible_org || 'wamy',
       body.planned_start || null, body.planned_end || null, body.duration != null ? Number(body.duration) : null,
       body.duration_unit || null, body.original_timing || null, body.recurrence || null, body.kpi || null, body.target || null,
       body.priority || 'normal', body.baseline_status || 'not_started', body.import_notes || null]
    );
    await writeAudit(client, req, 'إنشاء بند في خطة الأساس', 'CREATE', 'master_plan_items', rows[0].id);
    await client.query('commit');
    res.status(201).json(rows[0]);
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

app.patch('/api/master-plan-items/:id', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Plans.Edit')) return forbid(res);
  const allowed = ['external_id','hierarchical_code','parent_external_id','item_type','track','phase','title','content','description','quantity','unit','responsible_org','planned_start','planned_end','duration','duration_unit','original_timing','recurrence','kpi','target','priority','baseline_status','import_notes'];
  const query = updateStatement('master_plan_items', req.params.id, req.body, allowed);
  if (!query) return invalid(res, 'لا توجد حقول صالحة للتحديث.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(query);
    if (!rows.length) { await client.query('rollback'); return res.status(404).json({ message: 'بند الخطة غير موجود.' }); }
    await writeAudit(client, req, 'تعديل بند في خطة الأساس', 'UPDATE', 'master_plan_items', req.params.id);
    await client.query('commit');
    res.json(rows);
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

app.delete('/api/master-plan-items/:id', requireActive, async (req, res, next) => {
  if (!can(req.user, 'Plans.Archive') && !isAdmin(req.user)) return forbid(res);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query('update master_plan_items set deleted_at=now() where id=$1 and deleted_at is null returning id', [req.params.id]);
    if (!rows.length) { await client.query('rollback'); return res.status(404).json({ message: 'بند الخطة غير موجود.' }); }
    await writeAudit(client, req, 'حذف/أرشفة بند خطة أساس', 'DELETE', 'master_plan_items', req.params.id);
    await client.query('commit');
    res.json(rows);
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

app.get('/api/master-plan-items', requireActive, async (req, res, next) => {
  if (!canAny(req.user,'MainPlan.View','Plans.View','Tasks.View','Tasks.Create','Timeline.View','Reports.View')) return forbid(res);
  try {
    const privileged = hasAllData(req.user);
    const { rows } = await pool.query(
      `select i.* from master_plan_items i join projects p on p.id=i.project_id
        where i.deleted_at is null and p.deleted_at is null
          and ($1::boolean or p.manager_id=$3 or (($4 in ('my_team','my_department')) and p.org=$2))
        order by p.code,i.planned_start nulls last,i.external_id`,
      [privileged, req.user.org, req.user.id,req.user.data_scope || 'my_data']
    );
    res.json(rows);
  } catch (error) { next(error); }
});

function masterWorkbookRows(workbook) {
  const sheet = workbook.getWorksheet('الخطة الرئيسية') || workbook.getWorksheet('الخطة الزمنية الموحدة') || workbook.worksheets[0];
  if (!sheet) throw new Error('ملف الخطة الرئيسية لا يحتوي على ورقة بيانات.');
  const headers = MASTER_PLAN_HEADERS.map((_, index) => excelCellText(sheet.getRow(1).getCell(index + 1).value));
  if (MASTER_PLAN_HEADERS.some((header, index) => headers[index] !== header)) throw new Error('أعمدة الخطة الرئيسية لا تطابق القالب المعتمد ذي 24 عمودًا.');
  const definitions = {};
  const definitionSheet = workbook.getWorksheet('تعريف المشروع');
  if (definitionSheet) definitionSheet.eachRow((row, number) => {
    if (number > 1) definitions[String(excelCellText(row.getCell(1).value) || '').trim()] = excelCellText(row.getCell(2).value);
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const v = MASTER_PLAN_HEADERS.map((_, index) => excelCellText(row.getCell(index + 1).value));
    if (!v.some(value => value !== '')) return;
    const plannedStart = v[13] ? isoDate(v[13]) : null;
    const plannedEnd = v[14] ? isoDate(v[14]) : null;
    const priority = PRIORITY_LABELS.get(String(v[21] || 'عادية').trim().toLowerCase()) || 'normal';
    const status = TASK_STATUS_LABELS.get(String(v[22] || 'لم تبدأ').trim().toLowerCase()) || 'not_started';
    const errors = [];
    if (!String(v[0] || '').trim()) errors.push('معرف السجل مطلوب.');
    if (!String(v[2] || '').trim() || !String(v[3] || '').trim()) errors.push('رمز المشروع واسمه مطلوبان.');
    if (!String(v[7] || '').trim()) errors.push('اسم المنتج أو المخرج مطلوب.');
    if (v[13] && !plannedStart) errors.push('تاريخ البداية غير صالح.');
    if (v[14] && !plannedEnd) errors.push('تاريخ الاستحقاق غير صالح.');
    if (plannedStart && plannedEnd && plannedEnd < plannedStart) errors.push('تاريخ الاستحقاق يسبق تاريخ البداية.');
    rows.push({
      row_number: rowNumber, external_id: String(v[0] || '').trim(), parent_external_id: String(v[1] || '').trim() || null,
      project_code: String(v[2] || '').trim(), project_name: String(v[3] || '').trim(), item_type: String(v[4] || '').trim() || null,
      track: String(v[5] || '').trim() || null, phase: String(v[6] || '').trim() || null, title: String(v[7] || '').trim(),
      content: String(v[8] || '').trim() || null, description: String(v[9] || '').trim() || null,
      quantity: v[10] === '' ? null : Number(v[10]), unit: String(v[11] || '').trim() || null,
      responsible_org: String(v[12] || '').trim() || null, planned_start: plannedStart, planned_end: plannedEnd,
      duration: v[15] === '' ? null : Number(v[15]), duration_unit: String(v[16] || '').trim() || null,
      original_timing: String(v[17] || '').trim() || null, recurrence: String(v[18] || '').trim() || null,
      kpi: String(v[19] || '').trim() || null, target: String(v[20] || '').trim() || null,
      priority, baseline_status: status, import_notes: String(v[23] || '').trim() || null,
      valid: errors.length === 0, errors
    });
  });
  return { sheet: sheet.name, definitions, rows };
}

function excelSerialDate(value) {
  if (value instanceof Date) return isoDate(value);
  if (/^\d+(?:\.\d+)?$/.test(String(value || '')) && Number(value) > 20000) {
    return new Date((Number(value) - 25569) * 86400000).toISOString().slice(0, 10);
  }
  return isoDate(value);
}

function masterRawWorkbookRows(workbook) {
  const sheet = workbook.getWorksheet('الخطة الرئيسية') || workbook.getWorksheet('الخطة الزمنية الموحدة') || workbook.sheets[0];
  if (!sheet) throw new Error('ملف الخطة الرئيسية لا يحتوي على ورقة بيانات.');
  const headers = sheet.rows[0] || [];
  if (MASTER_PLAN_HEADERS.some((header, index) => headers[index] !== header)) throw new Error('أعمدة الخطة الرئيسية لا تطابق القالب المعتمد ذي 24 عمودًا.');
  const definitions = {};
  const definitionSheet = workbook.getWorksheet('تعريف المشروع');
  if (definitionSheet) definitionSheet.rows.slice(1).forEach(row => { if (row && row[0]) definitions[String(row[0]).trim()] = row[1] || ''; });
  const rows = sheet.rows.slice(1).map((values, offset) => {
    values = values || [];
    const plannedStart = values[13] ? excelSerialDate(values[13]) : null;
    const plannedEnd = values[14] ? excelSerialDate(values[14]) : null;
    const errors = [];
    if (!String(values[0] || '').trim()) errors.push('معرف السجل مطلوب.');
    if (!String(values[2] || '').trim() || !String(values[3] || '').trim()) errors.push('رمز المشروع واسمه مطلوبان.');
    if (!String(values[7] || '').trim()) errors.push('اسم المنتج أو المخرج مطلوب.');
    if (values[13] && !plannedStart) errors.push('تاريخ البداية غير صالح.');
    if (values[14] && !plannedEnd) errors.push('تاريخ الاستحقاق غير صالح.');
    if (plannedStart && plannedEnd && plannedEnd < plannedStart) errors.push('تاريخ الاستحقاق يسبق تاريخ البداية.');
    return {
      row_number: offset + 2, external_id: String(values[0] || '').trim(), parent_external_id: String(values[1] || '').trim() || null,
      project_code: String(values[2] || '').trim(), project_name: String(values[3] || '').trim(), item_type: String(values[4] || '').trim() || null,
      track: String(values[5] || '').trim() || null, phase: String(values[6] || '').trim() || null, title: String(values[7] || '').trim(),
      content: String(values[8] || '').trim() || null, description: String(values[9] || '').trim() || null,
      quantity: values[10] === '' || values[10] == null ? null : Number(values[10]), unit: String(values[11] || '').trim() || null,
      responsible_org: String(values[12] || '').trim() || null, planned_start: plannedStart, planned_end: plannedEnd,
      duration: values[15] === '' || values[15] == null ? null : Number(values[15]), duration_unit: String(values[16] || '').trim() || null,
      original_timing: String(values[17] || '').trim() || null, recurrence: String(values[18] || '').trim() || null,
      kpi: String(values[19] || '').trim() || null, target: String(values[20] || '').trim() || null,
      priority: PRIORITY_LABELS.get(String(values[21] || 'عادية').trim().toLowerCase()) || 'normal',
      baseline_status: TASK_STATUS_LABELS.get(String(values[22] || 'لم تبدأ').trim().toLowerCase()) || 'not_started',
      import_notes: String(values[23] || '').trim() || null, valid: errors.length === 0, errors
    };
  }).filter(row => row.external_id || row.title || row.project_code);
  return { sheet: sheet.name, definitions, rows };
}

app.post('/api/master-plans/preview', requireActive, upload.single('file'), async (req, res, next) => {
  if (!can(req.user,'Plans.Import')) return forbid(res);
  if (!req.file) return invalid(res, 'اختر ملف Excel أولًا.');
  try {
    let parsed;
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      parsed = masterWorkbookRows(workbook);
    } catch (excelError) {
      parsed = masterRawWorkbookRows(await readRawWorkbook(req.file.buffer));
    }
    if (!parsed.rows.length || parsed.rows.length > 2000) return invalid(res, 'يجب أن تحتوي الخطة على 1 إلى 2000 بند.');
    res.json({ format: 'wamy_master_plan_v1', ...parsed, summary: {
      total: parsed.rows.length, valid: parsed.rows.filter(row => row.valid).length,
      invalid: parsed.rows.filter(row => !row.valid).length,
      projects: new Set(parsed.rows.map(row => row.project_code)).size
    } });
  } catch (error) {
    if (/أعمدة|ورقة|zip|xlsx|invalid/i.test(error.message)) return invalid(res, error.message);
    next(error);
  }
});

app.post('/api/master-plans/import', requireActive, async (req, res, next) => {
  if (!can(req.user,'Plans.Import')) return forbid(res);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 2000 || rows.some(row => !row.valid)) return invalid(res, 'بيانات الخطة الرئيسية غير صالحة.');
  const definitions = req.body.definitions || {};
  const client = await pool.connect();
  try {
    await client.query('begin');
    const projects = new Map();
    for (const row of rows) {
      if (projects.has(row.project_code)) continue;
      const description = definitions['وصف المشروع'] || null;
      const result = await client.query(
        `insert into projects(code,name,description,objective,vision,mission,org,status,budget,currency,source_notes,created_by)
         values($1,$2,$3,$4,$5,$6,'wamy','active',$7,$8,$9,$10)
         on conflict(code) do update set name=excluded.name,
           description=coalesce(excluded.description,projects.description),updated_at=now()
         returning id`,
        [row.project_code,row.project_name,description,definitions['الهدف العام'] || definitions['الهدف'] || null,
         definitions['الرؤية'] || null,definitions['الرسالة'] || null,
         Number(definitions['الميزانية التقديرية']) || null,definitions['العملة'] || null,
         definitions['التاريخ/المدة'] || definitions['مدة المشروع'] || null,req.user.id]
      );
      projects.set(row.project_code, result.rows[0].id);
    }
    let inserted = 0; let updated = 0;
    for (const row of rows) {
      const result = await client.query(
        `insert into master_plan_items(project_id,external_id,parent_external_id,item_type,track,phase,title,content,description,
          quantity,unit,responsible_org,planned_start,planned_end,duration,duration_unit,original_timing,recurrence,kpi,target,priority,baseline_status,import_notes)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         on conflict(project_id,external_id) do update set parent_external_id=excluded.parent_external_id,item_type=excluded.item_type,
          track=excluded.track,phase=excluded.phase,title=excluded.title,content=excluded.content,description=excluded.description,
          quantity=excluded.quantity,unit=excluded.unit,responsible_org=excluded.responsible_org,
          planned_start=excluded.planned_start,planned_end=excluded.planned_end,duration=excluded.duration,
          duration_unit=excluded.duration_unit,original_timing=excluded.original_timing,recurrence=excluded.recurrence,
          kpi=excluded.kpi,target=excluded.target,priority=excluded.priority,baseline_status=excluded.baseline_status,
          import_notes=excluded.import_notes,deleted_at=null,updated_at=now()
         returning (xmax=0) as inserted`,
        [projects.get(row.project_code),row.external_id,row.parent_external_id,row.item_type,row.track,row.phase,row.title,row.content,row.description,
         Number.isFinite(row.quantity) ? row.quantity : null,row.unit,row.responsible_org,row.planned_start,row.planned_end,
         Number.isFinite(row.duration) ? row.duration : null,row.duration_unit,row.original_timing,row.recurrence,row.kpi,row.target,
         row.priority,row.baseline_status,row.import_notes]
      );
      if (result.rows[0].inserted) inserted += 1; else updated += 1;
    }
    for (const projectId of projects.values()) {
      await client.query(
        `update projects p set
           planned_start=coalesce((select min(planned_start) from master_plan_items where project_id=p.id and deleted_at is null),p.planned_start),
           planned_end=coalesce((select max(planned_end) from master_plan_items where project_id=p.id and deleted_at is null),p.planned_end)
         where p.id=$1`, [projectId]
      );
    }
    await writeAudit(client, req, `استيراد الخطة الرئيسية: ${inserted} جديد و${updated} محدث`, 'CREATE', 'projects', null,
      { projects: [...projects.keys()], inserted, updated });
    await client.query('commit');
    res.status(201).json({ projects: projects.size, inserted, updated });
  } catch (error) { await client.query('rollback'); next(error); } finally { client.release(); }
});

app.get('/api/alerts', requireActive, async (req, res, next) => {
  if (!canAny(req.user,'Dashboard.View','MainPlan.View','Tasks.View')) return forbid(res);
  try {
    const privileged = hasAllData(req.user);
    const { rows } = await pool.query(
      `select t.id,t.title,t.status,t.progress,t.due_date,t.scheduled_due_at,t.assignee_id,t.project_id,
              p.name as project_name,i.planned_start as baseline_start,i.planned_end as baseline_end
         from tasks t left join projects p on p.id=t.project_id left join master_plan_items i on i.id=t.plan_item_id
        where t.deleted_at is null and ($1::boolean or t.assignee_id=$2 or exists(select 1 from task_assignees ta where ta.task_id=t.id and ta.user_id=$2))`,
      [privileged, req.user.id]
    );
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const alerts = [];
    for (const task of rows) {
      if (['completed','approved'].includes(task.status)) continue;
      const due = task.scheduled_due_at ? new Date(task.scheduled_due_at)
        : task.due_date ? new Date(`${task.due_date}T00:00:00Z`) : null;
      const baselineEnd = task.baseline_end ? new Date(`${task.baseline_end}T00:00:00Z`) : null;
      const days = due ? Math.ceil((due - today) / 86400000) : null;
      const varianceDays = due && baselineEnd ? Math.round((due - baselineEnd) / 86400000) : 0;
      if (days != null && days < 0) alerts.push({ id: `overdue-${task.id}`, task_id: task.id, project_id: task.project_id,
        severity: 'critical', type: 'overdue', title: task.title, project_name: task.project_name, days: Math.abs(days), message: `متأخرة ${Math.abs(days)} يومًا` });
      else if (days != null && days <= 7) alerts.push({ id: `due-${task.id}`, task_id: task.id, project_id: task.project_id,
        severity: 'warning', type: 'due_soon', title: task.title, project_name: task.project_name, days, message: `تستحق خلال ${days} يوم` });
      if (varianceDays > 0) alerts.push({ id: `variance-${task.id}`, task_id: task.id, project_id: task.project_id,
        severity: 'warning', type: 'schedule_variance', title: task.title, project_name: task.project_name, days: varianceDays,
        message: `انحراف ${varianceDays} يومًا عن الخطة الرئيسية` });
    }
    res.json(alerts.sort((a,b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1)));
  } catch (error) { next(error); }
});

function crudRoutes(name, table, orderBy, authorizeCreate, authorizeUpdate, authorizeDelete, forcedCreate = () => ({})) {
  app.get(`/api/${name}`, requireActive, async (req, res, next) => {
    const viewPermissions = {
      products: ['Products.View','Tasks.View','Tasks.Create','Timeline.View','Calendar.View','Files.View','Reports.View','Dashboard.View'],
      tasks: ['Tasks.View','Timeline.View','Calendar.View','Reports.View','Dashboard.View'],
      files: ['Files.View','Dashboard.View']
    }[name];
    if (viewPermissions && !canAny(req.user,...viewPermissions)) return forbid(res);
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const privileged = hasAllData(req.user);
    const scoped = name === 'tasks'
      ? `(assignee_id=$4 or exists(select 1 from task_assignees ta where ta.task_id=tasks.id and ta.user_id=$4)
          or ($8::text='my_project' and exists(select 1 from projects pr where pr.id=tasks.project_id and pr.manager_id=$4))
          or ($8::text='my_department' and $6::text is not null and exists(select 1 from task_assignees ta join profiles ap on ap.id=ta.user_id where ta.task_id=tasks.id and ap.org=$5 and ap.department=$6::text))
          or ($8::text='my_team' and $7::text is not null and exists(select 1 from task_assignees ta join profiles ap on ap.id=ta.user_id where ta.task_id=tasks.id and ap.org=$5 and ap.team=$7::text)))`
      : name === 'files'
        ? `(uploader_id=$4 or ($8::text='my_department' and $6::text is not null and exists(select 1 from profiles ap where ap.id=uploader_id and ap.org=$5 and ap.department=$6::text)) or ($8::text='my_team' and $7::text is not null and exists(select 1 from profiles ap where ap.id=uploader_id and ap.org=$5 and ap.team=$7::text)))`
        : `(manager_id=$4 or (($8::text in ('my_department','my_team')) and org=$5) or ($6::text is null and $7::text is null and false))`;
    const extra = name === 'tasks'
      ? `,coalesce((select array_agg(ta.user_id order by ta.assigned_at) from task_assignees ta where ta.task_id=tasks.id),'{}'::uuid[]) as assignee_ids`
      : '';
    try {
      res.json((await pool.query(
        `select * ${extra} from ${table} where deleted_at is null and ($3::boolean or ${scoped}) order by ${orderBy} limit $1 offset $2`,
        [limit,offset,privileged,req.user.id,req.user.org,req.user.department,req.user.team,req.user.data_scope || 'my_data']
      )).rows);
    } catch (error) { next(error); }
  });
  app.post(`/api/${name}`, requireActive, async (req, res, next) => {
    req.body = req.body || {};
    let assigneeIds = null;
    let scheduleChangeReason = null;
    if (name === 'tasks' && Object.prototype.hasOwnProperty.call(req.body, 'schedule_change_reason')) {
      scheduleChangeReason = String(req.body.schedule_change_reason || '').trim().slice(0, 1000) || null;
      req.body = { ...req.body };
      delete req.body.schedule_change_reason;
    }
    if (name === 'tasks' && Object.prototype.hasOwnProperty.call(req.body, 'assignee_ids')) {
      assigneeIds = [...new Set(req.body.assignee_ids || [])];
      if (!Array.isArray(req.body.assignee_ids) || assigneeIds.length > 50 || assigneeIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
        return invalid(res, 'قائمة المسؤولين غير صالحة.');
      }
      req.body = { ...req.body, assignee_id: assigneeIds[0] || null };
      delete req.body.assignee_ids;
    }
    if (!(await authorizeCreate(req))) return forbid(res);
    const validationError = validatePatch(name, req.body, true);
    if (validationError) return invalid(res, validationError);
    const ignorablePostFields = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
    if (Object.keys(req.body).some(key => !FIELDS[name].includes(key) && !ignorablePostFields.has(key)) && !isAdmin(req.user)) {
      return invalid(res, 'يتضمن الطلب حقولًا غير مسموحة.');
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (name === 'products') {
        if (!req.body.project_id) {
          const defaultProject = (await client.query(
            `select id from projects where deleted_at is null and is_system = false and status in ('active','planning') order by (case when code in ('STR-COMM-01','PRJ-001') then 0 else 1 end), created_at limit 1`
          )).rows[0];
          if (defaultProject) req.body.project_id = defaultProject.id;
        }
        if (!req.body.hierarchical_code && req.body.project_id) {
          const proj = (await client.query('select code, hierarchical_code from projects where id=$1', [req.body.project_id])).rows[0];
          const projHCode = (proj && (proj.hierarchical_code || proj.code)) || 'PRJ-001';
          const countProd = (await client.query('select count(*)::int as cnt from products where project_id=$1', [req.body.project_id])).rows[0].cnt || 0;
          req.body.hierarchical_code = `${projHCode}-PLN-01-PRD-${String(countProd + 1).padStart(3, '0')}`;
        }
        if (!req.body.legacy_code && req.body.code) {
          req.body.legacy_code = req.body.code;
        }
      }
      if (name === 'tasks') {
        if (req.body.task_mode === 'adhoc') {
          const orgCode = req.body.org || req.user.org || 'wamy';
          const sysProj = await getOrCreateAdhocSystemProject(client, orgCode, req.user.id);
          req.body.project_id = sysProj.id;
          req.body.task_mode = 'adhoc';
          req.body.plan_item_id = null;
          req.body.product_id = null;
        } else {
          req.body.task_mode = 'structured';
        }
      }
      if (name === 'tasks' && assigneeIds && assigneeIds.length) {
        const active = await client.query('select id from profiles where id=any($1::uuid[]) and status=\'active\' and org=$2 and deleted_at is null', [assigneeIds,req.body.org]);
        if (active.rowCount !== assigneeIds.length) { await client.query('rollback'); return invalid(res, 'يمكن الإسناد فقط إلى مستخدمين نشطين مرتبطين بجهة المشروع.'); }
      }
      const row = (await client.query(insertStatement(table, req.body, FIELDS[name], forcedCreate(req)))).rows[0];
      if (name === 'tasks') {
        for (const userId of assigneeIds || (row.assignee_id ? [row.assignee_id] : [])) {
          await client.query('insert into task_assignees(task_id,user_id,assigned_by) values($1,$2,$3) on conflict do nothing', [row.id,userId,req.user.id]);
        }
        const baseline = row.plan_item_id ? (await client.query(
          `select (planned_start::date + time '09:00') at time zone 'Asia/Riyadh' as baseline_start,
                  (planned_end::date + time '17:00') at time zone 'Asia/Riyadh' as baseline_due
             from master_plan_items where id=$1`, [row.plan_item_id])).rows[0] : null;
        await client.query(
          `insert into task_schedule_history(task_id,baseline_start_at,baseline_due_at,new_start_at,new_due_at,change_reason,changed_by,changed_by_name)
           values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.id,baseline && baseline.baseline_start,baseline && baseline.baseline_due,row.scheduled_start_at,row.scheduled_due_at,
           scheduleChangeReason || 'التزمين المعتمد عند إنشاء المهمة',req.user.id,req.user.name]
        );
      }
      await writeAudit(client, req, `إنشاء ${name}`, name === 'files' ? 'UPLOAD' : 'CREATE', table, row.id);
      await client.query('commit');
      res.status(201).json(row);
    } catch (error) {
      await client.query('rollback');
      next(error);
    } finally { client.release(); }
  });
  app.patch(`/api/${name}/:id`, requireActive, async (req, res, next) => {
    req.body = req.body || {};
    let assigneeIds = null;
    let scheduleChangeReason = null;
    if (name === 'tasks' && Object.prototype.hasOwnProperty.call(req.body, 'schedule_change_reason')) {
      scheduleChangeReason = String(req.body.schedule_change_reason || '').trim().slice(0, 1000) || 'تعديل تزمين المهمة';
      req.body = { ...req.body };
      delete req.body.schedule_change_reason;
    }
    if (name === 'tasks' && Object.prototype.hasOwnProperty.call(req.body, 'assignee_ids')) {
      if (!can(req.user, 'Tasks.Assign')) return forbid(res);
      assigneeIds = [...new Set(req.body.assignee_ids || [])];
      if (!Array.isArray(req.body.assignee_ids) || assigneeIds.length > 50 || assigneeIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
        return invalid(res, 'قائمة المسؤولين غير صالحة.');
      }
      req.body = { ...req.body, assignee_id: assigneeIds[0] || null };
      delete req.body.assignee_ids;
    }
    if (!(await authorizeUpdate(req))) return forbid(res);
    const validationError = validatePatch(name, req.body);
    if (validationError) return invalid(res, validationError);
    let allowed = FIELDS[name];
    const patch = { ...req.body };
    if (name === 'tasks' && !can(req.user, 'Tasks.Edit')) {
      allowed = ['status', 'progress', 'notes', 'actual_completion'];
    }
    if (name === 'files') {
      if (!can(req.user,'Files.Approve')) allowed = ['name', 'version', 'status'];
      if (patch.status === 'approved' || patch.folder === 'approved') {
        if (!can(req.user,'Files.Approve')) return forbid(res);
        patch.status = 'approved'; patch.folder = 'approved';
        patch.approved_by = req.user.id; patch.approved_at = new Date().toISOString();
      } else {
        delete patch.approved_by; delete patch.approved_at;
      }
    }
    const ignorableFields = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);
    const attempted = Object.keys(req.body).filter(key => !allowed.includes(key) && !ignorableFields.has(key));
    if (attempted.length && !isAdmin(req.user)) return forbid(res);
    const query = updateStatement(table, req.params.id, patch, allowed);
    if (!query) return res.status(400).json({ message: 'لا توجد حقول صالحة للتحديث.' });
    const client = await pool.connect();
    try {
      await client.query('begin');
      const before = (await client.query(
        `select updated_at,${allowed.join(',')} from ${table} where id=$1 and deleted_at is null for update`, [req.params.id]
      )).rows[0];
      if (name === 'tasks' && assigneeIds && assigneeIds.length) {
        const taskOrg = patch.org || (before && before.org);
        const active = await client.query('select id from profiles where id=any($1::uuid[]) and status=\'active\' and org=$2 and deleted_at is null', [assigneeIds,taskOrg]);
        if (active.rowCount !== assigneeIds.length) { await client.query('rollback'); return invalid(res, 'يمكن الإسناد فقط إلى مستخدمين نشطين مرتبطين بجهة المشروع.'); }
      }
      if (before && !versionMatches(req, before)) {
        await client.query('rollback');
        return versionConflict(res);
      }
      if (name === 'tasks' && patch.project_id && before && before.project_id && patch.project_id !== before.project_id) {
        const targetProj = (await client.query('select is_system, org, name from projects where id=$1 and deleted_at is null', [patch.project_id])).rows[0];
        if (targetProj && !targetProj.is_system) {
          patch.task_mode = 'structured';
        }
      }
      const finalQuery = updateStatement(table, req.params.id, patch, allowed);
      const { rows } = await client.query(finalQuery || query);
      if (!rows.length) {
        await client.query('rollback');
        return res.status(404).json({ message: 'العنصر غير موجود.' });
      }
      if (name === 'tasks' && assigneeIds) {
        await client.query('delete from task_assignees where task_id=$1', [req.params.id]);
        for (const userId of assigneeIds) {
          await client.query('insert into task_assignees(task_id,user_id,assigned_by) values($1,$2,$3)', [req.params.id,userId,req.user.id]);
        }
      }
      const scheduleChanged = name === 'tasks'
        && (Object.prototype.hasOwnProperty.call(patch, 'scheduled_start_at') || Object.prototype.hasOwnProperty.call(patch, 'scheduled_due_at'))
        && (new Date(before.scheduled_start_at || 0).getTime() !== new Date(rows[0].scheduled_start_at || 0).getTime()
          || new Date(before.scheduled_due_at || 0).getTime() !== new Date(rows[0].scheduled_due_at || 0).getTime());
      if (scheduleChanged) {
        const baseline = rows[0].plan_item_id ? (await client.query(
          `select (planned_start::date + time '09:00') at time zone 'Asia/Riyadh' as baseline_start,
                  (planned_end::date + time '17:00') at time zone 'Asia/Riyadh' as baseline_due from master_plan_items where id=$1`, [rows[0].plan_item_id])).rows[0] : null;
        await client.query(
          `insert into task_schedule_history(task_id,baseline_start_at,baseline_due_at,previous_start_at,previous_due_at,new_start_at,new_due_at,change_reason,changed_by,changed_by_name)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [rows[0].id,baseline && baseline.baseline_start,baseline && baseline.baseline_due,before.scheduled_start_at,before.scheduled_due_at,
           rows[0].scheduled_start_at,rows[0].scheduled_due_at,scheduleChangeReason || 'تعديل تزمين المهمة',req.user.id,req.user.name]
        );
      }
      const changedFields = Object.keys(cleanObject(patch, allowed));
      const auditAction = name === 'tasks' && patch.project_id && before && before.project_id && patch.project_id !== before.project_id
        ? 'ربط مهمة بمشروع معتمد'
        : patch.status === 'approved' ? 'APPROVAL' : 'UPDATE';
      await writeAudit(client, req, auditAction === 'APPROVAL' || auditAction === 'UPDATE' ? `تحديث ${name}` : auditAction, patch.status === 'approved' ? 'APPROVAL' : 'UPDATE', table, rows[0].id, {
        changed_fields: changedFields,
        before: Object.fromEntries(changedFields.map(key => [key, before && before[key]])),
        after: Object.fromEntries(changedFields.map(key => [key, rows[0][key]]))
      });
      await client.query('commit');
      res.json(rows);
    } catch (error) {
      await client.query('rollback');
      next(error);
    } finally { client.release(); }
  });
  app.delete(`/api/${name}/:id`, requireActive, async (req, res, next) => {
    if (!(await authorizeDelete(req))) return forbid(res);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(`update ${table} set deleted_at=now() where id=$1 and deleted_at is null returning id`, [req.params.id]);
      if (!rows.length) {
        await client.query('rollback');
        return res.status(404).json({ message: 'العنصر غير موجود.' });
      }
      if (name === 'products') {
        await client.query('update tasks set deleted_at=coalesce(deleted_at,now()) where product_id=$1', [req.params.id]);
        await client.query('update files set deleted_at=coalesce(deleted_at,now()) where product_id=$1', [req.params.id]);
      }
      await writeAudit(client, req, `أرشفة ${name}`, 'DELETE', table, req.params.id);
      await client.query('commit');
      res.json(rows);
    } catch (error) {
      await client.query('rollback');
      next(error);
    } finally { client.release(); }
  });
}

async function productAcceptsTask(productId, excludeTaskId = null, user = null) {
  if (!productId) return true;
  if (isAdmin(user)) return true;
  const { rows } = await pool.query(
    `select p.is_active,p.status,p.allow_multiple_tasks,
            exists(select 1 from tasks t where t.product_id=p.id and t.deleted_at is null and ($2::uuid is null or t.id<>$2::uuid)) as has_task
       from products p where p.id=$1 and p.deleted_at is null`,
    [productId, excludeTaskId]
  );
  const product = rows[0];
  return Boolean(product && product.is_active && !['cancelled','archived'].includes(product.status)
    && (product.allow_multiple_tasks || !product.has_task));
}

async function normalizeTaskPlanLink(req) {
  if (!req.body) return true;
  const isPrivileged = req.user && (
    isAdmin(req.user) ||
    isSupervisor(req.user) ||
    String(req.user.role || '').toLowerCase() === 'admin' ||
    String(req.user.role || '').toLowerCase() === 'supervisor' ||
    hasAllData(req.user) ||
    can(req.user, 'Tasks.Edit') ||
    can(req.user, 'Tasks.Assign') ||
    can(req.user, 'Tasks.Create')
  );
  if (req.body.project_id) {
    const proj = (await pool.query('select id, org from projects where id=$1 and deleted_at is null', [req.body.project_id])).rows[0];
    if (!proj) return false;
    if (!hasAllData(req.user) && !isPrivileged && proj.org !== req.user.org) return false;
    if (!isPrivileged || !req.body.org) {
      req.body.org = proj.org;
    }
  }
  if (req.body.plan_item_id) {
    const item = (await pool.query(
      `select i.project_id,p.org from master_plan_items i join projects p on p.id=i.project_id
        where i.id=$1 and i.deleted_at is null and p.deleted_at is null`, [req.body.plan_item_id]
    )).rows[0];
    if (!item || (req.body.project_id && req.body.project_id !== item.project_id)) return false;
    if (!hasAllData(req.user) && !isPrivileged && item.org !== req.user.org) return false;
    req.body.project_id = item.project_id;
    if (!isPrivileged || !req.body.org) {
      req.body.org = item.org;
    }
  }
  return true;
}

async function canAccessTask(user, taskId) {
  if (hasAllData(user)) return true;
  const { rowCount } = await pool.query(
    `select 1 from tasks t where t.id=$1 and t.deleted_at is null and (
       t.assignee_id=$2 or exists(select 1 from task_assignees ta where ta.task_id=t.id and ta.user_id=$2)
       or ($6::text='my_project' and exists(select 1 from projects pr where pr.id=t.project_id and pr.manager_id=$2))
       or ($6::text='my_department' and $4::text is not null and exists(select 1 from task_assignees ta join profiles ap on ap.id=ta.user_id where ta.task_id=t.id and ap.org=$3 and ap.department=$4::text))
       or ($6::text='my_team' and $5::text is not null and exists(select 1 from task_assignees ta join profiles ap on ap.id=ta.user_id where ta.task_id=t.id and ap.org=$3 and ap.team=$5::text))
     )`,
    [taskId,user.id,user.org,user.department,user.team,user.data_scope || 'my_data']
  );
  return rowCount > 0;
}

crudRoutes('products', 'products', 'code',
  req => can(req.user,'Products.Create'),
  req => can(req.user,'Products.Edit'),
  req => can(req.user,'Products.Delete'));

crudRoutes('tasks', 'tasks', 'due_date nulls last',
  async req => {
    const body = req.body || {};
    if (!can(req.user,'Tasks.Create') || !can(req.user,'Tasks.Assign') || !(await productAcceptsTask(body.product_id, null, req.user)) || !(await normalizeTaskPlanLink(req))) return false;
    if (hasAllData(req.user) || (req.user && (
      isAdmin(req.user) ||
      isSupervisor(req.user) ||
      String(req.user.role || '').toLowerCase() === 'admin' ||
      String(req.user.role || '').toLowerCase() === 'supervisor' ||
      can(req.user, 'Tasks.Create') ||
      can(req.user, 'Tasks.Assign') ||
      can(req.user, 'Tasks.Edit')
    ))) return true;
    const product = body.product_id
      ? (await pool.query('select org from products where id=$1 and deleted_at is null', [body.product_id])).rows[0] : null;
    return body.org === req.user.org && (!product || product.org === req.user.org);
  },
  async req => {
    const body = req.body || {};
    if ((body.product_id && !(await productAcceptsTask(body.product_id, req.params.id, req.user))) || !(await normalizeTaskPlanLink(req))) return false;
    const { rows } = await pool.query('select assignee_id,org from tasks where id=$1 and deleted_at is null', [req.params.id]);
    if (!rows[0]) return false;
    const operational = Object.keys(body).every(key => ['status','progress','notes','actual_completion','schedule_change_reason'].includes(key));
    const actionAllowed = operational
      ? (body.status === 'approved' ? can(req.user,'Tasks.Approve') : body.status === 'completed' ? can(req.user,'Tasks.Complete') : can(req.user,'Tasks.Start'))
      : can(req.user,'Tasks.Edit');
    if (!actionAllowed) return false;
    return canAccessTask(req.user, req.params.id);
  },
  async req => can(req.user,'Tasks.Delete') && await canAccessTask(req.user, req.params.id),
  req => ({ created_by: req.user.id }));

app.get('/api/tasks/:id/schedule-history', requireActive, async (req, res, next) => {
  try {
    if (!can(req.user,'Tasks.View')) return forbid(res);
    const allowed = await canAccessTask(req.user, req.params.id);
    if (!allowed) return forbid(res);
    const { rows } = await pool.query('select * from task_schedule_history where task_id=$1 order by changed_at desc', [req.params.id]);
    res.json(rows);
  } catch (error) { next(error); }
});

crudRoutes('files', 'files', 'created_at desc',
  async req => {
    if (!can(req.user,'Files.Upload')) return false;
    if (!req.body.product_id || hasAllData(req.user)) return true;
    const product = (await pool.query('select org from products where id=$1 and deleted_at is null', [req.body.product_id])).rows[0];
    return Boolean(product && product.org === req.user.org);
  },
  async req => {
    const { rows } = await pool.query('select uploader_id,org from files where id=$1 and deleted_at is null', [req.params.id]);
    if (!rows[0]) return false;
    if (req.body.status === 'approved' || req.body.folder === 'approved') return can(req.user,'Files.Approve') && (hasAllData(req.user) || rows[0].org === req.user.org);
    return can(req.user,'Files.Edit') && (hasAllData(req.user) || rows[0].uploader_id === req.user.id);
  },
  async req => {
    if (!can(req.user,'Files.Delete')) return false;
    if (hasAllData(req.user)) return true;
    const { rows } = await pool.query('select uploader_id from files where id=$1', [req.params.id]);
    return rows[0] && rows[0].uploader_id === req.user.id;
  },
  req => ({ uploader_id: req.user.id, org: req.user.org }));

app.get('/api/plans/template', requireActive, async (req, res, next) => {
  if (!canAny(req.user,'Plans.Create','Plans.Export')) return forbid(res);
  try {
    const [{ rows: products }, { rows: users }] = await Promise.all([
      pool.query(`select p.code,p.name from products p
                  where p.deleted_at is null and p.is_active=true and p.status not in ('completed','approved','cancelled','archived')
                    and (p.allow_multiple_tasks or not exists (select 1 from tasks t where t.product_id=p.id and t.deleted_at is null))
                  order by p.code`),
      pool.query(`select name,email from profiles where deleted_at is null and status='active' order by name`)
    ]);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WAMY Media Project Planner';
    const sheet = workbook.addWorksheet('نموذج الخطة', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المنتج', key: 'product_code', width: 18 },
      { header: 'اسم المنتج', key: 'product_name', width: 38 },
      { header: 'اسم المرحلة', key: 'phase_name', width: 24 },
      { header: 'اسم المهمة', key: 'title', width: 40 },
      { header: 'وصف المهمة', key: 'description', width: 48 },
      { header: 'الجهة المسؤولة', key: 'org', width: 20 },
      { header: 'بريد المسؤول', key: 'assignee_email', width: 30 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 18 },
      { header: 'تاريخ الاستحقاق', key: 'due_date', width: 18 },
      { header: 'المدة بالأيام', key: 'active_duration', width: 18 },
      { header: 'الأولوية', key: 'priority', width: 16 },
      { header: 'الملاحظات', key: 'notes', width: 42 }
    ];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.autoFilter = 'A1:L1';
    for (let row = 2; row <= 501; row += 1) {
      sheet.getCell(`A${row}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$A$2:$A$${Math.max(products.length + 1, 2)}`] };
      sheet.getCell(`F${row}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$D$2:$D$3`] };
      sheet.getCell(`G${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'القوائم'!$C$2:$C$${Math.max(users.length + 1, 2)}`] };
      sheet.getCell(`K${row}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$E$2:$E$5`] };
      sheet.getCell(`H${row}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`I${row}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`J${row}`).dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 2000] };
    }
    const lists = workbook.addWorksheet('القوائم', { state: 'veryHidden', views: [{ rightToLeft: true }] });
    lists.addRow(['رمز المنتج', 'اسم المنتج', 'بريد المسؤول', 'الجهة', 'الأولوية']);
    const total = Math.max(products.length, users.length, 4);
    for (let index = 0; index < total; index += 1) {
      lists.addRow([
        products[index] && products[index].code,
        products[index] && products[index].name,
        users[index] && users[index].email,
        ['WAMY', 'إمعان'][index],
        ['منخفضة', 'عادية', 'عاجلة', 'حرجة'][index]
      ]);
    }
    const instructions = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
    instructions.getColumn(1).width = 110;
    [
      'أدخل مهمة واحدة في كل صف، ولا تغيّر أسماء الأعمدة.',
      'رمز المنتج واسم المهمة والجهة وتاريخ الاستحقاق حقول مطلوبة. اختر رمز المنتج من القائمة المنسدلة.',
      'استخدم صيغة YYYY-MM-DD للتواريخ. يجب ألا يسبق تاريخ الاستحقاق تاريخ البدء.',
      'استخدم بريد مستخدم نشط كما يظهر في القائمة. اتركه فارغًا إذا لم تُسند المهمة بعد.',
      'سيعرض النظام معاينة وأخطاء الصفوف والتكرارات قبل الاستيراد، ولن يغيّر البيانات الحالية.'
    ].forEach(text => instructions.addRow([text]));
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plan-template.xlsx"; filename*=UTF-8''${encodeURIComponent('نموذج خطة.xlsx')}`);
    res.send(Buffer.from(buffer));
  } catch (error) { next(error); }
});

app.post('/api/plans/preview', requireActive, upload.single('file'), async (req, res, next) => {
  if (!can(req.user,'Plans.Import')) return forbid(res);
  if (!req.file) return res.status(400).json({ message: 'اختر ملف Excel أولًا.' });
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const standardSheet = workbook.getWorksheet('نموذج الخطة');
    const legacySheet = workbook.getWorksheet('المهام');
    const sheet = standardSheet || legacySheet || workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ message: 'ملف Excel لا يحتوي على ورقة بيانات.' });
    const width = Math.max(STANDARD_PLAN_HEADERS.length, LEGACY_PLAN_HEADERS.length);
    const headers = Array.from({ length: width }, (_, index) => excelCellText(sheet.getRow(1).getCell(index + 1).value));
    const standard = STANDARD_PLAN_HEADERS.every((header, index) => headers[index] === header);
    const legacy = LEGACY_PLAN_HEADERS.every((header, index) => headers[index] === header);
    if (!standard && !legacy) return res.status(400).json({
      message: 'أعمدة الملف لا تطابق نموذج الخطة أو تنسيق «المهام» ذي الأعمدة العشرة.'
    });
    const rawRows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const expected = standard ? STANDARD_PLAN_HEADERS : LEGACY_PLAN_HEADERS;
      const values = expected.map((_, index) => excelCellText(row.getCell(index + 1).value));
      if (!values.some(value => value !== '')) return;
      if (standard) {
        rawRows.push({
          row_number: rowNumber, product_code: values[0], product_name: values[1], phase_name: values[2],
          title: values[3], description: values[4], org: values[5], assignee_email: values[6],
          planned_start: values[7], due_date: values[8], active_duration: values[9], priority: values[10], notes: values[11]
        });
      } else {
        const category = String(values[5] || '').trim();
        const durationMatch = String(values[7] || '').match(/(\d+)\s*(?:يوم|أيام)/);
        const legacyProductLabel = String(values[1] || '').trim();
        const isPartOneWorkstream = /^المنتج\s+(?:الأول|الثاني|الثالث|الرابع)(?:\s|—|-)/.test(legacyProductLabel);
        rawRows.push({
          row_number: rowNumber,
          // This workbook is the detailed breakdown of the existing part-one
          // operating deliverable. Preserve its four product labels as phases.
          product_code: isPartOneWorkstream ? 'PRD-02' : '',
          product_name: isPartOneWorkstream ? '' : legacyProductLabel,
          phase_name: isPartOneWorkstream ? legacyProductLabel : null,
          title: values[2], due_date: values[3],
          status: values[4], description: category || null,
          org: /الإنتاج|التصميم/.test(category) ? 'إمعان' : 'WAMY',
          assignee_name: values[6], notes: values[7],
          active_duration: durationMatch ? Number(durationMatch[1]) : null,
          priority: 'عادية'
        });
      }
    });
    if (!rawRows.length) return res.status(400).json({ message: 'لا يحتوي الملف على مهام.' });
    if (rawRows.length > 500) return res.status(400).json({ message: 'الحد الأقصى للاستيراد 500 مهمة في الملف الواحد.' });
    const rows = await validatePlanRows(rawRows);
    res.json({ format: legacy ? 'wamy_tasks_v1' : 'plan_template_v2', rows, summary: {
      total: rows.length, valid: rows.filter(row => row.valid).length,
      invalid: rows.filter(row => !row.valid).length,
      duplicates: rows.filter(row => row.duplicate).length
    } });
  } catch (error) {
    if (/zip|xlsx|central directory|invalid/i.test(error.message)) return res.status(400).json({ message: 'تعذّرت قراءة الملف. استخدم ملف XLSX صالحًا.' });
    next(error);
  }
});

app.post('/api/plans/import', requireActive, async (req, res, next) => {
  if (!can(req.user,'Plans.Import')) return forbid(res);
  if (!Array.isArray(req.body.rows) || !req.body.rows.length || req.body.rows.length > 500) {
    return res.status(400).json({ message: 'بيانات الاستيراد غير صالحة.' });
  }
  const validated = await validatePlanRows(req.body.rows);
  const invalid = validated.filter(row => !row.valid);
  if (invalid.length) return res.status(409).json({ message: 'تغيّرت البيانات أو تحتوي على أخطاء. أعد المعاينة.', rows: validated });
  const client = await pool.connect();
  try {
    await client.query('begin');
    let imported = 0;
    let duplicates = 0;
    const defaultProject = (await client.query(
      `select id from projects where deleted_at is null and status in ('active','planning') order by (case when code='STR-COMM-01' then 0 else 1 end), created_at limit 1`
    )).rows[0];
    const defaultProjectId = defaultProject ? defaultProject.id : null;

    for (const row of validated) {
      let targetProjectId = defaultProjectId;
      if (row.org) {
        const orgProject = (await client.query(
          `select id from projects where org=$1 and deleted_at is null and status in ('active','planning') order by (case when code='STR-COMM-01' then 0 else 1 end), created_at limit 1`,
          [row.org]
        )).rows[0];
        if (orgProject) targetProjectId = orgProject.id;
      }
      const scheduledStart = row.planned_start ? `${row.planned_start}T09:00:00Z` : null;
      const scheduledDue = row.due_date ? `${row.due_date}T17:00:00Z` : null;
      const requiredOutputs = row.title;

      const result = await client.query(
        `insert into tasks (product_id,project_id,title,description,required_outputs,org,assignee_id,priority,status,progress,
                            planned_start,due_date,scheduled_start_at,scheduled_due_at,active_duration,phase_name,notes,import_key,created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (import_key) where import_key is not null do nothing returning id`,
        [row.product_id,targetProjectId,row.title,row.description,requiredOutputs,row.org,row.assignee_id,row.priority,row.status,row.progress,
         row.planned_start,row.due_date,scheduledStart,scheduledDue,row.active_duration,row.phase_name,row.notes,row.import_key,req.user.id]
      );
      if (result.rowCount) imported += 1; else duplicates += 1;
    }
    await client.query(
      `insert into activity_log (actor_id,actor_name,org,action,type)
       values ($1,$2,$3,$4,'CREATE')`,
      [req.user.id, req.user.name, req.user.org, `استيراد خطة Excel: ${imported} مهمة`]
    );
    await client.query('commit');
    res.status(201).json({ imported, duplicates });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

app.get('/api/plans/export', requireActive, async (req, res, next) => {
  if (!canAny(req.user,'Plans.Export','Reports.Export')) return forbid(res);
  try {
    const privileged = hasAllData(req.user);
    const { rows: tasks } = await pool.query(
      `select t.*,
              p.name as product_name, p.code as product_code, p.hierarchical_code as product_hierarchical_code,
              pr.name as project_name, pr.code as project_code, coalesce(pr.hierarchical_code, pr.code) as project_hierarchical_code,
              mi.hierarchical_code as plan_item_hierarchical_code, mi.track as plan_track,
              u.name as assignee_name
         from tasks t
         left join projects pr on pr.id=t.project_id
         left join products p on p.id=t.product_id
         left join master_plan_items mi on mi.id=t.plan_item_id
         left join profiles u on u.id=t.assignee_id
        where t.deleted_at is null and ($1::boolean or t.assignee_id=$2 or exists(select 1 from task_assignees ta where ta.task_id=t.id and ta.user_id=$2))
        order by coalesce(pr.code,''), coalesce(t.phase_name,p.name,mi.title), t.due_date nulls last, t.created_at`,
      [privileged, req.user.id]
    );
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WAMY Media Project Planner';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('المهام', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'م', key: 'number', width: 7 },
      { header: 'رمز المشروع', key: 'project_code', width: 16 },
      { header: 'المشروع', key: 'project_name', width: 34 },
      { header: 'المسار / الخطة', key: 'track', width: 28 },
      { header: 'رمز المنتج / المخرج', key: 'product_code', width: 24 },
      { header: 'المنتج / المخرج', key: 'product', width: 44 },
      { header: 'المرحلة / المعلم', key: 'phase', width: 24 },
      { header: 'وصف المهمة', key: 'title', width: 60 },
      { header: 'المخرجات المطلوبة', key: 'required_outputs', width: 40 },
      { header: 'التاريخ المجدول', key: 'date', width: 17 },
      { header: 'الحالة', key: 'status', width: 18 },
      { header: 'الجهة', key: 'org', width: 16 },
      { header: 'المسؤول عن المتابعة', key: 'assignee', width: 28 },
      { header: 'ملاحظات', key: 'notes', width: 32 },
      { header: 'أيام حتى الموعد', key: 'days', width: 18 },
      { header: 'الوضع الزمني', key: 'timeline', width: 18 }
    ];
    const counters = new Map();
    tasks.forEach((task, index) => {
      const legacyPhase = task.product_id && task.import_key && task.phase_name
        && /^المنتج\s+(?:الأول|الثاني|الثالث|الرابع)(?:\s|—|-)/.test(task.phase_name);
      const productLabel = legacyPhase ? task.phase_name : task.product_name || (task.title ? 'المخرج المعتمد' : 'بلا منتج');
      const number = (counters.get(productLabel) || 0) + 1;
      counters.set(productLabel, number);
      const rowNumber = index + 2;
      const dueDate = task.due_date ? new Date(`${task.due_date}T00:00:00`) : null;
      sheet.addRow({
        number,
        project_code: task.project_hierarchical_code || task.project_code || '—',
        project_name: task.project_name || '—',
        track: task.plan_track || '—',
        product_code: task.plan_item_hierarchical_code || task.product_hierarchical_code || task.product_code || '—',
        product: productLabel,
        phase: task.phase_name || '—',
        title: task.title,
        required_outputs: task.required_outputs || '—',
        date: dueDate,
        status: TASK_STATUS_EXPORT[task.status] || task.status,
        org: task.org === 'imaan' ? 'إمعان' : 'WAMY',
        assignee: task.assignee_name || '',
        notes: task.notes || '',
        days: dueDate ? { formula: `DAYS(J${rowNumber},TODAY())` } : '',
        timeline: dueDate ? { formula: `IF(OR(K${rowNumber}="منجزة",K${rowNumber}="معتمدة"),"مكتملة",IF(O${rowNumber}<0,"متأخرة",IF(O${rowNumber}<=7,"تستحق قريبًا","قادمة")))` } : ''
      });
      sheet.getCell(`J${rowNumber}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`K${rowNumber}`).dataValidation = {
        type: 'list', allowBlank: false, formulae: ['"لم تبدأ,قيد التنفيذ,متعثرة,منجزة,معتمدة"']
      };
    });
    sheet.autoFilter = `A1:P${Math.max(tasks.length + 1, 2)}`;
    sheet.getRow(1).height = 28;
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
      if (rowNumber > 1) row.height = 34;
      row.eachCell(cell => { cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } }, bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } }, right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      }; });
    });

    const overview = workbook.addWorksheet('نظرة عامة', { views: [{ rightToLeft: true }] });
    overview.getColumn(1).width = 4;
    overview.getColumn(2).width = 46;
    overview.getColumn(3).width = 22;
    overview.addRow([]);
    overview.addRow(['', 'الخطة الزمنية لمنتجات الإعلام — تصدير النظام']);
    overview.addRow(['', `آخر تحديث: ${new Date().toISOString().slice(0, 10)}`]);
    overview.addRow([]);
    overview.addRow(['', 'إجمالي المهام', tasks.length]);
    overview.addRow(['', 'المكتملة', tasks.filter(task => ['completed', 'approved'].includes(task.status)).length]);
    overview.addRow(['', 'قيد التنفيذ', tasks.filter(task => task.status === 'in_progress').length]);
    overview.addRow(['', 'لم تبدأ', tasks.filter(task => task.status === 'not_started').length]);
    overview.getRow(2).font = { bold: true, size: 18, color: { argb: 'FF1D4ED8' } };
    overview.getColumn(2).alignment = { wrapText: true };

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="wamy-tasks.xlsx"; filename*=UTF-8''${encodeURIComponent('الخطة-الزمنية-وامي.xlsx')}`);
    res.send(Buffer.from(buffer));
  } catch (error) { next(error); }
});

app.get('/api/logs', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Audit.View', 'AuditLog.View')) return forbid(res);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
    const privileged = hasAllData(req.user);
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (!privileged) {
      conditions.push(`actor_id = $${paramIndex++}`);
      params.push(req.user.id);
    } else if (req.query.actor_id) {
      conditions.push(`actor_id = $${paramIndex++}`);
      params.push(req.query.actor_id);
    }

    if (req.query.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(req.query.type);
    }

    if (req.query.entity_table) {
      conditions.push(`entity_table = $${paramIndex++}`);
      params.push(req.query.entity_table);
    }

    if (req.query.start_date) {
      conditions.push(`created_at >= $${paramIndex++}::date`);
      params.push(req.query.start_date);
    }

    if (req.query.end_date) {
      conditions.push(`created_at < ($${paramIndex++}::date + interval '1 day')`);
      params.push(req.query.end_date);
    }

    if (req.query.search || req.query.query) {
      const term = `%${String(req.query.search || req.query.query).trim()}%`;
      conditions.push(`(action ILIKE $${paramIndex} OR actor_name ILIKE $${paramIndex} OR coalesce(entity_table, '') ILIKE $${paramIndex})`);
      params.push(term);
      paramIndex++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM activity_log ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (error) { next(error); }
});
app.post('/api/logs', requireActive, (_req, res) => res.status(405).json({
  code: 'SERVER_AUDIT_ONLY', message: 'سجل التدقيق يُنشأ من الخادم فقط.'
}));

// -----------------------------------------------------------------------------
// Backup & System Reset Routes
// -----------------------------------------------------------------------------
app.get('/api/backups', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Backup.View', 'Settings.Backup')) return forbid(res);
  try {
    const backups = backupManager.listBackups();
    res.json(backups);
  } catch (error) { next(error); }
});

app.post('/api/backups', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Backup.Create', 'Settings.Backup')) return forbid(res);
  try {
    const backup = await backupManager.createBackup({
      type: req.body.type || 'FULL',
      notes: String(req.body.notes || '').trim(),
      user: req.user,
      pool
    });
    await pool.query(
      `insert into activity_log(actor_id,actor_name,org,action,type,entity_table,details,request_id,ip_address)
       values($1,$2,$3,$4,'CREATE','backups',$5,$6,$7)`,
      [req.user.id, req.user.name, req.user.org, `إنشاء نسخة احتياطية (${backup.type}): ${backup.id}`,
       { backupId: backup.id, size: backup.sizeFormatted, records: backup.totalRecords }, req.requestId, req.ip]
    );
    res.status(201).json(backup);
  } catch (error) { next(error); }
});

app.get('/api/backups/:id/download', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Backup.Download', 'Settings.Backup')) return forbid(res);
  try {
    const filePath = backupManager.getBackupFilePath(req.params.id);
    const filename = path.basename(filePath);
    res.download(filePath, filename);
  } catch (error) {
    if (/not found/i.test(error.message)) return res.status(404).json({ message: 'ملف النسخة الاحتياطية غير موجود.' });
    next(error);
  }
});

app.post('/api/backups/:id/restore', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Backup.Restore', 'Settings.Backup')) return forbid(res);
  try {
    const result = await backupManager.restoreBackup(req.params.id, { pool, user: req.user });
    await pool.query(
      `insert into activity_log(actor_id,actor_name,org,action,type,entity_table,details,request_id,ip_address)
       values($1,$2,$3,$4,'UPDATE','backups',$5,$6,$7)`,
      [req.user.id, req.user.name, req.user.org, `استعادة النظام من النسخة الاحتياطية: ${req.params.id}`,
       result, req.requestId, req.ip]
    );
    res.json({ success: true, message: 'تمت استعادة النسخة الاحتياطية بنجاح.', result });
  } catch (error) { next(error); }
});

app.delete('/api/backups/:id', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'Backup.Delete', 'Settings.Backup')) return forbid(res);
  try {
    backupManager.deleteBackup(req.params.id);
    await pool.query(
      `insert into activity_log(actor_id,actor_name,org,action,type,entity_table,request_id,ip_address)
       values($1,$2,$3,$4,'DELETE','backups',$5,$6)`,
      [req.user.id, req.user.name, req.user.org, `حذف النسخة الاحتياطية: ${req.params.id}`, req.requestId, req.ip]
    );
    res.json({ success: true, id: req.params.id });
  } catch (error) {
    if (/not found/i.test(error.message)) return res.status(404).json({ message: 'ملف النسخة الاحتياطية غير موجود.' });
    next(error);
  }
});

app.post('/api/system/reset-projects', requireActive, async (req, res, next) => {
  if (!canAny(req.user, 'System.Reset') && !isAdmin(req.user)) return forbid(res);
  const confirmation = String(req.body.confirmation || '').trim();
  if (confirmation !== 'إعادة تهيئة النظام بالكامل' && confirmation !== 'RESET_ALL_PROJECTS') {
    return res.status(400).json({
      code: 'INVALID_CONFIRMATION',
      message: 'عبارة التأكيد غير صحيحة. يرجى إدخال: "إعادة تهيئة النظام بالكامل"'
    });
  }
  try {
    const createBackupFirst = req.body.createBackupFirst !== false;
    const result = await backupManager.resetProjectHierarchy({
      pool,
      user: req.user,
      createBackupFirst
    });
    await pool.query(
      `insert into activity_log(actor_id,actor_name,org,action,type,entity_table,details,request_id,ip_address)
       values($1,$2,$3,$4,'DELETE','system',$5,$6,$7)`,
      [req.user.id, req.user.name, req.user.org, 'إعادة تهيئة النظام وحذف جميع بيانات المشاريع والمهام',
       { wipedCounts: result.wipedCounts, preResetBackup: result.preResetBackup ? result.preResetBackup.id : null }, req.requestId, req.ip]
    );
    res.json({ success: true, message: 'تمت إعادة تهيئة بيانات المشاريع بنجاح مع المحافظة على حسابات المستخدمين والإعدادات.', result });
  } catch (error) { next(error); }
});

app.get('/api/settings', requireActive, async (_req, res, next) => {
  if (!can(_req.user,'Settings.View')) return forbid(res);
  try { res.json((await pool.query('select * from app_settings where id=1')).rows[0] || null); } catch (error) { next(error); }
});
app.patch('/api/settings', requireActive, async (req, res, next) => {
  if (!can(req.user,'Settings.Integrations')) return forbid(res);
  const patch = { ...req.body, updated_by: req.user.id };
  delete patch.updated_at;
  const query = updateStatement('app_settings', 1, patch, FIELDS.settings);
  if (!query) return res.status(400).json({ message: 'لا توجد حقول صالحة للتحديث.' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const before = (await client.query('select * from app_settings where id=1 for update')).rows[0];
    if (before && !versionMatches(req, before)) {
      await client.query('rollback');
      return versionConflict(res);
    }
    const rows = (await client.query(query)).rows;
    const changedFields = Object.keys(cleanObject(patch, FIELDS.settings)).filter(key => key !== 'updated_by');
    await writeAudit(client, req, 'تحديث إعدادات Google Drive', 'SETTINGS', 'app_settings', 1,
      { changed_fields: changedFields,
        before: Object.fromEntries(changedFields.map(key => [key, before && before[key]])),
        after: Object.fromEntries(changedFields.map(key => [key, rows[0] && rows[0][key]])) });
    await client.query('commit');
    res.json(rows);
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally { client.release(); }
});

const frontendDir = IS_PRODUCTION ? path.join(__dirname, 'dist') : __dirname;
if (IS_PRODUCTION) app.use('/assets', express.static(path.join(frontendDir, 'assets'), { immutable: true, maxAge: '1y' }));
app.get('/', (_req, res) => res.sendFile(path.join(frontendDir, IS_PRODUCTION ? 'index.html' : 'code_artifact.html')));
if (!IS_PRODUCTION) app.get('/code_artifact.html', (_req, res) => res.sendFile(path.join(__dirname, 'code_artifact.html')));

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', event: 'request_error', request_id: _req.requestId,
    code: error.code, message: error.message, stack: IS_PRODUCTION ? undefined : error.stack }));
  const known = ['23502','23505','23503','23514','22P02','42501'].includes(error.code);
  res.status(known ? 400 : 500).json({
    code: error.code || 'SERVER_ERROR',
    message: known || !IS_PRODUCTION ? error.message : 'حدث خطأ داخلي في الخادم.'
  });
});

let server;
(async () => {
  await pool.query('select 1');
  await Promise.all([
    pool.query('delete from sessions where expires_at <= now()'),
    pool.query(`delete from login_attempts where attempted_at < now() - interval '30 days'`)
  ]);
  server = app.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ level: 'info', event: 'server_started', host: HOST, port: PORT,
      environment: process.env.NODE_ENV || 'development', database: 'connected' }));
  });
})().catch(error => {
  console.error('Cannot connect to PostgreSQL:', error.message);
  console.error('Check DATABASE_URL and run: npm run db:init');
  process.exit(1);
});

async function shutdown() {
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
