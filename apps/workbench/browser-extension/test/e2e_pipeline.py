"""Synthetic end-to-end check for the Edge extension and its agent protocol.

The extension is copied to a temp directory with SERVER_URL pointed at a fake
agent server on 127.0.0.1:4329. creator.douyin.com is fulfilled from local HTML
so no real account, network request or platform data is involved.

Flow covered: popup pairing -> long poll -> sync command -> home account
detection -> confirm command -> manage page work_list (fetch) -> next page
item_list (XHR) -> dedupe/limit -> complete event -> popup disconnect.
"""
import json
import os
import secrets
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

EXTENSION = Path(__file__).resolve().parents[1]
PORT = 4329
TASK_ID = 'e2e-task-1'
TEST_CODE = 'TEST-CODE'
LIMIT = 3

ACCOUNT = {
    "status_code": 0,
    "user": {"nickname": "测试账号", "unique_id": "test-uid", "uid": "123"},
}

PAGE_ONE = {
    "status_code": 0,
    "data": {
        "aweme_list": [
            {
                "aweme_id": "7411111111111111111",
                "desc": "第一条作品",
                "create_time": 1729000000,
                "statistics": {
                    "play_count": 1234, "digg_count": 56, "comment_count": 7,
                    "share_count": 8, "collect_count": 9,
                },
            },
            {
                "aweme_id": "7411111111111111112",
                "desc": "第二条作品",
                "create_time": 1729000100,
                "statistics": {
                    "play_count": 100, "digg_count": 10, "comment_count": 1,
                    "share_count": 2, "collect_count": 0,
                },
            },
        ],
        "has_more": True,
    },
}

PAGE_TWO = {
    "status_code": 0,
    "data": {
        "item_list": [
            {
                "aweme_id": "7411111111111111111",
                "desc": "第一条作品（重复）",
                "statistics": {
                    "play_count": 9999, "digg_count": 999, "comment_count": 9,
                    "share_count": 9, "collect_count": 9,
                },
            },
            {
                "aweme_id": "7411111111111111113",
                "desc": "第三条作品",
                "create_time": 1729000200,
                "statistics": {"play_count": 300, "digg_count": 30},
            },
        ],
        "has_more": False,
    },
}

HOME_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>创作者中心</title></head>
<body><header class="topbar"><span class="nickname">测试账号</span></header>
<main><h1>首页</h1></main>
<script>
setTimeout(() => {
  fetch('/aweme/v1/creator/user/info').then(r => r.json()).then(() => { window.__accountDone = true; }).catch(() => {});
}, 300);
</script></body></html>"""

MANAGE_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>内容管理</title></head>
<body><header class="topbar"><span class="nickname">测试账号</span></header>
<main>
  <div id="works"></div>
  <div class="ant-pagination-next" aria-disabled="false"><button id="next">下一页</button></div>
</main>
<script>
let page = 1;
function render(items) {
  const box = document.getElementById('works');
  for (const item of items || []) {
    const row = document.createElement('div');
    row.textContent = item.desc || item.aweme_id;
    box.appendChild(row);
  }
}
function loadPage(n) {
  if (n === 1) {
    fetch('/janus/douyin/creator/pc/work_list?page=1&count=2')
      .then(r => r.json()).then(data => { render(data.data.aweme_list); window.__pageOne = true; }).catch(() => {});
    return;
  }
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/aweme/v1/creator/item/list?page=' + n);
  xhr.responseType = 'json';
  xhr.onload = () => { render(xhr.response && xhr.response.data && xhr.response.data.item_list); window.__pageTwo = true; };
  xhr.send();
}
document.getElementById('next').addEventListener('click', () => {
  if (page >= 2) return;
  page += 1;
  loadPage(page);
  if (page >= 2) document.querySelector('.ant-pagination-next').setAttribute('aria-disabled', 'true');
});
setTimeout(() => loadPage(1), 350);
</script></body></html>"""


class FakeAgent:
    def __init__(self):
        self.lock = threading.Condition()
        self.token = 'wbc_' + secrets.token_urlsafe(24)
        self.origin = None
        self.commands = []
        self.command_kinds = []
        self.events = []
        self.polls = []
        self.pair_requests = []
        self.disconnect_calls = 0
        self.revoked = False
        self.confirm_queued = False

    def enqueue(self, kind):
        with self.lock:
            command = {
                'id': f'cmd-{kind}-{len(self.commands) + 1}',
                'kind': kind,
                'taskId': TASK_ID,
                'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                'protocol': 1,
            }
            if kind == 'sync':
                command['limit'] = LIMIT
            self.commands.append(command)
            self.command_kinds.append(kind)
            self.lock.notify_all()

    def take_command(self, wait_seconds):
        deadline = time.time() + wait_seconds
        with self.lock:
            while not self.commands and time.time() < deadline:
                self.lock.wait(timeout=1)
            return self.commands.pop(0) if self.commands else None


STATE = FakeAgent()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def cors(self):
        origin = self.headers.get('Origin', '')
        if origin.startswith('chrome-extension://'):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Max-Age', '600')
            if self.headers.get('Access-Control-Request-Private-Network') == 'true':
                self.send_header('Access-Control-Allow-Private-Network', 'true')

    def reply(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        return json.loads(raw.decode('utf-8')) if raw else {}

    def authorize(self):
        origin = self.headers.get('Origin') or ''
        auth = self.headers.get('Authorization') or ''
        if STATE.revoked or auth != f'Bearer {STATE.token}' or origin != STATE.origin:
            self.reply(401, {'error': 'unauthorized', 'code': 'UNAUTHORIZED'})
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path == '/api/browser/agent/pair':
                payload = self.body()
                origin = self.headers.get('Origin') or ''
                with STATE.lock:
                    STATE.pair_requests.append({'origin': origin, 'payload': payload})
                if payload.get('code') != TEST_CODE:
                    self.reply(400, {'error': '配对码无效', 'code': 'PAIR_CODE_INVALID'})
                    return
                if not origin.startswith('chrome-extension://'):
                    self.reply(403, {'error': 'origin', 'code': 'ORIGIN_REQUIRED'})
                    return
                STATE.origin = origin
                STATE.enqueue('sync')
                self.reply(200, {'token': STATE.token, 'protocol': 1})
                return
            if path == '/api/browser/agent/poll':
                if not self.authorize():
                    return
                payload = self.body()
                with STATE.lock:
                    STATE.polls.append(payload)
                command = STATE.take_command(20)
                self.reply(200, {
                    'command': command,
                    'account': None,
                    'lastSyncAt': None,
                    'protocol': 1,
                })
                return
            if path == '/api/browser/agent/event':
                if not self.authorize():
                    return
                payload = self.body()
                with STATE.lock:
                    STATE.events.append(payload)
                    if payload.get('type') == 'account' and not STATE.confirm_queued:
                        STATE.confirm_queued = True
                if payload.get('type') == 'account':
                    STATE.enqueue('confirm')
                self.reply(200, {'ok': True})
                return
            if path == '/api/browser/agent/disconnect':
                if not self.authorize():
                    return
                with STATE.lock:
                    STATE.disconnect_calls += 1
                    STATE.revoked = True
                self.reply(200, {'ok': True})
                return
            self.reply(404, {'error': 'not found'})
        except Exception as error:  # keep the harness diagnosable
            self.reply(500, {'error': str(error)})

    def do_GET(self):
        self.reply(404, {'error': 'not found'})


def start_server():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def prepare_extension(root):
    target = root / 'extension'
    shutil.copytree(
        EXTENSION, target,
        ignore=shutil.ignore_patterns('.probe', 'test', 'probe-server.mjs', '__pycache__'),
    )
    protocol = target / 'src' / 'lib' / 'protocol.js'
    text = protocol.read_text(encoding='utf-8')
    replaced = text.replace(
        "export const SERVER_URL = 'http://127.0.0.1:4317';",
        f"export const SERVER_URL = 'http://127.0.0.1:{PORT}';",
    )
    if replaced == text:
        raise RuntimeError('SERVER_URL was not patched')
    protocol.write_text(replaced, encoding='utf-8')
    return target


def extension_id_from_workers(context, pump, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for worker in context.service_workers:
            url = worker.url
            if url.startswith('chrome-extension://') and '/src/background.js' in url:
                return url.split('/')[2]
        pump.wait_for_timeout(200)
    return None


def extension_id_from_profile(profile, extension_dir):
    prefs = Path(profile) / 'Default' / 'Preferences'
    for _ in range(20):
        if prefs.exists():
            try:
                data = json.loads(prefs.read_text(encoding='utf-8'))
                settings = data.get('extensions', {}).get('settings', {})
                expected = os.path.normcase(os.path.abspath(extension_dir))
                for key, value in settings.items():
                    path = value.get('path')
                    if isinstance(path, str) and os.path.normcase(os.path.abspath(path)) == expected:
                        return key
            except Exception:
                pass
        time.sleep(0.25)
    return None


def creator_route(route, request):
    try:
        url = urlsplit(request.url)
        path = url.path
        if path.startswith('/janus/douyin/creator/pc/work_list'):
            route.fulfill(status=200, content_type='application/json; charset=utf-8', body=json.dumps(PAGE_ONE))
        elif path.startswith('/aweme/v1/creator/item/list'):
            route.fulfill(status=200, content_type='application/json; charset=utf-8', body=json.dumps(PAGE_TWO))
        elif path.startswith('/aweme/v1/creator/user/info'):
            route.fulfill(status=200, content_type='application/json; charset=utf-8', body=json.dumps(ACCOUNT))
        elif path.startswith('/creator-micro/content/manage'):
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=MANAGE_HTML)
        elif path.startswith('/creator-micro/home'):
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=HOME_HTML)
        else:
            route.fulfill(status=200, content_type='text/html; charset=utf-8', body=HOME_HTML)
    except Exception as error:
        print('route error:', error)
        try:
            route.fulfill(status=500, content_type='text/plain; charset=utf-8', body='route error')
        except Exception:
            pass


def pump_until(page, predicate, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        page.wait_for_timeout(250)
    print(f'timeout waiting for {label}')
    return False


def poll_revoked():
    data = json.dumps({'activeTaskId': None}).encode('utf-8')
    request = urllib.request.Request(
        f'http://127.0.0.1:{PORT}/api/browser/agent/poll',
        data=data,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {STATE.token}',
            'Origin': STATE.origin or 'chrome-extension://invalid',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main():
    server = start_server()
    failures = []
    report = {}
    screenshot_dir = EXTENSION / '.probe'
    screenshot_dir.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory(prefix='wb-e2e-') as root:
        root_path = Path(root)
        extension_dir = prepare_extension(root_path)
        profile = root_path / 'profile'
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    profile,
                    channel='chromium',
                    headless=True,
                    args=[
                        f'--disable-extensions-except={extension_dir}',
                        f'--load-extension={extension_dir}',
                    ],
                )
                try:
                    context.route('https://creator.douyin.com/**', creator_route)
                    pump = context.pages[0] if context.pages else context.new_page()
                    extension_id = extension_id_from_workers(context, pump)
                    if not extension_id:
                        extension_id = extension_id_from_profile(profile, extension_dir)
                    if not extension_id:
                        raise RuntimeError('extension id not found')
                    report['extensionId'] = extension_id

                    popup = context.new_page()
                    popup.goto(f'chrome-extension://{extension_id}/src/popup/popup.html', wait_until='domcontentloaded')
                    popup.wait_for_selector('#code', timeout=10_000)
                    report['popupTitle'] = popup.title()

                    popup.fill('#code', TEST_CODE)
                    popup.click('#pair')
                    if not pump_until(popup, lambda: bool(STATE.origin), 20, 'pair request'):
                        failures.append('pair request never reached the agent')
                    if not pump_until(
                        popup,
                        lambda: popup.evaluate("() => !document.getElementById('paired').hidden"),
                        20, 'popup paired state',
                    ):
                        failures.append('popup did not switch to paired state')

                    complete_seen = pump_until(
                        popup,
                        lambda: any(event.get('type') == 'complete' for event in STATE.events),
                        90, 'complete event',
                    )
                    if not complete_seen:
                        failures.append('sync did not complete')

                    events = list(STATE.events)
                    report['events'] = [event.get('type') for event in events]
                    report['commands'] = list(STATE.command_kinds)
                    report['polls'] = len(STATE.polls)
                    report['pairOrigin'] = STATE.origin
                    report['pair'] = STATE.pair_requests[0]['payload'] if STATE.pair_requests else None

                    complete = next((event for event in events if event.get('type') == 'complete'), None)
                    account = next((event for event in events if event.get('type') == 'account'), None)
                    errors = [event for event in events if event.get('type') == 'error']
                    works = complete.get('works') if complete else []
                    by_id = {work.get('aweme_id'): work for work in works}

                    checks = {
                        'pair origin': isinstance(STATE.origin, str) and STATE.origin.startswith('chrome-extension://'),
                        'pair payload protocol': (STATE.pair_requests[0]['payload'].get('protocol') == 1) if STATE.pair_requests else False,
                        'accepted event': 'accepted' in report['events'],
                        'account name': bool(account) and account.get('account', {}).get('name') == '测试账号',
                        'account id': bool(account) and account.get('account', {}).get('id') == 'test-uid',
                        'confirm command': 'confirm' in STATE.command_kinds,
                        'sync then confirm': STATE.command_kinds[:2] == ['sync', 'confirm'],
                        'poll carried task': any(poll.get('activeTaskId') == TASK_ID for poll in STATE.polls),
                        'three unique works': len(works) == 3 and len(by_id) == 3,
                        'first metrics': by_id.get('7411111111111111111', {}).get('statistics') == {
                            'play_count': 1234, 'digg_count': 56, 'comment_count': 7,
                            'share_count': 8, 'collect_count': 9,
                        },
                        'duplicate not overwritten': by_id.get('7411111111111111111', {}).get('statistics', {}).get('play_count') == 1234,
                        'genuine zero kept': by_id.get('7411111111111111112', {}).get('statistics', {}).get('collect_count') == 0,
                        'missing metrics omitted': set(by_id.get('7411111111111111113', {}).get('statistics', {})) == {'play_count', 'digg_count'},
                        'no error events': not errors,
                        'complete count': bool(complete) and complete.get('count') == 3 and complete.get('limit') == LIMIT,
                    }
                    report['checks'] = checks
                    failures.extend(name for name, ok in checks.items() if not ok)

                    if complete:
                        report['works'] = [
                            {'id': work.get('aweme_id'), 'stats': work.get('statistics')}
                            for work in works
                        ]

                    if not failures:
                        popup.click('#disconnect')
                        popup.wait_for_timeout(150)
                        popup.click('#disconnect')
                        if not pump_until(popup, lambda: STATE.disconnect_calls > 0, 15, 'disconnect request'):
                            failures.append('disconnect request never reached the agent')
                        else:
                            status = poll_revoked()
                            report['revokedPollStatus'] = status
                            if status != 401:
                                failures.append(f'revoked token poll returned {status}, expected 401')
                            paired_hidden = pump_until(
                                popup,
                                lambda: popup.evaluate("() => document.getElementById('paired').hidden"),
                                10, 'popup unpaired state',
                            )
                            if not paired_hidden:
                                failures.append('popup stayed paired after disconnect')
                except Exception as error:
                    failures.append(f'harness error: {error}')
                    for index, page in enumerate(context.pages):
                        try:
                            page.screenshot(path=str(screenshot_dir / f'e2e-failure-{index}.png'))
                        except Exception:
                            pass
                finally:
                    report['pages'] = [page.url for page in context.pages]
                    context.close()
        except Exception as error:
            failures.append(f'launch error: {error}')
    server.shutdown()
    server.server_close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    if failures:
        print('FAILURES:')
        for failure in failures:
            print(f'- {failure}')
        print('E2E_FAILED')
        return 1
    print('E2E_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
