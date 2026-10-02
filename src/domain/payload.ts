// Construcción pura de la OrdenCompra (PRD 7.4), validación de catálogos, trazabilidad y sello.
// Fuentes permitidas: solicitud, maestros, aprobación, derivados RC6/RC7, constantes del PRD y la
// evidencia. Nunca la cotización como monto ni valores provenientes del modelo. Sin E/S ni reloj.
import {
  OrdenCompra,
  Trazabilidad,
  type CodigoError,
  type ErrorTool,
  type Maestros,
  type Paquete,
  type Regla,
  type ResultadoTool,
} from "../schemas"
import { buscarAprobador, buscarCentro, buscarProveedor, proveedorResuelto, type EvaluacionControles } from "./controles"
import { fechaDe, normalizarEmail, normalizarNombre, normalizarTexto } from "./normalizar"
import { payloadSha } from "./sello"

export const SOCIEDAD = "1000"
export const ORGANIZACION_COMPRAS = "1000"
export const MAX_DESCRIPCION = 40
export const PRIMERA_POSICION = 10

export type Unidad = OrdenCompra["posiciones"][number]["unidad"]
type CampoTraza = Trazabilidad["campos"][number]

export type EntradaPayload = {
  paquete: Paquete
  maestros: Maestros
  evaluacion: EvaluacionControles
  evidenciaSha256: string
  // Momento de generación de la trazabilidad (inyectado; nunca forma parte del payload).
  generadoEn: string
}

export type PayloadConstruido = {
  orden: OrdenCompra
  payload_sha: string
  confirmaciones: Regla[]
  trazabilidad: Trazabilidad
}

function fallo(codigo: CodigoError, mensaje: string, sugerencia: string, detalle: Record<string, unknown>): { ok: false; error: ErrorTool } {
  return { ok: false, error: { codigo, mensaje, sugerencia, detalle } }
}

// ---------------------------------------------------------------------------
// Derivaciones deterministas de la posición
// ---------------------------------------------------------------------------

// Máximo 40 caracteres; corta por palabra completa; si una sola palabra excede el límite, trunca a 40.
export function truncarDescripcion(texto: string, max: number = MAX_DESCRIPCION): string {
  const limpio = normalizarTexto(texto).replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const ultimoEspacio = limpio.slice(0, max + 1).lastIndexOf(" ")
  if (ultimoEspacio <= 0) return limpio.slice(0, max)
  return limpio.slice(0, ultimoEspacio).replace(/[\s,;:.-]+$/, "")
}

// Regla de unidad de los fixtures: "hora"/"horas" en la descripción → H; en otro caso → UN.
// MES no se infiere ("vigencia 12 meses" en sol-001 es una licencia, no un servicio mensual).
export function derivarUnidad(descripcion: string): Unidad {
  return /\bhoras?\b/.test(normalizarNombre(descripcion)) ? "H" : "UN"
}

// ---------------------------------------------------------------------------
// Catálogos (integridad del payload; no son reglas RC)
// ---------------------------------------------------------------------------

export function validarCatalogos(valores: { indicador_iva: string; condiciones_pago: string }, maestros: Maestros): ErrorTool | null {
  if (!maestros.indicadores_iva.some((i) => i.codigo === valores.indicador_iva)) {
    return {
      codigo: "CATALOGO_INVALIDO",
      mensaje: `El indicador de IVA "${valores.indicador_iva}" no existe en el catálogo.`,
      sugerencia: "Pedir al solicitante un indicador de IVA válido.",
      detalle: { campo: "indicador_iva", valor: valores.indicador_iva, catalogo: "maestro.indicadores-iva" },
    }
  }
  if (!maestros.condiciones_pago.some((c) => c.codigo === valores.condiciones_pago)) {
    return {
      codigo: "CATALOGO_INVALIDO",
      mensaje: `La condición de pago "${valores.condiciones_pago}" no existe en el catálogo.`,
      sugerencia: "Pedir al solicitante una condición de pago válida.",
      detalle: { campo: "condiciones_pago", valor: valores.condiciones_pago, catalogo: "maestro.condiciones-pago" },
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Construcción + sello
// ---------------------------------------------------------------------------

export function construirPayload(entrada: EntradaPayload): ResultadoTool<PayloadConstruido> {
  const { paquete, maestros, evaluacion } = entrada
  const s = paquete.solicitud

  if (!evaluacion.apta) {
    return fallo("CASO_BLOQUEADO", "El caso no es apto: no se construye el payload.", "Resolver los bloqueos antes de construir la orden.", {
      bloqueos: evaluacion.bloqueos.map((b) => b.regla),
      no_evaluables: evaluacion.controles.filter((c) => c.estado === "NO_EVALUABLE").map((c) => c.regla),
    })
  }
  if (s.moneda !== "COP" && s.moneda !== "USD") {
    return fallo("MONEDA_NO_SOPORTADA", `La moneda "${s.moneda}" no está soportada.`, "Usar COP o USD.", { campo: "moneda", valor: s.moneda })
  }

  // Con una evaluación apta, todo esto existe; si no, la evaluación no corresponde al paquete.
  const proveedor = proveedorResuelto(paquete, maestros)
  const busqueda = buscarProveedor(paquete, maestros)
  const aprobador = buscarAprobador(paquete, maestros)
  const centro = buscarCentro(maestros, s.centro_costo)
  const subarea = centro?.subareas.find((x) => normalizarNombre(x) === normalizarNombre(s.subarea)) ?? null
  const fechaAprobacion = paquete.aprobacion === null ? null : fechaDe(paquete.aprobacion.fecha)
  const indicadorIva = s.indicador_iva ?? evaluacion.derivados.indicador_iva?.valor ?? null
  const condicionesPago = s.condiciones_pago ?? evaluacion.derivados.condiciones_pago?.valor ?? null
  if (
    proveedor === null ||
    aprobador === null ||
    centro === null ||
    subarea === null ||
    fechaAprobacion === null ||
    indicadorIva === null ||
    condicionesPago === null
  ) {
    return fallo("PAYLOAD_INVALIDO", "La evaluación apta no es coherente con el paquete.", "Volver a validar el caso.", {
      motivo: "evaluacion_inconsistente",
    })
  }

  const errorCatalogo = validarCatalogos({ indicador_iva: indicadorIva, condiciones_pago: condicionesPago }, maestros)
  if (errorCatalogo !== null) return { ok: false, error: errorCatalogo }

  const descripcion = truncarDescripcion(s.descripcion)
  const unidad = derivarUnidad(s.descripcion)
  const orden = OrdenCompra.safeParse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: paquete.correo.id, cotizacion_ref: paquete.cotizacion?.numero ?? null },
    sociedad: SOCIEDAD,
    organizacion_compras: ORGANIZACION_COMPRAS,
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: condicionesPago,
    aprobador: { email: normalizarEmail(aprobador.email), fecha_aprobacion: fechaAprobacion, evidencia_sha256: entrada.evidenciaSha256 },
    posiciones: [
      {
        numero: PRIMERA_POSICION,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: centro.centro_costo,
        subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: evaluacion.confirmaciones.map((h) => ({ codigo: h.regla, detalle: h.detalle, confirmado_por: null })),
  })
  if (!orden.success) {
    return fallo("PAYLOAD_INVALIDO", "La orden construida no cumple el esquema de SAP.", "Revisar los datos de la solicitud.", {
      campos: orden.error.issues.map((i) => i.path.map(String).join(".")),
    })
  }

  const sello = payloadSha(orden.data)
  const o = orden.data
  const p0 = `posiciones[0]`
  const campos: CampoTraza[] = [
    { ruta: "referencia.solicitud_id", valor: o.referencia.solicitud_id, fuente: "solicitud", detalle: "solicitud.solicitud_id" },
    { ruta: "referencia.correo_id", valor: o.referencia.correo_id, fuente: "derivado", detalle: "correo.id" },
    {
      ruta: "referencia.cotizacion_ref",
      valor: o.referencia.cotizacion_ref,
      fuente: paquete.cotizacion === null ? "derivado" : "cotizacion",
      detalle: paquete.cotizacion === null ? "sin cotización en el paquete" : "cotizacion.numero",
    },
    { ruta: "sociedad", valor: o.sociedad, fuente: "derivado", detalle: "constante PRD 7.4" },
    { ruta: "organizacion_compras", valor: o.organizacion_compras, fuente: "derivado", detalle: "constante PRD 7.4" },
    ...(["codigo_sap", "nit", "nombre"] as const).map((k) => ({
      ruta: `proveedor.${k}`,
      valor: o.proveedor[k],
      fuente: "maestro.proveedores",
      detalle: `RC1: resuelto por ${busqueda.criterio} "${busqueda.valor_buscado}"`,
    })),
    { ruta: "moneda", valor: o.moneda, fuente: "solicitud", detalle: "solicitud.moneda" },
    s.condiciones_pago === undefined
      ? { ruta: "condiciones_pago", valor: o.condiciones_pago, fuente: "derivado", detalle: `RC7: condiciones_pago_default del proveedor ${proveedor.codigo_sap}; validado contra maestro.condiciones-pago` }
      : { ruta: "condiciones_pago", valor: o.condiciones_pago, fuente: "solicitud", detalle: "solicitud.condiciones_pago; validado contra maestro.condiciones-pago" },
    { ruta: "aprobador.email", valor: o.aprobador.email, fuente: "maestro.centros-costo", detalle: `RC2: aprobador listado en ${centro.centro_costo}` },
    { ruta: "aprobador.fecha_aprobacion", valor: o.aprobador.fecha_aprobacion, fuente: "derivado", detalle: "aprobacion.fecha (parte YYYY-MM-DD)" },
    { ruta: "aprobador.evidencia_sha256", valor: o.aprobador.evidencia_sha256, fuente: "derivado", detalle: "sha256 de la evidencia de aprobación" },
    { ruta: `${p0}.numero`, valor: PRIMERA_POSICION, fuente: "derivado", detalle: "posición única; numeración SAP en pasos de 10" },
    {
      ruta: `${p0}.descripcion`,
      valor: descripcion,
      fuente: descripcion === s.descripcion ? "solicitud" : "derivado",
      detalle: descripcion === s.descripcion ? "solicitud.descripcion" : `solicitud.descripcion truncada a ${MAX_DESCRIPCION} caracteres`,
    },
    { ruta: `${p0}.cantidad`, valor: s.cantidad, fuente: "solicitud", detalle: "solicitud.cantidad" },
    { ruta: `${p0}.unidad`, valor: unidad, fuente: "derivado", detalle: "regla de unidad: 'hora(s)' en la descripción → H; otro caso → UN" },
    { ruta: `${p0}.precio_unitario`, valor: s.valor_unitario, fuente: "solicitud", detalle: "solicitud.valor_unitario (la cotización no reemplaza el valor aprobado)" },
    { ruta: `${p0}.centro_costo`, valor: centro.centro_costo, fuente: "solicitud", detalle: "solicitud.centro_costo; validado en RC2/RC4" },
    { ruta: `${p0}.subarea`, valor: subarea, fuente: "maestro.centros-costo", detalle: "subárea canónica del maestro (RC4)" },
    s.indicador_iva === undefined
      ? { ruta: `${p0}.indicador_iva`, valor: indicadorIva, fuente: "derivado", detalle: `RC6: indicador_iva_default del proveedor ${proveedor.codigo_sap}; validado contra maestro.indicadores-iva` }
      : { ruta: `${p0}.indicador_iva`, valor: indicadorIva, fuente: "solicitud", detalle: "solicitud.indicador_iva; validado contra maestro.indicadores-iva" },
    ...o.excepciones.flatMap((x, i) => [
      { ruta: `excepciones[${i}].codigo`, valor: x.codigo, fuente: "derivado", detalle: `confirmación ${x.codigo} de la evaluación de controles` },
      { ruta: `excepciones[${i}].detalle`, valor: x.detalle, fuente: "derivado", detalle: `valores comparados por ${x.codigo}` },
      { ruta: `excepciones[${i}].confirmado_por`, valor: null, fuente: "derivado", detalle: "siempre null en el payload sellado; la autorización se registra aparte" },
    ]),
  ]

  const trazabilidad = Trazabilidad.safeParse({
    solicitud_id: s.solicitud_id,
    payload_sha: sello,
    generado_en: entrada.generadoEn,
    campos,
    controles: evaluacion.controles,
  })
  if (!trazabilidad.success) {
    return fallo("PAYLOAD_INVALIDO", "La trazabilidad no cumple su esquema.", "Revisar la construcción del payload.", {
      campos: trazabilidad.error.issues.map((i) => i.path.map(String).join(".")),
    })
  }

  return {
    ok: true,
    data: {
      orden: o,
      payload_sha: sello,
      confirmaciones: o.excepciones.map((x) => x.codigo),
      trazabilidad: trazabilidad.data,
    },
  }
}
