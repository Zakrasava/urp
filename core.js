(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HRSurveyCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var statuses = { ready: "Решение известно", pending: "Нужно уточнить", delegate: "Другое подразделение" };
  var key = "hr-portal-survey:draft:v1";
  var maxPayloadLength = 350000;
  function knownStatus(value) { return typeof value === "string" && Object.prototype.hasOwnProperty.call(statuses, value); }
  function str(value) { return typeof value === "string" ? value.trim() : ""; }
  function questions(data) { return data.sections.reduce(function (all, s) { return all.concat(s.questions); }, []); }
  function validLink(value) {
    var s = str(value);
    if (!s) return true;
    if (s.length > 1500 || /[\r\n\x00-\x1f]/.test(s)) return false;
    if (/^\\\\[^\\\s]+\\[^\\]+/.test(s)) return true;
    return /^https?:\/\/(?:\[[0-9a-f:.]+\]|[^\s\\/@:?#]+)(?::\d+)?(?:[\/?#][^\s\\]*)?$/i.test(s);
  }
  function fileUrl(path) {
    if (!/^\\\\[^\\\s]+\\/.test(path)) return "";
    return "file://" + path.slice(2).split("\\").map(encodeURIComponent).join("/");
  }
  function answerComplete(answer) {
    return !!answer && knownStatus(answer.status) && (answer.status !== "ready" || str(answer.text).length > 0);
  }
  function normalize(raw, list) {
    raw = raw && typeof raw === "object" ? raw : {};
    var respondent = raw.respondent || {}, answers = {};
    list.forEach(function (q) {
      var a = raw.answers && raw.answers[q.id] || {};
      answers[q.id] = { status: knownStatus(a.status) ? a.status : "", text: str(a.text).slice(0, 5000), link: str(a.link).slice(0, 1500) };
    });
    return { respondent: { team: str(respondent.team).slice(0, 180), role: str(respondent.role).slice(0, 180), contact: str(respondent.contact).slice(0, 200) }, answers: answers, comments: str(raw.comments).slice(0, 5000), submissionId: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw.submissionId || "") ? raw.submissionId.toLowerCase() : "", lastSubmittedContent: typeof raw.lastSubmittedContent === "string" && raw.lastSubmittedContent.length <= maxPayloadLength ? raw.lastSubmittedContent : "" };
  }
  function validate(state, list) {
    var errors = {};
    if (!str(state.respondent.team)) errors.team = "Укажите подразделение.";
    if (!str(state.respondent.role)) errors.role = "Укажите должность или роль.";
    ["team", "role", "contact"].forEach(function (key) { if (/\x00/.test(state.respondent[key])) errors[key] = "Удалите нулевой символ из текста."; });
    if (/\x00/.test(state.comments)) errors.comments = "Удалите нулевой символ из текста.";
    list.forEach(function (q) {
      var a = state.answers[q.id] || {};
      if (!knownStatus(a.status)) errors[q.id + "-status"] = "Выберите статус для вопроса.";
      if (a.status === "ready" && !str(a.text)) errors[q.id + "-text"] = "Напишите ответ или выберите «Нужно уточнить».";
      if (/\x00/.test(a.text)) errors[q.id + "-text"] = "Удалите нулевой символ из текста.";
      if (!validLink(a.link)) errors[q.id + "-link"] = "Укажите http(s)-ссылку или полный сетевой путь к файлу.";
    });
    return errors;
  }
  function uuid(cryptoApi) {
    if (cryptoApi && cryptoApi.randomUUID) return cryptoApi.randomUUID();
    var bytes = new Uint8Array(16);
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (n) { return n.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  function storage(getStorage) {
    var memory = "", available = true;
    return {
      read: function () { try { memory = getStorage().getItem(key) || ""; } catch (_) { available = false; } return memory; },
      write: function (value) { memory = value; try { getStorage().setItem(key, value); available = true; } catch (_) { available = false; } return available; },
      clear: function () { memory = ""; try { getStorage().removeItem(key); } catch (_) { available = false; } },
      available: function () { return available; }
    };
  }
  function draft(raw, list) { try { return normalize(JSON.parse(raw), list); } catch (_) { return normalize({}, list); } }
  function payload(state, version) {
    return { service: "hr-portal-survey", schema: 1, version: version, submissionId: state.submissionId, respondent: state.respondent, answers: state.answers, comments: state.comments, website: "" };
  }
  function content(state) { return JSON.stringify({ respondent: state.respondent, answers: state.answers, comments: state.comments }); }
  function prepareAttempt(state, cryptoApi) {
    var normalizedContent = content(state);
    var id = state.submissionId;
    if (!id || (state.lastSubmittedContent && state.lastSubmittedContent !== normalizedContent)) id = uuid(cryptoApi);
    return Object.assign({}, state, { submissionId: id, lastSubmittedContent: normalizedContent });
  }
  function failureMessage(result) {
    var messages = {
      BAD_REQUEST: "Сервис не принял формат ответов. Скопируйте ответы кнопкой ниже и сообщите организатору.",
      SCHEMA_MISMATCH: "В таблице изменились настройки приёма. Скопируйте ответы и сообщите организатору; повтор сейчас не поможет.",
      BUSY: "Сервис занят сохранением других ответов. Повторите отправку через минуту.",
      SAVE_FAILED: "Google-таблица временно не приняла запись. Повторите отправку; если ошибка повторяется, скопируйте ответы и сообщите организатору.",
      ID_CONFLICT: "Этот номер уже сохранён с другим содержимым. Скопируйте ответы и сообщите организатору."
    };
    return result && Object.prototype.hasOwnProperty.call(messages, result.error) ? messages[result.error] : "Сервис не подтвердил сохранение. Повторите отправку с теми же ответами позже.";
  }
  function confirmed(result, id) { return !!result && result.ok === true && result.service === "hr-portal-survey" && result.submissionId === id; }
  function summary(state, list) {
    var lines = ["Уточнения УРП", "Подразделение: " + state.respondent.team, "Роль: " + state.respondent.role, "Контакт: " + state.respondent.contact, ""];
    list.forEach(function (q) { var a = state.answers[q.id]; lines.push(q.code + ". " + q.title, "Статус: " + (statuses[a.status] || "Не выбран"), a.text || "Без пояснения", a.link ? "Материал: " + a.link : "", ""); });
    lines.push("Дополнительно: " + state.comments);
    return lines.join("\n");
  }
  return { key: key, maxPayloadLength: maxPayloadLength, statuses: statuses, questions: questions, str: str, validLink: validLink, fileUrl: fileUrl, answerComplete: answerComplete, normalize: normalize, validate: validate, uuid: uuid, storage: storage, draft: draft, payload: payload, content: content, prepareAttempt: prepareAttempt, failureMessage: failureMessage, confirmed: confirmed, summary: summary };
});
