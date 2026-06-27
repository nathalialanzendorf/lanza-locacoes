/**
 * Script injetado no Chrome real (via CDP) para o solver do DETRAN SC.
 *
 * NÃO-INVASIVO: não mexe em `window.turnstile` com defineProperty (a versão
 * antiga quebrava o captcha do portal). Apenas ADICIONA utilitários no window.
 *
 * Descobertas que orientam este hook (do bundle do portal `index-*.js` e dos
 * chunks de cada serviço):
 *   - O portal mina o token assim:
 *       wid = turnstile.render(div, { sitekey, appearance: "execute" });
 *       turnstile.execute(wid, { action, callback, "error-callback", ... });
 *   - O backend VALIDA o `action`. Cada serviço usa um action próprio; o do
 *     dossiê de veículo (infrações + débitos) é "consulta_dossie_veiculo".
 *   - O Turnstile é carregado sob demanda (api.js). Aqui sabemos carregá-lo
 *     sozinhos, então NÃO é preciso o utilizador fazer uma consulta manual.
 *
 * Funções expostas:
 *   - __lanzaEnsureTurnstile()  carrega o api.js se preciso; resolve quando
 *     window.turnstile.{render,execute} existem.
 *   - __lanzaTurnstilePronto()  true se já dá para minar.
 *   - __lanzaMint(sitekey, action)  mina um token fresco (render+execute).
 *   - __lanzaConsulta(opts)     requisitar+resposta na origem do browser.
 *   - __lanzaClick(padroes) / __lanzaHost() / __lanzaScanToken()  auxiliares.
 *
 * Idempotente: pode ser injetado várias vezes.
 */
export const DETRAN_BROWSER_HOOK = String.raw`
(function () {
  if (window.__lanzaHookReady) return;
  window.__lanzaHookReady = true;

  var CF_API = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

  function descobrirSitekey() {
    try {
      var el = document.querySelector("[data-sitekey]");
      if (el) { var sk = el.getAttribute("data-sitekey"); if (sk) return sk; }
    } catch (e) {}
    return null;
  }
  window.__lanzaSitekeyAtual = descobrirSitekey;

  window.__lanzaTurnstilePronto = function () {
    return !!(
      window.turnstile &&
      typeof window.turnstile.render === "function" &&
      typeof window.turnstile.execute === "function"
    );
  };

  // Garante o Turnstile carregado. Se o portal ainda não o carregou (carrega sob
  // demanda), injetamos o api.js nós mesmos (a origem permite, o portal usa-o).
  var _ensure = null;
  window.__lanzaEnsureTurnstile = function () {
    if (window.__lanzaTurnstilePronto()) return Promise.resolve(true);
    if (_ensure) return _ensure;
    _ensure = new Promise(function (resolve, reject) {
      var deadline = Date.now() + 20000;
      var existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
      if (!existing) {
        try {
          var s = document.createElement("script");
          s.src = CF_API;
          s.async = true;
          s.defer = true;
          document.head.appendChild(s);
        } catch (e) {}
      }
      (function poll() {
        if (window.__lanzaTurnstilePronto()) return resolve(true);
        if (Date.now() > deadline) return reject("timeout ao carregar turnstile");
        setTimeout(poll, 150);
      })();
    });
    return _ensure;
  };

  // Mina um token fresco replicando o fluxo do portal (render execute + action).
  window.__lanzaMint = function (sitekey, action) {
    return window.__lanzaEnsureTurnstile().then(function () {
      return new Promise(function (resolve, reject) {
        var sk = sitekey || descobrirSitekey();
        if (!window.turnstile || !window.turnstile.render || !window.turnstile.execute) {
          return reject("turnstile indisponível");
        }
        if (!sk) return reject("sitekey não descoberto");
        var div = document.createElement("div");
        div.style.display = "none";
        document.body.appendChild(div);
        var done = false;
        var wid;
        function finish(fn, val) {
          if (done) return;
          done = true;
          clearTimeout(to);
          try { if (wid != null && window.turnstile.remove) window.turnstile.remove(wid); } catch (e) {}
          try { div.remove(); } catch (e) {}
          fn(val);
        }
        var to = setTimeout(function () { finish(reject, "timeout ao minar token"); }, 30000);
        try {
          wid = window.turnstile.render(div, { sitekey: sk, appearance: "execute" });
          window.turnstile.execute(wid, {
            action: action || "",
            callback: function (token) { finish(resolve, token); },
            "error-callback": function (c) { finish(reject, "error-callback " + c); },
            "expired-callback": function () { finish(reject, "expired-callback"); },
          });
        } catch (e) {
          finish(reject, String(e));
        }
      });
    });
  };

  function temPayload(o) {
    if (!o || typeof o !== "object") return false;
    // pendente:true = consulta ainda PROCESSANDO (resposta-consulta devolve
    // {placa,pendente:true,...} enquanto monta o dossiê). NÃO é o payload final.
    if (o.pendente === true) return false;
    return !!(
      Array.isArray(o.infracoes) || Array.isArray(o.historicoInfracoes) ||
      Array.isArray(o.debitos) || o.placa != null
    );
  }
  function msgErro(raw) {
    function f(o) {
      if (!o || typeof o !== "object") return null;
      var ks = ["mensagemUsuario", "mensagem", "message", "erro", "error"];
      for (var i = 0; i < ks.length; i++) {
        var v = o[ks[i]];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    }
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) { var m = f(raw[i]); if (m) return m; }
      return null;
    }
    return f(raw);
  }
  function pickTicket(raw) {
    if (typeof raw === "string") {
      var s = raw.trim().replace(/^"|"$/g, "");
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
    }
    if (raw && typeof raw === "object") {
      var ks = ["t", "ticket", "uuid", "id", "protocolo", "token"];
      for (var i = 0; i < ks.length; i++) {
        var v = raw[ks[i]];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      var nest = ["data", "resultado", "payload", "content"];
      for (var j = 0; j < nest.length; j++) {
        var t = pickTicket(raw[nest[j]]);
        if (t) return t;
      }
    }
    return null;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Faz a consulta inteira (requisitar + poll resposta) na origem do browser.
  window.__lanzaConsulta = async function (opts) {
    var base = "https://backend.detran.sc.gov.br/transito-api";
    var headers = { Accept: "application/json, text/plain, */*" };
    if (opts.auth) headers["Authorization"] = opts.auth;
    if (opts.empresa) headers["X-Empresa"] = opts.empresa;
    if (opts.appVersion) headers["X-App-Version"] = opts.appVersion;

    var reqUrl = base + "/veiculo/requisitar-consulta?p=" +
      encodeURIComponent(opts.placa) + "&r=" + encodeURIComponent(opts.renavam) +
      "&c=" + (opts.captcha || "") + "&v=";

    var r1 = await fetch(reqUrl, { headers: headers });
    var tx1 = await r1.text();
    var j1; try { j1 = JSON.parse(tx1); } catch (e) { j1 = tx1; }

    if (r1.ok && temPayload(j1)) return { status: "ok", payload: j1 };

    var em = msgErro(j1);
    var ticket = pickTicket(j1);
    if (!ticket) {
      return { status: "erro", message: em || ("requisitar-consulta HTTP " + r1.status), body: String(tx1).slice(0, 300) };
    }

    var respUrl = base + "/veiculo/resposta-consulta?t=" + encodeURIComponent(ticket);
    // ~40s de janela: o dossiê pode levar vários segundos a ficar pronto
    // (resposta devolve {pendente:true} enquanto monta).
    var delays = [600, 1000, 1500, 2000, 2500, 3000, 3000, 3500, 4000, 4000, 5000, 5000];
    var ultimo = null;
    for (var i = 0; i < delays.length; i++) {
      var r2 = await fetch(respUrl, { headers: headers });
      if (r2.status === 202 || r2.status === 204) { await sleep(delays[i]); continue; }
      var tx2 = await r2.text();
      var j2; try { j2 = JSON.parse(tx2); } catch (e) { j2 = tx2; }
      ultimo = j2;
      if (temPayload(j2)) return { status: "ok", payload: j2, ticket: ticket };
      var pend = j2 && typeof j2 === "object" &&
        (j2.pendente === true || /process|pendente|aguard/i.test(String(j2.status || j2.situacao || "")));
      if (pend) { await sleep(delays[i]); continue; }
      // não-pendente e sem payload reconhecível: devolve o que veio.
      return { status: "ok", payload: j2, ticket: ticket };
    }
    return { status: "erro", message: "timeout resposta-consulta (ainda pendente)", ticket: ticket, payload: ultimo };
  };

  // Clica no primeiro elemento (link/botão) cujo texto bata com algum padrão.
  window.__lanzaClick = function (padroes) {
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

  window.__lanzaHost = function () { return location.host; };

  window.__lanzaScanToken = function () {
    function scan(s) {
      try {
        for (var i = 0; i < s.length; i++) {
          var v = s.getItem(s.key(i)) || "";
          var m = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
          if (m) return m[0];
        }
      } catch (e) {}
      return null;
    }
    return scan(window.localStorage) || scan(window.sessionStorage) || null;
  };
})();
`;
