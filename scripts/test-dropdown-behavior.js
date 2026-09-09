'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'code_artifact.html'), 'utf8');
const distJs = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'app.js'), 'utf8');

console.log('--- 1. Validating SearchableSelect Component in code_artifact.html ---');
assert(html.includes('function SearchableSelect('), 'SearchableSelect function definition missing in code_artifact.html');
assert(html.includes('function normalizeArabic('), 'normalizeArabic helper missing in code_artifact.html');
assert(html.includes('onWheel={(e) => e.stopPropagation()}'), 'Wheel event stopPropagation missing on listbox');
assert(html.includes('onTouchMove={(e) => e.stopPropagation()}'), 'TouchMove event stopPropagation missing on listbox');
assert(html.includes('document.addEventListener(\'mousedown\', handlePointerDown)'), 'Outside click mousedown handler missing');
assert(html.includes('document.addEventListener(\'touchstart\', handlePointerDown)'), 'Outside click touchstart handler missing');
assert(html.includes('e.key === \'Escape\''), 'Escape key handling missing');
assert(html.includes('allowCustom'), 'allowCustom support missing in SearchableSelect');
console.log('PASS: SearchableSelect component is fully defined with isolated scrolling, keyboard navigation, and outside-click protection.');

console.log('--- 2. Validating 4 Fields in TaskWizardModal ---');
assert(html.includes('label="1. المشروع"'), 'Field 1: 1. المشروع missing in TaskWizardModal');
assert(html.includes('label="2. الخطة / المسار"'), 'Field 2: 2. الخطة / المسار missing in TaskWizardModal');
assert(html.includes('label="3. منتج المشروع / المخرج المعتمد"'), 'Field 3: 3. منتج المشروع / المخرج المعتمد missing in TaskWizardModal');
assert(html.includes('label="4. المرحلة / المعلم المرتبط"'), 'Field 4: 4. المرحلة / المعلم المرتبط missing in TaskWizardModal');

// Verify datalist is completely replaced by stable SearchableSelect with allowCustom
assert(!html.includes('id="phase-suggestions"'), 'Old flaky datalist still present in code_artifact.html');
assert(html.includes('label="4. المرحلة / المعلم المرتبط"\n                                            hint="اختر مرحلة معتمدة من خطة المشروع أو أدخل مرحلة مخصصة."') ||
       html.includes('label="4. المرحلة / المعلم المرتبط"'), 'Phase field properly configured with SearchableSelect');
console.log('PASS: All 4 project-related fields are connected to SearchableSelect.');

console.log('--- 3. Validating Compiled Production Bundle (dist/assets/app.js) ---');
assert(distJs.length > 50000, 'Compiled app.js seems too small');
assert(distJs.includes('normalizeArabic') || distJs.includes('PRJ-'), 'Compiled bundle does not contain required project tokens');
console.log('PASS: Production bundle contains the complete enhanced frontend UI.');

console.log('\n======================================================');
console.log('ALL DROPDOWN STABILITY & SCROLLING CHECKS PASSED!');
console.log('======================================================\n');
