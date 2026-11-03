(() => {
  const root = document.querySelector('#app');
  function favoritesStorageKey(owner) {
    return `crazepanel.server-favorites.v1.${encodeURIComponent(String(owner || 'guest'))}`;
  }

  function readServerFavorites(owner) {
    try {
      const saved = JSON.parse(localStorage.getItem(favoritesStorageKey(owner)) || '[]');
      return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  function saveServerFavorites() {
    try {
      localStorage.setItem(favoritesStorageKey(state.favoriteOwner), JSON.stringify(state.favoriteServers));
      return true;
    } catch {
      return false;
    }
  }

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
    serverSearch: '',
    serverFilter: 'all',
    serverSort: 'updated',
    favoriteServers: [],
    favoriteOwner: null,
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
    const favoriteOwner = state.user.id || state.user.username;
    if (state.favoriteOwner !== favoriteOwner) {
      state.favoriteOwner = favoriteOwner;
      state.favoriteServers = readServerFavorites(favoriteOwner);
    }
    const visibleServerIds = new Set(state.servers.map((server) => server.id));
    const visibleFavorites = state.favoriteServers.filter((id) => visibleServerIds.has(id));
    if (visibleFavorites.length !== state.favoriteServers.length) {
      state.favoriteServers = visibleFavorites;
      saveServerFavorites();
    }

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
            ${navButton('account', '◉', 'Account')}
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
      account: 'Account',
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
    const admin = state.user.role === 'admin';
    const online = state.servers.filter((server) => server.status === 'running').length;
    const stopped = state.servers.filter((server) => ['stopped', 'exited'].includes(server.status)).length;
    const attentionServers = state.servers.filter((server) => ['node-offline', 'offline', 'error', 'failed', 'unknown', 'missing'].includes(String(server.status || '').toLowerCase())).length;
    const offlineNodes = admin ? state.nodes.filter((node) => !node.online).length : 0;
    const onlineNodes = admin ? state.nodes.filter((node) => node.online).length : 0;
    const recentServers = state.servers.slice(0, 6);
    const uptimeLabel = state.servers.length ? 'Live state from node agents' : 'No workloads provisioned yet';

    return `
      <div class="dashboard-welcome">
        <div>
          <div class="kicker">CRAZEPANEL / CONTROL CENTER</div>
          <h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${esc(state.user.username)}.</h1>
          <p>Here is the current status of your Minecraft infrastructure.</p>
        </div>
        <div class="dashboard-actions">
          ${admin ? '<button class="btn" data-action="new-node">＋ Add node</button><button class="btn primary" data-action="new-server">＋ Create server</button>' : '<button class="btn" data-view="servers">View my servers</button>'}
        </div>
      </div>

      <section class="dashboard-metrics">
        <article class="metric-card metric-primary">
          <div class="metric-top"><span>SERVER INSTANCES</span><span class="metric-icon">▣</span></div>
          <strong>${state.servers.length}</strong>
          <small>${uptimeLabel}</small>
        </article>
        <article class="metric-card">
          <div class="metric-top"><span>RUNNING SERVERS</span><span class="metric-icon">◉</span></div>
          <strong>${online}</strong>
          <small>${state.servers.length ? `${Math.round(online / state.servers.length * 100)}% of your instances` : 'Waiting for first server'}</small>
        </article>
        <article class="metric-card">
          <div class="metric-top"><span>STOPPED SERVERS</span><span class="metric-icon">Ⅱ</span></div>
          <strong>${stopped}</strong>
          <small>Stopped or exited containers</small>
        </article>
        ${admin ? `
          <article class="metric-card">
            <div class="metric-top"><span>NODES ONLINE</span><span class="metric-icon">⌘</span></div>
            <strong>${onlineNodes}<span class="metric-total"> / ${state.nodes.length}</span></strong>
            <small>${offlineNodes ? `${offlineNodes} node(s) need attention` : 'All registered nodes reachable'}</small>
          </article>
        ` : ''}
      </section>

      <div class="dashboard-grid">
        <section class="dashboard-main-column">
          <div class="dashboard-section-heading">
            <div><span class="kicker">YOUR INFRASTRUCTURE</span><h2>Server instances</h2><p>Monitor and manage your Minecraft servers.</p></div>
            <button class="btn small" data-view="servers">View all <span aria-hidden="true">→</span></button>
          </div>
          <section class="dashboard-server-list">
            ${recentServers.length ? recentServers.map((server) => {
              const egg = state.eggs[server.egg_id];
              const node = state.nodes.find((item) => item.id === server.node_id);
              return `
                <article class="dashboard-server-row">
                  <div class="dashboard-server-symbol">▣</div>
                  <div class="dashboard-server-info">
                    <strong>${esc(server.name)}</strong>
                    <small>${esc(egg?.name || server.egg_id)} · ${esc(server.version)} · ${esc(node?.name || 'Node')}</small>
                  </div>
                  <div class="dashboard-server-port"><small>PORT</small><strong>${esc(server.port)}</strong></div>
                  <div class="dashboard-server-status">${statusBadge(server.status)}</div>
                  <button class="btn small" data-server="${esc(server.id)}">Open <span aria-hidden="true">↗</span></button>
                </article>`;
            }).join('') : emptyState('No servers yet', admin ? 'Register a node and create your first Minecraft server.' : 'No server instances have been assigned to your account.', admin ? '<button class="btn primary" data-action="new-server">Create server</button>' : '')}
          </section>

          ${admin ? `
            <div class="dashboard-section-heading dashboard-node-heading">
              <div><span class="kicker">HOST INFRASTRUCTURE</span><h2>Node health</h2><p>Connection state of your registered machines.</p></div>
              <button class="btn small" data-view="nodes">Manage nodes <span aria-hidden="true">→</span></button>
            </div>
            <section class="dashboard-node-list">
              ${state.nodes.length ? state.nodes.slice(0, 4).map((node) => `
                <article class="dashboard-node-row">
                  <span class="node-health-indicator ${node.online ? 'is-online' : 'is-offline'}"></span>
                  <div class="dashboard-node-info"><strong>${esc(node.name)}</strong><small>${esc(node.location || node.url)}</small></div>
                  <div class="dashboard-node-version">${node.docker ? `Docker ${esc(node.docker.version)}` : 'Agent unavailable'}</div>
                  ${statusBadge(node.online ? 'online' : 'offline')}
                </article>
              `).join('') : emptyState('No nodes registered', 'Register a Linux host running the CrazePanel agent.', '<button class="btn primary" data-action="new-node">Register node</button>')}
            </section>
          ` : ''}
        </section>

        <aside class="dashboard-side-column">
          <section class="dashboard-side-panel">
            <div class="dashboard-section-heading compact"><div><span class="kicker">SHORTCUTS</span><h2>Quick actions</h2></div></div>
            <div class="quick-action-list">
              ${admin ? `
                <button data-action="new-server"><span class="quick-action-icon">＋</span><span><strong>Create a server</strong><small>Deploy a Minecraft instance</small></span><span class="quick-arrow">↗</span></button>
                <button data-action="new-node"><span class="quick-action-icon">⌘</span><span><strong>Register a node</strong><small>Connect another host machine</small></span><span class="quick-arrow">↗</span></button>
                <button data-view="admin"><span class="quick-action-icon">♙</span><span><strong>Manage users</strong><small>Roles and access permissions</small></span><span class="quick-arrow">↗</span></button>
                <button data-view="activity"><span class="quick-action-icon">↗</span><span><strong>Activity log</strong><small>Review panel actions</small></span><span class="quick-arrow">↗</span></button>
              ` : `
                <button data-view="servers"><span class="quick-action-icon">▣</span><span><strong>Open my servers</strong><small>Manage assigned instances</small></span><span class="quick-arrow">↗</span></button>
                <button data-view="account"><span class="quick-action-icon">◉</span><span><strong>Account settings</strong><small>Update account security</small></span><span class="quick-arrow">↗</span></button>
              `}
            </div>
          </section>
          <section class="dashboard-side-panel dashboard-system-panel">
            <div class="dashboard-section-heading compact"><div><span class="kicker">PANEL STATUS</span><h2>System overview</h2></div><span class="system-status-dot ${attentionServers || offlineNodes ? 'has-issues' : 'is-healthy'}" aria-label="${attentionServers || offlineNodes ? 'Infrastructure needs attention' : 'Infrastructure healthy'}"></span></div>
            <div class="system-overview-row"><span>Panel session</span><strong>Active</strong></div>
            <div class="system-overview-row"><span>Connected nodes</span><strong>${admin ? `${onlineNodes} / ${state.nodes.length}` : 'Managed by admin'}</strong></div>
            <div class="system-overview-row"><span>Server workloads</span><strong>${state.servers.length}</strong></div>
            <div class="system-overview-row"><span>Needs attention</span><strong>${attentionServers}</strong></div>
            <p class="dashboard-disclaimer">Metrics are based on the latest successful node-agent responses. Detailed CPU, memory and network usage is available inside each server workspace.</p>
          </section>
        </aside>
      </div>
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
      <div class="node-card-foot">
        <span class="muted">${esc(node.location || 'No location')}<span class="subline">Last contact: ${esc(dateText(node.last_seen))}</span></span>
        <span class="muted mono">${node.docker ? `Docker ${esc(node.docker.version)}` : 'Agent not reachable'}</span>
      </div>
      <div class="node-card-foot">
        <span class="help">${node.error ? esc(node.error) : 'Agent health check'}</span>
        <div class="inline-actions">
          <button class="btn small" data-node-test="${esc(node.id)}">Test connection</button>
          <button class="btn small danger" data-node-delete="${esc(node.id)}">Remove</button>
        </div>
      </div>
    </article>`;
  }
  function renderServers() {
    const counts = {
      all: state.servers.length,
      running: state.servers.filter((server) => server.status === 'running').length,
      stopped: state.servers.filter((server) => ['stopped', 'exited'].includes(server.status)).length,
      attention: state.servers.filter((server) => ['node-offline', 'offline', 'error', 'failed', 'unknown', 'missing'].includes(server.status)).length,
    };
    const filterCard = (filter, label, value, hint) => `
      <button type="button" class="inventory-stat ${state.serverFilter === filter ? 'active' : ''}" data-server-filter="${filter}" aria-pressed="${state.serverFilter === filter}">
        <span>${label}</span><strong>${value}</strong><small>${hint}</small>
      </button>`;
    const filtered = getFilteredServers();

    return `
      ${heading('INSTANCES', 'Servers', 'Manage Minecraft Java and Bedrock server instances.',
        adminAction('<button class="btn primary" data-action="new-server">＋ Create server</button>'))}
      ${state.servers.length ? `
        <section class="inventory-stats" aria-label="Server status filters">
          ${filterCard('all', 'All servers', counts.all, 'Every instance')}
          ${filterCard('running', 'Running', counts.running, 'Online workloads')}
          ${filterCard('stopped', 'Stopped', counts.stopped, 'Paused instances')}
          ${filterCard('attention', 'Needs attention', counts.attention, 'Offline or unhealthy')}
        </section>
        <section class="panel server-inventory">
          <div class="server-toolbar">
            <label class="server-search-label" for="server-search">Find a server</label>
            <div class="server-search-wrap"><span aria-hidden="true">⌕</span><input id="server-search" type="search" value="${esc(state.serverSearch)}" placeholder="Name, software, node, port…" autocomplete="off"></div>
            <label class="server-sort-label" for="server-sort">Sort</label>
            <select id="server-sort" aria-label="Sort servers">
              <option value="updated" ${state.serverSort === 'updated' ? 'selected' : ''}>Recently updated</option>
              <option value="name-asc" ${state.serverSort === 'name-asc' ? 'selected' : ''}>Name A–Z</option>
              <option value="name-desc" ${state.serverSort === 'name-desc' ? 'selected' : ''}>Name Z–A</option>
              <option value="port" ${state.serverSort === 'port' ? 'selected' : ''}>Port low to high</option>
            </select>
            <button type="button" class="btn small favorite-filter ${state.serverFilter === 'favorites' ? 'active' : ''}" data-server-filter="favorites" aria-pressed="${state.serverFilter === 'favorites'}">★ Favorites <span id="favorite-count">${state.favoriteServers.length}</span></button>
            <button type="button" class="btn small ghost" data-action="clear-server-filters">Reset</button>
          </div>
          <div class="inventory-results" id="server-results" role="status" aria-live="polite">Showing ${filtered.length} of ${state.servers.length} servers</div>
          <div class="table-wrap" id="server-table-wrap" ${filtered.length ? '' : 'hidden'}><table>
            <thead><tr><th>Server</th><th>Software</th><th>Resources</th><th>Port</th><th>Status</th><th></th></tr></thead>
            <tbody id="server-table-body">${filtered.map((server) => serverInventoryRow(server)).join('')}</tbody>
          </table></div>
          <div class="empty inventory-empty" id="server-empty-results" ${filtered.length ? 'hidden' : ''}>
            <div class="inventory-empty-icon" aria-hidden="true">⌕</div>
            <strong>No matching servers</strong>
            <p>Try a different search or status filter, or reset the view to see every instance.</p>
            <button type="button" class="btn" data-action="clear-server-filters">Clear filters</button>
          </div>
          <div class="inventory-footnote">Favorites are saved in this browser only.</div>
        </section>
      ` : emptyState('No server instances', state.user.role === 'admin' ? 'Register a node first, then create a server.' : 'There are no server instances assigned to you.', adminAction('<button class="btn primary" data-action="new-node">Register node</button>'))}`;
  }

  function getFilteredServers() {
    const query = state.serverSearch.trim().toLocaleLowerCase();
    const filtered = state.servers.filter((server) => {
      const status = String(server.status || 'unknown').toLowerCase();
      if (state.serverFilter === 'running' && status !== 'running') return false;
      if (state.serverFilter === 'stopped' && !['stopped', 'exited'].includes(status)) return false;
      if (state.serverFilter === 'attention' && !['node-offline', 'offline', 'error', 'failed', 'unknown', 'missing'].includes(status)) return false;
      if (state.serverFilter === 'favorites' && !state.favoriteServers.includes(server.id)) return false;
      if (!query) return true;

      const node = state.nodes.find((item) => item.id === server.node_id);
      const egg = state.eggs[server.egg_id];
      const haystack = [server.name, server.id, egg?.name, server.egg_id, server.version, node?.name, node?.location, server.port, server.memory_mb, server.cpu_cores]
        .filter((value) => value !== undefined && value !== null)
        .join(' ')
        .toLocaleLowerCase();
      return haystack.includes(query);
    });

    filtered.sort((a, b) => {
      if (state.serverSort === 'name-asc') return String(a.name).localeCompare(String(b.name));
      if (state.serverSort === 'name-desc') return String(b.name).localeCompare(String(a.name));
      if (state.serverSort === 'port') return Number(a.port) - Number(b.port);
      const aDate = new Date(a.updated_at || a.created_at || 0).getTime() || 0;
      const bDate = new Date(b.updated_at || b.created_at || 0).getTime() || 0;
      return bDate - aDate;
    });
    return filtered;
  }

  function serverInventoryRow(server) {
    const node = state.nodes.find((item) => item.id === server.node_id);
    const egg = state.eggs[server.egg_id];
    const favorite = state.favoriteServers.includes(server.id);
    return `<tr>
      <td><div class="inventory-name-cell"><button type="button" class="favorite-toggle ${favorite ? 'is-favorite' : ''}" data-server-favorite="${esc(server.id)}" aria-label="${favorite ? 'Remove' : 'Add'} ${esc(server.name)} ${favorite ? 'from' : 'to'} favorites" aria-pressed="${favorite}">${favorite ? '★' : '☆'}</button><span><span class="server-name">${esc(server.name)}</span><span class="subline">${esc(server.id.slice(0, 8))} · ${esc(node?.name || 'Node')}</span></span></div></td>
      <td>${esc(egg?.name || server.egg_id)}<span class="subline">${esc(server.version)}</span></td>
      <td class="mono">${esc(server.memory_mb)} MB · ${esc(server.cpu_cores)} CPU</td>
      <td class="mono">${esc(server.port)}</td>
      <td>${statusBadge(server.status)}</td>
      <td><button class="btn small" data-server="${esc(server.id)}">Manage →</button></td>
    </tr>`;
  }

  function syncServerInventory() {
    const body = document.querySelector('#server-table-body');
    if (!body) return;
    const filtered = getFilteredServers();
    body.innerHTML = filtered.map((server) => serverInventoryRow(server)).join('');
    const tableWrap = document.querySelector('#server-table-wrap');
    const empty = document.querySelector('#server-empty-results');
    if (tableWrap) tableWrap.hidden = filtered.length === 0;
    if (empty) empty.hidden = filtered.length !== 0;
    const results = document.querySelector('#server-results');
    if (results) results.textContent = `Showing ${filtered.length} of ${state.servers.length} servers`;
    const favoriteCount = document.querySelector('#favorite-count');
    if (favoriteCount) favoriteCount.textContent = String(state.favoriteServers.length);
    document.querySelectorAll('[data-server-filter]').forEach((button) => {
      const active = button.dataset.serverFilter === state.serverFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function toggleServerFavorite(id) {
    state.favoriteServers = state.favoriteServers.includes(id)
      ? state.favoriteServers.filter((item) => item !== id)
      : [...state.favoriteServers, id];
    if (!saveServerFavorites()) {
      toast('Favorite saved for this session, but browser storage is unavailable.', true);
    }
    syncServerInventory();
    if (state.view !== 'servers') render();
  }

  function renderNodes() {
    return `
      ${heading('INFRASTRUCTURE', 'Nodes', 'Machines that run Docker containers and host your game servers.',
        '<button class="btn primary" data-action="new-node">＋ Register node</button>')}
      <section class="node-grid">${state.nodes.map((node) => nodeCard(node)).join('') || emptyState('No nodes connected', 'Create a node record, install the agent on a Linux host and use its shared token.', '<button class="btn primary" data-action="new-node">Register first node</button>')}</section>`;
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

  function renderAccount() {
    return `
      ${heading('ACCOUNT SECURITY', 'Account', 'Change your sign-in password and review your current account.')}
      <section class="panel" style="max-width:620px">
        <div class="panel-head"><strong>Account profile</strong><small>${esc(state.user.role.toUpperCase())}</small></div>
        <div class="file-row"><span>Username</span><strong>${esc(state.user.username)}</strong></div>
        <div class="file-row"><span>Email</span><strong>${esc(state.user.email || 'Not set')}</strong></div>
        <form class="form-stack" id="password-form" data-form="password-change" style="padding:18px">
          <label class="field-label">Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label>
          <label class="field-label">New password<input type="password" name="newPassword" minlength="12" maxlength="128" autocomplete="new-password" required></label>
          <label class="field-label">Confirm new password<input type="password" name="confirmPassword" minlength="12" maxlength="128" autocomplete="new-password" required></label>
          <button class="btn primary" type="submit">Change password</button>
        </form>
      </section>
      <p class="help" style="margin-top:12px">Use a unique password of at least 12 characters. Changing it renews your current session.</p>
    `;
  }
  function renderPage() {
    if (state.view === 'servers') return renderServers();
    if (state.view === 'nodes') return renderNodes();
    if (state.view === 'admin') return renderAdmin();
    if (state.view === 'activity') return renderActivity();
    if (state.view === 'account') return renderAccount();
    if (state.view === 'server') return renderServerPage();
    return renderOverview();
  }

  function renderServerPage() {
    const server = state.server || state.servers.find((item) => item.id === state.serverId);
    if (!server) {
      return `${heading('SERVER', 'Loading server', 'Fetching live instance details.')}<section class="panel empty">Loading server data…</section>`;
    }

    const tabs = [
      ['overview', '◫', 'Overview'],
      ['console', '⌁', 'Console'],
      ['files', '▤', 'Files'],
      ['backups', '◷', 'Backups'],
      ['settings', '⚙', 'Settings'],
    ];

    return `
      <section class="server-workspace">
        <aside class="server-sidebar">
          <button class="server-back" data-view="servers">← <span>All servers</span></button>
          <div class="server-identity">
            <div class="server-avatar">▣</div>
            <div class="server-identity-copy"><strong>${esc(server.name)}</strong><small>${esc(state.eggs[server.egg_id]?.name || server.egg_id)} · ${esc(server.version)}</small></div>
          </div>
          <div class="server-nav-label">SERVER MANAGEMENT</div>
          <nav class="server-nav">
            ${tabs.map(([id, icon, label]) => `<button class="${state.tab === id ? 'active' : ''}" data-tab="${id}"><span class="server-nav-icon">${icon}</span><span>${label}</span>${state.tab === id ? '<i></i>' : ''}</button>`).join('')}
          </nav>
          <div class="server-sidebar-bottom">${statusBadge(state.live?.status || server.status)}<small>PORT ${esc(server.port)}</small></div>
        </aside>
        <div class="server-workspace-main">
          <div class="server-workspace-top">
            <div class="server-breadcrumb"><button data-view="servers">Servers</button><span>/</span><strong>${esc(server.name)}</strong><span>/</span><strong>${tabs.find(([id]) => id === state.tab)?.[2] || 'Overview'}</strong></div>
            <div class="inline-actions"><button class="btn small ghost" data-action="refresh">↻ Refresh</button>${server.canManage && state.user.role === 'admin' ? '<button class="btn small danger" data-action="delete-server">Delete server</button>' : ''}</div>
          </div>
          <div class="server-workspace-content">
            ${state.tab === 'overview' ? renderServerOverview(server) : ''}
            ${state.tab === 'console' ? renderConsole() : ''}
            ${state.tab === 'files' ? renderFiles() : ''}
            ${state.tab === 'backups' ? renderBackups() : ''}
            ${state.tab === 'settings' ? renderServerSettings(server) : ''}
          </div>
        </div>
      </section>
    `;
  }

  function renderServerSettings(server) {
    const node = state.nodes.find((item) => item.id === server.node_id);
    return `
      ${heading('CONFIGURATION', 'Server settings', 'Manage resource limits, access permissions and instance details.')}
      <section class="settings-grid">
        <article class="panel settings-panel">
          <div class="panel-head"><div><strong>Resource allocation</strong><small class="settings-subtitle">CPU AND MEMORY LIMITS</small></div><span class="settings-icon">▥</span></div>
          <div class="settings-values"><div><small>Memory limit</small><strong>${esc(server.memory_mb)} <span>MB</span></strong></div><div><small>CPU cores</small><strong>${esc(server.cpu_cores)}</strong></div></div>
          <p class="help">These limits are applied to the Docker container. Changes affect the running container configuration.</p>
          ${server.canManage && state.user.role === 'admin' ? '<button class="btn" data-action="edit-resources">Adjust resources</button>' : '<p class="help">Only an administrator can change resource allocation.</p>'}
        </article>
        <article class="panel settings-panel">
          <div class="panel-head"><div><strong>Server access</strong><small class="settings-subtitle">TEAM PERMISSIONS</small></div><span class="settings-icon">♙</span></div>
          <p class="help">Control which panel users can view or operate this server.</p>
          ${server.canManage && state.user.role === 'admin' ? '<button class="btn" data-action="manage-access">Manage user access</button>' : '<p class="help">You do not have permission to manage access.</p>'}
        </article>
        <article class="panel settings-panel">
          <div class="panel-head"><div><strong>Instance information</strong><small class="settings-subtitle">IDENTITY AND NETWORK</small></div><span class="settings-icon">ⓘ</span></div>
          <div class="settings-detail"><span>Server ID</span><code>${esc(server.id)}</code></div>
          <div class="settings-detail"><span>Software</span><strong>${esc(state.eggs[server.egg_id]?.name || server.egg_id)}</strong></div>
          <div class="settings-detail"><span>Minecraft version</span><strong>${esc(server.version)}</strong></div>
          <div class="settings-detail"><span>Allocation port</span><strong>${esc(server.port)}</strong></div>
          <div class="settings-detail"><span>Node</span><strong>${esc(node?.name || 'Registered node')}</strong></div>
          <div class="settings-detail"><span>Created</span><strong>${esc(dateText(server.created_at))}</strong></div>
        </article>
        <article class="panel settings-panel settings-danger">
          <div class="panel-head"><div><strong>Danger zone</strong><small class="settings-subtitle">IRREVERSIBLE ACTIONS</small></div><span class="settings-icon">⚠</span></div>
          <p class="help">Deleting the server removes its container and panel record. Server files are retained on the node host and are not automatically erased.</p>
          ${server.canManage && state.user.role === 'admin' ? '<button class="btn danger" data-action="delete-server">Delete server instance</button>' : '<p class="help">Only an administrator can delete this server.</p>'}
        </article>
      </section>
    `;
  }

  function renderServerOverview(server) {
    const stats = state.live?.stats;
    const currentStatus = state.live?.status || server.status;
    return `
      <div class="page-heading">
        <div><div class="kicker">LIVE CONTAINER STATE</div><div>${statusBadge(currentStatus)}</div></div>
        <div class="heading-actions">
          <button class="btn primary" data-power="start" ${!server.canOperate || currentStatus === 'running' ? 'disabled' : ''}>Start</button>
          <button class="btn" data-power="restart" ${!server.canOperate || currentStatus !== 'running' ? 'disabled' : ''}>Restart</button>
          <button class="btn danger" data-power="stop" ${!server.canOperate || currentStatus !== 'running' ? 'disabled' : ''}>Stop</button>
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
          ${server.canManage && state.user.role === 'admin' ? '<div style="padding:13px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" data-action="edit-resources">Adjust resource limits</button><button class="btn small" data-action="manage-access">Manage access</button></div>' : ''}
          ${!server.canOperate ? '<div class="help" style="padding:13px">Read-only access: server controls, console commands and file changes are disabled.</div>' : ''}
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
          <input name="command" autocomplete="off" maxlength="500" placeholder="${state.server?.canOperate ? 'Enter a server command…' : 'Read-only access'}" required ${state.server?.canOperate ? '' : 'disabled'}>
          <button class="btn primary" type="submit" ${state.server?.canOperate ? '' : 'disabled'}>Send command</button>
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
          ${state.server?.canOperate ? '<button class="btn small" data-action="new-folder">＋ Folder</button><button class="btn small" data-action="new-file">＋ Text file</button><label class="btn small">Upload<input id="file-upload" type="file" hidden></label>' : ''}
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
              ${file.type === 'file' ? `${state.server?.canOperate ? `<button class="btn small" data-file-open="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">Edit</button>` : ''}<button class="btn small" data-file-download="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">Download</button>` : ''}
              ${state.server?.canOperate ? `<button class="btn small" data-file-rename="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">Rename</button><button class="btn small danger" data-file-delete="${esc([state.filePath, file.name].filter(Boolean).join('/'))}">Delete</button>` : ''}
            </div>
          </div>
        `).join('') : emptyState('This directory is empty', 'Upload a file or create a folder to get started.')}
      </section>`;
  }

  function saveBase64Download(name, contentBase64) {
    if (typeof contentBase64 !== 'string') throw new Error('The node returned an invalid download.');
    const binary = atob(contentBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadFile(filePath) {
    const query = new URLSearchParams({ path: filePath });
    const result = await api(`/servers/${state.serverId}/download?${query}`);
    saveBase64Download(result.name || filePath.split('/').pop(), result.contentBase64);
  }

  async function downloadBackup(name) {
    const result = await api(`/servers/${state.serverId}/backups/${encodeURIComponent(name)}/download`);
    saveBase64Download(result.name || name, result.contentBase64);
  }

  function renameFileModal(filePath) {
    const name = filePath.split('/').pop();
    fileModal('Rename file or folder', 'rename-file-form', 'rename-file', `
      <label class="field-label">Current path<input name="path" value="${esc(filePath)}" readonly></label>
      <label class="field-label">New name<input name="name" value="${esc(name)}" maxlength="120" pattern="[a-zA-Z0-9_ ()-][a-zA-Z0-9_ .()-]{0,119}" required><small class="help">Hidden names beginning with a dot are not allowed.</small></label>
    `, 'Rename');
  }
  function renderBackups() {
    return `
      <div class="page-heading">
        <div><div class="kicker">RESTORE POINTS</div><p>Full server-directory archives stored on the node host.</p></div>
        <div class="heading-actions">${state.server?.canOperate ? '<button class="btn primary" data-action="create-backup">＋ Create backup</button>' : ''}</div>
      </div>
      <section class="panel">
        <div class="panel-head"><strong>Available backups</strong><small>BACKUP STORAGE</small></div>
        ${state.backups.length ? state.backups.map((backup) => `
          <div class="file-row">
            <span class="server-name">${esc(backup.name)}<span class="subline">${esc(dateText(backup.createdAt))}</span></span>
            <span class="mono muted">${formatBytes(backup.size)}</span>
            <div class="file-actions"><button class="btn small" data-backup-download="${esc(backup.name)}">Download</button>${state.server?.canOperate ? `<button class="btn small danger" data-backup-restore="${esc(backup.name)}">Restore</button>` : ''}</div>
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
        const result = await api(`/servers/${state.serverId}/files?${new URLSearchParams({ path: state.filePath })}`);
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

  async function manageAccessModal() {
    const result = await api(`/servers/${state.serverId}/users`);
    const candidates = (result.users || []).filter((user) => user.id !== state.server?.owner_id && !user.disabled);
    const names = new Map((result.users || []).map((user) => [user.id, user.username]));
    const assigned = result.assignments || [];
    openModal('Server access', `
      <form class="form-stack" id="share-user-form" data-form="share-user">
        <label class="field-label">Panel user<select name="userId" required>${candidates.map((user) => `<option value="${esc(user.id)}">${esc(user.username)} · ${esc(user.role)}</option>`).join('')}</select></label>
        <label class="field-label">Permission<select name="permission"><option value="operator">Operator · can control and change files</option><option value="read">Read only · can view server data</option></select></label>
      </form>
      <div class="section-head"><div><h2>Assigned users</h2><p>Remove access at any time.</p></div></div>
      ${assigned.map((item) => `<div class="file-row"><span>${esc(names.get(item.user_id) || item.user_id)}</span><span class="mono muted">${esc(item.permission)}</span><div class="file-actions"><button class="btn small danger" data-share-remove="${esc(item.user_id)}">Remove</button></div></div>`).join('') || '<p class="help">No additional users have access to this server.</p>'}
    `, `<button class="btn" data-action="close-modal">Close</button><button class="btn primary" type="submit" form="share-user-form">Save access</button>`);
  }
  async function newServerModal() {
    if (!state.nodes.some((node) => node.online)) {
      toast(state.nodes.length ? 'No connected node is available. Test or reconnect a node before creating a server.' : 'Register and connect a node before creating a server.', true);
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
        <label class="field-label" style="display:flex;align-items:flex-start;gap:10px"><input name="eulaAccepted" type="checkbox" required style="width:auto;margin-top:2px"> I agree to the Minecraft End User License Agreement (EULA).</label>
        <p class="help">The agent pulls the allow-listed image from its registry, creates persistent server storage and starts the container. First boot may take several minutes. You must review and accept the EULA before provisioning Minecraft Java servers.</p>
      </form>`,
      '<button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" type="submit" form="new-server-form">Create and install</button>');
  }

  function newNodeModal() {
    openModal('Register a node', `
      <form class="form-stack" id="new-node-form" data-form="new-node">
        <label class="field-label">Node name<input name="name" required maxlength="64" placeholder="Main node"></label>
        <label class="field-label">Agent URL<input name="url" type="url" required placeholder="https://node1.example.com:8080"></label>
        <label class="field-label">Location<input name="location" maxlength="80" placeholder="Frankfurt, Germany"></label>
        <label class="field-label">Existing agent token (optional)<input name="token" maxlength="64" autocomplete="off" placeholder="Leave blank to generate a new token"></label>
        <p class="help">Generate a token in the panel for a separately installed node. For Docker Compose, supply the same 64-character NODE_TOKEN configured in the environment. The token is encrypted after registration.</p>
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
          eulaAccepted: form.querySelector('[name="eulaAccepted"]')?.checked === true,
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
        await refreshData();
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
        await api(`/servers/${state.serverId}/files`, {
          method: 'POST',
          body: { action: 'create', path: [state.filePath, values.name].filter(Boolean).join('/'), content: values.content || '' },
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

      if (type === 'rename-file') {
        await api(`/servers/${state.serverId}/files`, {
          method: 'POST',
          body: { action: 'rename', sourcePath: values.path, name: values.name },
        });
        closeModal();
        toast('File or folder renamed.');
        await loadFiles();
        return;
      }
      if (type === 'password-change') {
        if (values.newPassword !== values.confirmPassword) {
          toast('The new passwords do not match.', true);
          return;
        }
        const result = await api('/auth/password', {
          method: 'POST',
          body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
        });
        state.user = result.user;
        state.csrfToken = result.csrfToken;
        form.reset();
        toast('Password changed successfully.');
        return;
      }
      if (type === 'share-user') {
        await api(`/servers/${state.serverId}/users`, { method: 'POST', body: values });
        toast('Server access updated.');
        await manageAccessModal();
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
      if (action === 'clear-server-filters') {
        state.serverSearch = '';
        state.serverFilter = 'all';
        state.serverSort = 'updated';
        const search = document.querySelector('#server-search');
        const sort = document.querySelector('#server-sort');
        if (search) search.value = '';
        if (sort) sort.value = 'updated';
        syncServerInventory();
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
          '<label class="field-label">Folder name<input name="name" required maxlength="80" pattern="[a-zA-Z0-9_ ][a-zA-Z0-9_. -]{0,79}"><small class="help">Hidden names beginning with a dot are not allowed.</small></label>', 'Create folder');
        return;
      }
      if (action === 'new-file') {
        fileModal('Create text file', 'new-file-form', 'new-file',
          '<label class="field-label">File name<input name="name" required maxlength="100" pattern="[a-zA-Z0-9_ ][a-zA-Z0-9_. -]{0,99}"><small class="help">Hidden names beginning with a dot are not allowed.</small></label><label class="field-label">Initial contents<textarea class="field" name="content" spellcheck="false"></textarea></label>', 'Create file');
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
      if (action === 'manage-access') {
        await manageAccessModal();
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
    const serverFilterButton = event.target.closest('[data-server-filter]');
    if (serverFilterButton) {
      state.serverFilter = serverFilterButton.dataset.serverFilter;
      syncServerInventory();
      return;
    }

    const favoriteButton = event.target.closest('[data-server-favorite]');
    if (favoriteButton) {
      toggleServerFavorite(favoriteButton.dataset.serverFavorite);
      return;
    }

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

    const fileDownloadButton = event.target.closest('[data-file-download]');
    if (fileDownloadButton) {
      try {
        fileDownloadButton.disabled = true;
        await downloadFile(fileDownloadButton.dataset.fileDownload);
      } catch (error) {
        toast(error.message, true);
      } finally {
        fileDownloadButton.disabled = false;
      }
      return;
    }

    const fileRenameButton = event.target.closest('[data-file-rename]');
    if (fileRenameButton) {
      renameFileModal(fileRenameButton.dataset.fileRename);
      return;
    }
    const fileDeleteButton = event.target.closest('[data-file-delete]');
    if (fileDeleteButton) {
      confirmModal('Delete file or folder?', `This permanently deletes ${fileDeleteButton.dataset.fileDelete} from the server directory.`, 'delete-file', { path: fileDeleteButton.dataset.fileDelete });
      return;
    }

    const backupDownloadButton = event.target.closest('[data-backup-download]');
    if (backupDownloadButton) {
      try {
        backupDownloadButton.disabled = true;
        await downloadBackup(backupDownloadButton.dataset.backupDownload);
      } catch (error) {
        toast(error.message, true);
      } finally {
        backupDownloadButton.disabled = false;
      }
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

    const shareRemove = event.target.closest('[data-share-remove]');
    if (shareRemove) {
      try {
        await api(`/servers/${state.serverId}/users/${shareRemove.dataset.shareRemove}`, { method: 'DELETE' });
        toast('Server access removed.');
        await manageAccessModal();
      } catch (error) {
        toast(error.message, true);
      }
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
    if (actionButton) {
      if (actionButton.dataset.action === 'backdrop-close') {
        if (event.target === actionButton) closeModal();
        return;
      }
      await action(actionButton.dataset.action, actionButton);
    }
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
    if (file.name.startsWith('.')) {
      toast('Hidden files cannot be uploaded.', true);
      event.target.value = '';
      return;
    }
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
    if (event.target.id === 'server-sort') {
      state.serverSort = event.target.value;
      syncServerInventory();
    }
    handleUpload(event).catch((error) => toast(error.message, true));
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'server-search') {
      state.serverSearch = event.target.value;
      syncServerInventory();
    }
  });

  boot();
})();
