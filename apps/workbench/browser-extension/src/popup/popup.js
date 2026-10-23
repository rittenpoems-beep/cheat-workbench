const $ = (id) => document.getElementById(id);

const send = (message) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: '扩展后台没有响应，请重新打开扩展。' });
        return;
      }
      resolve(response || { ok: false, error: '扩展后台没有返回结果。' });
    });
  } catch {
    resolve({ ok: false, error: '扩展上下文已失效，请刷新页面。' });
  }
});

let paired = false;
let pairPending = false;
let disconnectArmed = false;
let disconnectTimer = null;

function formatTime(value) {
  if (!value) return '尚未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function stateText(status) {
  if (!status.paired) return status.code === 'PAIR_EXPIRED' ? '配对已失效，请重新配对' : '尚未连接工作台';
  if (!status.connected) return '工作台未响应，正在重试…';
  if (status.phase === 'login') return '等待在创作者中心登录';
  if (status.phase === 'account') return '等待确认抖音账号';
  if (status.phase === 'opening') return '正在打开创作者中心';
  if (status.phase === 'capturing') return `正在读取作品 ${status.count}/${status.limit}`;
  if (status.phase === 'paging') return `已读取 ${status.count} 条作品`;
  if (status.phase === 'error') return '上次同步没有完成';
  if (status.phase === 'cancelled') return '上次同步已取消';
  if (status.phase === 'done') return `已同步 ${status.count} 条作品`;
  return status.account ? `已连接：${status.account.name}` : '已连接工作台';
}

function render(status) {
  paired = Boolean(status.paired);
  $('state').textContent = stateText(status);
  $('server').textContent = status.server || '127.0.0.1:4317';
  $('account').textContent = status.account
    ? (status.account.id ? `${status.account.name}（${status.account.id}）` : status.account.name)
    : '尚未识别';
  $('last-sync').textContent = formatTime(status.lastSyncAt);
  $('version').textContent = status.version ? `${status.version} · 协议 ${status.protocol}` : '-';

  const dot = $('dot');
  dot.className = 'dot';
  if (status.paired && status.connected && !['error', 'cancelled'].includes(status.phase)) dot.classList.add('ok');
  else if (status.paired && status.connected) dot.classList.add('warn');
  else if (status.error) dot.classList.add('bad');
  else if (status.paired) dot.classList.add('warn');

  $('unpaired').hidden = paired;
  $('paired').hidden = !paired;

  const error = String(status.error || '');
  const showError = error && !paired
    ? true
    : error && status.code && !['PAIR_EXPIRED'].includes(status.code) && status.phase === 'error';
  $('error').hidden = !showError;
  $('error').textContent = showError ? error : '';
}

async function refresh() {
  const status = await send({ type: 'wb:status' });
  if (status && typeof status === 'object' && 'paired' in status) render(status);
  else if (status && status.error) {
    $('state').textContent = status.error;
    $('dot').className = 'dot bad';
  }
}

function normalizeCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

$('code').addEventListener('input', (event) => {
  const input = event.target;
  const position = input.selectionStart === input.value.length;
  input.value = normalizeCode(input.value);
  if (position) input.setSelectionRange(input.value.length, input.value.length);
});

$('code').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void pair();
});

async function pair() {
  if (pairPending) return;
  const code = normalizeCode($('code').value);
  if (code.replace('-', '').length !== 8) {
    $('error').hidden = false;
    $('error').textContent = '请输入 8 位配对码，例如 ABCD-EFGH。';
    return;
  }
  pairPending = true;
  $('pair').disabled = true;
  $('pair').textContent = '正在连接…';
  $('error').hidden = true;
  const result = await send({ type: 'wb:pair', code });
  pairPending = false;
  $('pair').disabled = false;
  $('pair').textContent = '连接工作台';
  if (result && result.ok) {
    $('code').value = '';
    $('pairing').hidden = false;
    $('pairing').textContent = '配对成功，已开始连接。回到工作台即可同步作品。';
    await refresh();
  } else {
    $('error').hidden = false;
    $('error').textContent = (result && result.error) || '配对失败，请重新生成配对码。';
  }
}

$('pair').addEventListener('click', () => void pair());

$('retry').addEventListener('click', async () => {
  $('retry').disabled = true;
  const result = await send({ type: 'wb:retry' });
  $('retry').disabled = false;
  if (result && result.ok) {
    $('pairing').hidden = false;
    $('pairing').textContent = '正在重新连接工作台…';
    await refresh();
  }
});

$('disconnect').addEventListener('click', async () => {
  if (!disconnectArmed) {
    disconnectArmed = true;
    $('disconnect').textContent = '再点一次断开';
    clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      disconnectArmed = false;
      $('disconnect').textContent = '断开连接';
    }, 4000);
    return;
  }
  clearTimeout(disconnectTimer);
  disconnectArmed = false;
  $('disconnect').disabled = true;
  $('disconnect').textContent = '正在断开…';
  const result = await send({ type: 'wb:disconnect' });
  $('disconnect').disabled = false;
  $('disconnect').textContent = '断开连接';
  if (result && result.ok) {
    $('pairing').hidden = false;
    $('pairing').textContent = '已断开。下次使用时重新生成配对码即可。';
    await refresh();
  } else {
    $('error').hidden = false;
    $('error').textContent = (result && result.error) || '断开失败，请重试。';
  }
});

void refresh();
setInterval(() => { void refresh(); }, 1000);
