"""Verify only the new HR spreadsheet using local clasp auth and Drive export.
No credentials or submitted answers are printed or stored in the repository.
"""
import argparse, io, json, os, re, urllib.parse, urllib.request, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SHEET_ID=re.search(r"HR_SHEET_ID = '([^']+)'",(ROOT/'apps-script/Code.gs').read_text(encoding='utf-8')).group(1)
parser=argparse.ArgumentParser(); parser.add_argument('--test-id',required=True); args=parser.parse_args()
c=json.loads((Path(os.environ['USERPROFILE'])/'.clasprc.json').read_text(encoding='utf-8'))['tokens']['default']
data=urllib.parse.urlencode({k:c[k] for k in ('client_id','client_secret','refresh_token')}|{'grant_type':'refresh_token'}).encode()
token=json.load(urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token',data=data),timeout=20))['access_token']
def request(url):
 return urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token}),timeout=35)
permissions=json.load(request('https://www.googleapis.com/drive/v3/files/'+SHEET_ID+'/permissions?fields=permissions(type,role)'))['permissions']
private=len(permissions)==1 and permissions[0]['type']=='user' and permissions[0]['role']=='owner'
print(json.dumps({'private_owner_only':private})); assert private
xlsx=request('https://www.googleapis.com/drive/v3/files/'+SHEET_ID+'/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').read()
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
matches=[]; formula_rows=[]
with zipfile.ZipFile(io.BytesIO(xlsx)) as archive:
 shared=[]
 if 'xl/sharedStrings.xml' in archive.namelist():
  for cell in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('s:si',ns):shared.append(''.join(cell.itertext()))
 for name in archive.namelist():
  if not re.fullmatch(r'xl/worksheets/sheet[0-9]+\.xml',name):continue
  for row in ET.fromstring(archive.read(name)).findall('.//s:sheetData/s:row',ns):
   values={}
   for cell in row.findall('s:c',ns):
    value=cell.find('s:v',ns); text=value.text if value is not None else ''.join(cell.find('s:is',ns).itertext()) if cell.find('s:is',ns) is not None else ''
    if cell.get('t')=='s':text=shared[int(text)]
    values[re.sub(r'[0-9]+','',cell.get('r',''))]=text
   if values.get('A')==args.test_id:matches.append(values);formula_rows.append(bool(row.findall('s:c/s:f',ns)))
print(json.dumps({'test_rows_with_id':len(matches),'test_marker_verified':bool(matches and matches[0].get('D','').startswith('ТЕСТОВАЯ ЗАПИСЬ')),'checksum_present':bool(matches and matches[0].get('BY'))}))
assert len(matches)==1 and matches[0].get('D','').startswith('ТЕСТОВАЯ ЗАПИСЬ') and matches[0].get('BY')
print(json.dumps({'test_row_has_formulas':any(formula_rows),'formula_examples_stored_as_text':all(expected in matches[0].get(col,'') for col,expected in [('K','=1+1'),('N','@test'),('Q','-item'),('T','+7-test')])}))
assert not any(formula_rows)
