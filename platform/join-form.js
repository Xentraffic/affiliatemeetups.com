const LEGAL = 'PLACEHOLDER. The legal entity that operates AffiliateMeetups, and the terms and privacy text, are not decided. This is not the final policy.';

function joinPage({ token }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join the waitlist · AffiliateMeetups</title>
<style>
  body { margin:0; font-family: Georgia, serif; background:#F7F4EF; color:#111; }
  main { max-width:640px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:36px; letter-spacing:-.03em; }
  .note { background:#fff8e8; border:1px solid #e2d3a8; padding:12px 14px; }
  label { display:block; margin:12px 0 4px; font-size:14px; }
  input, textarea, select { width:100%; padding:8px 10px; font:inherit; box-sizing:border-box; }
  button { margin-top:16px; background:#111; color:#F7F4EF; border:0; padding:10px 16px; font:inherit; }
  .hp { position:absolute; left:-9999px; height:0; overflow:hidden; }
</style>
</head>
<body>
<main>
  <p class="note">${LEGAL} XenTraffic operates the current site. Nothing here is a paid offer.</p>
  <h1>Join the waitlist</h1>
  <p>Operators apply. Agents are not part of this form.</p>
  <form method="post" action="/api/members/register">
    <input type="hidden" name="client" value="waitlist-form">
    <input type="hidden" name="form_token" value="${token}">
    <input type="hidden" name="started_at" value="${Date.now()}">
    <div class="hp" aria-hidden="true">
      <label>Leave this empty<input name="company_url_2" tabindex="-1" autocomplete="off"></label>
    </div>
    <label>First name<input name="firstname" required></label>
    <label>Last name<input name="lastname" required></label>
    <label>Work email<input name="email" type="email" required></label>
    <label>Company<input name="company"></label>
    <label>Role<input name="role"></label>
    <label>Country<input name="country"></label>
    <label>Website<input name="website"></label>
    <label>Traffic<input name="traffic" placeholder="Sources and rough volume"></label>
    <label>How you heard about AMU<input name="source"></label>
    <label>What you want from the room<textarea name="goal" rows="4"></textarea></label>
    <button type="submit">Request a place</button>
  </form>
  <p><a href="/api/members/legal">Placeholder terms and privacy</a></p>
</main>
</body>
</html>`;
}

function legalPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Policies · AffiliateMeetups</title></head>
<body style="font-family:Georgia,serif;background:#F7F4EF;color:#111;max-width:640px;margin:32px auto;padding:0 20px">
<h1>Policies</h1>
<p>${LEGAL}</p>
<p>Until counsel publishes the real text, do not treat this page as terms of use or a privacy notice. The existing club privacy page, if linked from the homepage, is a separate document and was not replaced.</p>
</body></html>`;
}

module.exports = { LEGAL, joinPage, legalPage };
