/** @jest-environment node */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function release(failApi) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-release-test-'));
  const root = path.join(temp, 'journal');
  fs.mkdirSync(path.join(root, 'infra'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web'));
  fs.mkdirSync(path.join(temp, 'bin'));
  fs.copyFileSync(path.join(__dirname, '../infra/deploy.sh'), path.join(root, 'infra/deploy.sh'));
  fs.cpSync(path.join(__dirname, '../api'), path.join(root, 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(temp, 'bin/aws'), `#!/usr/bin/env node
const fs=require('fs'),c=require('crypto'); const a=process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='lambda'&&a[1]==='update-function-code'&&process.env.FAIL_API==='1')process.exit(42);
if(a[0]==='lambda'&&a[1]==='get-function-configuration')console.log(c.createHash('sha256').update(fs.readFileSync(process.env.RELEASE_ZIP)).digest('base64'));
if(a[0]==='cloudformation'){
 const q=a[a.indexOf('--query')+1];
 console.log(q.includes('ApiEndpoint')?'https://example.test/api':q.includes('SiteBucketName')?'journal-only-bucket':'journal-only-distribution');
}
if(a[0]==='cloudfront'&&a[1]==='create-invalidation')console.log('invalidation-id');
`);
  fs.chmodSync(path.join(temp, 'bin/aws'), 0o755);
  const log = path.join(temp, 'calls.jsonl');
  const result = spawnSync('bash', [path.join(root, 'infra/deploy.sh'), 'app'], {
    encoding: 'utf8', env: { ...process.env, PATH: path.join(temp, 'bin') + ':' + process.env.PATH,
      RELEASE_LOG: log, RELEASE_ZIP: path.join(root, '.build/api.zip'), FAIL_API: failApi ? '1' : '0' },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  fs.rmSync(temp, { recursive: true, force: true });
  return { result, calls };
}

test('routine release verifies the API before publishing and waits for invalidation without touching data or credentials', () => {
  const { result, calls } = release(false);
  expect(result.status).toBe(0);
  const sequence = calls.map(c => c.slice(0, 2).join(' '));
  expect(sequence.indexOf('lambda update-function-code')).toBeLessThan(sequence.indexOf('lambda get-function-configuration'));
  expect(sequence.indexOf('lambda get-function-configuration')).toBeLessThan(sequence.indexOf('s3 sync'));
  expect(sequence.indexOf('s3 sync')).toBeLessThan(sequence.indexOf('cloudfront create-invalidation'));
  expect(calls[calls.length - 1]).toContain('invalidation-completed');
  expect(calls.find(c => c[0] === 's3')).toContain('s3://journal-only-bucket');
  expect(calls.some(c => ['ssm', 'dynamodb', 'route53'].includes(c[0]))).toBe(false);
  expect(calls.some(c => c[0] === 'cloudformation' && c[1] !== 'describe-stacks')).toBe(false);
  expect(calls.some(c => c[1] === 'update-function-configuration')).toBe(false);
});

test('API failure stops the release before frontend or cache changes', () => {
  const { result, calls } = release(true);
  expect(result.status).toBe(42);
  expect(calls.some(c => c[0] === 's3' || c[0] === 'cloudfront')).toBe(false);
});
