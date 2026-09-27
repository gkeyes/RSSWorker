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

const extractInitialState = async (res) => {
	const scripts = [];
	const rewriter = new HTMLRewriter()
		.on('script', {
			element() {
				scripts.push('');
			},
			text(text) {
				if (scripts.length) {
					scripts[scripts.length - 1] += text.text;
				}
			},
		})
		.transform(res);

	await rewriter.text();

	const marker = 'window.__INITIAL_STATE__=';
	const source = scripts.find((script) => script.includes(marker));
	if (!source) {
		throw new Error('小红书未返回 __INITIAL_STATE__，可能触发了风控或页面结构已经变化');
	}

	let script = source.slice(source.indexOf(marker) + marker.length).trim();
	script = script.replace(/;\s*$/, '');
	script = script.replaceAll(/new Map\(\s*\[\s*\]\s*\)/g, 'null').replaceAll(/\bundefined\b/g, 'null');

	try {
		return JSON.parse(script);
	} catch (error) {
		throw new Error(`小红书初始化数据解析失败: ${error.message}`);
	}
};

const getUser = async (url) => {
	const res = await fetch(url, {
		headers: browserHeaders,
		redirect: 'follow',
	});

	if (!res.ok) {
		throw new Error(`小红书主页请求失败: HTTP ${res.status}`);
	}

	const state = await extractInitialState(res);
	const user = unwrap(state?.user);
	if (!user || typeof user !== 'object') {
		throw new Error('小红书未返回用户数据，可能触发了风控或页面结构已经变化');
	}

	const userPageData = unwrap(user.userPageData ?? user.userInfo ?? {});
	const notes = unwrap(user.notes ?? userPageData?.notes ?? []);
	const collect = unwrap(user.collect);

	return { userPageData, notes, collect };
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

const normalizeNotes = (notes) => {
	if (!Array.isArray(notes)) {
		return [];
	}
	return notes.flatMap((group) => (Array.isArray(group) ? group : [group])).filter(Boolean);
};

const deal = async (ctx) => {
	const { uid } = ctx.req.param();
	const url = `https://www.xiaohongshu.com/user/profile/${uid}`;
	const { userPageData, notes } = await getUser(url);

	const page = unwrap(userPageData) ?? {};
	const basicInfo = unwrap(page.basicInfo ?? page.basic_info ?? page.userInfo ?? page.user_info) ?? {};
	const interactions = unwrap(page.interactions) ?? [];
	const tags = unwrap(page.tags) ?? [];
	const normalizedNotes = normalizeNotes(notes);

	const nickname = basicInfo.nickname ?? basicInfo.nickName ?? basicInfo.name;
	if (!nickname && !normalizedNotes.length) {
		throw new Error('小红书未返回用户资料或笔记，可能触发了风控；请稍后重试');
	}

	const feedTitle = nickname || `小红书用户 ${uid}`;
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

	const image = basicInfo.imageb ?? basicInfo.images ?? basicInfo.avatar ?? basicInfo.image;

	const items = normalizedNotes
		.map((item) => {
			const noteCard = unwrap(item?.noteCard ?? item?.note_card ?? item) ?? {};
			const noteId = noteCard.noteId ?? noteCard.note_id ?? item?.id ?? item?.noteId ?? item?.note_id;
			if (!noteId) {
				return null;
			}

			const noteUser = unwrap(noteCard.user) ?? {};
			const interactInfo = unwrap(noteCard.interactInfo ?? noteCard.interact_info) ?? {};
			const displayTitle = noteCard.displayTitle ?? noteCard.display_title ?? noteCard.title ?? noteCard.desc ?? `小红书笔记 ${noteId}`;
			const author = noteUser.nickname ?? noteUser.nickName ?? noteUser.name ?? feedTitle;
			const coverUrl = getCoverUrl(noteCard.cover);
			const xsecToken = item?.xsecToken ?? item?.xsec_token ?? noteCard.xsecToken ?? noteCard.xsec_token;
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
		})
		.filter(Boolean);

	ctx.header('Content-Type', 'application/rss+xml; charset=UTF-8');
	return ctx.body(
		renderRss2({
			title: `${feedTitle} - 笔记 • 小红书 / RED`,
			description: descriptionParts.join(' '),
			image,
			link: url,
			items,
		})
	);
};

const setup = (route) => {
	route.get('/xiaohongshu/user/:uid', deal);
};

export default { setup };
