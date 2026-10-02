// Chat UI (vanilla JS). No contiene lógica de negocio: muestra lo que devuelve la API.
// Todo el contenido del modelo, del usuario y de las tools se inserta con textContent.
"use strict";

const CLAVE_SESION = "oc-agent.sessionId";
const ETIQUETAS_REGLAS = {
  RC5: "RC5 · cotización difiere más de 2 % de la solicitud",
  RC6: "RC6 · indicador de IVA derivado del proveedor",
  RC8: "RC8 · OC retroactiva (factura anterior a la solicitud)",
  RC9: "RC9 · aprobación anterior a la solicitud",
};

const $ = (id) => document.getElementById(id);
const conversacion = $("conversacion");
const entrada = $("entrada");
const enviar = $("enviar");
const banner = $("banner");
const confirmar = $("confirmar");
const rechazar = $("rechazar");
const procesando = $("procesando");

let pendiente = null;
let ocupado = false;

// ---------------------------------------------------------------------------
// Sesión (identificador de navegador; no es una identidad verificada)
// ---------------------------------------------------------------------------

function leerSesion() {
  try {
    const guardada = localStorage.getItem(CLAVE_SESION);
    if (guardada && /^[A-Za-z0-9-]{8,64}$/.test(guardada)) return guardada;
  } catch {}
  return null;
}

function nuevaSesion() {
  const id = crypto.randomUUID();
  try { localStorage.setItem(CLAVE_SESION, id); } catch {}
  return id;
}

let sessionId = leerSesion() || nuevaSesion();

function mostrarSesion() {
  $("sesion").textContent = `Sesión ${sessionId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function el(tag, clase, texto) {
  const nodo = document.createElement(tag);
  if (clase) nodo.className = clase;
  if (texto !== undefined) nodo.textContent = texto;
  return nodo;
}

function bajar() {
  conversacion.scrollTop = conversacion.scrollHeight;
}

function mensaje(rol, texto) {
  conversacion.appendChild(el("div", `mensaje ${rol}`, texto));
  bajar();
}

// Argumentos que recibió la tool, ya saneados por el servidor (objetos grandes vienen resumidos).
function valorArgumento(v) {
  if (v !== null && typeof v === "object") {
    const partes = Object.entries(v).map(([k, x]) => `${k}=${k === "payload_sha" && typeof x === "string" ? `${x.slice(0, 12)}…` : String(x)}`);
    return `{${partes.join(", ")}}`;
  }
  return String(v);
}

function textoArgumentos(argumentos) {
  if (!argumentos || typeof argumentos !== "object") return "";
  return Object.entries(argumentos).map(([k, v]) => `${k}: ${valorArgumento(v)}`).join(" · ");
}

function tarjetas(eventos) {
  if (!eventos || eventos.length === 0) return;
  const grupo = el("div", "herramientas");
  for (const e of eventos) {
    const tarjeta = el("div", `tool ${e.ok ? "ok" : "fallo"}`);
    tarjeta.appendChild(el("span", "icono", e.ok ? "✓" : "✕"));
    const titulo = el("span", "titulo", e.caso ? `${e.herramienta} · ${e.caso}` : e.herramienta);
    // Número de OC tomado del resumen de la tool (no del texto del modelo).
    const oc = e.ok && e.herramienta === "oc_crear" ? /\b45\d{8}\b/.exec(e.resumen) : null;
    if (oc) titulo.appendChild(el("span", "oc", `OC ${oc[0]}`));
    tarjeta.appendChild(titulo);
    const args = textoArgumentos(e.argumentos);
    if (args) tarjeta.appendChild(el("span", "args", args));
    tarjeta.appendChild(el("span", "resumen", e.resumen));
    grupo.appendChild(tarjeta);
  }
  conversacion.appendChild(grupo);
  bajar();
}

// El banner depende SOLO de needsConfirmation / pendingConfirmation (estado del runtime).
function actualizarBanner(needsConfirmation, pendingConfirmation) {
  pendiente = needsConfirmation && pendingConfirmation ? pendingConfirmation : null;
  banner.hidden = pendiente === null;
  if (pendiente === null) return;
  $("banner-caso").textContent = pendiente.caso;
  const reglas = $("banner-reglas");
  reglas.textContent = "";
  for (const r of pendiente.reglas) reglas.appendChild(el("div", "", ETIQUETAS_REGLAS[r] || r));
  $("banner-sha").textContent = `${pendiente.payload_sha.slice(0, 16)}…`;
}

function ocupar(estado) {
  ocupado = estado;
  entrada.disabled = estado;
  enviar.disabled = estado;
  confirmar.disabled = estado;
  rechazar.disabled = estado;
  for (const chip of document.querySelectorAll(".chip")) chip.disabled = estado;
  procesando.hidden = !estado;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function llamar(ruta, cuerpo) {
  let res;
  try {
    res = await fetch(ruta, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  } catch {
    return { ok: false, error: { mensaje: "No se pudo contactar al servidor." } };
  }
  try {
    return await res.json();
  } catch {
    return { ok: false, error: { mensaje: `Respuesta inesperada del servidor (HTTP ${res.status}).` } };
  }
}

function mostrarTurno(r) {
  if (!r.ok) {
    mensaje("error", (r.error && r.error.mensaje) || "Error desconocido.");
    return;
  }
  const d = r.data;
  tarjetas(d.eventos);
  if (d.respuesta) mensaje(d.estado === "completado" ? "agente" : d.estado.startsWith("confirmacion") ? "agente" : "error", d.respuesta);
  if (d.autorizacion && d.autorizacion.consumida) mensaje("sistema", `Autorización humana usada (${d.autorizacion.origen === "boton" ? "botón" : "mensaje"}).`);
  actualizarBanner(d.needsConfirmation, d.pendingConfirmation);
}

async function enviarMensaje(texto) {
  if (ocupado || !texto.trim()) return;
  ocupar(true);
  mensaje("usuario", texto);
  actualizarBanner(false, null); // cualquier mensaje nuevo cancela el pendiente en el runtime
  mostrarTurno(await llamar("/api/chat", { sessionId, message: texto }));
  ocupar(false);
  entrada.focus();
}

async function confirmarPendiente() {
  if (ocupado || pendiente === null) return;
  const { caso, payload_sha } = pendiente;
  ocupar(true);
  mensaje("usuario", `Confirmo la OC de ${caso}`);
  actualizarBanner(false, null);
  mostrarTurno(await llamar("/api/confirm", { sessionId, action: "confirm", caso, payload_sha }));
  ocupar(false);
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function salud() {
  const llm = $("llm");
  try {
    const res = await fetch("/api/health");
    const h = await res.json();
    llm.textContent = h.llmConfigured ? "LLM ● configurado" : "LLM ○ no configurado";
    llm.className = `pastilla ${h.llmConfigured ? "on" : "off"}`;
  } catch {
    llm.textContent = "LLM ○ sin conexión";
    llm.className = "pastilla off";
  }
}

async function recuperarSesion() {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const r = await res.json();
    if (!r.ok) return;
    if (r.data.historial.length > 0) mensaje("sistema", "Sesión recuperada");
    for (const m of r.data.historial) mensaje(m.rol, m.texto);
    if (r.data.eventos.length > 0) tarjetas(r.data.eventos);
    actualizarBanner(r.data.needsConfirmation, r.data.pendingConfirmation);
  } catch {}
}

$("formulario").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const texto = entrada.value;
  entrada.value = "";
  enviarMensaje(texto);
});

entrada.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    $("formulario").requestSubmit();
  }
});

confirmar.addEventListener("click", confirmarPendiente);
rechazar.addEventListener("click", () => enviarMensaje("no confirmo"));

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    entrada.value = chip.dataset.texto || "";
    entrada.focus();
  });
}

$("nueva-sesion").addEventListener("click", () => {
  sessionId = nuevaSesion();
  mostrarSesion();
  conversacion.textContent = "";
  actualizarBanner(false, null);
  mensaje("sistema", "Nueva sesión iniciada");
});

mostrarSesion();
salud();
recuperarSesion();
