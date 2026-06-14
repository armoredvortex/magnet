import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());

const clients = new Set();
const torrentProcesses = new Map(); // id -> ChildProcess
const torrents = [];

function buildSummary() {
	const active = torrents.filter((torrent) => torrent.status === 'downloading').length;
	const completed = torrents.filter((torrent) => torrent.status === 'seeding').length;
	const paused = torrents.filter((torrent) => torrent.status === 'paused').length;
	const totalProgress = torrents.length
		? Math.round(torrents.reduce((sum, torrent) => sum + torrent.progress, 0) / torrents.length)
		: 0;

	return {
		active,
		completed,
		paused,
		total: torrents.length,
		totalProgress,
		downloadSpeed: Number(torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0).toFixed(1)),
		uploadSpeed: Number(torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0).toFixed(1)),
	};
}

function snapshot() {
	return {
		summary: buildSummary(),
		torrents: torrents.map((torrent) => ({ ...torrent, logs: [...torrent.logs] })),
	};
}

function broadcast() {
	const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;

	for (const client of clients) {
		client.write(payload);
	}
}

function appendLog(torrent, message) {
	torrent.logs = [message, ...torrent.logs].slice(0, 6);
}

app.get('/api/health', (_req, res) => {
	res.json({ ok: true, service: 'magnet-manager-api', timestamp: new Date().toISOString() });
});

app.get('/api/torrents', (_req, res) => {
	res.json(snapshot());
});

app.get('/api/torrents/:id', (req, res) => {
	const torrent = torrents.find((item) => item.id === req.params.id);

	if (!torrent) {
		res.status(404).json({ message: 'Torrent not found' });
		return;
	}

	res.json(torrent);
});

app.post('/api/torrents', (req, res) => {
	let source = String(req.body?.source || '').trim();
	const nameInput = String(req.body?.name || '').trim();
	const fileData = req.body?.file;
	const fileName = req.body?.fileName;

	if (fileData && fileName) {
		const uploadsDir = path.resolve(__dirname, 'uploads');
		if (!existsSync(uploadsDir)) {
			mkdirSync(uploadsDir, { recursive: true });
		}
		const filePath = path.join(uploadsDir, `${Date.now()}-${fileName}`);
		try {
			const buffer = Buffer.from(fileData, 'base64');
			writeFileSync(filePath, buffer);
			source = filePath;
		} catch (writeErr) {
			res.status(500).json({ message: 'Failed to write torrent file to disk', error: writeErr.message });
			return;
		}
	}

	if (!source) {
		res.status(400).json({ message: 'source is required' });
		return;
	}

	const derivedName = nameInput || path.basename(source) || 'New torrent';
	const torrent = {
		id: randomUUID(),
		name: derivedName,
		source,
		status: 'downloading',
		progress: 0,
		peers: 0,
		downloadSpeed: 0,
		uploadSpeed: 0,
		ratio: 0,
		tracker: 'custom-source',
		eta: 'estimating',
		health: 'queued',
		logs: ['Added from web dashboard', 'Starting magnet++ engine...'],
		createdAt: new Date().toISOString(),
		priority: 'normal',
		_lastDownloadedBytes: 0,
		_lastUpdateTime: Date.now()
	};

	torrents.unshift(torrent);
	
	// Spawn magnet++
	const magnetPath = path.resolve(__dirname, '../../build/magnet++');
	const child = spawn(magnetPath, [source]);
	torrentProcesses.set(torrent.id, child);

	child.stdout.on('data', (data) => {
		const output = data.toString();
		
		// Parse peer count first
		if (output.includes('active peer(s)')) {
			const peerMatch = output.match(/(\d+)\s+active peer/);
			if (peerMatch) torrent.peers = parseInt(peerMatch[1], 10);
		}

		// magnet++ output: \r[###-------] 30% (3000/10000 bytes)
		const match = output.match(/\]\s+(\d+)%\s+\((\d+)\/(\d+)\s+bytes\)/);
		if (match) {
			const percent = parseInt(match[1], 10);
			const downloadedBytes = parseInt(match[2], 10);
			const totalBytes = parseInt(match[3], 10);

			torrent.progress = percent;
			
			const now = Date.now();
			const timeDiff = (now - torrent._lastUpdateTime) / 1000; // seconds
			if (timeDiff >= 1) { // Calculate speed every second
				const byteDiff = downloadedBytes - torrent._lastDownloadedBytes;
				torrent.downloadSpeed = Number((byteDiff / 1024 / 1024 / timeDiff).toFixed(2)); // MB/s
				torrent._lastDownloadedBytes = downloadedBytes;
				torrent._lastUpdateTime = now;
				
				if (torrent.downloadSpeed > 0) {
					const bytesRemaining = totalBytes - downloadedBytes;
					const secondsRemaining = Math.max(0, bytesRemaining / (torrent.downloadSpeed * 1024 * 1024));
					if (secondsRemaining > 3600) {
						torrent.eta = `${Math.round(secondsRemaining / 3600)}h`;
					} else if (secondsRemaining > 60) {
						torrent.eta = `${Math.round(secondsRemaining / 60)}m`;
					} else {
						torrent.eta = `${Math.round(secondsRemaining)}s`;
					}
				}
			}

			if (percent === 100 && torrent.status !== 'seeding') {
				torrent.status = 'seeding';
				torrent.downloadSpeed = 0;
				torrent.eta = 'done';
				torrent.health = 'complete';
				appendLog(torrent, 'Download completed');
			}
			broadcast();
		} else {
			// Check for other logs
			const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('['));
			for (const line of lines) {
				// remove ANSI color codes
				const cleanLine = line.replace(/\x1B\[\d+m/g, '').replace(/\x1B\[0m/g, '');
				if (cleanLine) {
					appendLog(torrent, cleanLine);
				}
			}
			broadcast();
		}
	});

	child.stderr.on('data', (data) => {
		const errorLine = data.toString().trim();
		if (errorLine) {
			appendLog(torrent, `Error: ${errorLine}`);
			broadcast();
		}
	});

	child.on('close', (code, signal) => {
		torrentProcesses.delete(torrent.id);
		if (code === 0) {
			torrent.status = 'seeding';
			torrent.downloadSpeed = 0;
			torrent.eta = 'done';
			torrent.health = 'complete';
			appendLog(torrent, 'Process finished successfully');
		} else {
			torrent.status = 'paused';
			torrent.downloadSpeed = 0;
			appendLog(torrent, `Process exited with code ${code !== null ? code : signal}`);
		}
		broadcast();
	});

	broadcast();
	res.status(201).json(torrent);
});

app.post('/api/torrents/:id/pause', (req, res) => {
	const torrent = torrents.find((item) => item.id === req.params.id);

	if (!torrent) {
		res.status(404).json({ message: 'Torrent not found' });
		return;
	}

	torrent.status = 'paused';
	torrent.downloadSpeed = 0;
	torrent.uploadSpeed = 0;
	torrent.eta = 'paused';
	torrent.health = 'paused';
	appendLog(torrent, 'Paused from dashboard');
	
	const child = torrentProcesses.get(torrent.id);
	if (child) {
		child.kill('SIGSTOP');
	}

	broadcast();
	res.json(torrent);
});

app.post('/api/torrents/:id/resume', (req, res) => {
	const torrent = torrents.find((item) => item.id === req.params.id);

	if (!torrent) {
		res.status(404).json({ message: 'Torrent not found' });
		return;
	}

	if (torrent.progress >= 100) {
		torrent.status = 'seeding';
		torrent.uploadSpeed = 0.5;
		torrent.downloadSpeed = 0;
		torrent.eta = 'done';
		torrent.health = 'complete';
	} else {
		torrent.status = 'downloading';
		torrent.health = 'resumed';
	}

	appendLog(torrent, 'Resumed from dashboard');
	
	const child = torrentProcesses.get(torrent.id);
	if (child) {
		child.kill('SIGCONT');
	}

	broadcast();
	res.json(torrent);
});

app.delete('/api/torrents/:id', (req, res) => {
	const index = torrents.findIndex((item) => item.id === req.params.id);

	if (index === -1) {
		res.status(404).json({ message: 'Torrent not found' });
		return;
	}

	const [removed] = torrents.splice(index, 1);
	
	const child = torrentProcesses.get(removed.id);
	if (child) {
		child.kill('SIGKILL');
		torrentProcesses.delete(removed.id);
	}

	broadcast();
	res.json({ removed: removed.id });
});

app.get('/api/stream', (req, res) => {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
	});

	res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
	clients.add(res);

	req.on('close', () => {
		clients.delete(res);
	});
});

const clientDist = path.resolve(__dirname, '../client/dist');

if (existsSync(clientDist)) {
	app.use(express.static(clientDist));

	app.get('*', (_req, res) => {
		res.sendFile(path.join(clientDist, 'index.html'));
	});
}

app.listen(port, () => {
	console.log(`Magnet Manager API running on http://localhost:${port}`);
});