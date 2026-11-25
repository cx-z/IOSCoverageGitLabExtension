"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../src/shared/contracts.js');
const api = require('../src/background/api-client.js');
const dom = require('../src/content/gitlab-dom-adapter.js');
const renderer = require('../src/content/coverage-renderer.js');
const { FakeDocument } = require('./helpers/fake-dom.js');
const cycle = '11111111-1111-4111-8111-111111111111';
const build = '22222222-2222-4222-8222-222222222222';
const fileId = 'f'.repeat(64);
const diff = {base_sha:'a'.repeat(40),start_sha:'b'.repeat(40),head_sha:'c'.repeat(40)};
const summary = {changed_new_side:2,measurable:0,covered:1,uncovered:1,not_measurable:0,unknown:0,changed_line_coverage_percent:null};
const mr = {origin:'https://git.example.com',host:'git.example.com',projectPath:'group/project',iid:'42',
  pathname:'/group/project/merge_requests/42/diffs',identity:'https://git.example.com/group/project/merge_requests/42'};
function fixture() {
  return {schema_version:2,status:'ready',can_annotate:true,should_poll:true,
    page_version:'123',presentation_id:'e'.repeat(64),
    mr:{host:mr.host,project_path:mr.projectPath,iid:mr.iid,canonical_url:mr.identity,diff:{...diff}},
    cycle:{id:cycle},analysis:{status:'succeeded',requested_generation:1,completed_generation:1},
    report:{generation:1,updated_at:'2026-01-01T00:00:00Z',current_build_id:build,summary:{...summary},
      build_diff:{...diff,head_sha:'d'.repeat(40)},summary_api:`/api/v1/cycles/${cycle}/report`},
    projection:{strict_match:false,summary:{...summary},files:[{file_id:fileId,repo_relative_path:'File.swift',...summary}]}};
}

test('P14/P17 schema 2 binds current MR and source evidence while schema 1 stays strict', async () => {
  const value = fixture();
  contracts.validatePresentationResolver(value);
  const requests = [];
  const fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return {ok:true,json:async()=>value}; };
  const result = await api.resolveMergeRequest(fetch,{serverOrigin:'http://127.0.0.1:8765'}, {mr,pageVersion:'123'});
  assert.equal(result.presentationId, value.presentation_id);
  assert.deepEqual(result.targetDiff,diff);
  assert.equal(result.strictMatch,false);
  assert.equal(result.summary.changed_line_coverage_percent,null);
  assert.equal(requests.length,1);
  assert.equal(requests[0].schema_version,2);
  assert.equal(requests[0].page_version,'123');
  await assert.rejects(()=>api.resolveMergeRequest(fetch,{serverOrigin:'http://127.0.0.1:8765'},{mr,pageVersion:'456'}));
  const legacy = {...value,schema_version:1};
  delete legacy.projection; delete legacy.presentation_id; delete legacy.page_version;
  assert.throws(()=>contracts.validateResolverResponse(legacy));
});

test('P15/P17 rejects mixed semantics, invalid totals and old servers', () => {
  for (const mutate of [v=>v.schema_version=1, v=>v.presentation_id=null,
    v=>v.projection.summary.changed_line_coverage_percent=50,
    v=>v.projection.files[0].uncovered=0]) {
    const value=fixture(); mutate(value); assert.throws(()=>contracts.validatePresentationResolver(value));
  }
});

test('P18 verifies the page-selected version and actual row three refs before annotation', () => {
  const doc=new FakeDocument();
  const menu=doc.createElement('div'); menu.className='mr-version-dropdown';
  const link=doc.createElement('a'); link.className='is-active'; link.textContent='latest version';
  link.setAttribute('href',`${mr.pathname}?diff_id=123`); menu.append(link); doc.append(menu);
  assert.equal(dom.readPageVersion(doc,mr.origin+mr.pathname),'123');
  assert.equal(dom.readPageVersion(doc,mr.origin+mr.pathname+'?diff_id=456'),null);
  const row=doc.createElement('tr'), cell=doc.createElement('td'), button=doc.createElement('button');
  row.append(cell,button); doc.append(row);
  const candidate={target:cell,path:'File.swift',newLineNumber:8};
  button.setAttribute('data-position',JSON.stringify({...diff,position_type:'text',new_path:'File.swift',new_line:8}));
  assert.equal(dom.lineMatchesDiff(candidate,diff),true);
  assert.equal(dom.lineMatchesDiff(candidate,{...diff,start_sha:'e'.repeat(40)}),false);
  assert.equal(dom.lineMatchesDiff({...candidate,newLineNumber:9},diff),false);
  button.setAttribute('data-position','invalid');
  assert.equal(dom.lineMatchesDiff(candidate,diff),false);
});

test('P16/P17 current MR red counts remain filterable without presenting a percentage', () => {
  const doc=new FakeDocument(), mount=doc.createElement('div'); doc.append(mount);
  const section=renderer.renderSummary(doc,mount,{status:'ready',canAnnotate:true,strictMatch:false,
    summary,uncoveredFileCount:1}, {onRefresh(){},onOpenSettings(){},onFilter(){}});
  assert.match(section.textContent,/当前 MR 已覆盖/);
  assert.doesNotMatch(section.textContent,/覆盖率/);
});

test('review: schema 2 rejects contradictory states before authorizing annotations', () => {
  for (const status of ['mr_not_open','mr_diff_refs_not_ready','cycle_not_found','report_not_available',
    'analysis_pending','analysis_failed','page_version_unverified','stale_diff']) {
    const value=fixture(); value.status=status;
    assert.throws(()=>contracts.validatePresentationResolver(value),status);
  }
  for (const status of ['queued','running','failed']) {
    const value=fixture(); value.analysis.status=status;
    assert.throws(()=>contracts.validatePresentationResolver(value));
    value.status=status==='failed'?'analysis_failed':'analysis_pending';
    assert.doesNotThrow(()=>contracts.validatePresentationResolver(value));
    value.should_poll=false;
    assert.throws(()=>contracts.validatePresentationResolver(value));
  }
  const missing=fixture(); missing.projection=null;
  assert.throws(()=>contracts.validatePresentationResolver(missing));
});

test('review: same-ref additional independent evidence may use category-only projection', () => {
  const value=fixture(); value.report.build_diff={...diff};
  assert.doesNotThrow(()=>contracts.validatePresentationResolver(value));
  value.projection.strict_match=true; value.report.build_diff.head_sha='d'.repeat(40);
  assert.throws(()=>contracts.validatePresentationResolver(value));
});

function mappedFixture(covered, uncovered, notMeasurable = 0, unknown = 0) {
  const value = fixture();
  const measurable = covered + uncovered;
  const counts = { covered, uncovered, not_measurable: notMeasurable, unknown,
    changed_new_side: measurable + notMeasurable + unknown, measurable,
    changed_line_coverage_percent: measurable ? covered / measurable * 100 : null };
  value.projection.summary = { ...counts };
  value.projection.files = [{ file_id: fileId, repo_relative_path: 'File.swift', ...counts }];
  return value;
}

test('mapped server ratios pass the actual API client for mismatched and matching refs', async () => {
  for (const matchingRefs of [false, true]) {
    for (const [covered, uncovered, percent] of [[12, 1, 12 / 13 * 100], [0, 13, 0], [13, 0, 100], [0, 0, null]]) {
      const value = mappedFixture(covered, uncovered, 3, 2);
      if (matchingRefs) value.report.build_diff = { ...diff };
      assert.doesNotThrow(() => contracts.validatePresentationResolver(value));
      const expectedCounts = { covered, uncovered, not_measurable: 3, unknown: 2 };
      const lines = [];
      for (const [state, count] of Object.entries(expectedCounts)) {
        for (let index = 0; index < count; index += 1) {
          lines.push({ new_line_number: lines.length + 1, state,
            coverage_source: state === 'covered' ? 'historical_inheritance' : 'none',
            regions: ['covered', 'uncovered'].includes(state) ? [{ covered: state === 'covered' }] : [] });
        }
      }
      const detail = { schema_version: 2, presentation_id: value.presentation_id, page_version: '123',
        cycle_id: cycle, generation: 1, file: value.projection.files[0], lines };
      const fetch = async (_url, options) => ({ ok: true, status: 200,
        json: async () => JSON.parse(options.body).file_id ? detail : value });
      const settings = { serverOrigin: 'http://127.0.0.1:8765' };
      const result = await api.resolveMergeRequest(fetch, settings, { mr, pageVersion: '123' });
      assert.equal(result.summary.changed_line_coverage_percent, percent);
      assert.equal(result.summary.measurable, covered + uncovered);
      assert.equal(result.strictMatch, false);
      assert.equal(result.canAnnotate, true);
      const loaded = await api.loadPresentationFile(fetch, settings, result, fileId);
      assert.deepEqual(loaded, detail);
      const actualCounts = Object.fromEntries(Object.keys(expectedCounts).map(state =>
        [state, loaded.lines.filter(line => line.state === state).length]));
      assert.deepEqual(actualCounts, expectedCounts);
      assert.equal(loaded.lines.length, covered + uncovered + 5);
      assert.deepEqual(loaded.lines.map(line => line.new_line_number),
        Array.from({ length: covered + uncovered + 5 }, (_, index) => index + 1));
      assert.equal(loaded.file.changed_new_side, loaded.lines.length);
      assert.equal(result.summary.changed_new_side, loaded.lines.length);
      for (const [state, count] of Object.entries(actualCounts)) {
        assert.equal(loaded.file[state], count);
        assert.equal(result.summary[state], count);
      }
      assert.equal(loaded.file.measurable, actualCounts.covered + actualCounts.uncovered);
    }
  }
});

test('mapped percentages require the matching denominator and server classification totals', () => {
  for (const mutate of [
    v => v.projection.summary.measurable += 1,
    v => v.projection.summary.changed_line_coverage_percent = 100,
    v => v.projection.summary.changed_line_coverage_percent = null,
    v => v.projection.summary.changed_line_coverage_percent = NaN,
    v => v.projection.summary.changed_line_coverage_percent = Infinity,
    v => v.projection.files[0].covered -= 1,
  ]) {
    const value = mappedFixture(12, 1, 3, 2);
    mutate(value);
    assert.throws(() => contracts.validatePresentationResolver(value));
  }
});

test('mapped ratio renders server percentages including zero without showing the formal Build ratio', async () => {
  for (const [covered, uncovered, text] of [[12, 1, '92.3%'], [0, 13, '0.0%'], [13, 0, '100.0%']]) {
    const value = mappedFixture(covered, uncovered);
    value.report.summary = { changed_new_side: 100, measurable: 100, covered: 17, uncovered: 83,
      not_measurable: 0, unknown: 0, changed_line_coverage_percent: 17 };
    assert.equal(value.report.summary.covered + value.report.summary.uncovered, value.report.summary.measurable);
    assert.equal(value.report.summary.measurable, value.report.summary.changed_new_side);
    assert.equal(value.report.summary.covered / value.report.summary.measurable * 100,
      value.report.summary.changed_line_coverage_percent);
    const result = await api.resolveMergeRequest(async () => ({ok: true, json: async () => value}),
      {serverOrigin: 'http://127.0.0.1:8765'}, {mr, pageVersion: '123'});
    const doc = new FakeDocument(), mount = doc.createElement('div'); doc.append(mount);
    const section = renderer.renderSummary(doc, mount, result, {onRefresh(){}, onOpenSettings(){}, onFilter(){}});
    assert.match(section.textContent, /当前 MR 覆盖率/);
    assert.ok(section.textContent.includes(text));
    assert.doesNotMatch(section.textContent, /17.0%/);
    assert.match(section.textContent, /使用历史构建覆盖证据/);
  }
  const value = mappedFixture(0, 0, 3, 2);
  const doc = new FakeDocument(), mount = doc.createElement('div'); doc.append(mount);
  const section = renderer.renderSummary(doc, mount, {status: 'ready', strictMatch: false,
    summary: value.projection.summary}, {onRefresh(){}, onOpenSettings(){}, onFilter(){}});
  assert.doesNotMatch(section.textContent, /覆盖率/);
});
