let auditoriaEmAndamento = false;

export function definirAuditoriaEmAndamento(valor: boolean): void {
  auditoriaEmAndamento = valor;
}

export function isAuditoriaEmAndamento(): boolean {
  return auditoriaEmAndamento;
}
