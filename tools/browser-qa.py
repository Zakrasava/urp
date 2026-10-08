"""Focused local browser verification; no requests reach the old survey receiver."""
import atexit, json, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
class ProjectHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def do_GET(self):
        if not self.path.startswith('/urp/'):
            self.send_error(404)
            return
        self.path = self.path[len('/urp'):]
        super().do_GET()
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), ProjectHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
atexit.register(server.shutdown)
ORIGIN = 'http://127.0.0.1:' + str(server.server_port)
BASE = ORIGIN + '/urp/'
ARTIFACTS = ROOT / 'qa-artifacts'
ARTIFACTS.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    # Real assets must load under a project subpath, without any config mock.
    asset_page = browser.new_page()
    asset_errors = []
    asset_page.on('pageerror', lambda e: asset_errors.append(str(e)))
    asset_page.on('response', lambda r: asset_errors.append(str(r.status) + ' ' + r.url) if r.url.startswith(ORIGIN + '/') and r.status >= 400 else None)
    asset_page.on('requestfailed', lambda r: asset_errors.append(r.url + ' ' + str(r.failure)) if r.url.startswith(ORIGIN + '/') else None)
    asset_page.goto(BASE, wait_until='networkidle')
    assert asset_page.locator('fieldset.q').count() == 23
    actual_config = asset_page.evaluate('window.HR_SURVEY_CONFIG')
    assert actual_config['version'] == '2026-10-08.2'
    assert actual_config['endpoint'] == 'https://script.google.com/macros/s/AKfycbxMp6EmMyiqF1OeQ3t-kLe67KLDy4vrDfgbfIgox9F7V0xjHF-Urmefc2vSuuGxEJdd/exec'
    assert not asset_errors, asset_errors
    asset_page.close()
    # The renamed publication intentionally restores the existing HR draft.
    migrated = browser.new_context()
    prior_draft = {'respondent': {'team': 'Прежний кадровый черновик', 'role': 'Тест', 'contact': ''}, 'answers': {'K01': {'status': 'pending', 'text': 'Уже введённое пояснение', 'link': ''}}, 'comments': ''}
    migrated.add_init_script('localStorage.setItem("hr-portal-survey:draft:v1", ' + json.dumps(json.dumps(prior_draft, ensure_ascii=False)) + ');')
    migrated_page = migrated.new_page()
    migrated_page.goto(BASE)
    assert migrated_page.locator('#team').input_value() == prior_draft['respondent']['team']
    assert migrated_page.locator('#K01-text').input_value() == prior_draft['answers']['K01']['text']
    assert migrated_page.locator('#K01-status').input_value() == 'pending'
    migrated.close()
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    requests = []

    def receiver(route):
        data = route.request.post_data_json
        requests.append(data)
        if len(requests) == 1:
            route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
        else:
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'service': 'hr-portal-survey', 'submissionId': data['submissionId']}))

    page.route('**/config.js', lambda r: r.fulfill(content_type='text/javascript', body='window.HR_SURVEY_CONFIG={endpoint:"https://receiver.example.test/exec",version:"test",timeoutMs:800};'))
    page.route('https://receiver.example.test/exec', receiver)
    page.add_init_script('localStorage.setItem("survey-draft-v3", "old-survey-sentinel");')
    page.goto(BASE)
    page.wait_for_selector('#K23-status')
    assert page.locator('fieldset.q').count() == 23
    assert page.locator('#section-nav a').count() == 5
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert page.locator('input:not(.trap input):visible, textarea:visible, select:visible').evaluate_all('(els) => els.every(e => !!document.querySelector(`label[for="${e.id}"]`))')
    page.screenshot(path=str(ARTIFACTS / 'desktop.png'))
    page.locator('#K01').scroll_into_view_if_needed()
    page.locator('#K01 .example').evaluate('(e)=>e.open=true')
    page.locator('#K01 .sources').evaluate('(e)=>e.open=true')
    page.screenshot(path=str(ARTIFACTS / 'desktop-question.png'))
    # Permission denial offers manual copying, including the exact UNC path.
    page.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>Promise.reject(Error("denied"))}})')
    page.locator('#K01 .source-copy').click()
    assert page.locator('#copy-fallback').is_visible()
    assert page.locator('#copy-text').input_value().startswith('\\\\isreg.ru\\')
    page.locator('#send').click()
    assert page.locator('#team').get_attribute('aria-invalid') == 'true'
    page.locator('#team').fill('Тестовая запись — УРП')
    page.locator('#role').fill('Браузерная проверка')
    for i in range(1, 24):
        page.locator(f'#K{i:02}-status').select_option('pending')
    page.locator('#K01-status').select_option('ready')
    page.locator('#send').click()
    assert page.locator('#K01-text').get_attribute('aria-invalid') == 'true'
    page.locator('#K01-text').fill('Тестовый ответ')
    page.locator('#K02-link').fill('javascript:alert(1)')
    page.locator('#send').click()
    assert page.locator('#K02-link').get_attribute('aria-invalid') == 'true'
    page.locator('#K02-link').fill('\\\\server\\share\\Образец.pdf')
    assert page.locator('#progress').get_attribute('value') == '23'
    # Reload restores this form only.
    page.reload()
    page.wait_for_selector('#K23-status')
    assert page.locator('#K01-text').input_value() == 'Тестовый ответ'
    assert page.evaluate('localStorage.getItem("survey-draft-v3")') == 'old-survey-sentinel'
    page.locator('#send').click()
    page.wait_for_selector('#send-error:visible')
    assert not page.locator('#success').is_visible()
    assert page.locator('#K01-text').input_value() == 'Тестовый ответ'
    page.locator('#K01-text').fill('Временное изменение')
    page.locator('#K01-text').fill('Тестовый ответ')
    page.reload()
    page.wait_for_selector('#K23-status')
    page.locator('#send').click()
    page.wait_for_selector('#success:visible')
    assert len(requests) == 2 and requests[0]['submissionId'] == requests[1]['submissionId']
    assert page.evaluate('localStorage.getItem("hr-portal-survey:draft:v1")') is None
    assert page.evaluate('localStorage.getItem("survey-draft-v3")') == 'old-survey-sentinel'
    page.locator('#new-response').click()
    assert page.locator('#team').input_value() == ''
    # Editing a restored attempt creates a new revision instead of conflicting with its old ID.
    page.evaluate('(data) => localStorage.setItem("hr-portal-survey:draft:v1",JSON.stringify(data))', requests[0])
    page.reload()
    page.wait_for_selector('#K23-status')
    page.locator('#K01-text').fill('Обновлённый тестовый ответ')
    page.locator('#send').click()
    page.wait_for_selector('#success:visible')
    assert len(requests) == 3 and requests[2]['submissionId'] != requests[0]['submissionId']
    assert not errors, errors

    # Small phones, network-offline state, and inaccessible storage.
    phone = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, device_scale_factor=1, has_touch=True)
    mobile = phone.new_page()
    mobile.on('pageerror', lambda error: errors.append(str(error)))
    mobile.goto(BASE)
    mobile.wait_for_selector('#K23-status')
    for width in [320, 360, 390, 768]:
        mobile.set_viewport_size({'width': width, 'height': 844})
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    mobile.set_viewport_size({'width': 390, 'height': 844})
    mobile.screenshot(path=str(ARTIFACTS / 'mobile.png'))
    mobile.locator('#K01 .example').evaluate('(e)=>e.open=true')
    mobile.locator('#K01').scroll_into_view_if_needed()
    mobile.screenshot(path=str(ARTIFACTS / 'mobile-question.png'))
    mobile.locator('#team').fill('Черновик')
    mobile.locator('#clear-draft').click()
    assert mobile.locator('#clear-confirm').is_visible()
    mobile.locator('#clear-no').click()
    assert mobile.locator('#team').input_value() == 'Черновик'
    mobile.locator('#clear-draft').click()
    mobile.locator('#clear-yes').click()
    assert mobile.locator('#team').input_value() == ''
    denied = browser.new_context()
    denied.add_init_script('Object.defineProperty(window,"localStorage",{get(){throw Error("denied");}});')
    denied_page = denied.new_page()
    denied_page.on('pageerror', lambda error: errors.append(str(error)))
    denied_page.goto(BASE)
    denied_page.wait_for_selector('#K23-status')
    denied_page.locator('#team').fill('Не потерять')
    assert 'не сохранится' in denied_page.locator('#draft-state').inner_text()
    assert 'Скопируйте ответы' in denied_page.locator('#draft-state').inner_text()
    assert not errors, errors
    outage = browser.new_context()
    outage_page = outage.new_page()
    outage_page.on('pageerror', lambda error: errors.append(str(error)))
    outage_page.route('**/config.js', lambda r: r.fulfill(content_type='text/javascript', body='window.HR_SURVEY_CONFIG={endpoint:"https://receiver.example.test/exec",version:"test",timeoutMs:100};'))
    outage_page.goto(BASE)
    outage_page.wait_for_selector('#K23-status')
    outage_page.locator('#team').fill('Проверка сохранности')
    outage_page.locator('#role').fill('Тест')
    for i in range(1, 24):
        outage_page.locator(f'#K{i:02}-status').select_option('pending')
    outage.set_offline(True)
    outage_page.locator('#send').click()
    assert 'Нет подключения' in outage_page.locator('#send-error-text').inner_text()
    assert outage_page.locator('#team').input_value() == 'Проверка сохранности'
    outage.set_offline(False)
    outage_page.evaluate('() => {window.fetch=(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError"))));}')
    outage_page.locator('#retry').click()
    outage_page.wait_for_function('document.getElementById("send-error-text").textContent.includes("не ответил вовремя")')
    timeout_id = outage_page.evaluate('JSON.parse(localStorage.getItem("hr-portal-survey:draft:v1")).submissionId')
    assert timeout_id
    outage_page.evaluate('() => {window.fetch=(url,options)=>Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,service:"hr-portal-survey",submissionId:JSON.parse(options.body).submissionId})});}')
    outage_page.locator('#retry').click()
    outage_page.wait_for_selector('#success:visible')
    assert timeout_id in outage_page.locator('#receipt').inner_text()
    assert not errors, errors
    browser.close()
    print(json.dumps({'ok': True, 'questions': 23, 'viewports': [320, 360, 390, 768, 1440], 'retry_idempotent': True, 'storage_fallback': True, 'old_storage_preserved': True, 'project_subpath': True, 'real_config_verified': True, 'hr_draft_migration': True, 'screenshots': str(ARTIFACTS)}, ensure_ascii=False))
