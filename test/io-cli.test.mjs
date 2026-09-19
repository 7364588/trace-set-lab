import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTraceSet,parseRun } from '../dist/index.js';
const cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
const data=(extra={})=>({schema_version:1,case_id:'case',repeat_id:'1',status:'ok',spans_complete:true,spans:[],...extra});
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'trace-set-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));await writeFile(path.join(dir,'base.jsonl'),JSON.stringify(data())+'\n');await writeFile(path.join(dir,'next.jsonl'),JSON.stringify(data())+'\n');return dir;}
function call(dir,args=[]){return spawnSync(process.execPath,[cli,'compare','--baseline',path.join(dir,'base.jsonl'),'--candidate',path.join(dir,'next.jsonl'),...args],{encoding:'utf8',timeout:15000});}
test('CLI emits JSON, HTML, and JUnit with matching success',async t=>{
  const dir=await fixture(t);const result=call(dir,['--json',path.join(dir,'report.json'),'--html',path.join(dir,'report.html'),'--junit',path.join(dir,'report.xml')]);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(await readFile(path.join(dir,'report.json'),'utf8')).exit_code,0);assert.ok((await readFile(path.join(dir,'report.html'),'utf8')).includes('Case matrix'));assert.ok((await readFile(path.join(dir,'report.xml'),'utf8')).includes('tests="1"'));
});
test('CLI refuses existing output, preserving its contents',async t=>{
  const dir=await fixture(t);const original=await readFile(path.join(dir,'base.jsonl'),'utf8');assert.equal(call(dir,['--json',path.join(dir,'base.jsonl')]).status,2);assert.equal(await readFile(path.join(dir,'base.jsonl'),'utf8'),original);
});
test('CLI returns one for failure and two for missing pair',async t=>{
  const dir=await fixture(t);await writeFile(path.join(dir,'next.jsonl'),JSON.stringify(data({status:'error'})));assert.equal(call(dir).status,1);await writeFile(path.join(dir,'next.jsonl'),JSON.stringify(data({repeat_id:'2'})));assert.equal(call(dir).status,2);
});
test('CLI rules output is reusable',async t=>{
  const dir=await fixture(t), out=path.join(dir,'rules.json');assert.equal(spawnSync(process.execPath,[cli,'rules','--out',out]).status,0);assert.equal(call(dir,['--rules',out]).status,0);
});
test('malformed CLI input errors contain no raw record or path',async t=>{
  const dir=await fixture(t);await writeFile(path.join(dir,'next.jsonl'),'synthetic-secret!');const result=call(dir);assert.equal(result.status,2);assert.ok(!result.stderr.includes('synthetic-secret!'));assert.ok(!result.stderr.includes(dir));
});
test('evidence is opt-in and reads only explicit listed files',async t=>{
  const dir=await fixture(t);await mkdir(path.join(dir,'case'));await writeFile(path.join(dir,'case','listed.txt'),'selected');await writeFile(path.join(dir,'case','unlisted.txt'),'unselected');await writeFile(path.join(dir,'next.jsonl'),JSON.stringify(data({evidence:{directory:'case',files:[{path:'listed.txt'}]}})));
  assert.equal((await loadTraceSet(path.join(dir,'next.jsonl')))[0].attachments,undefined);const loaded=await loadTraceSet(path.join(dir,'next.jsonl'),{evidence:true});assert.deepEqual(loaded[0].attachments.map(a=>a.text),['selected']);
});
test('evidence rejects traversal, drive, UNC, backslashes, and encoding tricks',()=>{
  for(const directory of ['../other','/outside','C:/outside','C:relative','\\\\server\\share','case\\..\\other','%2e%2e/other','.','a//b'])assert.throws(()=>parseRun(data({evidence:{directory,files:[]}})));
  assert.throws(()=>parseRun(data({evidence:{directory:'case',files:[{path:'../secret.txt'}]}})));
});
test('cross-case overlapping evidence directories rejected',async t=>{
  const dir=await fixture(t);await mkdir(path.join(dir,'evidence','nested'),{recursive:true});const runs=[data({evidence:{directory:'evidence',files:[]}}),data({case_id:'other',evidence:{directory:'evidence/nested',files:[]}})];await writeFile(path.join(dir,'next.jsonl'),runs.map(JSON.stringify).join('\n'));await assert.rejects(loadTraceSet(path.join(dir,'next.jsonl'),{evidence:true}),/overlap/);
});
test('evidence size and non-text boundaries enforced',async t=>{
  const dir=await fixture(t);await mkdir(path.join(dir,'case'));await writeFile(path.join(dir,'case','large.txt'),'x'.repeat(65537));await writeFile(path.join(dir,'next.jsonl'),JSON.stringify(data({evidence:{directory:'case',files:[{path:'large.txt'}]}})));await assert.rejects(loadTraceSet(path.join(dir,'next.jsonl'),{evidence:true}));
});
test('symlink evidence escape rejected where supported',async t=>{
  const dir=await fixture(t);await mkdir(path.join(dir,'outside'));await writeFile(path.join(dir,'outside','secret.txt'),'synthetic');try{await symlink(path.join(dir,'outside'),path.join(dir,'case'),process.platform==='win32'?'junction':'dir');}catch{t.skip('Host cannot create links');return;}
  await writeFile(path.join(dir,'next.jsonl'),JSON.stringify(data({evidence:{directory:'case',files:[{path:'secret.txt'}]}})));await assert.rejects(loadTraceSet(path.join(dir,'next.jsonl'),{evidence:true}),/symlink/);
});
test('OTLP CLI imports explicit mapped synthetic export into comparable JSONL',async t=>{
  const dir=await fixture(t),out=path.join(dir,'imported.jsonl');
  const payload=fileURLToPath(new URL('../examples/otlp-export.json',import.meta.url));
  const mapping=fileURLToPath(new URL('../examples/otlp-mapping.json',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'import-otlp',payload,'--mapping',mapping,'--out',out],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const loaded=await loadTraceSet(out);assert.ok(loaded.length>0);assert.ok(loaded[0].case_id);assert.ok(loaded[0].repeat_id);
  assert.equal(spawnSync(process.execPath,[cli,'import-otlp',payload,'--mapping',mapping,'--out',out],{encoding:'utf8'}).status,2);
});
