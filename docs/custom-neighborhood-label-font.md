# Recorded neighborhood label font

Live saved-file verification found the custom subdivision-label symbol layer
requesting `Open Sans Regular,Arial Unicode MS Regular/0-255.pbf` from
OpenFreeMap. That request returned 404; MapLibre warned repeatedly while drawing
the labels with local fallback. The layer had omitted `text-font`, so it used
MapLibre's default rather than the base style's font.

The layer now explicitly uses `Noto Sans Regular`, one of the font stacks in
[OpenFreeMap's Bright style](https://github.com/hyperknot/openfreemap-styles/blob/main/styles/bright/style.json).
This changes only label typography/resource selection. It does not suppress
resource errors or change parcel geometry, label text/anchors, inclusion,
similarity, map colors, report calculations, authentication, or saved data.
No new runtime, font host, or dependency is introduced.

The component regression test checks the actual registered symbol layout on
initial load, view-only toggles, and assignment remount. Existing tests retain
resource-failure disclosures, exact parcel identity and click behavior. Live
acceptance must additionally check that recorded labels draw without the missing
font warning; a mocked runtime alone cannot establish provider availability.
