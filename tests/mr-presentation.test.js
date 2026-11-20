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
