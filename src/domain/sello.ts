// JSON canónico y hashes SHA-256. Puro y determinista: el resultado no depende del orden
// de inserción de claves, del orden de lectura de archivos ni del runtime.
import { createHash } from "node:crypto"
import type { OrdenCompra } from "../schemas"

// Claves de objeto ordenadas por código de unidad (independiente de locale); arreglos en su orden.
// Propiedades undefined se omiten (como JSON.stringify). Valores no representables en JSON son un error.
export function jsonCanonico(valor: unknown): string {
  if (valor === null) return "null"
  switch (typeof valor) {
    case "string":
    case "boolean":
      return JSON.stringify(valor)
    case "number":
      if (!Number.isFinite(valor)) throw new TypeError("jsonCanonico: número no finito")
      return JSON.stringify(valor)
    case "object": {
      if (Array.isArray(valor)) return `[${valor.map((v: unknown) => jsonCanonico(v === undefined ? null : v)).join(",")}]`
      const entradas = Object.entries(valor)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonCanonico(v)}`).join(",")}}`
    }
    default:
      throw new TypeError(`jsonCanonico: valor no serializable (${typeof valor})`)
  }
}

export function sha256Hex(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

// Hash del business payload. El payload sellado no contiene timestamps ni datos de ejecución.
export function payloadSha(orden: OrdenCompra): string {
  return sha256Hex(jsonCanonico(orden))
}
