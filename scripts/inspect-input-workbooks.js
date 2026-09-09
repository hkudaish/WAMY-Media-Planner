'use strict';

const ExcelJS = require('exceljs');

function simple(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.text) return value.text;
    if (value.result != null) return simple(value.result);
    if (value.richText) return value.richText.map(part => part.text || '').join('');
    if (value.formula) return { formula: value.formula, result: simple(value.result) };
  }
  return value;
}

(async () => {
  for (const file of process.argv.slice(2)) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    console.log(JSON.stringify({ file, sheets: workbook.worksheets.map(sheet => ({
      name: sheet.name, state: sheet.state, rows: sheet.rowCount, columns: sheet.columnCount
    })) }));
    for (const sheet of workbook.worksheets) {
      console.log(`SHEET ${sheet.name}`);
      sheet.eachRow((row, rowNumber) => {
        const values = Array.from({ length: sheet.columnCount }, (_, index) => simple(row.getCell(index + 1).value));
        if (values.some(value => value != null && value !== '')) console.log(`${rowNumber}\t${JSON.stringify(values)}`);
      });
    }
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
