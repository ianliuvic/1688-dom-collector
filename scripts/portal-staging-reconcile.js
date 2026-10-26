const baseUrl = process.env.PORTAL_RECONCILE_URL || 'http://127.0.0.1:3000';
const apiKey = process.env.ADMIN_API_KEY;
if (!apiKey) {
  console.error('ADMIN_API_KEY is required');
  process.exit(1);
}

const response = await fetch(`${baseUrl}/api/portal/staging-reconcile`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  },
  body: '{}',
});
const body = await response.text();
console.log(`HTTP ${response.status}`);
console.log(body);
if (!response.ok) process.exit(1);
