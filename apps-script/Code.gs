// Independent receiver for the /hr/ survey. Never uses the training survey sheet.
var HR_SERVICE = 'hr-portal-survey';
var HR_SHEET_ID = '1PRnjDo_LXdpiYtTd0OvUgVUMe2aDYyPb_MW5mr_gVyc';
var HR_SHEET_NAME = 'Ответы УРП';
var HR_QUESTION_IDS = Array.from({length: 23}, function (_, i) { return 'K' + ('0' + (i + 1)).slice(-2); });
var HR_STATUS_LABELS = {ready: 'Решение известно', pending: 'Нужно уточнить', delegate: 'Другое подразделение'};
var HR_HEADERS = ['ID ответа', 'Получено (UTC)', 'Версия формы', 'Подразделение', 'Должность / роль', 'Рабочий контакт'];
HR_QUESTION_IDS.forEach(function (id) {
  HR_HEADERS.push(id + ' — статус', id + ' — ответ', id + ' — материал');
});
HR_HEADERS.push('Дополнительные замечания', 'Контрольная сумма');

function doGet() {
  return hrJson_({ok: true, service: HR_SERVICE, version: '2026-10-08.1'});
}

function doPost(e) {
  var lock;
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string' || e.postData.contents.length > 350000) return hrError_('BAD_REQUEST');
    var data;
    try { data = hrValidate_(JSON.parse(e.postData.contents)); } catch (_) { return hrError_('BAD_REQUEST'); }
    // Client release metadata must not turn an unchanged retry into a conflict.
    var digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify({respondent: data.respondent, answers: data.answers, comments: data.comments}), Utilities.Charset.UTF_8);
    var digest = digestBytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return hrError_('BUSY');
    var spreadsheet = SpreadsheetApp.openById(HR_SHEET_ID);
    var sheet = spreadsheet.getSheetByName(HR_SHEET_NAME) || spreadsheet.insertSheet(HR_SHEET_NAME);
    if (sheet.getMaxColumns() < HR_HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HR_HEADERS.length - sheet.getMaxColumns());
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HR_HEADERS.length).setValues([HR_HEADERS]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, HR_HEADERS.length).setFontWeight('bold').setBackground('#d9eee9');
    }
    var headers = sheet.getRange(1, 1, 1, HR_HEADERS.length).getValues()[0];
    if (headers.some(function (value, i) { return value !== HR_HEADERS[i]; })) return hrError_('SCHEMA_MISMATCH');
    if (sheet.getLastRow() > 1) {
      var found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(data.submissionId).matchEntireCell(true).findNext();
      if (found) {
        var existingDigest = sheet.getRange(found.getRow(), HR_HEADERS.length).getValue();
        if (existingDigest !== digest) return hrError_('ID_CONFLICT');
        return hrJson_({ok: true, service: HR_SERVICE, submissionId: data.submissionId, duplicate: true});
      }
    }
    var values = [data.submissionId, new Date().toISOString(), data.version, data.respondent.team, data.respondent.role, data.respondent.contact];
    HR_QUESTION_IDS.forEach(function (id) { var a = data.answers[id]; values.push(HR_STATUS_LABELS[a.status], a.text, a.link); });
    values.push(data.comments, digest);
    // Write all untrusted content as text and neutralize spreadsheet formulas.
    var nextRow = sheet.getLastRow() + 1;
    if (nextRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 200);
    sheet.getRange(nextRow, 1, 1, values.length).setNumberFormat('@').setValues([values.map(hrSafeText_)]);
    SpreadsheetApp.flush();
    return hrJson_({ok: true, service: HR_SERVICE, submissionId: data.submissionId, duplicate: false});
  } catch (_) {
    // Never expose spreadsheet IDs, submitted answers or exception details.
    return hrError_('SAVE_FAILED');
  } finally { if (lock && lock.hasLock()) lock.releaseLock(); }
}

function hrValidate_(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.service !== HR_SERVICE || input.schema !== 1 || input.website) throw new Error('Invalid envelope');
  if (typeof input.submissionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.submissionId)) throw new Error('Invalid ID');
  var r = input.respondent;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Invalid respondent');
  var answers = input.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== HR_QUESTION_IDS.length) throw new Error('Invalid answers');
  var result = {service: HR_SERVICE, schema: 1, version: hrText_(input.version, 40, true), submissionId: input.submissionId.toLowerCase(), respondent: {team: hrText_(r.team, 180, true), role: hrText_(r.role, 180, true), contact: hrText_(r.contact, 200, false)}, answers: {}, comments: hrText_(input.comments, 5000, false)};
  HR_QUESTION_IDS.forEach(function (id) {
    var a = answers[id];
    if (!a || typeof a.status !== 'string' || !Object.prototype.hasOwnProperty.call(HR_STATUS_LABELS, a.status)) throw new Error('Invalid status');
    var text = hrText_(a.text, 5000, a.status === 'ready');
    var link = hrText_(a.link, 1500, false);
    if (link && !hrValidLink_(link)) throw new Error('Invalid link');
    result.answers[id] = {status: a.status, text: text, link: link};
  });
  return result;
}

function hrText_(value, max, required) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || /\x00/.test(value)) throw new Error('Invalid field');
  value = value.trim();
  if (required && !value) throw new Error('Missing field');
  return value;
}
function hrValidLink_(value) {
  if (/[\r\n\x00-\x1f]/.test(value)) return false;
  if (/^\\\\[^\\\s]+\\[^\\]+/.test(value)) return true;
  return /^https?:\/\/(?:\[[0-9a-f:.]+\]|[^\s\\/@:?#]+)(?::\d+)?(?:[\/?#][^\s\\]*)?$/i.test(value);
}
function hrSafeText_(value) { var s = String(value == null ? '' : value); return /^\s*[=+\-@]/.test(s) ? "'" + s : s; }
function hrError_(code) { if (code !== 'BAD_REQUEST') console.warn(HR_SERVICE + ':' + code); return hrJson_({ok: false, service: HR_SERVICE, error: code}); }
function hrJson_(data) { return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON); }
