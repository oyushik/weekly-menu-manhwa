import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOARD_URL, findNewPosts, parseListing, parsePost, readState, request,
  run, saveState, sendImage, webhookUrl,
} from './bot.js';

const TITLE = '(1)한국만화영상진흥원 주간식단표(10/5~10/11)';
const WEBHOOK = 'https://discord.com/api/webhooks/123/test_token';
const imageUrl = (name) => `https://cdn.imweb.me/upload/test/${name}.jpg`;
const listing = (rows, next) => `<div class="li_board">${rows.map(([id, title = TITLE]) => `
  <ul class="li_body holder"><li class="link_area"><a href="?bmode=view&idx=${id}"></a></li>
  <li class="tit"><a class="list_text_title _fade_link" href="/WeeklyMenu/?q=x&amp;bmode=view&amp;idx=${id}&amp;t=board"><span>${title}</span></a></li></ul>
`).join('')}</div>${next ? `<ul class="pagination"><li><a href="?page=${next}">${next}</a></li></ul>` : ''}`;
const detail = (images = ['a', 'b']) => `
  <img src="https://cdn.imweb.me/banner.png">
  <div class="board_view"><h1 class="view_tit">${TITLE}</h1>
  <div class="board_txt_area fr-view"><div><p>${images.map((name) => `<img src="${imageUrl(name)}">`).join('')}</p></div></div>
  <div class="comment_section"><img src="https://cdn.imweb.me/comment.png"></div></div>`;
const image = { blob: new Blob(['image'], { type: 'image/jpeg' }), extension: 'jpg' };
const getImage = async () => image;
const log = () => {};

async function tempState(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-menu-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'state.json');
}

test('실제 게시판 구조: 제목/본문 범위, 엔티티, 중복 이미지, 지연 로딩', () => {
  const parsed = parseListing(listing([[43], [44, '의정부지방검찰청 주간식단표']], 2));
  assert.equal(parsed.posts.length, 2);
  assert.equal(parsed.nextUrl, `${BOARD_URL}?page=2`);
  const post = parsePost(detail(['a', 'a', 'b']).replace(`src="${imageUrl('b')}"`, `src="data:image/gif;base64,x" data-src="${imageUrl('b')}"`), parsed.posts[0]);
  assert.deepEqual(post.images, [imageUrl('a'), imageUrl('b')]);
  assert.throws(() => parsePost(detail([]), parsed.posts[0]), /이미지가 아직 없습니다/);
  assert.throws(() => parsePost(detail().replace(TITLE, '다른 기관 주간식단표'), parsed.posts[0]), /대상 제목/);
  assert.throws(() => parseListing('<h1>Access denied</h1>'), /게시글 목록/);
});

test('오래된 고정 글이 있어도 다음 페이지의 새 글을 찾아 오래된 순으로 정렬', async () => {
  const pages = [
    listing([[5], [60, '다른 기관 주간식단표'], [50, '한국 만화 영상 진흥원 주간 식단표']], 2),
    listing([[40], [35]], 3),
    listing([[30], [20]]),
  ];
  const visited = [];
  const posts = await findNewPosts('30', async (url) => {
    const page = Number(new URL(url).searchParams.get('page') || 1);
    visited.push(page);
    return pages[page - 1];
  });
  assert.deepEqual(posts.map((post) => post.id), ['35', '40', '50']);
  assert.deepEqual(visited, [1, 2, 3]);
  await assert.rejects(findNewPosts('1', async () => pages[0]), /페이지가 반복/);
});

test('첫 실행은 최신 한 건, 재실행은 무전송, 이후 새 글은 순서대로 전송', async (t) => {
  const stateFile = await tempState(t);
  let rows = [[30], [20]];
  const sent = [];
  const options = {
    stateFile, webhook: WEBHOOK, getImage, log,
    getHtml: async (url) => new URL(url).searchParams.has('idx') ? detail() : listing(rows),
    send: async (_, post, index) => sent.push(`${post.id}:${index}`),
  };
  await run(options);
  assert.deepEqual(sent, ['30:0', '30:1']);
  await run(options);
  assert.equal(sent.length, 2);
  rows = [[50], [40], [30], [20]];
  await run(options);
  assert.deepEqual(sent, ['30:0', '30:1', '40:0', '40:1', '50:0', '50:1']);
  assert.equal((await readState(stateFile)).lastPostId, '50');
});

test('전송 실패 시 완료된 이미지만 기록하고 다음 실행에서 이어 전송', async (t) => {
  const stateFile = await tempState(t);
  const sent = [];
  let fail = true;
  const options = {
    stateFile, webhook: WEBHOOK, getImage, log,
    getHtml: async (url) => new URL(url).searchParams.has('idx') ? detail() : listing([[30], [20]]),
    send: async (_, post, index) => {
      if (index === 1 && fail) throw new Error('Discord unavailable');
      sent.push(index);
    },
  };
  await assert.rejects(run(options), /Discord unavailable/);
  assert.deepEqual(await readState(stateFile), {
    version: 1, lastPostId: '29', pending: { postId: '30', sentImages: [imageUrl('a')] },
  });
  fail = false;
  await run(options);
  assert.deepEqual(sent, [0, 1]);
  assert.deepEqual(await readState(stateFile), { version: 1, lastPostId: '30', pending: null });
});

test('이미지가 늦게 올라오면 기록을 건너뛰지 않고 다시 시도; 미리보기는 상태/전송을 변경하지 않음', async (t) => {
  const stateFile = await tempState(t);
  let images = [];
  const options = {
    stateFile, webhook: WEBHOOK, getImage, log,
    getHtml: async (url) => new URL(url).searchParams.has('idx') ? detail(images) : listing([[30]]),
    send: async () => assert.fail('Must not send'),
  };
  await assert.rejects(run(options), /이미지가 아직 없습니다/);
  assert.equal((await readState(stateFile)).lastPostId, '29');
  const before = await readFile(stateFile, 'utf8');
  images = ['a'];
  await run({ ...options, dryRun: true, webhook: undefined });
  assert.equal(await readFile(stateFile, 'utf8'), before);
});

test('손상된 기록이나 사라진 미완료 글은 초기화/덮어쓰기 없이 오류 처리', async (t) => {
  const stateFile = await tempState(t);
  await writeFile(stateFile, '{broken');
  await assert.rejects(readState(stateFile), /자동 초기화하지 않습니다/);
  await writeFile(stateFile, JSON.stringify({ version: 1, lastPostId: 'NaN', pending: null }));
  await assert.rejects(readState(stateFile), /자동 초기화하지 않습니다/);
  const state = { version: 1, lastPostId: '20', pending: { postId: '30', sentImages: [] } };
  await saveState(stateFile, state);
  await assert.rejects(run({
    stateFile, webhook: WEBHOOK, getHtml: async () => listing([[40], [20]]), getImage, log,
  }), /목록에서 사라졌습니다/);
  assert.deepEqual(await readState(stateFile), state);
});

test('Discord 요청: 원본 첨부, wait=true, 멘션 차단, 429 대기, 실패 시 웹훅 비밀 보호', async () => {
  const destination = webhookUrl(`${WEBHOOK}?thread_id=456`);
  assert.equal(destination.searchParams.get('wait'), 'true');
  assert.equal(destination.searchParams.get('thread_id'), '456');
  assert.throws(() => webhookUrl('https://discord.com.evil.test/api/webhooks/123/secret'), /설정하세요/);
  const post = { id: '30', title: TITLE, url: `${BOARD_URL}?bmode=view&idx=30`, images: [imageUrl('a')] };
  await sendImage(destination, post, 0, image, async (_, options) => {
    const payload = JSON.parse(options.body.get('payload_json'));
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(options.body.get('files[0]').name, 'menu-30-1.jpg');
    assert.equal(await options.body.get('files[0]').text(), 'image');
    return Response.json({ id: '99', attachments: [{ id: '100' }] });
  });
  const waits = [];
  let calls = 0;
  await request(destination, { method: 'POST' }, 'Discord 전송', async () => {
    calls++;
    return calls === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : Response.json({ id: '99' });
  }, async (ms) => waits.push(ms));
  assert.equal(calls, 2);
  assert.deepEqual(waits, [110]);
  calls = 0;
  await assert.rejects(request(destination, { method: 'POST' }, 'Discord 전송', async () => {
    calls++;
    throw new Error(WEBHOOK);
  }), (error) => !error.message.includes('test_token') && /연결 실패/.test(error.message));
  assert.equal(calls, 1);
});
