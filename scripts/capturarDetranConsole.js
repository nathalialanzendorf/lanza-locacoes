/*
 * CAPTURA DETRAN (resiliente a reload) — cole no Console do navegador (F12),
 * na aba onde você está LOGADO no portal do DETRAN, e tecle Enter.
 *
 * Os tickets são salvos no localStorage, então SOBREVIVEM a recarregamentos da
 * página. Se a página recarregar, basta colar o script de novo (ele restaura o
 * que já foi capturado e continua acumulando).
 *
 * Fluxo: cole → consulte as placas → rode  baixarDetran()  → cole o arquivo no chat.
 */
(() => {
  const HOST = "backend.detran.sc.gov.br";
  const LS_KEY = "__detranCapture";

  const carregar = () => {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return { auth: null, empresa: null, appVersion: null, tickets: [] };
  };

  const out = carregar();
  window.__detranOut = out;
  let lastPlaca = "";

  const salvar = () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch (e) {}
  };
  const mostrar = () =>
    console.log("%cDETRAN", "color:#0a0;font-weight:bold", "tickets:", out.tickets.length, out);

  const pick = (h, n) => {
    if (!h) return undefined;
    n = n.toLowerCase();
    if (typeof Headers !== "undefined" && h instanceof Headers) {
      for (const [k, v] of h) if (k.toLowerCase() === n) return v;
      return undefined;
    }
    if (Array.isArray(h)) {
      for (const [k, v] of h) if (String(k).toLowerCase() === n) return v;
      return undefined;
    }
    for (const k in h) if (k.toLowerCase() === n) return h[k];
    return undefined;
  };

  const tratar = (url, h) => {
    if (!url || !url.includes(HOST)) return;
    const a = pick(h, "authorization");
    if (a && /bearer/i.test(a)) {
      out.auth = a;
      out.empresa = pick(h, "x-empresa") || out.empresa;
      out.appVersion = pick(h, "x-app-version") || out.appVersion;
      salvar();
    }
    const r = url.match(/requisitar-consulta\?(?:[^]*?&)?p=([A-Za-z0-9-]+)/);
    if (r) lastPlaca = r[1].toUpperCase();
    const m = url.match(/resposta-consulta\?t=([0-9a-fA-F-]{36})/);
    if (m && !out.tickets.some((t) => t.ticket === m[1])) {
      out.tickets.push({ placa: lastPlaca || "?", ticket: m[1] });
      salvar();
      console.log("%c+ ticket", "color:#06c", lastPlaca || "?", m[1], "(total " + out.tickets.length + ")");
    }
  };

  const fo = window.fetch;
  window.fetch = function (i, init) {
    try {
      const u = typeof i === "string" ? i : i && i.url;
      tratar(u, (init && init.headers) || (i && i.headers));
    } catch (e) {}
    return fo.apply(this, arguments);
  };
  const xo = XMLHttpRequest.prototype.open,
    xs = XMLHttpRequest.prototype.setRequestHeader,
    xse = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__url = u;
    this.__h = {};
    return xo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      this.__h[k] = v;
    } catch (e) {}
    return xs.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      tratar(this.__url, this.__h);
    } catch (e) {}
    return xse.apply(this, arguments);
  };

  // Token de fallback (alguns portais guardam o JWT no storage)
  try {
    const scan = (s) => {
      for (let i = 0; i < s.length; i++) {
        const v = s.getItem(s.key(i)) || "";
        const mm = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
        if (mm && !out.auth) {
          out.auth = "Bearer " + mm[0];
          salvar();
        }
      }
    };
    scan(localStorage);
    scan(sessionStorage);
  } catch (e) {}

  window.baixarDetran = () => {
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "detran_tickets.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log("%cBAIXADO detran_tickets.json com " + out.tickets.length + " tickets.", "color:#0a0;font-weight:bold");
  };
  window.limparDetran = () => {
    localStorage.removeItem(LS_KEY);
    console.log("captura limpa");
  };

  // Busca os payloads AGORA (no navegador) e baixa o dado completo. Imune à
  // expiração/uso-único do ticket, pois consome cada ticket uma vez e salva o
  // resultado. Sem credentials:include (evita bloqueio de CORS do backend).
  window.baixarDetranData = async () => {
    const base = "https://backend.detran.sc.gov.br/transito-api/veiculo/resposta-consulta?t=";
    const headers = {
      Accept: "application/json, text/plain, */*",
      Authorization: out.auth,
      "X-Empresa": out.empresa,
      "X-App-Version": out.appVersion,
    };
    const seen = new Set();
    const dados = [];
    for (const t of out.tickets) {
      if (seen.has(t.ticket)) continue;
      seen.add(t.ticket);
      try {
        const r = await fetch(base + encodeURIComponent(t.ticket), { headers });
        const j = await r.json();
        dados.push({ status: r.status, payload: j });
        console.log(r.status, (j && (j.placa || (j.data && j.data.placa))) || "?");
      } catch (e) {
        dados.push({ erro: String(e) });
        console.log("ERR", String(e));
      }
    }
    window.__detranData = dados;
    const b = new Blob([JSON.stringify(dados, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "detran_data.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log("%cBAIXADO detran_data.json com " + dados.length + " payloads", "color:#0a0;font-weight:bold");
  };

  console.log(
    "%cCAPTURA DETRAN ATIVA (sobrevive a reload). Consulte as placas; depois rode baixarDetran().",
    "color:#06c;font-weight:bold",
  );
  mostrar();
})();
