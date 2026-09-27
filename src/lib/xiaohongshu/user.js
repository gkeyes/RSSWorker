import { renderRss2 } from '../../utils/util';

const unwrap = (value) => value?._rawValue ?? value?._value ?? value;

const browserHeaders = {
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
	'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
	'Cache-Control': 'no-cache',
	Pragma: 'no-cache',
	Referer: 'https://www.xiaohongshu.com/',
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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

const getBrowserState = async (ctx, url) => {
	if (!ctx.env?.BROWSER?.quickAction) {
		throw new Error('Cloudflare Browser Run binding 不可用');
	}

	const cookieString = ctx.env.XIAOHONGSHU_COOKIE || '';
	const cookies = parseBrowserCookies(cookieString);

	const response = await ctx.env.BROWSER.quickAction('content', {
		url,
		...(cookies.length ? { cookies } : {}),
		gotoOptions: {
			waitUntil: 'networkidle2',
			timeout: 30000,
		},
		waitForTimeout: 3000,
		rejectResourceTypes: ['image', 'media', 'font'],
		addScriptTag: [
			{
				content: `(() => {
					try {
						const value = JSON.stringify(window.__INITIAL_STATE__ || {});
						document.documentElement.setAttribute('data-rss-xhs-state', encodeURIComponent(value));
					} catch (error) {
						document.documentElement.setAttribute('data-rss-xhs-error', encodeURIComponent(String(error)));
					}
				})();`,
			},
		],
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(`Browser Run 请求失败: HTTP ${response.status} ${detail}`);
	}

	const payload = await response.json();
	if (!payload?.success || typeof payload.result !== 'string') {
		throw new Error('Browser Run 未返回可解析的 HTML');
	}

	const html = payload.result;
	const match = html.match(/data-rss-xhs-state="([^"]*)"/);
	if (!match) {
		const errorMatch = html.match(/data-rss-xhs-error="([^"]*)"/);
		const detail = errorMatch ? decodeURIComponent(errorMatch[1]) : '未找到运行时状态';
		throw new Error(`Browser Run 无法读取小红书运行时数据: ${detail}`);
	}

	let state;
	try {
		state = JSON.parse(decodeURIComponent(match[1]));
	} catch (error) {
		throw new Error(`Browser Run 小红书状态解析失败: ${error.message}`);
	}

	return parseUserState(state);
};

const hasUsefulData = ({ userPageData, notes }) => {
	const page = unwrap(userPageData) ?? {};
	const basicInfo = unwrap(page.basicInfo ?? page.basic_info ?? page.userInfo ?? page.user_info) ?? {};
	const nickname = basicInfo.nickname ?? basicInfo.nickName ?? basicInfo.name;
	return Boolean(nickname || notes.length);
};

const getUser = async (ctx, url) => {
	try {
		const staticData = await getStaticState(url);
		if (hasUsefulData(staticData)) return staticData;
	} catch {
		// Static SSR is only a fast path. Browser Run is the authoritative fallback.
	}

	const browserData = await getBrowserState(ctx, url);
	if (hasUsefulData(browserData)) return browserData;

	if (!ctx.env.XIAOHONGSHU_COOKIE) {
		throw new Error('Browser Run 已执行，但小红书仍返回空用户数据；请配置 XIAOHONGSHU_COOKIE 登录态');
	}

	throw new Error('Browser Run 已执行，但小红书仍返回空用户数据；XIAOHONGSHU_COOKIE 可能已失效');
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

const deal = async (ctx) => {
	const { uid } = ctx.req.param();
	const pageUrl = new URL(`https://www.xiaohongshu.com/user/profile/${uid}`);
	const xsecToken = ctx.req.query('xsec_token');

	if (xsecToken) {
		pageUrl.searchParams.set('xsec_token', xsecToken);
		pageUrl.searchParams.set('xsec_source', ctx.req.query('xsec_source') || 'app_share');
	}

	const { userPageData, notes } = await getUser(ctx, pageUrl.toString());
	const page = unwrap(userPageData) ?? {};
	const basicInfo = unwrap(page.basicInfo ?? page.basic_info ?? page.userInfo ?? page.user_info) ?? {};
	const interactions = unwrap(page.interactions) ?? [];
	const tags = unwrap(page.tags) ?? [];

	const profileNickname = basicInfo.nickname ?? basicInfo.nickName ?? basicInfo.name;
	const firstNote = notes[0] ? unwrap(notes[0]) : null;
	const firstCard = firstNote ? unwrap(firstNote.noteCard ?? firstNote.note_card ?? firstNote) : null;
	const firstUser = firstCard ? unwrap(firstCard.user ?? firstNote.user) : null;
	const noteNickname = firstUser?.nickname ?? firstUser?.nickName ?? firstUser?.nick_name ?? firstUser?.name;
	const feedTitle = profileNickname ?? noteNickname ?? `小红书用户 ${uid}`;

	const items = notes.map((item) => toRssItem(item, feedTitle)).filter(Boolean);
	if (!profileNickname && !items.length) {
		throw new Error('小红书运行时状态存在，但没有可用的用户资料或笔记');
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

	ctx.header('Content-Type', 'application/rss+xml; charset=UTF-8');
	return ctx.body(
		renderRss2({
			title: `${feedTitle} - 笔记 • 小红书 / RED`,
			description: descriptionParts.join(' ') || `${feedTitle} 的小红书笔记`,
			image,
			link: `https://www.xiaohongshu.com/user/profile/${uid}`,
			items,
		})
	);
};

const setup = (route) => {
	route.get('/xiaohongshu/user/:uid', deal);
};

export default { setup };
