# Signature assets

Drop the two signature marks here with these exact filenames, in lowercase:

- `signature-black.png` — the solid black mark. Used on **light** theme exports.
- `signature-white.png` — the white mark. Used on **dark** theme exports.

Both must be **transparent** PNGs, at least 160px tall so they stay sharp when scaled up for the
1920px preset. The exporter picks the file by theme and composites it into every frame.

Lowercase the extension. Windows will serve `.PNG` regardless, but a case-sensitive host will
404 on it.

## Transparent padding is handled for you

Exported logos usually carry a wide transparent margin, often not a symmetric one. The two files
currently here fill about 62% of their canvas width and 66% of its height, with 11% padding above
and 21% below.

On load, the opaque bounding box is detected and only that region is drawn. So:

- **Size** means the height of the visible mark, not of the file.
- **Inset** means the actual gap from the canvas edge to the ink.

Without this, a 66px request would draw a 45px logo, and the gap under the mark would not match
the gap beside it. There is no need to pre-crop — but cropping tightly does no harm either, since
a tight file simply trims to itself.

## Overriding without touching this folder

The Signature panel on the animate page can upload a mark directly; it is kept in browser storage
and takes priority over the files here. Useful for trying alternatives. These files remain the
better home for the real thing, since they survive a cleared browser profile and travel with a
fresh clone.
