import argparse
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from main import (
    CollectorError, MARKER, ResponseState, SessionDirectory, account_from_payload,
    check_cancel, merge_works, normalize_trends, normalize_work, numeric,
    run_sync, safe_absolute, timestamp, video_candidates,
)


AT = "2026-10-22T01:00:00Z"


class NormalizationTests(unittest.TestCase):
    def test_missing_metrics_stay_null_and_genuine_zero_survives(self):
        work = normalize_work({"aweme_id": "123", "desc": "真实作品", "statistics": {"play_count": 0, "digg_count": "15"}}, AT)
        self.assertEqual(work["metrics"], {"plays": 0, "likes": 15, "comments": None, "shares": None, "collects": None})
        self.assertEqual(work["publishedAt"], "")

    def test_upstream_zero_defaults_are_not_used_as_metrics(self):
        def upstream(raw):
            return {"aweme_id": "999", "desc": raw["desc"], "create_time": 1700000000, "play_count": 0}
        work = normalize_work({"desc": "上游元数据"}, AT, upstream)
        self.assertEqual(work["id"], "999")
        self.assertIsNone(work["metrics"]["plays"])
        self.assertEqual(work["publishedAt"], "2023-11-14T22:13:20Z")

    def test_nested_payload_wrappers_and_invalid_ids(self):
        payload = {"data": {"data": {"item_list": [{"aweme_info": {"aweme_id": "456", "title": "标题"}}, {}, "bad"]}}}
        values = video_candidates(payload)
        self.assertEqual(len(values), 2)
        self.assertEqual(normalize_work(values[0], AT)["id"], "456")
        self.assertIsNone(normalize_work(values[1], AT))
        self.assertIsNone(normalize_work({"id": "not-a-video"}, AT))
        self.assertEqual(video_candidates({"message": "ok", "data": None}), [])

    def test_merge_deduplicates_and_fills_null_without_erasing_counts(self):
        first = normalize_work({"aweme_id": "123", "statistics": {"play_count": 7}}, AT)
        next_record = normalize_work({"aweme_id": "123", "statistics": {"digg_count": 0}}, AT)
        second = normalize_work({"aweme_id": "456"}, AT)
        merged = merge_works([first], [next_record, second], 10)
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["metrics"]["plays"], 7)
        self.assertEqual(merged[0]["metrics"]["likes"], 0)
        self.assertEqual(len(merge_works([], [first, second], 1)), 1)

    def test_invalid_and_approximate_numeric_values_are_unknown(self):
        for value in (True, "1.2万", "", -1, float("nan"), float("inf"), {}, None):
            self.assertIsNone(numeric(value))
        self.assertEqual(numeric("0"), 0)
        self.assertEqual(numeric("10.5"), 10.5)
        self.assertEqual(timestamp(1700000000000), "2023-11-14T22:13:20Z")
        self.assertEqual(timestamp("2026-10-22T09:00:00+08:00"), "2026-10-22T01:00:00Z")
        self.assertEqual(timestamp("2026-10-22T09:00:00"), "")

    def test_account_requires_an_explicit_name(self):
        self.assertEqual(account_from_payload({"data": {"user_info": {"nickname": "创作者", "uid": 123}}}), {"name": "创作者", "id": "123"})
        self.assertIsNone(account_from_payload({"title": "不能当作账号", "uid": "123"}))

    def test_trend_heat_is_not_fabricated(self):
        trends = normalize_trends({"data": {"word_list": [{"word": "AI 编程", "hot_value": 12345}, {"word": "AI 编程"}, {"word": "另一条"}]}}, AT)
        self.assertEqual(len(trends), 2)
        self.assertEqual(trends[0]["heat"], 12345)
        self.assertIsNone(trends[1]["heat"])
        self.assertEqual(trends[1]["rank"], 3)
        self.assertIn("%20", trends[0]["url"])
        self.assertEqual(normalize_trends({"data": None}, AT), [])
        pinned = normalize_trends({"data": {"word_list": [{"word": "置顶", "position": 0, "hot_value": 0}]}}, AT)
        self.assertEqual(pinned[0]["rank"], 0)
        self.assertEqual(pinned[0]["heat"], 0)


class DirectoryTests(unittest.TestCase):
    def test_refuses_relative_existing_user_data_and_root(self):
        with self.assertRaises(CollectorError):
            safe_absolute("relative/path", "test")
        with self.assertRaises(CollectorError):
            SessionDirectory(Path(Path.cwd().anchor)).create()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "session"
            root.mkdir()
            existing = root / "valuable.txt"
            existing.write_text("preserve", encoding="utf-8")
            with self.assertRaises(CollectorError):
                SessionDirectory(root).create()
            self.assertEqual(existing.read_text(encoding="utf-8"), "preserve")

    def test_cleanup_removes_only_own_profile_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            session = SessionDirectory(Path(folder) / "session")
            session.create()
            (session.profile / "cookie.db").write_text("test", encoding="utf-8")
            result = session.path / "result.json"
            result.write_text("{}", encoding="utf-8")
            self.assertTrue(session.cleanup())
            self.assertFalse(session.profile.exists())
            self.assertTrue(session.cleanup())
            self.assertTrue(result.exists())
            marker = json.loads((session.path / MARKER).read_text(encoding="utf-8"))
            self.assertTrue(marker["profileRemoved"])

    def test_cleanup_refuses_changed_marker(self):
        with tempfile.TemporaryDirectory() as folder:
            session = SessionDirectory(Path(folder) / "session")
            session.create()
            (session.path / MARKER).write_text('{"token":"other-owner"}', encoding="utf-8")
            with self.assertRaises(CollectorError):
                session.cleanup()
            self.assertTrue(session.profile.exists())

    def test_missing_or_corrupt_marker_never_counts_as_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            session = SessionDirectory(Path(folder) / "session")
            session.create()
            marker = session.path / MARKER
            marker.unlink()
            with self.assertRaises(CollectorError):
                session.cleanup()
            self.assertTrue(session.profile.exists())
            marker.write_text("not-json", encoding="utf-8")
            with self.assertRaises(CollectorError):
                session.cleanup()
            self.assertTrue(session.profile.exists())

    def test_cancel_file(self):
        with tempfile.TemporaryDirectory() as folder:
            flag = Path(folder) / "cancel"
            check_cancel(flag)
            flag.touch()
            with self.assertRaises(CollectorError) as caught:
                check_cancel(flag)
            self.assertEqual(caught.exception.code, "CANCELLED")


class FakeResponse:
    def __init__(self, payload=None, *, status=200, path="/janus/douyin/creator/pc/work_list", host="creator.douyin.com", invalid=False):
        self.url = "https://" + host + path
        self.status, self.payload, self.invalid = status, payload, invalid

    async def json(self):
        if self.invalid:
            raise ValueError("invalid body")
        return self.payload


class ResponseTests(unittest.IsolatedAsyncioTestCase):
    def state(self):
        return ResponseState(10, lambda raw: {"aweme_id": raw.get("aweme_id"), "desc": raw.get("desc"), "create_time": raw.get("create_time")})

    async def test_passive_response_returns_real_works_and_account(self):
        state = self.state()
        response = FakeResponse({"status_code": 0, "data": {"has_more": False, "item_list": [{"aweme_id": "123", "author": {"nickname": "本人"}, "statistics": {"play_count": 45}}]}})
        await state.observe(response)
        self.assertEqual(len(state.works), 1)
        self.assertFalse(state.more)
        self.assertEqual(state.account, {"name": "本人"})

    async def test_200_empty_body_and_api_failure_are_not_success(self):
        state = self.state()
        await state.observe(FakeResponse(invalid=True))
        await state.observe(FakeResponse({"status_code": 8}))
        await state.observe(FakeResponse({}, status=403))
        self.assertEqual(state.works, [])
        self.assertEqual(state.responses, 0)
        self.assertEqual(len(state.errors), 3)

    async def test_unknown_hosts_are_ignored(self):
        state = self.state()
        await state.observe(FakeResponse({"aweme_list": [{"aweme_id": "123"}]}, host="attacker.example"))
        self.assertEqual(state.responses, 0)


class WorkerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def execute(self, root: Path, *, login=True, confirm=True, cancel=False, metrics=True, shutdown_failure=False):
        class Locator:
            async def is_visible(self, **kwargs):
                return False

        class Page:
            url = "https://creator.douyin.com/creator-micro/home"
            callback = None

            def on(self, name, callback):
                self.callback = callback

            async def goto(self, url, **kwargs):
                self.url = url
                if "/content/manage" in url:
                    self.callback(FakeResponse({"data": {"has_more": False, "item_list": [{"aweme_id": "123", "desc": "test-only fixture", "author": {"nickname": "fixture"}, "statistics": {"play_count": 2} if metrics else {}}]}}))
                    await asyncio.sleep(0)

            def locator(self, selector):
                return SimpleNamespace(first=Locator())

        page = Page()

        class Context:
            pages = [page]
            closed = False

            @property
            def browser(self):
                return SimpleNamespace(is_connected=lambda: not self.closed)

            async def cookies(self, url):
                return [{"name": "sessionid", "value": "fixture-only"}] if login else []

            async def close(self):
                if shutdown_failure:
                    raise RuntimeError("test-only context close failure")
                self.closed = True

        context = Context()

        class PW:
            stopped = False

            def __init__(self):
                self.chromium = self

            async def launch_persistent_context(self, path, **kwargs):
                (Path(path) / "Cookies").write_text("fixture-only", encoding="utf-8")
                (root / "login.png").write_bytes(b"fixture-only")
                (root / "login.pending.png").write_bytes(b"fixture-only")
                return context

            async def start(self):
                return self

            async def stop(self):
                self.stopped = True
                if shutdown_failure:
                    raise RuntimeError("test-only driver stop failure")

        pw = PW()
        args = argparse.Namespace(session_dir=str(root / "session"), output=str(root / "result.json"), view=str(root / "login.png"), confirm=str(root / "confirm.json"), cancel=str(root / "cancel"), limit=5, visible=False, login_timeout=1 if login else 0, confirm_timeout=1 if confirm else 0, max_pages=1)

        def event(kind, message, **fields):
            if kind == "account":
                if cancel:
                    (root / "cancel").touch()
                elif confirm:
                    (root / "confirm.json").write_text('{"confirmed":true}', encoding="utf-8")

        async def short_pause(seconds, flag):
            check_cancel(flag)
            await asyncio.sleep(0)

        normalizer = lambda raw: {"aweme_id": raw.get("aweme_id"), "desc": raw.get("desc"), "create_time": raw.get("create_time")}
        with patch("playwright.async_api.async_playwright", return_value=pw), patch("main.load_upstream_normalizer", return_value=normalizer), patch("main.emit", side_effect=event), patch("main.pause", side_effect=short_pause):
            try:
                await run_sync(args)
                return_code = None
            except CollectorError as exc:
                return_code = exc.code
        self.assertEqual(context.closed, not shutdown_failure)
        self.assertTrue(pw.stopped)
        self.assertFalse((root / "session" / "profile").exists())
        self.assertFalse((root / "login.png").exists())
        self.assertFalse((root / "login.pending.png").exists())
        self.assertFalse((root / "confirm.json").exists())
        return return_code

    async def test_login_timeout_cleans_profile_without_success_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(await self.execute(root, login=False), "LOGIN_TIMEOUT")
            self.assertFalse((root / "result.json").exists())

    async def test_cancel_at_confirmation_cleans_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(await self.execute(root, cancel=True), "CANCELLED")
            self.assertFalse((root / "result.json").exists())

    async def test_success_only_writes_output_after_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertIsNone(await self.execute(root))
            result = json.loads((root / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["metricsAvailable"], 1)
            self.assertTrue(result["cleanup"]["profileRemoved"])
            self.assertEqual(result["works"][0]["metrics"]["plays"], 2)

    async def test_metadata_without_metrics_does_not_report_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(await self.execute(root, metrics=False), "NO_METRICS")
            self.assertFalse((root / "result.json").exists())

    async def test_unverified_browser_shutdown_still_removes_files_and_never_succeeds(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(await self.execute(root, shutdown_failure=True), "CLEANUP_FAILED")
            self.assertFalse((root / "result.json").exists())


if __name__ == "__main__":
    unittest.main()
