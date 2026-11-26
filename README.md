# Gestor agenda

PWA para organizar el día: **tareas en tablero con recordatorios, notas con imágenes y finanzas**. Funciona sin internet, se instala en el celular (Android) y en el computador (Chrome o Edge), y guarda una copia en **Supabase** para no perder nada si pierdes el teléfono.

## Qué incluye

| Sección | Qué hace |
|---|---|
| **Hoy** | Tareas del día y atrasadas, progreso, hábitos que tocan hoy. Captura rápida: `Calificar parcial mañana 3pm #docencia !` |
| **Tareas** | **Tablero** por estado: Por hacer, Pausadas, Repetitivas y Terminadas (arrastrar tarjetas para cambiar de estado o reordenar; en el celular mantener presionada). Cada tarjeta muestra su **categoría**, con filtro por categoría. También vista **Lista**. Selección múltiple para eliminar, marcar hechas o mover. Subtareas, prioridad, hora, repetición |
| **Recordatorios** | Aviso el mismo día o días antes, a una hora. Se repite (30 min, 1 h, 3 h o diario) **hasta que marques la tarea como hecha**. Botones *Marcar hecha* y *Posponer 1 h* en la notificación; más opciones al abrirla |
| **Pagos** | Una tarea puede tener *Valor a pagar*: al marcarla hecha pregunta cuánto pagaste y lo registra como gasto. Si es mensual, pasa sola al mes siguiente con su aviso |
| **Finanzas** | Saldo inicial (cuánto tienes hoy) y **Disponible** acumulado: saldo + ingresos − gastos. Gastos e ingresos por mes con categorías y comparación. **Deudas** que debo y que me deben, con abonos. **Ahorros** con valor actual, meta opcional y aportes o retiros. CSV del mes para Excel |
| **Notas** | Cuadernos (= categorías), Markdown con vista previa, **imágenes** (cámara, galería, pegar o arrastrar; se comprimen a ~100–250 KB), `#etiquetas`, búsqueda, fijar, plantilla de apunte de clase, casillas `- [ ]` que se convierten en tareas |
| **Importar** | Varios `.md` / `.txt` a la vez o un `.zip` (con imágenes), vista previa, detección de duplicados, cuadernos según la carpeta |
| **Compartir** | En Android, la app aparece en el menú *Compartir*: textos y archivos `.md` llegan directo |
| **Exportar** | Notas en Markdown (.zip, una carpeta por cuaderno) y respaldo completo (.json) |
| **Respaldo** | Sincronización con Supabase: sube y baja cambios solo; si un registro cambió en dos equipos, gana el más reciente |

En pantallas anchas (computador) la app cambia sola a barra lateral, lista y editor de notas lado a lado, y atajos de teclado (`N`, `/`, `1`–`5`, `Ctrl+S`, `Esc`).

---

## 1. Crear el respaldo en Supabase (una sola vez)

1. Entra a <https://supabase.com>, crea una cuenta y un proyecto nuevo (el plan gratuito sirve).
2. En el proyecto ve a **SQL Editor → New query**, pega todo el archivo `supabase/esquema.sql` y pulsa **Run**. (Se puede volver a ejecutar sin perder datos; hazlo cada vez que actualices la app.)
3. Ve a **Project Settings → API Keys** y copia:
   - la **URL del proyecto** (`https://xxxx.supabase.co`, también aparece en *Data API*)
   - la clave **publishable** (`sb_publishable_…`) o, en proyectos antiguos, la **anon**.
   ⚠️ Nunca uses la clave *secret* ni *service_role* en la app.
4. **Authentication → Sign In / Providers → Email**: déjalo activado. Si no quieres confirmar el correo al crear la cuenta, desactiva *Confirm email*.
5. **Authentication → URL Configuration**: en *Site URL* pon la dirección donde publicaste la app (paso 2), para que el enlace de confirmación vuelva a ella.

## 2. Publicar la app (gratis, con HTTPS)

Una PWA necesita HTTPS para instalarse. La opción más simple es **GitHub Pages**:

1. Crea un repositorio en GitHub (por ejemplo `gestor-agenda`) y sube **todo el contenido de esta carpeta** (el `index.html` debe quedar en la raíz).
2. En el repositorio: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
3. En un minuto queda en `https://TU-USUARIO.github.io/gestor-agenda/`.

Alternativa: arrastra la carpeta a <https://app.netlify.com/drop>.

> Para probarla en tu PC sin publicar: en esta carpeta ejecuta `python -m http.server 8000` y abre `http://localhost:8000`.

## 3. Instalarla

**Redmi Note 12 Pro+ (Chrome):** abre la URL → menú ⋮ → **Instalar app** (o *Agregar a la pantalla principal*).
Luego, para que MIUI/HyperOS no la cierre en segundo plano: *Ajustes → Apps → Chrome → Ahorro de batería → Sin restricciones*.

**Computador (Chrome o Edge):** abre la URL → ícono de instalar a la derecha de la barra de direcciones. Queda como programa con su propia ventana y en el menú Inicio.

**Conectar el respaldo:** en la app, **Ajustes → Respaldo en la nube**: pega URL y clave → *Guardar conexión* → *Crear cuenta* (la primera vez) o *Entrar*. Haz lo mismo en el PC con la misma cuenta y verás los mismos datos.

## 4. Recordatorios con la app cerrada (opcional, una sola vez)

Sin este paso los avisos aparecen solo mientras la app está abierta o en segundo plano reciente. Con él, Supabase revisa cada minuto qué avisos tocan y los envía a tu celular y a tu PC.

1. En la app: **Ajustes → Recordatorios → Configurar el servidor de avisos → Generar claves**. Copia los dos valores.
2. En Supabase: **Edge Functions → Secrets** (o *Project Settings → Edge Functions*), crea:
   - `VAPID_PRIVATE_KEY` = la clave privada (el texto que empieza con `{"kty":"EC"…`)
   - `AVISOS_SECRETO` = el secreto
   - `VAPID_CONTACTO` = `mailto:tucorreo@ejemplo.com` (opcional)
3. **Edge Functions → Deploy a new function → Via Editor**. Nombre: `avisos`. Borra el ejemplo, pega el contenido de `supabase/functions/avisos/index.ts` y despliega. En los detalles de la función **desactiva la verificación de JWT** (*Verify JWT* / *Enforce JWT verification*): la función se protege con `AVISOS_SECRETO`.
4. **SQL Editor**: abre `supabase/avisos_cron.sql`, reemplaza los dos valores marcados con `<<< >>>` (tu URL y el mismo secreto) y ejecútalo.
5. En la app, en cada dispositivo: **Ajustes → Recordatorios → Activar en este dispositivo**. Luego usa **Probar con la app cerrada**: cierra la app y en 1–2 minutos debe llegar el aviso.

En el Redmi, además: *Ajustes → Apps → Chrome* (y la app instalada) → **Notificaciones: permitidas**, **Inicio automático: activado**, **Ahorro de batería: sin restricciones**. MIUI/HyperOS bloquea notificaciones de apps en segundo plano si no lo haces.

Para revisar si el servidor está enviando, en el SQL Editor:
`select status_code, content, created from net._http_response order by created desc limit 10;`

## 5. Traer tus notas de Xiaomi

- **Notas exportadas como texto (.txt):** en tu app de notas usa *Exportar → como texto*. En Gestor agenda: **Notas → Importar → Elegir archivos de texto** y marca todos los .txt. La primera línea de cada nota se usa como título (si el archivo tiene un nombre propio, se usa ese nombre).

- **Archivos .md:** exporta desde Notas de Xiaomi → en la app, **Notas → Importar** (o Ajustes → Importar notas) → selecciona todos los archivos (o el .zip). Revisa la lista y pulsa *Importar*.
- **Desde Compartir:** abre una nota en Xiaomi → Compartir → *Gestor agenda*. Si compartes un archivo .md se abre la vista previa; si compartes texto, se crea la nota directamente.
- **Pegar:** Ajustes → *Pegar notas*, separando cada nota con una línea `---`.
- **Tareas copiadas como texto:** en tu lista del celular, *Seleccionar todo → Copiar*; en la app, **Tareas → Pegar tareas** (o *Ajustes → Pegar tareas*). Cada línea es una tarea; entiende casillas ☐ ☑, viñetas, números, fechas (*mañana*, *viernes*, *15/12*), horas (*3pm*), `#área` y `!`. También puedes usar *Compartir → Gestor agenda* y elegir **Tareas**.

## 6. Publicar cambios

Si modificas el código, cambia `VERSION` al inicio de `sw.js` (por ejemplo `ga-v1.0.1`). Los dispositivos verán el aviso **"Hay una versión nueva" → Actualizar**.

---

## Estructura

```
index.html            Estructura de la página
styles.css            Diseño (móvil y escritorio, claro y oscuro)
manifest.webmanifest  Instalación, íconos y "Compartir"
sw.js                 Sin conexión + recepción de lo compartido
supabase/esquema.sql  Tablas, seguridad (RLS), regla "gana el más reciente", avisos
supabase/avisos_cron.sql              Programa la revisión de avisos cada minuto
supabase/functions/avisos/index.ts    Función que envía las notificaciones (Web Push)
js/app.js             Interfaz y vistas
js/db.js              Almacenamiento local (IndexedDB)
js/sync.js            Sincronización con Supabase
js/importer.js        Importar/exportar Markdown y .zip
js/logic.js           Fechas, repeticiones, rachas, captura rápida, cálculo de avisos
js/finanzas.js        Dinero, categorías, deudas y CSV
js/avisos.js          Permisos, notificaciones locales y suscripción push
vendor/               marked, DOMPurify, JSZip, supabase-js (locales para funcionar sin internet)
fonts/, icons/
```

### Cómo funciona el respaldo

- Todo se guarda primero en el dispositivo (IndexedDB), así funciona sin señal.
- Cada cambio queda marcado como pendiente; unos segundos después (o al recuperar internet, abrir la app o cada 5 min) se sincroniza: primero baja lo nuevo de la nube y luego sube lo pendiente.
- En Supabase hay una sola tabla, `registros`, con el contenido en JSON. Las políticas RLS hacen que cada cuenta solo vea sus datos. Las vistas `v_tareas` y `v_notas` sirven para consultarlos desde el panel de Supabase.
- Los borrados también se sincronizan (quedan marcados como eliminados).

### Límites actuales

- Los montos se manejan en pesos colombianos sin decimales.
- Las notificaciones del servidor usan el cifrado `aesgcm` de Web Push (compatible con Chrome y Edge en Android y Windows).
- Las imágenes de notas importadas desde .zip se reducen (máx. 1280 px) y se guardan dentro de la nota.
- Si inicias sesión con otra cuenta en el mismo dispositivo, los datos locales se suben a esa cuenta.
