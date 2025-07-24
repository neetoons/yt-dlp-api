import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import http from 'http';
import os from 'os'; // <--- NUEVO: Importado para detectar el S.O.

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
        this.downloadDir = config?.downloadDir || this.getDefaultDownloadPath();
        this.timeout = config?.timeout || 15 * 1000; // 15 seconds
        this.fileRetentionTimeMs = (config?.fileRetentionTimeSeconds || 3600) * 1000;
        this.cleanUpIntervalMs = (config?.cleanUpIntervalSeconds || 600) * 1000;
        this.maxDownloadSizeBytes = (config?.maxDownloadSizeMB || 100) * 1024 * 1024;

        this.configureMiddleware();
        this.setupRoutes();
        this.ensureDownloadDirectoryExists();
    }

    private getDefaultDownloadPath(): string {
        const platform = os.platform();
        console.log(`Detected platform: ${platform}`);

        switch (platform) {
            case 'win32': // Windows
                // Usa la carpeta AppData/Local, que es el lugar estándar para caché.
                const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
                return path.join(localAppData, 'yt-dlp-api-cache');

            case 'linux': // Linux
                // Ruta especificada para sistemas Linux. Requiere permisos.
                return '/var/lib/yt-dlp-api';

            default: // macOS y otros
                // Usa una carpeta oculta en el directorio de inicio del usuario.
                return path.join(os.homedir(), '.yt-dlp-api-cache');
        }
    }

    private configureMiddleware(): void {
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use('/downloads', express.static(this.downloadDir));
    }

    private ensureDownloadDirectoryExists(): void {
        try {
            if (!fs.existsSync(this.downloadDir)) {
                fs.mkdirSync(this.downloadDir, { recursive: true });
                console.log(`Download directory created: ${this.downloadDir}`);
            }
        } catch (error: any) {
            console.error(`FATAL: Could not create download directory at ${this.downloadDir}.`);
            console.error(`Please check permissions. On Linux, you may need to run 'sudo mkdir -p ${this.downloadDir}' and 'sudo chown -R $USER:$USER ${this.downloadDir}'.`);
            console.error('Error details:', error.message);
            process.exit(1); // Sale de la aplicación si no se puede crear la carpeta
        }
    }

    private setupRoutes(): void {
        this.app.get('/', this.handleRoot);
        this.app.post('/api/video-info', this.handleVideoInfo);
        this.app.post('/api/download', this.handleDownload);

        // Generic error handling middleware
        this.app.use((err: any, req: Request, res: Response, next: Function) => {
            if (res.headersSent) {
                return next(err);
            }
            if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
                console.error(`Request timeout for ${req.path}`);
                return res.status(503).json({ error: 'The request has exceeded the time limit.' });
            }
            console.error('Unhandled error:', err);
            res.status(500).json({ error: 'Internal server error.', details: err.message || err });
        });
    }

    private handleRoot = (req: Request, res: Response): void => {
        res.send('yt-dlp API is running!');
    }

    private handleVideoInfo = async (req: Request, res: Response): Promise<void> => {
        if (!req.body?.url) {
            res.status(400).json({ error: 'Video URL is required' });
            return;
        }
        const { url } = req.body;

        try {
            const { stdout, stderr } = await execPromise(`yt-dlp -j "${url}"`);

            if (stderr) {
                console.error(`yt-dlp error getting info: ${stderr}`);
                res.status(500).json({ error: 'Could not retrieve video information.', details: stderr });
                return;
            }

            const videoInfo = JSON.parse(stdout);
            res.json(videoInfo);
            return;

        } catch (error: unknown) {
            let errorMessage = 'Internal server error.';
            if (error instanceof Error) {
                errorMessage = error.message;
                console.error(`Error executing yt-dlp command for info: ${error.message}`);
            } else {
                console.error(`Unknown error executing yt-dlp command: ${error}`);
            }
            res.status(500).json({ error: 'Internal server error when getting info.', details: errorMessage });
            return;
        }
    }

    private handleDownload = async (req: Request, res: Response): Promise<void> => {
        const { url } = req.body;

        if (!url) {
            res.status(400).json({ error: 'Video URL is required for download.' });
            return;
        }

        let selectedFormatCode: string | null = null;
        let estimatedFileSize: number | undefined;
        let requiresMuxing = false; // Flag to indicate if FFmpeg muxing is needed

        try {
            const { stdout: infoStdout, stderr: infoStderr } = await execPromise(`yt-dlp -j "${url}"`);

            if (infoStderr) {
                console.error(`yt-dlp error getting info for format selection: ${infoStderr}`);
                res.status(500).json({ error: 'Could not retrieve video information for format selection.', details: infoStderr });
                return;
            }

            const videoInfo = JSON.parse(infoStdout);
            const formats: any[] = videoInfo.formats || [];

            const allowedExtensions = ['mp4', 'webm'];

            // 1. Try to find a combined format (video + audio) that meets the requirements
            const combinedFormats = formats.filter(f =>
                f.vcodec !== 'none' && f.acodec !== 'none' && // Has both video and audio
                (f.filesize !== undefined || f.filesize_approx !== undefined) && // Has estimated size
                allowedExtensions.includes(f.ext) // Is an allowed extension
            ).sort((a, b) => {
                // Sort by quality (higher preference first)
                const aQuality = a.preference || 0;
                const bQuality = b.preference || 0;
                if (aQuality !== bQuality) return bQuality - aQuality;
                // Then by size (larger to smaller) to pick the best within the limit
                return (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0);
            });

            for (const f of combinedFormats) {
                const size = f.filesize || f.filesize_approx;
                if (size && size <= this.maxDownloadSizeBytes) {
                    selectedFormatCode = f.format_id;
                    estimatedFileSize = size;
                    requiresMuxing = false;
                    console.log(`Selected combined format ${selectedFormatCode} (${f.ext}, estimated ${Math.round(size / (1024 * 1024))}MB) that meets the limit.`);
                    break;
                }
            }

            // 2. If no suitable combined format was found, try to download video and audio separately for muxing
            if (!selectedFormatCode) {
                console.log('No suitable combined format found. Attempting to download video and audio separately for merging.');

                // Filter for video-only formats (vcodec not 'none', acodec is 'none')
                const videoOnlyFormats = formats.filter(f =>
                    f.vcodec !== 'none' && f.acodec === 'none' &&
                    (f.filesize !== undefined || f.filesize_approx !== undefined) &&
                    allowedExtensions.includes(f.ext) // Ensure it's a valid extension for FFmpeg
                ).sort((a, b) => {
                    const aQuality = a.preference || 0;
                    const bQuality = b.preference || 0;
                    return bQuality - aQuality; // Better video quality first
                });

                // Filter for audio-only formats (acodec not 'none', vcodec is 'none')
                const audioOnlyFormats = formats.filter(f =>
                    f.acodec !== 'none' && f.vcodec === 'none' &&
                    (f.filesize !== undefined || f.filesize_approx !== undefined) &&
                    allowedExtensions.includes(f.ext) // Typically audio will be webm/m4a
                ).sort((a, b) => {
                    const aQuality = a.preference || 0;
                    const bQuality = b.preference || 0;
                    return bQuality - aQuality; // Better audio quality first
                });

                const bestVideo = videoOnlyFormats[0];
                const bestAudio = audioOnlyFormats[0];

                if (bestVideo && bestAudio) {
                    // Estimate the combined size. This is an approximation, not exact.
                    const combinedSize = (bestVideo.filesize || bestVideo.filesize_approx || 0) +
                        (bestAudio.filesize || bestAudio.filesize_approx || 0);

                    if (combinedSize <= this.maxDownloadSizeBytes) {
                        selectedFormatCode = `${bestVideo.format_id}+${bestAudio.format_id}`;
                        estimatedFileSize = combinedSize;
                        requiresMuxing = true;
                        console.log(`Selected video ${bestVideo.format_id} and audio ${bestAudio.format_id} (estimated total ${Math.round(combinedSize / (1024 * 1024))}MB) for merging.`);
                    } else {
                        // If even the best combination exceeds the size limit
                        res.status(413).json({
                            error: `The video is too large. The best video and audio combination (${Math.round(combinedSize / (1024 * 1024))}MB) exceeds the limit of ${this.maxDownloadSizeBytes / (1024 * 1024)}MB.`,
                        });
                        return;
                    }
                } else {
                    res.status(500).json({ error: 'No valid video or audio formats found for merging within the size limit and MP4/WebM formats.' });
                    return;
                }
            }

            if (!selectedFormatCode) {
                // This will happen if neither a combined format nor a muxing combination was found.
                res.status(500).json({ error: 'Could not find a suitable video format to download within the size limit and MP4/WebM formats.' });
                return;
            }

        } catch (error: unknown) {
            let errorMessage = 'Internal error when selecting video format.';
            if (error instanceof Error) {
                errorMessage = error.message;
                console.error(`Error getting info or selecting format: ${error.message}`);
            } else {
                console.error(`Unknown error when selecting format: ${error}`);
            }
            res.status(500).json({ error: errorMessage });
            return;
        }

        // --- Start Download and/or Muxing ---
        const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = Date.now();
        const outputFileName = `${sanitizedUrl}_${timestamp}.mp4`;
        const outputPath = path.join(this.downloadDir, outputFileName);

        const ytDlpArgs = [
            '-f', selectedFormatCode,
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
                console.error(`Download of ${url} exceeded time limit and was terminated.`);
                res.status(504).json({
                    error: 'Video download exceeded time limit.',
                    details: 'The yt-dlp operation took too long and was canceled.'
                });
            }
        }, this.timeout);

        ytDlpProcess.on('close', (code) => {
            clearTimeout(downloadTimeout);
            if (!res.headersSent) {
                if (code === 0) {
                    console.log(`Download completed for ${url}. Saved to: ${outputPath}`);
                    res.status(200).json({
                        message: 'Download initiated and completed successfully.',
                        filePath: outputPath,
                        downloadUrl: `/downloads/${outputFileName}`,
                        estimatedSizeMB: estimatedFileSize ? Math.round(estimatedFileSize / (1024 * 1024)) : 'N/A',
                        formatUsed: selectedFormatCode,
                        muxedByFFmpeg: requiresMuxing // Indicator if FFmpeg was used for merging
                    });
                } else {
                    console.error(`yt-dlp exited with error code ${code} for ${url}.`);
                    res.status(500).json({
                        error: 'Error downloading video.',
                        details: stderrOutput || `yt-dlp exited with code ${code}.`
                    });
                }
            }
        });

        ytDlpProcess.on('error', (err) => {
            clearTimeout(downloadTimeout);
            if (!res.headersSent) {
                console.error('Error executing yt-dlp:', err);
                if (err.message.includes('ffmpeg') && err.message.includes('not found')) {
                    res.status(500).json({
                        error: 'Error: FFmpeg not found. Ensure FFmpeg is installed and in your PATH to download videos with audio.',
                        details: err.message
                    });
                } else {
                    res.status(500).json({
                        error: 'Error executing yt-dlp. Ensure it is installed and in your PATH.',
                        details: err.message
                    });
                }
            }
        });
    }

    private cleanUpOldFiles(): void {
        console.log(`[${new Date().toLocaleString()}] Starting cleanup of old files in: ${this.downloadDir}`);
        const now = Date.now();

        fs.readdir(this.downloadDir, (err, files) => {
            if (err) {
                console.error('Error reading download directory for cleanup:', err);
                return;
            }

            files.forEach(file => {
                const filePath = path.join(this.downloadDir, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) {
                        console.error(`Error getting file stats for ${filePath}:`, err);
                        return;
                    }

                    const fileAge = now - stats.birthtimeMs;

                    if (fileAge > this.fileRetentionTimeMs) {
                        fs.unlink(filePath, unlinkErr => {
                            if (unlinkErr) {
                                console.error(`Error deleting old file ${filePath}:`, unlinkErr);
                            } else {
                                console.log(`Old file deleted: ${filePath} (Age: ${(fileAge / 1000 / 60).toFixed(2)} minutes)`);
                            }
                        });
                    }
                });
            });
            console.log(`[${new Date().toLocaleString()}] File cleanup finished.`);
        });
    }

    public start(): void {
        this.server = this.app.listen(this.port, () => {
            console.log(`Server running on http://localhost:${this.port}`);
            console.log(`File retention time: ${this.fileRetentionTimeMs / 1000 / 60} minutes.`);
            console.log(`Cleanup interval: ${this.cleanUpIntervalMs / 1000 / 60} minutes.`);
            console.log(`Download size limit: ${this.maxDownloadSizeBytes / (1024 * 1024)} MB.`);
            console.log(`Downloads will be saved to: ${this.downloadDir}`);
        });

        this.server.timeout = this.timeout;
        console.log(`Global server timeout set to ${this.timeout / 1000} seconds.`);

        this.server.on('request', (req: Request, res: Response) => {
            res.setTimeout(this.timeout, () => {
                if (!res.headersSent) {
                    console.warn(`Response timeout for route: ${req.url}`);
                    res.status(503).json({ error: 'The request has exceeded the time limit.' });
                }
            });
        });

        this.cleanUpTimer = setInterval(() => this.cleanUpOldFiles(), this.cleanUpIntervalMs);
    }

    public close(): void {
        if (this.server) {
            this.server.close(() => {
                console.log('Express server closed.');
            });
        }
        if (this.cleanUpTimer) {
            clearInterval(this.cleanUpTimer);
            console.log('File cleanup timer stopped.');
        }
    }

}

// Class Usage:
const api = new YoutubeDLPApi({
    port: 3005,
    timeout: 30 * 1000,
    fileRetentionTimeSeconds: 3600,
    cleanUpIntervalSeconds: 600,
    maxDownloadSizeMB: 100
});
api.start();
