// <script>
// vizor.js: the entry point index.html loads. Importing nav.js loads core.js and every view; the app starts
// here, after all of them have run their setup.
// The first and last lines are markers the static UI tests read modules by; keep them.
import { readHash, refresh } from './core.js';
import './nav.js';

readHash();
refresh();
// </script>
