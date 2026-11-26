// Arrastrar y soltar tarjetas del tablero (mouse y pantalla táctil)
//
// Mouse: se arrastra apenas el puntero se mueve unos píxeles.
// Táctil: hay que mantener presionada la tarjeta ~0,3 s; si el dedo se mueve antes,
// se interpreta como desplazamiento normal de la pantalla.
// La tarjeta real se mueve dentro del DOM para mostrar dónde quedará; al soltar se
// llama a alSoltar(id, columna, idAnterior, idSiguiente).

let estado = null;
let quitarClic = false;
let opciones = { alSoltar: () => {} };

const ESPERA_TACTIL = 320;
const UMBRAL_MOUSE = 6;
const UMBRAL_TACTIL = 10;
const BORDE = 48;

export function iniciarArrastre(opc) {
  opciones = opc;
  document.addEventListener('pointerdown', alPresionar);
  document.addEventListener('pointermove', alMover, { passive: false });
  document.addEventListener('pointerup', alSoltarPuntero);
  document.addEventListener('pointercancel', alCancelar);
  // Mientras se arrastra con el dedo, la pantalla no debe desplazarse
  document.addEventListener('touchmove', e => { if (estado?.activo) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', e => { if (estado || e.target.closest?.('.tarjeta')) e.preventDefault(); });
  // Un clic justo después de soltar no debe abrir la tarea
  document.addEventListener('click', e => { if (quitarClic) { e.preventDefault(); e.stopPropagation(); quitarClic = false; } }, true);
}

function alPresionar(ev) {
  const card = ev.target.closest?.('#tablero .tarjeta');
  if (!card || ev.button > 0 || ev.target.closest('.check, input, textarea, select') || document.body.classList.contains('modo-sel')) return;
  const tactil = ev.pointerType !== 'mouse';
  estado = { card, id: card.dataset.id, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, tactil, activo: false };
  if (tactil) estado.timer = setTimeout(empezar, ESPERA_TACTIL);
}

function empezar() {
  if (!estado || estado.activo) return;
  const { card } = estado;
  const r = card.getBoundingClientRect();
  estado.activo = true;
  estado.dx = estado.x0 - r.left;
  estado.dy = estado.y0 - r.top;
  estado.origen = card.closest('.columna')?.dataset.col ?? '';
  const fantasma = card.cloneNode(true);
  fantasma.classList.add('tarjeta-fantasma');
  fantasma.style.width = `${r.width}px`;
  document.body.appendChild(fantasma);
  estado.fantasma = fantasma;
  card.classList.add('arrastrando');
  document.body.classList.add('arrastrando-tarjeta');
  navigator.vibrate?.(25);
  ubicarFantasma();
  estado.raf = requestAnimationFrame(autoDesplazar);
}

function alMover(ev) {
  if (!estado) return;
  estado.x = ev.clientX;
  estado.y = ev.clientY;
  const d = Math.hypot(estado.x - estado.x0, estado.y - estado.y0);
  if (!estado.activo) {
    if (estado.tactil) { if (d > UMBRAL_TACTIL) cancelar(); return; }
    if (d > UMBRAL_MOUSE) empezar(); else return;
  }
  ev.preventDefault();
  ubicarFantasma();
  ubicarTarjeta();
}

function ubicarFantasma() {
  const { fantasma, x, y, dx, dy } = estado;
  fantasma.style.transform = `translate(${x - dx}px, ${y - dy}px) rotate(2deg)`;
}

/** Mueve la tarjeta real al lugar donde caería */
function ubicarTarjeta() {
  const { card, x, y } = estado;
  const bajo = document.elementFromPoint(x, y);
  // La columna bajo el dedo; si se suelta en un espacio vacío, la que esté a esa altura horizontal
  const col = bajo?.closest?.('.columna[data-col]') || [...document.querySelectorAll('.columna[data-col]')]
    .find(c => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right; });
  if (!col) return;
  const lista = col.querySelector('.tarjetas');
  const otras = [...lista.children].filter(el => el !== card && el.classList.contains('tarjeta'));
  const siguiente = otras.find(el => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
  if (siguiente) { if (card.nextElementSibling !== siguiente) lista.insertBefore(card, siguiente); }
  else if (lista.lastElementChild !== card) lista.appendChild(card);
  document.querySelectorAll('.columna.destino').forEach(c => c !== col && c.classList.remove('destino'));
  col.classList.add('destino');
}

/** Desplaza el tablero o la página cuando la tarjeta llega a un borde */
function autoDesplazar() {
  if (!estado?.activo) return;
  const tablero = document.getElementById('tablero');
  const { x, y } = estado;
  let movio = false;
  if (tablero) {
    const r = tablero.getBoundingClientRect();
    if (x < r.left + BORDE) { tablero.scrollLeft -= 14; movio = true; }
    else if (x > r.right - BORDE) { tablero.scrollLeft += 14; movio = true; }
  }
  if (y < 80) { window.scrollBy(0, -12); movio = true; }
  else if (y > innerHeight - 110) { window.scrollBy(0, 12); movio = true; }
  if (movio) ubicarTarjeta();
  estado.raf = requestAnimationFrame(autoDesplazar);
}

function terminar(guardar) {
  if (!estado) return;
  clearTimeout(estado.timer);
  if (estado.activo) {
    cancelAnimationFrame(estado.raf);
    estado.fantasma.remove();
    estado.card.classList.remove('arrastrando');
    document.body.classList.remove('arrastrando-tarjeta');
    document.querySelectorAll('.columna.destino').forEach(c => c.classList.remove('destino'));
    quitarClic = true;
    setTimeout(() => { quitarClic = false; }, 400);
    if (guardar) {
      const { card, id } = estado;
      const col = card.closest('.columna');
      const ant = card.previousElementSibling?.classList.contains('tarjeta') ? card.previousElementSibling.dataset.id : null;
      const sig = card.nextElementSibling?.classList.contains('tarjeta') ? card.nextElementSibling.dataset.id : null;
      opciones.alSoltar(id, col?.dataset.col ?? estado.origen, ant, sig);
    }
  }
  estado = null;
}

function cancelar() { clearTimeout(estado?.timer); estado = null; }
const alSoltarPuntero = () => terminar(true);
const alCancelar = () => terminar(true);

export const arrastrando = () => !!estado?.activo;
