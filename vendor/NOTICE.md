# Third-party notices

`vendor/` holds copies of two small libraries from the [Cordis](https://github.com/cordisjs/cordis)
ecosystem. They are vendored because a `link:`-installed plugin resolves bare
package names from its own directory, and these two are only needed for the
config schema:

| File | Upstream | License |
| --- | --- | --- |
| `vendor/schemastery.js` | npm `schemastery` (Cordis) | MIT |
| `vendor/cosmokit.js` | npm `cosmokit` (Cordis) | MIT |

Both remain the property of their authors and are redistributed unmodified in
substance (only the bundling wrapper differs). If you build this plugin from a
checkout that has those packages installed, you may delete `vendor/` and import
the real packages instead.
