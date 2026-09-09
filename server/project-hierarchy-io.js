'use strict';

const ExcelJS = require('exceljs');

const ORG_MAP = {
  'wamy': 'wamy',
  'الندوة': 'wamy',
  'الندوة العالمية': 'wamy',
  'الندوة wamy': 'wamy',
  'imaan': 'imaan',
  'إمعان': 'imaan',
  'امعان': 'imaan'
};

const PROJECT_STATUS_MAP = {
  'planning': 'planning',
  'تخطيط': 'planning',
  'قيد التخطيط': 'planning',
  'active': 'active',
  'نشط': 'active',
  'on_hold': 'on_hold',
  'معلق': 'on_hold',
  'متوقف': 'on_hold',
  'completed': 'completed',
  'مكتمل': 'completed',
  'cancelled': 'cancelled',
  'ملغي': 'cancelled',
  'مؤرشف': 'cancelled'
};

const PROJECT_STATUS_LABELS = {
  'planning': 'قيد التخطيط',
  'active': 'نشط',
  'on_hold': 'معلق',
  'completed': 'مكتمل',
  'cancelled': 'ملغي'
};

const PRODUCT_STATUS_MAP = {
  'draft': 'draft',
  'مسودة': 'draft',
  'in_progress': 'in_progress',
  'قيد التنفيذ': 'in_progress',
  'in_review': 'in_review',
  'قيد المراجعة': 'in_review',
  'completed': 'completed',
  'مكتمل': 'completed',
  'approved': 'approved',
  'معتمد': 'approved',
  'cancelled': 'cancelled',
  'ملغي': 'cancelled',
  'archived': 'archived',
  'مؤرشف': 'archived'
};

const PRODUCT_STATUS_LABELS = {
  'draft': 'مسودة',
  'in_progress': 'قيد التنفيذ',
  'in_review': 'قيد المراجعة',
  'completed': 'مكتمل',
  'approved': 'معتمد',
  'cancelled': 'ملغي',
  'archived': 'مؤرشف'
};

const PLAN_STATUS_MAP = {
  'not_started': 'not_started',
  'لم تبدأ': 'not_started',
  'in_progress': 'in_progress',
  'قيد التنفيذ': 'in_progress',
  'completed': 'completed',
  'مكتملة': 'completed',
  'منجزة': 'completed',
  'approved': 'approved',
  'معتمدة': 'approved',
  'on_hold': 'on_hold',
  'معلقة': 'on_hold',
  'late': 'late',
  'متأخرة': 'late'
};

const PLAN_STATUS_LABELS = {
  'not_started': 'لم تبدأ',
  'in_progress': 'قيد التنفيذ',
  'completed': 'منجزة',
  'approved': 'معتمدة',
  'on_hold': 'معلقة',
  'late': 'متأخرة'
};

const PRIORITY_MAP = {
  'low': 'low',
  'منخفضة': 'low',
  'normal': 'normal',
  'عادية': 'normal',
  'urgent': 'urgent',
  'عاجلة': 'urgent',
  'critical': 'critical',
  'حرجة': 'critical'
};

const PRIORITY_LABELS = {
  'low': 'منخفضة',
  'normal': 'عادية',
  'urgent': 'عاجلة',
  'critical': 'حرجة'
};

function excelCellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value.text != null) return String(value.text).trim();
    if (value.result != null) return excelCellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(t => t.text).join('').trim();
    if (value instanceof Date) {
      const y = value.getFullYear();
      const m = String(value.getMonth() + 1).padStart(2, '0');
      const d = String(value.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return String(value).trim();
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const num = Number(str);
  if (!isNaN(num) && num > 20000 && num < 70000) {
    const date = new Date(Math.round((num - 25569) * 86400 * 1000));
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

// -------------------------------------------------------------
// 1. Template Generation
// -------------------------------------------------------------
async function generateTemplate(entity, { pool }) {
  const [
    { rows: projects },
    { rows: products },
    { rows: planItems },
    { rows: profiles }
  ] = await Promise.all([
    pool.query(`select id, code, hierarchical_code, name, org, status from projects where deleted_at is null order by coalesce(hierarchical_code, code)`),
    pool.query(`select id, code, hierarchical_code, name, project_id, org from products where deleted_at is null order by coalesce(hierarchical_code, code)`),
    pool.query(`select distinct track from master_plan_items where deleted_at is null and track is not null and trim(track) <> '' order by track`),
    pool.query(`select id, name, email from profiles where deleted_at is null and status='active' order by name`)
  ]);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WAMY Media Project Planner';
  workbook.created = new Date();

  if (entity === 'projects') {
    const sheet = workbook.addWorksheet('المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المشروع', key: 'code', width: 18 },
      { header: 'الرمز الهرمي', key: 'hierarchical_code', width: 18 },
      { header: 'اسم المشروع', key: 'name', width: 38 },
      { header: 'وصف المشروع', key: 'description', width: 44 },
      { header: 'الأهداف الاستراتيجية', key: 'objective', width: 40 },
      { header: 'الرؤية', key: 'vision', width: 34 },
      { header: 'الرسالة', key: 'mission', width: 34 },
      { header: 'الجهة المسؤولة', key: 'org', width: 18 },
      { header: 'البريد الإلكتروني لمدير المشروع', key: 'manager_email', width: 32 },
      { header: 'الحالة', key: 'status', width: 18 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 16 },
      { header: 'تاريخ النهاية', key: 'planned_end', width: 16 },
      { header: 'الميزانية', key: 'budget', width: 16 },
      { header: 'العملة', key: 'currency', width: 14 },
      { header: 'الملاحظات', key: 'source_notes', width: 36 }
    ];
    styleHeader(sheet, 'FF1E40AF');

    for (let r = 2; r <= 300; r++) {
      sheet.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$A$2:$A$3`] };
      sheet.getCell(`I${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'القوائم'!$C$2:$C$${Math.max(profiles.length + 1, 2)}`] };
      sheet.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$B$2:$B$6`] };
      sheet.getCell(`K${r}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`L${r}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`M${r}`).numFmt = '#,##0.00';
    }

    const lists = workbook.addWorksheet('القوائم', { state: 'veryHidden', views: [{ rightToLeft: true }] });
    lists.addRow(['الجهة', 'الحالة', 'البريد الإلكتروني للمدير', 'اسم المدير']);
    const maxLen = Math.max(2, 5, profiles.length);
    for (let i = 0; i < maxLen; i++) {
      lists.addRow([
        ['WAMY', 'إمعان'][i] || '',
        ['قيد التخطيط', 'نشط', 'معلق', 'مكتمل', 'ملغي'][i] || '',
        profiles[i] ? profiles[i].email : '',
        profiles[i] ? profiles[i].name : ''
      ]);
    }

    const instructions = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
    instructions.getColumn(1).width = 110;
    [
      'تعليمات تعبئة نموذج المشاريع:',
      '1. الحقول الإلزامية: رمز المشروع، اسم المشروع، الجهة المسؤولة، والحالة.',
      '2. الرمز الهرمي: يُستخدم لتوحيد الترميز الهرمي (مثال: PRJ-001)، وإذا تُرك فارغاً سيولّد النظام الرمز تلقائياً.',
      '3. البريد الإلكتروني لمدير المشروع: اختر من القائمة المنسدلة لمدراء النظام الفاعلين أو اتركه فارغاً.',
      '4. التواريخ: يجب أن تكون بصيغة YYYY-MM-DD وتاريخ النهاية بعد تاريخ البدء.',
      '5. عند الاستيراد، يمكنك اختيار تحديث المشاريع القائمة أو إضافة الجديد فقط وتجاهل المكرر.'
    ].forEach(t => instructions.addRow([t]));

  } else if (entity === 'project-plans') {
    const sheet = workbook.addWorksheet('خطط ومسارات المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز الخطة / المسار', key: 'plan_code', width: 22 },
      { header: 'اسم الخطة / المسار', key: 'title', width: 38 },
      { header: 'رمز المشروع المرتبط', key: 'project_code', width: 22 },
      { header: 'الوصف', key: 'description', width: 44 },
      { header: 'الجهة المسؤولة', key: 'responsible_org', width: 18 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 16 },
      { header: 'تاريخ الاستحقاق', key: 'planned_end', width: 16 },
      { header: 'الحالة', key: 'baseline_status', width: 18 },
      { header: 'الملاحظات', key: 'import_notes', width: 36 }
    ];
    styleHeader(sheet, 'FF7C3AED');

    const projectCodes = projects.map(p => p.hierarchical_code || p.code);
    for (let r = 2; r <= 300; r++) {
      sheet.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$A$2:$A$${Math.max(projectCodes.length + 1, 2)}`] };
      sheet.getCell(`E${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$B$2:$B$3`] };
      sheet.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$C$2:$C$7`] };
      sheet.getCell(`F${r}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`G${r}`).numFmt = 'yyyy-mm-dd';
    }

    const lists = workbook.addWorksheet('القوائم', { state: 'veryHidden', views: [{ rightToLeft: true }] });
    lists.addRow(['رمز المشروع', 'الجهة', 'الحالة']);
    const maxLen = Math.max(projectCodes.length, 3, 6);
    for (let i = 0; i < maxLen; i++) {
      lists.addRow([
        projectCodes[i] || '',
        ['WAMY', 'إمعان'][i] || '',
        ['لم تبدأ', 'قيد التنفيذ', 'مكتملة', 'معتمدة', 'معلقة', 'متأخرة'][i] || ''
      ]);
    }

    const instructions = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
    instructions.getColumn(1).width = 110;
    [
      'تعليمات تعبئة نموذج خطط ومسارات المشاريع:',
      '1. الحقول الإلزامية: رمز الخطة/المسار (مثال: PRJ-001-PLN-01)، اسم الخطة/المسار، ورمز المشروع المرتبط.',
      '2. رمز المشروع المرتبط: اختر الرمز المعتمد للمشروع من القائمة المنسدلة (يجب أن يكون المشروع مسجلاً بالنظام).',
      '3. التواريخ: صيغة YYYY-MM-DD.',
      '4. يدعم النظام الحفاظ على التسلسل الهرمي للمشروع وربط مخرجاته بالمسار المناسب.'
    ].forEach(t => instructions.addRow([t]));

  } else if (entity === 'project-products') {
    const sheet = workbook.addWorksheet('منتجات ومخرجات المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المنتج', key: 'product_code', width: 24 },
      { header: 'اسم المنتج', key: 'name', width: 38 },
      { header: 'رمز المشروع', key: 'project_code', width: 20 },
      { header: 'رمز الخطة / المسار', key: 'plan_track', width: 24 },
      { header: 'الوصف', key: 'content', width: 44 },
      { header: 'المخرجات المطلوبة', key: 'target_output', width: 34 },
      { header: 'الكمية المستهدفة', key: 'target_qty', width: 16 },
      { header: 'الجهة المسؤولة', key: 'org', width: 18 },
      { header: 'البريد الإلكتروني لمسؤول المتابعة', key: 'manager_email', width: 32 },
      { header: 'تاريخ البدء', key: 'start_date', width: 16 },
      { header: 'تاريخ الاستحقاق', key: 'due_date', width: 16 },
      { header: 'الحالة', key: 'status', width: 18 },
      { header: 'السماح بمهام متعددة', key: 'allow_multiple_tasks', width: 20 },
      { header: 'الملاحظات', key: 'notes', width: 36 }
    ];
    styleHeader(sheet, 'FF059669');

    const projectCodes = projects.map(p => p.hierarchical_code || p.code);
    const trackNames = planItems.map(t => t.track);
    for (let r = 2; r <= 300; r++) {
      sheet.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$A$2:$A$${Math.max(projectCodes.length + 1, 2)}`] };
      sheet.getCell(`H${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$B$2:$B$3`] };
      sheet.getCell(`I${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'القوائم'!$C$2:$C$${Math.max(profiles.length + 1, 2)}`] };
      sheet.getCell(`L${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$D$2:$D$8`] };
      sheet.getCell(`M${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$E$2:$E$3`] };
      sheet.getCell(`J${r}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`K${r}`).numFmt = 'yyyy-mm-dd';
    }

    const lists = workbook.addWorksheet('القوائم', { state: 'veryHidden', views: [{ rightToLeft: true }] });
    lists.addRow(['رمز المشروع', 'الجهة', 'البريد الإلكتروني للمسؤول', 'الحالة', 'السماح بمهام متعددة', 'المسار / الخطة']);
    const maxLen = Math.max(projectCodes.length, profiles.length, trackNames.length, 8);
    for (let i = 0; i < maxLen; i++) {
      lists.addRow([
        projectCodes[i] || '',
        ['WAMY', 'إمعان'][i] || '',
        profiles[i] ? profiles[i].email : '',
        ['مسودة', 'قيد التنفيذ', 'قيد المراجعة', 'مكتمل', 'معتمد', 'ملغي', 'مؤرشف'][i] || '',
        ['نعم', 'لا'][i] || '',
        trackNames[i] || ''
      ]);
    }

    const instructions = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
    instructions.getColumn(1).width = 110;
    [
      'تعليمات تعبئة نموذج منتجات ومخرجات المشاريع:',
      '1. الحقول الإلزامية: رمز المنتج (مثال: PRJ-001-PLN-01-PRD-001)، اسم المنتج، رمز المشروع، والجهة المسؤولة.',
      '2. رمز الخطة / المسار: اختياري، يُستخدم لربط المنتج بمسار أو خطة محددة ضمن المشروع.',
      '3. السماح بمهام متعددة: اختر «نعم» إذا كان المنتج يتطلب عدة مهام تنفيذية متوازية.',
      '4. عند الاستيراد، سيتحقق النظام من صحة رمز المشروع وتبعية المنتج له.'
    ].forEach(t => instructions.addRow([t]));

  } else if (entity === 'project-phases') {
    const sheet = workbook.addWorksheet('مراحل ومعالم المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المرحلة / المعلم', key: 'phase_code', width: 28 },
      { header: 'اسم المرحلة / المعلم', key: 'title', width: 38 },
      { header: 'النوع', key: 'item_type', width: 18 },
      { header: 'رمز المشروع', key: 'project_code', width: 20 },
      { header: 'رمز الخطة / المسار', key: 'track', width: 24 },
      { header: 'رمز المنتج المرتبط', key: 'product_code', width: 26 },
      { header: 'الوصف', key: 'description', width: 44 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 16 },
      { header: 'تاريخ الاستحقاق', key: 'planned_end', width: 16 },
      { header: 'المدة بالأيام', key: 'duration', width: 16 },
      { header: 'الجهة المسؤولة', key: 'responsible_org', width: 18 },
      { header: 'الأولوية', key: 'priority', width: 16 },
      { header: 'الحالة', key: 'baseline_status', width: 18 },
      { header: 'الملاحظات', key: 'import_notes', width: 36 }
    ];
    styleHeader(sheet, 'FFD97706');

    const projectCodes = projects.map(p => p.hierarchical_code || p.code);
    const productCodes = products.map(p => p.hierarchical_code || p.code);
    for (let r = 2; r <= 300; r++) {
      sheet.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$A$2:$A$4`] };
      sheet.getCell(`D${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$B$2:$B$${Math.max(projectCodes.length + 1, 2)}`] };
      sheet.getCell(`F${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'القوائم'!$C$2:$C$${Math.max(productCodes.length + 1, 2)}`] };
      sheet.getCell(`K${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$D$2:$D$3`] };
      sheet.getCell(`L${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$E$2:$E$5`] };
      sheet.getCell(`M${r}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`'القوائم'!$F$2:$F$6`] };
      sheet.getCell(`H${r}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`I${r}`).numFmt = 'yyyy-mm-dd';
      sheet.getCell(`J${r}`).numFmt = '#,##0';
    }

    const lists = workbook.addWorksheet('القوائم', { state: 'veryHidden', views: [{ rightToLeft: true }] });
    lists.addRow(['النوع', 'رمز المشروع', 'رمز المنتج', 'الجهة', 'الأولوية', 'الحالة']);
    const maxLen = Math.max(3, projectCodes.length, productCodes.length, 6);
    for (let i = 0; i < maxLen; i++) {
      lists.addRow([
        ['مرحلة تنفيذ', 'معلم رئيسي', 'معلم اعتماد'][i] || '',
        projectCodes[i] || '',
        productCodes[i] || '',
        ['WAMY', 'إمعان'][i] || '',
        ['منخفضة', 'عادية', 'عاجلة', 'حرجة'][i] || '',
        ['لم تبدأ', 'قيد التنفيذ', 'منجزة', 'معتمدة', 'معلقة'][i] || ''
      ]);
    }

    const instructions = workbook.addWorksheet('تعليمات', { views: [{ rightToLeft: true }] });
    instructions.getColumn(1).width = 110;
    [
      'تعليمات تعبئة نموذج مراحل ومعالم المشاريع:',
      '1. الحقول الإلزامية: رمز المرحلة/المعلم (مثال: PRJ-001-PLN-01-PRD-001-PHS-01)، اسم المرحلة/المعلم، النوع، ورمز المشروع.',
      '2. النوع: مرحلة تنفيذ، معلم رئيسي، أو معلم اعتماد.',
      '3. رمز المنتج المرتبط: اختر رمز المنتج المعتمد الذي تتبع له هذه المرحلة/المعلم.',
      '4. التواريخ والمدد: صيغة YYYY-MM-DD وتحديد عدد الأيام التقديرية.',
      '5. يضمن الاستيراد ربط المرحلة بالمنتج والخطة والمشروع بالتسلسل الصحيح.'
    ].forEach(t => instructions.addRow([t]));
  }

  return workbook.xlsx.writeBuffer();
}

function styleHeader(sheet, argbColor) {
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argbColor } };
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(1).height = 28;
  sheet.autoFilter = `A1:${sheet.columns[sheet.columns.length - 1].letter}1`;
}

// -------------------------------------------------------------
// 2. Data Export
// -------------------------------------------------------------
async function exportData(entity, { pool }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WAMY Media Project Planner';
  workbook.created = new Date();

  if (entity === 'projects') {
    const { rows } = await pool.query(`
      select p.*,
             mgr.name as manager_name,
             mgr.email as manager_email,
             count(distinct prds.id)::int as products_count,
             count(distinct t.id)::int as tasks_count
        from projects p
        left join profiles mgr on mgr.id = p.manager_id
        left join products prds on prds.project_id = p.id and prds.deleted_at is null
        left join tasks t on t.project_id = p.id and t.deleted_at is null
       where p.deleted_at is null
       group by p.id, mgr.name, mgr.email
       order by coalesce(p.hierarchical_code, p.code)
    `);

    const sheet = workbook.addWorksheet('المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المشروع', key: 'code', width: 18 },
      { header: 'الرمز الهرمي', key: 'hierarchical_code', width: 18 },
      { header: 'اسم المشروع', key: 'name', width: 38 },
      { header: 'وصف المشروع', key: 'description', width: 44 },
      { header: 'الأهداف الاستراتيجية', key: 'objective', width: 40 },
      { header: 'الرؤية', key: 'vision', width: 34 },
      { header: 'الرسالة', key: 'mission', width: 34 },
      { header: 'الجهة المسؤولة', key: 'org', width: 18 },
      { header: 'البريد الإلكتروني لمدير المشروع', key: 'manager_email', width: 32 },
      { header: 'الحالة', key: 'status', width: 18 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 16 },
      { header: 'تاريخ النهاية', key: 'planned_end', width: 16 },
      { header: 'الميزانية', key: 'budget', width: 16 },
      { header: 'العملة', key: 'currency', width: 14 },
      { header: 'الملاحظات', key: 'source_notes', width: 36 }
    ];
    styleHeader(sheet, 'FF1E40AF');

    rows.forEach(p => {
      sheet.addRow({
        code: p.code,
        hierarchical_code: p.hierarchical_code || p.code,
        name: p.name,
        description: p.description || '',
        objective: p.objective || '',
        vision: p.vision || '',
        mission: p.mission || '',
        org: p.org === 'imaan' ? 'إمعان' : 'WAMY',
        manager_email: p.manager_email || '',
        status: PROJECT_STATUS_LABELS[p.status] || p.status,
        planned_start: p.planned_start ? new Date(p.planned_start) : null,
        planned_end: p.planned_end ? new Date(p.planned_end) : null,
        budget: p.budget != null ? Number(p.budget) : null,
        currency: p.currency || 'SAR',
        source_notes: p.source_notes || ''
      });
    });

  } else if (entity === 'project-plans') {
    const { rows } = await pool.query(`
      select m.*,
             p.code as project_code,
             coalesce(p.hierarchical_code, p.code) as project_hcode
        from master_plan_items m
        join projects p on p.id = m.project_id and p.deleted_at is null
       where m.deleted_at is null
       order by coalesce(p.hierarchical_code, p.code), coalesce(m.track, ''), coalesce(m.planned_start, '2099-01-01')
    `);

    const sheet = workbook.addWorksheet('خطط ومسارات المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز الخطة / المسار', key: 'plan_code', width: 22 },
      { header: 'اسم الخطة / المسار', key: 'title', width: 38 },
      { header: 'رمز المشروع المرتبط', key: 'project_code', width: 22 },
      { header: 'الوصف', key: 'description', width: 44 },
      { header: 'الجهة المسؤولة', key: 'responsible_org', width: 18 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 16 },
      { header: 'تاريخ الاستحقاق', key: 'planned_end', width: 16 },
      { header: 'الحالة', key: 'baseline_status', width: 18 },
      { header: 'الملاحظات', key: 'import_notes', width: 36 }
    ];
    styleHeader(sheet, 'FF7C3AED');

    rows.forEach(m => {
      sheet.addRow({
        plan_code: m.hierarchical_code || m.external_id,
        title: m.track || m.title,
        project_code: m.project_hcode || m.project_code,
        description: m.description || m.content || '',
        responsible_org: m.responsible_org || (m.org === 'imaan' ? 'إمعان' : 'WAMY'),
        planned_start: m.planned_start ? new Date(m.planned_start) : null,
        planned_end: m.planned_end ? new Date(m.planned_end) : null,
        baseline_status: PLAN_STATUS_LABELS[m.baseline_status] || m.baseline_status || 'لم تبدأ',
        import_notes: m.import_notes || ''
      });
    });

  } else if (entity === 'project-products') {
    const { rows } = await pool.query(`
      select p.*,
             pr.code as project_code,
             coalesce(pr.hierarchical_code, pr.code) as project_hcode,
             mgr.email as manager_email
        from products p
        left join projects pr on pr.id = p.project_id and pr.deleted_at is null
        left join profiles mgr on mgr.id = p.manager_id
       where p.deleted_at is null
       order by coalesce(p.hierarchical_code, p.code)
    `);

    const sheet = workbook.addWorksheet('منتجات ومخرجات المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المنتج', key: 'product_code', width: 24 },
      { header: 'اسم المنتج', key: 'name', width: 38 },
      { header: 'رمز المشروع', key: 'project_code', width: 20 },
      { header: 'رمز الخطة / المسار', key: 'plan_track', width: 24 },
      { header: 'الوصف', key: 'content', width: 44 },
      { header: 'المخرجات المطلوبة', key: 'target_output', width: 34 },
      { header: 'الكمية المستهدفة', key: 'target_qty', width: 16 },
      { header: 'الجهة المسؤولة', key: 'org', width: 18 },
      { header: 'البريد الإلكتروني لمسؤول المتابعة', key: 'manager_email', width: 32 },
      { header: 'تاريخ البدء', key: 'start_date', width: 16 },
      { header: 'تاريخ الاستحقاق', key: 'due_date', width: 16 },
      { header: 'الحالة', key: 'status', width: 18 },
      { header: 'السماح بمهام متعددة', key: 'allow_multiple_tasks', width: 20 },
      { header: 'الملاحظات', key: 'notes', width: 36 }
    ];
    styleHeader(sheet, 'FF059669');

    rows.forEach(p => {
      sheet.addRow({
        product_code: p.hierarchical_code || p.code,
        name: p.name,
        project_code: p.project_hcode || p.project_code || '',
        plan_track: p.plan_track || '',
        content: p.content || '',
        target_output: p.target_output || '',
        target_qty: p.target_qty || '',
        org: p.org === 'imaan' ? 'إمعان' : 'WAMY',
        manager_email: p.manager_email || '',
        start_date: p.start_date ? new Date(p.start_date) : null,
        due_date: p.due_date ? new Date(p.due_date) : null,
        status: PRODUCT_STATUS_LABELS[p.status] || p.status,
        allow_multiple_tasks: p.allow_multiple_tasks ? 'نعم' : 'لا',
        notes: p.notes || ''
      });
    });

  } else if (entity === 'project-phases') {
    const { rows } = await pool.query(`
      select m.*,
             pr.code as project_code,
             coalesce(pr.hierarchical_code, pr.code) as project_hcode,
             p.code as product_code,
             coalesce(p.hierarchical_code, p.code) as product_hcode
        from master_plan_items m
        join projects pr on pr.id = m.project_id and pr.deleted_at is null
        left join products p on p.project_id = pr.id and p.deleted_at is null and (
          lower(trim(p.name)) = lower(trim(m.title))
          or (m.phase is not null and lower(trim(p.name)) like '%' || lower(trim(m.phase)) || '%')
        )
       where m.deleted_at is null
         and (
           m.item_type in ('مرحلة تنفيذ', 'معلم رئيسي', 'معلم اعتماد', 'مرحلة/خطة', 'مرحلة/مشروع')
           or lower(coalesce(m.item_type, '')) like '%مرحلة%'
           or lower(coalesce(m.item_type, '')) like '%معلم%'
         )
       order by coalesce(pr.hierarchical_code, pr.code), coalesce(m.track, ''), m.planned_start nulls last
    `);

    const sheet = workbook.addWorksheet('مراحل ومعالم المشاريع', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'رمز المرحلة / المعلم', key: 'phase_code', width: 28 },
      { header: 'اسم المرحلة / المعلم', key: 'title', width: 38 },
      { header: 'النوع', key: 'item_type', width: 18 },
      { header: 'رمز المشروع', key: 'project_code', width: 20 },
      { header: 'رمز الخطة / المسار', key: 'track', width: 24 },
      { header: 'رمز المنتج المرتبط', key: 'product_code', width: 26 },
      { header: 'الوصف', key: 'description', width: 44 },
      { header: 'تاريخ البدء', key: 'planned_start', width: 16 },
      { header: 'تاريخ الاستحقاق', key: 'planned_end', width: 16 },
      { header: 'المدة بالأيام', key: 'duration', width: 16 },
      { header: 'الجهة المسؤولة', key: 'responsible_org', width: 18 },
      { header: 'الأولوية', key: 'priority', width: 16 },
      { header: 'الحالة', key: 'baseline_status', width: 18 },
      { header: 'الملاحظات', key: 'import_notes', width: 36 }
    ];
    styleHeader(sheet, 'FFD97706');

    rows.forEach(m => {
      sheet.addRow({
        phase_code: m.hierarchical_code || m.external_id,
        title: m.title,
        item_type: m.item_type || 'مرحلة تنفيذ',
        project_code: m.project_hcode || m.project_code,
        track: m.track || '',
        product_code: m.product_hcode || m.product_code || '',
        description: m.description || m.content || '',
        planned_start: m.planned_start ? new Date(m.planned_start) : null,
        planned_end: m.planned_end ? new Date(m.planned_end) : null,
        duration: m.duration != null ? Number(m.duration) : null,
        responsible_org: m.responsible_org || (m.org === 'imaan' ? 'إمعان' : 'WAMY'),
        priority: PRIORITY_LABELS[m.priority] || m.priority || 'عادية',
        baseline_status: PLAN_STATUS_LABELS[m.baseline_status] || m.baseline_status || 'لم تبدأ',
        import_notes: m.import_notes || ''
      });
    });
  }

  return workbook.xlsx.writeBuffer();
}

// -------------------------------------------------------------
// 3. Preview & Validation
// -------------------------------------------------------------
async function previewImport(entity, fileBuffer, { pool }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('الملف لا يحتوي على ورقة عمل صالحة.');

  const [
    { rows: existingProjects },
    { rows: existingProducts },
    { rows: existingPlanItems },
    { rows: activeProfiles }
  ] = await Promise.all([
    pool.query(`select id, code, hierarchical_code, name from projects where deleted_at is null`),
    pool.query(`select id, code, hierarchical_code, name, project_id from products where deleted_at is null`),
    pool.query(`select id, external_id, hierarchical_code, project_id, track from master_plan_items where deleted_at is null`),
    pool.query(`select id, name, email from profiles where deleted_at is null and status='active'`)
  ]);

  const projectByCode = new Map();
  existingProjects.forEach(p => {
    if (p.code) projectByCode.set(p.code.toLowerCase(), p);
    if (p.hierarchical_code) projectByCode.set(p.hierarchical_code.toLowerCase(), p);
  });

  const productByCode = new Map();
  existingProducts.forEach(p => {
    if (p.code) productByCode.set(p.code.toLowerCase(), p);
    if (p.hierarchical_code) productByCode.set(p.hierarchical_code.toLowerCase(), p);
  });

  const planItemByCode = new Map();
  existingPlanItems.forEach(i => {
    if (i.external_id) planItemByCode.set(`${i.project_id}:${i.external_id.toLowerCase()}`, i);
    if (i.hierarchical_code) planItemByCode.set(`${i.project_id}:${i.hierarchical_code.toLowerCase()}`, i);
  });

  const profileByEmail = new Map();
  activeProfiles.forEach(u => profileByEmail.set(u.email.toLowerCase(), u));

  const parsedRows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = Array.from({ length: 20 }, (_, i) => excelCellText(row.getCell(i + 1).value));
    if (!values.some(v => v !== '')) return;

    const rowObj = { row_number: rowNumber, valid: true, errors: [], duplicate: false, entity };

    if (entity === 'projects') {
      rowObj.code = values[0];
      rowObj.hierarchical_code = values[1] || rowObj.code;
      rowObj.name = values[2];
      rowObj.description = values[3];
      rowObj.objective = values[4];
      rowObj.vision = values[5];
      rowObj.mission = values[6];
      rowObj.org_raw = values[7];
      rowObj.manager_email = values[8];
      rowObj.status_raw = values[9];
      rowObj.planned_start = parseDate(values[10]);
      rowObj.planned_end = parseDate(values[11]);
      rowObj.budget = values[12] ? Number(String(values[12]).replace(/[^0-9.-]+/g, '')) : null;
      rowObj.currency = values[13] || 'SAR';
      rowObj.source_notes = values[14];

      if (!rowObj.code) rowObj.errors.push('رمز المشروع مطلوب.');
      if (!rowObj.name) rowObj.errors.push('اسم المشروع مطلوب.');
      rowObj.org = ORG_MAP[String(rowObj.org_raw || '').toLowerCase()] || 'wamy';
      rowObj.status = PROJECT_STATUS_MAP[String(rowObj.status_raw || '').toLowerCase()] || 'planning';
      if (rowObj.manager_email && !profileByEmail.has(rowObj.manager_email.toLowerCase())) {
        rowObj.errors.push(`بريد مدير المشروع (${rowObj.manager_email}) غير مسجل كمستخدم نشط.`);
      } else if (rowObj.manager_email) {
        rowObj.manager_id = profileByEmail.get(rowObj.manager_email.toLowerCase()).id;
      }
      if (rowObj.planned_start && rowObj.planned_end && rowObj.planned_end < rowObj.planned_start) {
        rowObj.errors.push('تاريخ النهاية لا يمكن أن يسبق تاريخ البدء.');
      }
      const existing = (rowObj.code && projectByCode.get(rowObj.code.toLowerCase())) ||
                       (rowObj.hierarchical_code && projectByCode.get(rowObj.hierarchical_code.toLowerCase()));
      if (existing) {
        rowObj.duplicate = true;
        rowObj.existing_id = existing.id;
      }

    } else if (entity === 'project-plans') {
      rowObj.plan_code = values[0];
      rowObj.title = values[1];
      rowObj.project_code = values[2];
      rowObj.description = values[3];
      rowObj.org_raw = values[4];
      rowObj.planned_start = parseDate(values[5]);
      rowObj.planned_end = parseDate(values[6]);
      rowObj.status_raw = values[7];
      rowObj.import_notes = values[8];

      if (!rowObj.plan_code) rowObj.errors.push('رمز الخطة / المسار مطلوب.');
      if (!rowObj.title) rowObj.errors.push('اسم الخطة / المسار مطلوب.');
      if (!rowObj.project_code) {
        rowObj.errors.push('رمز المشروع المرتبط مطلوب.');
      } else {
        const proj = projectByCode.get(rowObj.project_code.toLowerCase());
        if (!proj) {
          rowObj.errors.push(`المشروع برمز (${rowObj.project_code}) غير موجود بالنظام.`);
        } else {
          rowObj.project_id = proj.id;
          const existing = planItemByCode.get(`${proj.id}:${rowObj.plan_code.toLowerCase()}`);
          if (existing) {
            rowObj.duplicate = true;
            rowObj.existing_id = existing.id;
          }
        }
      }
      rowObj.responsible_org = ORG_MAP[String(rowObj.org_raw || '').toLowerCase()] === 'imaan' ? 'إمعان' : 'WAMY';
      rowObj.baseline_status = PLAN_STATUS_MAP[String(rowObj.status_raw || '').toLowerCase()] || 'not_started';
      if (rowObj.planned_start && rowObj.planned_end && rowObj.planned_end < rowObj.planned_start) {
        rowObj.errors.push('تاريخ الاستحقاق لا يمكن أن يسبق تاريخ البدء.');
      }

    } else if (entity === 'project-products') {
      rowObj.product_code = values[0];
      rowObj.name = values[1];
      rowObj.project_code = values[2];
      rowObj.plan_track = values[3];
      rowObj.content = values[4];
      rowObj.target_output = values[5];
      rowObj.target_qty = values[6];
      rowObj.org_raw = values[7];
      rowObj.manager_email = values[8];
      rowObj.start_date = parseDate(values[9]);
      rowObj.due_date = parseDate(values[10]);
      rowObj.status_raw = values[11];
      rowObj.allow_multiple_tasks = /نعم|yes|true|1/i.test(values[12]);
      rowObj.notes = values[13];

      if (!rowObj.product_code) rowObj.errors.push('رمز المنتج مطلوب.');
      if (!rowObj.name) rowObj.errors.push('اسم المنتج مطلوب.');
      if (!rowObj.project_code) {
        rowObj.errors.push('رمز المشروع المرتبط مطلوب.');
      } else {
        const proj = projectByCode.get(rowObj.project_code.toLowerCase());
        if (!proj) {
          rowObj.errors.push(`المشروع برمز (${rowObj.project_code}) غير موجود بالنظام.`);
        } else {
          rowObj.project_id = proj.id;
        }
      }
      rowObj.org = ORG_MAP[String(rowObj.org_raw || '').toLowerCase()] || 'wamy';
      rowObj.status = PRODUCT_STATUS_MAP[String(rowObj.status_raw || '').toLowerCase()] || 'draft';
      if (rowObj.manager_email && !profileByEmail.has(rowObj.manager_email.toLowerCase())) {
        rowObj.errors.push(`بريد المسؤول (${rowObj.manager_email}) غير مسجل كمستخدم نشط.`);
      } else if (rowObj.manager_email) {
        rowObj.manager_id = profileByEmail.get(rowObj.manager_email.toLowerCase()).id;
      }
      if (rowObj.start_date && rowObj.due_date && rowObj.due_date < rowObj.start_date) {
        rowObj.errors.push('تاريخ الاستحقاق لا يمكن أن يسبق تاريخ البدء.');
      }
      const existing = productByCode.get(rowObj.product_code.toLowerCase());
      if (existing) {
        rowObj.duplicate = true;
        rowObj.existing_id = existing.id;
      }

    } else if (entity === 'project-phases') {
      rowObj.phase_code = values[0];
      rowObj.title = values[1];
      rowObj.item_type = values[2] || 'مرحلة تنفيذ';
      rowObj.project_code = values[3];
      rowObj.track = values[4];
      rowObj.product_code = values[5];
      rowObj.description = values[6];
      rowObj.planned_start = parseDate(values[7]);
      rowObj.planned_end = parseDate(values[8]);
      rowObj.duration = values[9] ? Number(String(values[9]).replace(/[^0-9.-]+/g, '')) : null;
      rowObj.org_raw = values[10];
      rowObj.priority_raw = values[11];
      rowObj.status_raw = values[12];
      rowObj.import_notes = values[13];

      if (!rowObj.phase_code) rowObj.errors.push('رمز المرحلة / المعلم مطلوب.');
      if (!rowObj.title) rowObj.errors.push('اسم المرحلة / المعلم مطلوب.');
      if (!rowObj.project_code) {
        rowObj.errors.push('رمز المشروع مطلوب.');
      } else {
        const proj = projectByCode.get(rowObj.project_code.toLowerCase());
        if (!proj) {
          rowObj.errors.push(`المشروع برمز (${rowObj.project_code}) غير موجود بالنظام.`);
        } else {
          rowObj.project_id = proj.id;
          const existing = planItemByCode.get(`${proj.id}:${rowObj.phase_code.toLowerCase()}`);
          if (existing) {
            rowObj.duplicate = true;
            rowObj.existing_id = existing.id;
          }
        }
      }
      if (rowObj.product_code) {
        const prd = productByCode.get(rowObj.product_code.toLowerCase());
        if (prd) {
          rowObj.product_id = prd.id;
          if (rowObj.project_id && prd.project_id && prd.project_id !== rowObj.project_id) {
            rowObj.errors.push(`المنتج (${rowObj.product_code}) لا يتبع للمشروع (${rowObj.project_code}).`);
          }
        }
      }
      rowObj.responsible_org = ORG_MAP[String(rowObj.org_raw || '').toLowerCase()] === 'imaan' ? 'إمعان' : 'WAMY';
      rowObj.priority = PRIORITY_MAP[String(rowObj.priority_raw || '').toLowerCase()] || 'normal';
      rowObj.baseline_status = PLAN_STATUS_MAP[String(rowObj.status_raw || '').toLowerCase()] || 'not_started';
      if (rowObj.planned_start && rowObj.planned_end && rowObj.planned_end < rowObj.planned_start) {
        rowObj.errors.push('تاريخ الاستحقاق لا يمكن أن يسبق تاريخ البدء.');
      }
    }

    if (rowObj.errors.length > 0) rowObj.valid = false;
    parsedRows.push(rowObj);
  });

  return {
    entity,
    rows: parsedRows,
    summary: {
      total: parsedRows.length,
      valid: parsedRows.filter(r => r.valid).length,
      invalid: parsedRows.filter(r => !r.valid).length,
      duplicates: parsedRows.filter(r => r.duplicate).length
    }
  };
}

// -------------------------------------------------------------
// 4. Commit Import Transaction
// -------------------------------------------------------------
async function commitImport(entity, { rows, mode }, { pool, user, req, writeAudit }) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('لا توجد صفوف صالحة للاستيراد.');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.valid && mode !== 'ignore_errors') continue;

      if (entity === 'projects') {
        if (row.duplicate) {
          if (mode === 'add_only' || mode === 'skip_duplicates') {
            skipped += 1;
            continue;
          }
          if (mode === 'update_existing' && row.existing_id) {
            await client.query(`
              update projects
                 set name = coalesce($1, name),
                     description = coalesce($2, description),
                     objective = coalesce($3, objective),
                     vision = coalesce($4, vision),
                     mission = coalesce($5, mission),
                     org = coalesce($6, org),
                     manager_id = coalesce($7, manager_id),
                     planned_start = coalesce($8, planned_start),
                     planned_end = coalesce($9, planned_end),
                     status = coalesce($10, status),
                     budget = coalesce($11, budget),
                     currency = coalesce($12, currency),
                     source_notes = coalesce($13, source_notes),
                     updated_at = now()
               where id = $14
            `, [
              row.name, row.description, row.objective, row.vision, row.mission,
              row.org, row.manager_id, row.planned_start, row.planned_end,
              row.status, row.budget, row.currency, row.source_notes, row.existing_id
            ]);
            updated += 1;
            continue;
          }
        }

        const hierarchicalCode = row.hierarchical_code || row.code;
        await client.query(`
          insert into projects (code, hierarchical_code, name, description, objective, vision, mission, org, manager_id, planned_start, planned_end, status, budget, currency, source_notes, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [
          row.code, hierarchicalCode, row.name, row.description, row.objective,
          row.vision, row.mission, row.org, row.manager_id, row.planned_start, row.planned_end,
          row.status, row.budget, row.currency, row.source_notes, user.id
        ]);
        inserted += 1;

      } else if (entity === 'project-plans') {
        if (row.duplicate) {
          if (mode === 'add_only' || mode === 'skip_duplicates') {
            skipped += 1;
            continue;
          }
          if (mode === 'update_existing' && row.existing_id) {
            await client.query(`
              update master_plan_items
                 set title = coalesce($1, title),
                     track = coalesce($1, track),
                     description = coalesce($2, description),
                     responsible_org = coalesce($3, responsible_org),
                     planned_start = coalesce($4, planned_start),
                     planned_end = coalesce($5, planned_end),
                     baseline_status = coalesce($6, baseline_status),
                     import_notes = coalesce($7, import_notes),
                     updated_at = now()
               where id = $8
            `, [
              row.title, row.description, row.responsible_org, row.planned_start, row.planned_end,
              row.baseline_status, row.import_notes, row.existing_id
            ]);
            updated += 1;
            continue;
          }
        }

        await client.query(`
          insert into master_plan_items (project_id, external_id, hierarchical_code, item_type, track, title, description, responsible_org, planned_start, planned_end, baseline_status, import_notes)
          values ($1, $2, $3, 'خطة/مسار', $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (project_id, external_id) do update
             set title = excluded.title,
                 track = excluded.track,
                 description = excluded.description,
                 responsible_org = excluded.responsible_org,
                 planned_start = excluded.planned_start,
                 planned_end = excluded.planned_end,
                 baseline_status = excluded.baseline_status,
                 import_notes = excluded.import_notes,
                 updated_at = now()
        `, [
          row.project_id, row.plan_code, row.plan_code, row.title, row.title, row.description,
          row.responsible_org, row.planned_start, row.planned_end, row.baseline_status, row.import_notes
        ]);
        inserted += 1;

      } else if (entity === 'project-products') {
        if (row.duplicate) {
          if (mode === 'add_only' || mode === 'skip_duplicates') {
            skipped += 1;
            continue;
          }
          const finalContent = row.content || row.notes || null;
          if (mode === 'update_existing' && row.existing_id) {
            await client.query(`
              update products
                 set name = coalesce($1, name),
                     plan_track = coalesce($2, plan_track),
                     content = coalesce($3, content),
                     target_qty = coalesce($4, target_qty),
                     org = coalesce($5, org),
                     manager_id = coalesce($6, manager_id),
                     start_date = coalesce($7, start_date),
                     due_date = coalesce($8, due_date),
                     status = coalesce($9, status),
                     allow_multiple_tasks = coalesce($10, allow_multiple_tasks),
                     updated_at = now()
               where id = $11
            `, [
              row.name, row.plan_track, finalContent, row.target_qty, row.org, row.manager_id,
              row.start_date, row.due_date, row.status, row.allow_multiple_tasks, row.existing_id
            ]);
            updated += 1;
            continue;
          }
        }

        const hierarchicalCode = row.product_code;
        const finalContent = row.content || row.notes || null;
        await client.query(`
          insert into products (code, hierarchical_code, project_id, plan_track, name, content, target_qty, org, manager_id, start_date, due_date, status, allow_multiple_tasks)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          on conflict (code) do update
             set name = excluded.name,
                 project_id = excluded.project_id,
                 plan_track = excluded.plan_track,
                 content = excluded.content,
                 target_qty = excluded.target_qty,
                 org = excluded.org,
                 manager_id = excluded.manager_id,
                 start_date = excluded.start_date,
                 due_date = excluded.due_date,
                 status = excluded.status,
                 allow_multiple_tasks = excluded.allow_multiple_tasks,
                 updated_at = now()
        `, [
          row.product_code, hierarchicalCode, row.project_id, row.plan_track, row.name,
          finalContent, row.target_qty, row.org, row.manager_id, row.start_date, row.due_date,
          row.status, row.allow_multiple_tasks
        ]);
        inserted += 1;

      } else if (entity === 'project-phases') {
        if (row.duplicate) {
          if (mode === 'add_only' || mode === 'skip_duplicates') {
            skipped += 1;
            continue;
          }
          if (mode === 'update_existing' && row.existing_id) {
            await client.query(`
              update master_plan_items
                 set title = coalesce($1, title),
                     item_type = coalesce($2, item_type),
                     track = coalesce($3, track),
                     description = coalesce($4, description),
                     planned_start = coalesce($5, planned_start),
                     planned_end = coalesce($6, planned_end),
                     duration = coalesce($7, duration),
                     responsible_org = coalesce($8, responsible_org),
                     priority = coalesce($9, priority),
                     baseline_status = coalesce($10, baseline_status),
                     import_notes = coalesce($11, import_notes),
                     updated_at = now()
               where id = $12
            `, [
              row.title, row.item_type, row.track, row.description, row.planned_start, row.planned_end,
              row.duration, row.responsible_org, row.priority, row.baseline_status, row.import_notes, row.existing_id
            ]);
            updated += 1;
            continue;
          }
        }

        await client.query(`
          insert into master_plan_items (project_id, external_id, hierarchical_code, title, item_type, track, description, planned_start, planned_end, duration, responsible_org, priority, baseline_status, import_notes)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          on conflict (project_id, external_id) do update
             set title = excluded.title,
                 item_type = excluded.item_type,
                 track = excluded.track,
                 description = excluded.description,
                 planned_start = excluded.planned_start,
                 planned_end = excluded.planned_end,
                 duration = excluded.duration,
                 responsible_org = excluded.responsible_org,
                 priority = excluded.priority,
                 baseline_status = excluded.baseline_status,
                 import_notes = excluded.import_notes,
                 updated_at = now()
        `, [
          row.project_id, row.phase_code, row.phase_code, row.title, row.item_type, row.track,
          row.description, row.planned_start, row.planned_end, row.duration, row.responsible_org,
          row.priority, row.baseline_status, row.import_notes
        ]);
        inserted += 1;
      }
    }

    const actionTitle = `استيراد Excel (${entity}): ${inserted} جديد، ${updated} محدث، ${skipped} متجاهل`;
    await writeAudit(client, req, actionTitle, 'CREATE', entity, null, {
      entity, inserted, updated, skipped, total: rows.length
    });

    await client.query('commit');
    return { entity, inserted, updated, skipped, total: rows.length };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------
// 5. Check Project Dependencies
// -------------------------------------------------------------
async function getProjectDependencies(projectId, pool) {
  const [
    { rows: taskRows },
    { rows: productRows },
    { rows: planRows },
    { rows: fileRows }
  ] = await Promise.all([
    pool.query(`select count(*)::int as cnt from tasks where project_id = $1 and deleted_at is null`, [projectId]),
    pool.query(`select count(*)::int as cnt from products where project_id = $1 and deleted_at is null`, [projectId]),
    pool.query(`select count(*)::int as cnt from master_plan_items where project_id = $1 and deleted_at is null`, [projectId]),
    pool.query(`select count(*)::int as cnt from files f join products p on p.id = f.product_id where p.project_id = $1 and f.deleted_at is null`, [projectId])
  ]);

  return {
    tasks: taskRows[0].cnt || 0,
    products: productRows[0].cnt || 0,
    plans: planRows[0].cnt || 0,
    files: fileRows[0].cnt || 0
  };
}

module.exports = {
  generateTemplate,
  exportData,
  previewImport,
  commitImport,
  getProjectDependencies
};
