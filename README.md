# 🎥 API de Descarga de Videos con yt-dlp y FFmpeg

Esta es una API Node.js/Express robusta que te permite obtener información y descargar videos de diversas plataformas (principalmente YouTube) utilizando `yt-dlp` y `FFmpeg`. La API está diseñada para gestionar el tamaño de los archivos, priorizar la calidad, asegurar la inclusión de audio y limpiar los archivos temporales.

-----

## 🌟 Características Principales

  * **Obtención de Información de Videos**: Consulta detalles completos de cualquier video compatible.
  * **Descarga Inteligente de Videos**:
      * Prioriza la **mejor calidad** disponible.
      * **Límite de Tamaño Configurable**: Descarga videos hasta un tamaño máximo (por defecto 100 MB), degradando la calidad si es necesario para cumplir el límite.
      * **Audio Incluido**: Si el formato de mejor calidad viene sin audio, la API descargará el video y audio por separado, y usará `FFmpeg` para combinarlos automáticamente.
      * Soporte para formatos **MP4 y WebM**.
  * **Gestión de Archivos Temporales**: Los videos descargados se eliminan automáticamente después de un tiempo configurable (por defecto 1 hora).
  * **Timeouts Robusto**: Manejo de timeouts para evitar que las solicitudes se queden colgadas.

-----

## 🚀 Cómo Empezar

Sigue estos pasos para configurar y ejecutar la API en tu entorno local.

### 📋 Prerrequisitos

Necesitas tener instalados los siguientes programas en tu sistema y accesibles desde el `PATH`:

  * **Node.js** (versión 18 o superior recomendada)
  * **npm** (viene con Node.js)
  * **yt-dlp**: Una herramienta de línea de comandos para descargar videos.
      * [Guía de instalación de yt-dlp](https://www.google.com/search?q=https://github.com/yt-dlp/yt-dlp%23installation)
  * **FFmpeg**: Una solución completa para grabar, convertir y hacer streaming de audio y video. Necesario para combinar pistas de video y audio.
      * [Guía de instalación de FFmpeg](https://ffmpeg.org/download.html)

### ⚙️ Instalación

1.  **Clona este repositorio** (o copia los archivos de la API a tu máquina):
    ```bash
    git clone <URL_DEL_REPOSITORIO>
    cd <nombre_de_tu_proyecto>
    ```
2.  **Instala las dependencias de Node.js**:
    ```bash
    npm install
    ```
    Si usas `yarn`:
    ```bash
    yarn install
    ```

-----

## ▶️ Ejecución de la API

Para iniciar el servidor de la API:

```bash
npm start
```

O, para desarrollo con recarga en caliente (si usas `ts-node-dev` o similar):

```bash
npm run dev
```

La API se iniciará por defecto en `http://localhost:3005`.

-----

## 🌐 Endpoints de la API

La API expone los siguientes endpoints:

### `GET /`

  * **Descripción**: Verifica que la API está funcionando.
  * **Respuesta Exitosa**:
    ```
    API de yt-dlp funcionando!
    ```

### `POST /api/video-info`

  * **Descripción**: Obtiene información detallada de un video.
  * **Cuerpo de la Solicitud (JSON)**:
    ```json
    {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    }
    ```
  * **Respuesta Exitosa (JSON)**:
    ```json
    {
        "id": "dQw4w9WgXcQ",
        "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
        "duration": 212,
        "uploader": "Rick Astley",
        "formats": [
            { /* ... detalles del formato ... */ },
            { /* ... más formatos ... */ }
        ],
        "...": "..."
    }
    ```
  * **Errores Posibles**: `400 Bad Request` (URL faltante), `500 Internal Server Error` (Error de `yt-dlp` o del servidor).

### `POST /api/download`

  * **Descripción**: Inicia la descarga de un video con audio, respetando el límite de tamaño y el formato (MP4/WebM).
  * **Cuerpo de la Solicitud (JSON)**:
    ```json
    {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        // "format": "best" // Opcional, pero la API selecciona automáticamente para cumplir límites.
    }
    ```
  * **Respuesta Exitosa (JSON)**:
    ```json
    {
        "message": "Descarga iniciada y completada con éxito.",
        "filePath": "/ruta/en/servidor/downloads/video_id_1678888888888.mp4",
        "downloadUrl": "/downloads/video_id_1678888888888.mp4",
        "estimatedSizeMB": 15,
        "formatUsed": "bestvideo+bestaudio",
        "muxedByFFmpeg": true
    }
    ```
    El `downloadUrl` es relativo a la raíz de la API y puede ser usado para que un cliente descargue el archivo directamente.
  * **Errores Posibles**:
      * `400 Bad Request` (URL faltante).
      * `413 Payload Too Large` (El video, incluso en su formato más pequeño o combinado, excede el `maxDownloadSizeMB`).
      * `500 Internal Server Error` (Errores de `yt-dlp`, `FFmpeg` no encontrado, o problemas internos).
      * `503 Service Unavailable` / `504 Gateway Timeout` (La solicitud excedió el tiempo de espera del servidor o la descarga de `yt-dlp` tardó demasiado).

-----

## 🛠️ Configuración

Puedes configurar la API pasando un objeto de configuración al constructor de la clase `YoutubeDLPApi` en `index.ts` (o tu archivo principal).

```typescript
const api = new YoutubeDLPApi({
    port: 3005,                     // Puerto donde la API escuchará (por defecto: 3005)
    timeout: 15 * 1000,             // Timeout de respuesta para todas las solicitudes en ms (por defecto: 15000 ms = 15s)
    downloadDir: path.join(__dirname, '..', 'downloads'), // Directorio de descargas (por defecto: `../downloads`)
    fileRetentionTimeSeconds: 3600, // Tiempo que un archivo se mantiene antes de ser eliminado en segundos (por defecto: 3600s = 1 hora)
    cleanUpIntervalSeconds: 600,    // Frecuencia con la que se ejecuta la tarea de limpieza en segundos (por defecto: 600s = 10 minutos)
    maxDownloadSizeMB: 100          // Tamaño máximo de los videos a descargar en MB (por defecto: 100 MB)
});
api.start();
```

-----

## 🧹 Limpieza Automática de Archivos

La API incluye un proceso de limpieza que se ejecuta periódicamente (cada `cleanUpIntervalSeconds`) y elimina los archivos descargados del directorio `downloads` que sean más antiguos que `fileRetentionTimeSeconds`. Esto ayuda a gestionar el espacio en disco.

-----

## 🤝 Contribuciones

¡Las contribuciones son bienvenidas\! Si tienes ideas para mejoras, reportes de errores o deseas añadir nuevas funcionalidades, no dudes en abrir un *issue* o enviar un *pull request*.

-----

## 📄 Licencia

Este proyecto está bajo la licencia [MIT](https://opensource.org/licenses/MIT).

-----
