# -*- coding: utf-8 -*-
"""
Integração com o rastreame.com.br (cadastro de motorista).

Token: lido da variável de ambiente RASTREAME_AUTH (header X-r2f-auth).
O token é um JWT da sessão do navegador e EXPIRA — se der 401/403, obter um
novo no DevTools (aba Network, qualquer request → header x-r2f-auth).

Uso:
    python rastreame.py check <cnh> ["nome"]      # diz se já está cadastrado
    python rastreame.py add <cliente.json>        # cadastra a partir do cliente local
"""
import sys, os, re, json, base64, urllib.request, urllib.error

ORIGIN = "https://rastreame.com.br"
BASE = ORIGIN + "/keek/rest/motorista"
LOGIN_URL = ORIGIN + "/auth/rest/login/v2/keek/America@Recife"

_token_cache = None

def _login():
    """Autentica com RASTREAME_LOGIN/RASTREAME_SENHA e devolve o accessToken.
    O separador do header authorization é o literal '&#58;' (assim está no app)."""
    lg = os.environ.get("RASTREAME_LOGIN")
    sn = os.environ.get("RASTREAME_SENHA")
    if not (lg and sn):
        return None
    authz = base64.b64encode(f"{lg}&#58;{sn}&#58;{ORIGIN}".encode("utf-8")).decode()
    req = urllib.request.Request(LOGIN_URL, data=b"", method="POST", headers={
        "Content-Type": "application/json", "Content-Length": "0",
        "authorization": authz, "Origin": ORIGIN, "Referer": ORIGIN + "/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/149.0.0.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode("utf-8"))
        return d.get("accessToken")
    except urllib.error.HTTPError as e:
        print(f"ERRO login rastreame [HTTP {e.code}]: {e.read().decode('utf-8')[:200]}")
        return None

def token():
    """Prioriza RASTREAME_AUTH (token manual); senão autentica via login/senha."""
    global _token_cache
    if _token_cache:
        return _token_cache
    t = os.environ.get("RASTREAME_AUTH") or _login()
    if not t:
        print("ERRO: defina RASTREAME_LOGIN + RASTREAME_SENHA (ou RASTREAME_AUTH) nas variáveis de ambiente.")
        sys.exit(2)
    _token_cache = t
    return t

def headers(post=False):
    h = {"Accept": "application/json, text/plain, */*",
         "Content-Type": "application/json",
         "X-r2f-auth": token(), "X-r2f-ns": "null",
         "Referer": "https://rastreame.com.br/",
         "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/149.0.0.0"}
    if post:
        h["Origin"] = "https://rastreame.com.br"
    return h

def _digits(s):
    return re.sub(r"\D", "", s or "")

def listar():
    req = urllib.request.Request(BASE + "?ativo=true&size=2000", headers=headers())
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode("utf-8"))
    return d.get("content", d if isinstance(d, list) else [])

def achar(cnh, nome=""):
    cnh_d = _digits(cnh)
    nome_n = (nome or "").strip().lower()
    for m in listar():
        if cnh_d and _digits(str(m.get("cnh", ""))) == cnh_d:
            return m
        if nome_n and (m.get("nome", "") or "").strip().lower() == nome_n:
            return m
    return None

def br2iso(d):
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", d or "")
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None

def montar_observacao(c):
    cnh = c.get("cnh", {})
    linhas = []
    if c.get("cpf"): linhas.append(f"CPF: {c['cpf']}")
    if c.get("rg"): linhas.append(f"RG: {c['rg']}" + (f" {c['rgOrgaoExpedidor']}" if c.get("rgOrgaoExpedidor") else ""))
    if c.get("dataNascimento"): linhas.append(f"Nascimento: {c['dataNascimento']}" + (f" - {c['localNascimento']}" if c.get("localNascimento") else ""))
    if cnh.get("primeiraHabilitacao"): linhas.append(f"1a Habilitacao: {cnh['primeiraHabilitacao']}")
    if cnh.get("dataEmissao"): linhas.append(f"Emissao CNH: {cnh['dataEmissao']}")
    if cnh.get("numeroEspelho"): linhas.append(f"Espelho: {cnh['numeroEspelho']}")
    if cnh.get("orgaoEmissor") or cnh.get("ufEmissor"): linhas.append(f"Orgao emissor: {cnh.get('orgaoEmissor','')}/{cnh.get('ufEmissor','')}")
    if c.get("filiacao"): linhas.append(f"Filiacao: {c['filiacao']}")
    if c.get("telefone"): linhas.append(f"Telefone: {c['telefone']}")
    end = c.get("endereco") or {}
    if any(end.values()):
        e = f"{end.get('logradouro','')}, {end.get('numero','')} {end.get('bairro','')} - {end.get('cidade','')}/{end.get('uf','')} {end.get('cep','')}"
        linhas.append("Endereco: " + re.sub(r"\s+", " ", e).strip())
    return "\n".join(linhas)

def add(cliente_json):
    c = json.load(open(cliente_json, encoding="utf-8"))
    cnh = c.get("cnh", {})
    ja = achar(cnh.get("numeroRegistro", ""), c.get("nome", ""))
    if ja:
        print(f"JA CADASTRADO no rastreame: {ja.get('nome')} (id {ja.get('id')}) — nada a fazer.")
        return
    payload = {
        "nome": c.get("nome"),
        "cnh": cnh.get("numeroRegistro"),
        "categoriaCnh": {"key": cnh.get("categoria")},
        "observacao": montar_observacao(c),
        "vencimentoCnh": br2iso(cnh.get("validade")),
        "vencimentoToxicologico": None,
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + "/", data=data, headers=headers(post=True), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"CADASTRADO no rastreame [HTTP {r.status}]: {payload['nome']}")
            body = r.read().decode("utf-8")
            print(body[:300])
    except urllib.error.HTTPError as e:
        print(f"ERRO HTTP {e.code} ao cadastrar: {e.read().decode('utf-8')[:300]}")
        if e.code in (401, 403):
            print(">> Token expirado? Atualize RASTREAME_AUTH.")
        sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "check":
        cnh = sys.argv[2] if len(sys.argv) > 2 else ""
        nome = sys.argv[3] if len(sys.argv) > 3 else ""
        m = achar(cnh, nome)
        print(f"JA CADASTRADO: {m.get('nome')} (id {m.get('id')})" if m else "NAO CADASTRADO")
    elif cmd == "add":
        add(sys.argv[2])
    else:
        print(__doc__); sys.exit(2)

if __name__ == "__main__":
    main()
