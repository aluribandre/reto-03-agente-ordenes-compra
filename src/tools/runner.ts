// Ejecutor común de tools: valida argumentos con zod, es la última defensa ante excepciones
// y deja una línea en out/log.jsonl por llamada (CA4). Siempre devuelve JSON serializado
// { ok: true, data } | { ok: false, error }, sin trazas ni rutas absolutas.
import { z } from "zod"
import type { Reloj } from "../config"
import { appendLog } from "../persistencia"
import { CodigoError, type Autorizacion, type ErrorTool, type LineaLog, type ResultadoTool } from "../schemas"

// Contexto de ejecución (PRD 6.2 + extensión documentada). El modelo nunca escribe en él:
// `autorizacion` solo la pone el runtime a partir de una acción del usuario (o demo.ts como humano simulado).
export type ContextoTool = {
  directory: string
  sessionId: string
  turnoId: string
  reloj: Reloj
  autorizacion?: Autorizacion
}

export type ArgsTool = Record<string, z.ZodType>

// Contrato PRD 6.2: description + args (zod) + execute → string JSON. Nunca lanza.
export type Herramienta<A = never> = {
  description: string
  args: ArgsTool
  execute(args: A, ctx: ContextoTool): Promise<string>
}

export type OpcionesRunner = {
  // Inyectable para que la demo y los tests sean deterministas.
  cronometro?: () => number
}

const MAX_RESUMEN = 200

function serializar(resultado: ResultadoTool<unknown>): string {
  return JSON.stringify(resultado)
}

function error(codigo: ErrorTool["codigo"], mensaje: string, sugerencia: string, detalle?: Record<string, unknown>): ResultadoTool<never> {
  return { ok: false, error: detalle ? { codigo, mensaje, sugerencia, detalle } : { codigo, mensaje, sugerencia } }
}

const ERROR_INTERNO = error("ERROR_INTERNO", "Error interno al ejecutar la herramienta.", "Reintentar; si persiste, revisar el registro del servidor.")

const Respuesta = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ codigo: z.string(), mensaje: z.string() }).loose() }),
])

function resumenDe(resultado: z.infer<typeof Respuesta>): string {
  const texto = resultado.ok
    ? typeof resultado.data === "object" && resultado.data !== null && "resumen" in resultado.data && typeof resultado.data.resumen === "string"
      ? resultado.data.resumen
      : "ok"
    : `${resultado.error.codigo}: ${resultado.error.mensaje}`
  return texto.length > MAX_RESUMEN ? `${texto.slice(0, MAX_RESUMEN - 1)}…` : texto
}

export async function ejecutarTool(
  nombre: string,
  herramienta: Herramienta<never>,
  argsCrudos: unknown,
  ctx: ContextoTool,
  opciones: OpcionesRunner = {},
): Promise<string> {
  const cronometro = opciones.cronometro ?? (() => performance.now())
  const inicio = cronometro()
  // Estricto: un argumento no documentado es un error, no se descarta en silencio.
  const args = z.object(herramienta.args).strict().safeParse(argsCrudos)

  let salida: string
  if (!args.success) {
    salida = serializar(
      error("ARGS_INVALIDOS", "Argumentos inválidos para la herramienta.", "Revisar los argumentos según la descripción de la herramienta.", {
        campos: args.error.issues.map((i) => (i.path.length > 0 ? i.path.map(String).join(".") : "(raíz)")),
      }),
    )
  } else {
    try {
      salida = await herramienta.execute(args.data as never, ctx)
    } catch {
      salida = serializar(ERROR_INTERNO)
    }
  }

  let resultado: z.infer<typeof Respuesta>
  try {
    const r = Respuesta.safeParse(JSON.parse(salida))
    if (!r.success) throw new Error("respuesta fuera de contrato")
    resultado = r.data
  } catch {
    salida = serializar(ERROR_INTERNO)
    resultado = { ok: false, error: { codigo: "ERROR_INTERNO", mensaje: "Error interno al ejecutar la herramienta." } }
  }

  // Solo se registra `caso` si pasó la validación de argumentos (nunca texto arbitrario del modelo).
  const caso = args.success && typeof args.data["caso"] === "string" ? args.data["caso"] : null
  const linea: LineaLog = {
    ts: ctx.reloj(),
    sesion: ctx.sessionId,
    herramienta: nombre,
    caso,
    ok: resultado.ok,
    resumen: resumenDe(resultado),
    duracion_ms: Math.max(0, Math.round(cronometro() - inicio)),
  }
  if (!resultado.ok) {
    const codigo = CodigoError.safeParse(resultado.error.codigo)
    linea.codigo_error = codigo.success ? codigo.data : "ERROR_INTERNO"
  }

  // El log nunca invalida el resultado principal ni mata la sesión.
  try {
    await appendLog(ctx.directory, linea)
  } catch {
    console.warn(`[runner] no se pudo escribir out/log.jsonl para ${nombre}`)
  }
  return salida
}
