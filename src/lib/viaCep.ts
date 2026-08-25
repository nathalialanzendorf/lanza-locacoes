export type ViaCepResult = {
  cep: string;
  logradouro: string;
  complemento: string;
  bairro: string;
  localidade: string;
  uf: string;
  ibge?: string;
  gia?: string;
  ddd?: string;
  siafi?: string;
  erro?: boolean;
};

export function cepDigitos(cep: string): string {
  return String(cep ?? "").replace(/\D/g, "").slice(0, 8);
}

export function formatarCep(cep: string): string {
  const d = cepDigitos(cep);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : String(cep ?? "").trim();
}

export function cepValido(cep: string): boolean {
  return cepDigitos(cep).length === 8;
}

export async function consultarViaCep(cep: string): Promise<ViaCepResult> {
  const digits = cepDigitos(cep);
  if (digits.length !== 8) {
    throw new Error("CEP inválido");
  }

  const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error("Falha ao consultar ViaCEP");
  }

  const data = (await res.json()) as ViaCepResult;
  if (data.erro) {
    throw new Error("CEP não encontrado");
  }

  return {
    ...data,
    cep: formatarCep(data.cep || digits),
  };
}
