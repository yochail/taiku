import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_COMMENT_DRAFTS, MAX_POST_DRAFTS, xComposerUrl } from '../src/lib/x-drafts.mjs';

const address = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function draftEmail(drafts) {
  const { date, posts, comments } = drafts;
  if (drafts.site !== 'taiku' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(`${date}T00:00:00Z`).toJSON()?.slice(0, 10) !== date ||
      !Array.isArray(posts) || posts.length > MAX_POST_DRAFTS ||
      !Array.isArray(comments) || comments.length > MAX_COMMENT_DRAFTS) {
    throw new Error('Invalid Taiku draft artifact');
  }
  const intro = 'Review these AI-generated Taiku drafts and submit manually. Nothing has been posted to X.';
  const text = [intro];
  const html = [`<p>${intro}</p>`];
  for (const [kind, items, label] of [['post', posts, 'Review and post on X'], ['comment', comments, 'Review and reply on X']]) {
    for (const item of items) {
      if (item.kind !== kind || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 280 ||
          (kind === 'comment' && !/^\d{5,25}$/.test(item.originalPostId)) ||
          item.openInXUrl !== xComposerUrl(item.text, kind === 'comment' ? item.originalPostId : null)) {
        throw new Error('Invalid X composer link in draft artifact');
      }
      text.push(`${item.text}\n${label}: ${item.openInXUrl}`);
      html.push(`<p>${escape(item.text).replace(/\n/g, '<br>')}<br><a href="${escape(item.openInXUrl)}">${label}</a></p>`);
    }
  }
  if (!posts.length && !comments.length) return null;
  return { subject: `Taiku X drafts - ${date}`, text: text.join('\n\n'), html: html.join('\n') };
}

export async function sendDraftEmail(drafts, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.X_DRAFT_EMAIL_FREE_ONLY !== 'true') return 'disabled';
  const email = draftEmail(drafts);
  if (!email) return 'empty';
  const { X_DRAFT_EMAIL_FROM: from, X_DRAFT_EMAIL_TO: to, RESEND_X_DRAFT_API_KEY: key } = env;
  if (!key || !address.test(from ?? '') || !address.test(to ?? '')) {
    throw new Error('Configure RESEND_X_DRAFT_API_KEY, X_DRAFT_EMAIL_FROM and X_DRAFT_EMAIL_TO in production');
  }
  let response;
  try {
    response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `taiku-x-drafts/${drafts.date}`,
      },
      body: JSON.stringify({ from, to: [to], ...email }),
    });
  } catch {
    throw new Error('Resend request failed or timed out; check the Resend dashboard before retrying');
  }
  if (!response.ok) throw new Error(`Resend did not accept the email (HTTP ${response.status}); check the Resend dashboard`);
  const result = await response.json().catch(() => null);
  if (typeof result?.id !== 'string' || !result.id) throw new Error('Resend response is missing an email ID; check the Resend dashboard');
  return 'accepted';
}

async function main() {
  const messages = {
    disabled: 'Not enabled; draft links are still available in the run summary and artifact.',
    empty: 'No eligible drafts to email.',
    accepted: 'Resend accepted the draft email. Check the Resend dashboard for delivery status.',
  };
  const status = process.env.X_DRAFT_EMAIL_FREE_ONLY === 'true'
    ? await sendDraftEmail(JSON.parse(await fs.readFile(process.argv[2], 'utf8')))
    : 'disabled';
  console.log(messages[status]);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\n**X draft email:** ${messages[status]}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // Do not let provider response bodies or addresses appear in public Actions logs.
    const message = error instanceof SyntaxError ? 'Invalid draft JSON' : error.message;
    console.error(`::warning title=X draft email failed::${message}`);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\n**X draft email:** Failed. Draft links remain in the run summary and artifact. See the email step for details.\n`);
    process.exitCode = 1;
  }
}
