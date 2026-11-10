/**
 * Stands in for ws's optional native add-ons, `bufferutil` and `utf-8-validate`, in the
 * bundle (see the `alias` in tsdown.config.ts).
 *
 * ws `require`s them inside try/catch and falls back to plain JavaScript when they are
 * missing. Left alone, the bundler turns that into a runtime `require` that resolves from
 * disk — through every `node_modules` in every parent directory of the install — so a
 * package planted anywhere up the tree would run inside opencode's process. Throwing here
 * is exactly the "not installed" that ws expects.
 */
throw new Error("ws optional native add-ons are disabled in this build");

export {};
