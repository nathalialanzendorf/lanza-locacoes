import {
  cepDigitos,
  cepValido,
  consultarViaCep,
  formatarCep,
} from "../../../src/lib/viaCep.js";

export async function consultarCep(cep: string) {
  if (!cepValido(cep)) {
    throw new Error("CEP inválido — informe 8 dígitos");
  }
  return consultarViaCep(cepDigitos(cep));
}

export { cepDigitos, cepValido, formatarCep };
