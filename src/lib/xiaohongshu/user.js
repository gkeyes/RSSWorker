import puppeteer from '@cloudflare/puppeteer';
import { renderRss2 } from '../../utils/util';

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const unwrap = (value) => value?._rawValue ?? value?._value ?? value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getHeaders = (cookie = '') => ({
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
	'Cache-Control': 'no-cache',
	Pragma: 'no-cache',
	Referer: 'https://www.xiaohongshu.com/',
	'User-Agent': USER_AGENT,
	...(cookie ? { Cookie: cookie } : {}),
});

const parseBrowserCookies = (cookieString) => {
	if (!cookieString) return [];

	return cookieString
		.split(';')
		.map((part) => {
			const index = part.indexOf('=');
			if (index <= 0) return null;
			return {
				name: part.slice(0, index).trim(),
				value: part.slice(index + 1).trim(),
				domain: '.xiaohongshu.com',
				path: '/',
			};
		})
		.filter((item) => item?.name);
};

const normalizeNotes = (notes) => {
	const result = [];

	const walk = (value) => {
		value = unwrap(value);
		if (!value) return;

		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}

		if (typeof value !== 'object') return;

		const noteCard = unwrap(value.noteCard ?? value.note_card);
		const noteId =
			value.id ??
			value.noteId ??
			value.note_id ??
			noteCard?.noteId ??
			noteCard?.note_id ??
			noteCard?.id;

		if (noteCard || noteId) {
			result.push(value);
			return;
		}

		for (const key of ['data', 'list', 'items', 'notes']) {
			if (value[key]) walk(value[key]);
		}
	};

	walk(notes);
	return result;
};

const parseInitialStateText = (scriptText) => {
	const marker = 'window.__INITIAL_STATE__=';
	const index = scriptText.indexOf(marker);
	if (index < 0) {
		throw new Error('小红书页面缺少 __INITIAL_STATE__');
	}

	let script = scriptText.slice(index + marker.length).trim();
	script = script.replace(/;\s*$/, '');
	// Xiaohongshu serializes parts of Vue state as executable JS rather than strict JSON.
	// Normalize the common container literals before JSON.parse.
	script = script
		.replaceAll(/new Map\(\s*\[\s*\]\s*\)/g, '{}')
		.replaceAll(/new Set\(\s*\[\s*\]\s*\)/g, '[]')
		.replaceAll(/new Map\(\s*\)/g, '{}')
		.replaceAll(/new Set\(\s*\)/g, '[]')
		.replaceAll(/\bundefined\b/g, 'null');

	try {
		return JSON.parse(script);
	} catch (error) {
		throw new Error(`小红书 __INITIAL_STATE__ 解析失败: ${error.message}`);
	}
};

const extractHomeCardLinks = (html) => {
	const links = new Map();
	const sectionPattern = /<section\\b([^>]*)class=(["'])[^"']*\\bnote-item\\b[^"']*\\2([^>]*)>([\\s\\S]*?)<\\/section>/gi;
	let sectionMatch;

	while ((sectionMatch = sectionPattern.exec(html))) {
		const attrs = `${sectionMatch[1]} ${sectionMatch[3]}`;
		const indexMatch = attrs.match(/data-index=(["'])(\\d+)\\1/i);
		if (!indexMatch) continue;

		const body = sectionMatch[4];
		const hrefMatch = body.match(
			/<a\\b[^>]*class=(["'])[^"']*\\bcover\\b[^"']*\\1[^>]*href=(["'])([^"']+)\\2/i
		) || body.match(/<a\\b[^>]*href=(["'])([^"']*(?:\\/explore\\/|\\/discovery\\/item\\/|xsec_token=)[^"']*)\\1/i);

		if (!hrefMatch) continue;
		const href = hrefMatch.length >= 4 ? hrefMatch[3] : hrefMatch[2];
		links.set(Number(indexMatch[2]), href);
	}

	return links;
};

const extractNoteIdFromUrl = (href) => {
	if (!href) return '';
	try {
		const parsed = new URL(href, 'https://www.xiaohongshu.com');
		const parts = parsed.pathname.split('/').filter(Boolean);
		let noteId = '';

		if (parts[0] === 'explore' && parts.length >= 2) {
			noteId = parts[1];
		} else if (parts[0] === 'discovery' && parts[1] === 'item' && parts.length >= 3) {
			noteId = parts[2];
		} else if (parts[0] === 'user' && parts[1] === 'profile' && parts.length >= 4) {
			noteId = parts[3];
		}

		return /^[0-9a-f]{24}$/i.test(noteId) ? noteId : '';
	} catch {
		return '';
	}
};

const extractPage = async (html) => {
	let scriptText = '';

	const rewriter = new HTMLRewriter()
		.on('script', {
			element() {},
			text(text) {
				if (text.text.includes('window.__INITIAL_STATE__=') || scriptText) {
					scriptText += text.text;
				}
			},
		})
		.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }));

	await rewriter.text();

	if (!scriptText) {
		throw new Error('小红书页面未返回 __INITIAL_STATE__');
	}

	const state = parseInitialStateText(scriptText);
	const user = unwrap(state?.user);
	if (!user || typeof user !== 'object') {
		throw new Error('小红书页面未返回 user 状态');
	}

	const userPageData = unwrap(user.userPageData ?? user.userInfo ?? {}) ?? {};
	const rawNotes = unwrap(user.notes ?? userPageData?.notes ?? []);
	const activeTab = unwrap(user.activeTab) ?? {};
	const activeIndex = Number.isInteger(activeTab.index) ? activeTab.index : 0;

	let selectedNotes = rawNotes;
	if (Array.isArray(rawNotes) && rawNotes.length && rawNotes.every((row) => Array.isArray(row))) {
		selectedNotes = rawNotes[activeIndex] ?? rawNotes.find((row) => Array.isArray(row) && row.length) ?? [];
	}

	const notes = normalizeNotes(selectedNotes);
	const cardLinks = extractHomeCardLinks(html);

	for (let index = 0; index < notes.length; index++) {
		const item = notes[index];
		const noteCard = unwrap(item.noteCard ?? item.note_card ?? item) ?? {};
		let noteId = item.id ?? item.noteId ?? item.note_id ?? noteCard.noteId ?? noteCard.note_id ?? noteCard.id;
		const href = cardLinks.get(index) || '';
		const hrefNoteId = extractNoteIdFromUrl(href);

		if (!noteId && hrefNoteId) {
			item.id = hrefNoteId;
			noteId = hrefNoteId;
			if (item.noteCard && !item.noteCard.noteId && !item.noteCard.note_id) {
				item.noteCard.noteId = hrefNoteId;
			}
		}

		if (!href) continue;
		try {
			const parsed = new URL(href, 'https://www.xiaohongshu.com');
			const token = parsed.searchParams.get('xsec_token') || '';
			if (token) {
				item.xsecToken = item.xsecToken || item.xsec_token || token;
				if (item.noteCard && !item.noteCard.xsecToken && !item.noteCard.xsec_token) {
					item.noteCard.xsecToken = token;
				}
			}
		} catch {
			// Card-link enrichment is optional.
		}
	}

	return {
		userPageData,
		notes,
		activeIndex,
		cardLinkCount: cardLinks.size,
	};
};

const getBasicInfo = (userPageData) => {
	const page = unwrap(userPageData) ?? {};
	return unwrap(page.basicInfo ?? page.basic_info ?? page.userInfo ?? page.user_info) ?? {};
};

const hasProfile = (data) => {
	const basic = getBasicInfo(data?.userPageData);
	return Boolean(basic.nickname ?? basic.nickName ?? basic.name);
};

const checkCookie = async (cookie) => {
	if (!cookie) return { configured: false, valid: false, reason: 'missing' };

	try {
		const response = await fetch('https://edith.xiaohongshu.com/api/sns/web/v2/user/me', {
			headers: {
				...getHeaders(cookie),
				Accept: 'application/json, text/plain, */*',
				Origin: 'https://www.xiaohongshu.com',
			},
		});

		const data = await response.json();
		return {
			configured: true,
			valid: response.ok && data?.code === 0 && Boolean(data?.data?.user_id),
			reason: data?.msg ?? data?.message ?? `HTTP ${response.status}`,
		};
	} catch (error) {
		return {
			configured: true,
			valid: null,
			reason: String(error?.message || error),
		};
	}
};

const fetchProfileHtml = async (url, cookie = '') => {
	const response = await fetch(url, {
		headers: getHeaders(cookie),
		redirect: 'follow',
	});

	if (!response.ok) {
		throw new Error(`小红书主页请求失败: HTTP ${response.status}`);
	}

	return response.text();
};

const getWithCookie = async (url, cookie) => {
	const cookieStatus = await checkCookie(cookie);
	if (cookieStatus.valid === false) {
		throw new Error(`XIAOHONGSHU_COOKIE 登录态无效: ${cookieStatus.reason}`);
	}

	const html = await fetchProfileHtml(url, cookie);
	const data = await extractPage(html);

	if (!hasProfile(data)) {
		throw new Error('Cookie 请求已返回页面，但没有用户资料；登录态可能已失效或触发风控');
	}

	return data;
};

const getWithoutCookie = async (url) => {
	const html = await fetchProfileHtml(url);
	return extractPage(html);
};

const isNavigationTimeout = (error) => String(error?.message || error).includes('Navigation timeout');

const getWithBrowser = async (ctx, url) => {
	if (!ctx.env?.BROWSER) {
		throw new Error('Cloudflare Browser Run binding 不可用');
	}

	let browser;
	try {
		browser = await puppeteer.launch(ctx.env.BROWSER);
		const page = await browser.newPage();
		await page.setUserAgent(USER_AGENT);

		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const type = request.resourceType();
			if (type === 'document' || type === 'script' || type === 'xhr' || type === 'fetch' || type === 'other') {
				request.continue();
			} else {
				request.abort();
			}
		});

		try {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
		} catch (error) {
			if (!isNavigationTimeout(error)) throw error;
			let currentHost = '';
			try {
				currentHost = new URL(page.url()).hostname;
			} catch {
				// about:blank or transient navigation
			}
			if (currentHost !== 'www.xiaohongshu.com') throw error;
		}

		try {
			await page.waitForSelector('div.reds-tab-item:nth-child(2), .fe-verify-box', { timeout: 3500 });
		} catch {
			// The page can still be usable without these exact selectors.
		}

		if (await page.$('.fe-verify-box')) {
			throw new Error('小红书风控校验已触发（fe-verify-box），本次抓取停止');
		}

		await sleep(500);
		const html = await page.content();
		const data = await extractPage(html);

		if (!hasProfile(data)) {
			throw new Error('匿名 Browser Run 已打开主页，但没有用户资料');
		}

		return data;
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch {
				// Always release Browser Run time.
			}
		}
	}
};

const getUser = async (ctx, url) => {
	const diagnostics = [];
	const parsedUrl = new URL(url);
	const hasXsecToken = Boolean(parsedUrl.searchParams.get('xsec_token'));

	try {
		const data = await getWithoutCookie(url);
		if (data.notes.length) return { ...data, source: hasXsecToken ? 'token-fetch' : 'plain-fetch' };
		diagnostics.push(hasProfile(data) ? 'fetch=profile-only' : 'fetch=empty');
	} catch (error) {
		diagnostics.push(`fetch=${String(error?.message || error)}`);
	}

	// Anonymous bare-UID profile crawling is heavily rate-limited by Xiaohongshu.
	// Do not burn Browser Run time when the request has no public xsec_token context.
	if (!hasXsecToken) {
		throw new Error(
			`匿名模式下裸 UID 未返回发布笔记；请使用带 xsec_token 的公开小红书用户主页/分享链接。诊断：${diagnostics.join(' | ')}`
		);
	}

	try {
		const data = await getWithBrowser(ctx, url);
		if (data.notes.length) return { ...data, source: 'token-browser' };
		diagnostics.push(hasProfile(data) ? 'browser=profile-only' : 'browser=empty');
	} catch (error) {
		const message = String(error?.message || error);
		if (message.includes('风控校验已触发')) throw error;
		diagnostics.push(`browser=${message}`);
	}

	throw new Error(`匿名 xsec_token 模式仍未抓到发布笔记；${diagnostics.join(' | ')}`);
};

const getCoverUrl = (cover) => {
	cover = unwrap(cover) ?? {};
	const infoList = unwrap(cover.infoList ?? cover.info_list);
	if (Array.isArray(infoList) && infoList.length) {
		const item = infoList[infoList.length - 1] ?? infoList[0];
		return item?.url ?? item?.urlDefault ?? item?.url_default ?? item?.urlPre ?? item?.url_pre ?? '';
	}
	return cover.urlDefault ?? cover.url_default ?? cover.urlPre ?? cover.url_pre ?? cover.url ?? '';
};

const toRssItem = (item, fallbackAuthor) => {
	item = unwrap(item) ?? {};
	const noteCard = unwrap(item.noteCard ?? item.note_card ?? item) ?? {};
	const noteId = noteCard.noteId ?? noteCard.note_id ?? noteCard.id ?? item.id ?? item.noteId ?? item.note_id;
	if (!noteId) return null;

	const noteUser = unwrap(noteCard.user ?? item.user) ?? {};
	const interactInfo = unwrap(noteCard.interactInfo ?? noteCard.interact_info ?? item.interactInfo ?? item.interact_info) ?? {};
	const displayTitle =
		noteCard.displayTitle ??
		noteCard.display_title ??
		noteCard.title ??
		noteCard.desc ??
		item.displayTitle ??
		item.display_title ??
		item.title ??
		item.desc ??
		`小红书笔记 ${noteId}`;

	const author = noteUser.nickname ?? noteUser.nickName ?? noteUser.nick_name ?? noteUser.name ?? fallbackAuthor;
	const coverUrl = getCoverUrl(noteCard.cover ?? item.cover);
	const xsecToken = item.xsecToken ?? item.xsec_token ?? noteCard.xsecToken ?? noteCard.xsec_token;
	const noteUrl = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);

	if (xsecToken) {
		noteUrl.searchParams.set('xsec_token', xsecToken);
		noteUrl.searchParams.set('xsec_source', 'pc_user');
	}

	return {
		title: String(displayTitle).trim() || `小红书笔记 ${noteId}`,
		link: noteUrl.toString(),
		guid: noteId,
		description: `${coverUrl ? `<img src="${coverUrl}"><br>` : ''}${displayTitle}`,
		author,
		upvotes: interactInfo.likedCount ?? interactInfo.liked_count,
	};
};

const getCache = () => {
	try {
		return caches.default;
	} catch {
		return null;
	}
};

const deal = async (ctx) => {
	const { uid } = ctx.req.param();
	const cache = getCache();
	const cacheKey = new Request(`https://rssworker-cache.invalid/xiaohongshu/user/${uid}`);

	if (cache && ctx.req.query('refresh') !== '1') {
		const cached = await cache.match(cacheKey);
		if (cached) return cached;
	}

	const pageUrl = new URL(`https://www.xiaohongshu.com/user/profile/${uid}`);

	// Preserve the public share context. Xiaohongshu's anonymous profile access can
	// depend on more than xsec_token alone (for example shareRedId/apptime/share_id).
	const shareParams = [
		'xsec_token',
		'xsec_source',
		'xhsshare',
		'shareRedId',
		'apptime',
		'share_id',
		'share_channel',
	];
	for (const key of shareParams) {
		const value = ctx.req.query(key);
		if (value !== undefined && value !== null) {
			pageUrl.searchParams.set(key, value);
		}
	}
	if (pageUrl.searchParams.has('xsec_token') && !pageUrl.searchParams.has('xsec_source')) {
		pageUrl.searchParams.set('xsec_source', 'app_share');
	}

	const { userPageData, notes } = await getUser(ctx, pageUrl.toString());
	const page = unwrap(userPageData) ?? {};
	const basicInfo = getBasicInfo(userPageData);
	const interactions = unwrap(page.interactions) ?? [];
	const tags = unwrap(page.tags) ?? [];

	const profileNickname = basicInfo.nickname ?? basicInfo.nickName ?? basicInfo.name;
	const firstNote = notes[0] ? unwrap(notes[0]) : null;
	const firstCard = firstNote ? unwrap(firstNote.noteCard ?? firstNote.note_card ?? firstNote) : null;
	const firstUser = firstCard ? unwrap(firstCard.user ?? firstNote.user) : null;
	const noteNickname = firstUser?.nickname ?? firstUser?.nickName ?? firstUser?.nick_name ?? firstUser?.name;
	const feedTitle = profileNickname ?? noteNickname ?? `小红书用户 ${uid}`;

	const items = notes.map((item) => toRssItem(item, feedTitle)).filter(Boolean);
	if (!items.length) {
		throw new Error('小红书用户资料已获取，但没有可用于 RSS 的笔记条目');
	}

	const descriptionParts = [
		basicInfo.desc ?? basicInfo.description ?? '',
		Array.isArray(tags) ? tags.map((tag) => tag?.name).filter(Boolean).join(' ') : '',
		Array.isArray(interactions)
			? interactions
					.map((item) => (item?.name ? `${item?.count ?? ''} ${item.name}`.trim() : ''))
					.filter(Boolean)
					.join(' ')
			: '',
	].filter(Boolean);

	const image =
		basicInfo.imageb ??
		basicInfo.images ??
		basicInfo.avatar ??
		basicInfo.image ??
		firstUser?.avatar ??
		firstUser?.image;

	const xml = renderRss2({
		title: `${feedTitle} - 笔记 • 小红书 / RED`,
		description: descriptionParts.join(' ') || `${feedTitle} 的小红书笔记`,
		image,
		link: `https://www.xiaohongshu.com/user/profile/${uid}`,
		items,
	});

	const response = new Response(xml, {
		headers: {
			'Content-Type': 'application/rss+xml; charset=UTF-8',
			'Cache-Control': 'public, max-age=300, s-maxage=1800',
		},
	});

	if (cache) {
		try {
			await cache.put(cacheKey, response.clone());
		} catch {
			// Cache failure must not break the feed.
		}
	}

	return response;
};

const setup = (route) => {
	route.get('/xiaohongshu/user/:uid', deal);
};

export default { setup };
