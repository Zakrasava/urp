const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js');
const vm=require('node:vm');
const fs=require('node:fs');
const sandbox={window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../questions.js'),'utf8'),sandbox);
const data=sandbox.window.HR_SURVEY_DATA,list=C.questions(data);
function valid(){const s=C.normalize({},list);s.respondent={team:'УРП',role:'Кадровик',contact:''};list.forEach(q=>s.answers[q.id]={status:'pending',text:'',link:''});return s;}
test('all 23 unique questions in five groups retain source references and examples',()=>{
 assert.equal(data.sections.length,5);assert.equal(list.length,23);assert.equal(new Set(list.map(q=>q.id)).size,23);
 for(const q of list){assert.ok(q.example.length>60);assert.ok(q.requested);assert.ok(q.reference);assert.ok(q.documents.length);for(const id of q.documents){assert.ok(data.documents[id]);assert.ok(C.fileUrl(data.documents[id].path).startsWith('file://isreg.ru/'));}}
 assert.ok(C.key.startsWith('hr-portal-survey:'));assert.ok(!C.key.includes('survey-draft-v3'));
});
test('known decisions require detail, uncertainty and delegation do not invent answers',()=>{
 const s=valid();assert.deepEqual(C.validate(s,list),{});
 s.answers.K01.status='ready';assert.ok(C.validate(s,list)['K01-text']);assert.equal(C.answerComplete(s.answers.K01),false);
 s.answers.K01.text='Согласованный порядок';assert.equal(C.answerComplete(s.answers.K01),true);
 s.answers.K02.status='delegate';assert.equal(C.answerComplete(s.answers.K02),true);
 s.answers.K03.status='bogus';assert.ok(C.validate(s,list)['K03-status']);
 s.respondent.team=' ';assert.ok(C.validate(s,list).team);
});
test('only document URLs and network paths accepted',()=>{
 for(const s of ['https://intranet.example/folder?a=1','http://intranet/doc','\\\\server\\share\\Файл.pdf',''])assert.ok(C.validLink(s),s);
 for(const s of ['javascript:alert(1)','file:///C:/secrets','https://user:pass@example.com','https://site.test/\nmalicious','x'.repeat(1501)])assert.equal(C.validLink(s),false,s);
 assert.match(C.fileUrl('\\\\server\\share\\Файл №1.pdf'),/^file:\/\/server\/share\/%/);
});
test('malformed and foreign draft data does not break restoration',()=>{
 const s=C.draft('{malformed',list);assert.equal(s.answers.K01.status,'');
 assert.equal(C.draft('null',list).respondent.team,'');
 assert.equal(C.draft('{"answers":{"K01":{"status":"__proto__"}}}',list).answers.K01.status,'');
 assert.equal(C.normalize({respondent:{team:'x'.repeat(999)}},list).respondent.team.length,180);
 assert.equal(C.normalize({submissionId:'-'.repeat(36)},list).submissionId,'');
});
test('storage denied and quota keep in-memory data; quota still permits restoration',()=>{
 const denied=C.storage(()=>{throw Error('denied');});denied.write('draft');assert.equal(denied.read(),'draft');assert.equal(denied.available(),false);
 let old='saved';const quota=C.storage(()=>({getItem:()=>old,setItem:()=>{throw Error('quota');},removeItem:()=>{old=null;}}));assert.equal(quota.read(),'saved');assert.equal(quota.write('new'),false);quota.clear();assert.equal(old,null);
});
test('success requires explicit confirmation for the same receiver and submission ID',()=>{
 const id=C.uuid(require('node:crypto').webcrypto);assert.match(id,/^[a-f0-9-]{36}$/);
 assert.equal(C.confirmed({ok:true,service:'hr-portal-survey',submissionId:id},id),true);
 for(const r of [{ok:true},{ok:true,service:'survey',submissionId:id},{ok:true,service:'hr-portal-survey',submissionId:'other'},null])assert.equal(C.confirmed(r,id),false);
 const s=valid();s.submissionId=id;assert.equal(C.payload(s,'test').submissionId,id);
});
test('retry and edit-undo keep the same ID; a changed revision gets a new ID after restoration',()=>{
 const cryptoApi=require('node:crypto').webcrypto;
 const first=C.prepareAttempt(valid(),cryptoApi);
 assert.equal(C.prepareAttempt(first,cryptoApi).submissionId,first.submissionId);
 const restored=C.draft(JSON.stringify(first),list);
 restored.answers.K01.text='Temporary edit';restored.answers.K01.text='';
 assert.equal(C.prepareAttempt(restored,cryptoApi).submissionId,first.submissionId);
 restored.answers.K01.text='New decision';
 assert.notEqual(C.prepareAttempt(restored,cryptoApi).submissionId,first.submissionId);
 assert.equal(C.payload(first,'old').submissionId,C.payload(first,'new').submissionId);
});
test('permanent receiver errors give a recovery path and text NULs are rejected',()=>{
 assert.match(C.failureMessage({error:'BAD_REQUEST'}),/Скопируйте/);
 assert.match(C.failureMessage({error:'SCHEMA_MISMATCH'}),/повтор сейчас не поможет/);
 assert.match(C.failureMessage({error:'BUSY'}),/Повторите/);
 for(const code of ['SAVE_FAILED','ID_CONFLICT'])assert.match(C.failureMessage({error:code}),/Скопируйте|скопируйте/);
 for(const response of [null,undefined,{error:'unknown'},{error:'__proto__'}])assert.match(C.failureMessage(response),/не подтвердил/);
 const s=valid();s.answers.K01.text='bad\x00text';assert.ok(C.validate(s,list)['K01-text']);
 assert.equal(C.normalize({answers:{K01:{status:['ready']}}},list).answers.K01.status,'');
});
