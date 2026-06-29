/**
 * Script injetado no Chrome real (via CDP) para a triagem de locatário.
 *
 * NÃO-INVASIVO: apenas ADICIONA utilitários no `window`. Idempotente (pode ser
 * injetado várias vezes). As consultas que dependem de sessão/captcha são feitas
 * com `fetch` NA ORIGEM da página (cookies/headers de sessão vão automaticamente),
 * tal como o `__lanzaConsulta` do solver do DETRAN SC.
 *
 * Funções expostas:
 *   - __triagemFetch(url, opts)  fetch in-page → { status, ok, body } (texto).
 *   - __triagemPreencher(seletor, valor)  set de input + dispatch de eventos.
 *   - __triagemDigitar(seletor, texto)    simula digitação tecla-a-tecla (máscaras).
 *   - __triagemClick(padroes)    clica no 1º elemento cujo texto bata um regex.
 *   - __triagemRecaptchaOk()     true se o reCAPTCHA já tem token (resolvido).
 *   - __triagemValor(seletor)    lê o value atual de um campo (para conferência).
 *   - __triagemHost()            location.host.
 */
export const TRIAGEM_BROWSER_HOOK = String.raw`
(function () {
  if (window.__triagemHookReady) return;
  window.__triagemHookReady = true;

  // Setter NATIVO de value — Angular/React/PrimeNG só "enxergam" a mudança quando
  // o valor é definido pelo setter do protótipo + um InputEvent real.
  function setNativeValue(el, valor) {
    var proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, valor);
    else el.value = valor;
  }

  // fetch na origem da página (sessão/cookies/captcha já válidos no browser).
  window.__triagemFetch = async function (url, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: opts.headers || {} };
    if (opts.body != null) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    init.credentials = "include";
    try {
      var r = await fetch(url, init);
      var txt = await r.text();
      return { status: r.status, ok: r.ok, body: txt };
    } catch (e) {
      return { status: 0, ok: false, body: "", erro: String(e) };
    }
  };

  // Preenche um input/select e dispara input+change+blur (frameworks reagem).
  window.__triagemPreencher = function (seletor, valor) {
    try {
      var el = typeof seletor === "string" ? document.querySelector(seletor) : seletor;
      if (!el) return false;
      el.focus();
      setNativeValue(el, valor);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  };

  // Digitação tecla-a-tecla — robusto para máscaras (CPF) e date pickers que
  // escutam keydown/keyup, não apenas o value final.
  window.__triagemDigitar = function (seletor, texto) {
    try {
      var el = typeof seletor === "string" ? document.querySelector(seletor) : seletor;
      if (!el) return false;
      el.focus();
      setNativeValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      texto = String(texto);
      for (var i = 0; i < texto.length; i++) {
        var ch = texto[i];
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
        setNativeValue(el, (el.value || "") + ch);
        el.dispatchEvent(new InputEvent("input", { data: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  };

  window.__triagemClick = function (padroes) {
    var res = [];
    for (var i = 0; i < padroes.length; i++) {
      try { res.push(new RegExp(padroes[i], "i")); } catch (e) {}
    }
    var nodes = document.querySelectorAll(
      "a,button,[role=button],input[type=submit],input[type=button],div[onclick],span[onclick]",
    );
    for (var n = 0; n < nodes.length; n++) {
      var el = nodes[n];
      var txt = (el.innerText || el.textContent || el.value ||
        el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      if (!txt) continue;
      for (var j = 0; j < res.length; j++) {
        if (res[j].test(txt)) {
          try { el.scrollIntoView({ block: "center" }); el.click(); return txt.slice(0, 80); } catch (e) {}
        }
      }
    }
    return null;
  };

  // true quando o reCAPTCHA já foi resolvido pelo operador (token presente).
  window.__triagemRecaptchaOk = function () {
    try {
      if (window.grecaptcha && typeof window.grecaptcha.getResponse === "function") {
        try { if ((window.grecaptcha.getResponse() || "").length > 0) return true; } catch (e) {}
      }
    } catch (e) {}
    try {
      var t = document.querySelector("#g-recaptcha-response, textarea[name='g-recaptcha-response']");
      return !!(t && t.value && t.value.length > 0);
    } catch (e) { return false; }
  };

  window.__triagemValor = function (seletor) {
    try {
      var el = document.querySelector(seletor);
      return el ? (el.value != null ? el.value : el.textContent) : null;
    } catch (e) { return null; }
  };

  // Preenche o input cujo RÓTULO (label/placeholder/aria/formcontrolname/texto
  // do container) casa com um regex — robusto p/ forms sem id estável (TJSC).
  window.__triagemPreencherPorRotulo = function (rotuloRe, valor) {
    try {
      var re = new RegExp(rotuloRe, "i");
      var visivel = function (el) { return !!(el.offsetParent || el.getClientRects().length); };
      var inputs = Array.prototype.slice
        .call(document.querySelectorAll("input,textarea"))
        .filter(function (i) {
          var t = (i.type || "text").toLowerCase();
          return t !== "hidden" && t !== "checkbox" && t !== "radio" && visivel(i);
        });
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var rotulo = "";
        if (el.id) {
          var lbl = document.querySelector('label[for="' + el.id + '"]');
          if (lbl) rotulo += " " + (lbl.innerText || "");
        }
        var cont = el.closest("div,span,p-field,mat-form-field,.field,.form-group");
        if (cont) {
          var l2 = cont.querySelector("label");
          if (l2) rotulo += " " + (l2.innerText || "");
        }
        rotulo += " " + (el.getAttribute("placeholder") || "") +
          " " + (el.getAttribute("aria-label") || "") +
          " " + (el.getAttribute("formcontrolname") || "") +
          " " + (el.name || "");
        if (re.test(rotulo)) {
          el.focus();
          setNativeValue(el, valor);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          return { ok: true, rotulo: rotulo.trim().slice(0, 60), valor: el.value };
        }
      }
      return { ok: false };
    } catch (e) { return { ok: false, erro: String(e) }; }
  };

  // Snapshot leve da tela (diagnóstico): textos clicáveis + campos visíveis.
  window.__triagemSnapshot = function () {
    try {
      var visivel = function (el) { return !!(el.offsetParent || el.getClientRects().length); };
      var seen = {};
      var links = [];
      Array.prototype.slice
        .call(document.querySelectorAll("a,button,[role=button],[role=menuitem],[role=tab],li"))
        .forEach(function (e) {
          if (!visivel(e)) return;
          var t = (e.innerText || e.textContent || "").trim().replace(/\s+/g, " ");
          if (t && t.length <= 45 && !seen[t]) { seen[t] = 1; links.push(t); }
        });
      var inputs = Array.prototype.slice
        .call(document.querySelectorAll("input,textarea,select,mat-select,p-dropdown,p-calendar,pf-calendar"))
        .filter(visivel)
        .map(function (i) {
          return {
            tag: i.tagName,
            type: i.getAttribute("type"),
            id: i.id || null,
            name: i.getAttribute("name"),
            fcn: i.getAttribute("formcontrolname"),
            ph: i.getAttribute("placeholder"),
            aria: i.getAttribute("aria-label"),
          };
        });
      return JSON.stringify({
        host: location.host,
        href: location.href,
        title: document.title,
        links: links.slice(0, 70),
        inputs: inputs.slice(0, 45),
      });
    } catch (e) { return JSON.stringify({ erro: String(e) }); }
  };

  window.__triagemHost = function () { return location.host; };
})();
`;
