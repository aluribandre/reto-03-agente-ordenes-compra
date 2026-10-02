// RC1–RC10 (PRD 7.3) como funciones puras sobre el Paquete canónico y los maestros.
// Sin E/S, sin reloj, sin LLM, sin mutar entradas. Devuelven datos estructurados:
// `motivo` y `accion_sugerida` son códigos; la explicación en lenguaje natural la hace el agente.
import type {
  CentroCosto,
  DataValidar,
  Derivados,
  EstadoControl,
  Hallazgo,
  Maestros,
  Paquete,
  Proveedor,
  Regla,
  ResultadoControl,
  TipoControl,
} from "../schemas"
import { fechaDe, normalizarEmail, normalizarNit, normalizarNombre } from "./normalizar"

export const TOLERANCIA_RC5_PCT = 2
export const TOLERANCIA_RC10 = 1

export type Control = (paquete: Paquete, maestros: Maestros) => ResultadoControl
export type EvaluacionControles = Omit<DataValidar, "resumen">

// Un estado imposible es un error de programación: nunca se convierte en un resultado válido.
export class ErrorInvarianteControles extends Error {}

type Valores = ResultadoControl["valores_comparados"]
type Base = { regla: Regla; tipo: TipoControl; fuente: readonly string[] }
type Extra = { motivo?: string; accion?: string; depende_de?: Regla; derivado?: Record<string, string> }

const BASE = {
  RC1: { regla: "RC1", tipo: "BLOCK", fuente: ["solicitud", "maestro.proveedores"] },
  RC2: { regla: "RC2", tipo: "BLOCK", fuente: ["aprobacion", "maestro.centros-costo"] },
  RC3: { regla: "RC3", tipo: "BLOCK", fuente: ["solicitud", "aprobacion", "maestro.centros-costo"] },
  RC4: { regla: "RC4", tipo: "BLOCK", fuente: ["solicitud", "maestro.centros-costo"] },
  RC5: { regla: "RC5", tipo: "CONFIRM", fuente: ["solicitud", "cotizacion"] },
  RC6: { regla: "RC6", tipo: "CONFIRM+DERIVE", fuente: ["solicitud", "maestro.proveedores"] },
  RC7: { regla: "RC7", tipo: "DERIVE+INFO", fuente: ["solicitud", "maestro.proveedores"] },
  RC8: { regla: "RC8", tipo: "CONFIRM", fuente: ["factura", "solicitud"] },
  RC9: { regla: "RC9", tipo: "CONFIRM", fuente: ["aprobacion", "solicitud"] },
  RC10: { regla: "RC10", tipo: "BLOCK", fuente: ["solicitud"] },
} as const satisfies Record<Regla, Base>

function crear(base: Base, estado: EstadoControl, valores: Valores, extra: Extra = {}): ResultadoControl {
  const r: ResultadoControl = {
    regla: base.regla,
    tipo: base.tipo,
    estado,
    motivo: extra.motivo ?? null,
    depende_de: extra.depende_de ?? null,
    valores_comparados: valores,
    fuente: [...base.fuente],
    accion_sugerida: extra.accion ?? null,
  }
  return extra.derivado ? { ...r, derivado: extra.derivado } : r
}

// ---------------------------------------------------------------------------
// Helpers de búsqueda en maestros (puros)
// ---------------------------------------------------------------------------

export type BusquedaProveedor = { criterio: "nit" | "nombre"; valor_buscado: string; coincidencias: Proveedor[] }

// Por NIT si la solicitud lo trae; si no, por nombre normalizado exacto (sin matching difuso).
export function buscarProveedor(paquete: Paquete, maestros: Maestros): BusquedaProveedor {
  const nit = paquete.solicitud.proveedor_nit
  if (nit !== undefined) {
    const buscado = normalizarNit(nit)
    return { criterio: "nit", valor_buscado: buscado, coincidencias: maestros.proveedores.filter((p) => normalizarNit(p.nit) === buscado) }
  }
  const buscado = normalizarNombre(paquete.solicitud.proveedor_nombre)
  return { criterio: "nombre", valor_buscado: buscado, coincidencias: maestros.proveedores.filter((p) => normalizarNombre(p.nombre) === buscado) }
}

// Proveedor resuelto = exactamente una coincidencia y activa (es decir, RC1 en CUMPLE).
export function proveedorResuelto(paquete: Paquete, maestros: Maestros): Proveedor | null {
  const { coincidencias } = buscarProveedor(paquete, maestros)
  const unico = coincidencias.length === 1 ? coincidencias[0] : undefined
  return unico !== undefined && unico.activo ? unico : null
}

export function buscarCentro(maestros: Maestros, centroCosto: string): CentroCosto | null {
  const buscado = centroCosto.trim()
  return maestros.centros_costo.find((c) => c.centro_costo.trim() === buscado) ?? null
}

// Aprobador que firmó, siempre que esté listado en el centro de costo de la solicitud.
export function buscarAprobador(paquete: Paquete, maestros: Maestros): CentroCosto["aprobadores"][number] | null {
  const aprobacion = paquete.aprobacion
  const centro = buscarCentro(maestros, paquete.solicitud.centro_costo)
  if (aprobacion === null || centro === null) return null
  const email = normalizarEmail(aprobacion.de)
  return centro.aprobadores.find((a) => normalizarEmail(a.email) === email) ?? null
}

// ---------------------------------------------------------------------------
// RC1–RC10
// ---------------------------------------------------------------------------

// RC1 — El proveedor debe existir (por NIT; si no hay NIT, por nombre normalizado) y estar activo.
export const rc1: Control = (p, m) => {
  const { criterio, valor_buscado, coincidencias } = buscarProveedor(p, m)
  const unico = coincidencias.length === 1 ? coincidencias[0] : undefined
  const valores: Valores = {
    criterio,
    valor_buscado,
    coincidencias: coincidencias.length,
    codigo_sap: unico?.codigo_sap ?? null,
    activo: unico?.activo ?? null,
  }
  if (coincidencias.length === 0) {
    return crear(BASE.RC1, "BLOQUEO", valores, { motivo: "no_encontrado", accion: "verificar_nit_o_tramitar_alta_proveedor" })
  }
  if (unico === undefined) {
    return crear(BASE.RC1, "BLOQUEO", valores, { motivo: "ambiguo", accion: "solicitar_nit_proveedor" })
  }
  if (!unico.activo) {
    return crear(BASE.RC1, "BLOQUEO", valores, { motivo: "inactivo", accion: "reactivar_o_cambiar_proveedor" })
  }
  return crear(BASE.RC1, "CUMPLE", valores)
}

// RC2 — La aprobación debe existir, contener "Aprobado" y venir de un aprobador del centro de costo.
export const rc2: Control = (p, m) => {
  const aprobacion = p.aprobacion
  const centro = buscarCentro(m, p.solicitud.centro_costo)
  const validos = centro?.aprobadores.map((a) => normalizarEmail(a.email)) ?? []
  const email = aprobacion === null ? null : normalizarEmail(aprobacion.de)
  const listado = email !== null && validos.includes(email)
  const valores: Valores = {
    aprobador_email: email,
    centro_costo: p.solicitud.centro_costo,
    aprobadores_validos: validos.join(";"),
    aprobador_listado: listado,
    contiene_aprobado: aprobacion?.aprobado ?? null,
  }
  if (aprobacion === null) {
    return crear(BASE.RC2, "BLOQUEO", valores, { motivo: "sin_aprobacion", accion: "solicitar_aprobacion_del_lider" })
  }
  if (centro === null) {
    return crear(BASE.RC2, "BLOQUEO", valores, { motivo: "centro_costo_inexistente", accion: "corregir_centro_costo" })
  }
  if (!listado) {
    return crear(BASE.RC2, "BLOQUEO", valores, { motivo: "aprobador_no_autorizado_en_cc", accion: "solicitar_aprobacion_de_aprobador_del_cc" })
  }
  if (!aprobacion.aprobado) {
    return crear(BASE.RC2, "BLOQUEO", valores, { motivo: "sin_palabra_aprobado", accion: "solicitar_aprobacion_explicita" })
  }
  return crear(BASE.RC2, "CUMPLE", valores)
}

// RC3 — valor_total ≤ tope del aprobador para ese centro. Sin aprobador del centro: NO_EVALUABLE (depende de RC2).
export const rc3: Control = (p, m) => {
  const aprobador = buscarAprobador(p, m)
  const valorTotal = p.solicitud.valor_total
  if (aprobador === null) {
    const topes = buscarCentro(m, p.solicitud.centro_costo)?.aprobadores.map((a) => a.tope) ?? []
    return crear(
      BASE.RC3,
      "NO_EVALUABLE",
      {
        aprobador_email: p.aprobacion === null ? null : normalizarEmail(p.aprobacion.de),
        centro_costo: p.solicitud.centro_costo,
        valor_total: valorTotal,
        tope_aplicado: null,
        // Dato informativo del maestro, no una regla.
        tope_maximo_en_cc: topes.length > 0 ? Math.max(...topes) : null,
      },
      { motivo: "aprobador_sin_tope_en_cc", depende_de: "RC2" },
    )
  }
  const valores: Valores = {
    aprobador_email: normalizarEmail(aprobador.email),
    centro_costo: p.solicitud.centro_costo,
    valor_total: valorTotal,
    tope_aplicado: aprobador.tope,
  }
  if (valorTotal <= aprobador.tope) return crear(BASE.RC3, "CUMPLE", valores)
  return crear(BASE.RC3, "BLOQUEO", valores, { motivo: "excede_tope", accion: "solicitar_aprobacion_con_tope_suficiente" })
}

// RC4 — La subárea debe pertenecer al centro de costo.
export const rc4: Control = (p, m) => {
  const centro = buscarCentro(m, p.solicitud.centro_costo)
  const valores: Valores = {
    centro_costo: p.solicitud.centro_costo,
    subarea: p.solicitud.subarea,
    subareas_validas: centro?.subareas.join(";") ?? null,
  }
  if (centro === null) {
    return crear(BASE.RC4, "BLOQUEO", valores, { motivo: "centro_costo_inexistente", accion: "corregir_centro_costo" })
  }
  const buscada = normalizarNombre(p.solicitud.subarea)
  if (centro.subareas.some((s) => normalizarNombre(s) === buscada)) return crear(BASE.RC4, "CUMPLE", valores)
  return crear(BASE.RC4, "BLOQUEO", valores, { motivo: "subarea_no_pertenece", accion: "corregir_subarea_o_centro_costo" })
}

// RC5 — |cotización − solicitud| / solicitud ≤ 2 %, en aritmética entera. Sin cotización: confirmación.
export const rc5: Control = (p) => {
  const solicitud = p.solicitud.valor_total
  const cotizacion = p.cotizacion?.total ?? null
  if (cotizacion === null) {
    return crear(
      BASE.RC5,
      "CONFIRMACION",
      { valor_solicitud: solicitud, valor_cotizacion: null, diferencia_absoluta: null, diferencia_pct: null, tolerancia_pct: TOLERANCIA_RC5_PCT },
      { motivo: "sin_cotizacion", accion: "confirmar_sin_cotizacion_o_solicitarla" },
    )
  }
  const diferencia = Math.abs(cotizacion - solicitud)
  const valores: Valores = {
    valor_solicitud: solicitud,
    valor_cotizacion: cotizacion,
    diferencia_absoluta: diferencia,
    // Solo informativo (2 decimales); la decisión usa la comparación entera de abajo.
    diferencia_pct: Math.round((diferencia * 10_000) / solicitud) / 100,
    tolerancia_pct: TOLERANCIA_RC5_PCT,
  }
  if (diferencia * 100 <= TOLERANCIA_RC5_PCT * solicitud) return crear(BASE.RC5, "CUMPLE", valores)
  return crear(BASE.RC5, "CONFIRMACION", valores, { motivo: "diferencia_excede_tolerancia", accion: "confirmar_valor_solicitud_o_devolver" })
}

// RC6 — Sin indicador de IVA: se deriva del proveedor y se pide confirmación.
export const rc6: Control = (p, m) => {
  const informado = p.solicitud.indicador_iva ?? null
  if (informado !== null) {
    return crear(BASE.RC6, "CUMPLE", { indicador_iva_solicitud: informado, indicador_iva_derivado: null, codigo_sap: null })
  }
  const proveedor = proveedorResuelto(p, m)
  if (proveedor === null) {
    return crear(
      BASE.RC6,
      "NO_EVALUABLE",
      { indicador_iva_solicitud: null, indicador_iva_derivado: null, codigo_sap: null },
      { motivo: "proveedor_no_resuelto", depende_de: "RC1" },
    )
  }
  return crear(
    BASE.RC6,
    "CONFIRMACION",
    { indicador_iva_solicitud: null, indicador_iva_derivado: proveedor.indicador_iva_default, codigo_sap: proveedor.codigo_sap },
    { motivo: "iva_derivado_del_proveedor", accion: "confirmar_iva_derivado", derivado: { indicador_iva: proveedor.indicador_iva_default } },
  )
}

// RC7 — Sin condiciones de pago: se derivan del proveedor. Solo se informa.
export const rc7: Control = (p, m) => {
  const informado = p.solicitud.condiciones_pago ?? null
  if (informado !== null) {
    return crear(BASE.RC7, "CUMPLE", { condiciones_pago_solicitud: informado, condiciones_pago_derivado: null, codigo_sap: null })
  }
  const proveedor = proveedorResuelto(p, m)
  if (proveedor === null) {
    return crear(
      BASE.RC7,
      "NO_EVALUABLE",
      { condiciones_pago_solicitud: null, condiciones_pago_derivado: null, codigo_sap: null },
      { motivo: "proveedor_no_resuelto", depende_de: "RC1" },
    )
  }
  return crear(
    BASE.RC7,
    "DERIVADO",
    { condiciones_pago_solicitud: null, condiciones_pago_derivado: proveedor.condiciones_pago_default, codigo_sap: proveedor.codigo_sap },
    { motivo: "condiciones_pago_derivadas_del_proveedor", derivado: { condiciones_pago: proveedor.condiciones_pago_default } },
  )
}

// RC8 — Factura con fecha anterior a la solicitud: retroactiva y confirmación. Comparación de cadenas YYYY-MM-DD.
export const rc8: Control = (p) => {
  const factura = p.factura
  const fechaSolicitud = p.solicitud.fecha_solicitud
  if (factura === null) {
    return crear(BASE.RC8, "NO_APLICA", { factura_numero: null, factura_fecha: null, fecha_solicitud: fechaSolicitud, retroactiva: false })
  }
  const retroactiva = factura.fecha < fechaSolicitud
  const valores: Valores = { factura_numero: factura.numero, factura_fecha: factura.fecha, fecha_solicitud: fechaSolicitud, retroactiva }
  if (!retroactiva) return crear(BASE.RC8, "CUMPLE", valores)
  return crear(BASE.RC8, "CONFIRMACION", valores, { motivo: "factura_anterior_a_solicitud", accion: "confirmar_oc_retroactiva" })
}

// RC9 — La fecha de aprobación debe ser ≥ fecha_solicitud. Sin aprobación: NO_EVALUABLE (depende de RC2).
export const rc9: Control = (p) => {
  const fechaSolicitud = p.solicitud.fecha_solicitud
  if (p.aprobacion === null) {
    return crear(BASE.RC9, "NO_EVALUABLE", { fecha_aprobacion: null, fecha_solicitud: fechaSolicitud }, { motivo: "sin_aprobacion", depende_de: "RC2" })
  }
  const fechaAprobacion = fechaDe(p.aprobacion.fecha)
  if (fechaAprobacion === null) throw new ErrorInvarianteControles("RC9: fecha de aprobación inválida en un Paquete canónico")
  const valores: Valores = { fecha_aprobacion: fechaAprobacion, fecha_solicitud: fechaSolicitud }
  if (fechaAprobacion >= fechaSolicitud) return crear(BASE.RC9, "CUMPLE", valores)
  return crear(BASE.RC9, "CONFIRMACION", valores, { motivo: "aprobacion_anterior_a_solicitud", accion: "confirmar_o_solicitar_aprobacion_vigente" })
}

// RC10 — cantidad × valor_unitario debe igualar valor_total (± 1 unidad monetaria).
export const rc10: Control = (p) => {
  const { cantidad, valor_unitario, valor_total } = p.solicitud
  const calculado = cantidad * valor_unitario
  const diferencia = Math.abs(calculado - valor_total)
  const valores: Valores = { cantidad, valor_unitario, calculado, valor_total, diferencia, tolerancia: TOLERANCIA_RC10 }
  if (diferencia <= TOLERANCIA_RC10) return crear(BASE.RC10, "CUMPLE", valores)
  return crear(BASE.RC10, "BLOQUEO", valores, { motivo: "aritmetica_no_cuadra", accion: "corregir_montos_solicitud" })
}

export const CONTROLES: readonly Control[] = [rc1, rc2, rc3, rc4, rc5, rc6, rc7, rc8, rc9, rc10]

// ---------------------------------------------------------------------------
// Agregado
// ---------------------------------------------------------------------------

// Todo NO_EVALUABLE declara depende_de y esa regla está en BLOQUEO; ninguna otra regla declara dependencia.
export function verificarInvariantes(controles: readonly ResultadoControl[]): void {
  if (controles.length !== CONTROLES.length || controles.some((c, i) => c.regla !== `RC${i + 1}`)) {
    throw new ErrorInvarianteControles("se esperaban RC1–RC10 en orden")
  }
  for (const c of controles) {
    if (c.estado !== "NO_EVALUABLE") {
      if (c.depende_de !== null) throw new ErrorInvarianteControles(`${c.regla}: depende_de solo aplica a NO_EVALUABLE`)
      continue
    }
    if (c.depende_de === null) throw new ErrorInvarianteControles(`${c.regla}: NO_EVALUABLE sin depende_de`)
    const dependencia = controles.find((d) => d.regla === c.depende_de)
    if (dependencia?.estado !== "BLOQUEO") {
      throw new ErrorInvarianteControles(`${c.regla}: NO_EVALUABLE pero ${c.depende_de} no está en BLOQUEO`)
    }
  }
}

function obtener(controles: readonly ResultadoControl[], regla: Regla): ResultadoControl {
  const c = controles.find((x) => x.regla === regla)
  if (c === undefined) throw new ErrorInvarianteControles(`falta ${regla}`)
  return c
}

function aHallazgo(c: ResultadoControl): Hallazgo {
  return {
    regla: c.regla,
    motivo: c.motivo ?? c.estado.toLowerCase(),
    detalle: Object.entries(c.valores_comparados)
      .map(([clave, valor]) => `${clave}=${String(valor)}`)
      .join("; "),
    valores: { ...c.valores_comparados },
    accion_sugerida: c.accion_sugerida ?? "",
  }
}

export function evaluarControles(paquete: Paquete, maestros: Maestros): EvaluacionControles {
  const controles = CONTROLES.map((control) => control(paquete, maestros))
  verificarInvariantes(controles)

  const derivados: Derivados = {}
  const iva = obtener(controles, "RC6").derivado?.["indicador_iva"]
  if (iva !== undefined) derivados.indicador_iva = { valor: iva, fuente: "maestro.proveedores" }
  const pago = obtener(controles, "RC7").derivado?.["condiciones_pago"]
  if (pago !== undefined) derivados.condiciones_pago = { valor: pago, fuente: "maestro.proveedores" }
  const rc1Resultado = obtener(controles, "RC1")
  if (rc1Resultado.estado === "CUMPLE" && rc1Resultado.valores_comparados["criterio"] === "nombre") {
    const proveedor = proveedorResuelto(paquete, maestros)
    if (proveedor !== null) derivados.proveedor_por_nombre = { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre }
  }

  return {
    solicitud_id: paquete.solicitud.solicitud_id,
    // apta exige que TODAS las reglas BLOCK estén en CUMPLE (un NO_EVALUABLE también impide apta).
    apta: controles.filter((c) => c.tipo === "BLOCK").every((c) => c.estado === "CUMPLE"),
    bloqueos: controles.filter((c) => c.estado === "BLOQUEO").map(aHallazgo),
    confirmaciones: controles.filter((c) => c.estado === "CONFIRMACION").map(aHallazgo),
    derivados,
    retroactiva: obtener(controles, "RC8").estado === "CONFIRMACION",
    controles,
  }
}
