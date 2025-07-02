# 🎥 Video Download API with yt-dlp and FFmpeg

This is a robust Node.js/Express API that allows you to fetch information and download videos from various platforms (primarily YouTube) using `yt-dlp` and `FFmpeg`. The API is designed to manage file size, prioritize quality, ensure audio inclusion, and clean up temporary files.

-----

## 🌟 Key Features

  * **Video Information Retrieval**: Get comprehensive details for any compatible video.
  * **Intelligent Video Download**:
      * Prioritizes the **best available quality**.
      * **Configurable Size Limit**: Downloads videos up to a maximum size (default 100 MB), degrading quality if necessary to meet the limit.
      * **Audio Included**: If the best quality format comes without audio, the API will download video and audio tracks separately and automatically use `FFmpeg` to combine them.
      * Supports **MP4 and WebM** formats.
  * **Temporary File Management**: Downloaded videos are automatically deleted after a configurable period (default 1 hour).
  * **Robust Timeouts**: Handles timeouts to prevent requests from hanging.

-----

## 🚀 Getting Started

Follow these steps to set up and run the API in your local environment.

### 📋 Prerequisites

You need to have the following software installed on your system and accessible via your system's `PATH`:

  * **Node.js** (version 18 or higher recommended)
  * **npm** (comes with Node.js)
  * **yt-dlp**: A command-line program to download videos.
      * [yt-dlp Installation Guide](https://www.google.com/search?q=https://github.com/yt-dlp/yt-dlp%23installation)
  * **FFmpeg**: A complete, cross-platform solution to record, convert and stream audio and video. Required for combining video and audio tracks.
      * [FFmpeg Download & Installation Guide](https://ffmpeg.org/download.html)

### ⚙️ Installation

1.  **Clone this repository** (or copy the API files to your machine):
    ```bash
    git clone <REPOSITORY_URL>
    cd <your_project_name>
    ```
2.  **Install Node.js dependencies**:
    ```bash
    npm install
    ```
    If you use `yarn`:
    ```bash
    yarn install
    ```

-----

## ▶️ Running the API

To start the API server:

```bash
npm start
```

Or, for development with hot reloading (if you use `ts-node-dev` or similar):

```bash
npm run dev
```

The API will start by default on `http://localhost:3005`.

-----

## 🌐 API Endpoints

The API exposes the following endpoints:

### `GET /`

  * **Description**: Checks if the API is running.
  * **Success Response**:
    ```
    yt-dlp API is running!
    ```

### `POST /api/video-info`

  * **Description**: Retrieves detailed information about a video.
  * **Request Body (JSON)**:
    ```json
    {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    }
    ```
  * **Success Response (JSON)**:
    ```json
    {
        "id": "dQw4w9WgXcQ",
        "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
        "duration": 212,
        "uploader": "Rick Astley",
        "formats": [
            { /* ... format details ... */ },
            { /* ... more formats ... */ }
        ],
        "...": "..."
    }
    ```
  * **Possible Errors**: `400 Bad Request` (missing URL), `500 Internal Server Error` (`yt-dlp` or server error).

### `POST /api/download`

  * **Description**: Initiates the download of a video with audio, respecting the size limit and desired format (MP4/WebM).
  * **Request Body (JSON)**:
    ```json
    {
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        // "format": "best" // Optional; the API automatically selects to meet limits.
    }
    ```
  * **Success Response (JSON)**:
    ```json
    {
        "message": "Download initiated and completed successfully.",
        "filePath": "/server/path/to/downloads/video_id_1678888888888.mp4",
        "downloadUrl": "/downloads/video_id_1678888888888.mp4",
        "estimatedSizeMB": 15,
        "formatUsed": "bestvideo+bestaudio",
        "muxedByFFmpeg": true
    }
    ```
    The `downloadUrl` is relative to the API root and can be used by a client to directly download the file.
  * **Possible Errors**:
      * `400 Bad Request` (missing URL).
      * `413 Payload Too Large` (the video, even in its smallest or combined format, exceeds `maxDownloadSizeMB`).
      * `500 Internal Server Error` (`yt-dlp` errors, `FFmpeg` not found, or internal issues).
      * `503 Service Unavailable` / `504 Gateway Timeout` (the request exceeded the server's timeout or the `yt-dlp` download took too long).

-----

## 🛠️ Configuration

You can configure the API by passing a configuration object to the `YoutubeDLPApi` class constructor in `index.ts` (or your main file).

```typescript
const api = new YoutubeDLPApi({
    port: 3005,                     // Port where the API will listen (default: 3005)
    timeout: 15 * 1000,             // Response timeout for all requests in ms (default: 15000 ms = 15s)
    downloadDir: path.join(__dirname, '..', 'downloads'), // Download directory (default: `../downloads`)
    fileRetentionTimeSeconds: 3600, // Time a file is kept before being deleted in seconds (default: 3600s = 1 hour)
    cleanUpIntervalSeconds: 600,    // Frequency at which the cleanup task runs in seconds (default: 600s = 10 minutes)
    maxDownloadSizeMB: 100          // Maximum size of videos to download in MB (default: 100 MB)
});
api.start();
```

-----

## 🧹 Automatic File Cleanup

The API includes a cleanup process that runs periodically (every `cleanUpIntervalSeconds`) and deletes downloaded files from the `downloads` directory that are older than `fileRetentionTimeSeconds`. This helps manage disk space.

-----

## 🤝 Contributions

Contributions are welcome\! If you have ideas for improvements, bug reports, or want to add new features, feel free to open an issue or submit a pull request.

-----

## 📄 License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT).

-----
