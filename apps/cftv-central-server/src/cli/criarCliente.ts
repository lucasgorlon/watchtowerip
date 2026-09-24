import { iniciarBanco } from "../db";
import { criarCliente } from "../clientesRepo";

async function main() {
  await iniciarBanco();

  const [, , nome] = process.argv;

  if (!nome) {
    console.error("Uso: npm run criar-cliente -- <nome-do-cliente>");
    process.exit(1);
  }

  const cliente = await criarCliente(nome);
  console.log(`Cliente criado: ${cliente.nome} (id: ${cliente.id})`);
  console.log(`API key (copie para o app local desse site, em Configurações → Servidor central):`);
  console.log(cliente.apiKey);
}

main();
