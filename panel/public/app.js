(() => {
  const root = document.querySelector('#app');
  const state = {
    user: null,
    csrfToken: null,
    view: 'overview',
    servers: [],
    nodes: [],
    eggs: {},
    users: [],
    audit: [],
    serverId: null,
    server: null,
    live: null,
    tab: 'overview',
    filePath: '',
    files: [],
    backups: [],
    timer: null,
  };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

  const formatBytes = (bytes) => {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const dateText = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  };

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;

    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    if (state.csrfToken && options.method && options.method !== 'GET') {
      headers['X-CSRF-Token'] = state.csrfToken;
    }

    const response = await fetch(`/api${url}`, {
      ...options,
      body,
      headers,
      credentials: 'same-origin',
    });

    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`Server returned an invalid response (HTTP ${response.status}).`); }

    if (!response.ok) throw new Error(payload.error || `Request failed (HTTP ${response.status}).`);
    return payload;
  }

  function toast(message, error = false) {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    const item = document.createElement('div');
    item.className = `toast${error ? ' error' : ''}`;
    item.textContent = message;
    stack.appendChild(item);
    setTimeout(() => item.remove(), 4200);
  }

  function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function boot() {
    try {
      const auth = await api('/auth/me');
      if (auth.user) {
        state.user = auth.user;
        state.csrfToken = auth.csrfToken;
        await refreshData();
      } else {
        const setup = await api('/auth/setup-status');
        renderAuth(setup.setupRequired);
      }
    } catch (error) {
      renderFatal(error.message);
    }
  }

  function renderFatal(message) {
    root.innerHTML = `
      <div class="auth-wrap">
        <section class="auth-card">
          <div class="brand-lockup"><div class="brand-mark">C</div><div class="brand-copy"><strong>CrazePanel</strong><small>Startup error</small></div></div>
          <h1>Panel unavailable</h1>
          <p>${esc(message)}</p>
          <button class="btn primary full" data-action="reload">Retry connection</button>
        </section>
      </div>`;
  }

  function renderAuth(setupRequired) {
    stopTimer();
    const isSetup = Boolean(setupRequired);
    root.innerHTML = `
      <div class="auth-wrap">
        <section class="auth-card">
          <div class="brand-lockup">
            <div class="brand-mark">C</div>
            <div class="brand-copy"><strong>CrazePanel</strong><small>Game server control</small></div>
          </div>
          <h1>${isSetup ? 'Create the panel owner' : 'Welcome back'}</h1>
          <p>${isSetup
            ? 'Set up the first administrator account. There are no default or demo credentials.'
            : 'Sign in to access your servers and node infrastructure.'}</p>
          <div id="auth-error"></div>
          <form class="form-stack" id="auth-form" data-form="${isSetup ? 'setup' : 'login'}">
            <label class="field-label">Username
              <input name="username" minlength="3" maxlength="32" autocomplete="username" required placeholder="Your username">
            </label>
            ${isSetup ? '<label class="field-label">Email <input name="email" type="email" autocomplete="email" placeholder="admin@example.com"></label>' : ''}
            <label class="field-label">Password
              <input name="password" type="password" minlength="${isSetup ? 12 : 1}" maxlength="128" autocomplete="${isSetup ? 'new-password' : 'current-password'}" required placeholder="${isSetup ? 'At least 12 characters' : 'Your password'}">
            </label>
            <button class="btn primary full" type="submit">${isSetup ? 'Create administrator' : 'Sign in'}</button>
          </form>
          ${isSetup ? '<p class="help" style="margin-top:18px">Your password is stored as a bcrypt hash. Keep your panel secret keys backed up separately.</p>' : ''}
        </section>
      </div>`;
  }

  async function refreshData() {
    const serversResult = await api('/servers');
    state.servers = serversResult.servers || [];

    if (state.user.role === 'admin') {
      const results = await Promise.all([
        api('/nodes'),
        api('/eggs'),
      ]);
      state.nodes = results[0].nodes || [];
      state.eggs = results[1].eggs || {};
    }

    render();
  }

  function navButton(view, icon, label) {
    const active = state.view === view || (state.view === 'server' && view === 'servers');
    return `<button type="button" class="${active ? 'active' : ''}" data-view="${view}">
      <span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>
    </button>`;
  }

  function render() {
    stopTimer();
    const admin = state.user.role === 'admin';
    const activeNodes = state.nodes.filter((node) => node.online).length;

    root.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="sidebar-brand">
            <div class="brand-mark">C</div>
            <div class="brand-copy"><strong>CrazePanel</strong><small>Control platform</small></div>
          </div>
          <div class="side-section">Workspace</div>
          <nav class="nav">
            ${navButton('overview', '◫', 'Overview')}
            ${navButton('servers', '▣', 'Servers')}
            ${admin ? navButton('nodes', '⌘', 'Nodes') : ''}
          </nav>
          ${admin ? '<div class="side-section">Management</div><nav class="nav">' +
            navButton('admin', '⚙', 'Administration') +
            navButton('activity', '↗', 'Activity log') +
            '</nav>' : ''}
          <div class="sidebar-bottom">
            ${admin ? `<div class="node-indicator"><small>NODE HEALTH</small><strong>${activeNodes} / ${state.nodes.length} online</strong></div>` : ''}
            <div class="account-row">
              <div class="avatar">${esc(state.user.username.slice(0, 1).toUpperCase())}</div>
              <div class="account-details"><strong>${esc(state.user.username)}</strong><small>${esc(state.user.role.toUpperCase())}</small></div>
              <button class="btn small ghost" data-action="logout" title="Sign out">↗</button>
            </div>
          </div>
        </aside>
        <div class="workspace">
          <header class="topbar">
            <div class="crumb">CRAZEPANEL / <strong>${esc(pageTitle())}</strong></div>
            <div class="top-actions"><span class="live-label"><i class="live-dot"></i>Session active</span><button class="btn small ghost" data-action="refresh">↻ Refresh</button></div>
          </header>
          <main class="main-content" id="content">${renderPage()}</main>
        </div>
      </div>
      <div id="modal-root"></div>`;

    if (state.view === 'server' && state.serverId) {
      refreshServer();
      if (state.tab === 'console') {
        state.timer = setInterval(loadConsole, 2500);
      } else if (state.tab === 'overview') {
        state.timer = setInterval(refreshServer, 6000);
      }
    }
  }

  function pageTitle() {
    if (state.view === 'server') return state.server?.name || 'Server';
    return ({
      overview: 'Overview',
      servers: 'Servers',
      nodes: 'Nodes',
      admin: 'Administration',
      activity: 'Activity',
    })[state.view] || 'Overview';
  }

  function heading(kicker, title, subtitle, action = '') {
    return `<div class="page-heading">
      <div><div class="kicker">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="heading-actions">${action}</div>
    </div>`;
  }

  function statusBadge(status) {
    const value = String(status || 'unknown').toLowerCase();
    return `<span class="status ${esc(value)}">${esc(status || 'Unknown')}</span>`;
  }

  function renderOverview() {
    const online = state.servers.filter((server) => server.status === 'running').length;
    const offline = state.servers.filter((server) => server.status === 'node-offline').length;
    const cards = [
      ['SERVER INSTANCES', state.servers.length, 'Registered workloads'],
      ['RUNNING', online, 'Live container state'],
      ['STOPPED / OTHER', state.servers.length - online - offline, 'Not currently running'],
      ['NODES OFFLINE', offline, 'Servers with unreachable agent'],
    ];

    return `
      ${heading('OPERATIONS', 'Overview', 'Your game infrastructure, with status reported by connected node agents.',
        adminAction('<button class="btn primary" data-action="new-server">＋ Create server</button>'))}
      <section class="stats-grid">${cards.map(([label, value, note]) => `
        <article class="stat-card"><small>${label}</small><div class="stat-value">${value}</div><div class="stat-foot">${note}</div></article>
      `).join('')}</section>
      <div class="section-head"><div><h2>Server instances</h2><p>Latest status from each connected node.</p></div><button class="btn small" data-view="servers">All servers →</button></div>
      <section class="panel">
        ${state.servers.length ? `
          <div class="table-wrap"><table>
            <thead><tr><th>Server</th><th>Software</th><th>Node</th><th>Address</th><th>Status</th><th></th></tr></thead>
            <tbody>${state.servers.slice(0, 8).map((server) => serverRow(server)).join('')}</tbody>
          </table></div>
        ` : emptyState('No servers yet', admin ? 'Add a node, then provision your first Minecraft server.' : 'No servers have been assigned to your account.', admin ? '<button class="btn primary" data-action="new-node">Add a node</button>' : '')}
      </section>
      ${admin ? `
        <div class="section-head"><div><h2>Nodes</h2><p>Hosts connected to CrazePanel.</p></div><button class="btn small" data-view="nodes">Manage nodes →</button></div>
        <section class="node-grid">${state.nodes.slice(0, 4).map((node) => nodeCard(node)).join('') || emptyState('No nodes registered', 'Install a node agent and connect it to this panel.', '<button class="btn primary" data-action="new-node">Register node</button>')}</section>
      ` : ''}
    `;
  }

  function adminAction(value) {
    return state.user.role === 'admin' ? value : '';
  }

  function emptyState(title, description, action = '') {
    return `<div class="empty"><div class="brand-mark" style="margin:0 auto 12px">C</div><strong>${esc(title)}</strong><p>${esc(description)}</p>${action}</div>`;
  }

  function serverRow(server) {
    const node = state.nodes.find((item) => item.id === server.node_id);
    const egg = state.eggs[server.egg_id];
    return `<tr>
      <td><span class="server-name">${esc(server.name)}</span><span class="subline">${esc(server.id.slice(0, 8))}</span></td>
      <td>${esc(egg?.name || server.egg_id)}<span class="subline">${esc(server.version)}</span></td>
      <td>${esc(node?.name || 'Node')}</td>
      <td class="mono">${esc(server.port)}</td>
      <td>${statusBadge(server.status)}</td>
      <td><button class="btn small" data-server="${esc(server.id)}">Manage →</button></td>
    </tr>`;
  }

  function nodeCard(node) {
    return `<article class="node-card">
      <header><h3>${esc(node.name)}</h3>${statusBadge(node.online ? 'online' : 'offline')}</header>
      <p>${esc(node.url)}</p>
      <div class="node-card-foot"><span class="muted">${esc(node.location || 'No location')}</span><span class="muted mono">${node.docker ? `Docker ${esc(node.docker.version)}` : 'Agent not reachable'}</span></div>
    </article>`;
  }

  function renderServers() {
    return `
      ${heading('INSTANCES', 'Servers', 'Manage Minecraft Java and Bedrock server instances.',
        adminAction('<button class="btn primary" data-action="new-server">＋ Create server</button>'))}
      <section class="panel">
        ${state.servers.length ? `
          <div class="table-wrap"><table>
            <thead><tr><th>Server</th><th>Software</th><th>Resources</th><th>Port</th><th>Status</th><th></th></tr></thead>
            <tbody>${state.servers.map((server) => `
              <tr>
                <td><span class="server-name">${esc(server.name)}</span><span class="subline">${esc(server.id)}</span></td>
                <td>${esc(state.eggs[server.egg_id]?.name || server.egg_id)}<span class="subline">${esc(server.version)}</span></td>
                <td class="mono">${server.memory_mb} MB · ${server.cpu_cores} CPU</td>
                <td class="mono">${server.port}</td>
                <td>${statusBadge(server.status)}</td>
                <td><button class="btn small" data-server="${esc(server.id)}">Manage →</button></td>
              </tr>
            `).join('')}</tbody>
          </table></div>
        ` : emptyState('No server instances', state.user.role === 'admin' ? 'Register a node first, then create a server.' : 'There are no server instances assigned to you.', adminAction('<button class="btn primary" data-action="new-node">Register node</button>'))}
      </section>`;
  }

  function renderNodes() {
    return `
      ${heading('INFRASTRUCTURE', 'Nodes', 'Machines that run Docker containers and host your game servers.',
        '<button class="btn primary" data-action="new-node">＋ Register node</button>')}
      <section class="node-grid">${state.nodes.map((node) => nodeCard(node) + `
        <div class="node-card">
          <div class="node-card-foot">
            <span class="muted">Last contact: ${esc(dateText(node.last_seen))}</span>
            <div class="inline-actions">
              <button class="btn small" data-node-test="${esc(node.id)}">Test</button>
              <button class="btn small danger" data-node-delete="${esc(node.id)}">Remove</button>
            </div>
          </div>
        </div>
      `).join('') || emptyState('No nodes connected', 'Create a node record, install the agent on a Linux host and use its shared token.', '<button class="btn primary" data-action="new-node">Register first node</button>')}</section>`;
  }

  function renderAdmin() {
    return `
      ${heading('CONTROL', 'Administration', 'Manage panel accounts and review privileged activity.')}
      <div class="section-head"><div><h2>Panel users</h2><p>Account roles and access state.</p></div><button class="btn primary" data-action="new-user">＋ Create user</button></div>
      <section class="panel">
        <div class="table-wrap"><table>
          <thead><tr><th>Account</th><th>Role</th><th>State</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${state.users.map((user) => `
            <tr>
              <td><span class="server-name">${esc(user.username)}</span><span class="subline">${esc(user.email || 'No email')}</span></td>
              <td>${esc(user.role)}</td>
              <td>${user.disabled ? statusBadge('disabled') : statusBadge('online')}</td>
              <td class="mono">${esc(dateText(user.created_at))}</td>
              <td><div class="inline-actions">
                ${user.id !== state.user.id ? `
                  <button class="btn small" data-user-role="${esc(user.id)}" data-role="${user.role === 'admin' ? 'user' : 'admin'}">Make ${user.role === 'admin' ? 'user' : 'admin'}</button>
                  <button class="btn small" data-user-disable="${esc(user.id)}" data-disabled="${user.disabled ? 'false' : 'true'}">${user.disabled ? 'Enable' : 'Disable'}</button>
                  <button class="btn small danger" data-user-delete="${esc(user.id)}">Delete</button>
                ` : '<span class="muted">Current account</span>'}
              </div></td>
            </tr>
          `).join('')}</tbody>
        </table></div>
      </section>
      <div class="section-head"><div><h2>Security notes</h2><p>Operational safety for this installation.</p></div></div>
      <section class="panel"><div class="panel-head"><strong>Host access</strong><small>NODE AGENT</small></div><div style="padding:16px" class="help">The agent has access to the Docker socket, which is effectively host-level access. Keep agent tokens private and limit the agent port to trusted panel traffic. Never give panel administration access to untrusted users.</div></section>
    `;
  }

  function renderActivity() {
    return `
      ${heading('AUDIT', 'Activity log', 'Administrator actions recorded by the panel.')}
      <section class="panel">
        <div class="table-wrap"><table>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Object</th><th>Details</th></tr></thead>
          <tbody>${state.audit.map((log) => `
            <tr>
              <td class="mono">${esc(dateText(log.created_at))}</td>
              <td>${esc(log.username || 'System')}</td>
              <td>${esc(log.action)}</td>
              <td>${esc(log.entity_type)} <span class="subline">${esc(log.entity_id || '')}</span></td>
              <td class="muted">${esc(log.details)}</td>
            </tr>
          `).join('')}</tbody>
        </table></div>
        ${state.audit.length ? '' : emptyState('No activity yet', 'Panel actions will appear here as users operate the system.')}
      </section>`;
  }

  function renderPage() {
    if (state.view === 'servers') return renderServers();
    if (state.view === 'nodes') return renderNodes();
    if (state.view === 'admin') return renderAdmin();
    if (state.view === 'activity') return renderActivity();
    if (state.view === 'server') return renderServerPage();
    return renderOverview();
  }

  function renderServerPage() {
    const server = state.server || state.servers.find((item) => item.id === state.serverId);
    if (!server) {
      return `${heading('SERVER', 'Loading server', 'Fetching live instance details.')}<section class="panel empty">Loading server data…</section>`;
    }

    const tabs = [
      ['overview', 'Overview'],
      ['console', 'Console'],
      ['files', 'Files'],
      ['backups', 'Backups'],
    ];

    return `
      ${heading('SERVER WORKSPACE', esc(server.name), `${esc(state.eggs[server.egg_id]?.name || server.egg_id)} · ${esc(server.version)} · Port ${server.port}`,
        `<button class="btn" data-view="servers">← All servers</button>
         ${server.canManage && state.user.role === 'admin' ? '<button class="btn danger" data-action="delete-server">Delete</button>' : ''}`)}
      <nav class="server-tabs">${tabs.map(([id, label]) => `<button class="${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</nav>
      ${state.tab === 'overview' ? renderServerOverview(server) : ''}
      ${state.tab === 'console' ? renderConsole() : ''}
      ${state.tab === 'files' ? renderFiles() : ''}
      ${state.tab === 'backups' ? renderBackups() : ''}
    `;
  }

  function renderServerOverview(server) {
    const stats = state.live?.stats;
    return `
      <div class="page-heading">
        <div><div class="kicker">LIVE CONTAINER STATE</div><div>${statusBadge(state.live?.status || server.status)}</div></div>
        <div class="heading-actions">
          <button class="btn primary" data-power="start" ${state.live?.status === 'running' ? 'disabled' : ''}>Start</button>
          <button class="btn" data-power="restart" ${state.live?.status !== 'running' ? 'disabled' : ''}>Restart</button>
          <button class="btn danger" data-power="stop" ${state.live?.status !== 'running' ? 'disabled' : ''}>Stop</button>
        </div>
      </div>
      <section class="resource-grid">
        <article class="resource-card"><small>CPU USAGE</small><strong>${stats ? `${stats.cpuPercent}%` : '—'}</strong></article>
        <article class="resource-card"><small>MEMORY</small><strong>${stats ? formatBytes(stats.memoryBytes) : '—'}</strong><span class="subline">${stats ? `${stats.memoryPercent}% of limit` : 'No live stats'}</span></article>
        <article class="resource-card"><small>NETWORK RX / TX</small><strong>${stats ? `${formatBytes(stats.networkRxBytes)} / ${formatBytes(stats.networkTxBytes)}` : '—'}</strong></article>
      </section>
      <div class="detail-grid" style="margin-top:15px">
        <section class="panel">
          <div class="panel-head"><strong>Instance information</strong><small>SERVER CONFIGURATION</small></div>
          <div class="file-row"><span>Name</span><span class="mono">${esc(server.name)}</span></div>
          <div class="file-row"><span>Version</span><span class="mono">${esc(server.version)}</span></div>
          <div class="file-row"><span>Port</span><span class="mono">${server.port}</span></div>
          <div class="file-row"><span>Memory limit</span><span class="mono">${server.memory_mb} MB</span></div>
          <div class="file-row"><span>CPU limit</span><span class="mono">${server.cpu_cores} cores</span></div>
          <div class="file-row"><span>Container ID</span><span class="mono">${esc((server.container_id || '').slice(0, 12))}</span></div>
        </section>
        <section class="panel">
          <div class="panel-head"><strong>Runtime</strong><small>AGENT DATA</small></div>
          <div class="file-row"><span>Container present</span><span>${state.live?.exists ? 'Yes' : 'No'}</span></div>
          <div class="file-row"><span>Started at</span><span class="mono">${esc(dateText(state.live?.startedAt))}</span></div>
          <div class="file-row"><span>Node</span><span>${esc(state.nodes.find((node) => node.id === server.node_id)?.name || 'Registered node')}</span></div>
          <div class="file-row"><span>Last update</span><span class="mono">${esc(dateText(server.updated_at))}</span></div>
          ${server.canManage && state.user.role === 'admin' ? '<div style="padding:13px"><button class="btn small" data-action="edit-resources">Adjust resource limits</button></div>' : ''}
        </section>
      </div>
    `;
  }

  function renderConsole() {
    const lines = state.consoleLines || [];
    return `
      <section class="panel">
        <div class="panel-head"><strong>Server console</strong><small>DOCKER ATTACH / LOG OUTPUT</small></div>
        <div class="console-output" id="console-output">${lines.length ? lines.map((line) => esc(line)).join('\n') : 'Waiting for console output…'}</div>
        <form class="console-form" id="command-form">
          <input name="command" autocomplete="off" maxlength="500" placeholder="Enter a server command…" required>
          <button class="btn primary" type="submit">Send command</button>
        </form>
      </section>
      <p class="help" style="margin-top:10px">Console output is read from Docker logs. Commands use the attached container stdin stream. Some server images may not support interactive stdin.</p>
    `;
  }

  function renderFiles() {
    const files = state.files || [];
    const parts = state.filePath ? state.filePath.split('/') : [];
    return `
      <section class="panel">
        <div class="file-toolbar">
          <div class="breadcrumbs">/ ${parts.map((part, index) => `<button class="btn small ghost" data-file-path="${esc(parts.slice(0, index + 1).join('/'))}">${esc(part)}</button> /`).join(' ')}</div>
          <button class="btn small" data-action="file-up" ${state.filePath ? '' : 'disabled'}>↑ Up</button>
          <button class="btn small" data-action="new-folder">＋ Folder</button>
          <button class="btn small" data-action="new-file">＋ Text file</button>
          <label class="btn small">Upload<input id="file-upload" type="file" hidden></label>
          <button class="btn small" data-action="refresh-files">↻</button>
        </div>
        ${files.length ? files.map((file) => `
          <div class="file-row">
            <div class="file-name"><span>${file.type === 'directory' ? '▰' : '▤'}</span>
              ${file.type === 'directory'
                ? `<button class="btn small ghost" data-file-path="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">${esc(file.name)}</button>`
                : `<span>${esc(file.name)}</span>`}
            </div>
            <span class="muted mono">${file.type === 'directory' ? 'Directory' : formatBytes(file.size)}</span>
            <div class="file-actions">
              ${file.type === 'file' ? `<button class="btn small" data-file-open="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">Edit</button>` : ''}
              <button class="btn small danger" data-file-delete="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">Delete</button>
            </div>
          </div>
        `).join('') : emptyState('This directory is empty', 'Upload a file or create a folder to get started.')}
      </section>`;
  }

  function renderBackups() {
    return `
      <div class="page-heading">
        <div><div class="kicker">RESTORE POINTS</div><p>Full server-directory archives stored on the node host.</p></div>
        <div class="heading-actions"><button class="btn primary" data-action="create-backup">＋ Create backup</button></div>
      </div>
      <section class="panel">
        <div class="panel-head"><strong>Available backups</strong><small>BACKUP STORAGE</small></div>
        ${state.backups.length ? state.backups.map((backup) => `
          <div class="file-row">
            <span class="server-name">${esc(backup.name)}<span class="subline">${esc(dateText(backup.createdAt))}</span></span>
            <span class="mono muted">${formatBytes(backup.size)}</span>
            <div class="file-actions"><button class="btn small danger" data-backup-restore="${esc(backup.name)}">Restore</button></div>
          </div>
        `).join('') : emptyState('No backups yet', 'Create a restore point before installing plugins or changing server configuration.')}
      </section>
      <p class="help" style="margin-top:10px">Restore is allowed only while the container is stopped. Backups can use significant disk space; copy important archives off-node.</p>
    `;
  }

  async function refreshServer() {
    if (!state.serverId) return;
    try {
      const result = await api(`/servers/${state.serverId}`);
      state.server = result.server;
      state.live = result.live;
      if (state.view === 'server' && state.tab === 'overview') {
        const content = document.querySelector('#content');
        if (content) content.innerHTML = renderServerPage();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function loadConsole() {
    if (!state.serverId || state.view !== 'server' || state.tab !== 'console') return;
    try {
      const result = await api(`/servers/${state.serverId}/console`);
      state.consoleLines = result.lines || [];
      const output = document.querySelector('#console-output');
      if (output) {
        output.textContent = state.consoleLines.join('\n') || 'Waiting for console output…';
        output.scrollTop = output.scrollHeight;
      }
    } catch (error) {
      const output = document.querySelector('#console-output');
      if (output) output.textContent = error.message;
    }
  }

  async function loadFiles() {
    const result = await api(`/servers/${state.serverId}/files?${new URLSearchParams({ path: state.filePath })}`);
    state.files = result.files || [];
    render();
  }

  async function loadBackups() {
    const result = await api(`/servers/${state.serverId}/backups`);
    state.backups = result.backups || [];
    render();
  }

  function openServer(id) {
    state.serverId = id;
    state.server = state.servers.find((server) => server.id === id) || null;
    state.live = null;
    state.tab = 'overview';
    state.filePath = '';
    state.files = [];
    state.backups = [];
    state.consoleLines = [];
    state.view = 'server';
    render();
  }

  async function goTab(tab) {
    state.tab = tab;
    if (tab === 'files') {
      try {
        const result = await api(`/servers/${state.serverId}/files`);
        state.files = result.files || [];
      } catch (error) {
        toast(error.message, true);
      }
    }
    if (tab === 'backups') {
      try {
        const result = await api(`/servers/${state.serverId}/backups`);
        state.backups = result.backups || [];
      } catch (error) {
        toast(error.message, true);
      }
    }
    if (tab === 'console') await loadConsole();
    render();
  }

  function openModal(title, body, footer = '<button class="btn" data-action="close-modal">Close</button>') {
    const modalRoot = document.querySelector('#modal-root');
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-action="backdrop-close">
        <section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <header class="modal-head"><h2>${esc(title)}</h2><button class="btn small ghost" data-action="close-modal" aria-label="Close">✕</button></header>
          <div class="modal-body">${body}</div>
          <footer class="modal-foot">${footer}</footer>
        </section>
      </div>`;
  }

  function closeModal() {
    const modalRoot = document.querySelector('#modal-root');
    if (modalRoot) modalRoot.innerHTML = '';
  }

  function confirmModal(title, message, action, payload = {}) {
    openModal(title, `<p class="help">${esc(message)}</p>`, `
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn danger" data-confirm-action="${esc(action)}" data-confirm-payload="${esc(JSON.stringify(payload))}">Confirm</button>
    `);
  }

  async function newServerModal() {
    if (!state.nodes.length) {
      toast('Register and connect a node before creating a server.', true);
      state.view = 'nodes';
      render();
      return;
    }

    const eggs = Object.entries(state.eggs);
    openModal('Create a server', `
      <form class="form-stack" id="new-server-form" data-form="new-server">
        <label class="field-label">Server name<input name="name" required maxlength="48" placeholder="Survival SMP"></label>
        <div class="form-grid">
          <label class="field-label">Server software<select name="eggId">${eggs.map(([id, egg]) => `<option value="${esc(id)}">${esc(egg.name)}</option>`).join('')}</select></label>
          <label class="field-label">Minecraft version<input name="version" value="LATEST" maxlength="20" required></label>
          <label class="field-label">Node<select name="nodeId">${state.nodes.map((node) => `<option value="${esc(node.id)}" ${node.online ? '' : 'disabled'}>${esc(node.name)} ${node.online ? '' : '(offline)'}</option>`).join('')}</select></label>
          <label class="field-label">Host port<input name="port" type="number" min="1" max="65535" value="25565" required></label>
          <label class="field-label">Memory (MB)<input name="memoryMb" type="number" min="1024" max="131072" step="256" value="4096" required></label>
          <label class="field-label">CPU cores<input name="cpuCores" type="number" min="0.5" max="64" step="0.5" value="2" required></label>
        </div>
        <p class="help">The agent pulls the allow-listed image from its registry, creates persistent server storage and starts the container. First boot may take several minutes.</p>
      </form>`,
      '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit" form="new-server-form">Create and install</button>');
  }

  function newNodeModal() {
    openModal('Register a node', `
      <form class="form-stack" id="new-node-form" data-form="new-node">
        <label class="field-label">Node name<input name="name" required maxlength="64" placeholder="Main node"></label>
        <label class="field-label">Agent URL<input name="url" type="url" required placeholder="https://node1.example.com:8080"></label>
        <label class="field-label">Location<input name="location" maxlength="80" placeholder="Frankfurt, Germany"></label>
        <p class="help">CrazePanel creates a unique agent token and encrypts it in the panel database. Copy it once after registering, then place it in the agent environment file on the host.</p>
      </form>`,
      '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit" form="new-node-form">Generate node token</button>');
  }

  function newUserModal() {
    openModal('Create a panel user', `
      <form class="form-stack" id="new-user-form" data-form="new-user">
        <label class="field-label">Username<input name="username" required minlength="3" maxlength="32" placeholder="operator01"></label>
        <label class="field-label">Email<input name="email" type="email" placeholder="operator@example.com"></label>
        <label class="field-label">Temporary password<input name="password" type="password" required minlength="12" maxlength="128" placeholder="At least 12 characters"></label>
        <label class="field-label">Role<select name="role"><option value="user">User</option><option value="admin">Administrator</option></select></label>
      </form>`,
      '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit" form="new-user-form">Create user</button>');
  }

  function fileModal(title, formId, formType, fields, submitLabel) {
    openModal(title, `<form class="form-stack" id="${formId}" data-form="${formType}">${fields}</form>`,
      `<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit" form="${formId}">${submitLabel}</button>`);
  }

  async function editFile(filePath) {
    try {
      const result = await api(`/servers/${state.serverId}/file?${new URLSearchParams({ path: filePath })}`);
      fileModal(`Edit ${filePath.split('/').pop()}`, 'edit-file-form', 'edit-file', `
        <label class="field-label">File path<input name="path" value="${esc(result.path)}" readonly></label>
        <label class="field-label">Contents<textarea class="field" name="content" spellcheck="false">${esc(result.content)}</textarea></label>
        <p class="help">Text editor limit: 2 MB. Binary files should be uploaded or downloaded, not edited here.</p>
      `, 'Save file');
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    const type = form.dataset.form;
    const values = Object.fromEntries(new FormData(form).entries());

    try {
      if (type === 'login' || type === 'setup') {
        const result = await api(`/auth/${type}`, { method: 'POST', body: values });
        state.user = result.user;
        state.csrfToken = result.csrfToken;
        await refreshData();
        toast(type === 'setup' ? 'Administrator account created.' : 'Signed in.');
        return;
      }

      if (type === 'new-server') {
        const payload = {
          ...values,
          port: Number(values.port),
          memoryMb: Number(values.memoryMb),
          cpuCores: Number(values.cpuCores),
        };
        const result = await api('/servers', { method: 'POST', body: payload });
        closeModal();
        toast('Server provisioned and started.');
        await refreshData();
        openServer(result.server.id);
        return;
      }

      if (type === 'new-node') {
        const result = await api('/nodes', { method: 'POST', body: values });
        closeModal();
        openModal('Node token generated', `
          <p class="help">Copy this token now. It is encrypted in the panel database and cannot be displayed again.</p>
          <div class="token-box" id="node-token">${esc(result.token)}</div>
          <p class="help" style="margin-top:14px">Set <span class="mono">NODE_TOKEN</span> in <span class="mono">/etc/crazepanel/agent.env</span>, restart <span class="mono">crazepanel-agent</span>, then test the node here.</p>
          <pre class="token-box">NODE_TOKEN=${esc(result.token)}
AGENT_HOST=0.0.0.0
AGENT_PORT=8080</pre>
        `, `
          <button class="btn" data-action="close-modal">Close</button>
          <button class="btn primary" data-action="copy-node-token">Copy token</button>
        `);
        await refreshData();
        return;
      }

      if (type === 'new-user') {
        await api('/admin/users', { method: 'POST', body: values });
        closeModal();
        toast('Panel user created.');
        await loadAdmin();
        return;
      }

      if (type === 'edit-file') {
        await api(`/servers/${state.serverId}/file`, { method: 'PUT', body: values });
        closeModal();
        toast('File saved.');
        await loadFiles();
        return;
      }

      if (type === 'new-file') {
        await api(`/servers/${state.serverId}/file`, {
          method: 'PUT',
          body: { path: [state.filePath, values.name].filter(Boolean).join('/'), content: values.content || '' },
        });
        closeModal();
        toast('File created.');
        await loadFiles();
        return;
      }

      if (type === 'new-folder') {
        await api(`/servers/${state.serverId}/files`, {
          method: 'POST',
          body: { action: 'mkdir', path: [state.filePath, values.name].filter(Boolean).join('/') },
        });
        closeModal();
        toast('Folder created.');
        await loadFiles();
        return;
      }

      if (type === 'edit-resources') {
        await api(`/servers/${state.serverId}`, {
          method: 'PATCH',
          body: { memoryMb: Number(values.memoryMb), cpuCores: Number(values.cpuCores) },
        });
        closeModal();
        toast('Server resource limits updated.');
        await refreshServer();
        return;
      }
    } catch (error) {
      const authError = document.querySelector('#auth-error');
      if (authError && (type === 'login' || type === 'setup')) {
        authError.innerHTML = `<div class="auth-error">${esc(error.message)}</div>`;
      } else {
        toast(error.message, true);
      }
    }
  }

  async function loadAdmin() {
    const [users, audit] = await Promise.all([
      api('/admin/users'),
      api('/admin/audit?limit=100'),
    ]);
    state.users = users.users || [];
    state.audit = audit.logs || [];
    state.audit = state.audit.map((row) => ({ ...row, details: row.details || '{}' }));
    if (state.view === 'admin' || state.view === 'activity') render();
  }

  async function action(action, button) {
    try {
      if (action === 'logout') {
        await api('/auth/logout', { method: 'POST', body: {} });
        state.user = null;
        state.csrfToken = null;
        renderAuth(false);
        return;
      }
      if (action === 'refresh') {
        await refreshData();
        toast('Panel data refreshed.');
        return;
      }
      if (action === 'reload') {
        location.reload();
        return;
      }
      if (action === 'close-modal') {
        closeModal();
        return;
      }
      if (action === 'backdrop-close') {
        if (button.target === button.currentTarget) closeModal();
        return;
      }
      if (action === 'new-server') return newServerModal();
      if (action === 'new-node') return newNodeModal();
      if (action === 'new-user') return newUserModal();
      if (action === 'copy-node-token') {
        const token = document.querySelector('#node-token')?.textContent || '';
        await navigator.clipboard.writeText(token);
        toast('Node token copied.');
        return;
      }
      if (action === 'new-folder') {
        fileModal('Create folder', 'new-folder-form', 'new-folder',
          '<label class="field-label">Folder name<input name="name" required maxlength="80" pattern="[a-zA-Z0-9_. -]+"></label>', 'Create folder');
        return;
      }
      if (action === 'new-file') {
        fileModal('Create text file', 'new-file-form', 'new-file',
          '<label class="field-label">File name<input name="name" required maxlength="100" pattern="[a-zA-Z0-9_. -]+"></label><label class="field-label">Initial contents<textarea class="field" name="content" spellcheck="false"></textarea></label>', 'Create file');
        return;
      }
      if (action === 'file-up') {
        state.filePath = state.filePath.split('/').slice(0, -1).join('/');
        await loadFiles();
        return;
      }
      if (action === 'refresh-files') {
        await loadFiles();
        return;
      }
      if (action === 'create-backup') {
        button.disabled = true;
        const result = await api(`/servers/${state.serverId}/backups`, { method: 'POST', body: { label: 'Manual backup' } });
        toast(`Backup created: ${result.name}`);
        await loadBackups();
        return;
      }
      if (action === 'delete-server') {
        confirmModal('Delete this server?', 'This removes the Docker container and the panel record. The node data directory is not automatically erased.', 'delete-server');
        return;
      }
      if (action === 'edit-resources') {
        fileModal('Adjust resources', 'edit-resources-form', 'edit-resources', `
          <label class="field-label">Memory limit (MB)<input type="number" name="memoryMb" min="1024" max="131072" step="256" value="${state.server.memory_mb}" required></label>
          <label class="field-label">CPU cores<input type="number" name="cpuCores" min="0.5" max="64" step="0.5" value="${state.server.cpu_cores}" required></label>
        `, 'Save limits');
        return;
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function doConfirm(actionName, payload) {
    closeModal();
    try {
      if (actionName === 'delete-server') {
        await api(`/servers/${state.serverId}`, { method: 'DELETE' });
        toast('Server record and container removed. Data is retained on its node.');
        state.serverId = null;
        state.server = null;
        state.view = 'servers';
        await refreshData();
      }
      if (actionName === 'delete-node') {
        await api(`/nodes/${payload.id}`, { method: 'DELETE' });
        toast('Node removed.');
        await refreshData();
      }
      if (actionName === 'delete-user') {
        await api(`/admin/users/${payload.id}`, { method: 'DELETE' });
        toast('User deleted.');
        await loadAdmin();
      }
      if (actionName === 'delete-file') {
        await api(`/servers/${state.serverId}/file?${new URLSearchParams({ path: payload.path })}`, { method: 'DELETE' });
        toast('File removed.');
        await loadFiles();
      }
      if (actionName === 'restore-backup') {
        await api(`/servers/${state.serverId}/backups/restore`, { method: 'POST', body: { name: payload.name } });
        toast('Backup restored.');
        await refreshServer();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function handleClick(event) {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      state.view = viewButton.dataset.view;
      state.serverId = null;
      if (state.view === 'admin' || state.view === 'activity') await loadAdmin();
      render();
      return;
    }

    const serverButton = event.target.closest('[data-server]');
    if (serverButton) {
      openServer(serverButton.dataset.server);
      return;
    }

    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {
      await goTab(tabButton.dataset.tab);
      return;
    }

    const powerButton = event.target.closest('[data-power]');
    if (powerButton) {
      const power = powerButton.dataset.power;
      powerButton.disabled = true;
      try {
        await api(`/servers/${state.serverId}/power/${power}`, { method: 'POST', body: {} });
        toast(`Server ${power} requested.`);
        await refreshServer();
        if (state.tab === 'overview') render();
      } catch (error) {
        toast(error.message, true);
      } finally {
        powerButton.disabled = false;
      }
      return;
    }

    const filePathButton = event.target.closest('[data-file-path]');
    if (filePathButton) {
      state.filePath = filePathButton.dataset.filePath;
      await loadFiles();
      return;
    }

    const fileOpenButton = event.target.closest('[data-file-open]');
    if (fileOpenButton) {
      await editFile(fileOpenButton.dataset.fileOpen);
      return;
    }

    const fileDeleteButton = event.target.closest('[data-file-delete]');
    if (fileDeleteButton) {
      confirmModal('Delete file or folder?', `This permanently deletes ${fileDeleteButton.dataset.fileDelete} from the server directory.`, 'delete-file', { path: fileDeleteButton.dataset.fileDelete });
      return;
    }

    const backupRestoreButton = event.target.closest('[data-backup-restore]');
    if (backupRestoreButton) {
      confirmModal('Restore backup?', 'The server must be stopped. Current files will be replaced with this backup.', 'restore-backup', { name: backupRestoreButton.dataset.backupRestore });
      return;
    }

    const nodeTest = event.target.closest('[data-node-test]');
    if (nodeTest) {
      nodeTest.disabled = true;
      try {
        const result = await api(`/nodes/${nodeTest.dataset.nodeTest}/test`, { method: 'POST', body: {} });
        toast(`Agent reachable · Docker ${result.health.docker.version}`);
        await refreshData();
      } catch (error) {
        toast(error.message, true);
      } finally {
        nodeTest.disabled = false;
      }
      return;
    }

    const nodeDelete = event.target.closest('[data-node-delete]');
    if (nodeDelete) {
      confirmModal('Remove node?', 'This is allowed only when no servers are assigned to the node.', 'delete-node', { id: nodeDelete.dataset.nodeDelete });
      return;
    }

    const userRole = event.target.closest('[data-user-role]');
    if (userRole) {
      try {
        await api(`/admin/users/${userRole.dataset.userRole}`, { method: 'PATCH', body: { role: userRole.dataset.role } });
        toast('User role updated.');
        await loadAdmin();
      } catch (error) { toast(error.message, true); }
      return;
    }

    const userDisable = event.target.closest('[data-user-disable]');
    if (userDisable) {
      try {
        await api(`/admin/users/${userDisable.dataset.userDisable}`, {
          method: 'PATCH',
          body: { disabled: userDisable.dataset.disabled === 'true' },
        });
        toast('User access updated.');
        await loadAdmin();
      } catch (error) { toast(error.message, true); }
      return;
    }

    const userDelete = event.target.closest('[data-user-delete]');
    if (userDelete) {
      confirmModal('Delete user?', 'This removes the selected panel account.', 'delete-user', { id: userDelete.dataset.userDelete });
      return;
    }

    const confirm = event.target.closest('[data-confirm-action]');
    if (confirm) {
      let payload = {};
      try { payload = JSON.parse(confirm.dataset.confirmPayload || '{}'); } catch {}
      await doConfirm(confirm.dataset.confirmAction, payload);
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (actionButton) await action(actionButton.dataset.action, actionButton);
  }

  async function handleConsoleSubmit(event) {
    if (event.target.id !== 'command-form') return;
    event.preventDefault();
    const command = new FormData(event.target).get('command');
    try {
      await api(`/servers/${state.serverId}/console`, { method: 'POST', body: { command } });
      event.target.reset();
      await loadConsole();
    } catch (error) { toast(error.message, true); }
  }

  async function handleUpload(event) {
    if (event.target.id !== 'file-upload' || !event.target.files?.length) return;
    const file = event.target.files[0];
    if (file.size > 64 * 1024 * 1024) {
      toast('Upload limit is 64 MB.', true);
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = String(reader.result).split(',')[1] || '';
        await api(`/servers/${state.serverId}/files`, {
          method: 'POST',
          body: { action: 'upload', path: state.filePath, name: file.name, contentBase64: base64 },
        });
        toast('File uploaded.');
        await loadFiles();
      } catch (error) {
        toast(error.message, true);
      }
      event.target.value = '';
    };
    reader.onerror = () => toast('Could not read the selected file.', true);
    reader.readAsDataURL(file);
  }

  document.addEventListener('click', (event) => {
    handleClick(event).catch((error) => toast(error.message, true));
  });
  document.addEventListener('submit', (event) => {
    handleSubmit(event).catch((error) => toast(error.message, true));
    handleConsoleSubmit(event).catch((error) => toast(error.message, true));
  });
  document.addEventListener('change', (event) => {
    handleUpload(event).catch((error) => toast(error.message, true));
  });

  boot();
})();
