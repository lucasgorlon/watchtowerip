import { Jimp } from "jimp";
import { Limites } from "./types";

export interface ResultadoImagem {
  nitidez: number;
  brilho: number;
  status: string; // "OK" ou lista de problemas separados por " | "
}

/**
 * Calcula a variancia do filtro Laplaciano (medida de nitidez) e o brilho
 * medio de uma imagem JPEG. Valores baixos de nitidez indicam imagem
 * borrada/desfocada (ex: lente suja, fora de foco, embacada).
 */
export async function analisarImagem(buffer: Buffer, limites: Limites): Promise<ResultadoImagem> {
  const imagem = await Jimp.read(buffer);
  imagem.greyscale();

  const largura = imagem.bitmap.width;
  const altura = imagem.bitmap.height;
  const dados = imagem.bitmap.data; // RGBA, 4 bytes por pixel

  // Extrai um array de intensidade (0-255) por pixel
  const total = largura * altura;
  const intensidade = new Float64Array(total);
  let somaBrilho = 0;
  for (let i = 0; i < total; i++) {
    const v = dados[i * 4]; // R = G = B apos greyscale
    intensidade[i] = v;
    somaBrilho += v;
  }
  const brilho = somaBrilho / total;

  // Convolucao com kernel Laplaciano 3x3: [[0,1,0],[1,-4,1],[0,1,0]]
  const laplaciano = new Float64Array(total);
  for (let y = 1; y < altura - 1; y++) {
    for (let x = 1; x < largura - 1; x++) {
      const idx = y * largura + x;
      const valor =
        intensidade[idx - largura] + // cima
        intensidade[idx + largura] + // baixo
        intensidade[idx - 1] + // esquerda
        intensidade[idx + 1] - // direita
        4 * intensidade[idx];
      laplaciano[idx] = valor;
    }
  }

  // Variancia do resultado do Laplaciano
  let soma = 0;
  let somaQuad = 0;
  const n = total;
  for (let i = 0; i < n; i++) {
    soma += laplaciano[i];
    somaQuad += laplaciano[i] * laplaciano[i];
  }
  const media = soma / n;
  const nitidez = somaQuad / n - media * media;

  const problemas: string[] = [];
  if (nitidez < limites.nitidezLaplaciano) problemas.push("possivel lente suja/desfocada");
  if (brilho < limites.brilhoMinimo) problemas.push("imagem escura demais");
  if (brilho > limites.brilhoMaximo) problemas.push("imagem estourada/clara demais");

  return {
    nitidez: Math.round(nitidez * 10) / 10,
    brilho: Math.round(brilho * 10) / 10,
    status: problemas.length === 0 ? "OK" : problemas.join(" | ").toUpperCase(),
  };
}
