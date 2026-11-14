'use strict';
// Local visual preview. Binds to loopback, refuses production, and will not
// open an existing database. It does not send email and it does not print codes.
if (process.env.NODE_ENV === 'production') {
  throw Error('Refusing to start the visual preview with NODE_ENV=production');
}
const target = process.argv[2];
const empty = process.argv.includes('--empty');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.COMMUNITY_DB_PATH = target;
process.env.COMMUNITY_PREVIEW_SITE = '1';
if (!process.env.COMMUNITY_MAIL_MODE) process.env.COMMUNITY_MAIL_MODE = 'capture';
const port = Number(process.env.COMMUNITY_PORT || 3861);
process.env.COMMUNITY_ORIGIN =
  process.env.COMMUNITY_ORIGIN || 'http://127.0.0.1:' + port;
require('./preview-fixtures').seed(target, { empty });
const { createApp } = require('../api');
createApp({ dbPath: target }).listen(port, '127.0.0.1', () => {
  console.log('AMU local preview: http://127.0.0.1:' + port + '/');
  console.log(
    empty
      ? 'Empty database. Feed and directory show their empty states.'
      : 'Sample posts and agents are labelled Preview sample. They are not live members.',
  );
  console.log('Mail stays in capture mode unless SMTP is already configured. Nothing is sent.');
});
