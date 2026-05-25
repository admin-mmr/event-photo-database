/**
 * safeJson.ts — JSON serialisation for embedding directly inside a <script>
 * tag in a server-rendered HTML template.
 *
 * The problem
 * ───────────
 * Page handlers in routes/pageRoutes.ts inject server-computed data into
 * client templates with the GAS template syntax:
 *
 *   <script>
 *     var ROWS = <?!= initialRows ?>;
 *   </script>
 *
 * `<?!= … ?>` is the no-HTML-escape variant — whatever string we put on
 * the right-hand side is emitted verbatim into the script body. The string
 * we put there comes from `JSON.stringify(value)` in the page handler.
 *
 * `JSON.stringify` is well-defined as a JSON producer, but its output is NOT
 * always a valid JavaScript literal. Two classes of characters bite us:
 *
 *   1. `</` sequences. The HTML tokenizer scans the contents of a <script>
 *      block looking for `</script>` (case-insensitive) and ends the block
 *      the moment it sees one — even inside a quoted JS string. If any value
 *      embedded in our JSON contains literal `</script>` (rare but possible
 *      in error messages, stack traces, audit details, etc.) the page breaks
 *      catastrophically: the browser closes the <script> tag mid-literal,
 *      the parser hits a syntax error, and nothing further on the page runs.
 *
 *   2. U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. These are valid
 *      JSON string characters but they are LINE TERMINATORS in JavaScript
 *      (per ECMA-262). When JS sees them inside a string literal, it throws
 *      a SyntaxError. JSON.stringify does NOT escape them by default. A
 *      single rogue U+2028 from a copy-pasted Slack/Word message in an
 *      audit record's details field will silently bomb the entire page.
 *
 * Either failure shows up as a page where the server-rendered HTML looks
 * correct (counts, headers, default values) but no rows render and no client
 * interactions fire — every initialiser is downstream of the bad line.
 *
 * The fix
 * ───────
 * Replace `<` with the `<` escape (which JS still happily reads as the
 * `<` character) and replace U+2028 / U+2029 with their `\u` escapes. The
 * result is a string that is BOTH valid JSON and valid as a JavaScript
 * literal regardless of what surrounds it in the HTML.
 *
 * This is the same fix used by Next.js, Rails, and pretty much every
 * SSR framework that embeds data in script tags.
 */

/**
 * Serialises `value` to a string that is safe to embed verbatim inside a
 * `<script>` tag in a server-rendered HTML page.
 *
 * Drop-in replacement for `JSON.stringify(value)` at script-injection sites.
 */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    // `</script>` would close the surrounding tag; escape every `<`.
    // The result is still valid JSON ("<" is a legal string escape).
    .replace(/</g, '\\u003c')
    // U+2028 / U+2029 are JS line terminators but valid JSON characters.
    // Inside a JS string literal they break parsing; escape them.
    // Source uses \u escapes so this file contains no literal control chars.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
