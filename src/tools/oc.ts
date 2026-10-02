// Las 5 tools P0 de órdenes de compra (PRD 6.2). El modelo las ve como oc_<export>.
// Inputs mínimos: { caso } o { caso, payload_sha? }. Todo dato de negocio se relee desde disco;
// el modelo nunca es fuente de valores. Ninguna tool lanza: devuelven JSON { ok, data } | { ok: false, error }.
import { resolve } from "node:path"
import { z } from "zod"
import { evaluarControles, type EvaluacionControles } from "../domain/controles"
import { construirEvidencia, renderArchivoEvidencia } from "../domain/evidencia"
import { construirPayload, validarCatalogos } from "../domain/payload"
import { payloadSha } from "../domain/sello"
import { cargarAprobacionFuente, cargarCaso, cargarMaestros } from "../ingestion/cargar"
import {
  ARCHIVOS,
  ErrorPersistencia,
  appendControl,
  conCandado,
  escribirEjecucion,
  leerEjecucion,
  leerEvidencia,
  leerPayloadSellado,
  sellarEvidencia,
  sellarPayload,
  sellarTrazabilidad,
} from "../persistencia"
import type { SapAdapter } from "../sap/adapter"
import { MockSapAdapter } from "../sap/mock"
import {
  ArgsCrear,
  ArgsSoloCaso,
  Autorizacion,
  Fecha,
  NumeroOc,
  type CodigoError,
  type DataConstruirPayload,
  type DataCrear,
  type DataEvidencia,
  type DataLeerPaquete,
  type DataValidar,
  type ErrorTool,
  type FilaControl,
  type Maestros,
  type Paquete,
  type PayloadSellado,
  type Regla,
  type ResultadoTool,
} from "../schemas"
import type { ContextoTool, Herramienta } from "./runner"

export type DependenciasOc = {
  crearSap: (ctx: ContextoTool, maestros: Maestros) => SapAdapter
}

export const DEPENDENCIAS_POR_DEFECTO: DependenciasOc = {
  crearSap: (ctx, maestros) => new MockSapAdapter({ raiz: ctx.directory, reloj: ctx.reloj, proveedores: maestros.proveedores }),
}

const MAX_TEXTO_LLM = 4000
const EsquemaSoloCaso = z.object(ArgsSoloCaso)
const EsquemaCrear = z.object(ArgsCrear)
const RespuestaSap = z.object({ numero_oc: NumeroOc, fecha: Fecha })

// ---------------------------------------------------------------------------
// Errores controlados
// ---------------------------------------------------------------------------

class FalloTool extends Error {
  constructor(readonly error: ErrorTool) {
    super(error.mensaje)
  }
}

function fallar(codigo: CodigoError, mensaje: string, sugerencia: string, detalle?: Record<string, unknown>): never {
  throw new FalloTool(detalle ? { codigo, mensaje, sugerencia, detalle } : { codigo, mensaje, sugerencia })
}

function exigir<T>(r: ResultadoTool<T>): T {
  if (!r.ok) throw new FalloTool(r.error)
  return r.data
}

function comoError(e: unknown): ResultadoTool<never> {
  if (e instanceof FalloTool) return { ok: false, error: e.error }
  if (e instanceof ErrorPersistencia) {
    return {
      ok: false,
      error: { codigo: "ERROR_ESCRITURA", mensaje: `Error de persistencia: ${e.message}.`, sugerencia: "Reintentar; si persiste, revisar el directorio out/." },
    }
  }
  return {
    ok: false,
    error: { codigo: "ERROR_INTERNO", mensaje: "Error interno al ejecutar la herramienta.", sugerencia: "Reintentar; si persiste, revisar el registro del servidor." },
  }
}

async function ejecutar<T>(cuerpo: () => Promise<T>): Promise<string> {
  try {
    return JSON.stringify({ ok: true, data: await cuerpo() })
  } catch (e) {
    return JSON.stringify(comoError(e))
  }
}

function parsearArgs<T>(esquema: z.ZodType<T>, args: unknown): T {
  const r = esquema.safeParse(args)
  if (!r.success) {
    fallar("ARGS_INVALIDOS", "Argumentos inválidos para la herramienta.", "Revisar los argumentos según la descripción de la herramienta.", {
      campos: r.error.issues.map((i) => i.path.map(String).join(".") || "(raíz)"),
    })
  }
  return r.data
}

// ---------------------------------------------------------------------------
// Pasos compartidos
// ---------------------------------------------------------------------------

type CasoEvaluado = { paquete: Paquete; maestros: Maestros; evaluacion: EvaluacionControles }

async function cargarYEvaluar(caso: string, ctx: ContextoTool): Promise<CasoEvaluado> {
  const paquete = exigir(await cargarCaso(caso, { raiz: ctx.directory }))
  const maestros = exigir(await cargarMaestros({ raiz: ctx.directory }))
  return { paquete, maestros, evaluacion: evaluarControles(paquete, maestros) }
}

const reglas = (lista: readonly { regla: Regla }[]): Regla[] => lista.map((h) => h.regla)
const listar = (lista: readonly string[]): string => (lista.length === 0 ? "—" : lista.join(","))

function detalleBloqueo(e: EvaluacionControles): Record<string, unknown> {
  return { bloqueos: reglas(e.bloqueos), no_evaluables: e.controles.filter((c) => c.estado === "NO_EVALUABLE").map((c) => c.regla) }
}

function exigirApta(e: EvaluacionControles, accion: string): void {
  if (!e.apta) {
    fallar("CASO_BLOQUEADO", `El caso tiene bloqueos: no se ${accion}.`, "Resolver los bloqueos con el solicitante y volver a validar.", detalleBloqueo(e))
  }
}

// Evidencia calculada desde la aprobación actual del caso (función pura de F4).
async function evidenciaActual(caso: string, ctx: ContextoTool): Promise<{ sha256: string; texto: string }> {
  const fuente = exigir(await cargarAprobacionFuente(caso, { raiz: ctx.directory }))
  if (fuente === null) throw new Error("aprobación ausente en un caso apto")
  const evidencia = construirEvidencia(fuente)
  return { sha256: evidencia.sha256, texto: renderArchivoEvidencia(evidencia) }
}

function limitar(texto: string): string {
  return texto.length > MAX_TEXTO_LLM ? `${texto.slice(0, MAX_TEXTO_LLM)}…` : texto
}

async function llamarSap<T>(llamada: () => Promise<T>): Promise<T> {
  try {
    return await llamada()
  } catch {
    fallar("SAP_ERROR", "SAP no respondió correctamente; no se creó la OC.", "Reintentar: la creación es idempotente por solicitud_id.")
  }
}

// ---------------------------------------------------------------------------
// oc_crear: única tool con efecto en el sistema de registro
// ---------------------------------------------------------------------------

async function leerSellado(raiz: string, caso: string): Promise<PayloadSellado | null> {
  try {
    return await leerPayloadSellado(raiz, caso)
  } catch {
    fallar("PAYLOAD_NO_COINCIDE", "El payload sellado es ilegible; no se crea la OC.", "Reconstruir el caso desde cero.", { motivo: "payload_ilegible" })
  }
}

function motivoAutorizacionInvalida(cruda: unknown, caso: string, sha: string, ctx: ContextoTool): string | null {
  const r = Autorizacion.safeParse(cruda)
  if (!r.success) return "estructura_invalida"
  const a = r.data
  if (a.caso !== caso) return "caso"
  if (a.payload_sha !== sha) return "payload_sha"
  if (a.session_id !== ctx.sessionId) return "session_id"
  if (a.turno_id !== ctx.turnoId) return "turno_id"
  if (a.consumida) return "consumida"
  return null
}

type Registrar = (resultado: FilaControl["resultado"], numeroOc?: string) => Promise<unknown>

async function respuestaIdempotente(
  caso: string,
  numeroOc: string,
  base: { solicitud_id: string; retroactiva: boolean },
  sap: SapAdapter,
  ctx: ContextoTool,
  registrar: Registrar,
): Promise<DataCrear> {
  let fecha: string
  let sha: string
  let autorizacionId: string | null
  const ejecucion = await leerEjecucion(ctx.directory, caso)
  if (ejecucion !== null && ejecucion.numero_oc === numeroOc) {
    fecha = ejecucion.fecha
    sha = ejecucion.payload_sha
    autorizacionId = ejecucion.autorizacion?.id ?? null
  } else {
    // Recuperación: la OC existe en SAP pero falta el registro local (p. ej. caída entre SAP y ejecucion.json).
    const sellado = await leerPayloadSellado(ctx.directory, caso)
    if (sellado === null) {
      fallar("SAP_ERROR", "La OC existe en SAP pero no hay registro local para reconstruir la respuesta.", "Revisar out/sap/ordenes.jsonl.", { numero_oc: numeroOc })
    }
    const existente = RespuestaSap.parse(await llamarSap(() => sap.crearOrden(sellado.payload)))
    fecha = existente.fecha
    sha = sellado.payload_sha
    autorizacionId = null
    await escribirEjecucion(ctx.directory, caso, { numero_oc: numeroOc, fecha, payload_sha: sha, idempotente: true, autorizacion: null })
  }
  await registrar("exitoso", numeroOc)
  return {
    numero_oc: numeroOc,
    fecha,
    idempotente: true,
    solicitud_id: base.solicitud_id,
    payload_sha: sha,
    retroactiva: base.retroactiva,
    autorizacion_id: autorizacionId,
    ruta_evidencia: `out/${caso}/${ARCHIVOS.evidencia}`,
    resumen: `${base.solicitud_id}: OC ${numeroOc} ya existía (idempotente)`,
  }
}

async function crearOc(caso: string, shaArg: string | undefined, ctx: ContextoTool, deps: DependenciasOc): Promise<DataCrear> {
  const { paquete, maestros, evaluacion } = await cargarYEvaluar(caso, ctx)
  const solicitudId = paquete.solicitud.solicitud_id
  const sap = deps.crearSap(ctx, maestros)
  const registrar: Registrar = (resultado, numeroOc = "") =>
    appendControl(ctx.directory, {
      solicitud_id: solicitudId,
      resultado,
      numero_oc: numeroOc,
      retroactiva: evaluacion.retroactiva,
      bloqueos: reglas(evaluacion.bloqueos),
      confirmaciones: reglas(evaluacion.confirmaciones),
      ts: ctx.reloj(),
    })

  // 1. Idempotencia: si la OC ya existe, se devuelve la misma.
  const existente = await llamarSap(() => sap.buscarOrdenPorReferencia(solicitudId))
  if (existente !== null) {
    return respuestaIdempotente(caso, existente.numero_oc, { solicitud_id: solicitudId, retroactiva: evaluacion.retroactiva }, sap, ctx, registrar)
  }

  // 2. Compuerta de controles.
  if (!evaluacion.apta) {
    await registrar("bloqueado")
    fallar("CASO_BLOQUEADO", "El caso tiene bloqueos: no se crea la OC.", "Resolver los bloqueos con el solicitante y volver a validar.", detalleBloqueo(evaluacion))
  }

  // 3. Integridad del payload sellado.
  const sellado = await leerSellado(ctx.directory, caso)
  if (sellado === null) fallar("FALTA_PAYLOAD", "No hay payload sellado para este caso.", "Ejecutar oc_construir_payload antes de crear la OC.")
  if (payloadSha(sellado.payload) !== sellado.payload_sha) {
    fallar("PAYLOAD_NO_COINCIDE", "El payload sellado fue alterado: su contenido no corresponde a su hash.", "No se crea la OC; reconstruir el caso.", {
      motivo: "hash_almacenado_no_coincide",
    })
  }
  if (shaArg === undefined) {
    fallar("ARGS_INVALIDOS", "payload_sha es obligatorio para crear la OC de un caso apto.", "Pasar el payload_sha devuelto por oc_construir_payload.")
  }
  if (shaArg !== sellado.payload_sha) {
    fallar("PAYLOAD_NO_COINCIDE", "El payload_sha indicado no corresponde al payload sellado.", "Usar el payload_sha devuelto por oc_construir_payload.", {
      motivo: "payload_sha_distinto",
    })
  }
  if (listar(sellado.confirmaciones) !== listar(reglas(evaluacion.confirmaciones))) {
    fallar("PAYLOAD_NO_COINCIDE", "Las confirmaciones del payload sellado no coinciden con la validación actual.", "Revisar qué cambió en el caso.", {
      motivo: "confirmaciones_distintas",
    })
  }
  for (const posicion of sellado.payload.posiciones) {
    const errorCatalogo = validarCatalogos({ indicador_iva: posicion.indicador_iva, condiciones_pago: sellado.payload.condiciones_pago }, maestros)
    if (errorCatalogo !== null) throw new FalloTool(errorCatalogo)
  }

  // 4. Autorización humana (la pone el runtime en ctx; nunca un argumento del modelo).
  let autorizacion: Autorizacion | null = null
  if (sellado.confirmaciones.length > 0) {
    if (ctx.autorizacion === undefined) {
      await registrar("pendiente")
      fallar("CONFIRMACION_REQUERIDA", "La OC requiere confirmación explícita del usuario antes de crearse.", "Mostrar las confirmaciones y preguntar; no crear sin respuesta afirmativa.", {
        confirmaciones: sellado.confirmaciones,
        payload_sha: sellado.payload_sha,
      })
    }
    const motivo = motivoAutorizacionInvalida(ctx.autorizacion, caso, sellado.payload_sha, ctx)
    if (motivo !== null) {
      await registrar("pendiente")
      fallar("AUTORIZACION_INVALIDA", "La autorización no corresponde a esta acción, caso, payload, sesión o turno.", "Pedir una nueva confirmación explícita del usuario.", {
        motivo,
      })
    }
    autorizacion = Autorizacion.parse(ctx.autorizacion)
  }

  // 5. Creación con el payload inmutable exacto.
  const creada = RespuestaSap.parse(await llamarSap(() => sap.crearOrden(sellado.payload)))
  await escribirEjecucion(ctx.directory, caso, {
    numero_oc: creada.numero_oc,
    fecha: creada.fecha,
    payload_sha: sellado.payload_sha,
    idempotente: false,
    autorizacion,
  })
  await registrar("exitoso", creada.numero_oc)
  return {
    numero_oc: creada.numero_oc,
    fecha: creada.fecha,
    idempotente: false,
    solicitud_id: solicitudId,
    payload_sha: sellado.payload_sha,
    retroactiva: evaluacion.retroactiva,
    autorizacion_id: autorizacion?.id ?? null,
    ruta_evidencia: `out/${caso}/${ARCHIVOS.evidencia}`,
    resumen: `${solicitudId}: OC ${creada.numero_oc} creada${autorizacion === null ? "" : " con confirmación del usuario"}`,
  }
}

// ---------------------------------------------------------------------------
// Fábrica de tools
// ---------------------------------------------------------------------------

type ArgsCaso = { caso: string }
type ArgsCrearOc = { caso: string; payload_sha?: string }

export function crearHerramientasOc(deps: DependenciasOc = DEPENDENCIAS_POR_DEFECTO) {
  const leer_paquete: Herramienta<ArgsCaso> = {
    description: "Lee y normaliza el correo, la solicitud, la cotización, la aprobación y la factura de un caso; no valida reglas de negocio.",
    args: ArgsSoloCaso,
    execute: (args, ctx) =>
      ejecutar(async (): Promise<DataLeerPaquete> => {
        const { caso } = parsearArgs(EsquemaSoloCaso, args)
        const p = exigir(await cargarCaso(caso, { raiz: ctx.directory }))
        return {
          ...p,
          cotizacion: p.cotizacion === null ? null : { ...p.cotizacion, texto: limitar(p.cotizacion.texto) },
          aprobacion: p.aprobacion === null ? null : { ...p.aprobacion, texto: limitar(p.aprobacion.texto) },
          resumen: `${p.solicitud.solicitud_id}: paquete leído; faltantes: ${listar(p.faltantes.map((f) => f.pieza))}`,
        }
      }),
  }

  const validar: Herramienta<ArgsCaso> = {
    description: "Aplica los controles RC1–RC10 al paquete de un caso contra los maestros y devuelve bloqueos, confirmaciones y valores derivados.",
    args: ArgsSoloCaso,
    execute: (args, ctx) =>
      ejecutar(async (): Promise<DataValidar> => {
        const { caso } = parsearArgs(EsquemaSoloCaso, args)
        const { evaluacion } = await cargarYEvaluar(caso, ctx)
        return {
          ...evaluacion,
          resumen: `${evaluacion.solicitud_id}: apta=${evaluacion.apta}; bloqueos=${listar(reglas(evaluacion.bloqueos))}; confirmaciones=${listar(reglas(evaluacion.confirmaciones))}`,
        }
      }),
  }

  const generar_evidencia: Herramienta<ArgsCaso> = {
    description: "Genera el archivo de evidencia del correo de aprobación de un caso no bloqueado y devuelve su hash sha256.",
    args: ArgsSoloCaso,
    execute: (args, ctx) =>
      ejecutar(async (): Promise<DataEvidencia> => {
        const { caso } = parsearArgs(EsquemaSoloCaso, args)
        const { evaluacion } = await cargarYEvaluar(caso, ctx)
        exigirApta(evaluacion, "genera evidencia")
        const evidencia = await evidenciaActual(caso, ctx)
        const r = await sellarEvidencia(ctx.directory, caso, evidencia.texto)
        if (r.estado === "conflicto") {
          fallar("EVIDENCIA_INCONSISTENTE", "Ya existe una evidencia distinta para este caso; no se sobrescribe.", "La aprobación cambió después de generar la evidencia: revisar el caso.", {
            ruta: r.ruta,
            ...r.detalle,
          })
        }
        return {
          ruta: r.ruta,
          sha256: evidencia.sha256,
          ruta_pdf: null,
          reutilizada: r.estado === "reutilizado",
          resumen: `${evaluacion.solicitud_id}: evidencia ${evidencia.sha256.slice(0, 12)}… (${r.estado === "reutilizado" ? "reutilizada" : "nueva"})`,
        }
      }),
  }

  const construir_payload: Herramienta<ArgsCaso> = {
    description: "Construye, valida y sella la orden de compra de un caso no bloqueado, con trazabilidad de cada campo; no la crea en SAP.",
    args: ArgsSoloCaso,
    execute: (args, ctx) =>
      ejecutar(async (): Promise<DataConstruirPayload> => {
        const { caso } = parsearArgs(EsquemaSoloCaso, args)
        const { paquete, maestros, evaluacion } = await cargarYEvaluar(caso, ctx)
        exigirApta(evaluacion, "construye el payload")

        const archivo = await leerEvidencia(ctx.directory, caso)
        if (archivo === null) fallar("FALTA_EVIDENCIA", "No existe la evidencia de aprobación del caso.", "Ejecutar oc_generar_evidencia antes de construir el payload.")
        const evidencia = await evidenciaActual(caso, ctx)
        if (archivo !== evidencia.texto) {
          fallar("EVIDENCIA_INCONSISTENTE", "La evidencia guardada no corresponde a la aprobación actual.", "Revisar el caso: la aprobación cambió después de generar la evidencia.", {
            ruta: `out/${caso}/${ARCHIVOS.evidencia}`,
          })
        }

        const construido = exigir(construirPayload({ paquete, maestros, evaluacion, evidenciaSha256: evidencia.sha256, generadoEn: ctx.reloj() }))
        const sello = await sellarPayload(ctx.directory, caso, {
          payload: construido.orden,
          payload_sha: construido.payload_sha,
          confirmaciones: construido.confirmaciones,
          construido_en: ctx.reloj(),
        })
        if (sello.estado === "conflicto") {
          fallar("PAYLOAD_NO_COINCIDE", "Ya existe un payload sellado distinto para este caso; no se sobrescribe.", "El payload sellado es inmutable: revisar qué cambió en la solicitud.", {
            ruta: sello.ruta,
            ...sello.detalle,
          })
        }
        const traza = await sellarTrazabilidad(ctx.directory, caso, construido.trazabilidad)
        if (traza.estado === "conflicto") {
          fallar("PAYLOAD_NO_COINCIDE", "La trazabilidad existente corresponde a otro payload; no se sobrescribe.", "Revisar el caso.", {
            ruta: traza.ruta,
            ...traza.detalle,
          })
        }
        const confirmaciones = reglas(evaluacion.confirmaciones)
        return {
          payload: construido.orden,
          payload_sha: construido.payload_sha,
          requiere_confirmacion: confirmaciones.length > 0,
          confirmaciones: evaluacion.confirmaciones,
          ruta_payload: sello.ruta,
          ruta_trazabilidad: traza.ruta,
          resumen: `${evaluacion.solicitud_id}: payload sellado ${construido.payload_sha.slice(0, 12)}… (${sello.estado}); confirmaciones=${listar(confirmaciones)}`,
        }
      }),
  }

  const crear: Herramienta<ArgsCrearOc> = {
    description: "Crea en SAP la orden de compra sellada de un caso si está apta y, cuando corresponde, confirmada por el usuario; es idempotente por solicitud_id.",
    args: ArgsCrear,
    execute: (args, ctx) =>
      ejecutar(async (): Promise<DataCrear> => {
        const { caso, payload_sha } = parsearArgs(EsquemaCrear, args)
        return conCandado(`crear:${resolve(ctx.directory)}:${caso}`, () => crearOc(caso, payload_sha, ctx, deps))
      }),
  }

  return { leer_paquete, validar, generar_evidencia, construir_payload, crear }
}

const POR_DEFECTO = crearHerramientasOc()

export const leer_paquete = POR_DEFECTO.leer_paquete
export const validar = POR_DEFECTO.validar
export const generar_evidencia = POR_DEFECTO.generar_evidencia
export const construir_payload = POR_DEFECTO.construir_payload
export const crear = POR_DEFECTO.crear

export type HerramientasOc = ReturnType<typeof crearHerramientasOc>

// Nombre visto por el modelo: <archivo>_<export> (PRD 6.2).
export function registroOc(h: HerramientasOc = POR_DEFECTO): Record<string, Herramienta<never>> {
  return {
    oc_leer_paquete: h.leer_paquete,
    oc_validar: h.validar,
    oc_generar_evidencia: h.generar_evidencia,
    oc_construir_payload: h.construir_payload,
    oc_crear: h.crear,
  }
}
