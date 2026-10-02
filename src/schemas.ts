// Esquemas zod compartidos. Módulo puro: sin E/S, sin reloj, sin dependencias internas.
// Fuente: reto-03/PRD.md (7.1, 7.2, 7.4) + contratos congelados de las tools P0.
import { z } from "zod"

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

export const Caso = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "caso inválido: solo minúsculas, dígitos y guiones")
  .describe("Carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. sol-004")

export const Fecha = z.iso.date()
export const FechaHora = z.iso.datetime({ offset: true })
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hexadecimal en minúsculas")
export const NumeroOc = z.string().regex(/^45\d{8}$/, "número de OC SAP (45xxxxxxxx)")

export const Regla = z.enum(["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"])
export type Regla = z.infer<typeof Regla>

// ---------------------------------------------------------------------------
// Envoltorio de las tools: { ok: true, data } | { ok: false, error }
// ---------------------------------------------------------------------------

export const CodigoError = z.enum([
  // Runtime
  "ARGS_INVALIDOS",
  "ERROR_ESCRITURA",
  "ERROR_INTERNO",
  // A. Ingestión / esquema
  "CASO_INVALIDO",
  "CASO_INEXISTENTE",
  "SOLICITUD_FALTANTE",
  "CORREO_FALTANTE",
  "JSON_MALFORMADO",
  "SOLICITUD_INVALIDA",
  "MONTO_NO_NUMERICO",
  "INSUMO_ILEGIBLE",
  "MAESTRO_INVALIDO",
  // B'. Compuertas de negocio
  "CASO_BLOQUEADO",
  "CONFIRMACION_REQUERIDA",
  // D. Integridad del payload
  "FALTA_EVIDENCIA",
  "EVIDENCIA_INCONSISTENTE",
  "MONEDA_NO_SOPORTADA",
  "CATALOGO_INVALIDO",
  "PAYLOAD_INVALIDO",
  "FALTA_PAYLOAD",
  "PAYLOAD_NO_COINCIDE",
  "AUTORIZACION_INVALIDA",
  // C. Adaptador SAP
  "SAP_ERROR",
])
export type CodigoError = z.infer<typeof CodigoError>

export const ErrorTool = z.object({
  codigo: CodigoError,
  mensaje: z.string(),
  sugerencia: z.string(),
  detalle: z.record(z.string(), z.unknown()).optional(),
})
export type ErrorTool = z.infer<typeof ErrorTool>

export function esquemaResultado<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ErrorTool }),
  ])
}
export type ResultadoTool<T> = { ok: true; data: T } | { ok: false; error: ErrorTool }

// ---------------------------------------------------------------------------
// Fixtures crudos (lo que hay en disco). Campos extra se descartan (p. ej. nota_fixture).
// ---------------------------------------------------------------------------

export const CorreoFixture = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  para: z.string().optional(),
  asunto: z.string(),
  fecha: FechaHora,
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type CorreoFixture = z.infer<typeof CorreoFixture>

export const Solicitud = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: z.string().min(1),
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: Fecha,
})
export type Solicitud = z.infer<typeof Solicitud>

export const AprobacionFixture = z.object({
  de: z.string().min(1),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: FechaHora,
  asunto: z.string(),
  cuerpo: z.string(),
})
export type AprobacionFixture = z.infer<typeof AprobacionFixture>

// ---------------------------------------------------------------------------
// Maestros (fixtures/reto-03/maestros/)
// ---------------------------------------------------------------------------

export const Proveedor = z.object({
  codigo_sap: z.string().min(1),
  nit: z.string().min(1),
  nombre: z.string().min(1),
  condiciones_pago_default: z.string().min(1),
  indicador_iva_default: z.string().min(1),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof Proveedor>

export const CentroCosto = z.object({
  centro_costo: z.string().min(1),
  nombre: z.string(),
  subareas: z.array(z.string().min(1)),
  aprobadores: z.array(
    z.object({
      email: z.string().min(3),
      nombre: z.string(),
      tope: z.number().nonnegative(),
    }),
  ),
})
export type CentroCosto = z.infer<typeof CentroCosto>

export const IndicadorIva = z.object({
  codigo: z.string().min(1),
  descripcion: z.string(),
  tasa: z.number().nonnegative(),
})
export type IndicadorIva = z.infer<typeof IndicadorIva>

export const CondicionPago = z.object({
  codigo: z.string().min(1),
  descripcion: z.string(),
  dias: z.number().int().nonnegative(),
})
export type CondicionPago = z.infer<typeof CondicionPago>

export const Maestros = z.object({
  proveedores: z.array(Proveedor),
  centros_costo: z.array(CentroCosto),
  indicadores_iva: z.array(IndicadorIva),
  condiciones_pago: z.array(CondicionPago),
})
export type Maestros = z.infer<typeof Maestros>

// ---------------------------------------------------------------------------
// Paquete normalizado (PRD 7.2 + extensiones documentadas: faltantes[], cotizacion.numero)
// ---------------------------------------------------------------------------

export const Paquete = z.object({
  correo: z.object({
    id: z.string(),
    de: z.string(),
    asunto: z.string(),
    fecha: FechaHora,
  }),
  solicitud: Solicitud,
  cotizacion: z
    .object({
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: Fecha.nullable(),
      texto: z.string(),
      numero: z.string().nullable(),
    })
    .nullable(),
  aprobacion: z
    .object({
      de: z.string(),
      fecha: FechaHora,
      aprobado: z.boolean(),
      texto: z.string(),
    })
    .nullable(),
  factura: z
    .object({
      numero: z.string(),
      fecha: Fecha,
      total: z.number(),
    })
    .nullable(),
  faltantes: z.array(
    z.object({
      pieza: z.enum(["cotizacion", "aprobacion", "factura"]),
      archivo: z.string(),
      motivo: z.literal("archivo_ausente"),
    }),
  ),
})
export type Paquete = z.infer<typeof Paquete>

// ---------------------------------------------------------------------------
// Controles RC1–RC10
// ---------------------------------------------------------------------------

export const EstadoControl = z.enum(["CUMPLE", "NO_APLICA", "BLOQUEO", "CONFIRMACION", "DERIVADO", "NO_EVALUABLE"])
export type EstadoControl = z.infer<typeof EstadoControl>

export const TipoControl = z.enum(["BLOCK", "CONFIRM", "CONFIRM+DERIVE", "DERIVE+INFO"])
export type TipoControl = z.infer<typeof TipoControl>

const ValorComparado = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const ResultadoControl = z.object({
  regla: Regla,
  tipo: TipoControl,
  estado: EstadoControl,
  motivo: z.string().nullable(),
  depende_de: Regla.nullable(),
  valores_comparados: z.record(z.string(), ValorComparado),
  fuente: z.array(z.string()),
  accion_sugerida: z.string().nullable(),
  derivado: z.record(z.string(), z.string()).optional(),
})
export type ResultadoControl = z.infer<typeof ResultadoControl>

export const Hallazgo = z.object({
  regla: Regla,
  motivo: z.string(),
  detalle: z.string(),
  valores: z.record(z.string(), z.unknown()),
  accion_sugerida: z.string(),
})
export type Hallazgo = z.infer<typeof Hallazgo>

const ValorDerivado = z.object({
  valor: z.string(),
  fuente: z.literal("maestro.proveedores"),
})

export const Derivados = z.object({
  indicador_iva: ValorDerivado.optional(),
  condiciones_pago: ValorDerivado.optional(),
  proveedor_por_nombre: z
    .object({
      codigo_sap: z.string(),
      nit: z.string(),
      nombre: z.string(),
    })
    .optional(),
})
export type Derivados = z.infer<typeof Derivados>

// ---------------------------------------------------------------------------
// Orden de compra (PRD 7.4). La validación contra catálogos se agrega en el dominio.
// ---------------------------------------------------------------------------

export const OrdenCompra = z
  .object({
    referencia: z.object({
      solicitud_id: z.string().min(1),
      correo_id: z.string().min(1),
      cotizacion_ref: z.string().nullable(),
    }),
    sociedad: z.literal("1000"),
    organizacion_compras: z.literal("1000"),
    proveedor: z.object({
      codigo_sap: z.string().min(1),
      nit: z.string().min(1),
      nombre: z.string().min(1),
    }),
    moneda: z.enum(["COP", "USD"]),
    condiciones_pago: z.string().min(1),
    aprobador: z.object({
      email: z.string().min(3),
      fecha_aprobacion: Fecha,
      evidencia_sha256: Sha256,
    }),
    posiciones: z
      .array(
        z.object({
          numero: z.number().int().positive().multipleOf(10),
          descripcion: z.string().min(1).max(40),
          cantidad: z.number().positive(),
          unidad: z.enum(["UN", "H", "MES"]),
          precio_unitario: z.number().nonnegative(),
          centro_costo: z.string().min(1),
          subarea: z.string().min(1),
          indicador_iva: z.string().min(1),
        }),
      )
      .min(1),
    excepciones: z.array(
      z.object({
        codigo: Regla,
        detalle: z.string(),
        // Siempre null en el payload sellado; quién confirmó vive en la Autorizacion.
        confirmado_por: z.string().nullable(),
      }),
    ),
  })
  .strict()
export type OrdenCompra = z.infer<typeof OrdenCompra>

// ---------------------------------------------------------------------------
// Artefactos persistidos en out/
// ---------------------------------------------------------------------------

export const FuenteTraza = z.union([
  z.enum(["solicitud", "cotizacion", "derivado"]),
  z.string().regex(/^maestro\.[a-z-]+$/),
])

export const Trazabilidad = z.object({
  solicitud_id: z.string(),
  payload_sha: Sha256,
  generado_en: FechaHora,
  campos: z.array(
    z.object({
      ruta: z.string(),
      valor: z.unknown(),
      fuente: FuenteTraza,
      detalle: z.string(),
    }),
  ),
  controles: z.array(ResultadoControl),
})
export type Trazabilidad = z.infer<typeof Trazabilidad>

// out/<caso>/payload.json — inmutable una vez escrito
export const PayloadSellado = z.object({
  payload: OrdenCompra,
  payload_sha: Sha256,
  confirmaciones: z.array(Regla),
  construido_en: FechaHora,
})
export type PayloadSellado = z.infer<typeof PayloadSellado>

// Autorización de ejecución: la crea solo el runtime a partir de una acción del usuario.
export const Autorizacion = z.object({
  id: z.string().min(1),
  accion: z.literal("crear_oc"),
  caso: Caso,
  payload_sha: Sha256,
  session_id: z.string().min(1),
  turno_id: z.string().min(1),
  actor: z.string().min(1),
  origen: z.enum(["boton", "mensaje"]),
  otorgada_en: FechaHora,
  consumida: z.boolean(),
})
export type Autorizacion = z.infer<typeof Autorizacion>

// out/<caso>/ejecucion.json — registro de ejecución separado del payload
export const Ejecucion = z.object({
  numero_oc: NumeroOc,
  fecha: Fecha,
  payload_sha: Sha256,
  idempotente: z.boolean(),
  autorizacion: Autorizacion.nullable(),
})
export type Ejecucion = z.infer<typeof Ejecucion>

// Línea de out/sap/ordenes.jsonl (el adaptador solo recibe la orden: PRD 7.4)
export const OrdenRegistrada = z.object({
  numero_oc: NumeroOc,
  fecha: Fecha,
  orden: OrdenCompra,
})
export type OrdenRegistrada = z.infer<typeof OrdenRegistrada>

// Fila de out/control.csv (PRD HU-5): solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts
export const FilaControl = z.object({
  solicitud_id: z.string().min(1),
  resultado: z.enum(["exitoso", "bloqueado", "pendiente"]),
  numero_oc: z.union([NumeroOc, z.literal("")]),
  retroactiva: z.boolean(),
  bloqueos: z.array(Regla),
  confirmaciones: z.array(Regla),
  ts: FechaHora,
})
export type FilaControl = z.infer<typeof FilaControl>

// Línea de out/log.jsonl (CA4). Sin argumentos completos, sin textos de correo, sin secretos.
export const LineaLog = z.object({
  ts: FechaHora,
  sesion: z.string(),
  herramienta: z.string(),
  caso: z.string().nullable(),
  ok: z.boolean(),
  codigo_error: CodigoError.optional(),
  resumen: z.string(),
  duracion_ms: z.number().nonnegative(),
})
export type LineaLog = z.infer<typeof LineaLog>

// ---------------------------------------------------------------------------
// Contratos de las 5 tools P0 (congelados). Inputs: solo caso y referencias.
// ---------------------------------------------------------------------------

export const ArgsSoloCaso = { caso: Caso }

export const ArgsCrear = {
  caso: Caso,
  payload_sha: Sha256.optional().describe(
    "Hash del payload sellado que se pretende ejecutar; obligatorio salvo para registrar un intento bloqueado",
  ),
}

export const DataLeerPaquete = Paquete.extend({ resumen: z.string() })
export type DataLeerPaquete = z.infer<typeof DataLeerPaquete>

export const DataValidar = z.object({
  solicitud_id: z.string(),
  apta: z.boolean(),
  bloqueos: z.array(Hallazgo),
  confirmaciones: z.array(Hallazgo),
  derivados: Derivados,
  retroactiva: z.boolean(),
  controles: z.array(ResultadoControl).length(10),
  resumen: z.string(),
})
export type DataValidar = z.infer<typeof DataValidar>

export const DataEvidencia = z.object({
  ruta: z.string(),
  sha256: Sha256,
  ruta_pdf: z.string().nullable(),
  reutilizada: z.boolean(),
  resumen: z.string(),
})
export type DataEvidencia = z.infer<typeof DataEvidencia>

export const DataConstruirPayload = z.object({
  payload: OrdenCompra,
  payload_sha: Sha256,
  requiere_confirmacion: z.boolean(),
  confirmaciones: z.array(Hallazgo),
  ruta_payload: z.string(),
  ruta_trazabilidad: z.string(),
  resumen: z.string(),
})
export type DataConstruirPayload = z.infer<typeof DataConstruirPayload>

export const DataCrear = z.object({
  numero_oc: NumeroOc,
  fecha: Fecha,
  idempotente: z.boolean(),
  solicitud_id: z.string(),
  payload_sha: Sha256,
  retroactiva: z.boolean(),
  autorizacion_id: z.string().nullable(),
  ruta_evidencia: z.string(),
  resumen: z.string(),
})
export type DataCrear = z.infer<typeof DataCrear>
