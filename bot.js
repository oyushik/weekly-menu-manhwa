import { load } from 'cheerio';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const BOARD_URL = 'https://www.hoyacooks.com/WeeklyMenu/';
const TARGET = '한국만화영상진흥원';
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'],
  ['image/gif', 'gif'], ['image/webp', 'webp'],
]);
const compact = (text) => text.replace(/\s+/g, '');
const isTarget = (title) => compact(title).includes(TARGET) && compact(title).includes('주간식단');
const isId = (id) => typeof id === 'string' && /^(0|[1-9]\d*)$/.test(id);
const byId = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;

export function parseListing(html, pageUrl = BOARD_URL) {
  const $ = load(html);
  const posts = new Map();
  $('.li_board a.list_text_title[href]').each((_, element) => {
    const link = $(element);
    const url = new URL(link.attr('href'), pageUrl);
    const id = url.searchParams.get('idx');
    if (url.origin !== new URL(BOARD_URL).origin || url.pathname.replace(/\/$/, '') !== '/WeeklyMenu'
      || url.searchParams.get('bmode') !== 'view' || !isId(id)) return;
    posts.set(id, {
      id,
      title: link.text().replace(/\s+/g, ' ').trim(),
      url: `${BOARD_URL}?bmode=view&idx=${id}`,
    });
  });
  if (!posts.size) throw new Error('게시글 목록을 찾지 못했습니다. 사이트 구조 또는 접속 상태를 확인하세요.');
  const currentPage = Number(new URL(pageUrl).searchParams.get('page') || 1);
  const nextPages = $('.pagination a[href]').toArray().map((element) => {
    const url = new URL($(element).attr('href'), pageUrl);
    const page = Number(url.searchParams.get('page'));
    return url.origin === new URL(BOARD_URL).origin
      && url.pathname.replace(/\/$/, '') === '/WeeklyMenu'
      && Number.isInteger(page) && page > currentPage ? { page, url: url.href } : null;
  }).filter(Boolean).sort((a, b) => a.page - b.page);
  return { posts: [...posts.values()].sort(byId), nextUrl: nextPages[0]?.url };
}

export function parsePost(html, post) {
  const $ = load(html);
  const title = $('.board_view .view_tit').first().text().replace(/\s+/g, ' ').trim();
  const body = $('.board_view .board_txt_area').first();
  if (!isTarget(title) || !body.length) throw new Error(`게시글 ${post.id}: 대상 제목/본문을 확인할 수 없습니다.`);
  const images = [];
  body.find('img').each((_, element) => {
    const img = $(element);
    const source = img.attr('data-original') || img.attr('data-src') || img.attr('src');
    if (!source) throw new Error(`게시글 ${post.id}: 이미지 주소가 없습니다.`);
    const url = new URL(source, post.url);
    if (url.protocol !== 'https:' || !['cdn.imweb.me', 'www.hoyacooks.com', 'hoyacooks.com'].includes(url.hostname)) {
      throw new Error(`게시글 ${post.id}: 지원하지 않는 이미지 주소입니다.`);
    }
    url.hash = '';
    if (!images.includes(url.href)) images.push(url.href);
  });
  if (!images.length) throw new Error(`게시글 ${post.id}: 이미지가 아직 없습니다. 다음 실행에서 다시 확인합니다.`);
  return { ...post, title, images };
}

// Errors deliberately omit request URLs: Discord webhook URLs contain credentials.
export async function request(url, options = {}, label = 'HTTP 요청', fetchFn = fetch, wait = sleep) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchFn(url, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'User-Agent': 'HoyacooksWeeklyMenuBot/1.0', ...options.headers },
      });
    } catch {
      if (options.method === 'POST' || attempt === 2) throw new Error(`${label}: 연결 실패 또는 시간 초과`);
      await wait(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response;
    if (response.status === 429 && attempt < 2) {
      const body = await response.json().catch(() => ({}));
      const seconds = Number(body.retry_after ?? response.headers.get('retry-after') ?? 5);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 120) {
        throw new Error(`${label}: 요청 제한. 다음 예약 실행에서 다시 시도합니다.`);
      }
      await wait(Math.ceil(seconds * 1000) + 100);
      continue;
    }
    await response.body?.cancel();
    if (response.status >= 500 && options.method !== 'POST' && attempt < 2) {
      await wait(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${label}: HTTP ${response.status}`);
  }
}

export async function findNewPosts(lastPostId, getHtml) {
  const found = new Map();
  const signatures = new Set();
  let url = BOARD_URL;
  for (let page = 0; url && page < 100; page++) {
    const listing = parseListing(await getHtml(url), url);
    const signature = listing.posts.map((post) => post.id).join(',');
    if (signatures.has(signature)) throw new Error('게시판 페이지가 반복됩니다. 전송을 중단합니다.');
    signatures.add(signature);
    for (const post of listing.posts) {
      if (isTarget(post.title) && (lastPostId === null || BigInt(post.id) > BigInt(lastPostId))) found.set(post.id, post);
    }
    // The board uses increasing numeric post IDs. A whole older page also handles pinned older entries.
    if (lastPostId === null && found.size) return [...found.values()].sort(byId).slice(-1);
    if (lastPostId !== null && listing.posts.every((post) => BigInt(post.id) <= BigInt(lastPostId))) break;
    url = listing.nextUrl;
    if (url && page === 99) throw new Error('100페이지 탐색 한도에 도달했습니다. 전송 기록을 확인하세요.');
  }
  if (lastPostId === null && !found.size) throw new Error('한국만화영상진흥원 주간식단표를 찾지 못했습니다.');
  return [...found.values()].sort(byId);
}

export function validateState(state) {
  if (state?.version !== 1 || !isId(state.lastPostId)
    || (state.pending !== null && (!isId(state.pending?.postId)
      || BigInt(state.pending.postId) <= BigInt(state.lastPostId)
      || !Array.isArray(state.pending.sentImages)
      || !state.pending.sentImages.every((url) => typeof url === 'string')))) {
    throw new Error('전송 기록이 손상되었습니다. state.json을 복구하세요. 자동 초기화하지 않습니다.');
  }
  return state;
}

export async function readState(file) {
  try {
    return validateState(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('전송 기록을 읽지 못했습니다. state.json을 복구하세요. 자동 초기화하지 않습니다.');
  }
}

export async function saveState(file, state) {
  validateState(state);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function webhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !['discord.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname)
    || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    throw new Error('DISCORD_WEBHOOK_URL에 Discord 채널 웹훅 URL을 설정하세요.');
  }
  url.searchParams.set('wait', 'true');
  return url;
}

async function downloadImage(url, postUrl) {
  const response = await request(url, { headers: { Referer: postUrl } }, '이미지 다운로드');
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    await response.body?.cancel();
    throw new Error('다운로드한 파일이 지원하는 이미지 형식(JPG/PNG/GIF/WebP)이 아닙니다.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error('이미지가 10 MiB를 초과합니다. 전송하지 않았습니다.');
    chunks.push(chunk);
  }
  if (!size) throw new Error('이미지 파일이 비어 있습니다.');
  return { blob: new Blob(chunks, { type }), extension: IMAGE_TYPES.get(type) };
}

export async function sendImages(webhook, post, images, sendRequest = request) {
  if (!images.length || images.length > 10) throw new Error('한 메시지에는 이미지 1~10장을 첨부할 수 있습니다.');
  // Leave room for multipart headers within Discord's 25 MiB request limit.
  if (images.reduce((total, image) => total + image.blob.size, 0) > 24 * 1024 * 1024) {
    throw new Error('이미지 합계가 24 MiB를 초과해 한 메시지로 전송할 수 없습니다.');
  }
  const attachments = images.map((image, index) => ({
    id: index, filename: `menu-${post.id}-${index + 1}.${image.extension}`,
  }));
  const form = new FormData();
  form.set('payload_json', JSON.stringify({
    username: '호야쿡스 식단 알림',
    content: `🍽️ ${post.title.slice(0, 300)}\n식단표 ${images.length}장\n<${post.url}>`,
    allowed_mentions: { parse: [] },
    attachments,
  }));
  images.forEach((image, index) => form.set(`files[${index}]`, image.blob, attachments[index].filename));
  const response = await sendRequest(webhook, { method: 'POST', body: form }, 'Discord 전송');
  const message = await response.json();
  if (!message.id || message.attachments?.length !== images.length) throw new Error('Discord의 전체 이미지 전송 확인을 받지 못했습니다.');
}

export async function run({
  stateFile = resolve('data/state.json'), webhook, dryRun = false,
  getHtml = async (url) => (await request(url, {}, '게시판 조회')).text(),
  getImage = downloadImage, send = sendImages, log = console.log,
} = {}) {
  const destination = dryRun ? null : webhookUrl(webhook);
  let state = dryRun ? null : await readState(stateFile);
  const posts = await findNewPosts(state?.lastPostId ?? null, getHtml);
  if (state?.pending && !posts.some((post) => post.id === state.pending.postId)) {
    throw new Error(`전송 중이던 게시글 ${state.pending.postId}이 목록에서 사라졌습니다. 기록을 확인하세요.`);
  }
  if (!posts.length) { log('새 식단표가 없습니다.'); return; }
  if (!dryRun && !state) {
    // Bootstrap only the latest post; persist the cutoff even if its first send fails.
    state = { version: 1, lastPostId: String(BigInt(posts[0].id) - 1n), pending: null };
    await saveState(stateFile, state);
  }
  for (const summary of posts) {
    const post = parsePost(await getHtml(summary.url), summary);
    log(`${dryRun ? '[미리보기] ' : ''}${post.title} — 이미지 ${post.images.length}장`);
    if (!dryRun && !state.pending) {
      state.pending = { postId: post.id, sentImages: [] };
      await saveState(stateFile, state);
    }
    // Honor any partial delivery history left by the previous image-per-message version.
    const remaining = post.images.filter((url) => dryRun || !state.pending.sentImages.includes(url));
    if (!dryRun && remaining.length > 10) throw new Error('이미지가 10장을 초과해 한 메시지로 전송할 수 없습니다.');
    const images = [];
    for (const [index, url] of remaining.entries()) {
      const image = await getImage(url, post.url);
      if (dryRun) { log(`  ${index + 1}. ${url} (${image.blob.size} bytes)`); continue; }
      images.push(image);
    }
    if (!dryRun) {
      if (images.length) {
        await send(destination, post, images);
        log(`  이미지 ${images.length}장을 메시지 1개로 전송 완료`);
      }
      state.lastPostId = post.id;
      state.pending = null;
      await saveState(stateFile, state);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((arg) => arg !== '--dry-run')) {
    console.error('사용법: node bot.js [--dry-run]');
    process.exitCode = 1;
  } else {
    run({
      webhook: process.env.DISCORD_WEBHOOK_URL,
      stateFile: resolve(process.env.STATE_FILE || 'data/state.json'),
      dryRun: arguments_.includes('--dry-run'),
    }).catch((error) => {
      // Never print a fetch stack/cause, since it can contain the secret URL.
      console.error(`실패: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
