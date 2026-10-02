// Ciclo del agente (PRD 6.3): mensaje → modelo → tools (vía runner) → modelo … → texto final.
// - CA1: tope de iteraciones por turno.  - Presupuesto de tokens por sesión.
// - CA3: la confirmación humana la resuelve el runtime ANTES de llamar al modelo (autorizacion.ts).
// - CA4: cada llamada pasa por el runner (log.jsonl) y queda en los eventos de la sesión.
// - CA5: un error de tool o del proveedor no mata la sesión.
// - El historial es append-only y siempre válido: todo tool_use recibe su tool_result.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { Reloj } from "../config"
import { ErrorLlm, totalTokens, type DefinicionTool, type LlamadaTool, type LlmAdapter, type ResultadoLlamada } from "../llm/adapter"
import { appendLog } from "../persistencia"
import type { Regla } from "../schemas"
import { ejecutarTool, type ContextoTool, type Herramienta } from "../tools/runner"
import { efectoSobreAutorizacion, notaConfirmacion, pendienteDesdeTool, resolverEntrada, type EntradaTurno, type MotivoInvalida } from "./autorizacion"
import type { EventoTool, Sesion } from "./sesiones"

export type OpcionesAgente = {
  llm: LlmAdapter
  herramientas: Record<string, Herramienta<never>>
  sistema: string
  directorio: string
  reloj: Reloj
  maxIteraciones: number
  maxTokensSesion: number
  cronometro?: () => number
}

export type EstadoTurno =
  | "completado"
  | "limite_iteraciones"
  | "limite_tokens"
  | "error_llm"
  | "rechazo"
  | "respuesta_truncada"
  | "error_interno"
  | "confirmacion_cancelada"
  | "confirmacion_invalida"

export type ConfirmacionPendiente = { caso: string; payload_sha: string; reglas: Regla[] }

export type ResultadoTurno = {
  respuesta: string
  estado: EstadoTurno
  eventos: EventoTool[]
  iteraciones: number
  tokensTurno: number
  // Derivado del estado del runtime (nunca del texto del modelo).
  needsConfirmation: boolean
  pendingConfirmation: ConfirmacionPendiente | null
  autorizacion: { id: string; origen: "boton" | "mensaje"; consumida: boolean } | null
}

const MAX_NOMBRE = 64

// System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/ordenes-compra.md).
export async function cargarSistema(raiz: string): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(join(raiz, "agent", "prompt.md"), "utf8"),
    readFile(join(raiz, "src", "knowledge", "ordenes-compra.md"), "utf8"),
  ])
  return `${comportamiento.trim()}\n\n---\n\n${conocimiento.trim()}\n`
}

// JSON Schema de cada tool, generado desde los esquemas zod congelados (sin duplicar a mano).
export function definicionesTools(herramientas: Record<string, Herramienta<never>>): DefinicionTool[] {
  return Object.entries(herramientas)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([nombre, h]) => {
      const esquema: Record<string, unknown> = { ...z.toJSONSchema(z.object(h.args).strict()) }
      delete esquema["$schema"]
      return { nombre, descripcion: h.description, esquema }
    })
}

const Salida = z.object({
  ok: z.boolean(),
  data: z.object({ resumen: z.string() }).loose().optional(),
  error: z.object({ codigo: z.string(), mensaje: z.string() }).loose().optional(),
})

function errorJson(codigo: string, mensaje: string, sugerencia: string): string {
  return JSON.stringify({ ok: false, error: { codigo, mensaje, sugerencia } })
}

const MENSAJES_INVALIDA: Record<MotivoInvalida, string> = {
  sin_pendiente: "No hay ninguna confirmación pendiente en esta sesión: no se creó ninguna OC.",
  turno_vencido: "La confirmación llegó tarde: solo vale en el turno siguiente a la pregunta. No se creó ninguna OC; vuelve a procesar el caso.",
  caso_distinto: "La confirmación no corresponde al caso pendiente. No se creó ninguna OC y el pendiente quedó cancelado.",
  payload_distinto: "La confirmación no corresponde al payload pendiente. No se creó ninguna OC y el pendiente quedó cancelado.",
  boton_malformado: "La confirmación recibida no es válida. No se creó ninguna OC.",
}

async function ejecutarLlamada(
  llamada: LlamadaTool,
  sesion: Sesion,
  turnoId: string,
  op: OpcionesAgente,
): Promise<{ resultado: ResultadoLlamada; evento: EventoTool }> {
  const nombre = llamada.nombre.slice(0, MAX_NOMBRE)
  const herramienta = Object.hasOwn(op.herramientas, llamada.nombre) ? op.herramientas[llamada.nombre] : undefined
  let salida: string
  if (herramienta === undefined) {
    salida = errorJson("ARGS_INVALIDOS", "La herramienta solicitada no existe.", `Usar una de: ${Object.keys(op.herramientas).sort().join(", ")}.`)
    try {
      await appendLog(op.directorio, {
        ts: op.reloj(),
        sesion: sesion.id,
        herramienta: nombre,
        caso: null,
        ok: false,
        codigo_error: "ARGS_INVALIDOS",
        resumen: "herramienta desconocida",
        duracion_ms: 0,
      })
    } catch {
      console.warn("[agente] no se pudo registrar una llamada a herramienta desconocida")
    }
  } else {
    // La autorización solo existe si el runtime la otorgó en ESTE turno y no se consumió.
    const vigente = sesion.autorizacion !== null && !sesion.autorizacion.consumida ? sesion.autorizacion : null
    const ctx: ContextoTool = { directory: op.directorio, sessionId: sesion.id, turnoId, reloj: op.reloj }
    if (vigente !== null) ctx.autorizacion = vigente
    salida = await ejecutarTool(nombre, herramienta, llamada.argumentos, ctx, op.cronometro === undefined ? {} : { cronometro: op.cronometro })
  }

  const parseada = Salida.safeParse(JSON.parse(salida))
  const ok = parseada.success && parseada.data.ok
  const evento: EventoTool = {
    turno_id: turnoId,
    herramienta: nombre,
    argumentos: llamada.argumentos,
    ok,
    codigo_error: parseada.success ? (parseada.data.error?.codigo ?? null) : "ERROR_INTERNO",
    resumen: !parseada.success
      ? "respuesta fuera de contrato"
      : ok
        ? (parseada.data.data?.resumen ?? "ok")
        : `${parseada.data.error?.codigo ?? "ERROR"}: ${parseada.data.error?.mensaje ?? ""}`,
  }
  return { resultado: { id: llamada.id, contenido: salida, esError: !ok }, evento }
}

// Efectos del resultado de una tool sobre el estado de autorización de la sesión.
function actualizarAutorizacion(sesion: Sesion, llamada: LlamadaTool, contenido: string, turnoId: string, turnoNumero: number, ahora: string): void {
  if (sesion.autorizacion !== null && !sesion.autorizacion.consumida) {
    const efecto = efectoSobreAutorizacion(sesion.autorizacion, llamada.nombre, llamada.argumentos, contenido)
    if (efecto === "consumir") sesion.autorizacion = { ...sesion.autorizacion, consumida: true }
  }
  // Un solo pendiente por sesión: dentro del turno se conserva el primero (salvo el mismo caso).
  const nuevo = pendienteDesdeTool(llamada.nombre, llamada.argumentos, contenido, {
    session_id: sesion.id,
    creado_en: ahora,
    turno_origen: turnoId,
    turno_numero: turnoNumero,
  })
  if (nuevo !== null && (sesion.pendiente === null || sesion.pendiente.caso === nuevo.caso)) sesion.pendiente = nuevo
}

function textoDeEntrada(entrada: EntradaTurno): string {
  // El texto del usuario nunca puede hacerse pasar por una nota del runtime.
  if (typeof entrada === "string") return entrada.replaceAll("[Runtime]", "[runtime-citado]")
  return `[Botón] Confirmar OC ${String(entrada.caso)} (payload ${String(entrada.payload_sha).slice(0, 12)}…)`
}

export async function ejecutarTurno(sesion: Sesion, entrada: EntradaTurno, op: OpcionesAgente): Promise<ResultadoTurno> {
  sesion.turnos += 1
  const turnoNumero = sesion.turnos
  const turnoId = `${sesion.id}:t${turnoNumero}`
  sesion.turnoId = turnoId
  sesion.ultimoError = null

  // CA3: el pendiente del turno anterior solo puede confirmarse en ESTE mensaje; nada se arrastra.
  const pendienteAnterior = sesion.pendiente
  sesion.pendiente = null
  sesion.autorizacion = null

  const eventos: EventoTool[] = []
  let iteraciones = 0
  let tokensTurno = 0
  let ultimoTexto = ""

  const fin = (estado: EstadoTurno, respuesta: string, tipoError?: string): ResultadoTurno => {
    if (tipoError !== undefined) sesion.ultimoError = { turno_id: turnoId, tipo: tipoError, mensaje: respuesta }
    const p = sesion.pendiente
    const a = sesion.autorizacion
    return {
      respuesta,
      estado,
      eventos,
      iteraciones,
      tokensTurno,
      needsConfirmation: p !== null,
      pendingConfirmation: p === null ? null : { caso: p.caso, payload_sha: p.payload_sha, reglas: [...p.confirmaciones] },
      autorizacion: a === null ? null : { id: a.id, origen: a.origen, consumida: a.consumida },
    }
  }

  const respuestaDirecta = (estado: EstadoTurno, texto: string): ResultadoTurno => {
    sesion.mensajes.push({ rol: "usuario", texto: textoDeEntrada(entrada) })
    sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] })
    return fin(estado, texto)
  }

  const decision = resolverEntrada(pendienteAnterior, entrada, {
    sessionId: sesion.id,
    turnoId,
    turnoNumero,
    actor: sesion.actor,
    ahora: op.reloj(),
  })

  let textoUsuario = textoDeEntrada(entrada)
  switch (decision.tipo) {
    case "invalida":
      return respuestaDirecta("confirmacion_invalida", MENSAJES_INVALIDA[decision.motivo])
    case "cancelar":
      return respuestaDirecta(
        "confirmacion_cancelada",
        `Entendido: no se creó la OC de ${decision.pendiente.caso}. La confirmación pendiente quedó cancelada; si quieres retomarla, vuelve a procesar el caso.`,
      )
    case "autorizar":
      sesion.autorizacion = decision.autorizacion
      textoUsuario = `${textoUsuario}\n\n${notaConfirmacion(decision.autorizacion, decision.pendiente.confirmaciones)}`
      break
    case "continuar":
      break
  }
  sesion.mensajes.push({ rol: "usuario", texto: textoUsuario })

  try {
    const definiciones = definicionesTools(op.herramientas)
    for (;;) {
      if (sesion.tokens.total >= op.maxTokensSesion) {
        return fin(
          "limite_tokens",
          `Se alcanzó el presupuesto de tokens de esta sesión (${op.maxTokensSesion}). Inicia una sesión nueva para continuar.`,
          "limite_tokens",
        )
      }
      if (iteraciones >= op.maxIteraciones) {
        const avance = ultimoTexto === "" ? "" : ` Último avance: ${ultimoTexto}`
        return fin(
          "limite_iteraciones",
          `Me detuve tras ${op.maxIteraciones} iteraciones sin terminar el turno.${avance} Puedes pedirme que continúe.`,
          "limite_iteraciones",
        )
      }

      iteraciones += 1
      sesion.iteraciones += 1
      let respuesta
      try {
        respuesta = await op.llm.enviar(sesion.mensajes, definiciones, op.sistema)
      } catch (e) {
        const error = e instanceof ErrorLlm ? e : new ErrorLlm("desconocido", "Error inesperado al llamar al modelo.")
        return fin("error_llm", `No pude completar la respuesta: ${error.message} La sesión sigue disponible.`, error.tipo)
      }

      const usados = totalTokens(respuesta.uso)
      tokensTurno += usados
      sesion.tokens.entrada += respuesta.uso.entrada
      sesion.tokens.salida += respuesta.uso.salida
      sesion.tokens.cacheEscritura += respuesta.uso.cacheEscritura
      sesion.tokens.cacheLectura += respuesta.uso.cacheLectura
      sesion.tokens.total += usados

      sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, crudo: respuesta.crudo })
      if (respuesta.texto !== "") ultimoTexto = respuesta.texto

      if (respuesta.motivo === "uso_tool" && respuesta.llamadas.length > 0) {
        const resultados: ResultadoLlamada[] = []
        for (const llamada of respuesta.llamadas) {
          const { resultado, evento } = await ejecutarLlamada(llamada, sesion, turnoId, op)
          actualizarAutorizacion(sesion, llamada, resultado.contenido, turnoId, turnoNumero, op.reloj())
          resultados.push(resultado)
          eventos.push(evento)
          sesion.eventos.push(evento)
        }
        // Todos los resultados en un único mensaje (requisito de la API para llamadas paralelas).
        sesion.mensajes.push({ rol: "resultados", resultados })
        continue
      }

      // Llamadas en una respuesta cortada o declinada: no se ejecutan, pero se responden para mantener el historial válido.
      if (respuesta.llamadas.length > 0) {
        sesion.mensajes.push({
          rol: "resultados",
          resultados: respuesta.llamadas.map((l) => ({
            id: l.id,
            contenido: errorJson("ARGS_INVALIDOS", "La llamada no se ejecutó: la respuesta del modelo quedó incompleta.", "Repetir la llamada."),
            esError: true,
          })),
        })
      }

      switch (respuesta.motivo) {
        case "rechazo":
          return fin("rechazo", "El modelo declinó responder esta solicitud. Reformúlala o revisa el caso con las herramientas directamente.", "rechazo")
        case "max_tokens":
        case "limite_contexto":
          return fin(
            "respuesta_truncada",
            `${respuesta.texto || ultimoTexto}\n\n(La respuesta quedó incompleta por el límite de tokens de salida o de contexto.)`.trim(),
            respuesta.motivo,
          )
        default:
          return fin("completado", respuesta.texto || ultimoTexto || "(sin respuesta del modelo)")
      }
    }
  } catch {
    return fin("error_interno", "Ocurrió un error interno al procesar el turno. La sesión sigue disponible.", "error_interno")
  }
}
