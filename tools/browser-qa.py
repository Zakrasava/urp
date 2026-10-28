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
    real_receiver_hits = []
    def guard(context):
        context.route('https://script.google.com/**', lambda r: (real_receiver_hits.append(r.request.url), r.abort()))
        return context
    # Real assets must load under a project subpath, without any config mock.
    asset_page = browser.new_page()
    asset_errors = []
    asset_page.on('pageerror', lambda e: asset_errors.append(str(e)))
    asset_page.on('response', lambda r: asset_errors.append(str(r.status) + ' ' + r.url) if r.url.startswith(ORIGIN + '/') and r.status >= 400 else None)
    asset_page.on('requestfailed', lambda r: asset_errors.append(r.url + ' ' + str(r.failure)) if r.url.startswith(ORIGIN + '/') else None)
    asset_page.goto(BASE, wait_until='networkidle')
    assert asset_page.locator('fieldset.q').count() == 18
    actual_config = asset_page.evaluate('window.HR_SURVEY_CONFIG')
    assert actual_config['version'] == '2026-10-28.1'
    assert actual_config['endpoint'] == 'https://script.google.com/macros/s/AKfycbxMp6EmMyiqF1OeQ3t-kLe67KLDy4vrDfgbfIgox9F7V0xjHF-Urmefc2vSuuGxEJdd/exec'
    assert not asset_errors, asset_errors
    asset_page.close()
    # A round 1 draft must not be substituted into round 2 questions, and it stays untouched.
    migrated = browser.new_context()
    prior_draft = {'respondent': {'team': 'Прежний кадровый черновик', 'role': 'Тест', 'contact': ''}, 'answers': {'K01': {'status': 'pending', 'text': 'Уже введённое пояснение', 'link': ''}}, 'comments': ''}
    prior_raw = json.dumps(prior_draft, ensure_ascii=False)
    migrated.add_init_script('localStorage.setItem("hr-portal-survey:draft:v1", ' + json.dumps(prior_raw) + ');')
    migrated_page = migrated.new_page()
    migrated_page.goto(BASE)
    migrated_page.wait_for_selector('#R18-status')
    assert migrated_page.locator('#team').input_value() == ''
    assert migrated_page.locator('#R01-text').input_value() == ''
    assert migrated_page.locator('#R01-status').input_value() == ''
    assert migrated_page.locator('#counter').inner_text() == 'Отмечено 0 из 18'
    assert migrated_page.evaluate('localStorage.getItem("hr-portal-survey:draft:v1")') == prior_raw
    assert migrated_page.evaluate('localStorage.getItem("hr-portal-survey:draft:v2")') is None
    migrated.close()
    context = guard(browser.new_context(viewport={'width': 1440, 'height': 1000}))
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

    page.route('**/config.js*', lambda r: r.fulfill(content_type='text/javascript', body='window.HR_SURVEY_CONFIG={endpoint:"https://receiver.example.test/exec",version:"test",timeoutMs:800};'))
    page.route('https://receiver.example.test/exec', receiver)
    page.add_init_script('localStorage.setItem("survey-draft-v3", "old-survey-sentinel");')
    page.goto(BASE)
    page.wait_for_selector('#R18-status')
    assert page.locator('fieldset.q').count() == 18
    assert page.locator('#section-nav a').count() == 5
    assert page.locator('#section-nav a').all_inner_texts() == ['1. Доступ', '2. Публикации', '3. Справочник', '4. Запуск', '5. Отпуска']
    assert page.locator('#intro p').count() == 2 and page.locator('#accepted-list li').count() == 8
    assert page.locator('#R01 .q-options li').count() == 3
    assert '[ПЗГД]' in page.locator('#R03').inner_text()
    assert 'Что нужно:' in page.locator('#R01').inner_text()
    assert page.locator('.source-copy, .example, .sources').count() == 0
    assert page.locator('#progress').get_attribute('max') == '18'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert page.locator('input:not(.trap input):visible, textarea:visible, select:visible').evaluate_all('(els) => els.every(e => !!document.querySelector(`label[for="${e.id}"]`))')
    page.screenshot(path=str(ARTIFACTS / 'desktop.png'))
    page.locator('#R01').scroll_into_view_if_needed()
    page.screenshot(path=str(ARTIFACTS / 'desktop-question.png'))
    # Permission denial offers manual copying of the answers.
    page.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>Promise.reject(Error("denied"))}})')
    page.locator('#copy-answers').click()
    assert page.locator('#copy-fallback').is_visible()
    assert page.locator('#copy-text').input_value().startswith('Уточнения УРП — второй круг')
    assert 'R18. График отпусков на 2027 год' in page.locator('#copy-text').input_value()
    page.locator('#send').click()
    assert page.locator('#team').get_attribute('aria-invalid') == 'true'
    page.locator('#team').fill('Тестовая запись — УРП')
    page.locator('#role').fill('Браузерная проверка')
    for i in range(1, 19):
        page.locator(f'#R{i:02}-status').select_option('pending')
    page.locator('#R01-status').select_option('ready')
    page.locator('#send').click()
    assert page.locator('#R01-text').get_attribute('aria-invalid') == 'true'
    page.locator('#R01-text').fill('Тестовый ответ')
    page.locator('#R02-link').fill('javascript:alert(1)')
    page.locator('#send').click()
    assert page.locator('#R02-link').get_attribute('aria-invalid') == 'true'
    page.locator('#R02-link').fill('\\\\server\\share\\Образец.pdf')
    assert page.locator('#progress').get_attribute('value') == '18'
    # Reload restores this form only.
    page.reload()
    page.wait_for_selector('#R18-status')
    assert page.locator('#R01-text').input_value() == 'Тестовый ответ'
    assert page.evaluate('localStorage.getItem("survey-draft-v3")') == 'old-survey-sentinel'
    page.locator('#send').click()
    page.wait_for_selector('#send-error:visible')
    assert not page.locator('#success').is_visible()
    assert page.locator('#R01-text').input_value() == 'Тестовый ответ'
    page.locator('#R01-text').fill('Временное изменение')
    page.locator('#R01-text').fill('Тестовый ответ')
    page.reload()
    page.wait_for_selector('#R18-status')
    page.locator('#send').click()
    page.wait_for_selector('#success:visible')
    assert len(requests) == 2 and requests[0]['submissionId'] == requests[1]['submissionId']
    assert page.evaluate('localStorage.getItem("hr-portal-survey:draft:v2")') is None
    assert page.evaluate('localStorage.getItem("survey-draft-v3")') == 'old-survey-sentinel'
    page.locator('#new-response').click()
    assert page.locator('#team').input_value() == ''
    # Editing a restored attempt creates a new revision instead of conflicting with its old ID.
    page.evaluate('(data) => localStorage.setItem("hr-portal-survey:draft:v2",JSON.stringify(data))', requests[0])
    page.reload()
    page.wait_for_selector('#R18-status')
    page.locator('#R01-text').fill('Обновлённый тестовый ответ')
    page.locator('#send').click()
    page.wait_for_selector('#success:visible')
    assert len(requests) == 3 and requests[2]['submissionId'] != requests[0]['submissionId']
    assert not errors, errors

    # Small phones, network-offline state, and inaccessible storage.
    phone = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, device_scale_factor=1, has_touch=True)
    mobile = phone.new_page()
    mobile.on('pageerror', lambda error: errors.append(str(error)))
    mobile.goto(BASE)
    mobile.wait_for_selector('#R18-status')
    for width in [320, 360, 390, 768]:
        mobile.set_viewport_size({'width': width, 'height': 844})
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    mobile.set_viewport_size({'width': 390, 'height': 844})
    mobile.screenshot(path=str(ARTIFACTS / 'mobile.png'))
    mobile.locator('#R01').scroll_into_view_if_needed()
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
    denied_page.wait_for_selector('#R18-status')
    denied_page.locator('#team').fill('Не потерять')
    assert 'не сохранится' in denied_page.locator('#draft-state').inner_text()
    assert 'Скопируйте ответы' in denied_page.locator('#draft-state').inner_text()
    assert not errors, errors
    outage = guard(browser.new_context())
    outage_page = outage.new_page()
    outage_page.on('pageerror', lambda error: errors.append(str(error)))
    outage_page.route('**/config.js*', lambda r: r.fulfill(content_type='text/javascript', body='window.HR_SURVEY_CONFIG={endpoint:"https://receiver.example.test/exec",version:"test",timeoutMs:100};'))
    outage_page.goto(BASE)
    outage_page.wait_for_selector('#R18-status')
    outage_page.locator('#team').fill('Проверка сохранности')
    outage_page.locator('#role').fill('Тест')
    for i in range(1, 19):
        outage_page.locator(f'#R{i:02}-status').select_option('pending')
    outage.set_offline(True)
    outage_page.locator('#send').click()
    assert 'Нет подключения' in outage_page.locator('#send-error-text').inner_text()
    assert outage_page.locator('#team').input_value() == 'Проверка сохранности'
    outage.set_offline(False)
    outage_page.evaluate('() => {window.fetch=(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError"))));}')
    outage_page.locator('#retry').click()
    outage_page.wait_for_function('document.getElementById("send-error-text").textContent.includes("не ответил вовремя")')
    timeout_id = outage_page.evaluate('JSON.parse(localStorage.getItem("hr-portal-survey:draft:v2")).submissionId')
    assert timeout_id
    outage_page.evaluate('() => {window.fetch=(url,options)=>Promise.resolve({ok:true,json:()=>Promise.resolve({ok:true,service:"hr-portal-survey",submissionId:JSON.parse(options.body).submissionId})});}')
    outage_page.locator('#retry').click()
    outage_page.wait_for_selector('#success:visible')
    assert timeout_id in outage_page.locator('#receipt').inner_text()
    assert not errors, errors
    assert not real_receiver_hits, real_receiver_hits
    browser.close()
    print(json.dumps({'ok': True, 'questions': 18, 'viewports': [320, 360, 390, 768, 1440], 'retry_idempotent': True, 'storage_fallback': True, 'old_storage_preserved': True, 'project_subpath': True, 'real_config_verified': True, 'round1_draft_not_applied': True, 'screenshots': str(ARTIFACTS)}, ensure_ascii=False))
