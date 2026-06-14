import { useEffect, useMemo, useState, startTransition } from 'react';

const emptyDetails = {
  id: '',
  name: '',
  status: '',
  progress: 0,
  peers: 0,
  downloadSpeed: 0,
  uploadSpeed: 0,
  ratio: 0,
  tracker: '',
  eta: '',
  health: '',
  source: '',
  logs: [],
};

export default function App() {
  const [summary, setSummary] = useState({ active: 0, completed: 0, paused: 0, total: 0, totalProgress: 0, downloadSpeed: 0, uploadSpeed: 0 });
  const [torrents, setTorrents] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [source, setSource] = useState('magnet:?xt=urn:btih:');
  const [name, setName] = useState('');
  const [addMethod, setAddMethod] = useState('link'); // 'link' | 'file'
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const response = await fetch('/api/torrents');
        const data = await response.json();

        if (ignore) {
          return;
        }

        setSummary(data.summary);
        setTorrents(data.torrents);
        setSelectedId((current) => current || data.torrents[0]?.id || '');
      } catch (fetchError) {
        if (!ignore) {
          setError('Unable to reach the backend. Start the Express server on port 3001.');
        }
      }
    }

    load();

    const stream = new EventSource('/api/stream');
    stream.addEventListener('state', (event) => {
      const data = JSON.parse(event.data);
      startTransition(() => {
        setSummary(data.summary);
        setTorrents(data.torrents);
        setSelectedId((current) => current || data.torrents[0]?.id || '');
      });
    });
    stream.onerror = () => {
      setError('Live updates temporarily disconnected. The dashboard will retry automatically.');
    };

    return () => {
      ignore = true;
      stream.close();
    };
  }, []);

  const selectedTorrent = useMemo(
    () => torrents.find((torrent) => torrent.id === selectedId) || torrents[0] || emptyDetails,
    [selectedId, torrents],
  );

  async function runAction(path, method = 'POST', body) {
    if (!path) {
      return;
    }

    setBusy(path);
    setError('');

    try {
      await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (actionError) {
      setError('Action failed. Check that the backend is still running.');
    } finally {
      setBusy('');
    }
  }

  function handleFileChange(event) {
    const selectedFile = event.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setName((current) => current || selectedFile.name.replace(/\.torrent$/i, ''));
    }
  }

  async function handleAddTorrent(event) {
    event.preventDefault();

    if (addMethod === 'link') {
      if (!source.trim()) {
        setError('Paste a magnet link or source first.');
        return;
      }
      await runAction('/api/torrents', 'POST', {
        source: source.trim(),
        name: name.trim(),
      });
      setSource('magnet:?xt=urn:btih:');
      setName('');
    } else {
      if (!file) {
        setError('Please select a .torrent file first.');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Data = reader.result.split(',')[1];
        await runAction('/api/torrents', 'POST', {
          file: base64Data,
          fileName: file.name,
          name: name.trim(),
        });
        setFile(null);
        setName('');
      };
      reader.onerror = () => {
        setError('Failed to read the torrent file.');
      };
      reader.readAsDataURL(file);
    }
  }

  const buttonsDisabled = Boolean(busy);

  return (
    <div className="app-shell">
      <div className="backdrop" />
      <header className="topbar panel">
        <div>
          <p className="eyebrow">Full-stack torrent manager</p>
          <h1>Magnet Manager</h1>
          {/* <p className="muted">Express API on port 3001, React dashboard on port 5173.</p> */}
        </div>
        <div className="topbar-stats">
          <Stat label="Active" value={summary.active} />
          <Stat label="Seeding" value={summary.completed} />
          <Stat label="Paused" value={summary.paused} />
        </div>
      </header>

      <section className="overview-grid">
        <Metric title="Total torrents" value={summary.total} subtitle={`${summary.totalProgress}% average completion`} />
        <Metric title="Download" value={`${summary.downloadSpeed.toFixed(1)} MB/s`} subtitle="" />
        <Metric title="Upload" value={`${summary.uploadSpeed.toFixed(1)} MB/s`} subtitle="Peers and seeding throughput" />
        <Metric title="Selected" value={selectedTorrent.name || 'None'} subtitle={selectedTorrent.status || 'No torrent selected'} />
      </section>

      <main className="layout-grid">
        <section className="panel sidebar-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Queue</p>
              <h2>Active torrents</h2>
            </div>
            <span className="pill">{torrents.length} items</span>
          </div>

          <div className="tab-buttons">
            <button
              type="button"
              className={`tab-button ${addMethod === 'link' ? 'active' : ''}`}
              onClick={() => { setAddMethod('link'); setError(''); }}
            >
              Magnet Link
            </button>
            <button
              type="button"
              className={`tab-button ${addMethod === 'file' ? 'active' : ''}`}
              onClick={() => { setAddMethod('file'); setError(''); }}
            >
              Torrent File
            </button>
          </div>

          <form className="add-form" onSubmit={handleAddTorrent}>
            {addMethod === 'link' ? (
              <label>
                Magnet or source
                <input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="magnet:?xt=urn:btih:..."
                />
              </label>
            ) : (
              <label>
                Torrent file
                <div className="file-upload-wrapper">
                  <input
                    type="file"
                    accept=".torrent"
                    id="torrent-file-input"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                  />
                  <label htmlFor="torrent-file-input" className="file-upload-label">
                    {file ? file.name : 'Choose .torrent file'}
                  </label>
                </div>
              </label>
            )}
            <label>
              Display name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Optional name"
              />
            </label>
            <button className="primary-button" type="submit" disabled={buttonsDisabled}>
              Add torrent
            </button>
          </form>

          <div className="torrent-list">
            {torrents.map((torrent) => (
              <button
                key={torrent.id}
                className={`torrent-card ${torrent.id === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(torrent.id)}
                type="button"
              >
                <div className="torrent-row">
                  <div>
                    <h3>{torrent.name}</h3>
                    <p className="muted small">{torrent.tracker}</p>
                  </div>
                  <span className={`status ${torrent.status}`}>{torrent.status}</span>
                </div>

                <div className="progress-shell" aria-label={`${torrent.progress}% complete`}>
                  <div className="progress-fill" style={{ width: `${torrent.progress}%` }} />
                </div>

                <div className="torrent-meta">
                  <span>{torrent.progress}%</span>
                  <span>{torrent.peers} peers</span>
                  <span>{torrent.eta}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Inspector</p>
              <h2>Selected torrent</h2>
            </div>
            <span className={`pill ${selectedTorrent.status}`}>{selectedTorrent.status || 'idle'}</span>
          </div>

          <div className="detail-card">
            <div className="detail-title">
              <h3>{selectedTorrent.name || 'No torrent selected'}</h3>
              <p className="muted small">{selectedTorrent.source}</p>
            </div>

            <div className="detail-grid">
              <Detail label="Progress" value={`${selectedTorrent.progress || 0}%`} />
              <Detail label="Peers" value={selectedTorrent.peers || 0} />
              <Detail label="Down" value={`${Number(selectedTorrent.downloadSpeed || 0).toFixed(1)} MB/s`} />
              <Detail label="Up" value={`${Number(selectedTorrent.uploadSpeed || 0).toFixed(1)} MB/s`} />
              <Detail label="Ratio" value={Number(selectedTorrent.ratio || 0).toFixed(2)} />
              <Detail label="ETA" value={selectedTorrent.eta || 'n/a'} />
            </div>

            <div className="progress-shell large" aria-label={`${selectedTorrent.progress || 0}% complete`}>
              <div className="progress-fill" style={{ width: `${selectedTorrent.progress || 0}%` }} />
            </div>
          </div>

          <div className="action-row">
            <button
              className="ghost-button"
              type="button"
              onClick={() => runAction(`/api/torrents/${selectedTorrent.id}/pause`)}
              disabled={buttonsDisabled || !selectedTorrent.id}
            >
              Pause
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => runAction(`/api/torrents/${selectedTorrent.id}/resume`)}
              disabled={buttonsDisabled || !selectedTorrent.id}
            >
              Resume
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={() => runAction(`/api/torrents/${selectedTorrent.id}`, 'DELETE')}
              disabled={buttonsDisabled || !selectedTorrent.id}
            >
              Remove
            </button>
          </div>

          <div className="panel-section">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">Activity</p>
                <h2>Recent log</h2>
              </div>
              <span className="pill">{selectedTorrent.health || 'n/a'}</span>
            </div>

            <div className="log-list">
              {(selectedTorrent.logs || []).map((entry) => (
                <div className="log-item" key={entry}>
                  {entry}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {error ? <div className="error-banner panel">{error}</div> : null}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ title, value, subtitle }) {
  return (
    <article className="panel metric-card">
      <p className="eyebrow">{title}</p>
      <h2>{value}</h2>
      <p className="muted small">{subtitle}</p>
    </article>
  );
}

function Detail({ label, value }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}