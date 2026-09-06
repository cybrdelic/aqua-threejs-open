# Repository import

This repository imports the latest supplied `CYBR-WATER-2.4-Source.zip`: the
five-shot, 42-second release, not the earlier similarly named 48-second draft.
The editable modules and runtime binary assets are imported without simulation
or shader edits.

The original README and hash ledger are retained as
`CYBR-WATER-2.4-README.md` and `CYBR-WATER-2.4-RELEASE-HASHES.json` in this directory.
Paths in those historical records refer to the original archive layout and
capture environment. They are historical evidence, not current-build guarantees.

The target repository already contained a GPL-2.0 LICENSE. It is left unchanged;
the imported distribution's MIT notice is retained in `licenses/CYBR-WATER-MIT.txt`.
The root README, repository checks, and README GIF capture tool are packaging
additions. The committed GIFs are fresh captures of the imported renderer, not
excerpts from an older renderer or image-generation output.

`import-manifest.json` identifies the source archive and hashes every imported
source file. `media/manifest.json` records preview scene/camera definitions,
output hashes, browser information and any rendering errors. No Git credentials,
API keys, private account information or absolute workstation paths are needed
by the application.
