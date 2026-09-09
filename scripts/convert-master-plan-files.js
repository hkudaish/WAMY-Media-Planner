'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { readWorkbook } = require('./ooxml-reader');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'imports');
const outputDir = path.join(root, 'converted-plans');
const files = [
  ['مشروع_01_تعزيز_الصورة_الذهنية_والاتصال_المؤسسي_للاستيراد.xlsx', '01-مشروع-تعزيز-الصورة-الذهنية-قالب-التطبيق.xlsx'],
  ['مشروع_02_تطوير_الموقع_الإلكتروني_للاستيراد.xlsx', '02-مشروع-تطوير-الموقع-قالب-التطبيق.xlsx'],
  ['الخطة_الزمنية_التشغيلية_للمنتجات_للاستيراد.xlsx', '03-الخطة-التشغيلية-للمنتجات-قالب-التطبيق.xlsx']
];

(async () => {
  await fs.mkdir(outputDir, { recursive: true });
  for (const [sourceName, outputName] of files) {
    const raw = await readWorkbook(await fs.readFile(path.join(sourceDir, sourceName)));
    const source = raw.getWorksheet('الخطة الرئيسية') || raw.getWorksheet('الخطة الزمنية الموحدة') || raw.sheets[0];
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'WAMY Media Project Planner';
    const primary = workbook.addWorksheet('الخطة الرئيسية', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    primary.columns = Array.from({ length: 24 }, (_, index) => ({ width: index === 7 ? 42 : index === 8 || index === 9 || index === 23 ? 34 : 18 }));
    source.rows.forEach((values, rowIndex) => {
      const output = [...(values || [])];
      for (const index of [13, 14]) {
        if (/^\d+(?:\.\d+)?$/.test(String(output[index] || '')) && Number(output[index]) > 20000) {
          output[index] = new Date((Number(output[index]) - 25569) * 86400000);
        }
      }
      primary.addRow(output);
      if (rowIndex > 0) {
        primary.getCell(rowIndex + 1, 14).numFmt = 'yyyy-mm-dd';
        primary.getCell(rowIndex + 1, 15).numFmt = 'yyyy-mm-dd';
      }
    });
    primary.autoFilter = `A1:X${Math.max(primary.rowCount, 2)}`;
    primary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    primary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    primary.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    primary.eachRow((row, number) => { row.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true }; if (number > 1) row.height = 30; });
    const rawDefinition = raw.getWorksheet('تعريف المشروع');
    if (rawDefinition) {
      const definition = workbook.addWorksheet('تعريف المشروع', { views: [{ rightToLeft: true }] });
      definition.columns = [{ width: 28 }, { width: 100 }];
      rawDefinition.rows.forEach(values => definition.addRow(values || []));
      definition.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      definition.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    }
    const guide = workbook.addWorksheet('تعليمات التطبيق', { views: [{ rightToLeft: true }] });
    guide.getColumn(1).width = 110;
    guide.getCell('A1').value = 'قالب الخطة الرئيسية المعتمد في تطبيق WAMY';
    guide.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF2563EB' } };
    guide.getCell('A3').value = 'يُستورد من شاشة «الخطة الرئيسية» بواسطة مدير النظام. لا تغيّر أسماء الأعمدة الأربعة والعشرين.';
    guide.getCell('A4').value = 'يمكن إعادة استيراد الملف لتحديث البنود نفسها؛ يعتمد التطابق على رمز المشروع ومعرف السجل.';
    guide.getCell('A5').value = 'اربط المهام التنفيذية ببند الخطة المعتمد من شاشة إنشاء المهمة لقياس التأخير والانحراف.';
    await workbook.xlsx.writeFile(path.join(outputDir, outputName));
    console.log(outputName);
  }
})().catch(error => { console.error(error); process.exit(1); });
