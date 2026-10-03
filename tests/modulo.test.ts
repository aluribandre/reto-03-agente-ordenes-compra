// Bonus PRD 9.4: modulo/ empaqueta las MISMAS piezas que usa la aplicación (no copias divergentes)
// y sus tools funcionan sin el servidor, con el contexto mínimo de otra plataforma.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { piezas } from "../modulo/sincronizar"
import * as modulo from "../modulo/tools/oc"
import { FECHA_REFERENCIA_DEMO, RAIZ_PROYECTO } from "../src/config"
import { leerJsonl } from "../src/persistencia"
import { DataConstruirPayload, DataLeerPaquete, DataValidar, OrdenRegistrada, type Autorizacion } from "../src/schemas"
import * as app from "../src/tools/oc"
import { CASOS_REALES, FIXTURES_REALES, crearRaizTemporal, huellaArbol, type RaizTemporal } from "./helpers"

const MODULO = join(RAIZ_PROYECTO, "modulo")
let huellaInicialFixtures = ""
const raices: RaizTemporal[] = []

beforeAll(async () => {
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
})
afterEach(async () => {
  for (const r of raices.splice(0)) await r.limpiar()
})

// Frontmatter YAML simple (claves de primer nivel y un mapa anidado de un nivel) + cuerpo.
function frontmatter(texto: string): { campos: Record<string, string | Record<string, string>>; cuerpo: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(texto)
  if (m?.[1] === undefined || m[2] === undefined) throw new Error("sin frontmatter")
  const campos: Record<string, string | Record<string, string>> = {}
  let mapa: Record<string, string> | null = null
  for (const linea of m[1].split("\n")) {
    const anidada = /^ {2}([\w-]+):\s*(.+)$/.exec(linea)
    const raiz = /^([\w-]+):\s*(.*)$/.exec(linea)
    if (anidada?.[1] !== undefined && anidada[2] !== undefined && mapa !== null) mapa[anidada[1]] = anidada[2]
    else if (raiz?.[1] !== undefined) {
      if (raiz[2] === "") campos[raiz[1]] = mapa = {}
      else {
        campos[raiz[1]] = raiz[2] ?? ""
        mapa = null
      }
    }
  }
  return { campos, cuerpo: m[2] }
}

const leer = (rel: string) => readFile(join(RAIZ_PROYECTO, rel), "utf8")

describe("bonus modulo/ · estructura del PRD 9.4", () => {
  test("existen las tres piezas exigidas", () => {
    for (const rel of ["agent.md", "tools/oc.ts", "skill/ordenes-compra/SKILL.md"]) expect([rel, existsSync(join(MODULO, rel))]).toEqual([rel, true])
  })

  test("agent.md: frontmatter description, mode: primary, permission {edit: deny, bash: deny}; cuerpo = agent/prompt.md", async () => {
    const { campos, cuerpo } = frontmatter(await leer("modulo/agent.md"))
    expect(typeof campos["description"] === "string" && campos["description"].length > 20).toBe(true)
    expect(campos["mode"]).toBe("primary")
    expect(campos["permission"]).toEqual({ edit: "deny", bash: "deny" })
    expect(cuerpo).toBe(await leer("agent/prompt.md"))
  })

  test("SKILL.md: frontmatter name, description; cuerpo = src/knowledge/ordenes-compra.md", async () => {
    const { campos, cuerpo } = frontmatter(await leer("modulo/skill/ordenes-compra/SKILL.md"))
    expect(campos["name"]).toBe("ordenes-compra")
    expect(typeof campos["description"] === "string" && campos["description"].length > 20).toBe(true)
    expect(cuerpo).toBe(await leer("src/knowledge/ordenes-compra.md"))
  })

  test("sincronizar.ts: los archivos en disco son exactamente los generados desde las fuentes de la aplicación", async () => {
    for (const p of await piezas()) expect([p.destino, await leer(p.destino)]).toEqual([p.destino, p.contenido])
  })
})

describe("bonus modulo/ · tools: las mismas que la aplicación, sin servidor", () => {
  test("exporta las 5 tools con la misma description y los mismos esquemas args (identidad, no copia)", () => {
    const nombres = ["leer_paquete", "validar", "generar_evidencia", "construir_payload", "crear"] as const
    expect(Object.keys(modulo).filter((k) => k !== "default").sort()).toEqual([...nombres].sort())
    for (const n of nombres) {
      expect(modulo[n].description).toBe(app[n].description)
      expect(modulo[n].args).toBe(app[n].args)
    }
  })

  test("no importa el servidor ni el agente: solo dominio/tools de src", async () => {
    const fuente = await leer("modulo/tools/oc.ts")
    const importados = [...fuente.matchAll(/from "([^"]+)"/g)].map((m) => m[1])
    expect(importados.sort()).toEqual(["../../src/config", "../../src/schemas", "../../src/tools/oc", "../../src/tools/runner"])
    for (const prohibido of ["server", "agent/", "llm/"]) expect(fuente).not.toContain(prohibido)
  })

  test("con el contexto mínimo de una plataforma ({ directory, sessionId }): sol-001 crea la OC; sol-004 falla cerrado sin autorización", async () => {
    const t = await crearRaizTemporal(CASOS_REALES)
    raices.push(t)
    const ctx = { directory: t.raiz, sessionId: "plataforma-x" }
    const datos = async <S extends z.ZodType>(esquema: S, salida: Promise<string>) => esquema.parse(z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(await salida)).data)

    const flujo = async (caso: string) => {
      const paquete = await datos(DataLeerPaquete, modulo.leer_paquete.execute({ caso }, ctx))
      const v = await datos(DataValidar, modulo.validar.execute({ caso, paquete }, ctx))
      await modulo.generar_evidencia.execute({ caso }, ctx)
      return datos(DataConstruirPayload, modulo.construir_payload.execute({ caso, paquete, derivados: v.derivados }, ctx))
    }

    const p1 = await flujo("sol-001")
    expect(JSON.parse(await modulo.crear.execute({ caso: "sol-001", payload: p1.payload }, ctx))).toMatchObject({ ok: true, data: { numero_oc: "4500000001" } })

    const p4 = await flujo("sol-004")
    for (const confirmado of [undefined, true]) {
      const args = confirmado === undefined ? { caso: "sol-004", payload: p4.payload } : { caso: "sol-004", payload: p4.payload, confirmado }
      expect(JSON.parse(await modulo.crear.execute(args, ctx))).toMatchObject({ ok: false, error: { codigo: "CONFIRMACION_REQUERIDA" } })
    }
    expect(await leerJsonl(t.raiz, "sap/ordenes.jsonl", OrdenRegistrada)).toHaveLength(1)

    // Un runtime de confirmación del anfitrión puede entregar la autorización por ctx.
    const autorizacion: Autorizacion = {
      id: "aut-anfitrion",
      accion: "crear_oc",
      caso: "sol-004",
      payload_sha: p4.payload_sha,
      session_id: "plataforma-x",
      turno_id: "plataforma-x:t2",
      actor: "humano@anfitrion",
      origen: "boton",
      otorgada_en: FECHA_REFERENCIA_DEMO,
      consumida: false,
    }
    const conAut = JSON.parse(await modulo.crear.execute({ caso: "sol-004", payload: p4.payload, confirmado: true }, { ...ctx, turnoId: "plataforma-x:t2", autorizacion }))
    expect(conAut).toMatchObject({ ok: true, data: { numero_oc: "4500000002", autorizacion_id: "aut-anfitrion" } })
  })

  test("nunca lanza: argumentos inválidos o caso inexistente devuelven { ok: false, error }", async () => {
    const t = await crearRaizTemporal(CASOS_REALES)
    raices.push(t)
    const ctx = { directory: t.raiz, sessionId: "plataforma-x" }
    expect(JSON.parse(await modulo.leer_paquete.execute({ caso: "../x" }, ctx))).toMatchObject({ ok: false, error: { codigo: "ARGS_INVALIDOS" } })
    expect(JSON.parse(await modulo.leer_paquete.execute({ caso: "sol-999" }, ctx))).toMatchObject({ ok: false, error: { codigo: "CASO_INEXISTENTE" } })
  })

  test("fixtures/ intacto", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
  })
})
