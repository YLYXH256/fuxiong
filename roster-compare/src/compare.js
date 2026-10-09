const STANDARD_FIELDS = ['studentId', 'name', 'className', 'phone'];

export function normalizeValue(value) {
  return value == null ? '' : String(value).trim();
}

function mappedValues(dataset, row) {
  const mapped = {};
  for (const field of new Set([...STANDARD_FIELDS, ...Object.keys(dataset.mapping || {})])) {
    const columnKey = dataset.mapping?.[field];
    mapped[field] = columnKey ? normalizeValue(row.values?.[columnKey]) : '';
  }
  return mapped;
}

function makeRecord(dataset, row) {
  return {
    recordId: `${dataset.id}:${row.id}`,
    datasetId: dataset.id,
    datasetName: dataset.name,
    rowId: row.id,
    values: { ...(row.values || {}) },
    mapped: mappedValues(dataset, row),
  };
}

function findConflicts(records, fields) {
  return fields.filter((field) => {
    const nonemptyValues = new Set(records.map((record) => record.mapped[field]).filter(Boolean));
    return nonemptyValues.size > 1;
  });
}

function hasDistinctStudentIds(records) {
  return new Set(records.map((record) => record.mapped.studentId).filter(Boolean)).size > 1;
}

function makePerson(records, key, config, manual = false) {
  const listMap = new Map(records.map((record) => [record.datasetId, record.datasetName]));
  const recordsPerList = new Map();
  for (const record of records) {
    recordsPerList.set(record.datasetId, (recordsPerList.get(record.datasetId) || 0) + 1);
  }
  const firstName = records.find((record) => record.mapped.name)?.mapped.name || '';
  const studentId = records.find((record) => record.mapped.studentId)?.mapped.studentId || '';
  const conflictFields = findConflicts(records, config.conflictFields);
  return {
    id: `person:${key}`,
    key,
    label: firstName || studentId || records[0]?.recordId || '',
    studentId,
    name: firstName,
    listIds: [...listMap.keys()],
    listNames: [...listMap.values()],
    occurrence: listMap.size,
    records,
    duplicate: [...recordsPerList.values()].some((count) => count > 1),
    conflict: conflictFields.length > 0,
    conflictFields,
    manual,
    matchedBy: manual ? 'manualName' : 'fields',
  };
}

/** Compare complete keys first; approved links then connect entire existing identity groups. */
export function compareDatasets(datasets, config = {}, overrides = []) {
  const settings = {
    matchFields: config.matchFields?.length ? [...config.matchFields] : ['studentId'],
    conflictFields: [...(config.conflictFields || [])],
  };
  const groups = new Map();
  const missing = [];
  const excluded = [];
  const recordsById = new Map();
  const recordGroupIds = new Map();
  let rawRecords = 0;
  let derivedRecords = 0;

  for (const dataset of datasets) {
    for (const row of dataset.rows || []) {
      if (row.derivedFrom) derivedRecords += 1;
      else rawRecords += 1;
      const record = makeRecord(dataset, row);
      if (row.excluded) {
        excluded.push(record);
        continue;
      }
      if (recordsById.has(record.recordId)) {
        throw new Error(`Duplicate row identity: ${record.recordId}`);
      }
      recordsById.set(record.recordId, record);
      record.missingFields = settings.matchFields.filter((field) => !record.mapped[field]);
      if (record.missingFields.length) {
        missing.push(record);
        const missingKey = `missing:${record.recordId}`;
        groups.set(missingKey, { key: missingKey, records: [record], complete: false, manual: false });
        recordGroupIds.set(record.recordId, missingKey);
        continue;
      }
      const key = JSON.stringify(settings.matchFields.map((field) => record.mapped[field]));
      if (!groups.has(key)) {
        groups.set(key, { key, records: [], complete: true, manual: false });
      }
      groups.get(key).records.push(record);
      recordGroupIds.set(record.recordId, key);
    }
  }

  const warnings = [];
  const links = Array.isArray(overrides) ? overrides : overrides?.matches || [];
  for (const link of links) {
    const ids = [...new Set(link.recordIds || [])];
    if (ids.length < 2 || ids.some((id) => !recordsById.has(id))) {
      warnings.push({ type: 'invalidOverride', recordIds: ids });
      continue;
    }
    const groupIds = [...new Set(ids.map((id) => recordGroupIds.get(id)))];
    if (groupIds.length < 2) continue;
    const selectedGroups = groupIds.map((id) => groups.get(id));
    const linkedRecords = selectedGroups.flatMap((group) => group.records);
    const distinctLists = new Set(linkedRecords.map((record) => record.datasetId));
    const completeKeys = new Set(selectedGroups.filter((group) => group.complete).map((group) => group.key));
    if (distinctLists.size < 2 || completeKeys.size > 1 || hasDistinctStudentIds(linkedRecords)
      || findConflicts(linkedRecords, settings.matchFields).length > 0) {
      warnings.push({ type: 'conflictingOverride', recordIds: ids });
      continue;
    }
    const completeGroup = selectedGroups.find((group) => group.complete);
    const mergedKey = completeGroup?.key || `manual:${linkedRecords.map((record) => record.recordId).sort().join('|')}`;
    for (const groupId of groupIds) groups.delete(groupId);
    groups.set(mergedKey, { key: mergedKey, records: linkedRecords, complete: Boolean(completeGroup), manual: true });
    for (const record of linkedRecords) recordGroupIds.set(record.recordId, mergedKey);
  }

  const people = [...groups.values()]
    .filter((group) => group.complete || group.manual)
    .map((group) => makePerson(group.records, group.key, settings, group.manual));
  const resolvedIds = new Set(people.flatMap((person) => person.records.map((record) => record.recordId)));
  const unresolved = missing.filter((record) => !resolvedIds.has(record.recordId));
  const duplicates = people.flatMap((person) => {
    const perList = new Map();
    for (const record of person.records) {
      if (!perList.has(record.datasetId)) perList.set(record.datasetId, []);
      perList.get(record.datasetId).push(record);
    }
    return [...perList.values()].filter((records) => records.length > 1).map((records) => ({
      id: JSON.stringify([records[0].datasetId, person.key]),
      key: person.key,
      datasetId: records[0].datasetId,
      datasetName: records[0].datasetName,
      name: person.name,
      studentId: person.studentId,
      records,
      count: records.length,
      occurrence: person.occurrence,
      listIds: [...person.listIds],
      listNames: [...person.listNames],
      manual: person.manual,
    }));
  });

  return {
    people,
    duplicates,
    missing: unresolved,
    excluded,
    warnings,
    config: settings,
    summary: {
      rawRecords,
      derivedRecords,
      validRecords: people.reduce((count, person) => count + person.records.length, 0),
      uniquePeople: people.length,
      allCount: datasets.length ? people.filter((person) => person.occurrence === datasets.length).length : 0,
      onlyCount: people.filter((person) => person.occurrence === 1).length,
      missingCount: unresolved.length,
      duplicateGroups: duplicates.length,
      conflictCount: people.filter((person) => person.conflict).length,
      totalLists: datasets.length,
      excludedRecords: excluded.length,
      duplicateRecords: duplicates.reduce((count, group) => count + group.count, 0),
      manualCount: people.filter((person) => person.manual).length,
      byOccurrence: Object.fromEntries(
        Array.from({ length: datasets.length }, (_, index) => [
          index + 1,
          people.filter((person) => person.occurrence === index + 1).length,
        ]),
      ),
    },
  };
}

export function stats(result) {
  return { ...result.summary, byOccurrence: { ...result.summary.byOccurrence } };
}

/** Name suggestions remain pending until a caller submits an explicit approved override. */
export function findNameCandidates(datasets, result) {
  const recordsByName = new Map();
  const missingIds = new Set(result.missing.map((record) => record.recordId));
  const personIds = new Map(result.people.flatMap((person) => person.records.map((record) => [record.recordId, person.id])));
  for (const record of [
    ...result.people.flatMap((person) => person.records),
    ...result.missing,
  ]) {
    const name = record.mapped.name;
    if (!name) continue;
    if (!recordsByName.has(name)) recordsByName.set(name, []);
    recordsByName.get(name).push(record);
  }
  const candidates = [];
  for (const [name, records] of recordsByName) {
    const incomplete = records.filter((record) => missingIds.has(record.recordId));
    if (!incomplete.length) continue;
    const knownIds = [...new Set(records.map((record) => record.mapped.studentId).filter(Boolean))];
    const candidatePools = knownIds.length
      ? knownIds.map((studentId) => records.filter((record) => !record.mapped.studentId || record.mapped.studentId === studentId))
      : [records];
    const perList = new Map();
    for (const record of records) perList.set(record.datasetId, (perList.get(record.datasetId) || 0) + 1);
    const ambiguous = knownIds.length > 1 || [...perList.values()].some((count) => count > 1);
    for (const pool of candidatePools) {
      const listIds = [...new Set(pool.map((record) => record.datasetId))];
      if (listIds.length < 2) continue;
      if (!pool.some((record) => incomplete.some((item) => item.recordId === record.recordId))) continue;
      const distinctPeople = new Set(pool.map((record) => personIds.get(record.recordId)).filter(Boolean));
      const poolAmbiguous = ambiguous || distinctPeople.size > 1
        || findConflicts(pool, result.config.matchFields).length > 0;
      candidates.push({
        id: `name:${name}:${pool.find((record) => record.mapped.studentId)?.mapped.studentId || 'missing'}`,
        name,
        studentId: pool.find((record) => record.mapped.studentId)?.mapped.studentId || '',
        status: poolAmbiguous ? 'ambiguous' : 'unique',
        ambiguous: poolAmbiguous,
        manual: true,
        recordIds: pool.map((record) => record.recordId),
        records: pool,
        listIds,
        listNames: listIds.map((id) => datasets.find((dataset) => dataset.id === id)?.name || id),
      });
    }
  }
  return candidates;
}

export function demoDatasets() {
  const first = {
    id: 'list-a',
    name: '\u540d\u5355\u4e00',
    columns: [
      { key: 'sid', label: '\u5b66\u53f7' },
      { key: 'student', label: '\u59d3\u540d' },
      { key: 'group', label: '\u73ed\u7ea7' },
      { key: 'tel', label: '\u624b\u673a\u53f7' },
    ],
    mapping: { studentId: 'sid', name: 'student', className: 'group', phone: 'tel' },
    rows: [
      ['2024001', '\u738b\u7f8e', '\u4e00\u73ed', '13800000001'],
      ['2024002', '\u9648\u6668', '\u4e00\u73ed', '13800000002'],
      ['2024003', '\u674e\u7136', '\u4e8c\u73ed', '13800000003'],
      ['00123', '\u9ec4\u6770', '\u4e8c\u73ed', '13800000123'],
      [' 00123 ', '\u9ec4\u6770', '\u4e8c\u73ed', '13800000123'],
      ['2024006', '\u5218\u96e8', '\u4e09\u73ed', '13800000006'],
      ['', '\u5f20\u5b81', '\u4e09\u73ed', ''],
    ].map((values, index) => ({ id: `a-${index + 1}`, values: Object.fromEntries(['sid', 'student', 'group', 'tel'].map((key, i) => [key, values[i]])) })),
  };
  const second = {
    id: 'list-b',
    name: '\u540d\u5355\u4e8c',
    columns: [
      { key: 'number', label: '\u5b66\u751f\u7f16\u53f7' },
      { key: 'fullName', label: '\u5b66\u751f\u59d3\u540d' },
      { key: 'class', label: '\u6240\u5728\u73ed\u7ea7' },
      { key: 'mobile', label: '\u8054\u7cfb\u7535\u8bdd' },
    ],
    mapping: { studentId: 'number', name: 'fullName', className: 'class', phone: 'mobile' },
    rows: [
      ['2024001', '\u738b\u7f8e', '\u4e00\u73ed', '13800000001'],
      ['2024003', '\u674e\u7136', '\u4e8c\u73ed', '13800000003'],
      ['2024004', '\u8d75\u5b89', '\u4e09\u73ed', '13800000004'],
      ['2024005', '\u5468\u5b87', '\u4e09\u73ed', '13800000005'],
      ['00123', '\u9ec4\u6770', '\u4e09\u73ed', '13800000123'],
      ['123', '\u90d1\u6708', '\u4e00\u73ed', '13800000124'],
      ['', '\u5218\u96e8', '\u4e09\u73ed', '13800000006'],
      ['2024008', '\u5f20\u5b81', '\u4e09\u73ed', '13800000008'],
    ].map((values, index) => ({ id: `b-${index + 1}`, values: Object.fromEntries(['number', 'fullName', 'class', 'mobile'].map((key, i) => [key, values[i]])) })),
  };
  const third = {
    id: 'list-c',
    name: '\u540d\u5355\u4e09',
    columns: [
      { key: 'studentNo', label: '\u5b66\u53f7' },
      { key: 'name', label: '\u59d3\u540d' },
      { key: 'className', label: '\u73ed\u7ea7' },
      { key: 'phone', label: '\u624b\u673a' },
    ],
    mapping: { studentId: 'studentNo', name: 'name', className: 'className', phone: 'phone' },
    rows: [
      ['2024001', '\u738b\u7f8e', '\u4e00\u73ed', '13800000001'],
      ['2024004', '\u8d75\u5b89', '\u4e09\u73ed', '13800000004'],
      ['00123', '\u9ec4\u6770', '\u4e8c\u73ed', '13800000123'],
      ['2024006', '\u5218\u96e8', '\u4e09\u73ed', '13800000006'],
      ['2024007', '\u65b9\u60a6', '\u4e8c\u73ed', '13800000007'],
      ['2024009', '\u5f20\u5b81', '\u4e09\u73ed', '13800000009'],
    ].map((values, index) => ({ id: `c-${index + 1}`, values: Object.fromEntries(['studentNo', 'name', 'className', 'phone'].map((key, i) => [key, values[i]])) })),
  };
  return [first, second, third];
}
