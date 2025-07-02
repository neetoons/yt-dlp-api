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
    timeout?: number;
    fileRetentionTimeSeconds?: number;
    cleanUpIntervalSeconds?: number;
    maxDownloadSizeMB?: number;
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
    private maxDownloadSizeBytes: number;

    constructor(config?: ApiConfig) {
        this.app = express();
        this.port = config?.port || 3005;
        this.downloadDir = config?.downloadDir || path.join(__dirname, '..', 'downloads');
        this.timeout = config?.timeout || 15 * 1000; // 15 segundos
        this.fileRetentionTimeMs = (config?.fileRetentionTimeSeconds || 3600) * 1000;
        this.cleanUpIntervalMs = (config?.cleanUpIntervalSeconds || 600) * 1000;
        this.maxDownloadSizeBytes = (config?.maxDownloadSizeMB || 100) * 1024 * 1024; // 100 MB por defecto

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

        this.app.use((err: any, req: Request, res: Response, next: Function) => {
            if (res.headersSent) {
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
        const { url } = req.body;

        if (!url) {
            res.status(400).json({ error: 'La URL del video es requerida para la descarga.' });
            return;
        }

        let selectedFormatCode: string | null = null;
        let estimatedFileSize: number | undefined;
        let requiresMuxing = false; // Bandera para saber si necesitamos FFmpeg

        try {
            const { stdout: infoStdout, stderr: infoStderr } = await execPromise(`yt-dlp -j "${url}"`);

            if (infoStderr) {
                console.error(`Error de yt-dlp al obtener info para selección de formato: ${infoStderr}`);
                res.status(500).json({ error: 'No se pudo obtener la información del video para selección de formato.', details: infoStderr });
                return;
            }

            const videoInfo = JSON.parse(infoStdout);
            const formats: any[] = videoInfo.formats || [];

            const allowedExtensions = ['mp4', 'webm'];

            // 1. Intentar encontrar un formato combinado (video + audio) que cumpla los requisitos
            const combinedFormats = formats.filter(f =>
                f.vcodec !== 'none' && f.acodec !== 'none' && // Tiene video y audio
                (f.filesize !== undefined || f.filesize_approx !== undefined) &&
                allowedExtensions.includes(f.ext)
            ).sort((a, b) => {
                // Ordenar por calidad (mayor preferencia)
                const aQuality = a.preference || 0;
                const bQuality = b.preference || 0;
                if (aQuality !== bQuality) return bQuality - aQuality;
                // Luego por tamaño (mayor a menor) para elegir el mejor dentro del límite
                return (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0);
            });

            for (const f of combinedFormats) {
                const size = f.filesize || f.filesize_approx;
                if (size && size <= this.maxDownloadSizeBytes) {
                    selectedFormatCode = f.format_id;
                    estimatedFileSize = size;
                    requiresMuxing = false;
                    console.log(`Seleccionado formato combinado ${selectedFormatCode} (${f.ext}, estimado ${Math.round(size / (1024 * 1024))}MB) que cumple el límite.`);
                    break;
                }
            }

            // 2. Si no se encontró un formato combinado, intentar descargar video y audio por separado para muxing
            if (!selectedFormatCode) {
                console.log('No se encontró un formato combinado adecuado. Intentando descargar video y audio por separado para combinar.');

                // Filtrar solo formatos de video (no 'none' en vcodec) y solo de audio (no 'none' en acodec)
                const videoOnlyFormats = formats.filter(f =>
                    f.vcodec !== 'none' && f.acodec === 'none' &&
                    (f.filesize !== undefined || f.filesize_approx !== undefined) &&
                    allowedExtensions.includes(f.ext) // Asegurar que sea una extensión válida para FFmpeg
                ).sort((a, b) => {
                    const aQuality = a.preference || 0;
                    const bQuality = b.preference || 0;
                    return bQuality - aQuality; // Mejor calidad de video
                });

                const audioOnlyFormats = formats.filter(f =>
                    f.acodec !== 'none' && f.vcodec === 'none' &&
                    (f.filesize !== undefined || f.filesize_approx !== undefined) &&
                    allowedExtensions.includes(f.ext) // Generalmente audio será webm/m4a
                ).sort((a, b) => {
                    const aQuality = a.preference || 0;
                    const bQuality = b.preference || 0;
                    return bQuality - aQuality; // Mejor calidad de audio
                });

                const bestVideo = videoOnlyFormats[0];
                const bestAudio = audioOnlyFormats[0];

                if (bestVideo && bestAudio) {
                    // Estimamos el tamaño combinado. Esto es una estimación, no exacto.
                    const combinedSize = (bestVideo.filesize || bestVideo.filesize_approx || 0) +
                        (bestAudio.filesize || bestAudio.filesize_approx || 0);

                    if (combinedSize <= this.maxDownloadSizeBytes) {
                        selectedFormatCode = `${bestVideo.format_id}+${bestAudio.format_id}`;
                        estimatedFileSize = combinedSize;
                        requiresMuxing = true;
                        console.log(`Seleccionado video ${bestVideo.format_id} y audio ${bestAudio.format_id} (estimado total ${Math.round(combinedSize / (1024 * 1024))}MB) para combinar.`);
                    } else {
                        // Si incluso la mejor combinación excede el tamaño
                        res.status(413).json({
                            error: `El video es demasiado grande. La mejor combinación de video y audio (${Math.round(combinedSize / (1024 * 1024))}MB) excede el límite de ${this.maxDownloadSizeBytes / (1024 * 1024)}MB.`,
                        });
                        return;
                    }
                } else {
                    res.status(500).json({ error: 'No se encontraron formatos de video o audio válidos para combinar dentro del límite de tamaño y formatos MP4/WebM.' });
                    return;
                }
            }

            if (!selectedFormatCode) {
                // Esto ocurrirá si no se encontró ni un formato combinado ni una combinación para muxing.
                res.status(500).json({ error: 'No se pudo encontrar un formato de video adecuado para descargar dentro del límite de tamaño y formatos MP4/WebM.' });
                return;
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

        // --- Inicio de la Descarga y/o Muxing ---
        const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        // El nombre de archivo de salida ahora debe ser MP4 para el muxing por defecto.
        // Si quieres WebM, podrías necesitar una lógica más compleja o que el cliente lo pida.
        const outputFileName = `${sanitizedUrl}_${timestamp}.mp4`;
        const outputPath = path.join(this.downloadDir, outputFileName);

        const ytDlpArgs = [
            '-f', selectedFormatCode,
            '-o', outputPath,
            url
        ];

        // Si necesitamos muxing, yt-dlp automáticamente usará ffmpeg si está en el PATH
        // y se le pide un formato combinado (ej. 'bestvideo+bestaudio').
        // No necesitamos invocar ffmpeg directamente aquí, yt-dlp lo hace por nosotros.
        // Solo debemos asegurarnos de que yt-dlp tenga ffmpeg disponible.

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
        }, this.timeout);

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
                        formatUsed: selectedFormatCode,
                        muxedByFFmpeg: requiresMuxing // Indicador si se usó FFmpeg para combinar
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
                // Si el error es específicamente de ffmpeg (ej. no encontrado), podemos dar un mensaje más útil
                if (err.message.includes('ffmpeg') && err.message.includes('not found')) {
                    res.status(500).json({
                        error: 'Error: FFmpeg no encontrado. Asegúrate de que FFmpeg esté instalado y en tu PATH para descargar videos con audio.',
                        details: err.message
                    });
                } else {
                    res.status(500).json({
                        error: 'Error al ejecutar yt-dlp. Asegúrate de que esté instalado y en tu PATH.',
                        details: err.message
                    });
                }
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
    timeout: 15 * 1000,
    fileRetentionTimeSeconds: 3600,
    cleanUpIntervalSeconds: 600,
    maxDownloadSizeMB: 100
});
api.start();