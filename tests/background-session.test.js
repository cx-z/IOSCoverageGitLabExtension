"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const urls = require('../src/content/gitlab-url.js');
const href = 'https://git.example.com/group/project/merge_requests/42/diffs';
const mr = urls.parseMergeRequestUrl(href);
function harness() {
  const tasks=[];
  const noop=async()=>{};
  const context=vm.createContext({URL, fetch:noop, importScripts(){},
    IOSCoverageGitLabUrl:urls,
    IOSCoverageOrigins:{DEFAULT_SERVER_ORIGIN:'http://127.0.0.1:8765'},
    IOSCoverageApiClient:{validateContentMessage:()=>true,
      resolveMergeRequest:()=>new Promise(resolve=>tasks.push(resolve)),
      loadPresentationFile:()=>new Promise(resolve=>tasks.push(resolve))},
    chrome:{storage:{local:{setAccessLevel:noop,get:async()=>({}),remove:noop}},
      scripting:{unregisterContentScripts:noop},
      runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
      action:{onClicked:{addListener(){}}},tabs:{onRemoved:{addListener(){}}}}});
  vm.runInContext(fs.readFileSync(require.resolve('../src/background/service-worker.js'),'utf8'),context);
  return {context,tasks,sender:{tab:{id:1},url:href}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function result(id) {return {canAnnotate:true,cycleId:'cycle',generation:1,presentationId:id,pageVersion:'123',
  mrUrl:href,files:[{fileId:'file'}]};}

test('P14 a late resolver cannot restore tab authorization from an older MR version',async()=>{
  const h=harness();
  const message={action:'RESOLVE_MR',mr,versionState:'latest'};
  const old=h.context.handleContentMessage(message,h.sender);
  await settle();
  const current=h.context.handleContentMessage(message,h.sender);
  await settle();
  h.tasks[1](result('new')); await current;
  h.tasks[0](result('old'));
  assert.equal((await old).ok,false);
  const denied=await h.context.handleContentMessage({action:'LOAD_REPORT_FILE',cycleId:'cycle',generation:1,
    fileId:'file',presentationId:'old'},h.sender);
  assert.equal(denied.error,'file_request_not_allowed');
});

test('P14 a late file response cannot cross a newer tab authorization session',async()=>{
  const h=harness(), message={action:'RESOLVE_MR',mr,versionState:'latest'};
  const first=h.context.handleContentMessage(message,h.sender); await settle();
  h.tasks[0](result('old')); await first;
  const file=h.context.handleContentMessage({action:'LOAD_REPORT_FILE',cycleId:'cycle',generation:1,
    fileId:'file',presentationId:'old'},h.sender); await settle();
  const next=h.context.handleContentMessage(message,h.sender); await settle();
  h.tasks[2](result('new')); await next;
  h.tasks[1]({generation:1});
  assert.equal((await file).error,'request_superseded');
});
