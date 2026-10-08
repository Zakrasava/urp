const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const C=require('../core.js');
function setup(){
 const rows=[],logs=[];let locked=false,maxColumns=26,maxRows=1;
 const sheet={getLastRow:()=>rows.length,setFrozenRows:()=>{},getMaxColumns:()=>maxColumns,insertColumnsAfter:(after,n)=>{assert.equal(after,maxColumns);maxColumns+=n;},getMaxRows:()=>maxRows,insertRowsAfter:(after,n)=>{assert.equal(after,maxRows);maxRows+=n;},getRange:(r,c,n=1,m=1)=>{
  assert.ok(c+m-1<=maxColumns,'column expansion before write');assert.ok(r+n-1<=maxRows,'row expansion before write');return({
  setValues(v){v.forEach((row,i)=>{rows[r+i-1]??=[];row.forEach((cell,j)=>rows[r+i-1][c+j-1]=cell);});return this;},setNumberFormat(){return this;},setFontWeight(){return this;},setBackground(){return this;},
  getValues:()=>Array.from({length:n},(_,i)=>rows[r+i-1].slice(c-1,c+m-1)),getValue:()=>rows[r-1][c-1],
  createTextFinder(id){return{matchEntireCell(){return this;},findNext(){const idx=rows.findIndex((row,i)=>i>0&&row[0]===id);return idx<0?null:{getRow:()=>idx+1};}};}
 });}};
 const sandbox={console:{warn(value){logs.push(value);}},ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType:()=>JSON.parse(s)})},Utilities:{DigestAlgorithm:{SHA_256:1},Charset:{UTF_8:1},computeDigest:(_,text)=>[...crypto.createHash('sha256').update(text).digest()]},LockService:{getScriptLock:()=>({tryLock:()=>{locked=true;return true;},hasLock:()=>locked,releaseLock:()=>{locked=false;}})},SpreadsheetApp:{openById:id=>{assert.equal(id,'1PRnjDo_LXdpiYtTd0OvUgVUMe2aDYyPb_MW5mr_gVyc');return{getSheetByName:()=>rows.length?sheet:null,insertSheet:()=>sheet};},flush:()=>{}}};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/Code.gs'),'utf8'),sandbox);
 return{ctx:sandbox,rows,logs,post:data=>sandbox.doPost({postData:{contents:JSON.stringify(data)}}),locked:()=>locked};
}
function payload(){return{service:'hr-portal-survey',schema:1,version:'test',submissionId:'01234567-1234-4567-8901-012345678901',respondent:{team:'Тест',role:'Проверка',contact:''},answers:Object.fromEntries(Array.from({length:23},(_,i)=>['K'+String(i+1).padStart(2,'0'),{status:'pending',text:'',link:''}])),comments:'',website:''};}
test('receiver saves a fixed schema, retry acknowledges same row, conflict never overwrites',()=>{
 const s=setup(),p=payload();const first=s.post(p);assert.equal(first.ok,true);assert.equal(first.duplicate,false);assert.equal(s.rows.length,2);assert.equal(s.rows[1].length,s.ctx.HR_HEADERS.length);assert.equal(s.locked(),false);
 assert.equal(s.post(p).duplicate,true);assert.equal(s.rows.length,2);p.answers.K01.text='Other content';assert.equal(s.post(p).error,'ID_CONFLICT');assert.equal(s.rows.length,2);assert.equal(s.rows[1][7],'');
});
test('invalid payloads, oversized values, missing questions, bad URLs, status prototypes and honeypot rejected before writing',()=>{
 for(const mutate of [p=>p.respondent.team='',p=>p.answers.K01.status='ready',p=>p.answers.K01.status=['ready'],p=>p.answers.K01.status=1,p=>delete p.answers.K03,p=>p.answers.K01.status='__proto__',p=>p.answers.K01.text='x'.repeat(5001),p=>p.answers.K01.link='javascript:alert(1)',p=>p.website='spam',p=>p.submissionId='bad',p=>p.answers.K24={}]){
  const s=setup(),p=payload();mutate(p);assert.equal(s.post(p).error,'BAD_REQUEST');assert.equal(s.rows.length,0);
 }
 const s=setup();assert.equal(s.ctx.doPost({postData:{contents:'x'.repeat(350001)}}).error,'BAD_REQUEST');
});
test('a deployment version change does not conflict with unchanged saved answers',()=>{
 const s=setup(),p=payload();assert.equal(s.post(p).ok,true);p.version='new-version';assert.equal(s.post(p).duplicate,true);assert.equal(s.rows.length,2);
});
test('client and receiver use the same HTTP/UNC rules, including IPv6 and control characters',()=>{
 for(const link of ['https://intranet/doc','https://[::1]/doc','\\\\server\\share\\Файл.pdf','https://user:pass@example.com','javascript:alert(1)','https://example.com/\ninvalid','https://example.com/a b','\\\\server\\share\\bad\x00']){
  const s=setup(),p=payload();p.answers.K01.link=link;assert.equal(s.post(p).ok,C.validLink(link),link);
 }
});
test('legitimate maximum quoted text is accepted within the shared serialized-body bound',()=>{
 const s=setup(),p=payload();for(const id in p.answers)p.answers[id].text='"'.repeat(5000);
 assert.ok(JSON.stringify(p).length>160000);assert.ok(JSON.stringify(p).length<C.maxPayloadLength);assert.equal(s.post(p).ok,true);
});
test('formula injection escaped, including leading whitespace',()=>{
 const s=setup();for(const value of ['=IMPORTXML("x")','+formula','-formula','@formula',' \t=cmd'])assert.equal(s.ctx.hrSafeText_(value),"'"+value);
 const p=payload();p.respondent.team='=1+1';p.answers.K01.text='@danger';assert.equal(s.post(p).ok,true);assert.equal(s.rows[1][3],"'=1+1");assert.equal(s.rows[1][7],"'@danger");
});
test('health response exposes no answers or table metadata',()=>{
 const s=setup();s.post(payload());assert.deepEqual(Object.keys(s.ctx.doGet()).sort(),['ok','service','version']);
});
test('schema drift, contention and write failures do not claim success',()=>{
 const s=setup();s.post(payload());s.rows[0][0]='Changed';const p=payload();p.submissionId='11234567-1234-4567-8901-012345678901';assert.equal(s.post(p).error,'SCHEMA_MISMATCH');assert.equal(s.locked(),false);
 const busy=setup();busy.ctx.LockService.getScriptLock=()=>({tryLock:()=>false,hasLock:()=>false});assert.equal(busy.post(payload()).error,'BUSY');
 const fail=setup();fail.ctx.SpreadsheetApp.openById=()=>{throw Error('private info');};const r=fail.post(payload());assert.equal(r.error,'SAVE_FAILED');assert.ok(!JSON.stringify(r).includes('private info'));assert.equal(fail.locked(),false);assert.deepEqual(fail.logs,['hr-portal-survey:SAVE_FAILED']);assert.deepEqual(busy.logs,['hr-portal-survey:BUSY']);assert.deepEqual(s.logs,['hr-portal-survey:SCHEMA_MISMATCH']);
});
