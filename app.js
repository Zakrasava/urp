(function () {
  "use strict";
  var C = window.HRSurveyCore, DATA = window.HR_SURVEY_DATA, CONFIG = window.HR_SURVEY_CONFIG || {};
  var list = C.questions(DATA), store = C.storage(function () { return window.localStorage; });
  var form = document.getElementById("survey"), sending = false, savedPayload = null, validated = false;
  function el(tag, cls, text) { var node = document.createElement(tag); if (cls) node.className = cls; if (text) node.textContent = text; return node; }
  function byId(id) { return document.getElementById(id); }
  function labelledError(id, message) {
    var input = byId(id), target = byId(id + "-error");
    if (target) target.textContent = message || "";
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }
  function source(doc) {
    var row = el("div", "source-row");
    var link = el("a", "source-link", doc.title); link.href = C.fileUrl(doc.path); link.title = doc.file; row.append(link);
    var button = el("button", "source-copy", "Копировать путь"); button.type = "button";
    button.setAttribute("aria-label", "Копировать путь: " + doc.title);
    button.addEventListener("click", function () { copy(doc.path, button); }); row.append(button);
    return row;
  }
  DATA.accepted.forEach(function (text) { byId("accepted-list").append(el("li", "", text)); });
  DATA.sections.forEach(function (section, i) {
    var nav = el("a", "", (i + 1) + ". " + ["Публикации", "ЛНА", "Заявления", "Справочник", "Материалы"][i]); nav.href = "#" + section.id; byId("section-nav").append(nav);
    var block = el("section", "block section"); block.id = section.id; block.setAttribute("aria-labelledby", section.id + "-title");
    var title = el("h2", "block-title", section.title); title.id = section.id + "-title"; block.append(title, el("p", "section-description", section.description));
    section.questions.forEach(function (q) {
      var field = el("fieldset", "q"); field.id = q.id;
      var legend = el("legend", "q-label"); legend.append(el("span", "q-num", q.code), el("span", "", q.title)); field.append(legend);
      var body = el("div", "q-body"); var description = el("p", "question-text", q.body); description.id = q.id + "-description"; body.append(description);
      var guidance = el("p", "guidance"); guidance.append(el("strong", "", "Что указать: "), document.createTextNode(q.requested)); body.append(guidance);
      var example = el("details", "example"); example.append(el("summary", "", "Посмотреть пример ответа"), el("p", "", q.example)); body.append(example);
      var materials = el("details", "sources"); materials.append(el("summary", "", "Исходные документы и основание"), el("p", "source-reference", q.reference));
      q.documents.forEach(function (id) { materials.append(source(DATA.documents[id])); });
      materials.append(el("p", "small", "Ссылка доступна в корпоративной сети. Если не открылась, скопируйте путь и вставьте его в адресную строку Проводника Windows.")); body.append(materials);
      var statusLabel = el("label", "", "Статус вопроса *"); statusLabel.htmlFor = q.id + "-status";
      var select = el("select"); select.id = q.id + "-status"; select.required = true;
      var placeholder = el("option", "", "Выберите статус"); placeholder.value = ""; select.append(placeholder);
      Object.keys(C.statuses).forEach(function (key) { var o = el("option", "", C.statuses[key]); o.value = key; select.append(o); });
      var statusError = el("p", "field-error"); statusError.id = select.id + "-error"; select.setAttribute("aria-describedby", statusError.id);
      var label = el("label", "", "Ответ или пояснение"); label.htmlFor = q.id + "-text";
      var textarea = el("textarea"); textarea.id = q.id + "-text"; textarea.maxLength = 5000;
      textarea.placeholder = "Опишите правило, ответственных и исключения. Если решения нет — напишите, что нужно уточнить и у кого.";
      var textError = el("p", "field-error"); textError.id = textarea.id + "-error"; textarea.setAttribute("aria-describedby", q.id + "-description " + textError.id);
      var linkLabel = el("label", "optional-label", "Ссылка или сетевой путь к материалу — необязательно"); linkLabel.htmlFor = q.id + "-link";
      var input = el("input"); input.type = "text"; input.id = q.id + "-link"; input.maxLength = 1500; input.placeholder = String.raw`https://… или \\сервер\папка\файл`;
      var linkError = el("p", "field-error"); linkError.id = input.id + "-error"; input.setAttribute("aria-describedby", linkError.id);
      body.append(statusLabel, select, statusError, label, textarea, textError, linkLabel, input, linkError); field.append(body); block.append(field);
    });
    byId("questions").append(block);
  });
  ["team", "role", "contact", "comments"].forEach(function (id) { byId(id).setAttribute("aria-describedby", id + "-error"); });
  var rawDraft = store.read(), initial = C.draft(rawDraft, list), state = initial;
  if (initial.submissionId && !initial.lastSubmittedContent) initial.lastSubmittedContent = C.content(initial);
  function apply(data) {
    ["team", "role", "contact"].forEach(function (key) { byId(key).value = data.respondent[key]; }); byId("comments").value = data.comments;
    list.forEach(function (q) { ["status", "text", "link"].forEach(function (key) { byId(q.id + "-" + key).value = data.answers[q.id][key]; }); });
  }
  function collect() {
    var answers = {};
    list.forEach(function (q) { answers[q.id] = { status: byId(q.id + "-status").value, text: byId(q.id + "-text").value, link: byId(q.id + "-link").value }; });
    return C.normalize({ respondent: { team: byId("team").value, role: byId("role").value, contact: byId("contact").value }, answers: answers, comments: byId("comments").value, submissionId: state.submissionId, lastSubmittedContent: state.lastSubmittedContent }, list);
  }
  function progress() {
    var count = list.filter(function (q) { return C.answerComplete(state.answers[q.id]); }).length;
    byId("counter").textContent = "Отмечено " + count + " из " + list.length; byId("progress").value = count;
    list.forEach(function (q) { byId(q.id + "-text").required = state.answers[q.id].status === "ready"; });
  }
  function save() {
    var ok = store.write(JSON.stringify(state));
    byId("draft-state").textContent = ok ? "Черновик сохранён в этом браузере" : "После закрытия страницы черновик не сохранится. Скопируйте ответы перед выходом.";
    byId("draft-state").classList.toggle("storage-warning", !ok);
  }
  function showValidation(focus) {
    var errors = C.validate(state, list), ids = ["team", "role", "contact", "comments"];
    list.forEach(function (q) { ["status", "text", "link"].forEach(function (key) { ids.push(q.id + "-" + key); }); });
    ids.forEach(function (id) { labelledError(id, errors[id]); });
    var summary = byId("validation-summary"), keys = Object.keys(errors); summary.replaceChildren(); summary.hidden = !keys.length;
    if (keys.length) {
      summary.append(el("p", "panel-title", "Проверьте отмеченные поля"));
      var link = el("a", "", "Перейти к первому полю с ошибкой"); link.href = "#" + keys[0]; summary.append(link);
      link.addEventListener("click", function (e) { e.preventDefault(); byId(keys[0]).focus(); });
      if (focus) { byId(keys[0]).focus(); byId(keys[0]).scrollIntoView({ block: "center" }); }
    }
    return !keys.length;
  }
  apply(initial); progress();
  if (rawDraft) byId("draft-state").textContent = "Черновик восстановлен. Можно продолжить.";
  if (!store.available()) byId("draft-state").textContent = "Хранилище браузера недоступно. Перед выходом скопируйте ответы.";
  form.addEventListener("input", changed); form.addEventListener("change", changed);
  function changed() {
    if (sending) return;
    state = collect();
    progress(); save(); if (validated) showValidation(false);
  }
  async function copy(text, button) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text); byId("action-status").textContent = "Скопировано.";
      if (button) { var old = button.textContent; button.textContent = "Скопировано"; setTimeout(function () { button.textContent = old; }, 1800); }
    } catch (_) {
      byId("copy-fallback").hidden = false; byId("copy-text").value = text; byId("copy-text").focus(); byId("copy-text").select();
      byId("action-status").textContent = "Браузер запретил копирование. Скопируйте выделенный текст вручную.";
    }
  }
  byId("copy-answers").addEventListener("click", function () { state = collect(); copy(C.summary(state, list)); });
  function reset() {
    store.clear(); state = C.normalize({}, list); apply(state); validated = false; sending = false; savedPayload = null;
    ["validation-summary", "send-error", "clear-confirm", "copy-fallback", "success"].forEach(function (id) { byId(id).hidden = true; });
    document.querySelectorAll(".field-error").forEach(function (n) { n.textContent = ""; });
    document.querySelectorAll('[aria-invalid="true"]').forEach(function (n) { n.setAttribute("aria-invalid", "false"); });
    form.hidden = false; progress(); byId("draft-state").textContent = "Черновик очищен"; byId("action-status").textContent = "";
  }
  byId("clear-draft").addEventListener("click", function () { byId("clear-confirm").hidden = false; byId("clear-yes").focus(); });
  byId("clear-yes").addEventListener("click", function () { reset(); byId("team").focus(); });
  byId("clear-no").addEventListener("click", function () { byId("clear-confirm").hidden = true; byId("clear-draft").focus(); });
  byId("new-response").addEventListener("click", function () { reset(); byId("team").focus(); });
  function controls(disabled) {
    form.querySelectorAll("input,textarea,select,button").forEach(function (n) { n.disabled = disabled; });
    form.classList.toggle("sending", disabled); form.setAttribute("aria-busy", String(disabled)); byId("send").textContent = disabled ? "Сохраняем ответы…" : "Отправить ответы";
  }
  async function submit(event) {
    if (event) event.preventDefault(); if (sending) return;
    state = collect(); validated = true; if (!showValidation(true)) return;
    byId("send-error").hidden = true; byId("action-status").textContent = "";
    var controller = new AbortController(), timeout;
    try {
      if (byId("website").value) throw new Error("Проверьте заполнение формы.");
      if (!CONFIG.endpoint) throw new Error("Приёмник ещё не настроен. Скопируйте ответы и сообщите организатору.");
      if (!navigator.onLine) throw new Error("Нет подключения к Интернету. После восстановления сети повторите отправку.");
      state = C.prepareAttempt(state, window.crypto);
      savedPayload = C.payload(state, CONFIG.version);
      var serialized = JSON.stringify(savedPayload);
      if (serialized.length > C.maxPayloadLength) throw new Error("Объём ответов слишком большой для одной отправки. Скопируйте ответы и сократите длинные поля или ссылки.");
      save(); sending = true; controls(true); timeout = setTimeout(function () { controller.abort(); }, CONFIG.timeoutMs || 30000);
      var response = await fetch(CONFIG.endpoint, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: serialized, signal: controller.signal });
      if (!response.ok) throw new Error("Сервис сохранения временно недоступен. Попробуйте ещё раз.");
      var result;
      try { result = await response.json(); } catch (_) { throw new Error("Сервис вернул ответ без подтверждения. Повторите отправку с теми же ответами."); }
      if (!C.confirmed(result, savedPayload.submissionId)) throw new Error(C.failureMessage(result));
      store.clear(); form.hidden = true; byId("success").hidden = false; byId("receipt").textContent = "Номер ответа: " + savedPayload.submissionId; byId("draft-state").textContent = "Ответы сохранены в таблице"; byId("success").focus();
    } catch (error) {
      var message = error.name === "AbortError" ? "Сервис не ответил вовремя. Ответы могли сохраниться: повторите отправку, система проверит номер ответа." : error instanceof TypeError ? "Не удалось связаться с Google-таблицей. Проверьте подключение или повторите позже." : error.message;
      byId("send-error-text").textContent = message; byId("send-error").hidden = false; byId("send-error").focus();
    } finally { clearTimeout(timeout); sending = false; controls(false); }
  }
  form.addEventListener("submit", submit); byId("retry").addEventListener("click", submit);
})();
