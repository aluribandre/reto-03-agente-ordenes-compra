// Proveedor Anthropic detrás de LlmAdapter, con el SDK oficial (@anthropic-ai/sdk, Messages API).
// - La clave la resuelve el SDK desde el entorno (ANTHROPIC_API_KEY); nunca pasa por este módulo.
// - Timeout y reintentos acotados (opciones del SDK); sin streaming.
// - Errores traducidos a ErrorLlm con mensajes fijos: nunca se reenvía el texto crudo del proveedor.
//   Para operación, los errores HTTP dejan una línea saneada en stderr (diagnosticoError).
import Anthropic from "@anthropic-ai/sdk"
import { ErrorLlm, type DefinicionTool, type LlmAdapter, type Mensaje, type MotivoFin, type RespuestaLlm } from "./adapter"

export type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

export type OpcionesAnthropic = {
  modelo: string
  maxTokens: number
  timeoutMs: number
  maxReintentos: number
  esfuerzo: Esfuerzo
}

const MOTIVOS: Record<string, MotivoFin> = {
  end_turn: "fin_turno",
  stop_sequence: "fin_turno",
  tool_use: "uso_tool",
  max_tokens: "max_tokens",
  refusal: "rechazo",
  pause_turn: "pausa",
  model_context_window_exceeded: "limite_contexto",
}

function esContenido(valor: unknown): valor is Anthropic.ContentBlock[] {
  return Array.isArray(valor)
}

function aTool(d: DefinicionTool): Anthropic.Tool {
  return { name: d.nombre, description: d.descripcion, input_schema: { ...d.esquema, type: "object" } }
}

// El asistente se reenvía con su contenido original (append-only); si no lo hay, se reconstruye.
function aParam(m: Mensaje): Anthropic.MessageParam {
  switch (m.rol) {
    case "usuario":
      return { role: "user", content: m.texto }
    case "asistente": {
      if (esContenido(m.crudo)) return { role: "assistant", content: m.crudo }
      const bloques: Anthropic.ContentBlockParam[] = []
      if (m.texto !== "") bloques.push({ type: "text", text: m.texto })
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.argumentos })
      return { role: "assistant", content: bloques }
    }
    case "resultados":
      return {
        role: "user",
        content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
      }
  }
}

function deRespuesta(r: Anthropic.Message): RespuestaLlm {
  const textos: string[] = []
  const llamadas: RespuestaLlm["llamadas"] = []
  for (const b of r.content) {
    if (b.type === "text") textos.push(b.text)
    else if (b.type === "tool_use") llamadas.push({ id: b.id, nombre: b.name, argumentos: b.input })
  }
  return {
    texto: textos.join("\n").trim(),
    llamadas,
    motivo: (r.stop_reason !== null && MOTIVOS[r.stop_reason]) || "otro",
    uso: {
      entrada: r.usage.input_tokens,
      salida: r.usage.output_tokens,
      cacheEscritura: r.usage.cache_creation_input_tokens ?? 0,
      cacheLectura: r.usage.cache_read_input_tokens ?? 0,
    },
    crudo: r.content,
  }
}

// Más específico primero (APIConnectionTimeoutError es subclase de APIConnectionError, que lo es de APIError).
export function traducirError(e: unknown): ErrorLlm {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErrorLlm("timeout", "El modelo no respondió a tiempo.")
  if (e instanceof Anthropic.APIConnectionError) return new ErrorLlm("red", "No se pudo conectar con el proveedor del modelo.")
  if (e instanceof Anthropic.AuthenticationError) return new ErrorLlm("autenticacion", "Credenciales del proveedor inválidas o ausentes.")
  if (e instanceof Anthropic.PermissionDeniedError) return new ErrorLlm("permiso", "La credencial no tiene acceso a este modelo u operación.")
  if (e instanceof Anthropic.RateLimitError) return new ErrorLlm("limite", "El proveedor limitó la tasa de peticiones; reintentar más tarde.")
  if (e instanceof Anthropic.InternalServerError) return new ErrorLlm("no_disponible", "El proveedor del modelo no está disponible en este momento.")
  if (e instanceof Anthropic.NotFoundError) return new ErrorLlm("peticion_invalida", "El modelo configurado no existe o no está disponible.")
  if (e instanceof Anthropic.BadRequestError) return new ErrorLlm("peticion_invalida", "El proveedor rechazó la petición por inválida.")
  return new ErrorLlm("desconocido", "Error inesperado al llamar al modelo.")
}

// ---------------------------------------------------------------------------
// Diagnóstico saneado para stderr (operación). El usuario sigue viendo solo el mensaje fijo.
// Solo status, tipo, request_id y el mensaje del proveedor redactado y truncado: nunca
// cabeceras, clave, system prompt, mensajes, documentos ni inputs de tools.
// ---------------------------------------------------------------------------

const MAX_MENSAJE_DIAGNOSTICO = 500

export function sanearDiagnostico(texto: string): string {
  const saneado = texto
    .replace(/sk-ant-[A-Za-z0-9_-]*/g, "sk-ant-[redactado]")
    .replace(/(?<![A-Za-z])[A-Za-z]:(?:\\{1,2}|\/(?!\/))[^\s"'`]*/g, "[ruta]")
    .replace(/(?<![\w:/.-])\/(?:[\w.-]+\/)+[\w.-]*/g, "[ruta]")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim()
  return saneado.length > MAX_MENSAJE_DIAGNOSTICO ? `${saneado.slice(0, MAX_MENSAJE_DIAGNOSTICO)}…` : saneado
}

// Identificadores (tipo, request_id): solo caracteres seguros.
const identificador = (valor: unknown): string => (typeof valor === "string" && valor !== "" ? valor.replace(/[^\w.-]/g, "").slice(0, 100) : "-")

function mensajeDelCuerpo(cuerpo: unknown): string | null {
  if (typeof cuerpo !== "object" || cuerpo === null) return null
  const error: unknown = Reflect.get(cuerpo, "error")
  if (typeof error !== "object" || error === null) return null
  const mensaje: unknown = Reflect.get(error, "message")
  return typeof mensaje === "string" ? mensaje : null
}

// Línea de diagnóstico para un error HTTP del proveedor; null si no hubo respuesta HTTP (red, timeout).
export function diagnosticoError(e: unknown): string | null {
  if (!(e instanceof Anthropic.APIError) || typeof e.status !== "number") return null
  const mensaje = sanearDiagnostico(mensajeDelCuerpo(e.error) ?? e.message)
  return `[anthropic] status=${e.status} type=${identificador(e.type)} request_id=${identificador(e.requestID)} message="${mensaje}"`
}

export class AnthropicAdapter implements LlmAdapter {
  readonly proveedor = "anthropic"
  readonly modelo: string
  readonly #opciones: OpcionesAnthropic
  readonly #cliente: Anthropic

  constructor(opciones: OpcionesAnthropic) {
    this.#opciones = opciones
    this.modelo = opciones.modelo
    // Sin apiKey explícita: el SDK la lee del entorno. maxRetries acotado (el SDK reintenta 408/409/429/5xx y red).
    this.#cliente = new Anthropic({ timeout: opciones.timeoutMs, maxRetries: opciones.maxReintentos })
  }

  async enviar(mensajes: readonly Mensaje[], herramientas: readonly DefinicionTool[], sistema: string): Promise<RespuestaLlm> {
    try {
      const respuesta = await this.#cliente.messages.create({
        model: this.#opciones.modelo,
        max_tokens: this.#opciones.maxTokens,
        system: sistema,
        tools: herramientas.map(aTool),
        messages: mensajes.map(aParam),
        output_config: { effort: this.#opciones.esfuerzo },
      })
      return deRespuesta(respuesta)
    } catch (e) {
      const diagnostico = diagnosticoError(e)
      if (diagnostico !== null) console.error(diagnostico)
      throw traducirError(e)
    }
  }
}
