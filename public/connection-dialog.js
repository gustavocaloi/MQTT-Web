import { validFilter } from './topic-filter.js';

export function initializeConnectionDialog({ onApplied, onError }) {
  const $ = id => document.getElementById(id);
  const dialog = $('connectionDialog');
  const form = $('connectionForm');
  let current = null;
  let removePassword = false;
  let loading = false;
  let saving = false;

  function error(message = '') {
    $('connectionError').textContent = message;
    $('connectionError').hidden = !message;
  }
  function passwordHint() {
    const sameAccount = current && $('connectionUrl').value.trim() === current.url && $('connectionUsername').value === current.username;
    $('connectionPassword').placeholder = !removePassword && sameAccount && current.hasPassword ? 'Manter senha atual' : '';
  }
  async function open(automatic = false) {
    if (loading) return;
    loading = true;
    $('connectionButton').disabled = true;
    try {
      const response = await fetch('/api/connection', { cache: 'no-store' });
      if (!response.ok) throw new Error('Nao foi possivel carregar a conexao.');
      current = await response.json();
      form.reset();
      removePassword = false;
      $('connectionUrl').value = current.url;
      $('connectionUsername').value = current.username;
      $('connectionRootFilter').value = current.rootFilter;
      $('connectionQos').value = current.qos;
      passwordHint();
      error();
      if (!automatic || !current.configured) dialog.showModal();
    } catch (failure) { onError(failure.message); }
    finally { loading = false; $('connectionButton').disabled = false; }
  }
  function close() { if (!saving) dialog.close(); }
  $('connectionButton').onclick = () => open();
  $('closeConnection').onclick = close;
  $('cancelConnection').onclick = close;
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { $('connectionPassword').value = ''; });
  $('connectionUrl').addEventListener('input', passwordHint);
  $('connectionUsername').addEventListener('input', passwordHint);
  $('clearConnectionPassword').onclick = () => {
    removePassword = true;
    $('connectionPassword').value = '';
    passwordHint();
    $('connectionPassword').focus();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (saving) return;
    error();
    const data = { url: $('connectionUrl').value.trim(), username: $('connectionUsername').value,
      rootFilter: $('connectionRootFilter').value, qos: Number($('connectionQos').value) };
    if (!validFilter(data.rootFilter)) { error('Filtro raiz MQTT invalido.'); return; }
    if ($('connectionPassword').value || removePassword) data.password = $('connectionPassword').value;
    saving = true;
    for (const control of form.elements) control.disabled = true;
    $('saveConnection').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Nao foi possivel aplicar a conexao.');
      current = result;
      dialog.close();
      onApplied();
    } catch (failure) { error(failure.message); }
    finally {
      saving = false;
      for (const control of form.elements) control.disabled = false;
      $('saveConnection').removeAttribute('aria-busy');
    }
  };
  open(true);
}
