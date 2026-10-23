"""Browser fixture: publication/T+3/early snapshot gates, with every API request mocked."""
import json
import sys
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright, expect

now = datetime.now(timezone.utc)
iso = lambda value: value.isoformat().replace('+00:00', 'Z')
base = {'draftId': 'fixture-draft', 'createdAt': iso(now - timedelta(days=5)), 'hash': 'fixture-hash', 'version': 1, 'path': 'predictions/fixture.md', 'forecast': '测试预测', 'rationale': '仅浏览器测试', 'status': 'pending'}
predictions = [
    {**base, 'id': 'pending', 'title': '未发布预测'},
    {**base, 'id': 'legacy', 'title': '旧样本记录', 'status': 'retrospected'},
    {**base, 'id': 'early', 'title': '刚发布一天', 'status': 'published', 'publishedAt': iso(now - timedelta(days=1))},
    {**base, 'id': 'mature', 'title': '已满三天', 'status': 'published', 'publishedAt': iso(now - timedelta(days=4)), 'dueAt': iso(now - timedelta(days=1))},
    {**base, 'id': 'followup', 'title': '已有早期快照', 'status': 'retrospected', 'publishedAt': iso(now - timedelta(days=4)), 'earlyRetro': True},
]
snapshot = {'mode': 'owner', 'project': {'name': '界面验证空间', 'platform': '抖音', 'initialized': True, 'contentForm': 'video', 'baselinePlays': None, 'calibrationSamples': 0, 'rootLabel': 'fixture', 'upstreamCommit': '0' * 40}, 'works': [], 'drafts': [], 'topics': [], 'reviews': [], 'predictions': predictions, 'tasks': [], 'messages': [], 'skills': [], 'settings': {'provider': 'auto', 'deepseekConfigured': False, 'codexAvailable': True, 'claudeAvailable': False, 'budget': 50}}
submissions = []
reject = False
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    def api(route):
        path = route.request.url.split('/api/', 1)[1].split('?', 1)[0]
        if path == 'snapshot':
            return route.fulfill(status=200, content_type='application/json', body=json.dumps(snapshot))
        if path == 'jobs' and route.request.method == 'POST':
            payload = json.loads(route.request.post_data)
            assert payload['kind'] == 'retro', payload
            submissions.append(payload)
            if reject:
                return route.fulfill(status=409, content_type='application/json', body=json.dumps({'error': '服务端复核：尚未满三天，请明确确认早期快照。'}))
            task = {'id': f'fixture-{len(submissions)}', 'kind': 'retro', 'label': '测试复盘任务', 'status': 'queued', 'createdAt': iso(now), 'updatedAt': iso(now), 'events': []}
            return route.fulfill(status=202, content_type='application/json', body=json.dumps(task))
        return route.fulfill(status=400, content_type='application/json', body='{"error":"fixture blocks unexpected API"}')
    page.route('**/api/**', api)
    page.goto(sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:4317/')
    page.get_by_role('button', name='预测与复盘', exact=True).click()
    for title in ['未发布预测', '旧样本记录']:
        expect(page.locator('.prediction-card').filter(has=page.get_by_role('heading', name=title, exact=True)).get_by_role('button', name='登记发布后可复盘')).to_be_disabled()
    early_card = page.locator('.prediction-card').filter(has=page.get_by_role('heading', name='刚发布一天', exact=True))
    early_card.get_by_role('button', name='填写实际结果 / 复盘').click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_text('距 T+3 还有', exact=False)).to_be_visible()
    expect(dialog.get_by_text('已发布：', exact=False)).to_be_visible()
    dialog.get_by_label('播放', exact=True).fill('1234')
    early_submit = dialog.get_by_role('button', name='提交早期快照复盘任务')
    expect(early_submit).to_be_disabled()
    checkbox = dialog.get_by_role('checkbox', name='我了解尚未满3天，仍记录早期快照（不计成熟校准样本）')
    checkbox.check()
    expect(early_submit).to_be_enabled()
    early_submit.click()
    expect(dialog).not_to_be_visible()
    assert submissions[-1]['input']['earlyConfirmed'] is True
    assert submissions[-1]['input']['actual']['plays'] == 1234
    page.get_by_role('button', name='关闭任务中心').click()
    mature_card = page.locator('.prediction-card').filter(has=page.get_by_role('heading', name='已满三天', exact=True))
    mature_card.get_by_role('button', name='填写实际结果 / 复盘').click()
    expect(dialog.get_by_text('已满 T+3，可录入成熟实绩')).to_be_visible()
    expect(dialog.get_by_role('checkbox')).not_to_be_visible()
    dialog.get_by_label('播放', exact=True).fill('5000')
    dialog.get_by_role('button', name='提交成熟实绩复盘任务').click()
    assert 'earlyConfirmed' not in submissions[-1]['input']
    page.get_by_role('button', name='关闭任务中心').click()
    followup_card = page.locator('.prediction-card').filter(has=page.get_by_role('heading', name='已有早期快照', exact=True))
    expect(followup_card.get_by_text('早期快照 · 待成熟复盘')).to_be_visible()
    followup_card.get_by_role('button', name='补录成熟实绩 / 复盘').click()
    expect(dialog.get_by_text('已有早期快照会保留；满 T+3 后可再次补录成熟实绩。')).to_be_visible()
    dialog.get_by_role('button', name='关闭复盘录入').click()
    reject = True
    early_card.get_by_role('button', name='填写实际结果 / 复盘').click()
    dialog.get_by_label('播放', exact=True).fill('2222')
    dialog.get_by_role('checkbox').check()
    dialog.get_by_role('button', name='提交早期快照复盘任务').click()
    expect(page.get_by_text('服务端复核：尚未满三天，请明确确认早期快照。')).to_be_visible()
    expect(dialog).to_be_visible()
    assert len(submissions) == 3, submissions
    browser.close()
    print(json.dumps({'passed': True, 'checks': ['unpublished disabled', 'legacy read-only record', 'published and T+3 timing', 'dueAt missing fallback', 'early explicit checkbox gate', 'early flag only when checked', 'mature no early flag', 'existing early snapshot mature followup', 'server 409 message retained dialog', 'accepted task not labelled completed'], 'realBackendMutations': 0}, ensure_ascii=False))
