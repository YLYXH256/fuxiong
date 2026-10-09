import Papa from 'papaparse';
import * as XLSX from 'xlsx';

const FIELD_ALIASES = {
  studentId: ['学号', '学生学号', '学生编号', '学生号码', '学籍号', '学籍编号', '人员编号', '编号', '工号', 'studentid', 'studentno', 'studentnumber', 'sno', 'id'],
  name: ['姓名', '学生姓名', '人员姓名', '名字', 'name', 'fullname', 'studentname'],
  className: ['班级', '班级名称', '班', 'class', 'classname'],
  phone: ['手机号', '手机号码', '手机', '电话', '电话号码', '联系电话', '联系电话号码', 'phone', 'mobile', 'telephone'],
};

const OTHER_HEADER_ALIASES = ['序号', '性别', '年级', '学院', '专业', '身份证', '身份证号', '邮箱', '备注', 'email', 'gender'];

const normalizeLabel = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[\s_\-()（）:：]/g, '');

const asText = (value) => value == null ? '' : String(value);

function aliasMatches(label, aliases) {
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  return aliases.some((alias) => {
    if (normalized === alias) return true;
    return alias.length > 1 && /[^a-z0-9]/i.test(alias) && normalized.includes(alias);
  });
}

function nonEmptyGrid(grid) {
  return grid
    .map((row) => row.map(asText))
    .filter((row) => row.some((value) => value.trim() !== ''));
}

function parseDelimited(text, delimiter) {
  const parsed = Papa.parse(text, {
    ...(delimiter ? { delimiter } : {}),
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transform: asText,
  });
  const seriousError = parsed.errors.find((error) => error.code === 'MissingQuotes');
  if (seriousError) throw new Error(`第 ${seriousError.row + 1} 行存在未闭合的引号，请检查文本格式。`);
  return nonEmptyGrid(parsed.data);
}

function normalizeEncoding(encoding) {
  const label = encoding.toLowerCase().replace(/[\s_-]/g, '');
  if (label === 'utf8' || label === 'utf8bom') return 'utf-8';
  if (label === 'gbk' || label === 'gb2312' || label === 'gb18030') return 'gb18030';
  return encoding;
}

function decodeCSV(buffer, requestedEncoding) {
  const bytes = new Uint8Array(buffer);
  if (requestedEncoding !== 'auto') {
    const encoding = normalizeEncoding(requestedEncoding);
    return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be', { fatal: true }).decode(bytes), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030' };
  }
}

export async function readRosterFile(file, { encoding = 'auto' } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择有效的名单文件。');
  const extension = (file.name ?? '').split('.').pop().toLowerCase();
  const buffer = await file.arrayBuffer();
  if (['xlsx', 'xls', 'xlsm', 'xlsb'].includes(extension)) {
    const workbook = XLSX.read(buffer, { type: 'array', cellText: true, cellDates: false });
    const sheets = workbook.SheetNames.map((name) => ({
      name,
      grid: nonEmptyGrid(XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
      })),
    }));
    if (!sheets.length) throw new Error('文件中没有可读取的工作表。');
    return { sheets, encoding: 'Excel' };
  }
  if (!['csv', 'tsv', 'txt'].includes(extension)) throw new Error('支持 Excel（.xlsx / .xls）、CSV、TSV 和 TXT 文件。');
  const decoded = decodeCSV(buffer, encoding);
  const text = decoded.text.replace(/^\uFEFF/, '');
  const grid = extension === 'txt' ? parsePastedText(text) : parseDelimited(text, extension === 'tsv' ? '\t' : undefined);
  return {
    sheets: [{ name: (file.name ?? '名单').replace(/\.[^.]+$/, ''), grid }],
    encoding: decoded.encoding,
  };
}

function parseSpaceSeparatedLine(line) {
  const trimmed = line.trim();
  const columns = trimmed.split(/\s{2,}/);
  if (columns.length > 1) return columns;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return [trimmed];
  const containsIdentifier = words.some((word) => /\d/.test(word));
  const isHeader = words.every((word) => Object.values(FIELD_ALIASES)
    .some((aliases) => aliasMatches(word, aliases)) || OTHER_HEADER_ALIASES.includes(normalizeLabel(word)));
  if (containsIdentifier || isHeader) return words;
  return [trimmed];
}

export function parsePastedText(text) {
  const source = asText(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return [];
  if (source.includes('\t')) return parseDelimited(source, '\t');
  if (source.includes(',')) return parseDelimited(source, ',');
  if (source.includes('，')) return parseDelimited(source, '，');
  return nonEmptyGrid(source.split('\n')
    .filter((line) => line.trim())
    .map(parseSpaceSeparatedLine));
}

export function detectHeader(grid) {
  const rows = nonEmptyGrid(grid ?? []);
  if (!rows.length) return false;
  const firstRow = rows[0];
  return firstRow.some((cell) => Object.values(FIELD_ALIASES)
    .some((aliases) => aliasMatches(cell, aliases)) || OTHER_HEADER_ALIASES.includes(normalizeLabel(cell)));
}

export function gridToDataset(grid, { id, name, sheetName, hasHeader = true } = {}) {
  const normalized = nonEmptyGrid(grid ?? []);
  const width = normalized.reduce((max, row) => Math.max(max, row.length), 0);
  const datasetId = id || globalThis.crypto?.randomUUID?.() || `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const columns = Array.from({ length: width }, (_, index) => ({
    key: `c${index}`,
    label: hasHeader ? normalized[0]?.[index]?.trim() || `列 ${index + 1}` : `列 ${index + 1}`,
  }));
  const rows = normalized.slice(hasHeader ? 1 : 0).map((row, index) => ({
    id: `${datasetId}-r${index + (hasHeader ? 2 : 1)}`,
    values: Object.fromEntries(columns.map((column, columnIndex) => [column.key, asText(row[columnIndex])])),
  }));
  const mapping = Object.fromEntries(Object.entries(FIELD_ALIASES).map(([field, aliases]) => {
    const candidates = columns.filter((column) => aliasMatches(column.label, aliases));
    return [field, candidates.length === 1 ? candidates[0].key : ''];
  }));
  return {
    id: datasetId,
    name: name || sheetName || '名单',
    sheetName: sheetName || '',
    columns,
    rows,
    mapping,
  };
}

function safeCSVValue(value) {
  const text = asText(value);
  return /^[\s\u0000]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
}

function ensureExtension(filename, extension) {
  const cleaned = asText(filename).trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || '比对结果';
  return cleaned.toLowerCase().endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}

function triggerDownload(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCSV(records, filename = '比对结果.csv') {
  const rows = Array.isArray(records) ? records : [];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = Papa.unparse({
    fields: keys.map(safeCSVValue),
    data: rows.map((row) => keys.map((key) => safeCSVValue(row[key]))),
  }, { newline: '\r\n' });
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
  const outputName = ensureExtension(filename, '.csv');
  triggerDownload(blob, outputName);
  return { filename: outputName, blob, csv };
}

function uniqueSheetName(name, usedNames) {
  let base = asText(name).replace(/[\\/?*\[\]:\u0000-\u001f]/g, '_').trim()
    .replace(/^'+|'+$/g, '').slice(0, 31).replace(/^'+|'+$/g, '') || '结果';
  if (base.toLowerCase() === 'history') base = 'History_';
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` (${index++})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export function downloadWorkbook(sheets, filename = '比对结果.xlsx') {
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set();
  const exportSheets = sheets?.length ? sheets : [{ name: '结果', rows: [] }];
  for (const { name, rows = [] } of exportSheets) {
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const grid = [keys, ...rows.map((row) => keys.map((key) => asText(row[key])))];
    const sheet = XLSX.utils.aoa_to_sheet(grid);
    // String cells cannot execute formulas and retain identifiers such as 00123.
    for (const key of Object.keys(sheet)) {
      if (!key.startsWith('!')) {
        sheet[key].t = 's';
        sheet[key].z = '@';
        delete sheet[key].f;
      }
    }
    sheet['!cols'] = keys.map((key, index) => ({
      wch: Math.min(42, Math.max(12, ...grid.slice(0, 100).map((row) => asText(row[index]).length + 2))),
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, uniqueSheetName(name, usedNames));
  }
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const outputName = ensureExtension(filename, '.xlsx');
  triggerDownload(blob, outputName);
  return { filename: outputName, blob, workbook };
}

export function maskValue(label, value) {
  const text = asText(value);
  if (!text.trim()) return text;
  const normalized = normalizeLabel(label);
  if (/手机|电话|phone|mobile|telephone/.test(normalized)) {
    return text.length > 7 ? `${text.slice(0, 3)}${'*'.repeat(text.length - 7)}${text.slice(-4)}` : '*'.repeat(text.length);
  }
  if (/身份证|证件|idcard|identity/.test(normalized)) {
    return text.length > 8 ? `${text.slice(0, 4)}${'*'.repeat(text.length - 8)}${text.slice(-4)}` : '*'.repeat(text.length);
  }
  if (/邮箱|email|mail/.test(normalized)) {
    const separator = text.indexOf('@');
    if (separator > 0) return `${text.slice(0, Math.min(2, separator))}***${text.slice(separator)}`;
    return '*'.repeat(text.length);
  }
  return text;
}
