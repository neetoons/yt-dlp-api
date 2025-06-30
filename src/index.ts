import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

const execPromise = promisify(exec);

// ---

interface ApiConfig {
    port?: number;
    downloadDir?: string;
}

class YoutubeDLPApi {
    private app: Application;
    private port: number;
    private downloadDir: string;

    constructor(config?: ApiConfig) {
        this.app = express();
        this.port = config?.port || 3005;
        this.downloadDir = config?.downloadDir || path.join(__dirname, '..', 'downloads');

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

    private handleDownload = (req: Request, res: Response): void => {
        const { url, format = 'best' } = req.body;

        if (!url) {
            res.status(400).json({ error: 'La URL del video es requerida para la descarga.' });
            return;
        }

        const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        const outputFileName = `${sanitizedUrl}_${timestamp}.mp4`;
        const outputPath = path.join(this.downloadDir, outputFileName); // Usar this.downloadDir

        const ytDlpArgs = [
            '-f', format,
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

        ytDlpProcess.on('close', (code) => {
            if (code === 0) {
                console.log(`Descarga completada para ${url}. Guardado en: ${outputPath}`);
                res.status(200).json({
                    message: 'Descarga iniciada y completada con éxito.',
                    filePath: outputPath,
                    downloadUrl: `/downloads/${outputFileName}`
                });
            } else {
                console.error(`yt-dlp salió con código de error ${code} para ${url}.`);
                res.status(500).json({
                    error: 'Error al descargar el video.',
                    details: stderrOutput || `yt-dlp exited with code ${code}.`
                });
            }
        });

        ytDlpProcess.on('error', (err) => {
            console.error('Error al ejecutar yt-dlp:', err);
            res.status(500).json({
                error: 'Error al ejecutar yt-dlp. Asegúrate de que esté instalado y en tu PATH.',
                details: err.message
            });
        });
    }

    public start(): void {
        this.app.listen(this.port, () => {
            console.log(`Servidor corriendo en http://localhost:${this.port}`);
        });
    }
}

// ---

// Uso de la clase:
const api = new YoutubeDLPApi({ port: 3005, downloadDir: path.join(__dirname, '..', 'downloads') });
api.start();