import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import http from 'http';

const execPromise = promisify(exec);

interface ApiConfig {
    port?: number;
    downloadDir?: string;
    timeout?: number; // Timeout para la respuesta del servidor (en milisegundos)
    fileRetentionTimeSeconds?: number;
    cleanUpIntervalSeconds?: number;
    maxDownloadSizeMB?: number; // Nuevo: Límite de tamaño de descarga en MB
}

class YoutubeDLPApi {
    private app: Application;
    private port: number;
    private downloadDir: string;
    private server: http.Server | null = null;
    private timeout: number;
    private fileRetentionTimeMs: number;
    private cleanUpIntervalMs: number;
    private cleanUpTimer: NodeJS.Timeout | null = null;
    private maxDownloadSizeBytes: number; // Límite de tamaño de descarga en bytes

    constructor(config?: ApiConfig) {
        this.app = express();
        this.port = config?.port || 3005;
        this.downloadDir = config?.downloadDir || path.join(__dirname, '..', 'downloads');
        this.timeout = config?.timeout || 15 * 1000; // ¡Cambiado a 15 segundos!
        this.fileRetentionTimeMs = (config?.fileRetentionTimeSeconds || 3600) * 1000;
        this.cleanUpIntervalMs = (config?.cleanUpIntervalSeconds || 600) * 1000;
        this.maxDownloadSizeBytes = (config?.maxDownloadSizeMB || 100) * 1024 * 1024; // ¡100 MB por defecto!

        this.configureMiddleware();
        this.setupRoutes();
        this.ensureDownloadDirectoryExists();
    }

    private configureMiddleware(): void {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use('/downloads', express.static(this.downloadDir));
    }

    private ensureDownloadDirectoryExists(): void {
        if (!fs.existsSync(this.downloadDir)) {
            fs.mkdirSync(this.downloadDir, { recursive: true });
            console.log(`Directorio de descargas creado: ${this.downloadDir}`);
        }
    }

    private setupRoutes(): void {
        this.app.get('/', this.handleRoot);
        this.app.post('/api/video-info', this.handleVideoInfo);
        this.app.post('/api/download', this.handleDownload);

        // Middleware de manejo de errores genérico (opcional pero recomendado)
        this.app.use((err: any, req: Request, res: Response, next: Function) => {
            if (res.headersSent) { // Si las cabeceras ya se enviaron, Express ya manejó la respuesta
                return next(err);
            }
            if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
                console.error(`Request timeout for ${req.path}`);
                return res.status(503).json({ error: 'La solicitud ha excedido el tiempo de espera.' });
            }
            console.error('Error no capturado:', err);
            res.status(500).json({ error: 'Error interno del servidor.', details: err.message || err });
        });
    }

    private handleRoot = (req: Request, res: Response): void => {
        res.send('API de yt-dlp funcionando!');
    }

    private handleVideoInfo = async (req: Request, res: Response): Promise<void> => {
        if (!req.body?.url) {
            res.status(400).json({ error: 'La URL del video es requerida' });
            return;
        }
        const { url } = req.body;

        try {
            const { stdout, stderr } = await execPromise(`yt-dlp -j "${url}"`);

            if (stderr) {
                console.error(`Error de yt-dlp al obtener información: ${stderr}`);
                res.status(500).json({ error: 'No se pudo obtener la información del video.', details: stderr });
                return;
            }

            const videoInfo = JSON.parse(stdout);
            res.json(videoInfo);
            return;

        } catch (error: unknown) {
            let errorMessage = 'Error interno del servidor.';
            if (error instanceof Error) {
                errorMessage = error.message;
                console.error(`Error al ejecutar el comando yt-dlp para información: ${error.message}`);
            } else {
                console.error(`Error desconocido al ejecutar el comando yt-dlp: ${error}`);
            }
            res.status(500).json({ error: 'Error interno del servidor al obtener información.', details: errorMessage });
            return;
        }
    }

    private handleDownload = async (req: Request, res: Response): Promise<void> => {
        const { url, format } = req.body; // 'format' ahora es opcional en el cuerpo

        if (!url) {
            res.status(400).json({ error: 'La URL del video es requerida para la descarga.' });
            return;
        }

        let selectedFormatCode: string;
        let estimatedFileSize: number | undefined;

        try {
            // Paso 1: Obtener la información completa del video para seleccionar el formato
            const { stdout: infoStdout, stderr: infoStderr } = await execPromise(`yt-dlp -j "${url}"`);

            if (infoStderr) {
                console.error(`Error de yt-dlp al obtener info para selección de formato: ${infoStderr}`);
                res.status(500).json({ error: 'No se pudo obtener la información del video para selección de formato.', details: infoStderr });
                return;
            }

            const videoInfo = JSON.parse(infoStdout);
            const formats: any[] = videoInfo.formats || [];

            // Filtrar formatos que no sean de video o que no tengan un tamaño estimado
            const videoFormats = formats.filter(f =>
                f.vcodec !== 'none' && f.filesize !== undefined || f.filesize_approx !== undefined
            );

            // Ordenar por calidad (mejor a peor) y luego por tamaño (para romper empates en calidad)
            videoFormats.sort((a, b) => {
                const aQuality = a.preference || 0;
                const bQuality = b.preference || 0;
                const aSize = a.filesize || a.filesize_approx || 0;
                const bSize = b.filesize || b.filesize_approx || 0;

                // Prioriza mejor calidad (mayor preferencia)
                if (aQuality !== bQuality) {
                    return bQuality - aQuality;
                }
                // Si la calidad es la misma, prioriza el tamaño (de mayor a menor para buscar el más grande apto)
                return bSize - aSize;
            });

            // Seleccionar el formato más adecuado
            let foundSuitableFormat = false;
            for (const f of videoFormats) {
                const size = f.filesize || f.filesize_approx; // Preferir filesize exacto
                if (size && size <= this.maxDownloadSizeBytes) {
                    selectedFormatCode = f.format_id;
                    estimatedFileSize = size;
                    foundSuitableFormat = true;
                    console.log(`Seleccionado formato ${selectedFormatCode} (estimado ${Math.round(size / (1024 * 1024))}MB) para cumplir límite.`);
                    break; // Encontró el mejor formato que cumple con el tamaño
                }
            }

            if (!foundSuitableFormat) {
                // Si no se encontró un formato que cumpla con el límite,
                // revisamos si el formato más pequeño ya es demasiado grande.
                const smallestFormat = videoFormats[videoFormats.length - 1]; // El último después de ordenar
                if (smallestFormat && ((smallestFormat.filesize || smallestFormat.filesize_approx) > this.maxDownloadSizeBytes)) {
                    res.status(413).json({
                        error: `El video es demasiado grande. El formato más pequeño disponible (${Math.round((smallestFormat.filesize || smallestFormat.filesize_approx) / (1024 * 1024))}MB) excede el límite de ${this.maxDownloadSizeBytes / (1024 * 1024)}MB.`,
                    });
                    return;
                } else {
                    // Esto puede pasar si no se encontró ningún formato de video con tamaño estimado,
                    // o si la lógica de filtrado es muy restrictiva.
                    res.status(500).json({ error: 'No se encontró un formato de video adecuado para descargar dentro del límite de tamaño.' });
                    return;
                }
            }

        } catch (error: unknown) {
            let errorMessage = 'Error interno al seleccionar el formato del video.';
            if (error instanceof Error) {
                errorMessage = error.message;
                console.error(`Error al obtener info o seleccionar formato: ${error.message}`);
            } else {
                console.error(`Error desconocido al seleccionar formato: ${error}`);
            }
            res.status(500).json({ error: errorMessage });
            return;
        }

        // --- Paso 2: Iniciar la descarga con el formato seleccionado ---
        const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        const outputFileName = `${sanitizedUrl}_${timestamp}.mp4`;
        const outputPath = path.join(this.downloadDir, outputFileName);

        const ytDlpArgs = [
            '-f', selectedFormatCode!, // Usar el formato seleccionado
            '-o', outputPath,
            url
        ];

        const ytDlpProcess = spawn('yt-dlp', ytDlpArgs);

        let stderrOutput = '';

        ytDlpProcess.stdout.on('data', (data) => {
            // console.log(`yt-dlp stdout: ${data.toString()}`);
        });

        ytDlpProcess.stderr.on('data', (data) => {
            stderrOutput += data.toString();
            console.error(`yt-dlp stderr: ${data.toString()}`);
        });

        const downloadTimeout = setTimeout(() => {
            ytDlpProcess.kill('SIGKILL');
            if (!res.headersSent) {
                console.error(`Descarga de ${url} excedió el tiempo límite y fue terminada.`);
                res.status(504).json({
                    error: 'La descarga del video excedió el tiempo límite.',
                    details: 'La operación de yt-dlp tardó demasiado y fue cancelada.'
                });
            }
        }, this.timeout); // Usamos el timeout configurado en la clase

        ytDlpProcess.on('close', (code) => {
            clearTimeout(downloadTimeout);
            if (!res.headersSent) {
                if (code === 0) {
                    console.log(`Descarga completada para ${url}. Guardado en: ${outputPath}`);
                    res.status(200).json({
                        message: 'Descarga iniciada y completada con éxito.',
                        filePath: outputPath,
                        downloadUrl: `/downloads/${outputFileName}`,
                        estimatedSizeMB: estimatedFileSize ? Math.round(estimatedFileSize / (1024 * 1024)) : 'N/A',
                        formatUsed: selectedFormatCode
                    });
                } else {
                    console.error(`yt-dlp salió con código de error ${code} para ${url}.`);
                    res.status(500).json({
                        error: 'Error al descargar el video.',
                        details: stderrOutput || `yt-dlp exited with code ${code}.`
                    });
                }
            }
        });

        ytDlpProcess.on('error', (err) => {
            clearTimeout(downloadTimeout);
            if (!res.headersSent) {
                console.error('Error al ejecutar yt-dlp:', err);
                res.status(500).json({
                    error: 'Error al ejecutar yt-dlp. Asegúrate de que esté instalado y en tu PATH.',
                    details: err.message
                });
            }
        });
    }

    private cleanUpOldFiles(): void {
        console.log(`[${new Date().toLocaleString()}] Iniciando limpieza de archivos antiguos en: ${this.downloadDir}`);
        const now = Date.now();

        fs.readdir(this.downloadDir, (err, files) => {
            if (err) {
                console.error('Error al leer el directorio de descargas para limpieza:', err);
                return;
            }

            files.forEach(file => {
                const filePath = path.join(this.downloadDir, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        console.error(`Error al obtener estadísticas del archivo ${filePath}:`, err);
                        return;
                    }

                    const fileAge = now - stats.birthtimeMs;

                    if (fileAge > this.fileRetentionTimeMs) {
                        fs.unlink(filePath, unlinkErr => {
                            if (unlinkErr) {
                                console.error(`Error al eliminar el archivo antiguo ${filePath}:`, unlinkErr);
                            } else {
                                console.log(`Archivo antiguo eliminado: ${filePath} (Edad: ${(fileAge / 1000 / 60).toFixed(2)} minutos)`);
                            }
                        });
                    }
                });
            });
            console.log(`[${new Date().toLocaleString()}] Limpieza de archivos finalizada.`);
        });
    }

    public start(): void {
        this.server = this.app.listen(this.port, () => {
            console.log(`Servidor corriendo en http://localhost:${this.port}`);
            console.log(`Tiempo de retención de archivos: ${this.fileRetentionTimeMs / 1000 / 60} minutos.`);
            console.log(`Intervalo de limpieza: ${this.cleanUpIntervalMs / 1000 / 60} minutos.`);
            console.log(`Límite de tamaño de descarga: ${this.maxDownloadSizeBytes / (1024 * 1024)} MB.`);
        });

        this.server.timeout = this.timeout;
        console.log(`Timeout global del servidor configurado a ${this.timeout / 1000} segundos.`);

        this.server.on('request', (req: Request, res: Response) => {
            res.setTimeout(this.timeout, () => {
                if (!res.headersSent) {
                    console.warn(`Timeout de respuesta para la ruta: ${req.url}`);
                    res.status(503).json({ error: 'La solicitud ha excedido el tiempo de espera.' });
                }
            });
        });

        this.cleanUpTimer = setInterval(() => this.cleanUpOldFiles(), this.cleanUpIntervalMs);
    }

    public close(): void {
        if (this.server) {
            this.server.close(() => {
                console.log('Servidor Express cerrado.');
            });
        }
        if (this.cleanUpTimer) {
            clearInterval(this.cleanUpTimer);
            console.log('Temporizador de limpieza de archivos detenido.');
        }
    }
}

// ---

// Uso de la clase:
const api = new YoutubeDLPApi({
    port: 3005,
    timeout: 15 * 1000, // Timeout de respuesta de 15 segundos
    fileRetentionTimeSeconds: 3600, // 1 hora
    cleanUpIntervalSeconds: 600, // Cada 10 minutos
    maxDownloadSizeMB: 100 // Límite de descarga de 100 MB
});
api.start();
