import { Client as NTPClient } from "ntp-time";

/** Obtem o horario correto (UTC) de um servidor NTP publico. */
export async function obterHorarioReferencia(servidor: string): Promise<Date> {
  const client = new NTPClient(servidor, 123, { timeout: 5000 });
  const pacote = await client.syncTime();
  return pacote.time;
}
