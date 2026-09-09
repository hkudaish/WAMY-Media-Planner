'use strict';

const JSZip = require('jszip');

function decode(value = '') {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decode(match[1]) : '';
}

function columnIndex(reference) {
  const letters = (reference.match(/^[A-Z]+/) || ['A'])[0];
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function textNodes(xml) {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match => decode(match[1])).join('');
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rowTag = rowMatch[0].slice(0, rowMatch[0].indexOf('>') + 1);
    const rowNumber = Number(attribute(rowTag, 'r')) || rows.length + 1;
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const tag = cellMatch[1]; const body = cellMatch[2] || '';
      const index = columnIndex(attribute(tag, 'r'));
      const type = attribute(tag, 't');
      const raw = (body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [,''])[1];
      let value = decode(raw);
      if (type === 's') value = sharedStrings[Number(value)] || '';
      else if (type === 'inlineStr') value = textNodes(body);
      else if (type === 'b') value = value === '1';
      values[index] = value;
    }
    rows[rowNumber - 1] = values;
  }
  return rows;
}

async function readWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async name => {
    const file = zip.file(name);
    if (!file) throw new Error(`Missing XLSX component: ${name}`);
    return file.async('string');
  };
  let sharedStrings = [];
  if (zip.file('xl/sharedStrings.xml')) {
    const sharedXml = await read('xl/sharedStrings.xml');
    sharedStrings = [...sharedXml.matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(match => textNodes(match[1]));
  }
  const workbookXml = await read('xl/workbook.xml');
  const relationshipsXml = await read('xl/_rels/workbook.xml.rels');
  const relationships = new Map([...relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .map(match => [attribute(match[1], 'Id'), attribute(match[1], 'Target')]));
  const sheets = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?\s*>/g)) {
    const name = attribute(match[1], 'name');
    const relationId = attribute(match[1], 'r:id');
    let target = relationships.get(relationId) || '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    const xml = await read(target);
    sheets.push({ name, rows: parseSheet(xml, sharedStrings) });
  }
  return { sheets, getWorksheet: name => sheets.find(sheet => sheet.name === name) };
}

module.exports = { readWorkbook };
