// A monthly commit prevents GitHub from disabling a public repository's
// schedule after 60 days without repository activity. No Site key is used here.
const repository = 'sonosuke519/shoequarium-price-updater';
if (process.env.GITHUB_REPOSITORY !== repository) throw Error('unexpected_repository');
const headers = { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const endpoint = `https://api.github.com/repos/${repository}/contents/.maintenance/last-success.json`;
const previous = await fetch(endpoint, { headers, redirect: 'error' });
if (!previous.ok && previous.status !== 404) throw Error(`activity_read_${previous.status}`);
const file = previous.ok ? await previous.json() : null;
const month = new Date().toISOString().slice(0, 7);
const value = file ? JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) : null;
if (value?.month === month) {
  console.log('Monthly repository activity already recorded.');
} else {
  const response = await fetch(endpoint, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ message: `Record successful scheduled operation for ${month}`, content: Buffer.from(JSON.stringify({ month }) + '\n').toString('base64'), ...(file ? { sha: file.sha } : {}) }),
  });
  if (!response.ok) throw Error(`activity_write_${response.status}`);
  console.log('Monthly repository activity recorded.');
}
