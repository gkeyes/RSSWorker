import puppeteer from '@cloudflare/puppeteer';
import { renderRss2 } from '../../utils/util';

const unwrap = (value) => value?._rawValue ?? value?._value ?? value;

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const browserHeaders = {
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
	'Cache-Control': 'no-cache',
	Pragma: 'no-cache',
	Referer: 'https://www.xiaohongshu.com/',
	'User-Agent': USER_AGENT,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isContextDestroyed = (error) => {
	const message = String(error?.message || error);
	return (
		message.includes('Execution context was destroyed') ||
		message.includes('Cannot find context with specified id') ||
		message.includes('Inspected target navigated or closed')
	);
};

const evaluateWithNavigationRetry = async (page, fn, ...args) => {
	let lastError;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return await page.evaluate(fn, ...args);
		} catch (error) {
			lastError = error;
			if (!isContextDestroyed(error)) throw error;
			await sleep(500 + attempt * 350);
		}
	}
	throw lastError;
};

const waitForStableUrl = async (page, { timeout = 7000, stableFor = 1200 } = {}) => {
	const started = Date.now();
	let lastUrl = page.url();
	let stableSince = Date.now();

	while (Date.now() - started < timeout) {
		await sleep(300);
		const currentUrl = page.url();
		if (currentUrl !== lastUrl) {
			lastUrl = currentUrl;
			stableSince = Date.now();
			continue;
		}
		if (Date.now() - stableSince >= stableFor) return currentUrl;
	}

	return page.url();
};

const safePublicUrl = (value) => {
	try {
		const parsed = new URL(value);
		return parsed.origin + parsed.pathname;
	} catch {
		return String(value || '');
	}
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

const parseUserState = (state) => {
	const user = unwrap(state?.user);
	if (!user || typeof user !== 'object') {
		return { userPageData: {}, notes: [] };
	}

	const userPageData = unwrap(user.userPageData ?? user.userInfo ?? {}) ?? {};
	const rawNotes = unwrap(user.notes ?? userPageData?.notes ?? []);

	return {
		userPageData,
		notes: normalizeNotes(rawNotes),
	};
};

const extractInitialState = async (res) => {
	const scripts = [];
	const rewriter = new HTMLRewriter()
		.on('script', {
			element() {
				scripts.push('');
			},
			text(text) {
				if (scripts.length) scripts[scripts.length - 1] += text.text;
			},
		})
		.transform(res);

	await rewriter.text();

	const marker = 'window.__INITIAL_STATE__=';
	const source = scripts.find((script) => script.includes(marker));
	if (!source) {
		throw new Error('小红书未返回 __INITIAL_STATE__');
	}

	let script = source.slice(source.indexOf(marker) + marker.length).trim();
	script = script.replace(/;\s*$/, '');
	script = script.replaceAll(/new Map\(\s*\[\s*\]\s*\)/g, 'null').replaceAll(/\bundefined\b/g, 'null');

	return JSON.parse(script);
};

const getStaticState = async (url) => {
	const res = await fetch(url, {
		headers: browserHeaders,
		redirect: 'follow',
	});

	if (!res.ok) {
		throw new Error(`小红书主页请求失败: HTTP ${res.status}`);
	}

	return parseUserState(await extractInitialState(res));
};

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

const extractPlainRuntimeState = async (page, uid) =>
	evaluateWithNavigationRetry(page, (targetUid) => {
		const unwrapLocal = (value) => {
			let current = value;
			for (let i = 0; i < 8; i++) {
				if (!current || typeof current !== 'object') break;
				if ('_rawValue' in current && current._rawValue !== current) {
					current = current._rawValue;
					continue;
				}
				if ('_value' in current && current._value !== current) {
					current = current._value;
					continue;
				}
				break;
			}
			return current;
		};

		const initial = window.__INITIAL_STATE__ || {};
		const user = unwrapLocal(initial.user) || {};
		const pageData = unwrapLocal(user.userPageData ?? user.userInfo ?? {}) || {};
		const basic = unwrapLocal(pageData.basicInfo ?? pageData.basic_info ?? pageData.userInfo ?? pageData.user_info) || {};

		const basicInfo = {
			nickname: basic.nickname ?? basic.nickName ?? basic.name ?? '',
			desc: basic.desc ?? basic.description ?? '',
			imageb: basic.imageb ?? '',
			images: basic.images ?? '',
			avatar: basic.avatar ?? basic.image ?? '',
			userId: basic.userId ?? basic.user_id ?? targetUid,
		};

		const interactionsRaw = unwrapLocal(pageData.interactions) || [];
		const interactions = Array.isArray(interactionsRaw)
			? interactionsRaw.map((item) => ({
					count: item?.count ?? '',
					name: item?.name ?? '',
				}))
			: [];

		const tagsRaw = unwrapLocal(pageData.tags) || [];
		const tags = Array.isArray(tagsRaw) ? tagsRaw.map((item) => ({ name: item?.name ?? '' })) : [];

		const domNotes = new Map();
		for (const anchor of document.querySelectorAll(
			'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="xsec_token"]'
		)) {
			const href = anchor.href || anchor.getAttribute('href') || '';
			const match = href.match(/(?:\/explore\/|\/discovery\/item\/)([0-9a-f]{24})(?:[/?#]|$)/i);
			if (!match) continue;

			const card =
				anchor.closest('section.note-item') ||
				anchor.closest('[class*="note-item"]') ||
				anchor.closest('section') ||
				anchor.parentElement;

			const text = (selector) => (card?.querySelector(selector)?.textContent || '').trim();
			const image = card?.querySelector('img');
			let parsed;
			try {
				parsed = new URL(href, location.origin);
			} catch {
				continue;
			}

			domNotes.set(match[1], {
				id: match[1],
				xsecToken: parsed.searchParams.get('xsec_token') || '',
				noteCard: {
					displayTitle:
						text('.title') ||
						text('.note-title') ||
						anchor.getAttribute('title') ||
						image?.getAttribute('alt') ||
						'',
					user: {
						nickname:
							text('.name-time-wrapper .name') ||
							text('.author .name') ||
							text('.name') ||
							text('.username'),
					},
					interactInfo: {
						likedCount: text('.like-wrapper .count') || text('.count'),
					},
					cover: {
						urlDefault: image?.currentSrc || image?.src || image?.getAttribute('src') || '',
					},
				},
			});
		}

		return {
			userPageData: {
				basicInfo,
				interactions,
				tags,
			},
			notes: Array.from(domNotes.values()),
		};
	}, uid);

const getBrowserState = async (ctx, url, uid) => {
	if (!ctx.env?.BROWSER) {
		throw new Error('Cloudflare Browser Run binding 不可用');
	}

	let browser;
	try {
		browser = await puppeteer.launch(ctx.env.BROWSER);
		const page = await browser.newPage();
		await page.setUserAgent(USER_AGENT);

		const cookies = parseBrowserCookies(ctx.env.XIAOHONGSHU_COOKIE || '');
		if (cookies.length) {
			await page.setCookie(...cookies);
		}

		let postedPayload = null;
		let postedUrl = '';
		let postedSeen = false;
		let postedStatus = null;
		let postedRawCount = 0;
		let postedCode = null;
		let postedMessage = '';

		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const type = request.resourceType();
			if (type === 'image' || type === 'media' || type === 'font') {
				request.abort();
				return;
			}
			request.continue();
		});

		page.on('response', async (response) => {
			const responseUrl = response.url();
			if (
				!responseUrl.includes('/api/sns/web/v1/user_posted') &&
				!responseUrl.includes('/api/sns/web/v2/user_posted') &&
				!responseUrl.includes('/api/sns/web/v1/user/posted')
			) {
				return;
			}

			postedSeen = true;
			postedStatus = response.status();
			postedUrl = responseUrl;

			try {
				const json = await response.json();
				const rawNotes = json?.data?.notes ?? json?.data?.items ?? [];
				postedRawCount = Array.isArray(rawNotes) ? rawNotes.length : 0;
				postedCode = json?.code ?? null;
				postedMessage = String(json?.msg ?? json?.message ?? '').slice(0, 120);
				const notes = normalizeNotes(rawNotes);
				if (notes.length) {
					postedPayload = json;
				}
			} catch {
				// Keep postedSeen/status even when the response body is unavailable.
			}
		});

		try {
			await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: 15000,
			});
		} catch (error) {
			const message = String(error?.message || error);
			const currentUrl = page.url();
			const targetHost = new URL(url).hostname;
			let currentHost = '';
			try {
				currentHost = new URL(currentUrl).hostname;
			} catch {
				// Keep currentHost empty when the page is still about:blank.
			}

			// Xiaohongshu is a long-lived SPA. Browser Run can time out waiting for
			// DOMContentLoaded even after Chromium has already navigated to the page.
			// In that case continue with the live page instead of treating navigation
			// completion as a hard requirement.
			if (!message.includes('Navigation timeout') || currentHost !== targetHost) {
				throw error;
			}
		}

		await waitForStableUrl(page, { timeout: 7000, stableFor: 1200 });

		try {
			await page.waitForNetworkIdle({ idleTime: 600, timeout: 4000 });
		} catch {
			// Xiaohongshu keeps background connections open; this is best-effort.
		}

		await waitForStableUrl(page, { timeout: 3500, stableFor: 900 });

		for (let step = 0; step < 4 && !postedPayload; step++) {
			await evaluateWithNavigationRetry(
				page,
				(index) => {
					const height = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
					window.scrollTo({ top: Math.min(height, 700 + index * 900), behavior: 'instant' });
				},
				step
			);
			await sleep(900);
		}

		if (!postedPayload) {
			try {
				await evaluateWithNavigationRetry(page, () => {
					const candidates = Array.from(document.querySelectorAll('div,span,button,a'));
					const tab = candidates.find((element) => {
						const text = (element.textContent || '').trim();
						return text === '笔记' && element.getBoundingClientRect().width > 0;
					});
					tab?.click();
				});
				await waitForStableUrl(page, { timeout: 3500, stableFor: 900 });
				await sleep(800);
				await evaluateWithNavigationRetry(page, () => window.scrollBy(0, 900));
				await sleep(1200);
			} catch (error) {
				if (!isContextDestroyed(error)) {
					// DOM clicking is only a fallback to trigger lazy loading.
				}
			}
		}

		const runtime = await extractPlainRuntimeState(page, uid);
		const apiNotes = normalizeNotes(postedPayload?.data?.notes ?? postedPayload?.data?.items ?? []);
		const notes = apiNotes.length ? apiNotes : normalizeNotes(runtime.notes);

		if (notes.length) {
			return {
				userPageData: runtime.userPageData,
				notes,
				source: postedUrl ? 'user_posted' : 'dom',
			};
		}

		const nickname = runtime.userPageData?.basicInfo?.nickname;
		const finalUrl = safePublicUrl(page.url());
		const diagnostic = [
			`finalUrl=${finalUrl}`,
			`userPostedSeen=${postedSeen}`,
			`status=${postedStatus ?? 'n/a'}`,
			`rawNotes=${postedRawCount}`,
			`code=${postedCode ?? 'n/a'}`,
			postedMessage ? `message=${postedMessage}` : '',
		].filter(Boolean).join('; ');

		if (nickname) {
			throw new Error(`已获取小红书用户资料，但未获取到发布笔记；${diagnostic}`);
		}

		if (!ctx.env.XIAOHONGSHU_COOKIE) {
			throw new Error(`Browser Session 已执行，但小红书未返回用户资料；请配置 XIAOHONGSHU_COOKIE；${diagnostic}`);
		}

		throw new Error(`Browser Session 已执行，但小红书未返回用户资料；Cookie 可能已失效或触发风控；${diagnostic}`);
	} catch (error) {
		const message = String(error?.message || error);
		if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
			throw new Error(`Browser Run 限流: ${message}`);
		}
		throw error;
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch {
				// Always release Browser Run usage when possible.
			}
		}
	}
};

const getProfileNickname = (userPageData) => {
	const page = unwrap(userPageData) ?? {};
	const basicInfo = unwrap(page.basicInfo ?? page.basic_info ?? page.userInfo ?? page.user_info) ?? {};
	return basicInfo.nickname ?? basicInfo.nickName ?? basicInfo.name ?? '';
};

const getUser = async (ctx, url, uid) => {
	try {
		const staticData = await getStaticState(url);
		// A profile-only SSR response is not enough for an RSS feed.
		// Only skip Browser Run when SSR actually contains notes.
		if (staticData.notes.length) {
			return staticData;
		}
	} catch {
		// Static SSR is only a fast path.
	}

	return getBrowserState(ctx, url, uid);
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
		if (cached) {
			return cached;
		}
	}

	const pageUrl = new URL(`https://www.xiaohongshu.com/user/profile/${uid}`);
	const xsecToken = ctx.req.query('xsec_token');

	if (xsecToken) {
		pageUrl.searchParams.set('xsec_token', xsecToken);
		pageUrl.searchParams.set('xsec_source', ctx.req.query('xsec_source') || 'app_share');
	}

	const { userPageData, notes } = await getUser(ctx, pageUrl.toString(), uid);
	const page = unwrap(userPageData) ?? {};
	const basicInfo = unwrap(page.basicInfo ?? page.basic_info ?? page.userInfo ?? page.user_info) ?? {};
	const interactions = unwrap(page.interactions) ?? [];
	const tags = unwrap(page.tags) ?? [];

	const profileNickname = getProfileNickname(userPageData);
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
