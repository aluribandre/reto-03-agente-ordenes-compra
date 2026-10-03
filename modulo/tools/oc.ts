// Las mismas 5 tools que usa la aplicación (src/tools/oc.ts), importables sin el servidor (PRD 9.4).
// No es una copia: cada tool conserva su `description`, sus `args` (los mismos esquemas zod) y su
// `execute`. Este archivo solo adapta el contexto mínimo de otras plataformas ({ directory, sessionId })
// al contexto de la aplicación (turno y reloj). El nombre que ve el modelo es oc_<export>.
import { crearReloj } from "../../src/config"
import type { Autorizacion } from "../../src/schemas"
import * as app from "../../src/tools/oc"
import type { ContextoTool, Herramienta } from "../../src/tools/runner"

// Contexto que entrega la plataforma anfitriona. `autorizacion` solo debe ponerla un runtime de
// confirmación humana del anfitrión, nunca el modelo; sin ella, las OC que requieren confirmación no se crean.
export type ContextoPlataforma = {
  directory: string
  sessionId: string
  turnoId?: string
  autorizacion?: Autorizacion
}

function contexto(ctx: ContextoPlataforma): ContextoTool {
  const base: ContextoTool = { directory: ctx.directory, sessionId: ctx.sessionId, turnoId: ctx.turnoId ?? `${ctx.sessionId}:modulo`, reloj: crearReloj() }
  return ctx.autorizacion === undefined ? base : { ...base, autorizacion: ctx.autorizacion }
}

function empaquetar<A>(h: Herramienta<A>) {
  return {
    description: h.description,
    args: h.args,
    execute: (args: A, ctx: ContextoPlataforma): Promise<string> => h.execute(args, contexto(ctx)),
  }
}

export const leer_paquete = empaquetar(app.leer_paquete)
export const validar = empaquetar(app.validar)
export const generar_evidencia = empaquetar(app.generar_evidencia)
export const construir_payload = empaquetar(app.construir_payload)
export const crear = empaquetar(app.crear)
