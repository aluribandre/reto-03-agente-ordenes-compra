// Interfaz neutral al proveedor (PRD 6.1: enviar(mensajes, herramientas) → respuesta).
// El ciclo del agente solo conoce estos tipos; cambiar de proveedor no toca el ciclo.

export type DefinicionTool = {
  nombre: string
  descripcion: string
  // JSON Schema del objeto de argumentos (derivado de los esquemas zod congelados).
  esquema: Record<string, unknown>
}

export type LlamadaTool = { id: string; nombre: string; argumentos: unknown }

export type ResultadoLlamada = { id: string; contenido: string; esError: boolean }

export type Mensaje =
  | { rol: "usuario"; texto: string }
  // `crudo`: contenido del proveedor tal como llegó (incluye bloques opacos, p. ej. de razonamiento).
  // Solo lo interpreta el mismo adaptador, que lo reenvía sin modificar: el historial es append-only.
  | { rol: "asistente"; texto: string; llamadas: LlamadaTool[]; crudo?: unknown }
  | { rol: "resultados"; resultados: ResultadoLlamada[] }

export type MotivoFin = "fin_turno" | "uso_tool" | "max_tokens" | "rechazo" | "pausa" | "limite_contexto" | "otro"

// Tokens facturables informados por el proveedor para UNA llamada.
export type Uso = { entrada: number; salida: number; cacheEscritura: number; cacheLectura: number }

export type RespuestaLlm = {
  texto: string
  llamadas: LlamadaTool[]
  motivo: MotivoFin
  uso: Uso
  crudo: unknown
}

export type TipoErrorLlm = "timeout" | "red" | "autenticacion" | "permiso" | "limite" | "no_disponible" | "peticion_invalida" | "desconocido"

// Error del proveedor ya saneado: el mensaje nunca incluye claves, cabeceras ni cuerpos crudos.
export class ErrorLlm extends Error {
  constructor(
    readonly tipo: TipoErrorLlm,
    mensaje: string,
  ) {
    super(mensaje)
  }
}

export interface LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: readonly Mensaje[], herramientas: readonly DefinicionTool[], sistema: string): Promise<RespuestaLlm>
}

export const totalTokens = (u: Uso): number => u.entrada + u.salida + u.cacheEscritura + u.cacheLectura
