const API_BASE = 'http://localhost:5000/api';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

async function getTokens() {
  const data = await chrome.storage.local.get(['accessToken', 'refreshToken']);
  return data;
}

async function saveTokens(accessToken, refreshToken) {
  await chrome.storage.local.set({ accessToken, refreshToken });
}

async function clearTokens() {
  await chrome.storage.local.remove(['accessToken', 'refreshToken']);
}

async function refreshAccessToken() {
  const { refreshToken } = await getTokens();
  if (!refreshToken) throw new Error('No refresh token');

  const res = await fetch(`${API_BASE}/auth/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    await clearTokens();
    throw new Error('Session expired — please log in again');
  }

  const data = await res.json();
  await saveTokens(data.accessToken, data.refreshToken || refreshToken);
  return data.accessToken;
}

async function authedFetch(url, options = {}) {
  let { accessToken } = await getTokens();
  if (!accessToken) throw new Error('Not logged in');

  options.headers = {
    ...options.headers,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  let res = await fetch(url, options);

  if (res.status === 401) {
    accessToken = await refreshAccessToken();
    options.headers.Authorization = `Bearer ${accessToken}`;
    res = await fetch(url, options);
  }

  return res;
}

async function authedFetchBlob(url) {
  let { accessToken } = await getTokens();
  if (!accessToken) throw new Error('Not logged in');

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    accessToken = await refreshAccessToken();
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message || String(err) });
  });
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'LOGIN': {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: msg.email, password: msg.password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Login failed');
      await saveTokens(data.accessToken, data.refreshToken);
      return { success: true, user: data.user };
    }

    case 'LOGOUT': {
      await clearTokens();
      return { success: true };
    }

    case 'CHECK_AUTH': {
      const { accessToken } = await getTokens();
      if (!accessToken) return { success: true, loggedIn: false };
      try {
        const res = await authedFetch(`${API_BASE}/profiles`);
        return { success: true, loggedIn: res.ok };
      } catch {
        return { success: true, loggedIn: false };
      }
    }

    case 'ADD_JOB_URL': {
      const res = await authedFetch(`${API_BASE}/scrape/url`, {
        method: 'POST',
        body: JSON.stringify({ url: msg.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Scrape failed');
      return { success: true, job: data };
    }

    case 'ADD_JOB_MANUAL': {
      const res = await authedFetch(`${API_BASE}/jobs`, {
        method: 'POST',
        body: JSON.stringify(msg.job),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to add job');
      return { success: true, job: data };
    }

    case 'GET_PROFILES': {
      const res = await authedFetch(`${API_BASE}/profiles`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to load profiles');
      const profiles = (Array.isArray(data) ? data : data.profiles || []).map((p) => ({
        _id: p._id,
        name: p.name,
        isDefault: !!p.isDefault,
      }));
      return { success: true, profiles };
    }

    case 'SEARCH_JOBS': {
      const query = encodeURIComponent(msg.query || '');
      const profileId = msg.profileId || '';
      const [jobsRes, mapRes] = await Promise.all([
        authedFetch(`${API_BASE}/jobs?search=${query}&limit=50`),
        authedFetch(`${API_BASE}/resumes/map${profileId ? `?profileId=${profileId}` : ''}`),
      ]);
      const jobsData = await jobsRes.json();
      if (!jobsRes.ok) throw new Error(jobsData.message || 'Search failed');

      const mapData = mapRes.ok ? await mapRes.json() : { map: {} };
      const resumeMap = mapData.map || {};

      const jobs = (jobsData.jobs || jobsData || []).map((j) => ({
        _id: j._id,
        title: j.title,
        company: j.company,
        location: j.location,
        postedAt: j.postedAt,
        resumes: (resumeMap[j._id] || []).map((r) => ({
          _id: r._id,
          fileName: r.fileName,
          mode: r.mode,
          profileName: r.profileName,
          hasPdf: r.hasPdf,
        })),
      }));

      return { success: true, jobs };
    }

    case 'DOWNLOAD_RESUME': {
      const { resumeId, isPdf, suggestedPath } = msg;
      const endpoint = isPdf
        ? `${API_BASE}/resumes/download-pdf/${resumeId}`
        : `${API_BASE}/resumes/download/${resumeId}`;

      const blob = await authedFetchBlob(endpoint);
      const reader = new FileReader();

      const dataUrl = await new Promise((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: dataUrl, filename: suggestedPath, saveAs: false },
          (id) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          }
        );
      });

      chrome.downloads.onChanged.addListener(function listener(delta) {
        if (delta.id === downloadId && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.show(downloadId);
        }
      });

      return { success: true, downloadId };
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}
