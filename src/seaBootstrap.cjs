const { pathToFileURL } = require('node:url');
const path = require('node:path');

const root = process.env.BROWSER_USE_HOME || path.dirname(process.execPath);
const entry = path.join(root, 'src', 'index.js');

import(pathToFileURL(entry).href)
  .then((module) => module.main())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
