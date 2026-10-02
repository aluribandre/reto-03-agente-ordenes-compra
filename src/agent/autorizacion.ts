// Runtime de autorización humana (CA3). El runtime es la autoridad: el LLM nunca decide
// que algo es una confirmación. Lógica pura sobre el estado de la sesión; sin E/S.
//
// Política:
// - Un pendiente como máximo por sesión. Se registra cuando oc_construir_payload devuelve
//   requiere_confirmacion=true (o oc_crear devuelve CONFIRMACION_REQUERIDA). Si en el MISMO
//   turno otro caso requiere confirmación, se conserva el primero. Cada turno nuevo descarta
//   el pendiente anterior salvo que ese mismo mensaje lo confirme (solo vale el turno N+1).
// - Confirmación por botón { action: "confirm", caso, payload_sha } o por mensaje de una lista
//   cerrada. La negación tiene prioridad; las preguntas nunca confirman.
// - La autorización vale solo en su turno y es de un solo uso (ver efectoSobreAutorizacion).
import { z } from "zod"
import { Autorizacion, Caso, Hallazgo, Regla, Sha256 } from "../schemas"

export type PendienteConfirmacion = {
  session_id: string
  caso: string
  payload_sha: string
  confirmaciones: Regla[]
  creado_en: string
  turno_origen: string
  turno_numero: number
}

export type EntradaBoton = { action: "confirm"; caso: string; payload_sha: string }
export type EntradaTurno = string | EntradaBoton

export type ClaseMensaje = "confirma" | "rechaza" | "otro"

export type MotivoInvalida = "sin_pendiente" | "turno_vencido" | "caso_distinto" | "payload_distinto" | "boton_malformado"

export type Decision =
  | { tipo: "autorizar"; autorizacion: Autorizacion; pendiente: PendienteConfirmacion }
  | { tipo: "cancelar"; pendiente: PendienteConfirmacion }
  | { tipo: "invalida"; motivo: MotivoInvalida; pendiente: PendienteConfirmacion | null }
  | { tipo: "continuar"; pendienteCancelado: PendienteConfirmacion | null }

export type ContextoDecision = {
  sessionId: string
  turnoId: string
  turnoNumero: number
  actor: string
  ahora: string
}

// Identidad de sesión, NO identidad autenticada (el PRD excluye autenticación).
export const actorDeSesion = (sessionId: string): string => `analista@sesion:${sessionId}`

// ---------------------------------------------------------------------------
// Clasificación cerrada y determinista del mensaje
// ---------------------------------------------------------------------------

const CONFIRMACIONES = new Set(["confirmo", "si confirmo", "confirmar", "proceda", "procede", "adelante"])
const NEGACIONES = new Set(["no", "nunca", "cancela", "cancelar", "cancelo", "cancelen", "rechazo", "rechazar", "rechaza", "detente", "alto"])

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[¡!.,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function clasificarMensaje(texto: string): ClaseMensaje {
  const n = normalizar(texto)
  if (n.split(" ").some((palabra) => NEGACIONES.has(palabra))) return "rechaza"
  if (/[¿?]/.test(texto)) return "otro"
  return CONFIRMACIONES.has(n) ? "confirma" : "otro"
}

// ---------------------------------------------------------------------------
// Decisión al inicio del turno (antes de llamar al LLM)
// ---------------------------------------------------------------------------

const EsquemaBoton = z.object({ action: z.literal("confirm"), caso: Caso, payload_sha: Sha256 }).strict()

function autorizar(p: PendienteConfirmacion, ctx: ContextoDecision, origen: "boton" | "mensaje"): Decision {
  const autorizacion = Autorizacion.parse({
    id: `aut-${ctx.sessionId}-t${ctx.turnoNumero}`,
    accion: "crear_oc",
    caso: p.caso,
    payload_sha: p.payload_sha,
    session_id: ctx.sessionId,
    turno_id: ctx.turnoId,
    actor: ctx.actor,
    origen,
    otorgada_en: ctx.ahora,
    consumida: false,
  })
  return { tipo: "autorizar", autorizacion, pendiente: p }
}

export function resolverEntrada(pendiente: PendienteConfirmacion | null, entrada: EntradaTurno, ctx: ContextoDecision): Decision {
  // El pendiente solo sirve si es de esta sesión y del turno inmediatamente anterior.
  const vigente = pendiente !== null && pendiente.session_id === ctx.sessionId && pendiente.turno_numero === ctx.turnoNumero - 1 ? pendiente : null

  if (typeof entrada !== "string") {
    const boton = EsquemaBoton.safeParse(entrada)
    if (!boton.success) return { tipo: "invalida", motivo: "boton_malformado", pendiente }
    if (pendiente === null) return { tipo: "invalida", motivo: "sin_pendiente", pendiente: null }
    if (vigente === null) return { tipo: "invalida", motivo: "turno_vencido", pendiente }
    if (boton.data.caso !== vigente.caso) return { tipo: "invalida", motivo: "caso_distinto", pendiente }
    if (boton.data.payload_sha !== vigente.payload_sha) return { tipo: "invalida", motivo: "payload_distinto", pendiente }
    return autorizar(vigente, ctx, "boton")
  }

  if (vigente === null) return { tipo: "continuar", pendienteCancelado: pendiente }
  switch (clasificarMensaje(entrada)) {
    case "confirma":
      return autorizar(vigente, ctx, "mensaje")
    case "rechaza":
      return { tipo: "cancelar", pendiente: vigente }
    default:
      // CA3: cualquier otro mensaje invalida el pendiente; la conversación sigue normalmente.
      return { tipo: "continuar", pendienteCancelado: vigente }
  }
}

// ---------------------------------------------------------------------------
// Señales que llegan de las tools
// ---------------------------------------------------------------------------

const ArgsCaso = z.object({ caso: Caso }).loose()

const ResultadoConstruir = z.object({
  ok: z.literal(true),
  data: z.object({ payload_sha: Sha256, requiere_confirmacion: z.boolean(), confirmaciones: z.array(Hallazgo) }).loose(),
})

const ResultadoCrearPendiente = z.object({
  ok: z.literal(false),
  error: z.object({
    codigo: z.literal("CONFIRMACION_REQUERIDA"),
    detalle: z.object({ payload_sha: Sha256, confirmaciones: z.array(Regla) }).loose(),
  }).loose(),
})

// Pendiente que se desprende del resultado de una tool, o null si no aplica.
export function pendienteDesdeTool(
  herramienta: string,
  argumentos: unknown,
  salida: string,
  base: { session_id: string; creado_en: string; turno_origen: string; turno_numero: number },
): PendienteConfirmacion | null {
  const args = ArgsCaso.safeParse(argumentos)
  if (!args.success) return null
  let crudo: unknown
  try {
    crudo = JSON.parse(salida)
  } catch {
    return null
  }
  if (herramienta === "oc_construir_payload") {
    const r = ResultadoConstruir.safeParse(crudo)
    if (!r.success || !r.data.data.requiere_confirmacion) return null
    return { ...base, caso: args.data.caso, payload_sha: r.data.data.payload_sha, confirmaciones: r.data.data.confirmaciones.map((h) => h.regla) }
  }
  if (herramienta === "oc_crear") {
    const r = ResultadoCrearPendiente.safeParse(crudo)
    if (!r.success) return null
    return { ...base, caso: args.data.caso, payload_sha: r.data.error.detalle.payload_sha, confirmaciones: r.data.error.detalle.confirmaciones }
  }
  return null
}

// Qué le pasa a la autorización vigente tras una llamada a oc_crear:
// - otro caso: sin efecto.
// - éxito (creada o idempotente): se consume.
// - SAP_ERROR / ERROR_ESCRITURA: se conserva DENTRO del turno para reintentar. Es seguro porque
//   oc_crear consulta primero SAP por solicitud_id: si la OC ya se creó (fallo parcial), el
//   reintento devuelve la existente y entonces se consume. Al terminar el turno se descarta igual.
// - cualquier otro error (integridad, bloqueo, autorización): se consume para impedir su reuso.
export type Efecto = "sin_efecto" | "consumir" | "conservar"

const CONSERVAR = new Set(["SAP_ERROR", "ERROR_ESCRITURA"])
const Salida = z.object({ ok: z.boolean(), error: z.object({ codigo: z.string() }).loose().optional() }).loose()

export function efectoSobreAutorizacion(autorizacion: Autorizacion, herramienta: string, argumentos: unknown, salida: string): Efecto {
  if (herramienta !== "oc_crear") return "sin_efecto"
  const args = ArgsCaso.safeParse(argumentos)
  if (!args.success || args.data.caso !== autorizacion.caso) return "sin_efecto"
  let crudo: unknown
  try {
    crudo = JSON.parse(salida)
  } catch {
    return "consumir"
  }
  const r = Salida.safeParse(crudo)
  if (!r.success) return "consumir"
  if (r.data.ok) return "consumir"
  return CONSERVAR.has(r.data.error?.codigo ?? "") ? "conservar" : "consumir"
}

// Nota que el runtime añade al mensaje del turno de confirmación (el modelo la ve; no autoriza nada por sí sola).
export function notaConfirmacion(a: Autorizacion, reglas: readonly Regla[]): string {
  return [
    "[Runtime] Confirmación registrada por el sistema (no por el texto del usuario).",
    `Autoriza una sola ejecución de oc_crear con caso=${a.caso} y payload_sha=${a.payload_sha} (confirmaciones: ${reglas.join(", ") || "—"}).`,
    "Vale solo en este turno.",
  ].join(" ")
}
