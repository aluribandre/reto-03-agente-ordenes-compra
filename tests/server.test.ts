// F10: API HTTP sobre el runtime real, con un LLM guionado (sin red, sin puerto: app.fetch en memoria).
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { cargarSistema } from "../src/agent/loop"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO, crearReloj } from "../src/config"
import type { DefinicionTool, LlamadaTool, LlmAdapter, Mensaje, RespuestaLlm, ResultadoLlamada } from "../src/llm/adapter"
import { leerJsonl } from "../src/persistencia"
import { OrdenRegistrada } from "../src/schemas"
import { crearApp } from "../src/server"
import { registroOc } from "../src/tools/oc"
import { CASOS_REALES, FIXTURES_REALES, crearRaizTemporal, huellaArbol, type RaizTemporal } from "./helpers"

// ---------------------------------------------------------------------------
// LLM guionado
// ---------------------------------------------------------------------------

type Paso = RespuestaLlm | ((mensajes: readonly Mensaje[]) => RespuestaLlm)

class LlmGuionado implements LlmAdapter {
  readonly proveedor = "guion"
  readonly modelo = "guion-1"
  readonly #pasos: Paso[]
  constructor(pasos: Paso[]) {
    this.#pasos = [...pasos]
  }
  async enviar(mensajes: readonly Mensaje[], _h: readonly DefinicionTool[], _s: string): Promise<RespuestaLlm> {
    const paso = this.#pasos.shift()
    if (paso === undefined) throw new Error("guion agotado")
    return typeof paso === "function" ? paso(mensajes) : paso
  }
}

const USO = { entrada: 10, salida: 5, cacheEscritura: 0, cacheLectura: 0 }
let secuencia = 0
const llamada = (nombre: string, argumentos: unknown): LlamadaTool => ({ id: `toolu_${++secuencia}`, nombre, argumentos })
const pideTools = (...llamadas: LlamadaTool[]): RespuestaLlm => ({ texto: "", llamadas, motivo: "uso_tool", uso: USO, crudo: undefined })
const responde = (texto: string): RespuestaLlm => ({ texto, llamadas: [], motivo: "fin_turno", uso: USO, crudo: undefined })

function ultimo(mensajes: readonly Mensaje[]): ResultadoLlamada | undefined {
  const m = mensajes.at(-1)
  return m?.rol === "resultados" ? m.resultados[0] : undefined
}
function dato(r: ResultadoLlamada | undefined, campo: string): string {
  const crudo: unknown = JSON.parse(r?.contenido ?? "{}")
  const data = typeof crudo === "object" && crudo !== null && "data" in crudo ? crudo.data : undefined
  const valor: unknown = typeof data === "object" && data !== null ? Reflect.get(data, campo) : undefined
  return String(valor)
}
function shaDeNota(mensajes: readonly Mensaje[]): string {
  const u = [...mensajes].reverse().find((m) => m.rol === "usuario")
  return (u?.rol === "usuario" ? /payload_sha=([a-f0-9]{64})/.exec(u.texto)?.[1] : undefined) ?? ""
}

const flujo = (caso: string, cierre: string): Paso[] => [
  pideTools(llamada("oc_leer_paquete", { caso })),
  pideTools(llamada("oc_validar", { caso })),
  pideTools(llamada("oc_generar_evidencia", { caso })),
  pideTools(llamada("oc_construir_payload", { caso })),
  (m) => pideTools(llamada("oc_crear", { caso, payload_sha: dato(ultimo(m), "payload_sha") })),
  (m) => responde(cierre.replace("{OC}", dato(ultimo(m), "numero_oc"))),
]
const crearConfirmado = (caso: string): Paso[] => [
  (m) => pideTools(llamada("oc_crear", { caso, payload_sha: shaDeNota(m) })),
  (m) => responde(`OC ${dato(ultimo(m), "numero_oc")} creada.`),
]

// ---------------------------------------------------------------------------
// Esquemas de respuesta (estrictos: verifican que no se filtren campos internos)
// ---------------------------------------------------------------------------

const Turno = z
  .object({
    sessionId: z.string(),
    respuesta: z.string(),
    estado: z.string(),
    eventos: z.array(
      z.object({ tipo: z.literal("tool"), herramienta: z.string(), caso: z.string().nullable(), ok: z.boolean(), codigo_error: z.string().nullable(), resumen: z.string() }).strict(),
    ),
    needsConfirmation: z.boolean(),
    pendingConfirmation: z.object({ caso: z.string(), payload_sha: z.string(), reglas: z.array(z.string()) }).strict().nullable(),
    autorizacion: z.object({ id: z.string(), origen: z.string(), consumida: z.boolean() }).strict().nullable(),
  })
  .strict()
const RespTurno = z.object({ ok: z.literal(true), data: Turno }).strict()
const RespError = z.object({ ok: z.literal(false), error: z.object({ codigo: z.string(), mensaje: z.string() }).strict() }).strict()

// ---------------------------------------------------------------------------

const DIR_OUT_REAL = join(RAIZ_PROYECTO, "out")
let sistema = ""
let huellaInicialFixtures = ""
let outRealExistia = false
const raices: RaizTemporal[] = []
const textos: string[] = [] // todo lo que devolvió la API (para el test de rutas absolutas)

beforeAll(async () => {
  sistema = await cargarSistema(RAIZ_PROYECTO)
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outRealExistia = existsSync(DIR_OUT_REAL)
})
afterEach(async () => {
  for (const r of raices.splice(0)) await r.limpiar()
})

async function app(pasos: Paso[] | null, raiz?: string) {
  let directorio = raiz
  if (directorio === undefined) {
    const t = await crearRaizTemporal(CASOS_REALES)
    raices.push(t)
    directorio = t.raiz
  }
  const a = crearApp({
    raiz: directorio,
    llm: pasos === null ? null : new LlmGuionado(pasos),
    herramientas: registroOc(),
    sistema,
    reloj: crearReloj(FECHA_REFERENCIA_DEMO),
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    version: "0.1.0-test",
    cronometro: () => 0,
  })
  return { a, raiz: directorio }
}

type App = Awaited<ReturnType<typeof app>>["a"]

async function pedir(a: App, ruta: string, init?: RequestInit): Promise<{ status: number; cuerpo: unknown; texto: string; tipo: string }> {
  const res = await a.fetch(new Request(`http://local${ruta}`, init))
  const texto = await res.text()
  textos.push(texto)
  let cuerpo: unknown = null
  try {
    cuerpo = JSON.parse(texto)
  } catch {}
  return { status: res.status, cuerpo, texto, tipo: res.headers.get("content-type") ?? "" }
}
const post = (a: App, ruta: string, cuerpo: unknown) =>
  pedir(a, ruta, { method: "POST", headers: { "content-type": "application/json" }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) })

const SA = "sesion-aaaa-0001"
const SB = "sesion-bbbb-0002"
const ordenes = (raiz: string) => leerJsonl(raiz, "sap/ordenes.jsonl", OrdenRegistrada)

// ---------------------------------------------------------------------------

describe("salud y validación", () => {
  test("A/L. /api/health funciona sin LLM y no expone secretos, entorno ni rutas", async () => {
    const anterior = process.env["ANTHROPIC_API_KEY"]
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-secreto-de-prueba"
    try {
      const { a } = await app(null, RAIZ_PROYECTO)
      const r = await pedir(a, "/api/health")
      expect(r.status).toBe(200)
      expect(r.cuerpo).toEqual({ ok: true, servicio: "oc-agent", version: "0.1.0-test", llmConfigured: false })
      for (const prohibido of ["sk-ant", "ANTHROPIC", RAIZ_PROYECTO, RAIZ_PROYECTO.replaceAll("\\", "/"), "claude-"]) expect(r.texto).not.toContain(prohibido)
      const conLlm = await app([], RAIZ_PROYECTO)
      expect((await pedir(conLlm.a, "/api/health")).cuerpo).toMatchObject({ llmConfigured: true })
    } finally {
      if (anterior === undefined) delete process.env["ANTHROPIC_API_KEY"]
      else process.env["ANTHROPIC_API_KEY"] = anterior
    }
  })

  test("B. /api/chat con entrada inválida → 400/413/415 saneados", async () => {
    const { a } = await app([])
    for (const cuerpo of [{}, { sessionId: SA }, { sessionId: SA, message: "" }, { sessionId: SA, message: "x".repeat(2001) }, { sessionId: SA, message: "hola", extra: 1 }]) {
      const r = await post(a, "/api/chat", cuerpo)
      expect(r.status).toBe(400)
      expect(RespError.parse(r.cuerpo).error.codigo).toBe("ENTRADA_INVALIDA")
    }
    expect((await post(a, "/api/chat", "{ roto")).status).toBe(400)
    expect((await pedir(a, "/api/chat", { method: "POST", headers: { "content-type": "text/plain" }, body: "hola" })).status).toBe(415)
    expect((await post(a, "/api/chat", { sessionId: SA, message: "x".repeat(20_000) })).status).toBe(413)
    expect((await pedir(a, "/api/chat")).status).toBe(405)
  })

  test("C. sessionId inválido → 400", async () => {
    const { a } = await app([])
    for (const sessionId of ["../x", "corto", "a".repeat(65), "sesion con espacios", "sesion/../../x"]) {
      expect((await post(a, "/api/chat", { sessionId, message: "hola" })).status).toBe(400)
    }
    expect((await pedir(a, "/api/sessions/..%2F..%2Fx")).status).toBe(400)
  })
})

describe("flujos de negocio por la API", () => {
  test("D. chat sol-001 → OC creada; eventos para tool cards sin argumentos ni crudo", async () => {
    const { a, raiz } = await app(flujo("sol-001", "OC {OC} creada."))
    const r = await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-001" })
    expect(r.status).toBe(200)
    const d = RespTurno.parse(r.cuerpo).data
    expect(d).toMatchObject({ estado: "completado", respuesta: "OC 4500000001 creada.", needsConfirmation: false, pendingConfirmation: null })
    expect(d.eventos.map((e) => [e.herramienta, e.caso, e.ok])).toEqual([
      ["oc_leer_paquete", "sol-001", true],
      ["oc_validar", "sol-001", true],
      ["oc_generar_evidencia", "sol-001", true],
      ["oc_construir_payload", "sol-001", true],
      ["oc_crear", "sol-001", true],
    ])
    expect(await ordenes(raiz)).toHaveLength(1)
  })

  test("E/F/M. sol-004 → needsConfirmation; /api/confirm → OC; GET /api/sessions recupera el estado", async () => {
    const { a, raiz } = await app([...flujo("sol-004", "¿Confirmas crear la OC?"), ...crearConfirmado("sol-004")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    expect(t1).toMatchObject({ needsConfirmation: true, pendingConfirmation: { caso: "sol-004", reglas: ["RC5"] } })
    expect(t1.eventos.at(-1)).toMatchObject({ herramienta: "oc_crear", ok: false, codigo_error: "CONFIRMACION_REQUERIDA" })

    const sesion = await pedir(a, `/api/sessions/${SA}`)
    expect(sesion.status).toBe(200)
    expect(sesion.cuerpo).toMatchObject({ ok: true, data: { sessionId: SA, needsConfirmation: true, pendingConfirmation: { caso: "sol-004" }, ultimoEstado: "completado" } })
    expect(sesion.texto).not.toContain("[Runtime]")

    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    const t2 = await post(a, "/api/confirm", { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: sha })
    expect(t2.status).toBe(200)
    expect(RespTurno.parse(t2.cuerpo).data).toMatchObject({
      estado: "completado",
      respuesta: "OC 4500000001 creada.",
      needsConfirmation: false,
      autorizacion: { origen: "boton", consumida: true },
    })
    expect(await ordenes(raiz)).toHaveLength(1)
    expect((await pedir(a, `/api/sessions/${SA}`)).cuerpo).toMatchObject({ data: { needsConfirmation: false, pendingConfirmation: null } })
    expect((await pedir(a, "/api/sessions/sesion-que-no-existe")).status).toBe(404)
  })

  test("G/H. confirm desde otra sesión o con otro payload → rechazado, sin OC", async () => {
    const { a, raiz } = await app([...flujo("sol-004", "¿Confirmas?"), responde("Hola.")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    const sha = t1.pendingConfirmation?.payload_sha ?? ""
    expect((await post(a, "/api/confirm", { sessionId: SB, action: "confirm", caso: "sol-004", payload_sha: sha })).status).toBe(404)
    await post(a, "/api/chat", { sessionId: SB, message: "hola" })
    const otra = RespTurno.parse((await post(a, "/api/confirm", { sessionId: SB, action: "confirm", caso: "sol-004", payload_sha: sha })).cuerpo).data
    expect(otra.estado).toBe("confirmacion_invalida")
    const malo = RespTurno.parse((await post(a, "/api/confirm", { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: "c".repeat(64) })).cuerpo).data
    expect(malo.estado).toBe("confirmacion_invalida")
    expect(await ordenes(raiz)).toEqual([])
  })

  test("I. doble confirm concurrente → una sola OC", async () => {
    const { a, raiz } = await app([...flujo("sol-004", "¿Confirmas?"), ...crearConfirmado("sol-004")])
    const t1 = RespTurno.parse((await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-004" })).cuerpo).data
    const evento = { sessionId: SA, action: "confirm", caso: "sol-004", payload_sha: t1.pendingConfirmation?.payload_sha ?? "" }
    const [x, y] = await Promise.all([post(a, "/api/confirm", evento), post(a, "/api/confirm", evento)])
    const estados = [x, y].map((r) => RespTurno.parse(r.cuerpo).data.estado).sort()
    expect(estados).toEqual(["completado", "confirmacion_invalida"])
    expect(await ordenes(raiz)).toHaveLength(1)
  })

  test("J. proveedor no configurado → 503 controlado y el servidor sigue vivo", async () => {
    const { a } = await app(null)
    const r = await post(a, "/api/chat", { sessionId: SA, message: "Procesa sol-001" })
    expect(r.status).toBe(503)
    expect(RespError.parse(r.cuerpo).error).toEqual({ codigo: "LLM_NO_CONFIGURADO", mensaje: "El proveedor LLM no está configurado." })
    expect((await pedir(a, "/api/health")).status).toBe(200)
  })
})

describe("estáticos y saneamiento", () => {
  test("N. solo se sirven los estáticos de la lista blanca de web/", async () => {
    const { a } = await app(null, RAIZ_PROYECTO)
    const raiz = await pedir(a, "/")
    expect(raiz.status).toBe(200)
    expect(raiz.tipo).toContain("text/html")
    expect((await pedir(a, "/app.js")).tipo).toContain("javascript")
    expect((await pedir(a, "/styles.css")).tipo).toContain("text/css")
    for (const ruta of ["/../package.json", "/%2e%2e/package.json", "/web/app.js", "/package.json", "/src/server.ts", "/.env", "/fixtures/reto-03/maestros/proveedores.json"]) {
      const r = await pedir(a, ruta)
      expect([ruta, r.status]).toEqual([ruta, 404])
    }
    expect((await pedir(a, "/api/inexistente")).status).toBe(404)
  })

  test("K. ninguna respuesta de la API incluye rutas absolutas ni trazas", () => {
    expect(textos.length).toBeGreaterThan(20)
    const todo = textos.filter((t) => !t.startsWith("<!doctype") && !t.startsWith('"use strict"') && !t.startsWith(":root")).join("\n")
    const tmp = tmpdir()
    for (const prohibido of [RAIZ_PROYECTO, RAIZ_PROYECTO.replaceAll("\\", "/"), RAIZ_PROYECTO.replaceAll("\\", "\\\\"), tmp, tmp.replaceAll("\\", "\\\\"), "    at ", "Error:", "node_modules"]) {
      expect(todo).not.toContain(prohibido)
    }
  })

  test("fixtures/ intacto y out/ real sin modificar", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT_REAL)).toBe(outRealExistia)
  })
})
