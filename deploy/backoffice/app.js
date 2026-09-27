'use strict';

const ADMIN_KEY_STORAGE = 'waha-backoffice.admin-key';
const SERVER_STORAGE = 'waha-backoffice.server';
const DEFAULTS_STORAGE = 'waha-backoffice.defaults';
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const REFRESH_INTERVAL_MS = 20000;
const CLINIC_ACTIONS = {
  read: true,
  send: true,
  control: true,
  setting: true,
  app: false,
  delete: false,
};
const ACTION_LABELS = {
  read: 'ler',
  send: 'enviar',
  control: 'controlar',
  setting: 'configurar',
  app: 'apps',
  delete: 'apagar',
};
const STATUS_LABELS = {
  WORKING: { text: 'Ligado', tone: 'ok' },
  SCAN_QR_CODE: { text: 'A aguardar emparelhamento', tone: 'warn' },
  PASSKEY_REQUIRED: { text: 'A aguardar passkey', tone: 'warn' },
  PASSKEY_CONFIRMATION_REQUIRED: { text: 'A aguardar confirmação', tone: 'warn' },
  STARTING: { text: 'A iniciar', tone: 'info' },
  STOPPED: { text: 'Parado', tone: 'muted' },
  FAILED: { text: 'Erro', tone: 'error' },
};

const state = {
  adminKey: '',
  server: '',
  sessions: [],
  keys: [],
  revealed: new Set(),
  deleting: null,
  timer: null,
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function byId(id) {
  return document.getElementById(id);
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.entries(props || {}).forEach(function apply([name, value]) {
    if (value === undefined || value === null || value === false) {
      return;
    }
    if (name === 'text') {
      node.textContent = value;
    } else if (name === 'className') {
      node.className = value;
    } else if (name.startsWith('on')) {
      node.addEventListener(name.slice(2), value);
    } else {
      node.setAttribute(name, value === true ? '' : value);
    }
  });
  (children || []).forEach(function append(child) {
    if (child !== null && child !== undefined) {
      node.append(child);
    }
  });
  return node;
}

function isFileMode() {
  return window.location.protocol === 'file:';
}

function errorMessage(status, data) {
  const detail = data && typeof data === 'object' ? data.message : null;
  if (status === 401) {
    return 'Chave admin inválida.';
  }
  if (status === 403) {
    return 'Esta chave não tem permissões de administrador.';
  }
  if (status === 404) {
    return 'Não encontrado.';
  }
  if (detail) {
    return Array.isArray(detail) ? detail.join('; ') : String(detail);
  }
  return 'Erro ' + status + ' no servidor WAHA.';
}

async function api(method, path, body) {
  const headers = { Accept: 'application/json', 'X-Api-Key': state.adminKey };
  const init = { method: method, headers: headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(state.server + path, init);
  } catch (error) {
    throw new ApiError(0, 'Servidor WAHA inacessível.');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = text;
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(response.status, data));
  }
  return data;
}

function toast(message, tone) {
  const node = byId('toast');
  node.textContent = message;
  node.className = 'toast toast-' + (tone || 'info');
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function hide() {
    node.hidden = true;
  }, 5000);
}

function maskKey(key) {
  return '••••••••' + String(key).slice(-4);
}

function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(value);
  }
  const area = el('textarea', { readonly: true, className: 'offscreen' });
  area.value = value;
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

function copyButton(value, label) {
  return el('button', {
    type: 'button',
    className: 'btn btn-small',
    text: label || 'Copiar',
    onclick: function onCopy() {
      copyText(value).then(
        function copied() {
          toast('Copiado.', 'ok');
        },
        function failed() {
          toast('Não foi possível copiar. Selecione e copie manualmente.', 'error');
        },
      );
    },
  });
}

function statusBadge(status) {
  const info = STATUS_LABELS[status] || { text: status || '—', tone: 'muted' };
  return el('span', { className: 'badge badge-' + info.tone, text: info.text, title: status });
}

function phoneFromMe(me) {
  if (!me || !me.id) {
    return '—';
  }
  const number = String(me.id).split('@')[0];
  return me.pushName ? number + ' (' + me.pushName + ')' : number;
}

function keysForSession(name) {
  return state.keys.filter(function match(key) {
    return key.session === name;
  });
}

function loadDefaults() {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_STORAGE)) || {};
  } catch (error) {
    return {};
  }
}

function saveDefaults(defaults) {
  localStorage.setItem(DEFAULTS_STORAGE, JSON.stringify(defaults));
}

function renderSessions() {
  const body = byId('sessions-body');
  body.replaceChildren();
  if (state.sessions.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '6', className: 'empty', text: 'Ainda não existem clínicas.' })]));
    return;
  }
  state.sessions
    .slice()
    .sort(function byName(a, b) {
      return a.name.localeCompare(b.name);
    })
    .forEach(function row(session) {
      const keys = keysForSession(session.name);
      const active = keys.filter(function isActive(key) {
        return key.isActive;
      }).length;
      const metadata = (session.config && session.config.metadata) || {};
      body.append(
        el('tr', {}, [
          el('td', {}, [el('code', { text: session.name })]),
          el('td', { text: metadata.clinic || '—' }),
          el('td', {}, [statusBadge(session.status)]),
          el('td', { text: phoneFromMe(session.me) }),
          el('td', { text: active + ' / ' + keys.length }),
          el('td', { className: 'right actions' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-small',
              text: 'Nova chave',
              onclick: function onNewKey() {
                createKeyForSession(session.name);
              },
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-small btn-danger',
              text: 'Apagar',
              onclick: function onDelete() {
                openDeleteClinic(session.name);
              },
            }),
          ]),
        ]),
      );
    });
}

function renderKeys() {
  const body = byId('keys-body');
  body.replaceChildren();
  if (state.keys.length === 0) {
    body.append(el('tr', {}, [el('td', { colspan: '6', className: 'empty', text: 'Sem chaves criadas.' })]));
    return;
  }
  const sessionNames = new Set(
    state.sessions.map(function name(session) {
      return session.name;
    }),
  );
  state.keys
    .slice()
    .sort(function bySession(a, b) {
      return String(a.session).localeCompare(String(b.session));
    })
    .forEach(function row(key) {
      const revealed = state.revealed.has(key.id);
      const actions = Object.entries(key.actions || {})
        .filter(function enabled([, value]) {
          return value;
        })
        .map(function label([name]) {
          return ACTION_LABELS[name] || name;
        });
      const sessionCell = key.isAdmin
        ? el('td', { text: '— (todas)' })
        : el('td', {}, [
            el('code', { text: key.session }),
            sessionNames.has(key.session) ? null : el('span', { className: 'badge badge-error', text: 'sessão inexistente' }),
          ]);
      body.append(
        el('tr', { className: key.isActive ? '' : 'inactive' }, [
          sessionCell,
          el('td', {}, [el('span', { className: 'badge ' + (key.isAdmin ? 'badge-warn' : 'badge-info'), text: key.isAdmin ? 'Admin' : 'Clínica' })]),
          el('td', {}, [el('span', { className: 'badge ' + (key.isActive ? 'badge-ok' : 'badge-muted'), text: key.isActive ? 'Ativa' : 'Inativa' })]),
          el('td', { text: key.isAdmin ? 'todas' : actions.join(', ') || 'padrão' }),
          el('td', { className: 'key-cell' }, [
            el('code', { text: revealed ? key.key : maskKey(key.key) }),
            el('button', {
              type: 'button',
              className: 'btn btn-small btn-ghost',
              text: revealed ? 'Ocultar' : 'Mostrar',
              onclick: function onReveal() {
                if (revealed) {
                  state.revealed.delete(key.id);
                } else {
                  state.revealed.add(key.id);
                }
                renderKeys();
              },
            }),
            copyButton(key.key),
          ]),
          el('td', { className: 'right actions' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-small',
              text: key.isActive ? 'Desativar' : 'Ativar',
              onclick: function onToggle() {
                toggleKey(key);
              },
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-small btn-danger',
              text: 'Revogar',
              onclick: function onRevoke() {
                revokeKey(key);
              },
            }),
          ]),
        ]),
      );
    });
}

async function refresh(silent) {
  try {
    const results = await Promise.all([api('GET', '/api/sessions?all=true'), api('GET', '/api/keys')]);
    state.sessions = results[0] || [];
    state.keys = results[1] || [];
    renderSessions();
    renderKeys();
    byId('last-refresh').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-PT');
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      logout(error.message);
      return;
    }
    if (!silent) {
      toast(error.message, 'error');
    }
  }
}

function showCredentials(entries) {
  const list = byId('credentials-list');
  list.replaceChildren();
  entries.forEach(function row(entry) {
    const input = el('input', { type: 'text', readonly: true, value: entry.value });
    list.append(
      el('div', { className: 'credential' }, [
        el('span', { className: 'credential-label', text: entry.label }),
        el('div', { className: 'credential-value' }, [input, copyButton(entry.value)]),
      ]),
    );
  });
  byId('dlg-credentials').showModal();
}

function credentialsFor(session, key) {
  const defaults = loadDefaults();
  const entries = [
    { label: 'URL do WAHA (interno)', value: defaults.wahaUrl || 'http://waha:3000' },
    { label: 'Nome da sessão', value: session },
    { label: 'Chave de API da clínica', value: key.key },
  ];
  if (defaults.callback) {
    entries.push({ label: 'URL de callback (webhook, interno)', value: defaults.callback });
  }
  entries.push({ label: 'ID da chave (para revogar)', value: key.id });
  return entries;
}

async function createClinicKey(session) {
  return api('POST', '/api/keys', {
    isAdmin: false,
    isActive: true,
    session: session,
    actions: CLINIC_ACTIONS,
  });
}

async function createKeyForSession(session) {
  const active = keysForSession(session).filter(function isActive(key) {
    return key.isActive;
  });
  const question =
    active.length > 0
      ? 'Criar uma nova chave para "' + session + '"? A chave atual continua ativa até a revogar (use isto para rodar a chave).'
      : 'Criar uma chave para "' + session + '"?';
  if (!window.confirm(question)) {
    return;
  }
  try {
    const key = await createClinicKey(session);
    await refresh(true);
    showCredentials(credentialsFor(session, key));
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function onCreateClinic(event) {
  event.preventDefault();
  const session = byId('nc-session').value.trim();
  const clinic = byId('nc-clinic').value.trim();
  const wahaUrl = byId('nc-waha-url').value.trim();
  const callback = byId('nc-callback').value.trim();
  if (!SESSION_NAME_PATTERN.test(session)) {
    toast('Nome da sessão inválido (use letras, números, "-" ou "_").', 'error');
    return;
  }
  const exists = state.sessions.some(function same(item) {
    return item.name === session;
  });
  if (exists) {
    toast('Já existe uma sessão com esse nome.', 'error');
    return;
  }
  saveDefaults({ wahaUrl: wahaUrl, callback: callback });
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await api('POST', '/api/sessions', {
      name: session,
      start: false,
      config: { metadata: { app: 'osteogest', clinic: clinic || session } },
    });
    const key = await createClinicKey(session);
    byId('dlg-new-clinic').close();
    byId('new-clinic-form').reset();
    await refresh(true);
    showCredentials(credentialsFor(session, key));
  } catch (error) {
    toast(error.message, 'error');
    await refresh(true);
  } finally {
    submit.disabled = false;
  }
}

function openDeleteClinic(session) {
  state.deleting = session;
  byId('delete-clinic-name').textContent = session;
  byId('delete-clinic-confirm').value = '';
  byId('dlg-delete-clinic').showModal();
}

async function onDeleteClinic(event) {
  event.preventDefault();
  const session = state.deleting;
  if (byId('delete-clinic-confirm').value.trim() !== session) {
    toast('O nome não corresponde.', 'error');
    return;
  }
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await api('DELETE', '/api/sessions/' + encodeURIComponent(session));
    const failures = [];
    for (const key of keysForSession(session)) {
      try {
        await api('DELETE', '/api/keys/' + encodeURIComponent(key.id));
      } catch (error) {
        failures.push(key.id + ': ' + error.message);
      }
    }
    byId('dlg-delete-clinic').close();
    if (failures.length > 0) {
      toast('Clínica apagada, mas algumas chaves não foram revogadas: ' + failures.join('; '), 'error');
    } else {
      toast('Clínica "' + session + '" apagada.', 'ok');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    submit.disabled = false;
    state.deleting = null;
    await refresh(true);
  }
}

async function toggleKey(key) {
  try {
    await api('PUT', '/api/keys/' + encodeURIComponent(key.id), {
      isAdmin: key.isAdmin,
      session: key.session,
      isActive: !key.isActive,
      actions: key.actions,
    });
    toast(key.isActive ? 'Chave desativada.' : 'Chave ativada.', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
  await refresh(true);
}

async function revokeKey(key) {
  const target = key.isAdmin ? 'esta chave admin' : 'a chave da sessão "' + key.session + '"';
  if (!window.confirm('Revogar ' + target + '? O Osteogest que a usa deixa de conseguir enviar mensagens.')) {
    return;
  }
  try {
    await api('DELETE', '/api/keys/' + encodeURIComponent(key.id));
    state.revealed.delete(key.id);
    toast('Chave revogada.', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
  await refresh(true);
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.timer = setInterval(function tick() {
    if (document.visibilityState === 'visible') {
      refresh(true);
    }
  }, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function showApp() {
  byId('login-view').hidden = true;
  byId('app-view').hidden = false;
  byId('topbar-actions').hidden = false;
  byId('server-label').textContent = state.server || window.location.host;
  startAutoRefresh();
}

function logout(message) {
  stopAutoRefresh();
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  state.adminKey = '';
  state.sessions = [];
  state.keys = [];
  state.revealed.clear();
  byId('sessions-body').replaceChildren();
  byId('keys-body').replaceChildren();
  byId('app-view').hidden = true;
  byId('topbar-actions').hidden = true;
  byId('login-view').hidden = false;
  byId('login-key').value = '';
  if (message) {
    toast(message, 'error');
  }
}

async function login(adminKey) {
  state.adminKey = adminKey;
  await api('GET', '/api/keys');
  sessionStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
  showApp();
  await refresh(false);
}

async function onLogin(event) {
  event.preventDefault();
  if (isFileMode()) {
    const server = byId('login-server').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(server)) {
      toast('Indique o URL do servidor WAHA (http://...).', 'error');
      return;
    }
    state.server = server;
    localStorage.setItem(SERVER_STORAGE, server);
  }
  try {
    await login(byId('login-key').value.trim());
  } catch (error) {
    state.adminKey = '';
    toast(error.message, 'error');
  }
}

function bindDialogs() {
  document.querySelectorAll('dialog [data-close]').forEach(function bind(button) {
    button.addEventListener('click', function close() {
      button.closest('dialog').close();
    });
  });
}

function init() {
  bindDialogs();
  if (isFileMode()) {
    byId('server-field').hidden = false;
    byId('login-server').required = true;
    byId('login-server').value = localStorage.getItem(SERVER_STORAGE) || '';
    state.server = byId('login-server').value.replace(/\/+$/, '');
  }
  const defaults = loadDefaults();
  if (defaults.wahaUrl) {
    byId('nc-waha-url').value = defaults.wahaUrl;
  }
  if (defaults.callback !== undefined) {
    byId('nc-callback').value = defaults.callback;
  }
  byId('login-form').addEventListener('submit', onLogin);
  byId('new-clinic-form').addEventListener('submit', onCreateClinic);
  byId('delete-clinic-form').addEventListener('submit', onDeleteClinic);
  byId('btn-new-clinic').addEventListener('click', function open() {
    byId('dlg-new-clinic').showModal();
  });
  byId('btn-refresh').addEventListener('click', function onRefresh() {
    refresh(false);
  });
  byId('btn-logout').addEventListener('click', function onLogout() {
    logout();
  });
  const stored = sessionStorage.getItem(ADMIN_KEY_STORAGE);
  if (stored) {
    login(stored).catch(function failed(error) {
      logout(error.message);
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
