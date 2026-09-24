import { iniciarBanco } from "../db";
import { criarUsuario, buscarUsuarioPorNome } from "../auth";

async function main() {
  await iniciarBanco();

  const [, , usuario, senha] = process.argv;

  if (!usuario || !senha) {
    console.error("Uso: npm run criar-usuario -- <usuario> <senha>");
    process.exit(1);
  }

  if (senha.length < 8) {
    console.error("A senha deve ter pelo menos 8 caracteres.");
    process.exit(1);
  }

  if (buscarUsuarioPorNome(usuario)) {
    console.error(`Já existe um usuário com o nome "${usuario}".`);
    process.exit(1);
  }

  const registro = await criarUsuario(usuario, senha);
  console.log(`Usuário criado: ${registro.usuario} (id: ${registro.id})`);
}

main();
