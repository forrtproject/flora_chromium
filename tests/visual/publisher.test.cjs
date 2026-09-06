const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const publish = require('../../.github/scripts/visual-publish.cjs');

// Exercise the publisher through its GitHub API boundary, without network calls.
async function scenario({changed = false, review, files = [], failure = false,
  stale = false, permission = 'write', results, authorBody} = {}) {
  fs.writeFileSync('visual-report/results.json', JSON.stringify(results ?? [{
    name: 'fixture', status: changed ? 'fail' : 'pass', detail: '120 px differ',
    ...(changed ? {changed: true} : {}),
  }]));
  const pr = {
    number: 215, state: 'open', user: {login: 'author'},
    head: {sha: 'abc', repo: {full_name: 'o/r'}},
    base: {sha: 'def', repo: {full_name: 'o/r'}},
    body: authorBody ?? 'Keep this author paragraph.',
  };
  const run = {
    head_sha: stale ? 'old' : 'abc', head_repository: {full_name: 'o/r'},
    conclusion: failure ? 'failure' : 'success',
    updated_at: '2026-09-06T10:00:00Z',
    html_url: 'https://github.com/o/r/actions/runs/123',
  };
  let body, state;
  const github = {
    rest: {
      pulls: {
        get: async () => ({data: pr}), listFiles: 'files', listReviews: 'reviews',
        update: async input => { body = input.body; },
      },
      actions: {
        getWorkflowRun: async () => ({data: run}),
        listWorkflowRunArtifacts: async () => ({data: {artifacts: [{id: 1, name: 'visual-report'}]}}),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({data: {permission}}),
        createCommitStatus: async input => { state = input.state; },
      },
    },
    paginate: async method => method === 'files' ? files : review ? [review] : [],
  };
  await publish({github, context: {repo: {owner: 'o', repo: 'r'}}});
  if (body) assert.ok(body.startsWith(pr.body), 'preserve the author description');
  return {state, body};
}

const approved = {
  state: 'APPROVED', commit_id: 'abc', user: {login: 'reviewer', type: 'User'},
  body: 'Visual approved', submitted_at: '2026-09-06T10:01:00Z',
};

test('visual publication policy', async t => {
  const previousCwd = process.cwd();
  const previousEnv = {VISUAL_PR: process.env.VISUAL_PR, VISUAL_RUN_ID: process.env.VISUAL_RUN_ID};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-publisher-'));
  t.after(() => {
    process.chdir(previousCwd);
    fs.rmSync(root, {recursive: true, force: true});
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.chdir(root);
  fs.mkdirSync('visual-report');
  process.env.VISUAL_PR = '215';
  process.env.VISUAL_RUN_ID = '123';

  await t.test('requires a current human approval after capture', async () => {
    assert.equal((await scenario()).state,'success');
    assert.equal((await scenario({changed:true})).state,'pending');
    assert.equal((await scenario({changed:true,review:approved})).state,'success');
    assert.equal((await scenario({changed:true,review:{...approved,commit_id:'old'}})).state,'pending');
    assert.equal((await scenario({changed:true,review:{...approved,user:{login:'author',type:'User'}}})).state,'pending');
    assert.equal((await scenario({changed:true,review:approved,permission:'read'})).state,'pending');
    assert.equal((await scenario({changed:true,review:{...approved,submitted_at:'2026-09-06T09:59:00Z'}})).state,'pending');
    assert.equal((await scenario({changed:true,review:{...approved,state:'DISMISSED'}})).state,'pending');
    assert.equal((await scenario({changed:true,review:{...approved,body:'Not visual approved'}})).state,'pending');
  });

  await t.test('rejects failed, stale and duplicate evidence', async () => {
    assert.equal((await scenario({failure:true,review:approved})).state,'failure');
    assert.equal((await scenario({stale:true})).state,undefined);
    const duplicate = [{name:'fixture',status:'pass',detail:'0 px differ'},{name:'fixture',status:'pass',detail:'0 px differ'}];
    assert.equal((await scenario({results:duplicate})).state,'failure');
  });

  await t.test('requires review only for screenshots and capture inputs', async () => {
    const baseline=await scenario({files:[{filename:'tests/visual/baselines/fixture.png',status:'modified'}]});
    assert.equal(baseline.state,'pending'); assert.match(baseline.body,/raw.githubusercontent.com/);
    assert.equal((await scenario({files:[{filename:'tests/visual/run.ts',status:'modified'}]})).state,'pending');
    assert.equal((await scenario({files:[{filename:'package.json',status:'modified'}],review:approved})).state,'success');
    assert.equal((await scenario({files:[{filename:'tests/fixtures/no-dois.html',status:'modified'}]})).state,'success');
    for (const name of ['article-with-dois','doi-in-table','retracted']) {
     assert.equal((await scenario({files:[{filename:`tests/fixtures/${name}.html`,status:'modified'}]})).state,'pending');
    }
    assert.equal((await scenario({files:[{filename:'tests/fixtures/no-longer-used.html',previous_filename:'tests/fixtures/retracted.html',status:'renamed'}]})).state,'pending');
  });

  await t.test('preserves screenshot rename evidence and escapes labels', async () => {
    const movedOut = await scenario({files:[{filename:'archive/old.png',previous_filename:'docs/img/popup.png',status:'renamed'}]});
    assert.equal(movedOut.state,'pending'); assert.match(movedOut.body,/!\[Before\].*def\/docs\/img\/popup.png/);
    assert.match(movedOut.body,/Removed screenshot/); assert.doesNotMatch(movedOut.body,/!\[After\]/);
    const movedIn = await scenario({files:[{filename:'docs/img/new.png',previous_filename:'archive/new.png',status:'renamed'}]});
    assert.equal(movedIn.state,'pending'); assert.match(movedIn.body,/New screenshot/); assert.doesNotMatch(movedIn.body,/!\[Before\]/);
    assert.match(movedIn.body,/!\[After\].*abc\/docs\/img\/new.png/);
    const renamed = await scenario({files:[{filename:'docs/img/new.png',previous_filename:'docs/img/old.png',status:'renamed'}]});
    assert.match(renamed.body,/!\[Before\].*def\/docs\/img\/old.png/); assert.match(renamed.body,/!\[After\].*abc\/docs\/img\/new.png/);
    const escaped = await scenario({files:[{filename:'docs/img/a<b&c>.png',status:'added'}]});
    assert.match(escaped.body,/<summary>docs\/img\/a&lt;b&amp;c&gt;.png<\/summary>/);
    assert.match(escaped.body,/abc\/docs\/img\/a%3Cb%26c%3E.png/);
  });

  await t.test('bounds inline previews without dropping approval requirements', async () => {
    const longFiles = Array.from({length:100},(_,i)=>({filename:`docs/img/${i}-${'&'.repeat(500)}.png`,status:'added'}));
    const bounded = await scenario({files:longFiles});
    assert.equal(bounded.state,'pending'); assert.ok(bounded.body.length<25000);
    assert.match(bounded.body,/additional screenshot previews omitted/);
    assert.match(bounded.body,/Review all screenshot files/);
    const fullBody = await scenario({files:longFiles,authorBody:'a'.repeat(64000)});
    assert.equal(fullBody.state,'pending'); assert.ok(fullBody.body.length<=65000); assert.match(fullBody.body,/additional screenshot previews omitted/);
  });
});
