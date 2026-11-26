# Gestor agenda: notas para trabajar en este repositorio

PWA personal (tareas en tablero, recordatorios, notas, finanzas) publicada con GitHub Pages desde la rama `main` (raíz). Respaldo y avisos en Supabase.

## Reglas
- Todo el texto de la interfaz va en español (Colombia), dinero en COP sin decimales.
- Sin paso de compilación: HTML, CSS y JS modules servidos tal cual. Las librerías viven en `vendor/` para que funcione sin conexión.
- Cada vez que cambie un archivo de la app, sube `VERSION` en `sw.js` (por ejemplo `ga-v1.2.0` → `ga-v1.2.1`) y, si es un archivo nuevo, agrégalo a `ARCHIVOS` en `sw.js`.
- Si cambia la estructura de IndexedDB, sube `DB_VERSION` en `js/db.js` y la versión en `abrirDB()` de `sw.js` (deben coincidir).
- Cambios de base de datos: van en `supabase/esquema.sql` (debe poder ejecutarse varias veces). El usuario los ejecuta a mano en el SQL Editor; entrégale el SQL exacto a ejecutar.
- La función `supabase/functions/avisos/index.ts` se despliega a mano desde el panel de Supabase (Verify JWT desactivado).
- Imágenes de notas: tipo `imagenes` (pesado: en memoria solo metadatos, `dataUrl` en IndexedDB; se sincroniza en lotes de 4 con cursor propio). En el texto se escriben `![foto N](img:N)` y la nota guarda `imagenes: { N: uuid }`.
- La sección Hábitos se quitó de la interfaz (el tipo `habitos` sigue en la base para no perder datos).
- Tablero por estado (`estadoTarea`: terminadas › pausadas › repetitivas › por hacer); categoría como etiqueta y filtro. `js/tablero.js` arrastra con mouse o presión larga; orden de tarjeta `orden ?? creadoEn`. Las tareas `pausada` no salen en Hoy ni avisan.
- Plantilla de apuntes de clase: nota oculta con `plantilla: 'clase'`; usar `notasReales()` para listar notas.
- Diseño móvil compacto (bloque "CELULAR" al final de `styles.css`); probar en 360 px y 393 px de ancho sin desbordes horizontales.
