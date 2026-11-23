# Watch-face layout (`dial_main.bin`): format spec (clean-room)

This file describes the binary layout file of a Suunto Run 2 watch face ("kunming" faces, feature
`feat_watchface_kunming_v1`, 466 × 466 round screen). It was written from one captured file so that
an encoder can be written from this text alone. It holds no bytes of that file and none of its
design (coordinates, sizes, colours, image names). Every example value below is made up.

Whoever writes Tartan's encoder works from this spec only.

## 1. Where the file lives

A face is a zip of PNG images plus `dial_main.bin`. The layout names images by their file name
without the `.png` extension: a resource string `hour` means the zip entry `hour.png`. Images are
8-bit RGBA PNGs. The zip's MD5 and the preview name are sent to the watch separately (not part
of this file).

## 2. General rules

- All integers are **little-endian**. `u16` = 2 bytes, `u32` = 4 bytes.
- **Name fields** are fixed 64-byte fields: ASCII bytes, then zero bytes up to 64. A name must be
  at most 63 bytes, so at least one zero follows it.
- Every structure is a multiple of 4 bytes long; sections follow each other with no gaps, so
  every section starts 4-aligned. The string table is the only part whose length isn't fixed
  by counts (see §8 for its padding).
- Bytes this spec calls "zero" are zero in the sample and should be written as zero.
- There is **no checksum or signature** over the file. Integrity is the zip MD5 sent at install.

## 3. The hash (`H`)

Many fields hold a 32-bit hash of a string. The algorithm is **FNV-1, 32-bit, with the top bit
cleared**:

```
H(s):
  h = 0x811C9DC5                      # FNV offset basis
  for each byte b of s (ASCII/UTF-8, no terminating zero):
      h = (h * 0x01000193) mod 2^32   # FNV prime: multiply first ...
      h = h XOR b                     # ... then XOR (FNV-1, not FNV-1a)
  return h AND 0x7FFFFFFF
```

The input is the bare string: no NUL, no padding, no `.png`, case as written. Evidence: all 28
hash fields in the sample (1 root, 14 element, 13 resource) equal `H` of the string described
below, and no other candidate (CRC-32 variants, FNV-1a, djb2, …) matched. Check values:
`H("") = 0x011C9DC5`, `H("a") = 0x050C5D7E`, `H("bg") = 0x6F772BA0`,
`H("imgDialHour") = 0x0C010582`. More in §11.

Where hashes are used:

| Field | Input string |
|---|---|
| root record hash | the face name in the root record |
| element hash | the element name (e.g. `imgDialHour`) |
| resource hash | the resource's **string-table content** (e.g. `hour`, or a whole list `0x112233@0x445566`), not the resource's name field |
| value of a reference property (flag 1) | the same string, i.e. equal to the referenced resource's hash |

So a reference property points at a resource by the hash of its content. When a string
changes, its hash changes, and every property that refers to it changes with it.

**Never edit a string without recomputing its hash.** A file whose strings were renamed in place
still parses (references and resource entries agree with each other), but every hash then
disagrees with its string. If the firmware looks images up by hash (say, a cache filled from the
zip's file names), those images go missing. An encoder that always computes the hashes from the
strings it writes can't produce this state.

## 4. File layout

Let `E` = number of elements, `P` = number of property records, `R` = number of resources,
`S` = string-table length in bytes.

| Offset | Size | Section |
|---|---|---|
| 0 | 376 | header (§5), including the root record |
| 376 | 84 × E | element records (§6) |
| 376 + 84E | 24 × P | property records (§7), all elements' properties back to back |
| 376 + 84E + 24P | 92 × R | resource entries (§8) |
| 376 + 84E + 24P + 92R | `T` | string table (§8), then filler up to `T` bytes (§9) |
| end − 132 | 132 | trailer (§10) |

`T`, the space reserved for the string table, is discussed in §9. In the sample, `T = 24P`.

## 5. Header (376 bytes)

| Offset | Type | Meaning |
|---|---|---|
| 0 | u32 | magic / format version: `0x86` (134) |
| 4 | name[64] | empty (all zero) in the sample; meaning unknown, write zeros |
| 68 | name[64] | author text (free text; the sample has a placeholder word) |
| 132 | name[64] | version text, form `ver-YYYY/MM/DD` (e.g. `ver-2026/10/25`) |
| 196 | u32 | unknown; `1` in the sample. Write `1`. |
| 200 | u32 | `376`: offset of the element table (= header size). See note. |
| 204 | u32 | `132`: size of the trailer (also equals the offset of the version text). Write `132`. |
| 208 | u32 | **unknown**. See note. |
| 212 | u32 | `E`, number of elements |
| 216 | u32 | `R`, number of resources |
| 220 | u32 | `P`, number of property records |
| 224 | u32 | `H(face name)` |
| 228 | name[64] | face name (any short ASCII name) |
| 292 | name[64] | preview image name: the same string as the preview element's resource (§12), and the preview name sent to the watch at install |
| 356 | u32 | zero |
| 360 | u16 | screen width, `466` |
| 362 | u16 | screen height, `466` |
| 364 | 12 bytes | zero |

Notes:

- **Offset 200.** We read this as the header size / element-table offset (it equals 376, the
  fixed header size). In the sample it also happens to be the string-table length + 4, so an
  earlier note read it as "string-table length". The structure says header size; it's the first
  thing to check on the watch if a face with a different string-table length fails (§13).
- **Offset 208.** A u32 whose meaning we couldn't find. It isn't a size, offset or count of
  anything in the file, and it isn't a byte/word sum, CRC-16, CRC-32, Adler-32, Fletcher-16 or
  FNV of any section or name we tried. The sample holds `0x00001732`. Make it a parameter of
  the encoder: try `0` first, and use `0x00001732` if the watch rejects the face.

## 6. Element records (84 bytes each)

| Offset | Type | Meaning |
|---|---|---|
| 0 | u32 | `H(element name)` |
| 4 | name[64] | element name |
| 68 | u32 | info bit-field (below) |
| 72 | 12 bytes | zero |

Info bit-field:

| Bits | Meaning |
|---|---|
| 0–4 | element type (table below) |
| 5–12 | element index: 0 for the first record, 1 for the next, … (the sample uses 0…13; 8 bits assumed) |
| 13–31 | number of property records that belong to this element |

`info = type | (index << 5) | (count << 13)`. Example: index 2, type 7, 18 properties →
`7 | 2<<5 | 18<<13 = 0x00024047`.

Properties aren't addressed by offset: element 0 owns the first `count₀` records of the property
section, element 1 the next `count₁`, and so on. The sum of all counts is `P`. An element can
have 0 properties.

Element types seen:

| Type | Used by | Kind |
|---|---|---|
| 4 | `imgDialOptColor` | the colour option the user picks on the watch |
| 6 | `imgDialPreview` | the picker preview image |
| 7 | `imgDialMainBg`, `imgDialHour`, `imgDialMin`, `imgDialSec`, `imgPinOne`, `imgPinTwo` | images (static or hand) |
| 16 (0x10) | `fixedCompStatus`, `fixedCompass`, `fixedDate`, `fixedPower` | complications the watch draws itself at a fixed place |
| 18 (0x12) | `compBuildInOpt_1`, `compBuildInOpt_2` | complication slots whose data the user chooses from a list |

The names are firmware interface names: the watch probably finds elements by name hash. Use
them exactly. Order in the sample (probably also the drawing order): preview, background, hour,
minute, lower cap, seconds, upper cap, colour option, the four fixed complications (status,
compass, date, battery), the two selectable slots.

## 7. Property records (24 bytes each)

| Offset | Type | Meaning |
|---|---|---|
| 0 | u16 | flag: `0` = plain value, `1` = reference (value is a resource hash) |
| 2 | u16 | key (tables below) |
| 4 | u32 | value: an integer, or for flag 1 `H(string)` of the referenced resource |
| 8 | 16 bytes | zero |

Within an element the records follow a fixed order per element kind (§12). Values are
unsigned 32-bit; no negative value appears in the sample.

### 7.1 Keys of image elements (type 7)

| Key | Name (ours) | Meaning (confidence) |
|---|---|---|
| `0xC9` | widget | `1` = static image (background), `3` = hand-style image (hands and the centre caps). High: the only difference between the two groups. |
| `0xCC` | source | what turns the image: `0` none, `23` hour, `24` minute, `25` second. High. |
| `0xCA` | show (active) | `1` on every image. Probably "visible in normal mode". |
| `0xCB` | show (always-on) | `1` on hour, minute and both caps; `0` on background and seconds. Probably "visible in the low-power / always-on view". Medium. |
| `0x07` | x | horizontal offset in pixels (see `0x09`) |
| `0x08` | y | vertical offset in pixels |
| `0x01` | width | image width in pixels (must equal the PNG's width) |
| `0x04` | height | image height in pixels (must equal the PNG's height) |
| `0x09` | align | `9` on every image. We read it as "centred on the screen" (bit 0 horizontal, bit 3 vertical); (x, y) is then an extra offset, and hands and caps use (0, 0). Medium. Safest: images whose centre is the screen centre, offsets 0. |
| `0x0B` | ? | `0` on images (`255` on selectable complications). Unknown; copy these values. |
| `0x6D` | scale | `256` on every image; probably 8.8 fixed-point scale = 1.0. Write 256. |
| `0x6F` | pivot x | hands only: rotation centre inside the image, in image pixels (e.g. width / 2) |
| `0x70` | pivot y | hands only: rotation centre inside the image (e.g. height / 2 for a full-height hand) |
| `0xCD` | hand mode | `2` on hour/minute (which also carry `0x47`, `0x48`, `0xD2`), `1` on seconds (whose image depends on the colour option). Exact meaning unknown; use these values. |
| `0x47` | colour | `0x00RRGGBB`, hour/minute only (a tint; e.g. `0x00FFFFFF` = white, no change) |
| `0x48` | alpha | 0–255, hour/minute only (255 = opaque) |
| `0xD2` | colour list (ref) | hour/minute only: reference to a list of exactly 2 colours (`0xRRGGBB@0xRRGGBB`). Possibly one per mode (active / always-on). Both hands may point at the same resource. |
| `0xCE` | image (ref) | reference to an image-name list. One name for most images; for the seconds hand N + 1 names (below). Always the element's last record. |

### 7.2 Key of the colour option element (type 4)

| Key | Meaning |
|---|---|
| `0xCF` (ref) | the list of N colours the watch offers, `0xRRGGBB@…` (upper-case hex, `0x` prefix). The seconds hand's image list has N + 1 names: in the sample the first name is the same as the second (the default), then one image per colour in the same order. So picking colour *i* (0-based) on the watch shows seconds image *i* + 1. The colours are shown as swatches; the images are what's drawn. |

### 7.3 Keys of fixed complications (type 16)

Exactly four records each, in this order:

| Key | Meaning |
|---|---|
| `0xD6` | data type the watch draws. Sample: `1` with `fixedCompStatus`, `2` with `fixedPower`, `3` with `fixedDate`, `21` with `fixedCompass`. |
| `0xD7` | template / style id the watch draws it with. Sample: `2` (status), `33` (battery), `35` (date), `34` (compass). |
| `0xD8` | x of the complication, screen pixels |
| `0xD9` | y of the complication, screen pixels |

The watch draws these from its own fonts and icons; the face supplies only position and these codes.

### 7.4 Keys of selectable complications (type 18)

Eleven records each, in this order:

| Key | Meaning |
|---|---|
| `0xDB` | slot number: `0` for `compBuildInOpt_1`, `1` for `compBuildInOpt_2` (could also be the default choice; both readings fit the sample) |
| `0xD7` | template / style id. Sample: `31` for slot 1, `32` for slot 2. |
| `0x07`, `0x08` | x, y of the slot's box (screen pixels, probably top-left; there's no `0x09` here) |
| `0x01`, `0x04` | width, height of the box (square in the sample) |
| `0x0B` | `255` (unknown; copy) |
| `0xD8`, `0xD9` | anchor x, y of the content (screen pixels; equal to x/y in one slot, a little off in the other) |
| `0xDC` (ref) | list of data-type ids the user may choose for this slot, decimal, `@`-separated (e.g. `8@6@11`). The first is probably the default. Sample ids are in the range 5–20; we haven't mapped ids to data. |
| `0xDD` (ref) | a parallel list with one value per entry of `0xDC`, all `0` in the sample (e.g. `0@0@0`). Keep the same count, all zeros. |

### 7.5 Preview element (type 6)

One record: `0xCE` (ref) → the preview image name (a 352 × 352 PNG in the sample; the watch
uses it in its face picker).

## 8. Resources and the string table

Every distinct string that a reference property names becomes one **resource**. The strings
live, NUL-terminated and back to back, in the **string table**; resource entries describe them.

Resource entry (92 bytes):

| Offset | Type | Meaning |
|---|---|---|
| 0 | u32 | `H(string)`, the string without its NUL |
| 4 | name[64] | `<element name>Res`, the element that first refers to it (e.g. `imgDialHourRes`). Not unique: one element can own two resources with the same name field. Not hashed. |
| 68 | u8 | kind: `1` = list of image names (referenced by `0xCE`), `2` = list of values (colours or numbers: `0xCF`, `0xD2`, `0xDC`, `0xDD`) |
| 69 | u8 | number of `@`-separated items in the string (1 when there's no `@`) |
| 70 | u16 | zero |
| 72 | u32 | offset of the string in the string table |
| 76 | u32 | length of the string **including** its NUL |
| 80 | 12 bytes | zero |

Rules (all hold in the sample):

1. Walk the elements in order and each element's properties in order. The first time a reference
   names a string, append a resource for it. Later references to the same string (e.g. two hands
   sharing one colour list) reuse it; there's no second entry.
2. The string table is the strings in resource order, each followed by one `0x00`. Resource 0 has
   offset 0; resource *k* + 1 starts at offset(*k*) + length(*k*). `S` = sum of lengths.
3. `R` in the header = number of entries; resource hash = value of every property that refers to it.
4. List syntax: items joined with `@`, no spaces. Image items are file names without `.png`.
   Colour items are `0x` + six upper-case hex digits. Number items are decimal.
5. A string can't contain a NUL. Keep it ASCII.

## 9. After the string table: filler

In the sample, the space from the start of the string table to the trailer is exactly `24P`
bytes: the size of the property section, not the size of the string table. After the `S` bytes
of strings, the rest of that space holds a stale copy of the property section's bytes at the
same distance from its start (bytes `S … 24P−1` of the property section). That is what a writer
reusing a buffer would leave behind; it's the "second record block" in earlier notes. It
carries nothing new and no offset points into it.

What an encoder should write:

- Reserve `T = max(24P, S)`, rounded up to a multiple of 4, after the start of the string table.
- Write the strings, then zeros up to `T`.
- Then the trailer.

This keeps the trailer where a reader would look for it either way: at file end − 132, or at
string-table start + 24P. Copying the stale property bytes, as the sample does, is a fallback
to try only if zeros fail on the watch.

## 10. Trailer (132 bytes)

| Offset | Type | Meaning |
|---|---|---|
| 0 | u32 | `0x86`, same as the header magic |
| 4 | name[64] | version text, same as the header's |
| 68 | name[64] | zero |

## 11. Encoding algorithm (summary)

1. Inputs: face name, preview name, author, version, header field 208, and the element list
   (name, type, ordered properties; a property is either `key + integer` or `key + string`).
2. Collect resources (§8, rule 1). Compute each `H`, kind (`1` for key `0xCE`, else `2`), item
   count, offset, length. `S` = sum of lengths.
3. `E`, `P` (sum of property counts), `R`. Section offsets from §4. `T` from §9.
4. Write header (§5), element records with `H(name)` and `type | index<<5 | count<<13` (§6),
   property records (flag 1 and `H(string)` for references) (§7), resource entries (§8), strings,
   zero filler, trailer.
5. Total size = `376 + 84E + 24P + 92R + T + 132`.

## 12. What a face needs (element recipes)

What the sample uses. Which elements are strictly required isn't known; the safest face has
all of them. Values in angle brackets are the face's own choice.

- `imgDialPreview` (type 6): `CE→<preview name>`. Also put `<preview name>` in the header
  (offset 292) and send it as the preview name at install.
- `imgDialMainBg` (type 7): `C9=1, CC=0, CA=1, CB=0, 07=<x>, 08=<y>, 01=<w>, 04=<h>, 09=9, 0B=0,
  6D=256, CE→<bg name>`.
- `imgDialHour` / `imgDialMin` (type 7): `C9=3, CC=23 (hour) / 24 (minute), CA=1, CB=1, 07=0, 08=0,
  01=<w>, 04=<h>, 09=9, 0B=0, 6D=256, 6F=<pivot x>, 70=<pivot y>, CD=2, 47=<0xRRGGBB>,
  48=<alpha>, D2→<"0xRRGGBB@0xRRGGBB">, CE→<hand image>`. Draw the hand pointing at 12 o'clock;
  the pivot is the point that sits on the screen centre.
- `imgPinOne` (type 7, the cap over the hour/minute hands): `C9=3, CC=0, CA=1, CB=1, 07=0, 08=0,
  01=<w>, 04=<h>, 09=9, 0B=0, 6D=256, CE→<cap image>`.
- `imgDialSec` (type 7): `C9=3, CC=25, CA=1, CB=0, 07=0, 08=0, 01=<w>, 04=<h>, 09=9, 0B=0,
  6D=256, 6F=<pivot x>, 70=<pivot y>, CD=1, CE→<"default@opt1@…@optN">`. All N + 1 images have
  the same size.
- `imgPinTwo` (type 7, cap over the seconds hand): like `imgPinOne`.
- `imgDialOptColor` (type 4): `CF→<"0xRRGGBB@…">` with N colours (N = seconds images − 1; the
  sample has N = 7).
- `fixedCompStatus`, `fixedCompass`, `fixedDate`, `fixedPower` (type 16): `D6, D7, D8=<x>, D9=<y>`
  with the codes from §7.3.
- `compBuildInOpt_1`, `compBuildInOpt_2` (type 18): `DB=<slot>, D7=<31|32>, 07, 08, 01, 04, 0B=255,
  D8, D9, DC→<"id@id@…">, DD→<"0@0@…">` (§7.4).

What the face draws: background, hands, caps (its PNGs). What the watch draws: the four fixed
complications (status icons, compass, date, battery) and the content of the two selectable slots
(user picks the data from the `0xDC` list), plus the colour picker built from the `0xCF` list.
Width and height in the layout should equal each PNG's real size.

## 13. Test vectors and how to check an encoder

**Hash.** `H` must give: `""` → `0x011C9DC5`, `"a"` → `0x050C5D7E`, `"pv"` → `0x617715CB`,
`"bg"` → `0x6F772BA0`, `"hour"` → `0x55A08F93`, `"demo"` → `0x6DD5A65C`,
`"0x123456@0x654321"` → `0x23EAC6E7`, `"imgDialPreview"` → `0x5DE01CDC`,
`"imgDialMainBg"` → `0x7B1EDE0A` (the untruncated FNV-1 here is `0xFB1EDE0A`: this one checks
the top-bit clear), `"imgDialHour"` → `0x0C010582`, `"fixedDate"` → `0x735A4B95`.

**A small made-up file.** Encode this face (all values invented):

- header: magic `0x86`, author `tartan`, version `ver-2026/10/25`, field 196 = 1, field 208 = 0;
  root name `demo`, preview `pv`, 466 × 466; trailer version `ver-2026/10/25`.
- elements:
  1. `imgDialPreview`, type 6: `CE→"pv"`.
  2. `imgDialMainBg`, type 7: `C9=1, CC=0, CA=1, CB=0, 07=0, 08=0, 01=466, 04=466, 09=9, 0B=0, 6D=256, CE→"bg"`.
  3. `imgDialHour`, type 7: `C9=3, CC=23, CA=1, CB=1, 07=0, 08=0, 01=40, 04=466, 09=9, 0B=0, 6D=256,
     6F=20, 70=233, CD=2, 47=0x123456, 48=200, D2→"0x123456@0x654321", CE→"hour"`.
  4. `fixedDate`, type 16: `D6=3, D7=35, D8=100, D9=300`.
- filler: zeros (§9).

Expected: `E=4, R=4, P=35`; info fields `0x00002006, 0x00018027, 0x00024047, 0x00008070`;
properties at 712, resources at 1552, string table at 1920; resources (name field / kind / count /
offset / length): `imgDialPreviewRes 1/1/0/3`, `imgDialMainBgRes 1/1/3/3`,
`imgDialHourRes 2/2/6/18`, `imgDialHourRes 1/1/24/5` (note the colour list comes before the
hour image, because `D2` precedes `CE`); `S = 29`, `T = 840`; trailer at 2760; total **2892
bytes**; SHA-256 of the file
`977cab78c5c96e3388a2f1a59e359c41f2682e8a6f97b25b875a316d900f0fe3`.

**Self-checks every encoder output should pass** (write them as a test):

1. Size = `376 + 84E + 24P + 92R + T + 132`; header counts match; trailer magic = header magic.
2. Every element hash = `H(name)`; every element's index bits = its position; the counts sum to `P`.
3. Every resource hash = `H` of the string at its offset; offsets are consecutive from 0; each
   length includes exactly one NUL; the item count matches the number of `@` + 1.
4. Every flag-1 property's value equals some resource's hash, and every resource is referenced.
5. The root hash = `H(face name)`; the header preview name = the preview element's resource string.
6. Change one image name to a longer one (e.g. `hour` → `tartan_hour_hand`): the hash
   (`0x74D76130`) changes in the resource and in every property that refers to it, the resources
   after it move by the difference, `S` grows, and checks 1–5 still pass.
7. Decode your own output and encode it again: the bytes must be identical.

**On the watch.** Install a face and check that background, hands (moving), caps, seconds colour
choice, date/battery/compass/status and both selectable slots appear. To test the header-200
question (§5), use a string table whose length + 4 isn't 376 (any real face will do).

## 14. Open questions

- Header offset 208: meaning unknown (§5).
- Header offset 196 (`1`), and the empty name at offset 4.
- Key `0x0B`, exact meaning of `0xCD` and `0xCB`, the bit meaning of align `9`, whether x/y
  can be negative (no sample value is).
- Which `0xDC` ids mean which data; whether `0xDB` is the slot number or the default choice.
- Whether every element is required.

## Observed on the watch (25 Oct 2026, Tartan's own faces)

- A face with a 307-byte string table, zeros after the strings and header field 200 = 376: the
  watch drew its own data (date, compass, battery, data spots) but none of the face's images, not
  even the background. A layout with a 372-byte table and field 200 = 376 had drawn the
  background. Field 200 may well be the string table's length + 4, not the header's size. Until
  that's settled, write a 372-byte table (strings, then zeros), so 376 is right under either
  reading, and the property bytes after the strings as the sample has them (§9).

