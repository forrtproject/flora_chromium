const fs = require('node:fs');

module.exports = async ({github, context}) => {
  const {owner, repo} = context.repo;
  const pull_number = Number(process.env.VISUAL_PR);
  const run_id = Number(process.env.VISUAL_RUN_ID);
  const {data: pr} = await github.rest.pulls.get({owner, repo, pull_number});
  const {data: run} = await github.rest.actions.getWorkflowRun({owner, repo, run_id});
  if (pr.state !== 'open' || pr.head.sha !== run.head_sha || pr.head.repo?.full_name !== run.head_repository.full_name) return;
  let results;
  try {
    const raw = fs.readFileSync('visual-report/results.json', 'utf8');
    if (raw.length > 100000) throw new Error('Oversized results');
    results = JSON.parse(raw);
    if (!Array.isArray(results) || results.length === 0 || results.length > 100 ||
        new Set(results.map(r => r?.name)).size !== results.length ||
        results.some(r => !/^[a-z0-9-]+$/.test(r.name) ||
          !['pass', 'fail'].includes(r.status) || typeof r.detail !== 'string' ||
          (r.status === 'fail' && r.changed !== true))) results = undefined;
  } catch { results = undefined; }
  const captured = run.conclusion === 'success' && !!results;
  const changed = captured ? results.filter(r => r.changed) : [];
  const files = await github.paginate(github.rest.pulls.listFiles, {owner, repo, pull_number});
  const screenshotPath = /^(tests\/visual\/(baselines|review-evidence)\/|docs\/img\/).+\.(png|jpe?g|webp)$/i;
  const baselineFiles = files.filter(f => [f.filename, f.previous_filename].some(name => name && screenshotPath.test(name)));
  // A PR controls its capture job and artifacts. Changes to that machinery
  // cannot certify themselves as unchanged and bypass human review.
  const capturePath = /^(tests\/visual\/|tests\/fixtures\/(article-with-dois|doi-in-table|retracted)\.html$|\.github\/(workflows\/visual[^/]*\.yml|scripts\/visual-publish\.cjs)$|package(?:-lock)?\.json$|esbuild\.config\.ts$|manifest\.json$|tsconfig[^/]*\.json$|\.npmrc$)/;
  const captureFiles = files.filter(f => [f.filename, f.previous_filename].some(name => name && capturePath.test(name)));
  const needsApproval = changed.length > 0 || captureFiles.length > 0 || baselineFiles.length > 0;
  let approved = false;
  if (captured && needsApproval) {
    const reviews = await github.paginate(github.rest.pulls.listReviews, {owner, repo, pull_number});
    const latest = new Map();
    for (const review of reviews) {
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review);
    }
    for (const review of latest.values()) {
      if (review.state !== 'APPROVED' || review.commit_id !== pr.head.sha ||
          review.user.login === pr.user.login || review.user.type !== 'User' ||
          !/^visual approved[.!]?\s*$/im.test(review.body ?? '') ||
          Date.parse(review.submitted_at) < Date.parse(run.updated_at)) continue;
      const {data: permission} = await github.rest.repos.getCollaboratorPermissionLevel({owner, repo, username: review.user.login});
      if (['admin', 'maintain', 'write'].includes(permission.permission)) approved = true;
    }
  }
  const conclusion = !captured ? 'failure' : needsApproval && !approved ? 'action_required' : 'success';
  const artifacts = await github.rest.actions.listWorkflowRunArtifacts({owner, repo, run_id});
  const artifact = artifacts.data.artifacts.find(a => a.name === 'visual-report' && !a.expired);
  const link = artifact ? `${run.html_url}/artifacts/${artifact.id}` : run.html_url;
  const safe = s => String(s).replace(/[^a-zA-Z0-9 .,:()_=!<>-]/g, '').slice(0, 200);
  const summary = captured ? `${changed.length} of ${results.length} fixtures changed. ${baselineFiles.length} committed screenshots changed. ${captureFiles.length} capture/configuration files changed; these also require review.\n\n` +
    changed.map(r => `- ${safe(r.name)}: ${safe(r.detail)}`).join('\n') :
    'Capture failed or results are missing. Inspect the logs; this is not visual approval.';
  const htmlLabel = s => String(s).slice(0, 200).replace(/[&<>"'\r\n]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;', '\n': '&#10;',
  })[char]);
  // Reserve space for the author's text and the review instructions/status.
  const previewLimit = Math.max(0, Math.min(20000, 28000 - summary.length,
    62000 - (pr.body ?? '').length - summary.length));
  let previewChars = 0, omittedPreviews = 0;
  const baselineEvidence = baselineFiles.map(f => {
    const encodePath = path => path.split("/").map(encodeURIComponent).join("/");
    const oldName = f.previous_filename ?? f.filename;
    const beforeExists = f.status !== 'added' && screenshotPath.test(oldName);
    const afterExists = f.status !== 'removed' && screenshotPath.test(f.filename);
    const beforePath = encodePath(oldName);
    const before = `https://raw.githubusercontent.com/${pr.base.repo.full_name}/${pr.base.sha}/${beforePath}`;
    const after = `https://raw.githubusercontent.com/${pr.head.repo.full_name}/${pr.head.sha}/${encodePath(f.filename)}`;
    const preview = `\n<details open><summary>${htmlLabel(f.filename)}</summary>\n\n| Committed base | Committed PR |\n| --- | --- |\n| ${beforeExists ? `![Before](${before})` : 'New screenshot'} | ${afterExists ? `![After](${after})` : 'Removed screenshot'} |\n\n</details>`;
    if (previewChars + preview.length > previewLimit) { omittedPreviews++; return ''; }
    previewChars += preview.length;
    return preview;
  }).join('\n') + (omittedPreviews ? `\n${omittedPreviews} additional screenshot previews omitted to keep this description within GitHub's limit. [Review all screenshot files](https://github.com/${owner}/${repo}/pull/${pull_number}/files).` : '');
  const start = '<!-- flora-visual:start -->' , end = '<!-- flora-visual:end -->';
  const block = `${start}\n### Visual review\n\nCommit: \`${pr.head.sha}\`\n\n${summary}\n${baselineEvidence}\n\n[Download before/after/diff report](${link}) · [Capture logs](${run.html_url})\n\nVisual approval: **${conclusion}**. When screenshots change, a collaborator with write access must inspect index.html in the downloaded report, then submit an approving review containing **Visual approved** on this commit. Approval must follow this capture; new commits or captures require a new visual review.\n${end}`;
  const {data: fresh} = await github.rest.pulls.get({owner, repo, pull_number});
  if (fresh.head.sha !== pr.head.sha) return;
  const body = fresh.body ?? '';
  const from = body.indexOf(start), to = body.indexOf(end, from);
  const next = from >= 0 && to >= from ? body.slice(0, from) + block + body.slice(to + end.length) : body + '\n\n' + block;
  if (next.length <= 65000) await github.rest.pulls.update({owner, repo, pull_number, body: next});
  else console.warn('Visual evidence did not fit the existing PR description; see the status report and Files changed.');
  await github.rest.repos.createCommitStatus({owner, repo, sha: pr.head.sha,
    context: 'Visual approval', target_url: link,
    state: conclusion === 'success' ? 'success' : conclusion === 'failure' ? 'failure' : 'pending',
    description: !captured ? 'Visual capture failed' : needsApproval && !approved ?
      'Changed screenshots require a Visual approved review' : 'Visual review satisfied'});
};
