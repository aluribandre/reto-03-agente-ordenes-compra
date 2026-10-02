// Utilidades de test. Los casos sintéticos viven en directorios temporales del SO:
// se copian desde fixtures/ (solo lectura) y se modifican fuera del repositorio.
import { createHash } from "node:crypto"
import { cp, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { RAIZ_PROYECTO } from "../src/config"
import { cargarCaso } from "../src/ingestion/cargar"
import type { ErrorTool, Paquete } from "../src/schemas"

export const FIXTURES_REALES = join(RAIZ_PROYECTO, "fixtures", "reto-03")
export const CASOS_REALES = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"] as const

export type RaizTemporal = {
  raiz: string
  ruta(caso: string, archivo: string): string
  leer(caso: string, archivo: string): Promise<string>
  escribir(caso: string, archivo: string, contenido: string): Promise<void>
  borrar(caso: string, archivo: string): Promise<void>
  limpiar(): Promise<void>
}

// Raíz de proyecto temporal con fixtures/reto-03/{maestros, solicitudes/<casos>} copiados.
export async function crearRaizTemporal(casos: readonly string[] = ["sol-001"]): Promise<RaizTemporal> {
  const raiz = await mkdtemp(join(tmpdir(), "reto03-test-"))
  const destino = join(raiz, "fixtures", "reto-03")
  await cp(join(FIXTURES_REALES, "maestros"), join(destino, "maestros"), { recursive: true })
  for (const caso of casos) {
    await cp(join(FIXTURES_REALES, "solicitudes", caso), join(destino, "solicitudes", caso), { recursive: true })
  }
  const ruta = (caso: string, archivo: string) => join(destino, "solicitudes", caso, archivo)
  return {
    raiz,
    ruta,
    leer: (caso, archivo) => readFile(ruta(caso, archivo), "utf8"),
    escribir: (caso, archivo, contenido) => writeFile(ruta(caso, archivo), contenido, "utf8"),
    borrar: (caso, archivo) => unlink(ruta(caso, archivo)),
    limpiar: () => rm(raiz, { recursive: true, force: true }),
  }
}

async function listarArchivos(dir: string): Promise<string[]> {
  const salida: string[] = []
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name)
    if (entrada.isDirectory()) salida.push(...(await listarArchivos(ruta)))
    else salida.push(ruta)
  }
  return salida.sort()
}

// Huella de un árbol de archivos (rutas relativas + contenido byte a byte).
export async function huellaArbol(dir: string): Promise<string> {
  const hash = createHash("sha256")
  for (const archivo of await listarArchivos(dir)) {
    const contenido = await readFile(archivo)
    hash.update(`${relative(dir, archivo)}\0${createHash("sha256").update(contenido).digest("hex")}\n`)
  }
  return hash.digest("hex")
}

// Reescribe todos los archivos de un directorio con saltos de línea CRLF.
export async function convertirACrlf(dir: string): Promise<void> {
  for (const archivo of await listarArchivos(dir)) {
    const texto = await readFile(archivo, "utf8")
    await writeFile(archivo, texto.replace(/\r?\n/g, "\r\n"), "utf8")
  }
}

export async function cargarOk(caso: string, raiz?: string): Promise<Paquete> {
  const r = await cargarCaso(caso, raiz === undefined ? {} : { raiz })
  if (!r.ok) throw new Error(`se esperaba ok para ${caso}: ${r.error.codigo} — ${r.error.mensaje}`)
  return r.data
}

export async function cargarError(caso: unknown, raiz?: string): Promise<ErrorTool> {
  const r = await cargarCaso(caso, raiz === undefined ? {} : { raiz })
  if (r.ok) throw new Error(`se esperaba error para ${String(caso)}`)
  return r.error
}
