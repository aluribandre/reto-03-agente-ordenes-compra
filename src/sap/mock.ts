// SAP simulado sobre out/sap/ordenes.jsonl (PRD 7.4).
// - Numeración secuencial desde 4500000001.
// - Idempotente por solicitud_id: crear dos veces devuelve la OC existente y no agrega líneas.
// - El estado vive solo en el archivo (no hay caché en memoria).
// - El candado es en proceso: válido para una sola instancia del mock/servidor.
import type { Reloj } from "../config"
import { fechaDe, normalizarNit } from "../domain/normalizar"
import { ARCHIVOS, appendJsonl, conCandado, leerJsonl, rutaEnOut } from "../persistencia"
import { OrdenCompra, OrdenRegistrada, type Proveedor } from "../schemas"
import type { SapAdapter } from "./adapter"

export const PRIMER_NUMERO_OC = 4_500_000_001

export type OpcionesMockSap = {
  raiz: string
  reloj: Reloj
  // Proveedores del maestro (fixtures/reto-03/maestros), ya cargados y validados.
  proveedores: readonly Proveedor[]
}

export class MockSapAdapter implements SapAdapter {
  readonly #opciones: OpcionesMockSap

  constructor(opciones: OpcionesMockSap) {
    this.#opciones = opciones
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const buscado = normalizarNit(nit)
    const proveedor = this.#opciones.proveedores.find((p) => normalizarNit(p.nit) === buscado)
    return proveedor === undefined ? null : { codigo_sap: proveedor.codigo_sap, activo: proveedor.activo }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const registrada = (await this.#leer()).find((r) => r.orden.referencia.solicitud_id === solicitud_id)
    return registrada === undefined ? null : { numero_oc: registrada.numero_oc }
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const valida = OrdenCompra.parse(orden)
    const clave = `sap:${rutaEnOut(this.#opciones.raiz, ARCHIVOS.ordenes)}`
    return conCandado(clave, async () => {
      const registradas = await this.#leer()
      const existente = registradas.find((r) => r.orden.referencia.solicitud_id === valida.referencia.solicitud_id)
      if (existente !== undefined) return { numero_oc: existente.numero_oc, fecha: existente.fecha }

      const fecha = fechaDe(this.#opciones.reloj())
      if (fecha === null) throw new Error("MockSapAdapter: el reloj no devolvió una fecha válida")
      const registro: OrdenRegistrada = { numero_oc: siguienteNumero(registradas), fecha, orden: valida }
      await appendJsonl(this.#opciones.raiz, ARCHIVOS.ordenes, registro)
      return { numero_oc: registro.numero_oc, fecha }
    })
  }

  async #leer(): Promise<OrdenRegistrada[]> {
    return leerJsonl(this.#opciones.raiz, ARCHIVOS.ordenes, OrdenRegistrada)
  }
}

function siguienteNumero(registradas: readonly OrdenRegistrada[]): string {
  const ultimo = registradas.reduce((max, r) => Math.max(max, Number(r.numero_oc)), PRIMER_NUMERO_OC - 1)
  return String(ultimo + 1)
}
