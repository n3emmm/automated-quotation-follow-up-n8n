"""Execute the exported workflow with real n8n nodes and loopback-only HTTP fixtures.
Usage: python3 tests/engine.py
Requires Python 3.10+, a local n8n CLI (validated with 2.20.0), and free loopback ports.
N8N_BIN may point to an isolated n8n executable. Never opens an existing n8n database.
"""
import base64
from collections import Counter
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
from urllib.parse import parse_qs, urlsplit

EXPORT = Path(__file__).resolve().parents[1] / 'Automated-Quotation-Follow-up-V2.json'
HEAD = 'quote_id customer_name customer_email amount follow_up_date status draft_id alert_status error_message draft_guard alert_attempts wa_message_id'.split()
SUBJECT = 'Follow-up on Quotation QFUP-'

def quote(q, **fields):
    return dict(quote_id=q, customer_name='عميل '+q, customer_email=q+'@example.test',
                amount='42', follow_up_date='2024-02-29', status='Pending', **fields)

class Fixtures:
    def __init__(self):
        self.rows = []
        self.drafts = {}
        self.calls = Counter()
        self.wave = 0
        self.errors = []

    def handle(self, method, url, data):
        path = url.path
        if path.endswith('/values/Quotes!A1:L') and method == 'GET':
            self.calls['read', 'all'] += 1
            return 200, {'values': [HEAD] + [[r.get(k,'') for k in HEAD] for r in self.rows]}
        if path.endswith('/values:batchUpdate') and method == 'POST':
            changes = {}
            positions = set()
            for cell in data['data']:
                col, num = re.fullmatch(r'Quotes!([F-L])(\d+)',cell['range']).groups()
                positions.add(int(num)-2)
                changes[HEAD[ord(col)-65]] = cell['values'][0][0]
            assert len(positions)==1 and data['valueInputOption']=='RAW'
            row = self.rows[positions.pop()]
            q = row['quote_id']
            if self.wave==1 and ((q=='recover' and 'draft_id' in changes) or
                                (q=='lostack' and changes.get('alert_status')=='Accepted')):
                return 503, {'error':{'code':503}}
            row.update(changes)
            self.calls['write',q] += 1
            return 200, {'totalUpdatedCells':len(changes)}
        if path.endswith('/drafts') and method=='GET':
            query = parse_qs(url.query)
            q = re.fullmatch('subject:"'+SUBJECT+'([^"]+)"',query['q'][0]).group(1)
            assert query['maxResults']==['2']
            self.calls['search',q] += 1
            return 200, {'drafts':[{'id':d} for d,(sub,_) in self.drafts.items() if sub==SUBJECT+q]}
        if '/drafts/' in path and method=='GET':
            d = path.split('/')[-1]
            sub, to = self.drafts[d]
            self.calls['inspect',sub[len(SUBJECT):]] += 1
            return 200, {'id':d,'message':{'id':'msg-'+d,'payload':{'headers':[
                {'name':'Subject','value':sub},{'name':'To','value':to}]}}}
        if path.endswith('/drafts') and method=='POST':
            raw = data['message']['raw']
            msg = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw+'==='))
            sub = str(msg['Subject'])
            q = sub.removeprefix(SUBJECT)
            assert sub==SUBJECT+q and str(msg['To'])==q+'@example.test'
            assert 'عميل '+q in msg.get_content()
            self.calls['create',q] += 1
            d = f'draft-{q}-{self.calls["create",q]}'
            self.drafts[d] = sub,str(msg['To'])
            if self.wave==1 and q=='lostdraft': return None
            return 200, {'id':d,'message':{'id':'msg-'+d}}
        if path.endswith('/messages') and method=='POST':
            assert data['to']=='12345678900'
            q = data['text']['body'].split('Quote: ')[1].splitlines()[0]
            assert 'Customer: عميل '+q in data['text']['body']
            self.calls['notify',q] += 1
            if self.wave==1:
                if q=='expired': return 400, {'error':{'code':190}}
                if q=='limited': return 429, {'error':{'code':130429}}
                if q=='disconnect': return None
            return 200, {'messages':[{'id':'wamid.'+q}]}
        raise AssertionError((method,path))

def endpoint(fix):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self): self.respond()
        def do_POST(self): self.respond()
        def log_message(self,*args): pass
        def respond(self):
            try:
                data = json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
                out = fix.handle(self.command,urlsplit(self.path),data)
                if out is None:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                status, obj = out
            except Exception as err:
                fix.errors.append(repr(err))
                status,obj = 500, {'error':'fixture assertion failed'}
            raw = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    return Handler

def private_copy(stock, port):
    w = json.loads(json.dumps(stock))
    w['id']='fixtureQuotesOnly'
    origins = ['https://sheets.googleapis.com','https://gmail.googleapis.com','https://graph.facebook.com']
    for n in w['nodes']:
        p = n['parameters']
        if n['name']=='Configuration':
            for old,new in [("live: false","live: true"),("spreadsheetId: ''","spreadsheetId: 'fixture_sheet_id_12345'"),
                            ("whatsappEnabled: false","whatsappEnabled: true"),("graphVersion: ''","graphVersion: 'v1.0'"),
                            ("phoneNumberId: ''","phoneNumberId: '111'"),("ownerPhone: ''","ownerPhone: '12345678900'")]:
                assert old in p['jsCode']
                p['jsCode']=p['jsCode'].replace(old,new,1)
        if n['type']=='n8n-nodes-base.httpRequest':
            matches=[o for o in origins if o in p['url']]
            assert len(matches)==1
            p['url']=p['url'].replace(matches[0],f'http://127.0.0.1:{port}')
            for k in ['genericAuthType','nodeCredentialType']: p.pop(k,None)
            p['authentication']='none'
            assert 'https://' not in p['url'] and 'credentials' not in n
    return w

def main():
    assert __debug__, 'Run without Python -O so assertions are enabled'
    stock=json.loads(EXPORT.read_text())
    assert not stock['active'] and all(n['disabled'] for n in stock['nodes'] if n['type'].endswith('.scheduleTrigger'))
    assert 'live: false' in next(n['parameters']['jsCode'] for n in stock['nodes'] if n['name']=='Configuration')
    cli=os.environ.get('N8N_BIN','n8n')
    fix=Fixtures()
    with tempfile.TemporaryDirectory() as home, ThreadingHTTPServer(('127.0.0.1',0),endpoint(fix)) as server:
        threading.Thread(target=server.serve_forever,daemon=True).start()
        # Whitelist the environment to exclude provider credentials and external DB settings.
        env={k:os.environ[k] for k in ['PATH','SystemRoot','TEMP','TMP'] if k in os.environ}
        env.update(HOME=home,N8N_USER_FOLDER=home,DB_TYPE='sqlite',N8N_DIAGNOSTICS_ENABLED='false',
                   N8N_VERSION_NOTIFICATIONS_ENABLED='false',N8N_TEMPLATES_ENABLED='false',
                   N8N_RUNNERS_BROKER_PORT='15789',N8N_PORT='15678',N8N_LOG_LEVEL='warn')
        def cmd(*args):
            result=subprocess.run([cli,*args],env=env,cwd=home,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
            return result.returncode,result.stdout
        print('n8n',cmd('--version')[1].strip(),flush=True)
        def load(w):
            f=Path(home)/'workflow.json'
            f.write_text(json.dumps(w))
            rc,out=cmd('import:workflow','--input='+str(f))
            assert rc==0 and 'error occurred' not in out.lower(),out[-1600:]
        covered=set()
        def execute(w,expected=None):
            rc,out=cmd('execute','--id='+w['id'],'--rawOutput')
            start = re.search(r'(?m)^\{\s*"data"\s*:',out)
            assert start,out[-1600:]
            record,_ = json.JSONDecoder().raw_decode(out[start.start():])
            result = record['data']['resultData']
            covered.update(result['runData'])
            if expected:
                assert record['status']=='error' and expected in result['error']['message'],(rc,record['status'],result['error']['message'])
            else:
                assert rc==0 and record['status']=='success' and 'Run result' in result['runData'],(rc,out[-2400:])
            assert not fix.errors,fix.errors
            return result
        load(stock)
        execute(stock,'Live access is disabled')
        assert not fix.calls
        print('PASS release import and guarded execution',flush=True)
        w=private_copy(stock,server.server_port)
        load(w)
        fix.rows=[quote('a'),quote('b'),quote('c')]
        out=execute(w)
        summary=out['runData']['Run result'][-1]['data']['main'][0][0]['json']
        assert summary=={'total':3,'processed':3,'skipped':0},summary
        for row in fix.rows:
            q=row['quote_id']
            assert row['draft_id']==f'draft-{q}-1' and row['wa_message_id']=='wamid.'+q
        totals=fix.calls.copy()
        execute(w)
        assert all(fix.calls[k]==v for k,v in totals.items() if k[0] in ['notify','create','write','search'])
        print('PASS three customers, item linking and idempotent rerun',flush=True)
        ids=['recover','expired','limited','disconnect','lostack','foreign','lostdraft','tail']
        fix.rows=[quote(q) for q in ids]
        fix.drafts['foreign-draft']=(SUBJECT+'foreign','other@example.test')
        fix.wave=1
        execute(w,'row(s) need attention')
        rows={r['quote_id']:r for r in fix.rows}
        for q,state in [('expired','Auth Blocked'),('limited','Retry'),('disconnect','Review'),('lostack','Sending'),('tail','Accepted')]:
            assert rows[q]['alert_status']==state,(q,rows[q])
        assert rows['recover']['draft_guard']=='Reserved' and not rows['recover'].get('draft_id')
        assert rows['lostdraft']['draft_guard']=='Reserved' and not rows['lostdraft'].get('draft_id')
        assert fix.calls['create','foreign']==0 and 'ownership' in rows['foreign']['error_message']
        print('PASS failed sheet checkpoint, auth, rate limit, dropped response, lost acceptance checkpoint and foreign recipient',flush=True)
        fix.wave=2
        execute(w,'row(s) need attention')
        assert rows['recover']['draft_id']=='draft-recover-1' and rows['recover']['alert_status']=='Accepted'
        assert fix.calls['inspect','recover']==1 and fix.calls['create','recover']==1
        assert rows['limited']['alert_status']=='Accepted' and fix.calls['notify','limited']==2
        assert rows['lostdraft']['draft_id']=='draft-lostdraft-1' and fix.calls['create','lostdraft']==1
        assert fix.calls['inspect','lostdraft']==1
        for q in ['expired','disconnect','lostack','tail']: assert fix.calls['notify',q]==1
        print('PASS recovery on fresh execution, bounded resend and held uncertain alerts',flush=True)
        wanted={n['name'] for n in stock['nodes'] if not n.get('disabled')}
        assert covered==wanted,(covered ^ wanted)
        print(f'PASS {len(covered)} enabled nodes recorded; disabled schedule absent',flush=True)
        server.shutdown()

if __name__=='__main__': main()
