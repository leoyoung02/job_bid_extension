const $ = (sel) => document.querySelector(sel);

let sessionCount = 0;
let selectedProfileId = '';

// --- DOM refs ---
const upgradeView = $('#upgrade-view');
const upgradeLink = $('#upgrade-link');
const loginView = $('#login-view');
const mainView = $('#main-view');
const loginForm = $('#login-form');
const loginError = $('#login-error');
const loginSubmit = $('#login-submit');
const statusDot = $('#status-dot');
const logoutBtn = $('#logout-btn');
const sessionCounter = $('#session-counter');

const manualForm = $('#manual-form');
const manualSubmit = $('#manual-submit');
const manualStatus = $('#manual-status');

const bidProfileSelect = $('#bid-profile');
const bidSearch = $('#bid-search');
const bidSearchBtn = $('#bid-search-btn');
const bidResults = $('#bid-results');

// --- Init ---
document.addEventListener('DOMContentLoaded', checkAuth);

async function checkAuth() {
  try {
    const res = await sendMessage({ type: 'CHECK_AUTH' });
    if (res.reason === 'UPGRADE_REQUIRED') {
      showUpgrade(res.downloadUrl);
    } else if (res.loggedIn) {
      showMain();
    } else {
      showLogin();
      if (res.reason === 'ACCOUNT_PENDING') {
        loginError.textContent = 'Your account is pending admin approval.';
      } else if (res.reason === 'ACCOUNT_RESTRICTED') {
        loginError.textContent = 'Your account has been restricted. Contact support.';
      }
    }
  } catch {
    showLogin();
  }
}

function showUpgrade(downloadUrl) {
  upgradeView.style.display = '';
  loginView.style.display = 'none';
  mainView.style.display = 'none';
  logoutBtn.style.display = 'none';
  statusDot.className = 'status-dot offline';
  statusDot.title = 'Update required';
  if (downloadUrl) upgradeLink.href = downloadUrl;
}

function showLogin() {
  upgradeView.style.display = 'none';
  loginView.style.display = '';
  mainView.style.display = 'none';
  logoutBtn.style.display = 'none';
  statusDot.className = 'status-dot offline';
  statusDot.title = 'Not connected';
}

async function showMain() {
  upgradeView.style.display = 'none';
  loginView.style.display = 'none';
  mainView.style.display = '';
  logoutBtn.style.display = '';
  statusDot.className = 'status-dot online';
  statusDot.title = 'Connected';
  await loadProfiles();
}

// --- Profiles ---
async function loadProfiles() {
  try {
    const res = await sendMessage({ type: 'GET_PROFILES' });
    if (!res.success || !res.profiles) return;

    bidProfileSelect.innerHTML = '';

    if (res.profiles.length === 0) {
      bidProfileSelect.innerHTML = '<option value="">No profiles — create one on the platform</option>';
      selectedProfileId = '';
      return;
    }

    const defaultProfile = res.profiles.find((p) => p.isDefault) || res.profiles[0];

    for (const p of res.profiles) {
      const opt = document.createElement('option');
      opt.value = p._id;
      opt.textContent = p.name + (p.isDefault ? ' (default)' : '');
      if (p._id === defaultProfile._id) opt.selected = true;
      bidProfileSelect.appendChild(opt);
    }

    selectedProfileId = defaultProfile._id;
  } catch (err) {
    bidProfileSelect.innerHTML = '<option value="">Failed to load profiles</option>';
    selectedProfileId = '';
  }
}

bidProfileSelect.addEventListener('change', () => {
  selectedProfileId = bidProfileSelect.value;
  const query = bidSearch.value.trim();
  if (query) doSearch();
});

// --- Login ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginSubmit.disabled = true;
  loginSubmit.textContent = 'Signing in...';

  try {
    const res = await sendMessage({
      type: 'LOGIN',
      email: $('#login-email').value.trim(),
      password: $('#login-password').value,
    });
    if (res.success) {
      showMain();
      loginForm.reset();
    } else {
      if (res.error && res.error.startsWith('UPGRADE_REQUIRED:')) {
        showUpgrade(res.error.split('UPGRADE_REQUIRED:')[1] || '');
        return;
      }
      if (res.error === 'ACCOUNT_PENDING') {
        loginError.textContent = 'Your account is pending admin approval. Please wait.';
      } else if (res.error === 'ACCOUNT_RESTRICTED') {
        loginError.textContent = 'Your account has been restricted. Contact support.';
      } else {
        loginError.textContent = res.error || 'Login failed';
      }
    }
  } catch (err) {
    if (err.message === 'ACCOUNT_PENDING') {
      loginError.textContent = 'Your account is pending admin approval. Please wait.';
    } else if (err.message === 'ACCOUNT_RESTRICTED') {
      loginError.textContent = 'Your account has been restricted. Contact support.';
    } else {
      loginError.textContent = err.message || 'Login failed';
    }
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = 'Sign In';
  }
});

// --- Logout ---
logoutBtn.addEventListener('click', async () => {
  await sendMessage({ type: 'LOGOUT' });
  showLogin();
});

// --- Main Tabs ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Add Manually ---
manualForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setLoading(manualSubmit, true);
  clearStatus(manualStatus);

  try {
    const job = {
      title: $('#job-title').value.trim(),
      company: $('#job-company').value.trim(),
      location: $('#job-location').value.trim() || undefined,
      url: $('#job-link').value.trim() || undefined,
      description: $('#job-description').value.trim(),
      source: 'chrome-extension',
    };

    const res = await sendMessage({ type: 'ADD_JOB_MANUAL', job });
    if (res.success) {
      setStatus(manualStatus, `Added: ${job.title} at ${job.company}`, 'success');
      manualForm.reset();
      bumpCounter();
    } else {
      setStatus(manualStatus, res.error || 'Failed to add job', 'error');
    }
  } catch (err) {
    setStatus(manualStatus, err.message || 'Failed to add job', 'error');
  } finally {
    setLoading(manualSubmit, false);
  }
});

// --- Bid Tab: Search ---
bidSearchBtn.addEventListener('click', () => doSearch());
bidSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const query = bidSearch.value.trim();
  if (!query) {
    bidResults.innerHTML = '<p class="empty-state">Type a company name or job title to search</p>';
    return;
  }

  bidResults.innerHTML = '<div class="loading-spinner"></div>';
  bidSearchBtn.disabled = true;

  try {
    const res = await sendMessage({
      type: 'SEARCH_JOBS',
      query,
      profileId: selectedProfileId,
    });
    if (!res.success) throw new Error(res.error || 'Search failed');

    const jobs = res.jobs || [];
    if (jobs.length === 0) {
      bidResults.innerHTML = '<p class="empty-state">No jobs found for this search</p>';
      return;
    }

    bidResults.innerHTML = '';
    for (const job of jobs) {
      bidResults.appendChild(createJobCard(job));
    }
  } catch (err) {
    bidResults.innerHTML = `<p class="empty-state" style="color:var(--error)">${err.message}</p>`;
  } finally {
    bidSearchBtn.disabled = false;
  }
}

function createJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card';

  const date = job.postedAt ? new Date(job.postedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const resumes = job.resumes || [];

  let resumeHTML = '';
  if (resumes.length > 0) {
    resumeHTML = resumes.map((r) => {
      const profileLabel = r.profileName || 'Default';
      return `
        <div class="job-card-resume">
          <div>
            <div class="resume-info">Resume ready</div>
            <div class="resume-profile">${profileLabel} &middot; ${r.mode || 'standard'}</div>
          </div>
          <div class="resume-actions">
            <button class="btn-download" data-resume-id="${r._id}" data-job-id="${job._id}" data-filename="${r.fileName}" data-company="${job.company}" data-title="${job.title}" title="Download DOCX">DOCX</button>
            ${r.hasPdf ? `<button class="btn-download pdf" data-resume-id="${r._id}" data-job-id="${job._id}" data-filename="${r.fileName}" data-company="${job.company}" data-title="${job.title}" data-pdf="true" title="Download PDF">PDF</button>` : ''}
          </div>
        </div>`;
    }).join('');
  } else {
    resumeHTML = '<div class="job-card-no-resume">No resume generated yet</div>';
  }

  card.innerHTML = `
    <div class="job-card-header">
      <div class="job-card-title">${escapeHTML(job.title)}</div>
      <div class="job-card-date">${date}</div>
    </div>
    <div class="job-card-company">${escapeHTML(job.company)}${job.location ? ' &middot; ' + escapeHTML(job.location) : ''}</div>
    ${resumeHTML}
  `;

  card.querySelectorAll('.btn-download').forEach((btn) => {
    btn.addEventListener('click', () => handleDownload(btn));
  });

  return card;
}

async function handleDownload(btn) {
  const resumeId = btn.dataset.resumeId;
  const company = btn.dataset.company || 'Unknown';
  const title = btn.dataset.title || 'Resume';
  const isPdf = btn.dataset.pdf === 'true';
  const origName = btn.dataset.filename || 'resume';

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '...';

  try {
    const safeCo = sanitizeFilename(company);
    const safeTitle = sanitizeFilename(title);
    const jobId = btn.dataset.jobId || '';
    const idSuffix = jobId.slice(-6);
    const ext = isPdf ? '.pdf' : '.docx';
    const baseName = origName.replace(/\.(docx|pdf)$/i, '') + ext;
    const folderPath = `RoundTable/${safeCo}_${safeTitle}_${idSuffix}/${baseName}`;

    const res = await sendMessage({
      type: 'DOWNLOAD_RESUME',
      resumeId,
      isPdf,
      suggestedPath: folderPath,
    });
    if (!res.success) throw new Error(res.error || 'Download failed');
  } catch (err) {
    alert('Download failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// --- Helpers ---
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response) {
        reject(new Error('No response from background'));
      } else {
        resolve(response);
      }
    });
  });
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector('.btn-label').style.display = loading ? 'none' : '';
  btn.querySelector('.btn-spinner').style.display = loading ? '' : 'none';
}

function setStatus(el, text, type) {
  el.textContent = text;
  el.className = `status-msg ${type}`;
}

function clearStatus(el) {
  el.textContent = '';
  el.className = 'status-msg';
}

function bumpCounter() {
  sessionCount++;
  sessionCounter.textContent = `Added ${sessionCount} job${sessionCount !== 1 ? 's' : ''} this session`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sanitizeFilename(str) {
  return str.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().substring(0, 60);
}
