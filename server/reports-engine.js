'use strict';

const ExcelJS = require('exceljs');

/**
 * Checks whether user has full unrestricted data access
 */
function hasAllData(user) {
  return user && (user.role === 'admin' || user.data_scope === 'all_data');
}

/**
 * Builds the SQL snippet for user authorization scope across projects/plans/tasks
 */
function buildUserRbacCondition(user, tableAlias = 't', projectAlias = 'p') {
  if (hasAllData(user)) {
    return { text: '1=1', values: [] };
  }

  const userId = user.id;
  const userOrg = user.org;
  const dataScope = user.data_scope || 'my_data';
  const dept = user.department || null;
  const team = user.team || null;

  // Conditions:
  // 1. User is project manager of the project
  // 2. User is Project-wide Team Head
  // 3. User is Plan-specific Team Head for the task's plan
  // 4. User is Team Member under a team head for the project or plan
  // 5. User is direct assignee or in task_assignees
  // 6. Organization / Department / Team scoping if applicable
  const cond = `(
    ${projectAlias}.manager_id = $USER_ID
    or exists (
      select 1 from project_team_assignments pta
       where pta.project_id = ${projectAlias}.id
         and pta.team_head_id = $USER_ID
         and pta.scope = 'PROJECT'
         and pta.is_active = true
         and pta.deleted_at is null
    )
    or exists (
      select 1 from project_team_assignments pta
       where pta.plan_item_id = ${tableAlias}.plan_item_id
         and pta.team_head_id = $USER_ID
         and pta.scope = 'PLAN'
         and pta.is_active = true
         and pta.deleted_at is null
    )
    or exists (
      select 1 from project_team_members ptm
      join project_team_assignments pta on pta.id = ptm.assignment_id
     where (
        (pta.scope = 'PROJECT' and pta.project_id = ${projectAlias}.id)
        or (pta.scope = 'PLAN' and pta.plan_item_id = ${tableAlias}.plan_item_id)
     )
       and ptm.user_id = $USER_ID
       and ptm.is_active = true
       and ptm.deleted_at is null
       and pta.deleted_at is null
    )
    or ${tableAlias}.assignee_id = $USER_ID
    or exists (
      select 1 from task_assignees ta
       where ta.task_id = ${tableAlias}.id
         and ta.user_id = $USER_ID
    )
    or ($DATA_SCOPE = 'my_department' and $USER_DEPT is not null and exists (
      select 1 from task_assignees ta
      join profiles ap on ap.id = ta.user_id
     where ta.task_id = ${tableAlias}.id and ap.org = $USER_ORG and ap.department = $USER_DEPT
    ))
    or ($DATA_SCOPE = 'my_team' and $USER_TEAM is not null and exists (
      select 1 from task_assignees ta
      join profiles ap on ap.id = ta.user_id
     where ta.task_id = ${tableAlias}.id and ap.org = $USER_ORG and ap.team = $USER_TEAM
    ))
    or (($DATA_SCOPE in ('my_department', 'my_team')) and ${projectAlias}.org = $USER_ORG)
  )`;

  return { cond, userId, userOrg, dataScope, dept, team };
}

/**
 * Returns available filter options dynamically constrained by user role and cascading filters
 */
async function getFilterMetadata(pool, user, currentFilters = {}) {
  const privileged = hasAllData(user);
  const userId = user.id;
  const userOrg = user.org;

  // 1. Get Accessible Projects
  let projectsQuery = `
    select p.id, p.code, p.hierarchical_code, p.name, p.org, p.status, p.manager_id,
           mgr.name as manager_name, mgr.email as manager_email
      from projects p
      left join profiles mgr on mgr.id = p.manager_id
     where p.deleted_at is null
       and p.is_system = false
  `;
  const pParams = [];
  let pParamIdx = 1;

  if (!privileged) {
    projectsQuery += `
      and (
        p.manager_id = $${pParamIdx}
        or exists (select 1 from project_team_assignments pta where pta.project_id = p.id and pta.team_head_id = $${pParamIdx} and pta.is_active = true and pta.deleted_at is null)
        or exists (select 1 from project_team_members ptm join project_team_assignments pta on pta.id = ptm.assignment_id where pta.project_id = p.id and ptm.user_id = $${pParamIdx} and ptm.is_active = true and ptm.deleted_at is null and pta.deleted_at is null)
        or exists (select 1 from tasks t where t.project_id = p.id and (t.assignee_id = $${pParamIdx} or exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $${pParamIdx})) and t.deleted_at is null)
        or (p.org = $${pParamIdx + 1})
      )
    `;
    pParams.push(userId, userOrg);
    pParamIdx += 2;
  }

  if (currentFilters.org && currentFilters.org !== 'all') {
    projectsQuery += ` and p.org = $${pParamIdx++}`;
    pParams.push(currentFilters.org);
  }

  projectsQuery += ` order by coalesce(p.hierarchical_code, p.code), p.name`;
  const projectsRes = await pool.query(projectsQuery, pParams);
  const projects = projectsRes.rows;
  const accessibleProjectIds = projects.map(p => p.id);

  // 2. Get Accessible Organizations from active projects or org list
  const orgsRes = await pool.query(
    `select code, name, is_active from organizations where deleted_at is null order by name`
  );
  let organizations = orgsRes.rows;
  if (!privileged) {
    const allowedOrgs = new Set(projects.map(p => p.org));
    allowedOrgs.add(userOrg);
    organizations = organizations.filter(o => allowedOrgs.has(o.code));
  }

  // 3. Get Accessible Plans (constrained by selected project or all accessible projects)
  let plans = [];
  if (accessibleProjectIds.length > 0) {
    let plansQuery = `
      select pi.id, pi.project_id, pi.external_id, pi.hierarchical_code, pi.title, pi.track, pi.phase,
             p.name as project_name, p.code as project_code
        from master_plan_items pi
        join projects p on p.id = pi.project_id
       where pi.deleted_at is null and p.deleted_at is null
         and pi.project_id = any($1::uuid[])
    `;
    const plParams = [accessibleProjectIds];
    let plIdx = 2;

    if (currentFilters.project_id && currentFilters.project_id !== 'all') {
      plansQuery += ` and pi.project_id = $${plIdx++}`;
      plParams.push(currentFilters.project_id);
    }

    if (!privileged) {
      plansQuery += `
        and (
          p.manager_id = $${plIdx}
          or exists (select 1 from project_team_assignments pta where pta.project_id = p.id and pta.team_head_id = $${plIdx} and pta.scope = 'PROJECT' and pta.is_active = true and pta.deleted_at is null)
          or exists (select 1 from project_team_assignments pta where pta.plan_item_id = pi.id and pta.team_head_id = $${plIdx} and pta.scope = 'PLAN' and pta.is_active = true and pta.deleted_at is null)
          or exists (select 1 from project_team_members ptm join project_team_assignments pta on pta.id = ptm.assignment_id where (pta.scope = 'PROJECT' and pta.project_id = p.id or pta.scope = 'PLAN' and pta.plan_item_id = pi.id) and ptm.user_id = $${plIdx} and ptm.is_active = true and ptm.deleted_at is null and pta.deleted_at is null)
          or exists (select 1 from tasks t where t.plan_item_id = pi.id and (t.assignee_id = $${plIdx} or exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $${plIdx})) and t.deleted_at is null)
          or (p.org = $${plIdx + 1})
        )
      `;
      plParams.push(userId, userOrg);
      plIdx += 2;
    }

    plansQuery += ` order by coalesce(pi.track, ''), pi.title`;
    const plansRes = await pool.query(plansQuery, plParams);
    plans = plansRes.rows;
  }

  // 4. Get Managers
  let managers = [];
  if (projects.length > 0) {
    const managerIds = [...new Set(projects.map(p => p.manager_id).filter(Boolean))];
    if (managerIds.length > 0) {
      const mgrRes = await pool.query(
        `select id, name, email, position, org from profiles where id = any($1::uuid[]) and deleted_at is null order by name`,
        [managerIds]
      );
      managers = mgrRes.rows;
    }
  }

  // 5. Get Team Heads (Cascading by project / plan)
  let teamHeads = [];
  if (accessibleProjectIds.length > 0) {
    let thQuery = `
      select distinct pta.team_head_id as id, u.name, u.email, u.position, pta.scope, pta.title as role_title,
             pta.project_id, pta.plan_item_id, p.name as project_name, pi.title as plan_title
        from project_team_assignments pta
        join profiles u on u.id = pta.team_head_id
        join projects p on p.id = pta.project_id
        left join master_plan_items pi on pi.id = pta.plan_item_id
       where pta.deleted_at is null and pta.is_active = true
         and pta.project_id = any($1::uuid[])
    `;
    const thParams = [accessibleProjectIds];
    let thIdx = 2;

    if (currentFilters.project_id && currentFilters.project_id !== 'all') {
      thQuery += ` and pta.project_id = $${thIdx++}`;
      thParams.push(currentFilters.project_id);
    }
    if (currentFilters.plan_item_id && currentFilters.plan_item_id !== 'all') {
      thQuery += ` and (pta.scope = 'PROJECT' or pta.plan_item_id = $${thIdx++})`;
      thParams.push(currentFilters.plan_item_id);
    }

    thQuery += ` order by u.name`;
    const thRes = await pool.query(thQuery, thParams);
    teamHeads = thRes.rows;
  }

  // 6. Get Team Members / Assignees
  let teamMembers = [];
  if (accessibleProjectIds.length > 0) {
    let tmQuery = `
      select distinct u.id, u.name, u.email, u.position, u.org
        from profiles u
       where u.deleted_at is null and u.status = 'active'
         and (
           exists (
             select 1 from project_team_members ptm
             join project_team_assignments pta on pta.id = ptm.assignment_id
            where ptm.user_id = u.id and ptm.deleted_at is null and ptm.is_active = true
              and pta.project_id = any($1::uuid[])
              ${currentFilters.project_id && currentFilters.project_id !== 'all' ? `and pta.project_id = '${currentFilters.project_id}'` : ''}
              ${currentFilters.plan_item_id && currentFilters.plan_item_id !== 'all' ? `and (pta.scope = 'PROJECT' or pta.plan_item_id = '${currentFilters.plan_item_id}')` : ''}
              ${currentFilters.team_head_id && currentFilters.team_head_id !== 'all' ? `and pta.team_head_id = '${currentFilters.team_head_id}'` : ''}
           )
           or exists (
             select 1 from tasks t
             join projects p on p.id = t.project_id
            where (t.assignee_id = u.id or exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = u.id))
              and t.deleted_at is null and p.id = any($1::uuid[])
              ${currentFilters.project_id && currentFilters.project_id !== 'all' ? `and p.id = '${currentFilters.project_id}'` : ''}
              ${currentFilters.plan_item_id && currentFilters.plan_item_id !== 'all' ? `and t.plan_item_id = '${currentFilters.plan_item_id}'` : ''}
           )
         )
       order by u.name
    `;
    const tmRes = await pool.query(tmQuery, [accessibleProjectIds]);
    teamMembers = tmRes.rows;
  }

  return {
    organizations,
    projects,
    plans,
    managers,
    team_heads: teamHeads,
    team_members: teamMembers,
    statuses: [
      { key: 'all', label: 'كل الحالات' },
      { key: 'not_started', label: 'لم تبدأ (Not Started)' },
      { key: 'in_progress', label: 'قيد التنفيذ (In Progress)' },
      { key: 'under_review', label: 'قيد المراجعة والاعتماد' },
      { key: 'completed', label: 'مكتملة (Completed)' },
      { key: 'delayed', label: 'متأخرة عن موعدها (Overdue)' },
      { key: 'blocked', label: 'متوقفة / معلقة (On Hold)' }
    ],
    priorities: [
      { key: 'all', label: 'كل الأولويات' },
      { key: 'low', label: 'منخفضة' },
      { key: 'normal', label: 'عادية' },
      { key: 'urgent', label: 'عاجلة' },
      { key: 'critical', label: 'حرجة' }
    ],
    date_types: [
      { key: 'due_date', label: 'تاريخ الاستحقاق (Due Date)' },
      { key: 'planned_start', label: 'تاريخ البدء المخطط' },
      { key: 'completed_at', label: 'تاريخ الإنجاز الفعلي' },
      { key: 'created_at', label: 'تاريخ الإنشاء والإدراج' }
    ]
  };
}

/**
 * Builds standard parameterized where clause for report queries
 */
function buildReportQueryClause(user, filters) {
  const conditions = ['t.deleted_at is null', 'p.deleted_at is null', 'p.is_system = false'];
  const params = [];
  let idx = 1;

  // 1. RBAC Scoping
  if (!hasAllData(user)) {
    const uid = user.id;
    const uorg = user.org;
    const dscope = user.data_scope || 'my_data';
    const udept = user.department || null;
    const uteam = user.team || null;

    const rbacParamIdx = idx;
    conditions.push(`(
      p.manager_id = $${rbacParamIdx}
      or exists (
        select 1 from project_team_assignments pta
         where pta.project_id = p.id and pta.team_head_id = $${rbacParamIdx} and pta.scope = 'PROJECT' and pta.is_active = true and pta.deleted_at is null
      )
      or exists (
        select 1 from project_team_assignments pta
         where pta.plan_item_id = t.plan_item_id and pta.team_head_id = $${rbacParamIdx} and pta.scope = 'PLAN' and pta.is_active = true and pta.deleted_at is null
      )
      or exists (
        select 1 from project_team_members ptm
        join project_team_assignments pta on pta.id = ptm.assignment_id
       where (
          (pta.scope = 'PROJECT' and pta.project_id = p.id)
          or (pta.scope = 'PLAN' and pta.plan_item_id = t.plan_item_id)
       )
         and ptm.user_id = $${rbacParamIdx} and ptm.is_active = true and ptm.deleted_at is null and pta.deleted_at is null
      )
      or t.assignee_id = $${rbacParamIdx}
      or exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $${rbacParamIdx})
      or ($${rbacParamIdx + 1} = 'my_department' and $${rbacParamIdx + 3}::text is not null and exists (
        select 1 from task_assignees ta join profiles ap on ap.id = ta.user_id where ta.task_id = t.id and ap.org = $${rbacParamIdx + 2} and ap.department = $${rbacParamIdx + 3}::text
      ))
      or ($${rbacParamIdx + 1} = 'my_team' and $${rbacParamIdx + 4}::text is not null and exists (
        select 1 from task_assignees ta join profiles ap on ap.id = ta.user_id where ta.task_id = t.id and ap.org = $${rbacParamIdx + 2} and ap.team = $${rbacParamIdx + 4}::text
      ))
      or (($${rbacParamIdx + 1} in ('my_department', 'my_team')) and p.org = $${rbacParamIdx + 2})
    )`);

    params.push(uid, dscope, uorg, udept, uteam);
    idx += 5;
  }

  // 2. Organization filter
  if (filters.org && filters.org !== 'all') {
    conditions.push(`p.org = $${idx++}`);
    params.push(filters.org);
  }

  // 3. Project filter
  if (filters.project_id && filters.project_id !== 'all') {
    conditions.push(`t.project_id = $${idx++}`);
    params.push(filters.project_id);
  }

  // 4. Plan Item filter
  if (filters.plan_item_id && filters.plan_item_id !== 'all') {
    conditions.push(`t.plan_item_id = $${idx++}`);
    params.push(filters.plan_item_id);
  }

  // 5. Manager filter
  if (filters.manager_id && filters.manager_id !== 'all') {
    conditions.push(`p.manager_id = $${idx++}`);
    params.push(filters.manager_id);
  }

  // 6. Team Head filter
  if (filters.team_head_id && filters.team_head_id !== 'all') {
    conditions.push(`(
      exists (
        select 1 from project_team_assignments pta
         where pta.project_id = p.id
           and pta.team_head_id = $${idx}
           and pta.scope = 'PROJECT'
           and pta.is_active = true
           and pta.deleted_at is null
      )
      or exists (
        select 1 from project_team_assignments pta
         where pta.plan_item_id = t.plan_item_id
           and pta.team_head_id = $${idx}
           and pta.scope = 'PLAN'
           and pta.is_active = true
           and pta.deleted_at is null
      )
    )`);
    params.push(filters.team_head_id);
    idx++;
  }

  // 7. Team Member / Assignee filter
  if (filters.member_id && filters.member_id !== 'all') {
    conditions.push(`(
      t.assignee_id = $${idx}
      or exists (select 1 from task_assignees ta where ta.task_id = t.id and ta.user_id = $${idx})
      or exists (
        select 1 from project_team_members ptm
        join project_team_assignments pta on pta.id = ptm.assignment_id
       where ptm.user_id = $${idx}
         and ptm.is_active = true
         and ptm.deleted_at is null
         and pta.deleted_at is null
         and (pta.project_id = t.project_id or pta.plan_item_id = t.plan_item_id)
      )
    )`);
    params.push(filters.member_id);
    idx++;
  }

  // 8. Status filter
  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'delayed') {
      conditions.push(`(t.status::text not in ('completed', 'approved', 'cancelled') and t.due_date is not null and t.due_date < current_date)`);
    } else {
      conditions.push(`t.status = $${idx++}`);
      params.push(filters.status);
    }
  }

  // 9. Priority filter
  if (filters.priority && filters.priority !== 'all') {
    conditions.push(`t.priority = $${idx++}`);
    params.push(filters.priority);
  }

  // 10. Date Range filter
  const dateField = ['due_date', 'planned_start', 'completed_at', 'created_at'].includes(filters.date_type)
    ? filters.date_type
    : 'due_date';

  if (filters.date_from) {
    conditions.push(`t.${dateField} >= $${idx++}`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`t.${dateField} <= $${idx++}`);
    params.push(filters.date_to);
  }

  // 11. Progress range
  if (filters.min_progress !== undefined && filters.min_progress !== null && filters.min_progress !== '') {
    conditions.push(`t.progress >= $${idx++}`);
    params.push(Number(filters.min_progress));
  }
  if (filters.max_progress !== undefined && filters.max_progress !== null && filters.max_progress !== '') {
    conditions.push(`t.progress <= $${idx++}`);
    params.push(Number(filters.max_progress));
  }

  // 12. Search query
  if (filters.search && String(filters.search).trim()) {
    const q = `%${String(filters.search).trim()}%`;
    conditions.push(`(
      t.title ilike $${idx}
      or t.code ilike $${idx}
      or coalesce(t.description, '') ilike $${idx}
      or p.name ilike $${idx}
      or coalesce(pi.title, '') ilike $${idx}
      or coalesce(mgr.name, '') ilike $${idx}
    )`);
    params.push(q);
    idx++;
  }

  return { whereSql: conditions.join(' and '), params };
}

/**
 * Execute complete paginated report query with KPIs summary
 */
async function queryReports(pool, user, filters = {}, pagination = {}) {
  const { whereSql, params } = buildReportQueryClause(user, filters);

  const page = Math.max(Number(pagination.page) || 1, 1);
  const limit = Math.min(Math.max(Number(pagination.limit) || 25, 5), 500);
  const offset = (page - 1) * limit;

  // Base FROM & JOINs
  const fromClause = `
    from tasks t
    join projects p on p.id = t.project_id
    left join master_plan_items pi on pi.id = t.plan_item_id
    left join products prd on prd.id = t.product_id
    left join profiles mgr on mgr.id = p.manager_id
    left join profiles primary_assignee on primary_assignee.id = t.assignee_id
  `;

  // 1. KPI Summary calculation (across full filtered set without pagination)
  const summarySql = `
    select
      count(distinct p.id)::int as total_projects,
      count(distinct pi.id)::int as total_plans,
      count(distinct t.id)::int as total_tasks,
      count(distinct t.id) filter (where t.status::text in ('completed', 'approved'))::int as completed_tasks,
      count(distinct t.id) filter (where t.status::text in ('in_progress', 'under_review'))::int as in_progress_tasks,
      count(distinct t.id) filter (where t.status::text in ('not_started', 'planning', 'scheduled'))::int as not_started_tasks,
      count(distinct t.id) filter (where t.status::text not in ('completed', 'approved', 'cancelled') and t.due_date is not null and t.due_date < current_date)::int as overdue_tasks,
      coalesce(round(avg(t.progress)), 0)::int as avg_progress,
      coalesce(sum(greatest(0, current_date - t.due_date)) filter (where t.status::text not in ('completed', 'approved', 'cancelled') and t.due_date is not null and t.due_date < current_date), 0)::int as total_delay_days
    ${fromClause}
    where ${whereSql}
  `;
  const summaryRes = await pool.query(summarySql, params);
  const summary = summaryRes.rows[0] || {
    total_projects: 0,
    total_plans: 0,
    total_tasks: 0,
    completed_tasks: 0,
    in_progress_tasks: 0,
    not_started_tasks: 0,
    overdue_tasks: 0,
    avg_progress: 0,
    total_delay_days: 0
  };

  // 2. Detailed Rows query (Paginated)
  const sortCol = ['p.name', 'pi.title', 't.title', 't.status', 't.priority', 't.due_date', 't.planned_start', 't.progress'].includes(pagination.sort_by)
    ? pagination.sort_by
    : 't.due_date nulls last, p.name, t.title';
  const sortDir = (pagination.sort_dir || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

  const rowsSql = `
    select
      t.id as task_id,
      coalesce(t.import_key, pi.hierarchical_code, pi.external_id, substring(t.id::text, 1, 8)) as task_code,
      t.title as task_title,
      t.description as task_description,
      t.status as task_status,
      t.priority as task_priority,
      t.progress as task_progress,
      t.planned_start,
      t.due_date,
      t.scheduled_start_at as actual_start,
      t.actual_completion as completed_at,
      t.notes as task_notes,
      case
        when t.status::text in ('completed', 'approved') then false
        when t.due_date is not null and t.due_date < current_date then true
        else false
      end as is_overdue,
      case
        when t.status::text not in ('completed', 'approved') and t.due_date is not null and t.due_date < current_date
          then (current_date - t.due_date)::int
        else 0
      end as delay_days,
      p.id as project_id,
      p.name as project_name,
      p.code as project_code,
      p.hierarchical_code as project_hierarchical_code,
      p.org as project_org,
      p.status as project_status,
      mgr.id as manager_id,
      mgr.name as manager_name,
      mgr.email as manager_email,
      pi.id as plan_item_id,
      pi.title as plan_title,
      pi.track as plan_track,
      pi.external_id as plan_external_id,
      prd.id as product_id,
      prd.name as product_name,
      primary_assignee.id as primary_assignee_id,
      primary_assignee.name as primary_assignee_name,
      primary_assignee.email as primary_assignee_email,
      coalesce(
        (select json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'position', u.position))
           from task_assignees ta
           join profiles u on u.id = ta.user_id
          where ta.task_id = t.id),
        case when primary_assignee.id is not null then json_build_array(json_build_object('id', primary_assignee.id, 'name', primary_assignee.name, 'email', primary_assignee.email)) else '[]'::json end
      ) as assignees,
      coalesce(
        (select json_agg(json_build_object('id', head.id, 'name', head.name, 'scope', pta.scope, 'title', pta.title))
           from project_team_assignments pta
           join profiles head on head.id = pta.team_head_id
          where pta.deleted_at is null and pta.is_active = true
            and (pta.project_id = p.id and (pta.scope = 'PROJECT' or pta.plan_item_id = t.plan_item_id))),
        '[]'::json
      ) as team_heads
    ${fromClause}
    where ${whereSql}
    order by ${sortCol} ${sortDir}
    limit $${params.length + 1} offset $${params.length + 2}
  `;

  const rowsRes = await pool.query(rowsSql, [...params, limit, offset]);

  return {
    summary,
    pagination: {
      total: summary.total_tasks,
      page,
      limit,
      total_pages: Math.ceil(summary.total_tasks / limit) || 1
    },
    rows: rowsRes.rows
  };
}

/**
 * Generate formatted Excel Workbook from filtered reports dataset
 */
async function exportReportsExcel(pool, user, filters = {}) {
  const { whereSql, params } = buildReportQueryClause(user, filters);

  const fromClause = `
    from tasks t
    join projects p on p.id = t.project_id
    left join master_plan_items pi on pi.id = t.plan_item_id
    left join products prd on prd.id = t.product_id
    left join profiles mgr on mgr.id = p.manager_id
    left join profiles primary_assignee on primary_assignee.id = t.assignee_id
  `;

  const rowsSql = `
    select
      p.name as project_name,
      p.code as project_code,
      p.org as project_org,
      coalesce(pi.title, '—') as plan_title,
      coalesce(pi.track, '—') as plan_track,
      coalesce(mgr.name, '—') as manager_name,
      coalesce(t.import_key, pi.hierarchical_code, pi.external_id, substring(t.id::text, 1, 8)) as task_code,
      t.title as task_title,
      t.description as task_description,
      t.status as task_status,
      t.priority as task_priority,
      t.progress as task_progress,
      t.planned_start,
      t.due_date,
      t.scheduled_start_at as actual_start,
      t.actual_completion as completed_at,
      case
        when t.status::text in ('completed', 'approved') then 0
        when t.due_date is not null and t.due_date < current_date then (current_date - t.due_date)::int
        else 0
      end as delay_days,
      coalesce(
        (select string_agg(u.name, '، ')
           from task_assignees ta
           join profiles u on u.id = ta.user_id
          where ta.task_id = t.id),
        primary_assignee.name,
        '—'
      ) as assignees_text,
      coalesce(
        (select string_agg(head.name || ' (' || case when pta.scope='PROJECT' then 'المشروع' else 'الخطة' end || ')', '، ')
           from project_team_assignments pta
           join profiles head on head.id = pta.team_head_id
          where pta.deleted_at is null and pta.is_active = true
            and (pta.project_id = p.id and (pta.scope = 'PROJECT' or pta.plan_item_id = t.plan_item_id))),
        '—'
      ) as team_heads_text
    ${fromClause}
    where ${whereSql}
    order by p.name, pi.title, t.due_date nulls last, t.title
  `;

  const { rows } = await pool.query(rowsSql, params);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WAMY Media Project Planner';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('تقرير المهام والتنفيذ', {
    views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }]
  });

  const statusMap = {
    not_started: 'لم تبدأ',
    in_progress: 'قيد التنفيذ',
    under_review: 'قيد المراجعة',
    completed: 'مكتملة',
    closed: 'مغلقة',
    blocked: 'معلقة',
    cancelled: 'ملغاة'
  };

  const priorityMap = {
    low: 'منخفضة',
    normal: 'عادية',
    urgent: 'عاجلة',
    critical: 'حرجة'
  };

  sheet.columns = [
    { header: 'المشروع', key: 'project_name', width: 28 },
    { header: 'الجهة', key: 'project_org', width: 15 },
    { header: 'المدير المسؤول', key: 'manager_name', width: 22 },
    { header: 'الخطة / المسار', key: 'plan_title', width: 28 },
    { header: 'المسار الفرعي', key: 'plan_track', width: 20 },
    { header: 'رؤساء الفرق / المشرفون', key: 'team_heads_text', width: 28 },
    { header: 'رمز المهمة', key: 'task_code', width: 16 },
    { header: 'عنوان المهمة', key: 'task_title', width: 38 },
    { header: 'فريق التنفيذ والمسؤولون', key: 'assignees_text', width: 30 },
    { header: 'الحالة', key: 'task_status_label', width: 16 },
    { header: 'الأولوية', key: 'task_priority_label', width: 14 },
    { header: 'نسبة الإنجاز %', key: 'task_progress', width: 16 },
    { header: 'البداية المخططة', key: 'planned_start', width: 16 },
    { header: 'تاريخ الاستحقاق', key: 'due_date', width: 16 },
    { header: 'الإنجاز الفعلي', key: 'completed_at', width: 16 },
    { header: 'أيام التأخير', key: 'delay_days', width: 14 },
    { header: 'الوصف ونطاق المهمة', key: 'task_description', width: 45 }
  ];

  // Style Header Row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Segoe UI' };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 28;

  for (const r of rows) {
    const isDone = ['completed', 'approved'].includes(r.task_status);
    const row = sheet.addRow({
      project_name: r.project_name,
      project_org: r.project_org,
      manager_name: r.manager_name,
      plan_title: r.plan_title,
      plan_track: r.plan_track,
      team_heads_text: r.team_heads_text,
      task_code: r.task_code || '—',
      task_title: r.task_title,
      assignees_text: r.assignees_text,
      task_status_label: statusMap[r.task_status] || r.task_status,
      task_priority_label: priorityMap[r.task_priority] || r.task_priority,
      task_progress: (r.task_progress || 0) + '%',
      planned_start: r.planned_start ? String(r.planned_start).slice(0, 10) : '—',
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : '—',
      completed_at: r.completed_at ? String(r.completed_at).slice(0, 10) : (isDone ? 'مكتملة' : '—'),
      delay_days: r.delay_days > 0 ? `${r.delay_days} يوم` : '0',
      task_description: r.task_description || '—'
    });

    row.alignment = { vertical: 'middle', horizontal: 'right' };
    row.font = { size: 10, name: 'Segoe UI' };

    // Highlight delayed tasks
    if (r.delay_days > 0) {
      row.getCell('delay_days').font = { bold: true, color: { argb: 'FFE11D48' } };
      row.getCell('task_status_label').font = { bold: true, color: { argb: 'FFE11D48' } };
    } else if (isDone) {
      row.getCell('task_status_label').font = { bold: true, color: { argb: 'FF10B981' } };
      row.getCell('task_progress').font = { bold: true, color: { argb: 'FF10B981' } };
    }
  }

  sheet.autoFilter = `A1:Q${Math.max(rows.length + 1, 2)}`;
  return workbook;
}

/**
 * Generate CSV text with UTF-8 BOM
 */
async function exportReportsCsv(pool, user, filters = {}) {
  const { whereSql, params } = buildReportQueryClause(user, filters);

  const fromClause = `
    from tasks t
    join projects p on p.id = t.project_id
    left join master_plan_items pi on pi.id = t.plan_item_id
    left join profiles mgr on mgr.id = p.manager_id
    left join profiles primary_assignee on primary_assignee.id = t.assignee_id
  `;

  const rowsSql = `
    select
      p.name as project_name,
      p.org as project_org,
      coalesce(mgr.name, '—') as manager_name,
      coalesce(pi.title, '—') as plan_title,
      coalesce(t.import_key, pi.hierarchical_code, pi.external_id, substring(t.id::text, 1, 8)) as task_code,
      t.title as task_title,
      t.status as task_status,
      t.priority as task_priority,
      t.progress as task_progress,
      t.planned_start,
      t.due_date,
      case
        when t.status::text not in ('completed', 'approved') and t.due_date is not null and t.due_date < current_date
          then (current_date - t.due_date)::int
        else 0
      end as delay_days,
      coalesce(
        (select string_agg(u.name, ' / ') from task_assignees ta join profiles u on u.id = ta.user_id where ta.task_id = t.id),
        primary_assignee.name,
        '—'
      ) as assignees_text
    ${fromClause}
    where ${whereSql}
    order by p.name, pi.title, t.due_date nulls last, t.title
  `;

  const { rows } = await pool.query(rowsSql, params);

  const headers = ['المشروع', 'الجهة', 'المدير المسؤول', 'الخطة', 'رمز المهمة', 'عنوان المهمة', 'الحالة', 'الأولوية', 'الإنجاز %', 'تاريخ البدء', 'تاريخ الاستحقاق', 'أيام التأخير', 'فريق التنفيذ'];

  const csvRows = [headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',')];

  for (const r of rows) {
    const line = [
      r.project_name || '',
      r.project_org || '',
      r.manager_name || '',
      r.plan_title || '',
      r.task_code || '',
      r.task_title || '',
      r.task_status || '',
      r.task_priority || '',
      (r.task_progress || 0) + '%',
      r.planned_start ? String(r.planned_start).slice(0, 10) : '',
      r.due_date ? String(r.due_date).slice(0, 10) : '',
      r.delay_days || 0,
      r.assignees_text || ''
    ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',');

    csvRows.push(line);
  }

  // Prepend UTF-8 Byte Order Mark (BOM) so Excel opens Arabic properly
  return '\uFEFF' + csvRows.join('\r\n');
}

module.exports = {
  getFilterMetadata,
  queryReports,
  exportReportsExcel,
  exportReportsCsv
};
