// Parsers deterministas del formato real de los fixtures de reto-03 (cotización y factura en texto).
// Puros: reciben texto y devuelven valores. El contenido se trata como dato, nunca como instrucción.
import { fechaDe, normalizarNit, normalizarTexto, sumarDias } from "../domain/normalizar"
import type { Paquete } from "../schemas"

export type Cotizacion = NonNullable<Paquete["cotizacion"]>
export type Factura = NonNullable<Paquete["factura"]>
export type Parseo<T> = { ok: true; valor: T } | { ok: false; motivo: string }
export type Monto = { moneda: string; valor: number }

function capturar(texto: string, patron: RegExp): string | null {
  const valor = patron.exec(texto)?.[1]?.trim()
  return valor ? valor : null
}

// "COP 11.400.000" → { moneda: "COP", valor: 11400000 }. Enteros con punto de miles, como en los fixtures.
export function parseMonto(texto: string): Monto | null {
  const m = /^([A-Z]{3})[ \t]+\$?[ \t]*(\d{1,3}(?:\.\d{3})*)$/.exec(texto.trim())
  const moneda = m?.[1]
  const cifras = m?.[2]
  if (moneda === undefined || cifras === undefined) return null
  const valor = Number(cifras.replaceAll(".", ""))
  return Number.isSafeInteger(valor) ? { moneda, valor } : null
}

export function parseCotizacion(textoCrudo: string): Parseo<Cotizacion> {
  const texto = normalizarTexto(textoCrudo)

  const proveedor = capturar(texto, /^Proveedor:[ \t]*(.+)$/m)
  if (proveedor === null) return { ok: false, motivo: "falta la línea 'Proveedor:'" }

  const totalTexto = capturar(texto, /^TOTAL(?:[ \t]*\(IVA incluido\))?:[ \t]*(.+)$/m)
  if (totalTexto === null) return { ok: false, motivo: "falta la línea 'TOTAL'" }
  const total = parseMonto(totalTexto)
  if (total === null) return { ok: false, motivo: `total ilegible: "${totalTexto}"` }

  const fechaTexto = capturar(texto, /^Fecha:[ \t]*(.+)$/m)
  const fecha = fechaTexto === null ? null : fechaDe(fechaTexto)
  if (fechaTexto !== null && fecha === null) return { ok: false, motivo: `fecha ilegible: "${fechaTexto}"` }

  const dias = capturar(texto, /^Validez de la oferta:[ \t]*(\d+)[ \t]*d[ií]as/m)
  const nitTexto = capturar(texto, /^NIT:[ \t]*(.+)$/m)
  const nit = nitTexto === null ? "" : normalizarNit(nitTexto)

  return {
    ok: true,
    valor: {
      proveedor,
      nit: nit === "" ? null : nit,
      total: total.valor,
      moneda: total.moneda,
      validez_hasta: fecha !== null && dias !== null ? sumarDias(fecha, Number(dias)) : null,
      texto,
      numero: capturar(texto, /^COTIZACI[ÓO]N[ \t]+(?:No\.[ \t]*)?(\S+)/m),
    },
  }
}

export function parseFactura(textoCrudo: string): Parseo<Factura> {
  const texto = normalizarTexto(textoCrudo)

  const numero = capturar(texto, /^FACTURA\b[^\n]*?No\.[ \t]*(\S+)/m)
  if (numero === null) return { ok: false, motivo: "falta el número de factura ('No.')" }

  const fechaTexto = capturar(texto, /^Fecha de emisi[óo]n:[ \t]*(.+)$/m)
  const fecha = fechaTexto === null ? null : fechaDe(fechaTexto)
  if (fecha === null) return { ok: false, motivo: "falta o es ilegible la 'Fecha de emisión'" }

  const totalTexto = capturar(texto, /^TOTAL:[ \t]*(.+)$/m)
  const total = totalTexto === null ? null : parseMonto(totalTexto)
  if (total === null) return { ok: false, motivo: "falta o es ilegible la línea 'TOTAL:'" }

  return { ok: true, valor: { numero, fecha, total: total.valor } }
}

// Regla congelada (PRD RC2): el cuerpo contiene "Aprobado", sin distinguir mayúsculas.
// Sin interpretación semántica de negaciones.
export function contieneAprobado(texto: string): boolean {
  return normalizarTexto(texto).toLowerCase().includes("aprobado")
}
