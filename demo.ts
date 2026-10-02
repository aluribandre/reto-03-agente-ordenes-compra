// Demo determinista sin LLM (PRD 6.6): procesa los 6 casos con las mismas tools de producción,
// a través del runner, con fecha fija. demo.ts actúa como humano simulado solo para autorizar
// sol-004 y sol-005 (construye ctx.autorizacion válido; no interpreta lenguaje natural).
//   bun run demo
import { z } from "zod"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO, crearReloj } from "./src/config"
import { ARCHIVOS, leerControl, leerJsonl, limpiarOut } from "./src/persistencia"
import {
  DataConstruirPayload,
  DataCrear,
  DataEvidencia,
  DataLeerPaquete,
  DataValidar,
  ErrorTool,
  OrdenRegistrada,
  type Autorizacion,
  type Derivados,
  type Regla,
} from "./src/schemas"
import { crearHerramientasOc, registroOc } from "./src/tools/oc"
import { ejecutarTool, type ContextoTool, type Herramienta } from "./src/tools/runner"

export const SESION_DEMO = "demo"

type Paso = { caso: string; autorizar: boolean }

// Secuencia exacta de la demo.
export const PASOS: readonly Paso[] = [
  { caso: "sol-001", autorizar: false },
  { caso: "sol-001", autorizar: false },
  { caso: "sol-002", autorizar: false },
  { caso: "sol-003", autorizar: false },
  { caso: "sol-004", autorizar: false },
  { caso: "sol-004", autorizar: true },
  { caso: "sol-005", autorizar: false },
  { caso: "sol-005", autorizar: true },
  { caso: "sol-006", autorizar: false },
]

export type ResultadoCrear = "exitoso" | "pendiente" | "bloqueado"

export type PasoDemo = {
  n: number
  caso: string
  apta: boolean
  bloqueos: Regla[]
  no_evaluables: Regla[]
  confirmaciones: Regla[]
  retroactiva: boolean
  derivados: Derivados
  autorizado: boolean
  resultado: ResultadoCrear
  codigo: string | null
  numero_oc: string | null
  idempotente: boolean | null
}

export type ResultadoDemo = {
  pasos: PasoDemo[]
  resumen: { ocs_creadas: number; pendientes_finales: number; bloqueados: number; intentos_registrados: number }
  lineas: string[]
}

class ErrorDemo extends Error {}

const Fallo = z.object({ ok: z.literal(false), error: ErrorTool })
const Exito = z.object({ ok: z.literal(true), data: z.unknown() })
type Respuesta<T> = { ok: true; data: T } | { ok: false; error: ErrorTool }

async function llamar<T>(
  registro: Record<string, Herramienta<never>>,
  nombre: string,
  args: Record<string, unknown>,
  esquema: z.ZodType<T>,
  ctx: ContextoTool,
): Promise<Respuesta<T>> {
  const herramienta = registro[nombre]
  if (herramienta === undefined) throw new ErrorDemo(`tool desconocida: ${nombre}`)
  const crudo: unknown = JSON.parse(await ejecutarTool(nombre, herramienta, args, ctx, { cronometro: () => 0 }))
  const fallo = Fallo.safeParse(crudo)
  if (fallo.success) return { ok: false, error: fallo.data.error }
  return { ok: true, data: esquema.parse(Exito.parse(crudo).data) }
}

function exigir<T>(r: Respuesta<T>, paso: string): T {
  if (!r.ok) throw new ErrorDemo(`${paso}: ${r.error.codigo} — ${r.error.mensaje}`)
  return r.data
}

// Humano simulado: autorización explícita para ESTA acción, caso, payload, sesión y turno.
function autorizacionSimulada(caso: string, payloadSha: string, turnoId: string, otorgadaEn: string): Autorizacion {
  return {
    id: `demo-aut-${caso}`,
    accion: "crear_oc",
    caso,
    payload_sha: payloadSha,
    session_id: SESION_DEMO,
    turno_id: turnoId,
    actor: "humano-simulado:demo.ts",
    origen: "boton",
    otorgada_en: otorgadaEn,
    consumida: false,
  }
}

function clasificar(codigo: string): ResultadoCrear {
  if (codigo === "CASO_BLOQUEADO") return "bloqueado"
  if (codigo === "CONFIRMACION_REQUERIDA" || codigo === "AUTORIZACION_INVALIDA") return "pendiente"
  throw new ErrorDemo(`oc_crear devolvió un error inesperado: ${codigo}`)
}

async function ejecutarPaso(n: number, paso: Paso, registro: Record<string, Herramienta<never>>, raiz: string): Promise<PasoDemo> {
  const reloj = crearReloj(FECHA_REFERENCIA_DEMO)
  // Cada paso es un turno: la autorización solo vale en el turno en que se otorga.
  const ctx: ContextoTool = { directory: raiz, sessionId: SESION_DEMO, turnoId: `demo-turno-${n}`, reloj }
  const { caso } = paso

  // Cada tool recibe exactamente lo que devolvió la anterior (contrato PRD 6.2).
  const paquete = exigir(await llamar(registro, "oc_leer_paquete", { caso }, DataLeerPaquete, ctx), `${caso} leer`)
  const v = exigir(await llamar(registro, "oc_validar", { caso, paquete }, DataValidar, ctx), `${caso} validar`)

  let construido: DataConstruirPayload | null = null
  if (v.apta) {
    exigir(await llamar(registro, "oc_generar_evidencia", { caso }, DataEvidencia, ctx), `${caso} evidencia`)
    construido = exigir(await llamar(registro, "oc_construir_payload", { caso, paquete, derivados: v.derivados }, DataConstruirPayload, ctx), `${caso} payload`)
  }

  const autorizado = paso.autorizar && construido !== null
  const ctxCrear: ContextoTool =
    autorizado && construido !== null ? { ...ctx, autorizacion: autorizacionSimulada(caso, construido.payload_sha, ctx.turnoId, reloj()) } : ctx
  const argsCrear = construido === null ? { caso, payload: null } : { caso, payload: construido.payload, ...(autorizado ? { confirmado: true } : {}) }
  const r = await llamar(registro, "oc_crear", argsCrear, DataCrear, ctxCrear)

  return {
    n,
    caso,
    apta: v.apta,
    bloqueos: v.bloqueos.map((b) => b.regla),
    no_evaluables: v.controles.filter((c) => c.estado === "NO_EVALUABLE").map((c) => c.regla),
    confirmaciones: v.confirmaciones.map((c) => c.regla),
    retroactiva: v.retroactiva,
    derivados: v.derivados,
    autorizado,
    resultado: r.ok ? "exitoso" : clasificar(r.error.codigo),
    codigo: r.ok ? null : r.error.codigo,
    numero_oc: r.ok ? r.data.numero_oc : null,
    idempotente: r.ok ? r.data.idempotente : null,
  }
}

// ---------------------------------------------------------------------------
// Presentación (sin rutas absolutas, sin textos de correos)
// ---------------------------------------------------------------------------

const lista = (reglas: readonly string[]) => (reglas.length === 0 ? "—" : reglas.join(","))

function fila(celdas: readonly string[], anchos: readonly number[]): string {
  return celdas.map((c, i) => c.padEnd(anchos[i] ?? 0)).join(" | ").trimEnd()
}

function presentar(pasos: readonly PasoDemo[], resumen: ResultadoDemo["resumen"], artefactos: readonly string[]): string[] {
  const encabezado = ["#", "Caso", "Validación", "Bloqueos", "Confirmaciones", "Retroactiva", "Crear", "Número OC", "Idempotente"]
  const filas = pasos.map((p) => [
    String(p.n),
    p.caso,
    p.apta ? "apta" : "bloqueada",
    p.no_evaluables.length === 0 ? lista(p.bloqueos) : `${lista(p.bloqueos)} (${lista(p.no_evaluables)} no evaluable)`,
    lista(p.confirmaciones),
    p.retroactiva ? "sí" : "no",
    p.autorizado ? `${p.resultado} (autorizado)` : p.resultado,
    p.numero_oc ?? "—",
    p.idempotente === null ? "—" : p.idempotente ? "sí" : "no",
  ])
  const anchos = encabezado.map((h, i) => Math.max(h.length, ...filas.map((f) => (f[i] ?? "").length)))

  const lineas = [
    `Demo determinista · Reto 03 · fecha de referencia ${FECHA_REFERENCIA_DEMO} · sin LLM`,
    "",
    fila(encabezado, anchos),
    anchos.map((a) => "-".repeat(a)).join("-|-"),
    ...filas.map((f) => fila(f, anchos)),
    "",
  ]
  const conDerivados = new Map<string, Derivados>()
  for (const p of pasos) if (Object.keys(p.derivados).length > 0) conDerivados.set(p.caso, p.derivados)
  for (const [caso, d] of conDerivados) {
    const partes = [
      d.indicador_iva ? `indicador_iva=${d.indicador_iva.valor}` : null,
      d.condiciones_pago ? `condiciones_pago=${d.condiciones_pago.valor}` : null,
      d.proveedor_por_nombre ? `proveedor=${d.proveedor_por_nombre.codigo_sap} (por nombre)` : null,
    ].filter((x) => x !== null)
    lineas.push(`Derivados ${caso}: ${partes.join(", ")} (fuente: maestro.proveedores)`)
  }
  lineas.push(
    "",
    `OCs creadas: ${resumen.ocs_creadas}`,
    `Pendientes finales: ${resumen.pendientes_finales}`,
    `Bloqueados: ${resumen.bloqueados}`,
    `Intentos registrados: ${resumen.intentos_registrados}`,
    "",
    "Artefactos:",
    ...artefactos.map((a) => `  ${a}`),
  )
  return lineas
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export async function ejecutarDemo(raiz: string = RAIZ_PROYECTO): Promise<ResultadoDemo> {
  await limpiarOut(raiz)
  const registro = registroOc(crearHerramientasOc())

  const pasos: PasoDemo[] = []
  for (const [i, paso] of PASOS.entries()) pasos.push(await ejecutarPaso(i + 1, paso, registro, raiz))

  // El resumen sale de los artefactos persistidos, no de la memoria de la demo.
  const control = await leerControl(raiz)
  const ordenes = await leerJsonl(raiz, ARCHIVOS.ordenes, OrdenRegistrada)
  const ultimoPorSolicitud = new Map(control.map((f) => [f.solicitud_id, f.resultado]))
  const resumen = {
    ocs_creadas: ordenes.length,
    pendientes_finales: [...ultimoPorSolicitud.values()].filter((r) => r === "pendiente").length,
    bloqueados: new Set(control.filter((f) => f.resultado === "bloqueado").map((f) => f.solicitud_id)).size,
    intentos_registrados: control.length,
  }

  const artefactos = [
    `out/${ARCHIVOS.control}`,
    `out/${ARCHIVOS.ordenes}`,
    `out/${ARCHIVOS.log}`,
    ...[...new Set(pasos.filter((p) => p.apta).map((p) => p.caso))].map((caso) => `out/${caso}/`),
  ]
  return { pasos, resumen, lineas: presentar(pasos, resumen, artefactos) }
}

if (import.meta.main) {
  try {
    const { lineas } = await ejecutarDemo()
    console.log(lineas.join("\n"))
  } catch (e) {
    console.error(`La demo falló: ${e instanceof Error ? e.message : "error desconocido"}`)
    process.exit(1)
  }
}
