import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { RAIZ_PROYECTO } from "../src/config"
import { ErrorInvarianteControles, evaluarControles, verificarInvariantes, type EvaluacionControles } from "../src/domain/controles"
import { cargarMaestros } from "../src/ingestion/cargar"
import type { EstadoControl, Maestros, Paquete, Regla, ResultadoControl } from "../src/schemas"
import { CASOS_REALES, FIXTURES_REALES, cargarOk, huellaArbol } from "./helpers"

const DIR_OUT = join(RAIZ_PROYECTO, "out")
let maestros: Maestros
const paquetes = new Map<string, Paquete>()
let huellaInicialFixtures = ""
let outExistiaAlInicio = false

beforeAll(async () => {
  huellaInicialFixtures = await huellaArbol(FIXTURES_REALES)
  outExistiaAlInicio = existsSync(DIR_OUT)
  const m = await cargarMaestros()
  if (!m.ok) throw new Error(`maestros: ${m.error.codigo}`)
  maestros = m.data
  for (const caso of CASOS_REALES) paquetes.set(caso, await cargarOk(caso))
})

function paquete(caso: string): Paquete {
  const p = paquetes.get(caso)
  if (p === undefined) throw new Error(`paquete no cargado: ${caso}`)
  return p
}

function evaluar(p: Paquete): EvaluacionControles {
  return evaluarControles(p, maestros)
}

function control(e: EvaluacionControles, regla: Regla): ResultadoControl {
  const c = e.controles.find((x) => x.regla === regla)
  if (c === undefined) throw new Error(`falta ${regla}`)
  return c
}

const reglas = (lista: { regla: Regla }[]) => lista.map((h) => h.regla)

// Variante en memoria de un paquete real (no toca fixtures/).
function variante(base: Paquete, cambio: (p: Paquete) => void): Paquete {
  const copia = structuredClone(base)
  cambio(copia)
  return copia
}

function congelarProfundo<T>(valor: T): T {
  if (typeof valor === "object" && valor !== null) {
    for (const v of Object.values(valor)) congelarProfundo(v)
    Object.freeze(valor)
  }
  return valor
}

// ---------------------------------------------------------------------------
// Casos reales: matriz exacta RC1–RC10
// ---------------------------------------------------------------------------

const C = "CUMPLE"
const MATRIZ: Record<string, EstadoControl[]> = {
  //          RC1        RC2        RC3             RC4  RC5             RC6             RC7         RC8             RC9  RC10
  "sol-001": [C,         C,         C,              C,   C,              C,              C,          "NO_APLICA",    C,   C],
  "sol-002": ["BLOQUEO", C,         C,              C,   C,              C,              C,          "NO_APLICA",    C,   C],
  "sol-003": [C,         "BLOQUEO", "NO_EVALUABLE", C,   C,              C,              C,          "NO_APLICA",    C,   C],
  "sol-004": [C,         C,         C,              C,   "CONFIRMACION", C,              C,          "NO_APLICA",    C,   C],
  "sol-005": [C,         C,         C,              C,   C,              C,              C,          "CONFIRMACION", C,   C],
  "sol-006": [C,         C,         C,              C,   C,              "CONFIRMACION", "DERIVADO", "NO_APLICA",    C,   C],
}

describe("casos reales", () => {
  for (const [caso, estados] of Object.entries(MATRIZ)) {
    test(`${caso}: estados RC1–RC10`, () => {
      const e = evaluar(paquete(caso))
      expect(e.controles.map((c) => c.regla)).toEqual(["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"])
      expect(e.controles.map((c) => c.estado)).toEqual(estados)
    })
  }

  test("sol-001: apta, sin bloqueos ni confirmaciones, RC8 NO_APLICA", () => {
    const e = evaluar(paquete("sol-001"))
    expect(e.apta).toBe(true)
    expect(e.bloqueos).toEqual([])
    expect(e.confirmaciones).toEqual([])
    expect(e.retroactiva).toBe(false)
    expect(e.derivados).toEqual({})
  })

  test("sol-002: bloqueada por RC1 (NIT 901999000 no existe)", () => {
    const e = evaluar(paquete("sol-002"))
    expect(e.apta).toBe(false)
    expect(reglas(e.bloqueos)).toEqual(["RC1"])
    expect(e.bloqueos[0]).toMatchObject({ motivo: "no_encontrado", accion_sugerida: "verificar_nit_o_tramitar_alta_proveedor" })
    expect(control(e, "RC1").valores_comparados).toMatchObject({ criterio: "nit", valor_buscado: "901999000", coincidencias: 0 })
  })

  test("sol-003: bloqueada por RC2; RC3 NO_EVALUABLE depende de RC2 y no entra en bloqueos", () => {
    const e = evaluar(paquete("sol-003"))
    expect(e.apta).toBe(false)
    expect(reglas(e.bloqueos)).toEqual(["RC2"])
    expect(e.bloqueos[0]?.motivo).toBe("aprobador_no_autorizado_en_cc")
    const rc3 = control(e, "RC3")
    expect(rc3.estado).toBe("NO_EVALUABLE")
    expect(rc3.depende_de).toBe("RC2")
    expect(rc3.valores_comparados).toMatchObject({ valor_total: 74_000_000, tope_aplicado: null, tope_maximo_en_cc: 30_000_000 })
  })

  test("sol-004: apta con confirmación RC5 por diferencia exacta de 6 %", () => {
    const e = evaluar(paquete("sol-004"))
    expect(e.apta).toBe(true)
    expect(e.bloqueos).toEqual([])
    expect(reglas(e.confirmaciones)).toEqual(["RC5"])
    expect(e.confirmaciones[0]?.valores).toMatchObject({
      valor_solicitud: 25_000_000,
      valor_cotizacion: 26_500_000,
      diferencia_absoluta: 1_500_000,
      diferencia_pct: 6,
    })
  })

  test("sol-005: apta con confirmación RC8 y retroactiva=true", () => {
    const e = evaluar(paquete("sol-005"))
    expect(e.apta).toBe(true)
    expect(reglas(e.confirmaciones)).toEqual(["RC8"])
    expect(e.retroactiva).toBe(true)
    expect(control(e, "RC8").valores_comparados).toMatchObject({ factura_fecha: "2026-08-10", fecha_solicitud: "2026-08-27" })
  })

  test("sol-006: apta con confirmación RC6; deriva C1 y Z030; proveedor por nombre", () => {
    const e = evaluar(paquete("sol-006"))
    expect(e.apta).toBe(true)
    expect(reglas(e.confirmaciones)).toEqual(["RC6"])
    expect(e.derivados).toEqual({
      indicador_iva: { valor: "C1", fuente: "maestro.proveedores" },
      condiciones_pago: { valor: "Z030", fuente: "maestro.proveedores" },
      proveedor_por_nombre: { codigo_sap: "100234", nit: "900555111", nombre: "TecnoSuministros S.A.S." },
    })
    expect(control(e, "RC1").valores_comparados).toMatchObject({ criterio: "nombre", codigo_sap: "100234" })
  })
})

// ---------------------------------------------------------------------------
// Sintéticos 1–7 (variantes en memoria de sol-001)
// ---------------------------------------------------------------------------

describe("sintéticos de controles", () => {
  test("1. RC4: subárea que no pertenece al centro de costo → BLOQUEO", () => {
    const e = evaluar(variante(paquete("sol-001"), (p) => (p.solicitud.subarea = "Compras")))
    expect(control(e, "RC4").estado).toBe("BLOQUEO")
    expect(e.apta).toBe(false)
    expect(reglas(e.bloqueos)).toEqual(["RC4"])
  })

  test("2. RC9: aprobación anterior a la solicitud → CONFIRMACION", () => {
    const e = evaluar(
      variante(paquete("sol-001"), (p) => {
        if (p.aprobacion) p.aprobacion.fecha = "2026-08-19T10:00:00-05:00"
      }),
    )
    expect(control(e, "RC9").estado).toBe("CONFIRMACION")
    expect(e.apta).toBe(true)
    expect(reglas(e.confirmaciones)).toEqual(["RC9"])
  })

  test("3. RC10: diferencia 1 → CUMPLE; diferencia 2 → BLOQUEO", () => {
    const uno = evaluar(variante(paquete("sol-001"), (p) => (p.solicitud.valor_total = 11_400_001)))
    expect(control(uno, "RC10").estado).toBe("CUMPLE")
    const dos = evaluar(variante(paquete("sol-001"), (p) => (p.solicitud.valor_total = 11_400_002)))
    expect(control(dos, "RC10").estado).toBe("BLOQUEO")
    expect(reglas(dos.bloqueos)).toEqual(["RC10"])
  })

  test("4. RC1: proveedor inactivo → BLOQUEO", () => {
    const e = evaluar(variante(paquete("sol-001"), (p) => (p.solicitud.proveedor_nit = "901777888")))
    expect(control(e, "RC1")).toMatchObject({ estado: "BLOQUEO", motivo: "inactivo" })
    expect(reglas(e.bloqueos)).toEqual(["RC1"])
  })

  // F11: bordes. sol-001 vale 11.400.000 → el 2 % es exactamente 228.000.
  test("F11-A/B/C. RC5: ±2 % exacto → CUMPLE; +1 unidad por encima → CONFIRMACION", () => {
    const conCotizacion = (total: number) =>
      control(
        evaluar(
          variante(paquete("sol-001"), (p) => {
            if (p.cotizacion) p.cotizacion.total = total
          }),
        ),
        "RC5",
      ).estado
    expect(conCotizacion(11_628_000)).toBe("CUMPLE")
    expect(conCotizacion(11_172_000)).toBe("CUMPLE")
    expect(conCotizacion(11_628_001)).toBe("CONFIRMACION")
    expect(conCotizacion(11_171_999)).toBe("CONFIRMACION")
  })

  test("F11-D. cotización ausente → RC5 CONFIRMACION (sin_cotizacion)", () => {
    const e = evaluar(variante(paquete("sol-001"), (p) => (p.cotizacion = null)))
    expect(control(e, "RC5")).toMatchObject({ estado: "CONFIRMACION", motivo: "sin_cotizacion" })
    expect(e.apta).toBe(true)
  })

  test("F11-E/F. sin IVA ni pago y proveedor no resuelto → RC6 y RC7 NO_EVALUABLE dependientes de RC1", () => {
    const e = evaluar(
      variante(paquete("sol-001"), (p) => {
        p.solicitud.proveedor_nit = "901999000"
        delete p.solicitud.indicador_iva
        delete p.solicitud.condiciones_pago
      }),
    )
    expect(control(e, "RC1").estado).toBe("BLOQUEO")
    expect(control(e, "RC6")).toMatchObject({ estado: "NO_EVALUABLE", depende_de: "RC1" })
    expect(control(e, "RC7")).toMatchObject({ estado: "NO_EVALUABLE", depende_de: "RC1" })
    expect(reglas(e.bloqueos)).toEqual(["RC1"])
    expect(e.derivados).toEqual({})
  })

  test("F11-G. factura con la misma fecha que la solicitud → no retroactiva", () => {
    const e = evaluar(
      variante(paquete("sol-005"), (p) => {
        if (p.factura) p.factura.fecha = p.solicitud.fecha_solicitud
      }),
    )
    expect(control(e, "RC8").estado).toBe("CUMPLE")
    expect(e.retroactiva).toBe(false)
  })

  test("F11-H. RC3 exactamente en el tope del aprobador → CUMPLE", () => {
    const e = evaluar(
      variante(paquete("sol-001"), (p) => {
        p.solicitud.cantidad = 1
        p.solicitud.valor_unitario = 50_000_000
        p.solicitud.valor_total = 50_000_000
        if (p.cotizacion) p.cotizacion.total = 50_000_000
      }),
    )
    expect(control(e, "RC3")).toMatchObject({ estado: "CUMPLE", valores_comparados: { tope_aplicado: 50_000_000 } })
    expect(e.apta).toBe(true)
  })

  test("5. aprobación ausente → RC2 BLOQUEO; RC3 y RC9 NO_EVALUABLE dependientes de RC2", () => {
    const e = evaluar(variante(paquete("sol-001"), (p) => (p.aprobacion = null)))
    expect(control(e, "RC2")).toMatchObject({ estado: "BLOQUEO", motivo: "sin_aprobacion" })
    expect(control(e, "RC3")).toMatchObject({ estado: "NO_EVALUABLE", depende_de: "RC2" })
    expect(control(e, "RC9")).toMatchObject({ estado: "NO_EVALUABLE", depende_de: "RC2" })
    expect(reglas(e.bloqueos)).toEqual(["RC2"])
    expect(e.apta).toBe(false)
  })

  test("6. texto sin 'Aprobado' → RC2 BLOQUEO", () => {
    const e = evaluar(
      variante(paquete("sol-001"), (p) => {
        if (p.aprobacion) {
          p.aprobacion.texto = "Revisado, queda pendiente."
          p.aprobacion.aprobado = false
        }
      }),
    )
    expect(control(e, "RC2")).toMatchObject({ estado: "BLOQUEO", motivo: "sin_palabra_aprobado" })
    expect(e.apta).toBe(false)
  })

  test("7. aprobador válido que supera su tope → RC3 BLOQUEO", () => {
    const e = evaluar(
      variante(paquete("sol-001"), (p) => {
        p.solicitud.cantidad = 600
        p.solicitud.valor_total = 57_000_000
        if (p.cotizacion) p.cotizacion.total = 57_000_000
      }),
    )
    expect(control(e, "RC3")).toMatchObject({ estado: "BLOQUEO", motivo: "excede_tope" })
    expect(control(e, "RC3").valores_comparados).toMatchObject({ tope_aplicado: 50_000_000, valor_total: 57_000_000 })
    expect(reglas(e.bloqueos)).toEqual(["RC3"])
  })
})

// ---------------------------------------------------------------------------
// Propiedades estructurales del dominio
// ---------------------------------------------------------------------------

describe("pureza e invariantes", () => {
  test("no muta el Paquete ni los maestros y es determinista", () => {
    for (const caso of CASOS_REALES) {
      const p = congelarProfundo(structuredClone(paquete(caso)))
      const m = congelarProfundo(structuredClone(maestros))
      const antes = JSON.stringify([p, m])
      const primera = evaluarControles(p, m)
      expect(JSON.stringify([p, m])).toBe(antes)
      expect(evaluarControles(p, m)).toEqual(primera)
    }
  })

  test("controles.ts no importa E/S, reloj, red ni LLM", async () => {
    const fuente = await readFile(join(RAIZ_PROYECTO, "src", "domain", "controles.ts"), "utf8")
    const imports = [...fuente.matchAll(/from "([^"]+)"/g)].map((m) => m[1])
    expect(imports.sort()).toEqual(["../schemas", "./normalizar"])
    for (const prohibido of ["Date", "fetch(", "Bun.", "process.", "readFile", "writeFile"]) {
      expect(fuente).not.toContain(prohibido)
    }
  })

  test("NO_EVALUABLE con dependencia no bloqueada es un error de programación", () => {
    const controles = evaluar(paquete("sol-003")).controles.map((c) => (c.regla === "RC2" ? { ...c, estado: "CUMPLE" as const } : c))
    expect(() => verificarInvariantes(controles)).toThrow(ErrorInvarianteControles)
  })

  test("NO_EVALUABLE sin depende_de es un error de programación", () => {
    const controles = evaluar(paquete("sol-003")).controles.map((c) => (c.regla === "RC3" ? { ...c, depende_de: null } : c))
    expect(() => verificarInvariantes(controles)).toThrow(ErrorInvarianteControles)
  })

  test("fixtures/ intacto y sin escrituras en out/", async () => {
    expect(await huellaArbol(FIXTURES_REALES)).toBe(huellaInicialFixtures)
    expect(existsSync(DIR_OUT)).toBe(outExistiaAlInicio)
  })
})
