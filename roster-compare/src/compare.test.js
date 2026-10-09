import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDatasets, demoDatasets, findNameCandidates, stats } from './compare.js';

const config = { matchFields: ['studentId'], conflictFields: ['name', 'className'] };

function dataset(id, rows) {
  return {
    id,
    name: id,
    columns: ['sid', 'name', 'class'].map((key) => ({ key, label: key })),
    mapping: { studentId: 'sid', name: 'name', className: 'class' },
    rows: rows.map((row, index) => ({ id: `${index + 1}`, values: { sid: row[0], name: row[1], class: row[2] || '' }, excluded: Boolean(row[3]) })),
  };
}

test('trims keys, preserves leading zeroes, retains duplicates and counts distinct lists', () => {
  const result = compareDatasets([
    dataset('a', [[' 00123 ', 'A'], ['00123', 'A'], ['123', 'B']]),
    dataset('b', [['00123', 'A']]),
    dataset('c', [['00123', 'A']]),
  ], config);
  assert.equal(result.summary.rawRecords, 5);
  assert.equal(result.summary.validRecords, 5);
  assert.equal(result.summary.uniquePeople, 2);
  assert.equal(result.summary.allCount, 1);
  assert.equal(result.summary.onlyCount, 1);
  const person = result.people.find((item) => item.studentId === '00123');
  assert.equal(person.records.length, 4);
  assert.equal(person.occurrence, 3);
  assert.equal(person.duplicate, true);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].count, 2);
  assert.equal(result.duplicates[0].occurrence, 3);
  assert.deepEqual(result.duplicates[0].listIds, ['a', 'b', 'c']);
  assert.deepEqual(result.duplicates[0].listNames, ['a', 'b', 'c']);
  assert.equal(result.duplicates[0].records.every((record) => record.datasetId === 'a'), true);
  assert.equal(person.records[0].values.sid, ' 00123 ');
});

test('composite keys are unambiguous and require every selected field', () => {
  const result = compareDatasets([
    dataset('a', [['1', 'a|b', 'c'], ['2', 'a', 'b|c'], ['3', 'a', '']]),
    dataset('b', [['4', ' a|b ', 'c']]),
  ], { matchFields: ['name', 'className'], conflictFields: [] });
  assert.equal(result.summary.uniquePeople, 2);
  assert.equal(result.summary.allCount, 1);
  assert.equal(result.missing.length, 1);
  assert.deepEqual(result.missing[0].missingFields, ['className']);
});

test('excluded rows do not count toward identity, duplicates or name suggestions', () => {
  const lists = [
    dataset('a', [['1', 'A'], ['1', 'A', '', true], ['', 'B', '', true]]),
    dataset('b', [['2', 'B']]),
  ];
  const result = compareDatasets(lists, config);
  assert.equal(result.excluded.length, 2);
  assert.equal(result.summary.rawRecords, 4);
  assert.equal(result.summary.validRecords, 2);
  assert.equal(result.summary.duplicateGroups, 0);
  assert.equal(result.summary.missingCount, 0);
  assert.deepEqual(findNameCandidates(lists, result), []);
});

test('conflicts check selected mapped fields and ignore empty values', () => {
  const lists = [dataset('a', [['1', ' A ', ''], ['2', 'B', 'one']]), dataset('b', [['1', 'A', 'two'], ['2', 'C', 'two']])];
  const result = compareDatasets(lists, config);
  assert.equal(result.people[0].conflict, false);
  assert.deepEqual(result.people[1].conflictFields, ['name', 'className']);
  const namesOnly = compareDatasets(lists, { ...config, conflictFields: ['name'] });
  assert.deepEqual(namesOnly.people[1].conflictFields, ['name']);
});

test('missing keys remain pending until name links are explicitly approved', () => {
  const lists = [dataset('a', [['0001', 'A'], ['0001', 'A']]), dataset('b', [['', ' A ']])];
  const before = compareDatasets(lists, config);
  const candidates = findNameCandidates(lists, before);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'ambiguous');
  assert.equal(before.summary.allCount, 0);
  assert.equal(before.missing.length, 1);
  const after = compareDatasets(lists, config, [{ recordIds: ['a:1', 'b:1'] }]);
  assert.equal(after.people.length, 1);
  assert.equal(after.people[0].records.length, 3);
  assert.equal(after.people[0].manual, true);
  assert.equal(after.people[0].occurrence, 2);
  assert.equal(after.summary.allCount, 1);
  assert.equal(after.summary.missingCount, 0);
  assert.equal(after.summary.validRecords, 3);
  assert.equal(after.people[0].records.find((record) => record.datasetId === 'b').values.sid, '');
});

test('same names with different known student IDs are never merged', () => {
  const lists = [dataset('a', [['1', 'A']]), dataset('b', [['2', 'A']]), dataset('c', [['', 'A']])];
  const before = compareDatasets(lists, config);
  const candidates = findNameCandidates(lists, before);
  assert.equal(candidates.length, 2);
  assert.equal(candidates.every((candidate) => candidate.ambiguous), true);
  assert.equal(candidates.every((candidate) => new Set(candidate.records.map((record) => record.mapped.studentId).filter(Boolean)).size === 1), true);
  const after = compareDatasets(lists, config, [{ recordIds: ['a:1', 'b:1', 'c:1'] }]);
  assert.equal(after.people.length, 2);
  assert.equal(after.missing.length, 1);
  assert.equal(after.warnings[0].type, 'conflictingOverride');
});

test('two missing student IDs can be confirmed, but multiple rows in one list are ambiguous', () => {
  const lists = [dataset('a', [['', 'A']]), dataset('b', [['', 'A'], ['', 'A']])];
  const before = compareDatasets(lists, config);
  const [candidate] = findNameCandidates(lists, before);
  assert.equal(candidate.status, 'ambiguous');
  assert.equal(before.people.length, 0);
  const after = compareDatasets(lists, config, [candidate]);
  assert.equal(after.people.length, 1);
  assert.equal(after.summary.allCount, 1);
  assert.equal(after.people[0].duplicate, true);
  assert.equal(after.people[0].records.length, 3);
  assert.equal(after.duplicates.length, 1);
  assert.equal(after.duplicates[0].count, 2);
});

test('empty names do not produce suggestions and invalid approvals are ignored', () => {
  const lists = [dataset('a', [['', '']]), dataset('b', [['1', '']])];
  const before = compareDatasets(lists, config);
  assert.deepEqual(findNameCandidates(lists, before), []);
  const after = compareDatasets(lists, config, [{ recordIds: ['a:1', 'unknown:1'] }]);
  assert.equal(after.summary.missingCount, 1);
  assert.equal(after.warnings[0].type, 'invalidOverride');
});

test('demo includes duplicate, conflict, missing and three-list intersection without mutating originals', () => {
  const lists = demoDatasets();
  const originals = structuredClone(lists);
  const result = compareDatasets(lists, config);
  assert.equal(result.summary.totalLists, 3);
  assert.equal(result.summary.allCount, 2);
  assert.equal(result.summary.duplicateGroups, 1);
  assert.equal(result.summary.conflictCount, 1);
  assert.equal(result.summary.missingCount, 2);
  assert.equal(result.people.some((person) => person.studentId === '00123'), true);
  assert.equal(result.people.some((person) => person.studentId === '123'), true);
  assert.deepEqual(lists, originals);
  assert.deepEqual(stats(result), result.summary);
});

test('empty input has zero totals and no all-list matches', () => {
  const result = compareDatasets([], config);
  assert.equal(result.summary.allCount, 0);
  assert.equal(result.summary.uniquePeople, 0);
  assert.equal(result.summary.rawRecords, 0);
  assert.deepEqual(result.people, []);
});

test('derived rows participate in comparison while original record totals stay unchanged', () => {
  const lists = [dataset('a', [['1,2', 'A,B', '', true]]), dataset('b', [['1', 'A'], ['2', 'B']])];
  lists[0].rows.push(
    { id: 'child-1', derivedFrom: '1', values: { sid: '1', name: 'A', class: '' } },
    { id: 'child-2', derivedFrom: '1', values: { sid: '2', name: 'B', class: '' } },
  );
  const result = compareDatasets(lists, config);
  assert.equal(result.summary.rawRecords, 3);
  assert.equal(result.summary.derivedRecords, 2);
  assert.equal(result.summary.validRecords, 4);
  assert.equal(result.summary.uniquePeople, 2);
  assert.equal(result.summary.allCount, 2);
  assert.equal(result.excluded.length, 1);
});

test('a missing class can be manually matched by name when both known student IDs agree', () => {
  const lists = [dataset('a', [['001', 'A', '']]), dataset('b', [['001', 'A', 'one']])];
  const compositeConfig = { matchFields: ['studentId', 'className'], conflictFields: ['name'] };
  const before = compareDatasets(lists, compositeConfig);
  const [candidate] = findNameCandidates(lists, before);
  assert.equal(before.summary.allCount, 0);
  assert.equal(before.summary.missingCount, 1);
  assert.equal(candidate.status, 'unique');
  assert.deepEqual(candidate.recordIds.toSorted(), ['a:1', 'b:1']);
  const after = compareDatasets(lists, compositeConfig, [candidate]);
  assert.equal(after.warnings.length, 0);
  assert.equal(after.summary.allCount, 1);
  assert.equal(after.summary.missingCount, 0);
  assert.equal(after.people[0].manual, true);
  assert.equal(after.people[0].records.find((record) => record.datasetId === 'a').values.class, '');
});

test('manual name matching rejects conflicts in any nonempty selected match field', () => {
  const lists = [dataset('a', [['', 'A', 'two']]), dataset('b', [['001', 'A', 'one']])];
  const compositeConfig = { matchFields: ['studentId', 'className'], conflictFields: ['name'] };
  const before = compareDatasets(lists, compositeConfig);
  const [candidate] = findNameCandidates(lists, before);
  assert.equal(candidate.ambiguous, true);
  const after = compareDatasets(lists, compositeConfig, [candidate]);
  assert.equal(after.warnings[0].type, 'conflictingOverride');
  assert.equal(after.summary.allCount, 0);
  assert.equal(after.summary.missingCount, 1);
});

test('two incomplete records with conflicting nonempty match fields cannot bypass the guard', () => {
  const lists = [dataset('a', [['', 'A', 'one']]), dataset('b', [['', 'A', 'two']])];
  const compositeConfig = { matchFields: ['studentId', 'className'], conflictFields: [] };
  const before = compareDatasets(lists, compositeConfig);
  const [candidate] = findNameCandidates(lists, before);
  assert.equal(candidate.ambiguous, true);
  const after = compareDatasets(lists, compositeConfig, [candidate]);
  assert.equal(after.people.length, 0);
  assert.equal(after.missing.length, 2);
  assert.equal(after.warnings[0].type, 'conflictingOverride');
});
