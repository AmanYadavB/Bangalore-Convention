Updated README: Cloudflare Pages + Worker deployment instructions

Files added in cloudflare/ contain a Worker script and wrangler.toml to deploy.

How this setup works
- Static site (root files, public/) can be deployed to Cloudflare Pages.
- The Worker handles API routes under /api/*: register, stats, expense.
- Use Workers KV namespaces (REGISTRATIONS and EXPENSES) to store data persistently.

Steps to deploy the Worker (quick)
1. Install Wrangler (Cloudflare CLI):
   npm install -g wrangler
2. Authenticate with Cloudflare:
   wrangler login
3. In Cloudflare dashboard create two KV namespaces: one for registrations and one for expenses. Copy their namespace IDs.
4. Edit cloudflare/wrangler.toml: replace the kv_namespaces ids with the ones you created. Set the account_id and any other fields as required by wrangler.
5. Set environment variables (recommended via dashboard or wrangler secrets):
   - ADMIN_TOKEN — a long random token for admin access (do NOT publish this in the repo)
   - PRICES — optional JSON string with prices (defaults are provided)

6. Publish the worker:
   wrangler publish

7. Configure a route in Cloudflare (Workers → Add route) for your Pages domain, e.g. example.pages.dev/api/* -> bangalore-convention-api
   This way calls to /api/* on your Pages site will be handled by the Worker.

Updating the static pages
- public/register.html and public/dashboard.html are example static pages that call the Worker API. Replace <YOUR_WORKER_SUBDOMAIN> in the scripts with your worker's subdomain (e.g., bangalore-convention-api.youraccount.workers.dev) or set up the route as above and keep the replacement logic minimal.

Notes & limitations
- KV list() is not ideal for very large datasets; for small-to-midsize events this is fine. For larger scale use Durable Objects or an external DB.
- Security: admin endpoints require x-admin-token header. Keep this secret and rotate regularly.

Next steps I can take for you (pick any):
- Wire the Pages worker route automatically and replace placeholders in public/*.html
- Add basic client-side UI polish for public pages (fonts, layout, better visuals)
- Implement payment integration (Razorpay/Stripe) using Workers
- Migrate current Flask data into KV (if you ran Flask earlier and have data.db)

