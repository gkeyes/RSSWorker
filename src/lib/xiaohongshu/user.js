import puppeteer from '@cloudflare/puppeteer';
import { renderRss2 } from '../../utils/util';

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const unwrap = (value) => value?._rawValue ?? value?._value ?? value?.value ?? value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getHeaders = (cookie = '') => ({
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
	'Cache-Control': 'no-cache',
	Pragma: 'no-cache',
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
		.replaceAll(/\bundefined\b/g, 'null')
		.replaceAll(/\bNaN\b/g, 'null');

	try {
		return JSON.parse(script);
	} catch (error) {
		throw new Error(`小红书 __INITIAL_STATE__ 解析失败: ${error.message}`);
	}
};

const getHtmlAttr = (attrs, name) => {
	const pattern = /([^\s=]+)\s*=\s*(["'])(.*?)\2/g;
	let match;
	const source = String(attrs || '');
	while ((match = pattern.exec(source))) {
		if (match[1].toLowerCase() === String(name).toLowerCase()) {
			return match[3];
		}
	}
	return '';
};

const extractHomeCardLinks = (html) => {
	const links = new Map();
	const samples = [];
	let sectionCount = 0;
	let anchorCount = 0;
	const sectionPattern = /<section\b([^>]*)class=(["'])[^"']*\bnote-item\b[^"']*\2([^>]*)>([\s\S]*?)<\/section>/gi;
	let sectionMatch;

	while ((sectionMatch = sectionPattern.exec(html))) {
		sectionCount++;
		const attrs = String(sectionMatch[1] || '') + ' ' + String(sectionMatch[3] || '');
		const indexMatch = attrs.match(/data-index=(["'])(\d+)\1/i);
		if (!indexMatch) continue;

		const body = sectionMatch[4];
		const anchors = [];
		const anchorPattern = /<a\b([^>]*)>/gi;
		let anchorMatch;

		while ((anchorMatch = anchorPattern.exec(body))) {
			anchorCount++;
			const anchorAttrs = anchorMatch[1];
			const href = getHtmlAttr(anchorAttrs, 'href').replaceAll('&amp;', '&');
			if (!href) continue;
			const className = getHtmlAttr(anchorAttrs, 'class');
			if (samples.length < 12) {
				try {
					const parsed = new URL(href, 'https://www.xiaohongshu.com');
					samples.push({
						path: parsed.pathname,
						className: className.split(/\s+/).slice(0, 6).join('.'),
					});
				} catch {}
			}
			anchors.push({
				href,
				isCover: className.split(/\s+/).includes('cover'),
			});
		}

		const preferred =
			anchors.find((anchor) => anchor.isCover && extractNoteIdFromUrl(anchor.href)) ||
			anchors.find((anchor) => extractNoteIdFromUrl(anchor.href));

		if (preferred) {
			links.set(Number(indexMatch[2]), preferred.href);
		}
	}

	links.debug = {
		sectionCount,
		anchorCount,
		samples,
	};
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
		const cardIndex = Number.isInteger(item.index) ? item.index : index;
		const href = cardLinks.get(cardIndex) || '';
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

	const rowLengths =
		Array.isArray(rawNotes) && rawNotes.every((row) => Array.isArray(row))
			? rawNotes.map((row) => row.length)
			: [Array.isArray(rawNotes) ? rawNotes.length : -1];

	const sampleItem = Array.isArray(selectedNotes) && selectedNotes.length ? selectedNotes[0] : null;
	const sampleCard = sampleItem ? unwrap(sampleItem.noteCard ?? sampleItem.note_card ?? sampleItem) : null;
	const debugSummary = {
		activeTabKeys: Object.keys(activeTab || {}).slice(0, 20),
		activeIndex,
		activeQuery: activeTab?.query ?? '',
		rawNotesType: Array.isArray(rawNotes) ? 'array' : typeof rawNotes,
		rowLengths,
		selectedLength: Array.isArray(selectedNotes) ? selectedNotes.length : -1,
		normalizedLength: notes.length,
		cardLinkCount: cardLinks.size,
		cardSectionCount: cardLinks.debug?.sectionCount ?? 0,
		cardAnchorCount: cardLinks.debug?.anchorCount ?? 0,
		cardHrefSamples: cardLinks.debug?.samples ?? [],
		sampleItemKeys: sampleItem && typeof sampleItem === 'object' ? Object.keys(sampleItem).slice(0, 30) : [],
		sampleCardKeys: sampleCard && typeof sampleCard === 'object' ? Object.keys(sampleCard).slice(0, 30) : [],
		sampleIndex: sampleItem?.index ?? null,
		sampleHasId: Boolean(
			sampleItem?.id ??
				sampleItem?.noteId ??
				sampleItem?.note_id ??
				sampleCard?.noteId ??
				sampleCard?.note_id ??
				sampleCard?.id
		),
	};

	return {
		userPageData,
		notes,
		activeIndex,
		cardLinkCount: cardLinks.size,
		debugSummary,
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

	try {
		const finalUrl = new URL(response.url);
		if (finalUrl.hostname === 'www.xiaohongshu.com' && finalUrl.pathname.startsWith('/login')) {
			throw new Error('小红书匿名主页被重定向到 /login');
		}
	} catch (error) {
		if (String(error?.message || error).includes('重定向到 /login')) throw error;
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
		const summary = data.debugSummary ? JSON.stringify(data.debugSummary) : '';
		diagnostics.push(`${hasProfile(data) ? 'fetch=profile-only' : 'fetch=empty'}${summary ? ':' + summary : ''}`);
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
		const summary = data.debugSummary ? JSON.stringify(data.debugSummary) : '';
		diagnostics.push(`${hasProfile(data) ? 'browser=profile-only' : 'browser=empty'}${summary ? ':' + summary : ''}`);
	} catch (error) {
		const message = String(error?.message || error);
		if (message.includes('风控校验已触发')) throw error;
		diagnostics.push(`browser=${message}`);
	}

	throw new Error(`匿名 xsec_token 模式仍未抓到发布笔记；${diagnostics.join(' | ')}`);
};

const normalizeMediaUrl = (value) => {
	if (!value) return '';
	try {
		const url = new URL(value);
		if (url.protocol === 'http:' && (url.hostname === 'xhscdn.com' || url.hostname.endsWith('.xhscdn.com'))) {
			url.protocol = 'https:';
		}
		return url.toString();
	} catch {
		return String(value);
	}
};

const getCoverUrl = (cover) => {
	cover = unwrap(cover) ?? {};
	const infoList = unwrap(cover.infoList ?? cover.info_list);
	let value = '';
	if (Array.isArray(infoList) && infoList.length) {
		const item = infoList[infoList.length - 1] ?? infoList[0];
		value = item?.url ?? item?.urlDefault ?? item?.url_default ?? item?.urlPre ?? item?.url_pre ?? '';
	} else {
		value = cover.urlDefault ?? cover.url_default ?? cover.urlPre ?? cover.url_pre ?? cover.url ?? '';
	}
	return normalizeMediaUrl(value);
};

const getAnonymousGuid = (coverUrl, author, displayTitle, noteTime) => {
	try {
		const url = new URL(coverUrl);
		const last = url.pathname.split('/').filter(Boolean).pop() || '';
		const mediaId = last.split('!')[0];
		if (mediaId) return `xhs-cover:${mediaId}`;
	} catch {}
	return `xhs-anon:${author || ''}:${noteTime || ''}:${displayTitle || ''}`;
};

const toRssItem = (item, fallbackAuthor) => {
	item = unwrap(item) ?? {};
	const noteCard = unwrap(item.noteCard ?? item.note_card ?? item) ?? {};
	const noteId = noteCard.noteId ?? noteCard.note_id ?? noteCard.id ?? item.id ?? item.noteId ?? item.note_id;

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
		(noteId ? `小红书笔记 ${noteId}` : '小红书笔记');

	const author = noteUser.nickname ?? noteUser.nickName ?? noteUser.nick_name ?? noteUser.name ?? fallbackAuthor;
	const coverUrl = getCoverUrl(noteCard.cover ?? item.cover);
	const xsecToken = item.xsecToken ?? item.xsec_token ?? noteCard.xsecToken ?? noteCard.xsec_token;

	let link = coverUrl || '';
	if (noteId) {
		const noteUrl = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
		if (xsecToken) {
			noteUrl.searchParams.set('xsec_token', xsecToken);
			noteUrl.searchParams.set('xsec_source', 'pc_user');
		}
		link = noteUrl.toString();
	}

	// Anonymous profile SSR currently redacts noteId for some users while still
	// exposing the full note card. Keep those cards in the feed using the cover
	// URL as the stable item link, matching RSSHub's list-feed fallback strategy.
	if (!link) return null;

	const guid = noteId || getAnonymousGuid(coverUrl, author, displayTitle, noteCard.time ?? item.time);

	return {
		title: String(displayTitle).trim() || (noteId ? `小红书笔记 ${noteId}` : '小红书笔记'),
		link,
		guid,
		description: `${coverUrl ? `<img src="${coverUrl}"><br>` : ''}${displayTitle}`,
		author,
		upvotes: interactInfo.likedCount ?? interactInfo.liked_count,
	};
};


const debugBrowserNoteId = async (ctx, url, uid) => {
	if (!ctx.env?.BROWSER) throw new Error('Cloudflare Browser Run binding 不可用');
	let browser;
	try {
		browser = await puppeteer.launch(ctx.env.BROWSER);
		const page = await browser.newPage();
		await page.setUserAgent(USER_AGENT);
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const type = request.resourceType();
			if (['document', 'script', 'xhr', 'fetch', 'other'].includes(type)) request.continue();
			else request.abort();
		});
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
		await sleep(1200);

		const collect = async () =>
			page.evaluate((targetUid) => {
				const hex = /[0-9a-fA-F]{24}/g;
				const uniqueHex = (value) => {
					const out = [];
					for (const match of String(value || '').matchAll(hex)) {
						const id = match[0].toLowerCase();
						if (id !== String(targetUid || '').toLowerCase() && !out.includes(id)) out.push(id);
						if (out.length >= 40) break;
					}
					return out;
				};
				const noteState = window.__INITIAL_STATE__?.note || null;
				const noteStateText = (() => {
					try { return JSON.stringify(noteState); } catch { return ''; }
				})();
				const htmlText = document.documentElement.outerHTML;
				const userState = window.__INITIAL_STATE__?.user || {};
				const unwrapRef = (value) => value?._rawValue ?? value?._value ?? value?.value ?? value;
				const rawNotes = unwrapRef(userState.notes) || [];
				const activeTab = unwrapRef(userState.activeTab) || {};
				const row = Array.isArray(rawNotes) && Array.isArray(rawNotes[activeTab.index || 0]) ? rawNotes[activeTab.index || 0] : [];
				const noteTimeMatches = row.slice(0, 12).map((entry, index) => {
					const card = unwrapRef(entry?.noteCard ?? entry?.note_card ?? entry) || {};
					const rawTime = Number(card.time ?? entry?.time ?? 0);
					const seconds = rawTime > 1e12 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
					const prefix = seconds > 0 ? seconds.toString(16).padStart(8, '0').slice(-8) : '';
					const pattern = prefix ? new RegExp(prefix + '[0-9a-fA-F]{16}', 'gi') : null;
					const matches = pattern ? [...new Set(htmlText.match(pattern) || [])].slice(0, 12) : [];
					return {
						index,
						title: String(card.displayTitle ?? card.display_title ?? card.title ?? '').slice(0, 120),
						time: rawTime,
						prefix,
						matches,
					};
				});
				const sections = Array.from(document.querySelectorAll('section.note-item')).slice(0, 8).map((section) => {
					const links = Array.from(section.querySelectorAll('a')).slice(0, 8).map((a) => ({
						raw: a.getAttribute('href') || '',
						href: a.href || '',
						className: typeof a.className === 'string' ? a.className : '',
					}));
					const vueKeys = Object.getOwnPropertyNames(section).filter((key) => key.startsWith('__vue') || key === '_vei');
					let vueHex = [];
					for (const key of vueKeys) {
						try {
							const seen = new WeakSet();
							const text = JSON.stringify(section[key], (name, value) => {
								if (typeof value === 'object' && value) {
									if (seen.has(value)) return undefined;
									seen.add(value);
								}
								if (name === 'parent' || name === 'appContext' || name === 'subTree' || name === 'vnode') return undefined;
								return value;
							});
							vueHex = vueHex.concat(uniqueHex(text));
						} catch {}
					}
					return {
						index: section.getAttribute('data-index'),
						attrs: Array.from(section.attributes).map((a) => [a.name, a.value]).slice(0, 12),
						links,
						vueKeys,
						vueHex: [...new Set(vueHex)].slice(0, 10),
					};
				});
				return {
					url: location.href,
					htmlHex: uniqueHex(document.documentElement.outerHTML),
					noteStateKeys: noteState && typeof noteState === 'object' ? Object.keys(noteState).slice(0, 30) : [],
					noteStateHex: uniqueHex(noteStateText),
					noteTimeMatches,
					sections,
				};
			}, uid);

		const before = await collect();
		const card = await page.$('section.note-item .cover, section.note-item a.cover, section.note-item');
		let clickError = '';
		if (card) {
			try {
				await card.click();
				await sleep(1500);
			} catch (error) {
				clickError = String(error?.message || error);
			}
		}
		const after = await collect();
		return { before, after, clickError };
	} finally {
		if (browser) await browser.close().catch(() => {});
	}
};


const debugSearchNote = async (ctx, keyword) => {
	if (!ctx.env?.BROWSER) throw new Error('Cloudflare Browser Run binding 不可用');
	let browser;
	try {
		browser = await puppeteer.launch(ctx.env.BROWSER);
		const page = await browser.newPage();
		await page.setUserAgent(USER_AGENT);
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const type = request.resourceType();
			if (['document', 'script', 'xhr', 'fetch', 'other', 'stylesheet'].includes(type)) request.continue();
			else request.abort();
		});
		await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
		await sleep(1200);

		let inputFound = false;
		try {
			await page.waitForSelector('#search-input', { timeout: 5000 });
			inputFound = true;
		} catch {}

		const before = await page.evaluate(() => ({
			url: location.href,
			title: document.title,
			hasInput: Boolean(document.querySelector('#search-input')),
			loginWall: /登录|扫码登录|登录后/.test(document.body?.innerText || ''),
			securityWall: /安全限制|请求太频繁|访问频次异常|验证码/.test(document.body?.innerText || ''),
		}));

		if (!inputFound) return { before, submitted: false, results: [] };

		await page.focus('#search-input');
		await page.evaluate(() => {
			const el = document.querySelector('#search-input');
			if (el) {
				el.value = '';
				el.dispatchEvent(new Event('input', { bubbles: true }));
			}
		});
		await page.type('#search-input', keyword, { delay: 15 });
		await page.keyboard.press('Enter');
		await sleep(3500);

		const after = await page.evaluate((query) => {
			const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
			const rows = [];
			for (const section of document.querySelectorAll('section.note-item')) {
				const link =
					section.querySelector('a.cover.mask') ||
					section.querySelector('a[href*="/search_result/"]') ||
					section.querySelector('a[href*="/explore/"]');
				const title =
					clean(section.querySelector('.title, .note-title, a.title')?.textContent) ||
					clean(link?.querySelector('span')?.textContent);
				const href = link?.href || link?.getAttribute('href') || '';
				if (title || href) rows.push({ title, href });
				if (rows.length >= 20) break;
			}
			return {
				url: location.href,
				title: document.title,
				loginWall: /登录后查看搜索结果|扫码登录/.test(document.body?.innerText || ''),
				securityWall: /安全限制|请求太频繁|访问频次异常|验证码/.test(document.body?.innerText || ''),
				query,
				rows,
			};
		}, keyword);
		return { before, submitted: true, after };
	} finally {
		if (browser) await browser.close().catch(() => {});
	}
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

	if (cache && ctx.req.query('refresh') !== '1' && ctx.req.query('debug') !== 'noteid') {
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

	if (ctx.req.query('debug') === 'noteid') {
		return ctx.json(await debugBrowserNoteId(ctx, pageUrl.toString(), uid));
	}
	if (ctx.req.query('debug') === 'search') {
		return ctx.json(await debugSearchNote(ctx, ctx.req.query('keyword') || ''));
	}

	const userResult = await getUser(ctx, pageUrl.toString());
	const { userPageData, notes, source, debugSummary } = userResult;
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
		const sample = notes[0] ?? {};
		const card = unwrap(sample.noteCard ?? sample.note_card ?? sample) ?? {};
		const detail = {
			source: source ?? 'unknown',
			notesLength: notes.length,
			debugSummary: debugSummary ?? null,
			sampleItemKeys: sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 40) : [],
			sampleCardKeys: card && typeof card === 'object' ? Object.keys(card).slice(0, 40) : [],
		};
		throw new Error(`小红书用户资料已获取，但没有可用于 RSS 的笔记条目；${JSON.stringify(detail)}`);
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
