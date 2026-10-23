import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/lib/extract.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL, console });
vm.runInContext(source, context, { filename: 'extract.js' });
const X = context.WorkbenchExtract;
const plain = (value) => JSON.parse(JSON.stringify(value));

const WORK_PATH = '/janus/douyin/creator/pc/work_list';
const options = { workishPath: true, acceptUnknown: true };

test('extracts a flat work list with canonical metrics, zeros and missing values', () => {
  const result = X.worksFromPayload({
    aweme_list: [
      {
        aweme_id: '7300000000000000001',
        desc: '第一条作品',
        create_time: 1710000000,
        statistics: { play_count: '1200', digg_count: 0, comment_count: '3', share_count: null },
      },
      { aweme_id: '7300000000000000002', title: '只有标题', create_time: '2024-03-09T08:00:00+08:00' },
    ],
  }, options);
  assert.equal(result.items.length, 2);
  assert.deepEqual(plain(result.items[0].statistics), { play_count: 1200, digg_count: 0, comment_count: 3 });
  assert.equal(result.items[0].create_time, 1710000000);
  assert.equal(result.items[1].desc, '只有标题');
  assert.equal(result.items[1].create_time, '2024-03-09T08:00:00+08:00');
  assert.deepEqual(plain(result.items[1].statistics), {});
  assert.equal(result.empty, false);
});

test('finds nested arrays, unwraps item wrappers and deduplicates ids', () => {
  const result = X.worksFromPayload({
    data: {
      item_list: [
        { aweme_info: { aweme_id: '7300000000000000003', desc: '包装', statistics: { like_count: 9 } } },
        { aweme_id: '7300000000000000003', desc: '重复', statistics: { digg_count: 12 } },
        { item_id: 7300000004, desc: '数字 ID', stats: { comment_cnt: 4 } },
      ],
    },
  }, options);
  assert.deepEqual(plain(result.items.map(item => item.aweme_id)), ['7300000000000000003', '7300000004']);
  assert.equal(result.items[0].statistics.digg_count, 9);
  assert.equal(result.items[0].desc, '包装');
  assert.equal(result.items[1].statistics.comment_count, 4);
  assert.deepEqual(plain(result.arrays), [{ path: 'data.item_list', count: 3 }]);
});

test('a work-like array under a changed endpoint is accepted tolerantly', () => {
  const result = X.worksFromPayload({
    data: {
      result: [
        { aweme_id: '7300000000000000005', desc: '改版接口', statistics: { play_count: 7 } },
        { aweme_id: '7300000000000000006', desc: '改版接口 2', statistics: { play_count: 8 } },
      ],
    },
  }, { workishPath: false, acceptUnknown: true });
  assert.equal(result.items.length, 2);
  assert.equal(result.tolerant, true);
});

test('unrelated lists are not imported as works', () => {
  const result = X.worksFromPayload({
    data: {
      music: [
        { id: 1, title: '配乐 A' },
        { id: 2, title: '配乐 B' },
      ],
    },
  }, { workishPath: false, acceptUnknown: true });
  assert.equal(result.items.length, 0);
});

test('invalid ids are dropped and descriptions are bounded', () => {
  const result = X.worksFromPayload({
    aweme_list: [
      { aweme_id: 'abc', desc: '不是数字' },
      { aweme_id: '7300000000000000007', desc: 'x'.repeat(900) },
    ],
  }, options);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].desc.length, 500);
});

test('an empty work array is reported explicitly', () => {
  const result = X.worksFromPayload({ aweme_list: [] }, options);
  assert.deepEqual(plain(result.items), []);
  assert.equal(result.empty, true);
});

test('account payloads expose only name and stable id', () => {
  const account = X.accountFromPayload({
    data: {
      user_info: { nickname: ' 示例创作者 ', unique_id: 'example_creator', uid: 12345, sec_uid: 'secret', avatar: 'https://x' },
    },
  }, '/janus/douyin/creator/pc/user_info');
  assert.deepEqual(plain(account), { name: '示例创作者', id: 'example_creator' });
});

test('a work response never becomes the account through its author', () => {
  const account = X.accountFromPayload({
    aweme_list: [{ aweme_id: '7300000000000000008', author: { nickname: '某个作者', uid: '9' } }],
  }, WORK_PATH);
  assert.equal(account, null);
});

test('unrelated payloads without an account path or account container are ignored', () => {
  assert.equal(X.accountFromPayload({ data: { nickname: '路人' } }, '/aweme/v1/web/comment/list'), null);
  assert.deepEqual(
    plain(X.accountFromPayload({ user_info: { nickname: '账号' } }, '/janus/douyin/creator/pc/anything')),
    { name: '账号' },
  );
});
