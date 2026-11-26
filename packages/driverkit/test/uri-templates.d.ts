/**
 * Types for `uri-templates`, which ships none.
 *
 * It is used in exactly one place — as the ORACLE for the core's own RFC 6570
 * expansion, in `registry.test.ts`. `ScreenSpec.url` is documented as RFC 6570
 * and the core implements the one level a route needs by hand, because the
 * package promises zero runtime dependencies and the worked example loads its
 * `.ts` sources into a browser with no bundler. Checking that subset against
 * the code that wrote it would prove nothing, so it is checked against a real
 * implementation instead.
 *
 * Declared here rather than depended on through `@types/*`: there is no such
 * package, and the two members used are the whole of what this test needs. It
 * lives beside the test and not in `src`, so nothing shipped can reach it.
 */
declare module "uri-templates" {
  interface UriTemplate {
    /** Simple string expansion of `{var}`, and the rest of RFC 6570. */
    fill(values: Record<string, unknown>): string;
    /** The template's variable names, in order. */
    varNames: string[];
  }
  export default function uriTemplates(template: string): UriTemplate;
}
