// Offline graph harness. No network clients, credentials or third-party packages.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const w = require('../Automated-Quotation-Follow-up-V2.json');
const nodes = Object.fromEntries(w.nodes.map(n=>[n.name,n]));
const edge = (n,p=0)=>w.connections[n].main[p][0].node;
const runCode = (name,json,ctx={},all=[]) => Function('$json','$','$input','$now',nodes[name].parameters.jsCode)(
  json,k=>({item:{json:ctx[k]},first:()=>({json:ctx[k]})}),{all:()=>all},ctx.now);
const evaluate = (value,json,ctx) => typeof value==='string' && value.startsWith('={{')
  ? Function('$json','$','return ('+value.slice(3,-2)+')')(json,k=>({first:()=>({json:ctx[k]})})) : value;
const headers = 'quote_id customer_name customer_email amount follow_up_date status draft_id alert_status error_message draft_guard alert_attempts wa_message_id'.split(' ');
const fixture = (id,extra={})=>Object.assign({quote_id:id,customer_name:'عميل '+id,customer_email:id+'@example.test',amount:'20',follow_up_date:'2024-02-29',status:'Pending'},extra);
function lab(rows,options={}) {
  const cfg={today:'2024-03-01',whatsappEnabled:true,graphVersion:'v0.0',ownerPhone:'000',phoneNumberId:'000',spreadsheetId:'fake',...options};
  const ctx={Configuration:cfg}, drafts=[],calls=[];
  function execute(hook=()=>undefined) {
    const values=[headers,...rows.map(r=>headers.map(k=>r[k]??''))];
    const checked=runCode('Validate rows',{values},ctx);
    const results=[];
    for (const item of checked) {
      let s=item.json;
      for(let step=0;step<25;step++){
        s=runCode('Dispatch',s,ctx).json;ctx.Dispatch=s;
        const port=evaluate(nodes['Next operation'].parameters.output,s,ctx);
        const op=edge('Next operation',port);
        if(op==='One quotation'){results.push(s);break;}
        const p=nodes[op].parameters;
        const payload=evaluate(p.jsonBody,s,ctx);
        const req={op,s,payload,url:evaluate(p.url,s,ctx),query:Object.fromEntries((p.queryParameters?.parameters||[]).map(x=>[x.name,evaluate(x.value,s,ctx)]))};
        calls.push(req);
        let reply=hook(req);
        if(reply===undefined){
          let body;
          switch(op){
            case 'Search drafts':
              body={drafts:drafts.filter(d=>req.query.q.includes(d.subject)).map(d=>({id:d.id}))};break;
            case 'Inspect candidate': {
              const d=drafts.find(d=>req.url.endsWith('/'+d.id));
              body={id:d.id,message:{id:'message-'+d.id,payload:{headers:[{name:'Subject',value:d.subject},{name:'To',value:d.to}]}}};break;
            }
            case 'Create draft': {
              const raw=Buffer.from(payload.message.raw,'base64url').toString();
              assert.ok(raw.includes('Subject: '+s.subject+'\r\n'));
              assert.ok(raw.startsWith('To: '+s.customer_email+'\r\n'));
              const id='draft-'+(drafts.length+1);drafts.push({id,subject:s.subject,to:s.customer_email});body={id};break;
            }
            case 'Persist checkpoint':
              for(const {range,values} of payload.data) {
                const [,letter,num]=range.match(/^Quotes!([F-L])(\d+)$/);
                rows[Number(num)-2][headers[letter.charCodeAt(0)-65]]=values[0][0];
              }
              body={totalUpdatedCells:payload.data.length};break;
            case 'Notify owner':
              assert.ok(payload.text.body.includes(s.quote_id));
              body={messages:[{id:'wamid.'+s.quote_id}]};break;
            default: throw Error(op);
          }
          reply={statusCode:200,body};
        }
        assert.equal(edge(op),'Apply result');
        s=runCode('Apply result',reply,ctx).json;
      }
    }
    assert.equal(results.length,checked.length,'graph must finish every input');
    return results;
  }
  return {execute,rows,drafts,calls,count:op=>calls.filter(c=>c.op===op).length};
}
const rejected=(code,statusCode=400)=>({statusCode,body:{error:{code}}});
test('safe defaults, graph closure and valid expression syntax',()=>{
  assert.equal(w.active,false);assert.equal(nodes['09 AM Amman'].disabled,true);
  assert.equal(w.settings.timezone,'Asia/Amman');assert.equal(nodes['09 AM Amman'].parameters.rule.interval[0].triggerAtHour,9);
  assert.throws(()=>runCode('Configuration',{}),/disabled/);
  const seen=new Set(),queue=['Manual start','09 AM Amman'];
  while(queue.length){const name=queue.pop();if(seen.has(name))continue;seen.add(name);assert.ok(nodes[name]);for(const e of (w.connections[name]?.main||[]).flat())queue.push(e.node);}
  assert.equal(seen.size,w.nodes.length);
  for(const n of w.nodes){assert.ok(!n.credentials);if(n.parameters.jsCode)Function(n.parameters.jsCode);}
  const walk=o=>{if(typeof o==='string'&&o.startsWith('={{'))Function('$json','$','return ('+o.slice(3,-2)+')');else if(o&&typeof o==='object')Object.values(o).forEach(walk);};walk(w);
});
test('required headers checked before work',()=>assert.throws(()=>runCode('Validate rows',{values:[['id']]}),/headers/));
test('three quotations preserve recipient, draft, row and WA ID across rerun',()=>{
 const l=lab(['a','b','c'].map(x=>fixture(x)));l.execute();l.execute();
 assert.equal(l.count('Create draft'),3);assert.equal(l.count('Notify owner'),3);
 l.rows.forEach((r,i)=>{assert.equal(r.wa_message_id,'wamid.'+r.quote_id);assert.equal(r.draft_id,'draft-'+(i+1));assert.equal(l.drafts[i].to,r.customer_email);});
});
test('sheet outage after successful Gmail create recovers real draft resource ID',()=>{
 const l=lab([fixture('a'),fixture('b')]);l.execute(({op,s})=>op==='Persist checkpoint'&&s.quote_id==='a'&&s.patch.draft_id?rejected(503,503):undefined);
 assert.equal(l.rows[0].draft_guard,'Reserved');assert.equal(l.rows[1].alert_status,'Accepted');l.execute();
 assert.equal(l.count('Create draft'),2);assert.equal(l.rows[0].draft_id,'draft-1');
});
test('negative lookup after an ambiguous create cannot create again',()=>{
 const l=lab([fixture('a')]);l.execute(({op})=>op==='Create draft'?{error:'timeout'}:undefined);l.execute();assert.equal(l.count('Create draft'),1);assert.equal(l.rows[0].draft_guard,'Reserved');
});
for(const [name,reply] of [['pagination',{statusCode:200,body:{nextPageToken:'page'}}],['multiple',{statusCode:200,body:{drafts:[{id:'a'},{id:'b'}]}}],['search outage',rejected(503,503)]])
 test(name+' prevents creation',()=>{const l=lab([fixture('a')]);l.execute(({op})=>op==='Search drafts'?reply:undefined);assert.equal(l.count('Create draft'),0);assert.ok(l.rows[0].error_message);});
test('legacy exact draft recovers, foreign recipient and similar subject held',()=>{
 for(const [subject,to,good] of [['Follow-up on Quotation QFUP-a','Client <a@example.test>',true],['Follow-up on Quotation QFUP-a','x@example.test',false],['Follow-up on Quotation QFUP-a1','a@example.test',false]]){
 const l=lab([fixture('a')]);l.drafts.push({id:'existing',subject,to});l.execute(({op})=>op==='Search drafts'?{statusCode:200,body:{drafts:[{id:'existing'}]}}:undefined);
 assert.equal(l.count('Create draft'),0);assert.equal(l.rows[0].draft_id,good?'existing':undefined);
 }});
test('invalid calendar date, duplicate IDs, missing ID, future and terminal rows isolated',()=>{
 const l=lab([fixture('a'),fixture('A'),fixture(''),fixture('x',{follow_up_date:'2024-02-30'}),fixture('f',{follow_up_date:'2024-03-02'}),fixture('t',{status:'Won'}),fixture('z')]);l.execute();
 assert.equal(l.count('Create draft'),1);l.rows.slice(0,4).forEach(r=>assert.ok(r.error_message));assert.equal(l.rows[4].error_message,undefined);
});
test('invalid credentials block retries until explicitly requeued',()=>{
 const l=lab([fixture('a')]);l.execute(({op})=>op==='Notify owner'?rejected(190):undefined);l.execute();assert.equal(l.rows[0].alert_status,'Auth Blocked');assert.equal(l.count('Notify owner'),1);l.rows[0].alert_status='Retry';l.execute();assert.equal(l.rows[0].alert_status,'Accepted');
});
test('rate limit retries on later runs and stops at three attempts',()=>{
 const l=lab([fixture('a')]);for(let i=0;i<5;i++)l.execute(({op})=>op==='Notify owner'?rejected(130429,429):undefined);
 assert.equal(l.count('Notify owner'),3);assert.equal(l.rows[0].alert_status,'Review');
});
test('WA response lost or final sheet write fails: no automatic resend',()=>{
 for(const failAt of ['Notify owner','Persist checkpoint']){
 const l=lab([fixture('a')]);l.execute(({op,s})=>op===failAt&&(op==='Notify owner'||s.patch.alert_status==='Accepted')?{error:'timeout'}:undefined);
 l.execute();assert.equal(l.count('Notify owner'),1);assert.ok(['Sending','Review'].includes(l.rows[0].alert_status));
 }});
test('failed reservation prevents Gmail POST; failed alert claim prevents WA POST',()=>{
 for(const [field,op] of [['draft_guard','Create draft'],['alert_status','Notify owner']]){
 const l=lab([fixture('a')]);l.execute(req=>req.op==='Persist checkpoint'&&(field==='draft_guard'?req.s.patch[field]==='Reserved':req.s.patch[field]==='Sending')?rejected(403,403):undefined);assert.equal(l.count(op),0);
 }});
test('disabled WhatsApp queues draft and preserves customer fields',()=>{
 const l=lab([fixture('a')],{whatsappEnabled:false});l.execute();assert.equal(l.rows[0].alert_status,'Queued');assert.equal(l.count('Notify owner'),0);assert.equal(l.rows[0].customer_name,'عميل a');
});
test('legacy Sent and ambiguous blank alert do not resend; explicit Retry recovers',()=>{
 const l=lab(['Sent','','Retry'].map((a,i)=>fixture('q'+i,{status:'Draft Created',draft_id:'d'+i,alert_status:a})));l.execute();assert.equal(l.count('Notify owner'),1);assert.equal(l.rows[2].alert_status,'Accepted');
});
test('summary exposes row-level failures after processing',()=>{
 assert.throws(()=>runCode('Run result',{}, {},[{json:{row:3,outcome:'failure',reason:'Sheet write unconfirmed'}}]),/row 3/);
});
test('approved template uses owner destination and three ordered fields',()=>{
 const l=lab([fixture('a')],{templateName:'quote_ready',templateLanguage:'en_US'});
 l.execute(({op,payload})=>{if(op==='Notify owner'){
   assert.equal(payload.to,'000');assert.equal(payload.type,'template');assert.equal(payload.template.name,'quote_ready');
   assert.deepEqual(payload.template.components[0].parameters.map(p=>p.text),['a','عميل a','20']);
   return {statusCode:200,body:{messages:[{id:'wamid.template'}]}};
 }});
 assert.equal(l.rows[0].wa_message_id,'wamid.template');
});
test('date boundary, malformed email and inconsistent draft state',()=>{
 const l=lab([fixture('today',{follow_up_date:'2024-03-01'}),fixture('invalid',{customer_email:'bad\r\nBcc: b@example.test'}),fixture('old',{status:'Draft Created'}),fixture('x',{draft_id:'unexpected'})]);
 l.execute();assert.equal(l.count('Create draft'),1);assert.equal(l.rows[0].draft_id,'draft-1');l.rows.slice(1).forEach(r=>assert.ok(r.error_message));
});
test('configuration derives the day in Amman across UTC midnight boundary',()=>{
 const js=nodes.Configuration.parameters.jsCode.replace('live: false','live: true').replace("spreadsheetId: ''","spreadsheetId: 'fixture_spreadsheet_id'");
 const now={setZone(zone){assert.equal(zone,'Asia/Amman');return {toISODate:()=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone}).format(new Date('2024-03-01T21:30:00Z'))};}};
 assert.equal(Function('$now',js)(now)[0].json.today,'2024-03-02');
});
