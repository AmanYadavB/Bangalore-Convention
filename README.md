Updated: full static frontend (public/) with multi-page site, config.json to minimize setup, and instructions in README for using Google Forms or Formspree as a backend.

Next steps (minimal):
1. Create a Google Form (or Formspree form) for registrations and get its POST endpoint.
2. Edit public/config.json and set FORM_ENDPOINT to that URL and add any published chart embed URLs to DASHBOARD_EMBEDS.
3. Deploy to Cloudflare Pages (build output directory: public).

This approach avoids Workers/KV setup now — you can add serverless APIs later when you want payments or advanced features.
