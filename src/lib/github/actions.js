import { renderRss2 } from '../../utils/util';

const API_VERSION = '2022-11-28';

const escapeHtml = (value) =>
	String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

const safeCdata = (value) => String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>');

const buildApiUrl = (owner, repo, workflow) => {
	const url = new URL(
		'https://api.github.com/repos/' +
			encodeURIComponent(owner) +
			'/' +
			encodeURIComponent(repo) +
			'/actions/workflows/' +
			encodeURIComponent(workflow) +
			'/runs'
	);
	url.searchParams.set('status', 'success');
	url.searchParams.set('per_page', '30');
	return url.href;
};

const runToItem = (run, meta) => {
	const shortSha = String(run?.head_sha || '').slice(0, 7);
	const repoUrl = 'https://github.com/' + encodeURIComponent(meta.owner) + '/' + encodeURIComponent(meta.repo);
	const details = [
		['Workflow', run?.name || meta.workflow],
		['Run', run?.run_number ? '#' + run.run_number : ''],
		['Branch', run?.head_branch || ''],
		['Event', run?.event || ''],
		['Actor', run?.actor?.login || ''],
		['Commit', shortSha],
		['Conclusion', run?.conclusion || 'success'],
	]
		.filter((entry) => entry[1])
		.map((entry) => '<strong>' + escapeHtml(entry[0]) + ':</strong> ' + escapeHtml(entry[1]))
		.join('<br>');

	return {
		title: safeCdata(run?.display_title || (run?.name || meta.workflow) + (run?.run_number ? ' #' + run.run_number : '')),
		link: run?.html_url || repoUrl + '/actions',
		description: details,
		pubDate: run?.updated_at || run?.run_started_at || run?.created_at || new Date().toUTCString(),
		guid: String(run?.id || run?.html_url || ''),
		category: 'GitHub Actions',
		source: {
			title: meta.owner + '/' + meta.repo,
			url: repoUrl,
		},
	};
};

const deal = async (ctx) => {
	const { owner, repo, workflow } = ctx.req.param();
	const apiUrl = buildApiUrl(owner, repo, workflow);
	const headers = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': API_VERSION,
		'User-Agent': 'RSSWorker',
	};
	const token = ctx.env?.GITHUB_TOKEN;
	if (token) headers.Authorization = 'Bearer ' + token;

	const response = await fetch(apiUrl, { headers });
	if (!response.ok) {
		let message = '';
		try {
			const payload = await response.json();
			message = payload?.message ? ' · ' + payload.message : '';
		} catch (_) {}
		return ctx.text('GitHub API HTTP ' + response.status + message, response.status);
	}

	const payload = await response.json();
	const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
	const meta = { owner, repo, workflow };
	const repoUrl = 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
	const workflowUrl = repoUrl + '/actions/workflows/' + encodeURIComponent(workflow);
	const items = runs.filter((run) => run?.conclusion === 'success').map((run) => runToItem(run, meta));
	const workflowName = runs[0]?.name || workflow;

	const data = {
		title: safeCdata(owner + '/' + repo + ' · ' + workflowName + ' · 成功构建'),
		link: workflowUrl,
		description: 'GitHub Actions successful workflow runs for ' + owner + '/' + repo,
		language: 'zh-cn',
		category: 'GitHub Actions',
		items,
	};

	ctx.header('Content-Type', 'application/rss+xml; charset=UTF-8');
	ctx.header('Cache-Control', 'public, max-age=300');
	return ctx.body(renderRss2(data));
};

const setup = (route) => {
	route.get('/github/actions/:owner/:repo/:workflow', deal);
};

export default { setup };
export { buildApiUrl, runToItem };
