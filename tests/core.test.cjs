const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../core.js');
const vm=require('node:vm');
const fs=require('node:fs');
const sandbox={window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../questions.js'),'utf8'),sandbox);
const data=sandbox.window.HR_SURVEY_DATA,list=C.questions(data);
function valid(){const s=C.normalize({},list);s.respondent={team:'УРП',role:'Кадровик',contact:''};list.forEach(q=>s.answers[q.id]={status:'pending',text:'',link:''});return s;}
test('round 2: 18 unique questions R01-R18 in five sections with intro and accepted decisions',()=>{
 assert.equal(data.round,2);assert.equal(data.sections.length,5);assert.equal(list.length,18);
 assert.deepEqual(list.map(q=>q.id),Array.from({length:18},(_,i)=>'R'+String(i+1).padStart(2,'0')));
 assert.equal(data.intro.length,2);assert.equal(data.accepted.length,8);
 for(const s of data.sections){assert.ok(s.nav);assert.ok(s.title);assert.ok(s.questions.length);}
 for(const q of list){assert.equal(q.code,q.id);assert.ok(q.title);assert.ok(q.question.endsWith('?'),q.id);assert.ok(q.details.length,q.id);
  for(const d of q.details){assert.ok(d.label);assert.ok(d.text?d.text.length>10:d.items.length>=3,q.id);}
  assert.ok(!('documents' in q),q.id);}
 const all=JSON.stringify(data);for(const placeholder of ['[ПЗГД]','[кто]','[публикатор главной]'])assert.ok(all.includes(placeholder),placeholder);
 assert.ok(!/isreg|\\\\/.test(all));
 assert.equal(C.key,'hr-portal-survey:draft:v2');assert.ok(!C.key.includes('survey-draft-v3'));
});
test('a round 1 draft is not applied to round 2 questions',()=>{
 const old=C.draft(JSON.stringify({respondent:{team:'УРП',role:'x',contact:''},answers:{K01:{status:'ready',text:'Старый ответ',link:''}},comments:''}),list);
 assert.ok(!('K01' in old.answers));assert.deepEqual(Object.keys(old.answers),list.map(q=>q.id));
});
test('known decisions require detail, uncertainty and delegation do not invent answers',()=>{
 const s=valid();assert.deepEqual(C.validate(s,list),{});
 s.answers.R01.status='ready';assert.ok(C.validate(s,list)['R01-text']);assert.equal(C.answerComplete(s.answers.R01),false);
 s.answers.R01.text='Согласованный порядок';assert.equal(C.answerComplete(s.answers.R01),true);
 s.answers.R02.status='delegate';assert.equal(C.answerComplete(s.answers.R02),true);
 s.answers.R03.status='bogus';assert.ok(C.validate(s,list)['R03-status']);
 s.respondent.team=' ';assert.ok(C.validate(s,list).team);
});
test('only document URLs and network paths accepted',()=>{
 for(const s of ['https://intranet.example/folder?a=1','http://intranet/doc','\\\\server\\share\\Файл.pdf',''])assert.ok(C.validLink(s),s);
 for(const s of ['javascript:alert(1)','file:///C:/secrets','https://user:pass@example.com','https://site.test/\nmalicious','x'.repeat(1501)])assert.equal(C.validLink(s),false,s);
 assert.match(C.fileUrl('\\\\server\\share\\Файл №1.pdf'),/^file:\/\/server\/share\/%/);
});
test('malformed and foreign draft data does not break restoration',()=>{
 const s=C.draft('{malformed',list);assert.equal(s.answers.R01.status,'');
 assert.equal(C.draft('null',list).respondent.team,'');
 assert.equal(C.draft('{"answers":{"R01":{"status":"__proto__"}}}',list).answers.R01.status,'');
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
 restored.answers.R01.text='Temporary edit';restored.answers.R01.text='';
 assert.equal(C.prepareAttempt(restored,cryptoApi).submissionId,first.submissionId);
 restored.answers.R01.text='New decision';
 assert.notEqual(C.prepareAttempt(restored,cryptoApi).submissionId,first.submissionId);
 assert.equal(C.payload(first,'old').submissionId,C.payload(first,'new').submissionId);
});
test('permanent receiver errors give a recovery path and text NULs are rejected',()=>{
 assert.match(C.failureMessage({error:'BAD_REQUEST'}),/Скопируйте/);
 assert.match(C.failureMessage({error:'SCHEMA_MISMATCH'}),/повтор сейчас не поможет/);
 assert.match(C.failureMessage({error:'BUSY'}),/Повторите/);
 for(const code of ['SAVE_FAILED','ID_CONFLICT'])assert.match(C.failureMessage({error:code}),/Скопируйте|скопируйте/);
 for(const response of [null,undefined,{error:'unknown'},{error:'__proto__'}])assert.match(C.failureMessage(response),/не подтвердил/);
 const s=valid();s.answers.R01.text='bad\x00text';assert.ok(C.validate(s,list)['R01-text']);
 assert.equal(C.normalize({answers:{R01:{status:['ready']}}},list).answers.R01.status,'');
});
