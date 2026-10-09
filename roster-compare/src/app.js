import {
  createIcons, ArrowDown, ArrowUp, ArrowUpDown, ArrowRight, ArrowLeft, ArrowUpRight,
  Bookmark, BookmarkPlus, Binary, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleAlert, CircleCheck, CircleDashed, CircleMinus, ClipboardList, ClipboardPaste,
  Combine, Copy, Download, Eye, EyeOff, FileCheck2, FileSpreadsheet, Files, Fingerprint,
  FlaskConical, FolderClock, FolderOpen, History, Info, Link2, ListChecks,
  LockKeyhole, LockOpen, LogIn, Mail, Menu, Merge, Pencil, Plus, RefreshCw,
  Rows3, RotateCcw, Save, ScanLine, ScanSearch, Scissors, Search, ShieldCheck,
  SlidersHorizontal, Sparkles, Split, Tags, Trash2, Undo2, Upload, UserRound,
  UserSearch, Users, X,
} from 'lucide';
import { compareDatasets, demoDatasets, findNameCandidates } from './compare.js';
import { readRosterFile, parsePastedText, gridToDataset, detectHeader, downloadCSV, downloadWorkbook, maskValue } from './io.js';
import './style.css';

const icons = { ArrowDown, ArrowUp, ArrowUpDown, ArrowRight, ArrowLeft, ArrowUpRight,
  Bookmark, BookmarkPlus, Binary, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleAlert, CircleCheck, CircleDashed, CircleMinus, ClipboardList, ClipboardPaste,
  Combine, Copy, Download, Eye, EyeOff, FileCheck2, FileSpreadsheet, Files, Fingerprint,
  FlaskConical, FolderClock, FolderOpen, History, Info, Link2, ListChecks,
  LockKeyhole, LockOpen, LogIn, Mail, Menu, Merge, Pencil, Plus, RefreshCw,
  Rows3, RotateCcw, Save, ScanLine, ScanSearch, Scissors, Search, ShieldCheck,
  SlidersHorizontal, Sparkles, Split, Tags, Trash2, Undo2, Upload, UserRound,
  UserSearch, Users, X };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const uid = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);
const storageKey = 'roster-workspace-v1';
const tabId = uid();
const DAY = 86400000;
const baseFields = { studentId: '学号', name: '姓名', className: '班级', phone: '手机号' };
const defaultConfig = () => ({ matchFields: ['studentId'], conflictFields: ['name', 'className'], fieldLabels: { ...baseFields }, aliases: {} });
const nowText = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const newTask = (datasets = []) => ({ id: uid(), name: `名单比对 ${nowText(Date.now())}`, createdAt: Date.now(), updatedAt: Date.now(), owner: user?.id || 'demo-me', ownerName: user?.name || '李老师', datasets: clone(datasets), config: defaultConfig(), overrides: [], logs: [], saved: false, dirty: false });
let stored;
try { stored = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { stored = {}; }
let tasks = (stored.tasks || []).filter((t) => Date.now() - t.createdAt < 7 * DAY);
let templates = stored.templates || [];
let user = stored.user || { id: 'demo-me', name: '李老师', email: 'teacher@example.com' };
let task = newTask(demoDatasets());
let state = { nav: 'workspace', step: 1, tab: 'all', search: '', occurrence: '', listFilter: '', page: 1, pageSize: 10, sortKey: 'studentId', sortDir: 1, masked: true, result: null, readOnly: false, fallback: false, busy: false };
let fileQueue = [];
let importDraft = null;
let modalContext = null;
let toastTimer;

function persist(nextTasks = tasks) {
  try { localStorage.setItem(storageKey, JSON.stringify({ tasks: nextTasks, templates, user })); return true; }
  catch { toast('浏览器存储空间不足，任务未保存；请先导出结果', true); return false; }
}
function cleanExpired() {
  const remaining = tasks.filter((t) => Date.now() - t.createdAt < 7 * DAY);
  if (remaining.length !== tasks.length) { tasks = remaining; persist(); }
  if (task.saved && Date.now() - task.createdAt >= 7 * DAY) {
    releaseLock(); task = newTask(); state.step = 1; state.result = null; state.readOnly = false;
    toast('任务已到保留期限，数据已清理'); render();
  }
}
function log(action) { task.logs.push({ id: uid(), action, by: user.name, at: Date.now() }); }
function saveTask(action = '保存任务', notify = true) {
  if (!canEdit()) return false;
  const snapshot = clone(task);
  snapshot.saved = true; snapshot.dirty = false; snapshot.updatedAt = Date.now();
  snapshot.logs.push({ id: uid(), action, by: user.name, at: Date.now() });
  const existing = tasks.findIndex((t) => t.id === task.id);
  if (existing >= 0) snapshot.logs = [...new Map([...tasks[existing].logs, ...snapshot.logs].map((l) => [l.id, l])).values()].toSorted((a, b) => a.at - b.at);
  const next = [...tasks];
  if (existing >= 0) next[existing] = snapshot; else next.unshift(snapshot);
  if (!persist(next)) { task.dirty = true; return false; }
  tasks = next; task = clone(snapshot); acquireLock(); if (notify) toast('任务已保存');
  return true;
}
function lockKey() { return `roster-lock:${task.id}`; }
function readLock() {
  try { const lock = JSON.parse(localStorage.getItem(lockKey()) || 'null'); return lock && lock.until > Date.now() ? lock : null; } catch { return null; }
}
function acquireLock() {
  const lock = readLock();
  state.readOnly = Boolean(lock && lock.tabId !== tabId);
  if (!state.readOnly) localStorage.setItem(lockKey(), JSON.stringify({ tabId, by: user.name, userId: user.id, until: Date.now() + 45000 }));
}
function releaseLock() { if (readLock()?.tabId === tabId) localStorage.removeItem(lockKey()); }
function canEdit() {
  if (state.busy) { toast('正在处理文件，请稍候', true); return false; }
  if (readLock()?.tabId && readLock().tabId !== tabId) state.readOnly = true;
  if (state.readOnly) { toast('当前任务由另一位用户编辑，请结束后再试', true); return false; }
  return true;
}
function invalidate() {
  state.result = null; state.fallback = false; task.dirty = true;
  const activeIds = new Set(task.datasets.flatMap((d) => d.rows.filter((r) => !r.excluded).map((r) => `${d.id}:${r.id}`)));
  task.overrides = task.overrides.map((link) => ({ recordIds: link.recordIds.filter((id) => activeIds.has(id)) })).filter((link) => link.recordIds.length >= 2);
  const validLinks = [];
  for (const link of task.overrides) {
    if (!compareDatasets(task.datasets, task.config, [...validLinks, link]).warnings.length) validLinks.push(link);
  }
  if (validLinks.length !== task.overrides.length) toast('部分人工匹配因字段变化失效，请重新确认', true);
  task.overrides = validLinks;
}
const hasUnsavedChanges = () => task.dirty || (!task.saved && task.datasets.length > 0);
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast-root').innerHTML = `<div class="toast ${error ? 'error' : ''}">${icon(error ? 'circle-alert' : 'circle-check')}<span>${escape(message)}</span></div>`;
  hydrate(); toastTimer = setTimeout(() => { $('#toast-root').innerHTML = ''; }, 3800);
}
function hydrate() { createIcons({ icons, attrs: { 'stroke-width': 1.8 } }); }
function button(action, label, symbol, style = '', attrs = '') { return `<button class="btn ${style}" data-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${escape(label)}</button>`; }
function iconButton(action, label, symbol, attrs = '', danger = false) { return `<button class="icon-btn ${danger ? 'danger' : ''}" data-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${attrs}>${icon(symbol)}</button>`; }
const sourceRows = (dataset) => dataset.rows.filter((r) => !r.derivedFrom);
const countRaw = () => task.datasets.reduce((n, d) => n + sourceRows(d).length, 0);
const labels = () => task.config.fieldLabels || baseFields;
const fieldName = (field) => labels()[field] || field;
const navLabel = () => ({ workspace: '比对工作台', history: '历史任务', templates: '个人模板', activity: '操作记录' }[state.nav]);
function render() {
  $('#app').innerHTML = `<div class="shell">
    <div class="sidebar-overlay" data-action="close-menu"></div>
    <aside class="sidebar">
      <button class="icon-btn mobile-close" data-action="close-menu" title="关闭导航" aria-label="关闭导航">${icon('x')}</button>
      <div class="brand"><span class="brand-icon">${icon('list-checks')}</span>名单比对</div>
      <div class="nav-caption">工作空间</div>
      <nav class="nav" aria-label="主导航">
        ${[['workspace', '比对工作台', 'scan-line'], ['history', '历史任务', 'history'], ['templates', '个人模板', 'sliders-horizontal'], ['activity', '操作记录', 'clipboard-list']].map(([key, title, symbol]) => `<button data-action="nav" data-value="${key}" class="${state.nav === key ? 'active' : ''}">${icon(symbol)}<span>${title}</span>${key === 'history' ? `<span class="counter">${tasks.length}</span>` : ''}</button>`).join('')}
      </nav>
      <div class="sidebar-bottom"><div class="small muted"><span class="live-dot"></span>本机工作空间</div><div class="small muted" style="font-size:10px;margin-top:8px">任务保留 7 天</div></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><div class="flex"><button class="icon-btn mobile-menu" data-action="menu" title="打开导航" aria-label="打开导航">${icon('menu')}</button><div class="breadcrumb"><span>工作空间</span>${icon('chevron-right')}<span>${navLabel()}</span></div></div><div class="top-actions"><span class="prototype" title="交互原型：数据仅存当前浏览器，账号和服务端协作为演示状态">${icon('flask-conical')}本地原型</span><button class="user-button" data-action="account" title="账号与演示用户"><span class="avatar">${escape(user.name[0])}</span><span class="user-name">${escape(user.name)}</span>${icon('chevron-down')}</button></div></header>
      <main class="main">${state.nav === 'workspace' ? workspaceView() : state.nav === 'history' ? historyView() : state.nav === 'templates' ? templatesView() : activityView()}</main>
    </div>
  </div><input id="file-input" class="hidden" type="file" multiple accept=".xlsx,.xls,.csv,.tsv,.txt" />`;
  bind(); hydrate();
}
function workspaceView() {
  return `<div class="page-heading"><div><div class="flex"><h1>${state.step === 3 ? '比对结果' : state.step === 2 ? '匹配设置' : '新建比对'}</h1></div><div class="subtitle flex"><span class="truncate">${escape(task.name)}</span>${iconButton('rename', '修改任务名称', 'pencil')}<span>·</span><span>${task.dirty ? '有未保存修改' : task.saved ? '已保存' : '未保存'}</span></div></div><div class="flex">${button('new', '新建任务', 'plus')}${button('save', '保存任务', 'save', '', state.readOnly ? 'disabled' : '')}</div></div>
    ${state.readOnly ? `<div class="lock-banner"><span class="flex">${icon('lock-keyhole')} ${escape(readLock()?.by || '其他用户')}正在编辑 · 当前为只读</span>${button('retry-lock', '尝试编辑', 'refresh-cw', 'compact')}</div>` : ''}
    <div class="stepper">${[[1, '导入名单', `${task.datasets.length} 份名单`], [2, '匹配设置', '字段映射与核对'], [3, '比对结果', '统计与导出']].map(([n, title, meta]) => `<button class="step ${state.step === n ? 'active' : state.step > n ? 'done' : ''}" data-action="step" data-value="${n}"><span class="step-number">${state.step > n ? icon('check') : String(n).padStart(2, '0')}</span><span>${title}<span class="step-meta">${meta}</span></span></button>`).join('')}</div>
    ${state.step === 1 ? importView() : state.step === 2 ? settingsView() : resultView()}
    <footer class="bottom-meta"><span>名单比对 · 工作空间</span><span>${task.saved ? `自动清理 ${nowText(task.createdAt + 7 * DAY)}` : '新任务保存后出现在历史列表'} · 数据保留 7 天</span></footer>`;
}
function importView() {
  const detected = task.datasets.filter((d) => d.mapping.studentId).length;
  return `<div class="import-layout"><section><div class="section-header"><div class="flex"><h2>人员名单</h2><span class="label">${task.datasets.length} 份</span></div>${button('demo', '载入示例', 'sparkles', 'text compact')}</div>
    <div class="dropzone" id="dropzone"><div class="upload-symbol">${icon('upload')}</div><h3>拖拽文件到此处，或选择文件</h3><p>Excel、CSV、TXT · 单文件 50 MB 以内</p><div class="flex">${button('upload', '选择文件', 'folder-open', 'primary')}${button('paste', '粘贴名单', 'clipboard-paste')}</div></div>
    <div class="file-list">${task.datasets.map((d, i) => { const format = d.format || ['xlsx', 'csv', 'paste'][i % 3]; const missing = d.mapping.studentId ? d.rows.filter((r) => !r.values[d.mapping.studentId]?.trim()).length : d.rows.length; return `<article class="file-item"><div class="file-symbol ${format}">${icon(format === 'paste' ? 'clipboard-list' : 'file-spreadsheet')}</div><div class="grow"><div class="file-name">${escape(d.name)}</div><div class="file-meta"><span>${format === 'paste' ? '粘贴名单' : format.toUpperCase()}</span><span class="dot">·</span><span>${d.rows.length} 条记录</span><span class="dot">·</span><span>${d.columns.length} 列</span>${d.sheetName ? `<span class="dot">·</span><span>${escape(d.sheetName)}</span>` : ''}</div><div class="file-details"><span class="pill ${d.mapping.studentId ? 'green' : 'amber'}">${icon(d.mapping.studentId ? 'check' : 'circle-alert')}${d.mapping.studentId ? `已识别 ${escape(d.columns.find((c) => c.key === d.mapping.studentId)?.label || '学号')}` : '学号列待确认'}</span>${missing ? `<span class="pill amber">${missing} 条缺少学号</span>` : ''}${d.rows.some((r) => r.excluded) ? `<span class="pill">${d.rows.filter((r) => r.excluded).length} 条已排除</span>` : ''}</div></div><div class="item-actions">${iconButton('preview', '预览与调整', 'eye', `data-id="${d.id}"`)}${iconButton('rename-list', '重命名名单', 'pencil', `data-id="${d.id}"`)}${iconButton('remove-list', '移除名单', 'trash-2', `data-id="${d.id}" ${state.readOnly ? 'disabled' : ''}`, true)}</div></article>`; }).join('')}</div>
    </section><aside class="import-aside"><h3 class="aside-title">导入概况</h3><div class="summary-mini"><div class="mini-stat large"><span>原始记录</span><b>${countRaw()}</b></div><div class="mini-stat"><span>已导入名单</span><b>${task.datasets.length} 份</b></div><div class="mini-stat"><span>学号列已识别</span><b>${detected} / ${task.datasets.length}</b></div></div><div class="aside-list"><h3 class="aside-title">当前比对规则</h3><div class="rule-item">${icon('fingerprint')}学号优先匹配</div><div class="rule-item">${icon('scissors')}去除字段首尾空格</div><div class="rule-item">${icon('binary')}保留学号前导零</div><div class="rule-item">${icon('copy')}重复行保留，人数去重</div></div><div class="readiness">${icon(task.datasets.length >= 2 ? 'circle-check' : 'circle-dashed')}<span>${task.datasets.length >= 2 ? '名单已就绪，待确认匹配字段' : '等待导入至少两份名单'}</span></div></aside></div>
    <div class="action-footer"><span class="footer-note">${icon('shield-check')}本次导入仅在当前浏览器处理</span>${button('to-settings', '下一步：匹配设置', 'arrow-right', 'primary', task.datasets.length < 2 || state.busy ? 'disabled' : '')}</div>`;
}
function settingsView() {
  const fields = labels();
  return `<div class="section-header"><h2>比对规则</h2><div class="flex">${button('aliases', '识别关键词', 'tags', 'text compact')}${button('add-field', '添加字段', 'plus', 'text compact')}${button('save-template', '保存为模板', 'bookmark-plus', 'compact')}</div></div>
    <div class="settings-band"><div class="setting-grid"><div><span class="field-label">匹配字段</span><div class="checks">${Object.entries(fields).map(([key, label]) => `<label class="check-option"><input type="checkbox" data-config="matchFields" value="${key}" ${task.config.matchFields.includes(key) ? 'checked' : ''} ${state.readOnly ? 'disabled' : ''}/>${escape(label)}</label>`).join('')}</div><div class="switch-line">${icon('link-2')}已选 ${task.config.matchFields.length} 个字段 · ${task.config.matchFields.length > 1 ? '全部一致才算同一人' : '精确匹配'}</div></div><div><span class="field-label">信息冲突核对字段</span><div class="checks">${Object.entries(fields).map(([key, label]) => `<label class="check-option"><input type="checkbox" data-config="conflictFields" value="${key}" ${task.config.conflictFields.includes(key) ? 'checked' : ''} ${state.readOnly ? 'disabled' : ''}/>${escape(label)}</label>`).join('')}</div><div class="switch-line">${icon('flag')}信息冲突仍计入重合人数</div></div></div></div>
    <div class="section-header"><h2>名单字段映射</h2><span class="small muted">${task.datasets.length} 份名单</span></div><div class="mapping-scroll"><table class="mapping-table"><thead><tr><th>名单</th>${Object.entries(fields).map(([key, label]) => `<th>${escape(label)}${task.config.matchFields.includes(key) ? '<span class="small" style="color:#b39152"> *</span>' : ''}</th>`).join('')}</tr></thead><tbody>${task.datasets.map((d) => `<tr><td><b>${escape(d.name)}</b><div class="mapping-sample">${d.rows.length} 条记录 · ${d.columns.length} 列</div></td>${Object.keys(fields).map((field) => { const key = d.mapping[field]; return `<td><select aria-label="${escape(d.name)}的${escape(fields[field])}列" data-map="${field}" data-id="${d.id}" ${state.readOnly ? 'disabled' : ''}><option value="">选择对应列</option>${d.columns.map((c) => `<option value="${c.key}" ${key === c.key ? 'selected' : ''}>${escape(c.label)}</option>`).join('')}</select><div class="mapping-sample">${key ? `示例：${escape(d.rows.find((r) => r.values[key]?.trim())?.values[key] || '空')}` : '未映射'}</div></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
    ${task.datasets.some((d) => task.config.matchFields.some((f) => !d.mapping[f])) ? `<div class="notice">${icon('circle-alert')}<span>部分匹配列尚未确认。可以先查看姓名比对预览，正式统计前需确认字段。</span>${button('fallback', '姓名预览', 'scan-search', 'compact')}</div>` : `<div class="notice green">${icon('circle-check')}<span>各名单匹配列已设置。点击开始比对，即确认当前字段映射。</span></div>`}
    <div class="action-footer">${button('back-import', '返回导入', 'arrow-left')}${button('compare', '确认并开始比对', 'scan-line', 'primary', !task.config.matchFields.length ? 'disabled' : '')}</div>`;
}
function getResult() { return state.result || compareDatasets(task.datasets, task.config, task.overrides); }
function resultTabs(result) {
  return [['all', '全部人员', result.people.length], ['intersection', '全部重合', result.summary.allCount], ['only', '单份独有', result.summary.onlyCount], ['duplicate', '重复数据', result.duplicates.length], ['conflict', '信息冲突', result.summary.conflictCount], ['missing', '缺少字段', result.missing.length], ['excluded', '已排除', result.excluded.length]];
}
function categoryRecords(result) {
  if (state.tab === 'duplicate') return result.duplicates;
  if (state.tab === 'missing' || state.tab === 'excluded') return result[state.tab].map((r) => ({ id: r.recordId, name: r.mapped.name, studentId: r.mapped.studentId, occurrence: 0, listIds: [r.datasetId], listNames: [r.datasetName], records: [r], missingFields: r.missingFields }));
  let rows = result.people;
  if (state.tab === 'intersection') rows = rows.filter((p) => p.occurrence === task.datasets.length);
  if (state.tab === 'only') rows = rows.filter((p) => p.occurrence === 1);
  if (state.tab === 'conflict') rows = rows.filter((p) => p.conflict);
  return rows;
}
function visibleRows() {
  let rows = categoryRecords(getResult());
  if (state.occurrence) rows = rows.filter((p) => p.occurrence === Number(state.occurrence));
  if (state.listFilter) rows = rows.filter((p) => (p.listIds || [p.datasetId]).includes(state.listFilter));
  if (state.search.trim()) {
    const search = state.search.trim().toLowerCase();
    rows = rows.filter((p) => [p.name, p.studentId, ...(p.listNames || [p.datasetName]), ...p.records.flatMap((r) => Object.entries(r.values).map(([k, v]) => displayValue(r.datasetId, k, v)))].some((v) => String(v || '').toLowerCase().includes(search)));
  }
  return rows.toSorted((a, b) => String(a[state.sortKey] || '').localeCompare(String(b[state.sortKey] || ''), 'zh-CN', { numeric: state.sortKey === 'occurrence' }) * state.sortDir);
}
function displayValue(datasetId, key, value) {
  const d = task.datasets.find((d) => d.id === datasetId);
  const mappedField = Object.keys(d?.mapping || {}).find((f) => d.mapping[f] === key && /手机号|手机|电话|身份证|邮箱/.test(fieldName(f)));
  return state.masked ? maskValue(mappedField ? fieldName(mappedField) : d?.columns.find((c) => c.key === key)?.label || key, value) : String(value ?? '');
}
function exportColumnName(dataset, column) {
  return dataset.columns.filter((c) => c.label === column.label).length > 1 ? `${column.label}[${column.key}]` : column.label;
}
function personPills(person) {
  return `${person.conflict ? `<span class="pill red">信息冲突</span>` : ''}${person.duplicate || person.count ? '<span class="pill amber">重复记录</span>' : ''}${person.manual ? '<span class="pill blue">姓名补充</span>' : ''}${!person.conflict && !person.duplicate && !person.manual && !person.count ? `<span class="pill ${person.occurrence === task.datasets.length ? 'green' : ''}">${person.occurrence === task.datasets.length ? '全部重合' : person.occurrence === 1 ? '单份独有' : person.occurrence ? '部分重合' : state.tab === 'excluded' ? '已排除' : '待补全'}</span>` : ''}`;
}
function resultView() {
  const result = getResult(), summary = result.summary;
  const candidates = findNameCandidates(task.datasets, result);
  return `<div class="stats-row"><div class="stat"><div class="stat-label">${icon('files')}原始记录</div><div class="stat-number">${summary.rawRecords}<small>条</small></div><div class="stat-sub">${task.datasets.length} 份名单 · ${summary.excludedRecords || 0} 条已排除</div></div><div class="stat"><div class="stat-label">${icon('users')}去重人数</div><div class="stat-number">${summary.uniquePeople}<small>人</small></div><div class="stat-sub">有效记录 ${summary.validRecords} 条</div></div><div class="stat"><div class="stat-label">${icon('combine')}全部重合</div><div class="stat-number">${summary.allCount}<small>人</small></div><div class="stat-sub">出现在全部 ${task.datasets.length} 份名单</div></div><div class="stat"><div class="stat-label">${icon('user-round')}单份独有</div><div class="stat-number">${summary.onlyCount}<small>人</small></div><div class="stat-sub">仅出现在某一份名单</div></div></div>
    ${state.fallback ? `<div class="notice" style="margin:0 0 18px">${icon('circle-alert')}<span>姓名比对预览 · 待确认，不计入正式统计</span>${button('to-settings', '确认匹配字段', 'sliders-horizontal', 'compact')}</div>` : ''}
    ${result.missing.length ? `<div class="notice blue" style="margin:0 0 18px">${icon('scan-search')}<span>${result.missing.length} 条记录缺少匹配字段 · ${candidates.length} 组姓名补充候选</span>${button('name-candidates', '按姓名补充比对', 'user-search', 'compact')}</div>` : ''}
    <div class="section-header" style="margin-bottom:6px"><h2>结果明细</h2><div class="flex">${button('to-settings', '调整规则', 'sliders-horizontal', 'text compact')}${button('export', '导出结果', 'download', 'primary compact', state.fallback ? 'disabled' : '')}</div></div>
    <div class="tabs" role="tablist">${resultTabs(result).map(([key, label, count]) => `<button class="tab ${state.tab === key ? 'active' : ''}" role="tab" aria-selected="${state.tab === key}" data-action="tab" data-value="${key}">${label}<span class="tab-count">${count}</span></button>`).join('')}</div>
    <div class="result-toolbar"><label class="search-box">${icon('search')}<input id="result-search" aria-label="搜索比对结果" placeholder="搜索姓名、学号或其他字段" value="${escape(state.search)}" /></label><div class="result-controls"><select id="occurrence-filter" aria-label="按出现名单数筛选"><option value="">全部出现次数</option>${Array.from({ length: task.datasets.length }, (_, i) => `<option value="${i + 1}" ${Number(state.occurrence) === i + 1 ? 'selected' : ''}>出现于 ${i + 1} 份名单</option>`).join('')}</select><select id="list-filter" aria-label="按名单筛选"><option value="">全部名单</option>${task.datasets.map((d) => `<option value="${d.id}" ${state.listFilter === d.id ? 'selected' : ''}>${escape(d.name)}</option>`).join('')}</select><button class="toggle-mask" data-action="mask" title="切换手机号、身份证和邮箱显示方式">${icon(state.masked ? 'eye-off' : 'eye')}${state.masked ? '已脱敏' : '完整显示'}</button>${iconButton('copy', '复制当前筛选结果', 'copy')}</div></div>
    <div id="result-table-area">${resultTable()}</div><div class="result-bottom flex">${icon('fingerprint')}匹配字段：${task.config.matchFields.map(fieldName).join(' + ')}<span>·</span>冲突检查：${task.config.conflictFields.map(fieldName).join('、') || '无'}<span>·</span>全部原始列保留在来源详情和导出文件中</div>`;
}
function resultTable() {
  const rows = visibleRows();
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * state.pageSize;
  const page = rows.slice(start, start + state.pageSize);
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th class="row-index">#</th>${[['studentId', '学号'], ['name', '姓名'], ['occurrence', state.tab === 'duplicate' ? '重复次数' : '出现名单']].map(([key, title]) => `<th><button data-action="sort" data-value="${key}">${title}${icon(state.sortKey === key ? state.sortDir === 1 ? 'arrow-up' : 'arrow-down' : 'arrow-up-down')}</button></th>`).join('')}<th>来源名单</th><th>状态</th><th>原始记录</th></tr></thead><tbody>${page.length ? page.map((p, i) => `<tr><td class="row-index">${String(start + i + 1).padStart(2, '0')}</td><td class="mono">${escape(p.studentId || '—')}</td><td class="person-name">${escape(p.name || '—')}</td><td>${p.count ? `<b>${p.count}</b> 条` : p.occurrence ? `<b>${p.occurrence}</b> 份` : '—'}</td><td><div class="list-presence">${(p.listNames || [p.datasetName]).map((name) => `<span class="presence-dot">${escape(name)}</span>`).join('')}</div></td><td><div class="flex wrap" style="gap:5px">${personPills(p)}</div></td><td>${button('details', `${p.records.length} 条详情`, 'rows-3', 'text compact', `data-id="${escape(p.id)}"`)}</td></tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:48px;color:#98a59c">没有符合条件的记录</td></tr>'}</tbody></table></div><div class="pagination"><span>共 ${rows.length} ${['missing', 'excluded'].includes(state.tab) ? '条' : state.tab === 'duplicate' ? '组' : '人'} · 当前 ${rows.length ? start + 1 : 0}–${Math.min(start + state.pageSize, rows.length)}</span><div class="flex"><span>每页</span><select id="page-size" aria-label="每页数量">${[10, 20, 50].map((n) => `<option ${state.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select>${iconButton('prev-page', '上一页', 'chevron-left', state.page <= 1 ? 'disabled' : '')}<span class="page-number">${state.page}</span><span>/ ${pages}</span>${iconButton('next-page', '下一页', 'chevron-right', state.page >= pages ? 'disabled' : '')}</div></div>`;
}
function historyView() {
  const list = tasks.toSorted((a, b) => b.updatedAt - a.updatedAt);
  return `<div class="page-heading"><div><h1>历史任务</h1><p class="subtitle">${tasks.length} 个任务 · 从创建时间起保留 7 天</p></div>${button('new', '新建任务', 'plus', 'primary')}</div>${list.length ? `<div class="task-list">${list.map((t) => { const r = compareDatasets(t.datasets, t.config, t.overrides); return `<article class="task-item"><span class="file-symbol">${icon('file-check-2')}</span><div class="grow"><h3>${escape(t.name)}</h3><div class="task-meta"><span>${escape(t.ownerName)}</span><span>${nowText(t.createdAt)}</span><span>${t.datasets.length} 份名单</span><span>${r.summary.uniquePeople} 人</span><span class="pill">${nowText(t.createdAt + 7 * DAY)} 清理</span></div></div><div class="flex">${button('open-task', '打开', 'arrow-up-right', 'compact', `data-id="${t.id}"`)}${iconButton('delete-task', t.owner === user.id ? '删除任务' : '仅创建者可以删除', 'trash-2', `data-id="${t.id}" ${t.owner !== user.id ? 'disabled' : ''}`, true)}</div></article>`; }).join('')}</div>` : `<div class="empty">${icon('folder-clock')}<h3>暂无历史任务</h3>${button('nav', '开始比对', 'plus', 'primary', 'data-value="workspace"')}</div>`}`;
}
function templatesView() {
  const own = templates.filter((t) => t.owner === user.id);
  return `<div class="page-heading"><div><h1>个人模板</h1><p class="subtitle">${own.length} 个比对方案</p></div>${button('save-template', '保存当前规则', 'bookmark-plus', 'primary')}</div>${own.length ? `<div class="template-grid">${own.map((t) => `<article class="template-item"><div class="flex between"><span class="template-icon">${icon('sliders-horizontal')}</span>${iconButton('delete-template', '删除模板', 'trash-2', `data-id="${t.id}"`, true)}</div><h3>${escape(t.name)}</h3><div class="checks">${t.config.matchFields.map((f) => `<span class="pill green">${escape(t.config.fieldLabels?.[f] || baseFields[f] || f)}</span>`).join('')}</div><div class="small muted" style="line-height:1.8;margin-bottom:18px">冲突检查：${t.config.conflictFields.map((f) => t.config.fieldLabels?.[f] || baseFields[f] || f).join('、') || '无'}</div>${button('use-template', '使用模板', 'arrow-right', '', `data-id="${t.id}"`)}</article>`).join('')}</div>` : `<div class="empty">${icon('bookmark')}<h3>暂无个人模板</h3>${button('to-settings', '设置比对规则', 'sliders-horizontal', 'primary')}</div>`}`;
}
function activityView() {
  const logs = tasks.flatMap((t) => t.logs.map((l) => ({ ...l, taskName: t.name }))).toSorted((a, b) => b.at - a.at);
  return `<div class="page-heading"><div><h1>操作记录</h1><p class="subtitle">${logs.length} 条记录 · 随任务一并清理</p></div></div>${logs.length ? logs.map((l) => `<div class="log-item"><span class="log-icon">${icon(l.action.includes('导出') ? 'download' : l.action.includes('保存') ? 'save' : 'pencil')}</span><div class="grow"><span>${escape(l.by)}</span><span class="muted"> · ${escape(l.action)}</span><p class="small muted" style="margin-top:6px">${escape(l.taskName)}</p></div><span class="log-time">${nowText(l.at)}</span></div>`).join('') : `<div class="empty">${icon('clipboard-list')}<h3>暂无操作记录</h3></div>`}`;
}

function bind() {
  $('#file-input').addEventListener('change', (event) => enqueueFiles([...event.target.files]));
  const drop = $('#dropzone');
  if (drop) {
    for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragover'); enqueueFiles([...e.dataTransfer.files]); });
  }
  $$('[data-map]').forEach((select) => select.addEventListener('change', () => {
    if (!canEdit()) return render();
    task.datasets.find((d) => d.id === select.dataset.id).mapping[select.dataset.map] = select.value;
    invalidate(); render();
  }));
  $$('[data-config]').forEach((input) => input.addEventListener('change', () => {
    if (!canEdit()) return render();
    const key = input.dataset.config;
    task.config[key] = $$(`[data-config="${key}"]:checked`).map((el) => el.value);
    invalidate(); render();
  }));
  $('#result-search')?.addEventListener('input', (e) => { state.search = e.target.value; state.page = 1; renderTable(); });
  $('#occurrence-filter')?.addEventListener('change', (e) => { state.occurrence = e.target.value; state.page = 1; renderTable(); });
  $('#list-filter')?.addEventListener('change', (e) => { state.listFilter = e.target.value; state.page = 1; renderTable(); });
  bindPagination();
}
function bindPagination() { $('#page-size')?.addEventListener('change', (e) => { state.pageSize = Number(e.target.value); state.page = 1; renderTable(); }); }
function renderTable() { $('#result-table-area').innerHTML = resultTable(); bindPagination(); hydrate(); }

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const { action, id, value } = target.dataset;
  try { await handleAction(action, id, value, target); }
  catch (error) { console.error(error); toast(error.message || '操作失败，请检查输入', true); }
});
async function handleAction(action, id, value, target) {
  if (action === 'nav') { state.nav = value; render(); }
  else if (action === 'menu' || action === 'close-menu') { $('.sidebar').classList.toggle('open', action === 'menu'); $('.sidebar-overlay').classList.toggle('open', action === 'menu'); }
  else if (action === 'new') {
    if (hasUnsavedChanges() && !await confirmModal('新建比对任务', '当前未保存的内容将被清空。是否继续？', '新建任务')) return;
    releaseLock(); task = newTask(); state = { ...state, nav: 'workspace', step: 1, result: null, readOnly: false, fallback: false }; render();
  }
  else if (action === 'demo') {
    if (!canEdit()) return;
    if (task.datasets.length && !await confirmModal('载入示例名单', '将用三份示例名单替换当前名单。是否继续？', '载入示例')) return;
    releaseLock(); task = newTask(demoDatasets()); task.name = '学生名单核对 · 示例任务'; state.step = 1; state.result = null; state.readOnly = false; render(); toast('已载入 3 份示例名单');
  }
  else if (action === 'save') { saveTask(); render(); }
  else if (action === 'rename') {
    if (!canEdit()) return; const name = await textModal('任务名称', task.name); if (!name) return; task.name = name; task.dirty = true; render();
  }
  else if (action === 'rename-list') {
    if (!canEdit()) return; const d = task.datasets.find((d) => d.id === id); const name = await textModal('名单名称', d.name); if (!name) return; d.name = name; state.result = null; task.dirty = true; render();
  }
  else if (action === 'remove-list') {
    if (!canEdit()) return; if (!await confirmModal('移除名单', '此名单将从当前任务中移除，保存后更新历史任务。', '移除')) return; task.datasets = task.datasets.filter((d) => d.id !== id); invalidate(); render();
  }
  else if (action === 'upload') { if (canEdit()) $('#file-input').click(); }
  else if (action === 'paste') { if (canEdit()) pasteModal(); }
  else if (action === 'parse-paste') {
    const text = $('#paste-text').value; const grid = parsePastedText(text);
    if (!grid.length) return toast('请先粘贴名单内容', true);
    importDraft = { sourceName: $('#paste-name').value.trim() || `粘贴名单 ${task.datasets.length + 1}`, sheets: [{ name: '粘贴数据', grid }], encoding: '文本', format: 'paste', sheet: 0, header: detectHeader(grid) };
    importModal();
  }
  else if (action === 'confirm-import') {
    if (!canEdit()) return;
    const name = $('#import-name').value.trim(); const grid = importDraft.sheets[importDraft.sheet].grid;
    const d = gridToDataset(grid, { id: uid(), name: name || importDraft.sourceName, sheetName: importDraft.sheets[importDraft.sheet].name, hasHeader: $('#has-header').checked });
    if (!d.rows.length) return toast('该工作表没有人员记录，请检查表头设置', true);
    d.format = importDraft.format; d.encoding = importDraft.encoding; applyAliases(d);
    task.datasets.push(d); invalidate(); closeModal(); render(); toast(`已导入 ${d.rows.length} 条记录`); await processFileQueue();
  }
  else if (action === 'cancel-import') { closeModal(); fileQueue = []; }
  else if (action === 'to-settings' || action === 'back-import' || action === 'step') {
    const next = action === 'to-settings' ? 2 : action === 'back-import' ? 1 : Number(value);
    if (next > 1 && task.datasets.length < 2) return toast('请至少导入两份名单', true);
    if (next === 3 && !state.result) return startCompare();
    state.nav = 'workspace'; state.step = next; render();
  }
  else if (action === 'compare') startCompare();
  else if (action === 'fallback') {
    if (task.datasets.length < 2) return toast('请至少导入两份名单', true);
    state.result = compareDatasets(task.datasets, task.config, task.overrides); state.fallback = true; state.step = 3; state.tab = 'missing'; render(); candidatesModal(true);
  }
  else if (action === 'tab') { state.tab = value; state.page = 1; state.search = ''; state.occurrence = ''; state.listFilter = ''; render(); }
  else if (action === 'sort') { state.sortDir = state.sortKey === value ? -state.sortDir : 1; state.sortKey = value; renderTable(); }
  else if (action === 'prev-page' || action === 'next-page') { state.page += action === 'next-page' ? 1 : -1; renderTable(); }
  else if (action === 'mask') { state.masked = !state.masked; render(); }
  else if (action === 'details') detailsModal(id);
  else if (action === 'preview') previewModal(id);
  else if (action === 'edit-row') editRowModal(id, value);
  else if (action === 'save-row') saveRow(id, value);
  else if (action === 'restore-row') {
    if (!canEdit()) return; const row = task.datasets.find((d) => d.id === id).rows.find((r) => r.id === value);
    if (row.originalValues) { row.values = clone(row.originalValues); delete row.originalValues; invalidate(); log('还原原始记录'); }
    previewModal(id); render();
  }
  else if (action === 'exclude-row') {
    if (!canEdit()) return; const d = task.datasets.find((d) => d.id === id), row = d.rows.find((r) => r.id === value);
    if (row.excluded) {
      const descendantIds = new Set([row.id]);
      let added;
      do { added = false; d.rows.forEach((r) => { if (r.derivedFrom && descendantIds.has(r.derivedFrom) && !descendantIds.has(r.id)) { descendantIds.add(r.id); added = true; } }); } while (added);
      const derived = d.rows.filter((r) => r.id !== row.id && descendantIds.has(r.id) && !r.excluded);
      if (derived.length) {
        if (!await confirmModal('还原拆分记录', `恢复原始行，并排除由它生成的 ${derived.length} 条记录，避免重复统计。`, '确认还原')) return previewModal(id);
        if (!canEdit()) return; derived.forEach((r) => { r.excluded = true; r.exclusionReason = '已还原源记录'; });
      }
    }
    row.excluded = !row.excluded; invalidate(); log(row.excluded ? '排除记录' : '恢复排除记录'); previewModal(id); render();
  }
  else if (action === 'merge-rows') mergeRows(id);
  else if (action === 'split-row') splitRowModal(id, value);
  else if (action === 'confirm-split') confirmSplit(id, value);
  else if (action === 'name-candidates') candidatesModal(false);
  else if (action === 'confirm-candidate') confirmCandidate(id);
  else if (action === 'undo-name') {
    if (!canEdit()) return; task.overrides = []; state.result = compareDatasets(task.datasets, task.config, []); saveTask('撤销姓名补充匹配', false); closeModal(); render(); toast('已撤销姓名补充匹配');
  }
  else if (action === 'export') exportModal();
  else if (action === 'download') doExport();
  else if (action === 'copy') {
    const rows = flatRows(visibleRows()); if (!rows.length) return toast('没有可以复制的记录', true);
    const keys = [...new Set(rows.flatMap(Object.keys))]; const text = [keys, ...rows.map((r) => keys.map((k) => String(r[k] ?? '').replace(/[\t\r\n]/g, ' ')))].map((row) => row.join('\t')).join('\n');
    await navigator.clipboard.writeText(text); toast(`已复制 ${rows.length} 条来源记录`);
  }
  else if (action === 'save-template') {
    const name = await textModal('保存个人模板', task.config.matchFields.map(fieldName).join(' + ') + '比对'); if (!name) return;
    templates.push({ id: uid(), owner: user.id, name, config: clone(task.config), createdAt: Date.now() }); persist(); render(); toast('个人模板已保存');
  }
  else if (action === 'use-template') {
    if (!canEdit()) return; const template = templates.find((t) => t.id === id); if (template?.owner !== user.id) return;
    task.config = clone(template.config); task.datasets.forEach(applyAliases); invalidate(); state.nav = 'workspace'; state.step = task.datasets.length >= 2 ? 2 : 1; render(); toast('已应用个人模板');
  }
  else if (action === 'delete-template') {
    if (!await confirmModal('删除个人模板', '删除后无法恢复，历史任务不受影响。', '删除模板')) return;
    templates = templates.filter((t) => t.id !== id || t.owner !== user.id); persist(); render();
  }
  else if (action === 'aliases') aliasesModal();
  else if (action === 'save-aliases') {
    if (!canEdit()) return;
    $$('[data-alias]').forEach((el) => { task.config.aliases[el.dataset.alias] = el.value.split(/[,，\n]/).map((v) => v.trim()).filter(Boolean); });
    task.datasets.forEach(applyAliases); invalidate(); closeModal(); render(); toast('识别关键词已更新');
  }
  else if (action === 'add-field') {
    if (!canEdit()) return; const name = await textModal('添加统一字段', '', '例如：专业、部门、身份证号'); if (!name) return;
    if (Object.values(labels()).includes(name)) return toast('该字段已存在', true);
    const key = `field-${uid().slice(0, 8)}`; task.config.fieldLabels[key] = name; task.config.aliases[key] = [name]; task.datasets.forEach(applyAliases); invalidate(); render();
  }
  else if (action === 'open-task') {
    if (hasUnsavedChanges() && !await confirmModal('打开历史任务', '当前未保存的内容将被清空。是否继续？', '打开任务')) return;
    const saved = tasks.find((t) => t.id === id); if (!saved) return toast('任务已删除或到期', true);
    releaseLock(); task = clone(saved); acquireLock(); state.nav = 'workspace'; state.result = compareDatasets(task.datasets, task.config, task.overrides); state.fallback = false; state.step = 3; state.tab = 'all'; state.page = 1; render();
  }
  else if (action === 'delete-task') {
    const saved = tasks.find((t) => t.id === id); if (saved?.owner !== user.id) return toast('只能删除自己创建的任务', true);
    let lock; try { lock = JSON.parse(localStorage.getItem(`roster-lock:${id}`) || 'null'); } catch { lock = null; }
    if (lock && lock.until > Date.now() && lock.tabId !== tabId) return toast('任务正在其他页面编辑，请结束编辑后删除', true);
    if (!await confirmModal('删除任务与全部数据', '原始名单、比对结果和操作记录将一并删除。此操作无法恢复。', '删除任务')) return;
    tasks = tasks.filter((t) => t.id !== id); localStorage.removeItem(`roster-lock:${id}`);
    if (task.id === id) { releaseLock(); task = newTask(); state.result = null; state.step = 1; state.readOnly = false; }
    persist(); render(); toast('任务及相关操作记录已删除');
  }
  else if (action === 'retry-lock') { acquireLock(); render(); toast(state.readOnly ? '其他用户仍在编辑' : '已进入编辑状态', state.readOnly); }
  else if (action === 'account') accountModal();
  else if (action === 'auth') authModal(value || 'login');
  else if (action === 'auth-submit') await authSubmit(value);
  else if (action === 'switch-user') {
    if (hasUnsavedChanges() && !await confirmModal('切换演示用户', '未保存的当前内容将被清空，已保存任务可以继续查看。', '切换用户')) return;
    releaseLock(); user = value === 'colleague' ? { id: 'demo-colleague', name: '陈老师', email: 'colleague@example.com' } : { id: 'demo-me', name: '李老师', email: 'teacher@example.com' }; task = newTask(); state.step = 1; state.nav = 'history'; state.result = null; state.readOnly = false; persist(); closeModal(); render(); toast(`已切换为${user.name}`);
  }
  else if (action === 'end-edit') { if (task.saved && canEdit() && !saveTask('结束编辑', false)) return; releaseLock(); state.readOnly = true; closeModal(); render(); toast('已结束编辑，其他页面可以接手'); }
  else if (action === 'close-modal') { if ($('.modal')?.getAttribute('aria-label') === '确认导入') { fileQueue = []; importDraft = null; } closeModal(); }
}
function startCompare() {
  if (task.datasets.length < 2) return toast('请至少导入两份名单', true);
  if (!task.config.matchFields.length) return toast('请至少选择一个匹配字段', true);
  if (task.datasets.some((d) => task.config.matchFields.some((f) => !d.mapping[f]))) return toast('请先确认每份名单的匹配列，或使用姓名预览', true);
  state.result = compareDatasets(task.datasets, task.config, task.overrides); state.step = 3; state.nav = 'workspace'; state.tab = 'all'; state.page = 1; state.search = ''; state.occurrence = ''; state.listFilter = ''; state.fallback = false;
  if (!state.readOnly) saveTask(task.saved ? '重新比对' : '创建并比对任务', false); render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function applyAliases(dataset) {
  for (const [key, words] of Object.entries(task.config.aliases || {})) {
    if (dataset.mapping[key]) continue;
    const matches = dataset.columns.filter((c) => words.some((w) => c.label.trim().toLowerCase().includes(w.trim().toLowerCase())));
    if (matches.length === 1) dataset.mapping[key] = matches[0].key;
  }
}

let modalReturnFocus = null;
let modalResolver = null;
function openModal(title, body, footer = '', size = '') {
  if (!$('#modal-root').firstChild) modalReturnFocus = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${size}" role="dialog" aria-modal="true" aria-label="${escape(title)}" tabindex="-1"><header class="modal-head"><h2>${escape(title)}</h2>${iconButton('close-modal', '关闭窗口', 'x')}</header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}</section></div>`;
  document.body.style.overflow = 'hidden'; hydrate(); $('.modal').focus();
}
function closeModal() {
  $('#modal-root').innerHTML = ''; document.body.style.overflow = ''; modalContext = null;
  if (modalResolver) { const resolve = modalResolver; modalResolver = null; resolve(null); }
  modalReturnFocus?.focus();
}
document.addEventListener('keydown', (e) => {
  const modal = $('.modal'); if (!modal) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
  if (e.key === 'Tab') {
    const els = $$('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]', modal).filter((el) => el.getClientRects().length);
    const first = els[0], last = els.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || document.activeElement === modal)) { e.preventDefault(); first?.focus(); }
  }
});
function confirmModal(title, text, command) {
  return new Promise((resolve) => {
    openModal(title, `<p class="muted" style="line-height:1.9;font-size:13px">${escape(text)}</p>`, `${button('close-modal', '取消', '', '')}<button class="btn primary" id="confirm-command">${escape(command)}</button>`, 'small-modal');
    modalResolver = resolve; $('#confirm-command').onclick = () => { modalResolver = null; closeModal(); resolve(true); };
  });
}
function textModal(title, initial, placeholder = '') {
  return new Promise((resolve) => {
    openModal(title, `<input class="input" id="text-value" maxlength="80" aria-label="${escape(title)}" value="${escape(initial)}" placeholder="${escape(placeholder)}"/>`, `${button('close-modal', '取消', '')}<button class="btn primary" id="text-confirm">确认</button>`, 'small-modal');
    modalResolver = resolve; $('#text-value').focus(); $('#text-value').select();
    const submit = () => { const text = $('#text-value').value.trim(); if (!text) return toast('请输入内容', true); modalResolver = null; closeModal(); resolve(text); };
    $('#text-confirm').onclick = submit; $('#text-value').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });
}
function pasteModal() {
  openModal('粘贴人员名单', `<div class="form-row"><label for="paste-name">名单名称</label><input id="paste-name" class="input" value="粘贴名单 ${task.datasets.length + 1}" maxlength="80"/></div><div class="form-row"><label for="paste-text">名单内容</label><textarea id="paste-text" aria-label="粘贴名单内容" placeholder="学号&#9;姓名&#9;班级&#10;2024001&#9;张三&#9;测控一班&#10;2024002&#9;李四&#9;测控二班" rows="9"></textarea></div>`, `${button('close-modal', '取消', '')}${button('parse-paste', '预览数据', 'arrow-right', 'primary')}`);
  $('#paste-text').focus();
}
async function enqueueFiles(files) {
  if (!canEdit()) return;
  const allowed = files.filter((file) => { if (file.size > 50 * 1024 * 1024) { toast(`${file.name} 超过单文件 50 MB 限制`, true); return false; } return true; });
  fileQueue.push(...allowed); if (!importDraft || !$('.modal')) await processFileQueue();
}
async function processFileQueue() {
  if (!fileQueue.length) { importDraft = null; return; }
  const file = fileQueue.shift(); importDraft = null; state.busy = true; toast(`正在读取 ${file.name}`);
  try {
    const read = await readRosterFile(file); importDraft = { ...read, sourceName: file.name.replace(/\.[^.]+$/, ''), format: file.name.split('.').pop().toLowerCase(), sheet: 0, header: detectHeader(read.sheets[0].grid) }; importModal();
  } catch (error) { toast(error.message, true); }
  finally { state.busy = false; }
  if (!importDraft && fileQueue.length) await processFileQueue();
}
function importModal() {
  const grid = importDraft.sheets[importDraft.sheet].grid;
  const width = grid.reduce((max, row) => Math.max(max, row.length), 1);
  openModal('确认导入', `<div class="form-grid"><div class="form-row"><label for="import-name">名单名称</label><input class="input" id="import-name" value="${escape(importDraft.sourceName)}" maxlength="80"/></div><div class="form-row"><label for="sheet-select">工作表</label><select class="input" id="sheet-select">${importDraft.sheets.map((sheet, i) => `<option value="${i}" ${i === importDraft.sheet ? 'selected' : ''}>${escape(sheet.name)}</option>`).join('')}</select></div></div><div class="flex between preview-info"><label class="flex"><input id="has-header" type="checkbox" ${importDraft.header ? 'checked' : ''}/>第一行为表头</label><span>${grid.length} 行 · ${width} 列 · ${escape(importDraft.encoding)}</span></div><div class="table-wrap"><table class="data-table"><thead><tr>${Array.from({ length: width }, (_, i) => `<th>第 ${i + 1} 列</th>`).join('')}</tr></thead><tbody>${grid.slice(0, 7).map((row) => `<tr>${Array.from({ length: width }, (_, i) => `<td>${escape(row[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`, `${button('cancel-import', '取消导入', '')}${button('confirm-import', '确认导入', 'check', 'primary')}`, 'wide');
  $('#sheet-select').onchange = (e) => { importDraft.sourceName = $('#import-name').value; importDraft.sheet = Number(e.target.value); importDraft.header = detectHeader(importDraft.sheets[importDraft.sheet].grid); importModal(); };
}
function previewModal(id) {
  const dataset = task.datasets.find((d) => d.id === id); if (!dataset) return;
  openModal(dataset.name, `<div class="preview-info flex between"><span>${sourceRows(dataset).length} 条原始记录 · ${dataset.rows.filter((r) => r.derivedFrom).length} 条衍生 · ${dataset.rows.filter((r) => r.excluded).length} 条已排除</span>${button('merge-rows', '合并选中行', 'merge', 'compact', `data-id="${id}" ${state.readOnly ? 'disabled' : ''}`)}</div><div class="table-wrap"><table class="data-table"><thead><tr><th>选择</th>${dataset.columns.map((c) => `<th>${escape(c.label)}</th>`).join('')}<th>状态</th><th>操作</th></tr></thead><tbody>${dataset.rows.map((r) => `<tr style="${r.excluded ? 'color:#a4aea7;background:#f8f9f8' : ''}"><td><input type="checkbox" data-row-select="${r.id}" aria-label="选择记录 ${escape(r.id)}" ${r.excluded ? 'disabled' : ''}/></td>${dataset.columns.map((c) => `<td>${escape(displayValue(id, c.key, r.values[c.key]))}</td>`).join('')}<td><span class="pill ${r.originalValues ? 'blue' : ''}">${r.excluded ? '已排除' : r.originalValues ? '已修改' : r.derivedFrom ? '拆分生成' : '原始记录'}</span></td><td><div class="flex" style="gap:2px">${iconButton('edit-row', '修改记录', 'pencil', `data-id="${id}" data-value="${r.id}" ${state.readOnly ? 'disabled' : ''}`)}${iconButton('split-row', '拆分记录', 'split', `data-id="${id}" data-value="${r.id}" ${state.readOnly || r.excluded ? 'disabled' : ''}`)}${iconButton('exclude-row', r.excluded ? '恢复记录' : '排除记录', r.excluded ? 'rotate-ccw' : 'circle-minus', `data-id="${id}" data-value="${r.id}" ${state.readOnly ? 'disabled' : ''}`)}${r.originalValues ? iconButton('restore-row', '还原原始内容', 'undo-2', `data-id="${id}" data-value="${r.id}" ${state.readOnly ? 'disabled' : ''}`) : ''}</div></td></tr>`).join('')}</tbody></table></div>`, button('close-modal', '完成', 'check', 'primary'), 'wide');
}
function editRowModal(datasetId, rowId) {
  if (!canEdit()) return;
  const d = task.datasets.find((d) => d.id === datasetId), row = d.rows.find((r) => r.id === rowId);
  openModal('编辑人员记录', `<div class="form-grid">${d.columns.map((c) => `<div class="form-row"><label for="row-${c.key}">${escape(c.label)}</label><input class="input" id="row-${c.key}" data-column="${c.key}" value="${escape(row.values[c.key])}"/></div>`).join('')}</div>`, `${button('preview', '取消', '', '', `data-id="${datasetId}"`)}${button('save-row', '保存修改', 'check', 'primary', `data-id="${datasetId}" data-value="${rowId}"`)}`);
}
function saveRow(datasetId, rowId) {
  if (!canEdit()) return;
  const row = task.datasets.find((d) => d.id === datasetId).rows.find((r) => r.id === rowId);
  row.originalValues ||= clone(row.values); $$('[data-column]').forEach((el) => { row.values[el.dataset.column] = el.value; }); invalidate(); log('修改人员记录'); previewModal(datasetId); render(); toast('记录已修改，原始内容已保留');
}
async function mergeRows(datasetId) {
  if (!canEdit()) return;
  const selected = $$('[data-row-select]:checked').map((el) => el.dataset.rowSelect);
  if (selected.length < 2) return toast('请选择至少两条记录', true);
  const d = task.datasets.find((d) => d.id === datasetId), rows = d.rows.filter((r) => selected.includes(r.id));
  const conflictColumns = d.columns.filter((c) => new Set(rows.map((r) => r.values[c.key]?.trim()).filter(Boolean)).size > 1);
  if (conflictColumns.length) {
    openModal('确认合并字段', `<p class="muted small" style="margin-bottom:18px">合并为一条有效记录，原始行保留。请确认冲突字段取值。</p><div class="form-grid">${d.columns.map((c) => `<div class="form-row"><label>${escape(c.label)}</label><select class="input" data-merge-key="${c.key}">${[...new Set(rows.map((r) => r.values[c.key] || ''))].map((v) => `<option value="${escape(v)}">${escape(v || '空')}</option>`).join('')}</select></div>`).join('')}</div>`, `${button('preview', '取消', '', '', `data-id="${datasetId}"`)}<button class="btn primary" id="confirm-merge">确认合并</button>`);
    $('#confirm-merge').onclick = () => { const values = Object.fromEntries($$('[data-merge-key]').map((el) => [el.dataset.mergeKey, el.value])); applyMerge(d, rows, values); };
  } else {
    if (!await confirmModal('合并所选记录', '合并为一条有效记录，其他原始行保留并标记为已排除。', '确认合并')) return previewModal(datasetId);
    const values = Object.fromEntries(d.columns.map((c) => [c.key, rows.find((r) => r.values[c.key]?.trim())?.values[c.key] || ''])); applyMerge(d, rows, values);
  }
}
function applyMerge(dataset, rows, values) {
  if (!canEdit()) return;
  const [first, ...rest] = rows; first.originalValues ||= clone(first.values); first.values = values;
  rest.forEach((r) => { r.excluded = true; r.exclusionReason = `合并至 ${first.id}`; }); invalidate(); log('人工合并记录'); previewModal(dataset.id); render(); toast('已合并，所有原始行仍保留');
}
function splitRowModal(datasetId, rowId) {
  if (!canEdit()) return;
  const d = task.datasets.find((d) => d.id === datasetId), row = d.rows.find((r) => r.id === rowId);
  openModal('拆分人员记录', `<div class="form-row"><label for="split-separator">拆分分隔符</label><select id="split-separator" class="input"><option value="、">顿号（、）</option><option value=",">英文逗号（,）</option><option value="，">中文逗号（，）</option><option value=";">分号（;）</option><option value=" ">空格</option><option value="\n">换行</option></select></div><div class="form-row"><label>需要拆分的列</label><div class="checks">${d.columns.map((c) => `<label class="check-option"><input type="checkbox" data-split-column="${c.key}" ${/[、,，;\n]/.test(row.values[c.key]) ? 'checked' : ''}/>${escape(c.label)}</label>`).join('')}</div></div><div class="notice blue">${icon('info')}<span>未选择的列复制到每条新记录；被拆分的原始行保留在已排除列表。</span></div>`, `${button('preview', '取消', '', '', `data-id="${datasetId}"`)}${button('confirm-split', '确认拆分', 'split', 'primary', `data-id="${datasetId}" data-value="${rowId}"`)}`);
}
function confirmSplit(datasetId, rowId) {
  if (!canEdit()) return;
  const d = task.datasets.find((d) => d.id === datasetId), row = d.rows.find((r) => r.id === rowId), separator = $('#split-separator').value;
  if (row.excluded) return toast('已排除的记录不能拆分，请先恢复', true);
  const columns = $$('[data-split-column]:checked').map((el) => el.dataset.splitColumn);
  if (!columns.length) return toast('请选择需要拆分的列', true);
  const parts = Object.fromEntries(columns.map((key) => [key, String(row.values[key] || '').split(separator).map((v) => v.trim())]));
  const size = Math.max(...Object.values(parts).map((p) => p.length));
  if (size < 2) return toast('所选字段中没有对应分隔符', true);
  if (Object.values(parts).some((p) => p.length !== size)) return toast('所选各列拆分数量不一致，请先整理对应关系', true);
  const derived = Array.from({ length: size }, (_, i) => ({ id: uid(), values: { ...row.values, ...Object.fromEntries(columns.map((key) => [key, parts[key][i]])) }, derivedFrom: row.id }));
  row.excluded = true; row.exclusionReason = '已拆分'; d.rows.push(...derived); invalidate(); log('人工拆分记录'); previewModal(datasetId); render(); toast(`已拆分为 ${size} 条记录，原始行已保留`);
}

function detailsModal(personId) {
  const person = categoryRecords(getResult()).find((p) => p.id === personId); if (!person) return;
  openModal(`${person.name || '人员'} · 来源详情`, `<div class="flex between" style="margin-bottom:20px"><div class="flex wrap">${personPills(person)}<span class="small muted">${person.records.length} 条原始记录</span></div><span class="small muted">${state.masked ? '敏感字段已脱敏' : '完整显示'}</span></div>${person.conflict ? `<div class="notice" style="margin:0 0 20px">${icon('flag')}<span>冲突字段：${person.conflictFields.map(fieldName).join('、')}</span></div>` : ''}<div class="detail-records">${person.records.map((r) => {
    const d = task.datasets.find((d) => d.id === r.datasetId), row = d.rows.find((row) => row.id === r.rowId);
    return `<div class="raw-heading">${icon('file-spreadsheet')}${escape(d.name)}<span class="muted small">记录 ${escape(r.rowId)}</span>${row.originalValues ? '<span class="pill blue">已修改</span>' : ''}</div><div class="raw-values">${d.columns.map((c) => `<div class="raw-value"><label>${escape(c.label)}</label><span style="${person.conflictFields?.some((f) => d.mapping[f] === c.key) ? 'color:#b86d53' : ''}">${escape(displayValue(d.id, c.key, r.values[c.key]) || '—')}</span>${row.originalValues ? `<div class="small muted" style="margin-top:6px">原值：${escape(displayValue(d.id, c.key, row.originalValues[c.key]))}</div>` : ''}</div>`).join('')}</div>`;
  }).join('')}</div>`, button('close-modal', '关闭', ''), 'wide');
}
function candidatesModal(preview = false) {
  const result = getResult();
  let candidates = findNameCandidates(task.datasets, result);
  if (preview && !candidates.length) {
    const namePreview = compareDatasets(task.datasets, { ...task.config, matchFields: ['name'] });
    candidates = namePreview.people.filter((p) => p.occurrence > 1).map((p) => ({ id: p.id, name: p.name, records: p.records, recordIds: p.records.map((r) => r.recordId), listNames: p.listNames, ambiguous: p.duplicate || new Set(p.records.map((r) => r.mapped.studentId).filter(Boolean)).size > 1 }));
  }
  modalContext = { candidates, preview };
  const body = `<div class="notice ${preview ? '' : 'blue'}" style="margin:0 0 20px">${icon('scan-search')}<span>${preview ? '姓名预览 · 待确认，确认字段前不可计入正式统计或导出' : '仅处理至少一方缺少匹配字段的记录，人工确认后计入正式人数。'}</span></div>${candidates.length ? candidates.map((c) => `<div class="candidate"><div class="grow"><div class="flex"><h3>${escape(c.name)}</h3><span class="pill ${c.ambiguous ? 'amber' : 'blue'}">${c.ambiguous ? '同名歧义 · 人工核对' : '待确认'}</span></div><p>${(c.listNames || []).map(escape).join(' · ')}</p>${c.ambiguous ? `<div class="stack" style="gap:6px;margin-top:12px">${c.records.map((r) => `<label class="small muted flex"><input type="checkbox" data-candidate="${escape(c.id)}" data-record="${escape(r.recordId)}"/><span>${escape(r.datasetName)} · ${escape(r.mapped.name)} · ${escape(r.mapped.studentId || '学号为空')} · ${escape(r.mapped.className || '班级为空')}</span></label>`).join('')}</div>` : `<p>${c.records.map((r) => `${escape(r.datasetName)}：${escape(r.mapped.studentId || '学号为空')}`).join(' / ')}</p>`}</div>${button('confirm-candidate', preview ? '待确认字段' : '确认匹配', 'check', 'compact', `data-id="${escape(c.id)}" ${preview || state.readOnly ? 'disabled' : ''}`)}</div>`).join('') : `<div class="empty" style="border:0">${icon('user-search')}<h3>没有可补充匹配的姓名候选</h3></div>`}`;
  openModal(preview ? '姓名匹配预览' : '按姓名补充比对', body, `${task.overrides.length ? button('undo-name', '撤销姓名补充', 'undo-2', '', state.readOnly ? 'disabled' : '') : ''}${button('close-modal', '完成', '', 'primary')}`);
  modalContext = { candidates, preview };
}
function confirmCandidate(id) {
  if (!canEdit()) return;
  const candidate = modalContext?.candidates.find((c) => c.id === id); if (!candidate || modalContext.preview) return;
  const recordIds = candidate.ambiguous ? $$('[data-candidate]:checked').filter((el) => el.dataset.candidate === id).map((el) => el.dataset.record) : candidate.recordIds;
  if (recordIds.length < 2) return toast('请至少选择两条跨名单的对应记录', true);
  const nextOverrides = [...task.overrides, { recordIds }]; const next = compareDatasets(task.datasets, task.config, nextOverrides);
  if (next.warnings.length) return toast('所选记录的已有学号或匹配字段相互矛盾，不能合并', true);
  task.overrides = nextOverrides; state.result = next; saveTask('确认姓名补充匹配', false); render(); candidatesModal(); toast('姓名匹配已确认，人数已重新计算');
}
function flatRows(people) {
  return people.flatMap((p) => p.records.map((r) => {
    const dataset = task.datasets.find((d) => d.id === r.datasetId), row = dataset.rows.find((row) => row.id === r.rowId);
    const out = { 人员学号: p.studentId || r.mapped.studentId || '', 人员姓名: p.name || r.mapped.name || '', 出现名单数: p.occurrence || '', 出现名单: (p.listNames || [p.datasetName || r.datasetName]).join('、'), 来源名单: r.datasetName, 重复次数: p.count || '', 信息冲突: p.conflict ? p.conflictFields.map(fieldName).join('、') : '', 匹配方式: p.manual ? '按姓名补充匹配（已确认）' : state.fallback ? '待确认预览' : task.config.matchFields.map(fieldName).join('+'), 记录状态: row.excluded ? '已排除' : row.originalValues ? '已修改' : row.derivedFrom ? '拆分生成' : '原始记录', 来源原始行: row.derivedFrom || row.id };
    dataset.columns.forEach((c) => { const label = exportColumnName(dataset, c); out[`原始.${label}`] = displayValue(dataset.id, c.key, r.values[c.key]); if (row.originalValues) out[`修改前.${label}`] = displayValue(dataset.id, c.key, row.originalValues[c.key]); });
    return out;
  }));
}
function exportModal() {
  if (state.fallback) return toast('待确认预览不能导出，请先确认匹配字段', true);
  openModal('导出比对结果', `<div class="form-row"><label>文件格式</label><div class="checks"><label class="check-option"><input type="radio" name="export-format" value="xlsx" checked/>Excel（.xlsx）</label><label class="check-option"><input type="radio" name="export-format" value="csv"/>CSV（.csv）</label></div></div><div class="form-row"><label>导出范围</label><div class="checks"><label class="check-option"><input type="radio" name="export-scope" value="all" checked/>全部结果</label><label class="check-option"><input type="radio" name="export-scope" value="filtered"/>当前标签页与筛选结果</label></div></div><div class="form-row" id="excel-organization"><label for="export-structure">Excel 分类方式</label><select id="export-structure" class="input"><option value="occurrence">按出现次数分类</option><option value="combination">按名单组合分类</option></select></div><div class="notice green" style="margin-top:10px">${icon('shield-check')}<span>本次导出${state.masked ? '保持敏感字段脱敏' : '包含完整敏感字段'} · 保留全部原始列</span></div>`, `${button('close-modal', '取消', '')}${button('download', '下载文件', 'download', 'primary')}`);
  $$('[name="export-format"]').forEach((radio) => radio.onchange = () => { $('#excel-organization').hidden = $('input[name="export-format"]:checked').value === 'csv'; });
}
function doExport() {
  if (state.fallback) return;
  const format = $('input[name="export-format"]:checked').value, scope = $('input[name="export-scope"]:checked').value;
  const structure = $('#export-structure').value, result = getResult();
  const filename = task.name.replace(/[<>:"/\\|?*]/g, '_');
  if (format === 'csv') {
    const rows = flatRows(scope === 'filtered' ? visibleRows() : [...result.people, ...result.missing.map((r) => ({ records: [r], name: r.mapped.name, studentId: r.mapped.studentId, listNames: [r.datasetName], occurrence: 0 })), ...result.excluded.map((r) => ({ records: [r], name: r.mapped.name, studentId: r.mapped.studentId, listNames: [r.datasetName], occurrence: 0 }))]);
    if (!rows.length) return toast('没有可导出的记录', true);
    downloadCSV(rows, `${filename}${scope === 'filtered' ? '_当前筛选' : '_全部结果'}.csv`);
  } else {
    const summary = [{ 项目: '任务名称', 数值: task.name }, { 项目: '创建者', 数值: task.ownerName }, { 项目: '创建时间', 数值: nowText(task.createdAt) }, { 项目: '匹配字段', 数值: task.config.matchFields.map(fieldName).join('+') }, { 项目: '敏感字段', 数值: state.masked ? '已脱敏' : '完整显示' }, ...[['名单份数', task.datasets.length], ['原始记录', result.summary.rawRecords], ['有效记录', result.summary.validRecords], ['去重人数', result.summary.uniquePeople], ['全部重合人数', result.summary.allCount], ['单份独有人数', result.summary.onlyCount], ['缺少字段记录', result.missing.length], ['已排除记录', result.excluded.length]].map(([项目, 数值]) => ({ 项目, 数值 }))];
    const sheets = [{ name: '统计汇总', rows: summary }];
    if (scope === 'filtered') sheets.push({ name: '当前筛选结果', rows: flatRows(visibleRows()) });
    else {
      sheets.push({ name: '全部重合', rows: flatRows(result.people.filter((p) => p.occurrence === task.datasets.length)) }, { name: '单份独有', rows: flatRows(result.people.filter((p) => p.occurrence === 1)) });
      const groups = new Map();
      for (const person of result.people) {
        const key = structure === 'occurrence' ? `出现于${person.occurrence}份名单` : JSON.stringify(person.listIds.toSorted());
        if (!groups.has(key)) groups.set(key, { name: structure === 'occurrence' ? key : `组合${groups.size + 1}_${person.listNames.join('+')}`, people: [] });
        groups.get(key).people.push(person);
      }
      groups.forEach((group) => sheets.push({ name: group.name, rows: flatRows(group.people) }));
      sheets.push({ name: '重复数据', rows: flatRows(result.duplicates) }, { name: '信息冲突', rows: flatRows(result.people.filter((p) => p.conflict)) }, { name: '缺少匹配字段', rows: flatRows(result.missing.map((r) => ({ records: [r], listNames: [r.datasetName] }))) }, { name: '已排除', rows: flatRows(result.excluded.map((r) => ({ records: [r], listNames: [r.datasetName] }))) });
      task.datasets.forEach((d) => sheets.push({ name: `原始_${d.name}`, rows: sourceRows(d).map((r) => Object.fromEntries([['记录状态', r.excluded ? '已排除' : r.originalValues ? '已修改' : '原始记录'], ...d.columns.map((c) => [exportColumnName(d, c), displayValue(d.id, c.key, (r.originalValues || r.values)[c.key])])])) }));
    }
    downloadWorkbook(sheets, `${filename}.xlsx`);
  }
  // Read-only viewers can export; they never replace another editor's task snapshot.
  const saved = tasks.find((t) => t.id === task.id);
  if (saved) { const entry = { id: uid(), action: `导出 ${format.toUpperCase()}（${scope === 'filtered' ? '当前筛选' : '全部结果'}）`, by: user.name, at: Date.now() }; saved.logs.push(entry); task.logs.push(clone(entry)); persist(); }
  closeModal(); toast('文件已导出');
}
function aliasesModal() {
  openModal('自定义识别关键词', `<div class="form-grid">${Object.entries(labels()).map(([key, label]) => `<div class="form-row"><label for="alias-${key}">${escape(label)}</label><input class="input" id="alias-${key}" data-alias="${key}" value="${escape((task.config.aliases[key] || []).join('，'))}" placeholder="多个关键词用逗号分隔"/></div>`).join('')}</div>`, `${button('close-modal', '取消', '')}${button('save-aliases', '保存关键词', 'check', 'primary', state.readOnly ? 'disabled' : '')}`);
}
function accountModal() {
  openModal('演示账号', `<div class="flex"><span class="avatar" style="width:42px;height:42px">${escape(user.name[0])}</span><div><h3>${escape(user.name)}</h3><p class="small muted" style="margin-top:7px">${escape(user.email)}</p></div><span class="pill green" style="margin-left:auto">管理权限</span></div><div class="account-options">${button('switch-user', '切换为李老师', 'user-round', '', 'data-value="me"')}${button('switch-user', '切换为陈老师', 'user-round', '', 'data-value="colleague"')}${button('auth', '登录 / 注册流程', 'log-in', '', 'data-value="login"')}${task.saved ? button('end-edit', '结束当前任务编辑', 'lock-open', '', state.readOnly ? 'disabled' : '') : ''}</div><div class="notice blue">${icon('flask-conical')}<span>账号流程为本机演示，未连接账号服务器或邮件服务。</span></div>`, button('close-modal', '关闭', ''), 'small-modal');
}
function authModal(mode = 'login') {
  const title = mode === 'login' ? '登录' : mode === 'register' ? '注册账号' : '找回密码';
  openModal(`${title} · 原型`, `<div class="auth-tabs">${[['login', '登录'], ['register', '注册'], ['reset', '找回密码']].map(([key, text]) => `<button data-action="auth" data-value="${key}" class="${mode === key ? 'active' : ''}">${text}</button>`).join('')}</div><form id="auth-form">${mode !== 'reset' ? `<div class="form-row"><label for="auth-name">${mode === 'login' ? '用户名或邮箱' : '用户名'}</label><input class="input" id="auth-name" required autocomplete="username" placeholder="${mode === 'login' ? 'teacher@example.com' : '请输入用户名'}" maxlength="50"/></div>` : ''}${mode !== 'login' ? `<div class="form-row"><label for="auth-email">邮箱</label><input class="input" id="auth-email" type="email" required autocomplete="email" placeholder="teacher@example.com"/></div>` : ''}${mode !== 'reset' ? `<div class="form-row"><label for="auth-password">密码</label><input class="input" id="auth-password" type="password" minlength="8" required autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" placeholder="至少 8 位"/></div>` : ''}${mode === 'register' ? `<div class="form-row"><label for="auth-confirm">确认密码</label><input class="input" id="auth-confirm" type="password" minlength="8" required autocomplete="new-password"/></div>` : ''}</form><div class="notice blue">${icon('flask-conical')}<span>${mode === 'reset' ? '邮件重置流程演示，不会实际发送邮件。' : '本机演示，不验证或保存密码。'}</span></div>`, `${button('close-modal', '取消', '')}${button('auth-submit', mode === 'reset' ? '预览重置流程' : title, mode === 'reset' ? 'mail' : 'arrow-right', 'primary', `data-value="${mode}"`)}`, 'small-modal');
  $('#auth-form').onsubmit = (e) => { e.preventDefault(); authSubmit(mode); };
}
async function authSubmit(mode) {
  if (!$('#auth-form').reportValidity()) return;
  if (mode === 'register' && $('#auth-password').value !== $('#auth-confirm').value) return toast('两次输入的密码不一致', true);
  if (mode === 'reset') {
    const email = $('#auth-email').value;
    openModal('重置密码 · 流程预览', `<div class="form-row"><label>收件邮箱</label><p>${escape(email)}</p></div><div class="form-row"><label>重置链接</label><input class="input" value="https://your-domain/reset-password?token=…" readonly/></div><div class="form-row"><label>新密码</label><input class="input" type="password" placeholder="输入新密码" minlength="8" id="reset-new" /></div><div class="notice blue">${icon('flask-conical')}<span>此处展示邮件链接与新密码页面，邮件服务尚未接入。</span></div>`, button('close-modal', '完成预览', 'check', 'primary'), 'small-modal'); return;
  }
  const name = $('#auth-name').value.trim(), email = mode === 'register' ? $('#auth-email').value : name.includes('@') ? name : 'teacher@example.com';
  if (hasUnsavedChanges() && !await confirmModal('进入演示账号', '未保存的当前内容将被清空，是否继续？', '继续')) return;
  releaseLock(); user = { id: `demo-${name.toLowerCase()}`, name: name.includes('@') ? name.split('@')[0] : name, email }; task = newTask(); state.readOnly = false; state.step = 1; state.result = null; state.nav = 'history'; persist(); closeModal(); render(); toast(mode === 'register' ? '注册流程预览完成，已切换演示身份' : '已进入演示工作空间');
}

window.addEventListener('storage', (event) => {
  if (event.key === storageKey) {
    try { const next = JSON.parse(event.newValue || '{}'); tasks = (next.tasks || []).filter((t) => Date.now() - t.createdAt < 7 * DAY); templates = next.templates || []; }
    catch { return; }
    if (task.saved && !tasks.some((t) => t.id === task.id)) { releaseLock(); task = newTask(); state.step = 1; state.result = null; state.readOnly = false; toast('当前任务已删除或到期'); }
    if (state.readOnly) {
      const current = tasks.find((t) => t.id === task.id);
      if (current) { task = clone(current); state.result = compareDatasets(task.datasets, task.config, task.overrides); }
    }
    render();
  }
  if (event.key === lockKey()) { const lock = readLock(); if (lock && lock.tabId !== tabId) { state.readOnly = true; render(); } }
});
window.addEventListener('beforeunload', releaseLock);
setInterval(() => { cleanExpired(); if (task.saved && !state.readOnly && readLock()?.tabId === tabId) acquireLock(); }, 15000);
persist(); render();
