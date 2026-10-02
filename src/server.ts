// API HTTP mínima (PRD 6.4) + estáticos de web/. Bun.serve, sin frameworks.
// El servidor no contiene lógica de negocio ni construye autorizaciones: entrega cada
// mensaje o evento de botón al mismo runtime (ejecutarTurno). El sessionId identifica
// una sesión de navegador; NO es una identidad verificada (no hay autenticación).
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { cargarSistema, ejecutarTurno, type EstadoTurno, type OpcionesAgente, type ResultadoTurno } from "./agent/loop"
import { AlmacenSesiones, type EventoTool, type Sesion } from "./agent/sesiones"
import { cargarConfig, type Reloj } from "./config"
import type { LlmAdapter } from "./llm/adapter"
import { AnthropicAdapter } from "./llm/anthropic"
import { conCandado } from "./persistencia"
import { payloadSha } from "./domain/sello"
import { Caso, Derivados, OrdenCompra, Paquete, Sha256 } from "./schemas"
import { registroOc } from "./tools/oc"
import type { Herramienta } from "./tools/runner"

export const SERVICIO = "oc-agent"
const MAX_BODY = 16 * 1024
const MAX_MENSAJE = 2000

export type OpcionesApp = {
  raiz: string
  llm: LlmAdapter | null
  herramientas: Record<string, Herramienta<never>>
  sistema: string
  reloj: Reloj
  maxIteraciones: number
  maxTokensSesion: number
  version: string
  cronometro?: () => number
}

const SessionId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/)
const PeticionChat = z.object({ sessionId: SessionId, message: z.string().trim().min(1).max(MAX_MENSAJE) }).strict()
const PeticionConfirm = z.object({ sessionId: SessionId, action: z.literal("confirm"), caso: Caso, payload_sha: Sha256 }).strict()

// Lista blanca de estáticos: el navegador nunca elige una ruta del disco.
const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/index.html": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "styles.css", tipo: "text/css; charset=utf-8" },
}

const CABECERAS_SEGURIDAD = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

function json(status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CABECERAS_SEGURIDAD },
  })
}

const error = (status: number, codigo: string, mensaje: string): Response => json(status, { ok: false, error: { codigo, mensaje } })

class ErrorHttp extends Error {
  constructor(readonly respuesta: Response) {
    super("http")
  }
}

async function leerCuerpo(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new ErrorHttp(error(415, "CONTENT_TYPE_INVALIDO", "El cuerpo debe ser JSON (Content-Type: application/json)."))
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) {
    throw new ErrorHttp(error(413, "CUERPO_DEMASIADO_GRANDE", "La petición excede el tamaño máximo permitido."))
  }
  const texto = await req.text()
  if (texto.length > MAX_BODY) throw new ErrorHttp(error(413, "CUERPO_DEMASIADO_GRANDE", "La petición excede el tamaño máximo permitido."))
  try {
    return JSON.parse(texto)
  } catch {
    throw new ErrorHttp(error(400, "JSON_INVALIDO", "El cuerpo no es JSON válido."))
  }
}

function validar<T>(esquema: z.ZodType<T>, valor: unknown): T {
  const r = esquema.safeParse(valor)
  if (!r.success) {
    const campos = [...new Set(r.error.issues.map((i) => i.path.map(String).join(".") || "(cuerpo)"))]
    throw new ErrorHttp(error(400, "ENTRADA_INVALIDA", `Entrada inválida: ${campos.join(", ")}.`))
  }
  return r.data
}

// ---------------------------------------------------------------------------
// Proyección segura para la UI (sin argumentos completos, sin crudo, sin rutas)
// ---------------------------------------------------------------------------

export type ValorArgumento = string | number | boolean | null | Record<string, string | number | null>
export type EventoUI = {
  tipo: "tool"
  herramienta: string
  caso: string | null
  argumentos: Record<string, ValorArgumento>
  ok: boolean
  codigo_error: string | null
  resumen: string
}

const ArgsConCaso = z.object({ caso: Caso }).loose()
const NO_VALIDO = "(no válido)"
const MAX_CLAVES_VISIBLES = 10

// Argumentos de una llamada a tool tal como los recibió (PRD 6.1), en una forma segura:
// valores simples tal cual; objetos grandes por identificadores o hash. Nunca textos de
// documentos, rutas ni objetos internos completos.
function argumentoVisible(clave: string, valor: unknown): ValorArgumento {
  switch (clave) {
    case "caso": {
      const r = Caso.safeParse(valor)
      return r.success ? r.data : NO_VALIDO
    }
    case "confirmado":
      return typeof valor === "boolean" ? valor : NO_VALIDO
    case "paquete": {
      const r = Paquete.safeParse(valor)
      if (!r.success) return NO_VALIDO
      const s = r.data.solicitud
      return { solicitud_id: s.solicitud_id, proveedor_nit: s.proveedor_nit ?? null, valor_total: s.valor_total, moneda: s.moneda }
    }
    case "derivados": {
      const r = Derivados.safeParse(valor)
      if (!r.success) return NO_VALIDO
      const d = r.data
      return {
        ...(d.indicador_iva ? { indicador_iva: d.indicador_iva.valor } : {}),
        ...(d.condiciones_pago ? { condiciones_pago: d.condiciones_pago.valor } : {}),
        ...(d.proveedor_por_nombre ? { proveedor_por_nombre: d.proveedor_por_nombre.codigo_sap } : {}),
      }
    }
    case "payload": {
      if (valor === null) return null
      const r = OrdenCompra.safeParse(valor)
      return r.success ? { payload_sha: payloadSha(r.data) } : NO_VALIDO
    }
    default:
      return "(argumento no admitido)"
  }
}

function argumentosVisibles(argumentos: unknown): Record<string, ValorArgumento> {
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) return {}
  const visibles: Record<string, ValorArgumento> = {}
  for (const [clave, valor] of Object.entries(argumentos).slice(0, MAX_CLAVES_VISIBLES)) {
    // Una clave arbitraria del modelo no se refleja tal cual.
    visibles[/^[a-z_]{1,32}$/.test(clave) ? clave : "(clave no válida)"] = argumentoVisible(clave, valor)
  }
  return visibles
}

function aEventoUI(e: EventoTool): EventoUI {
  const args = ArgsConCaso.safeParse(e.argumentos)
  return {
    tipo: "tool",
    herramienta: e.herramienta,
    caso: args.success ? args.data.caso : null,
    argumentos: argumentosVisibles(e.argumentos),
    ok: e.ok,
    codigo_error: e.codigo_error,
    resumen: e.resumen,
  }
}

function vistaTurno(sessionId: string, r: ResultadoTurno) {
  return {
    sessionId,
    respuesta: r.respuesta,
    estado: r.estado,
    eventos: r.eventos.map(aEventoUI),
    needsConfirmation: r.needsConfirmation,
    pendingConfirmation: r.pendingConfirmation,
    autorizacion: r.autorizacion,
  }
}

const NOTA_RUNTIME = /\n\n\[Runtime\][\s\S]*$/

function historialVisible(s: Sesion): { rol: "usuario" | "agente"; texto: string }[] {
  const salida: { rol: "usuario" | "agente"; texto: string }[] = []
  for (const m of s.mensajes) {
    if (m.rol === "usuario") salida.push({ rol: "usuario", texto: m.texto.replace(NOTA_RUNTIME, "") })
    else if (m.rol === "asistente" && m.texto !== "") salida.push({ rol: "agente", texto: m.texto })
  }
  return salida
}

// ---------------------------------------------------------------------------
// Aplicación
// ---------------------------------------------------------------------------

export function crearApp(op: OpcionesApp) {
  const sesiones = new AlmacenSesiones()
  const ultimoEstado = new Map<string, EstadoTurno>()

  const agente = (llm: LlmAdapter): OpcionesAgente => ({
    llm,
    herramientas: op.herramientas,
    sistema: op.sistema,
    directorio: op.raiz,
    reloj: op.reloj,
    maxIteraciones: op.maxIteraciones,
    maxTokensSesion: op.maxTokensSesion,
    ...(op.cronometro === undefined ? {} : { cronometro: op.cronometro }),
  })

  async function turno(sesion: Sesion, entrada: Parameters<typeof ejecutarTurno>[1]): Promise<Response> {
    if (op.llm === null) return error(503, "LLM_NO_CONFIGURADO", "El proveedor LLM no está configurado.")
    const llm = op.llm
    // Un turno a la vez por sesión: evita intercalar mensajes o dobles clics concurrentes.
    const r = await conCandado(`sesion:${sesion.id}`, () => ejecutarTurno(sesion, entrada, agente(llm)))
    ultimoEstado.set(sesion.id, r.estado)
    if (r.estado === "error_llm") return error(503, "LLM_NO_DISPONIBLE", r.respuesta)
    return json(200, { ok: true, data: vistaTurno(sesion.id, r) })
  }

  async function estatico(ruta: string): Promise<Response> {
    const recurso = ESTATICOS[ruta]
    if (recurso === undefined) return error(404, "NO_ENCONTRADO", "Recurso no encontrado.")
    try {
      const contenido = await readFile(join(op.raiz, "web", recurso.archivo))
      return new Response(contenido, { status: 200, headers: { "Content-Type": recurso.tipo, "Cache-Control": "no-store", ...CABECERAS_SEGURIDAD } })
    } catch {
      return error(404, "NO_ENCONTRADO", "Recurso no encontrado.")
    }
  }

  async function manejar(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const ruta = url.pathname
    const metodo = req.method

    if (ruta === "/api/health") {
      if (metodo !== "GET") return error(405, "METODO_NO_PERMITIDO", "Método no permitido.")
      return json(200, { ok: true, servicio: SERVICIO, version: op.version, llmConfigured: op.llm !== null })
    }

    if (ruta === "/api/chat") {
      if (metodo !== "POST") return error(405, "METODO_NO_PERMITIDO", "Método no permitido.")
      const p = validar(PeticionChat, await leerCuerpo(req))
      return turno(sesiones.obtenerOCrear(p.sessionId), p.message)
    }

    if (ruta === "/api/confirm") {
      if (metodo !== "POST") return error(405, "METODO_NO_PERMITIDO", "Método no permitido.")
      const p = validar(PeticionConfirm, await leerCuerpo(req))
      const sesion = sesiones.obtener(p.sessionId)
      if (sesion === undefined) return error(404, "SESION_INEXISTENTE", "La sesión no existe.")
      // El servidor solo entrega el evento de botón al runtime de F9; no construye autorizaciones.
      return turno(sesion, { action: p.action, caso: p.caso, payload_sha: p.payload_sha })
    }

    const sesionRuta = /^\/api\/sessions\/([^/]+)$/.exec(ruta)
    if (sesionRuta !== null) {
      if (metodo !== "GET") return error(405, "METODO_NO_PERMITIDO", "Método no permitido.")
      const id = validar(SessionId, sesionRuta[1])
      const sesion = sesiones.obtener(id)
      if (sesion === undefined) return error(404, "SESION_INEXISTENTE", "La sesión no existe.")
      const p = sesion.pendiente
      return json(200, {
        ok: true,
        data: {
          sessionId: sesion.id,
          needsConfirmation: p !== null,
          pendingConfirmation: p === null ? null : { caso: p.caso, payload_sha: p.payload_sha, reglas: [...p.confirmaciones] },
          ultimoEstado: ultimoEstado.get(sesion.id) ?? null,
          historial: historialVisible(sesion),
          eventos: sesion.eventos.map(aEventoUI),
        },
      })
    }

    if (ruta.startsWith("/api/")) return error(404, "NO_ENCONTRADO", "Recurso no encontrado.")
    if (metodo !== "GET") return error(405, "METODO_NO_PERMITIDO", "Método no permitido.")
    return estatico(ruta)
  }

  return {
    sesiones,
    async fetch(req: Request): Promise<Response> {
      try {
        return await manejar(req)
      } catch (e) {
        if (e instanceof ErrorHttp) return e.respuesta
        return error(500, "ERROR_INTERNO", "Error interno del servidor.")
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Arranque (bun run src/server.ts). Arranca aunque no haya credenciales del LLM.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const config = cargarConfig()
  const conCredencial = [process.env["ANTHROPIC_API_KEY"], process.env["ANTHROPIC_AUTH_TOKEN"]].some((v) => (v ?? "").trim() !== "")
  const llm = conCredencial
    ? new AnthropicAdapter({
        modelo: config.llm.modelo,
        maxTokens: config.llm.maxTokens,
        timeoutMs: config.llm.timeoutMs,
        maxReintentos: config.llm.maxReintentos,
        esfuerzo: config.llm.esfuerzo,
      })
    : null
  const paquete = z.object({ version: z.string() }).loose().parse(JSON.parse(await readFile(join(config.raiz, "package.json"), "utf8")))
  const app = crearApp({
    raiz: config.raiz,
    llm,
    herramientas: registroOc(),
    sistema: await cargarSistema(config.raiz),
    reloj: config.reloj,
    maxIteraciones: config.limites.maxIteraciones,
    maxTokensSesion: config.limites.maxTokensSesion,
    version: paquete.version,
  })
  const servidor = Bun.serve({ port: config.puerto, maxRequestBodySize: MAX_BODY, fetch: app.fetch })
  console.log(`${SERVICIO} escuchando en http://localhost:${servidor.port} · LLM ${llm === null ? "no configurado" : "configurado"}`)
}
