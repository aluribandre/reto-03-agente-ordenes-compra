// Sesiones en memoria (no se persisten a disco). Solo lo necesario para continuar el contexto.
import type { Mensaje, Uso } from "../llm/adapter"
import type { Autorizacion } from "../schemas"
import { actorDeSesion, type PendienteConfirmacion } from "./autorizacion"

// Llamada a tool visible en el chat (CA4): nombre, argumentos y resultado resumido.
export type EventoTool = {
  turno_id: string
  herramienta: string
  argumentos: unknown
  ok: boolean
  codigo_error: string | null
  resumen: string
}

export type ErrorSesion = { turno_id: string; tipo: string; mensaje: string }

export type Sesion = {
  id: string
  // Historial que se envía al modelo (append-only).
  mensajes: Mensaje[]
  eventos: EventoTool[]
  // Tokens facturables acumulados en la sesión (suma de `usage` de cada llamada al modelo).
  tokens: Uso & { total: number }
  iteraciones: number
  turnos: number
  turnoId: string | null
  ultimoError: ErrorSesion | null
  // Identidad de sesión (no autenticada).
  actor: string
  // Como máximo un pendiente; solo vale para el turno siguiente.
  pendiente: PendienteConfirmacion | null
  // Autorización del turno en curso (un solo uso); se descarta al empezar el turno siguiente.
  autorizacion: Autorizacion | null
}

export function crearSesion(id: string): Sesion {
  return {
    id,
    actor: actorDeSesion(id),
    pendiente: null,
    autorizacion: null,
    mensajes: [],
    eventos: [],
    tokens: { entrada: 0, salida: 0, cacheEscritura: 0, cacheLectura: 0, total: 0 },
    iteraciones: 0,
    turnos: 0,
    turnoId: null,
    ultimoError: null,
  }
}

export class AlmacenSesiones {
  readonly #sesiones = new Map<string, Sesion>()

  obtener(id: string): Sesion | undefined {
    return this.#sesiones.get(id)
  }

  obtenerOCrear(id: string): Sesion {
    const existente = this.#sesiones.get(id)
    if (existente !== undefined) return existente
    const nueva = crearSesion(id)
    this.#sesiones.set(id, nueva)
    return nueva
  }
}
