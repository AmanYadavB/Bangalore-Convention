# Production Reliability Baseline

## Purpose

This document defines how the Bangalore Convention website is changed,
tested, deployed, verified, and rolled back without risking the live site.

## Production system

- Production domain: `https://biaac.com`
- Cloudflare Worker: `bangalore-convention`
- Static assets: `public/`
- Worker entry point: `worker.js`
- Configuration: `wrangler.toml`
- Data services: Cloudflare D1 and KV
- Current production branch: not yet established
- Current deployment method: manual Wrangler deployment from a local machine

## Current known-good production release

- Worker version ID: `85dffc46-a60e-4ff2-8180-2ed2f8836adf`
- Recorded on: `2026-10-18`
- Verified by: `AMAN`
- Checks performed:
  - [*] Homepage loads
  - [*] Register page loads
  - [*] Brochure opens
  - [*] Mobile brochure preview loads
  - [*] Terms page loads
  - [*] Protected pages require sign-in

## Temporary safety rules

Until CI/CD is in place:

1. Do not run `wrangler deploy` unless the change has been reviewed and tested locally.
2. Do not use `git reset --hard` or discard uncommitted work.
3. Record the Cloudflare Worker version ID after every production deployment.
4. Verify the production site after every deployment.
5. Never store API keys, passwords, tokens, database exports, or personal registration data in Git.

## Target release workflow

```text
feature branch
  -> pull request
  -> automated checks
  -> staging deployment
  -> manual review
  -> merge to main
  -> production deployment
  -> production smoke test
  -> retain previous version for rollback