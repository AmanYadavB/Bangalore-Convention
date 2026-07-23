# Bangalore Convention — Website

This repository contains a simple, responsive static website for the Bangalore Convention.

What I added
- index.html — main site content (hero, about, schedule, speakers, venue, register, contact)
- styles.css — minimal responsive styling
- README.md — this file with deployment instructions

Deploying to Cloudflare Pages
1. Log in to your Cloudflare dashboard (https://dash.cloudflare.com/).
2. Go to "Pages" and click "Create a project".
3. Connect your GitHub account and select the repository: `AmanYadavB/Bangalore-Convention`.
4. For the production branch choose `main` (or select the branch you prefer).
5. Framework preset: "None (Static)". Build command: leave empty. Build output directory: `/`.
6. Click "Save and deploy". Cloudflare Pages will deploy the site on every push to the chosen branch.

Custom domain
- After successful deployment, you can add a custom domain in Pages → Custom domains and configure DNS.

Make the site dynamic or add forms
- For a contact/registration form, use Formspree, Google Forms, or integrate a backend API.
- If you prefer a Python backend (Flask/FastAPI), Cloudflare Pages alone won't host Python; consider using Cloudflare Workers + a hosted API or deploy the backend to a service like Railway/Render/Vercel and call it from the static frontend.

Next steps you might want me to do
- Add more pages (speakers details, schedule full breakdown)
- Add a registration form with backend integration
- Configure a Cloudflare Worker for serverless APIs or to serve assets via Workers Sites

