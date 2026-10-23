"""The EmbArch glyph, built from the mark (decision 54): the status bar's icon
font, the view containers' one-colour icon and the editor tab's two-colour
pair, all from tools/embarch-mark.svg, which is embarch-ui's
assets/brand/embarch-mark.svg verbatim (its trace_mark.py made it).

A status bar draws a codicon or a contributed icon font in one colour at
16 px, and the activity bar masks an SVG to one colour too, so the mark's
three paint layers become one shape there. Painted in one colour the mark is
a blob: the letters touch, and only the dark stroke and the two fills told
them apart. So the A keeps its share of the stroke and sits on top, as in the
master, and the E is cut back from it by a one-pixel gap (at 16 px). Then
the horizontal edges are snapped to the 16 px grid, which is what a hinted
font would do: the E's three bars and the A's base land on whole pixels
rather than smearing across two rows each. The editor tab can carry colour,
so it is the mark as embarch-ui's header draws it (union mode, the E in
--text-secondary and the A in --brand), one file per theme.

Outputs, all in media/:

    embarch-glyph.woff       U+E000, for `contributes.icons` (the status bar)
    embarch-glyph.svg        the same shape, for the view containers
    embarch-tab-dark.svg     the editor tab's icon on a dark theme
    embarch-tab-light.svg    ... and on a light one

It needs fontTools and skia-pathops (the boolean ops), which nothing at
runtime does, so they live in a scratch venv rather than in package.json:

    python3 -m venv /tmp/glyph-venv
    /tmp/glyph-venv/bin/pip install fonttools skia-pathops
    /tmp/glyph-venv/bin/python tools/make_glyph.py                # -> media/
    /tmp/glyph-venv/bin/python tools/make_glyph.py --all <dir>    # every variant

`--all` writes each variant in VARIANTS as <dir>/glyph-<name>.woff and .svg,
for rendering side by side; SHIP names the one media/ gets.
"""
import os, re, sys

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampFromString
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(os.path.dirname(HERE), "media")

# The master's own pixels: 256 box, y down; the ink is the square 25..231.
INK0, INK1 = 25.0, 231.0
# Where the ink sits in the 16 px em: one pixel of padding all round, as the
# codicons have (codicon.ttf: em 300, glyphs 19..281, that is 1..15 px).
PX0, PX1 = 1.0, 15.0
MASTER_PER_PX = (INK1 - INK0) / (PX1 - PX0)  # 14.7 master pixels per pixel at 16 px
# The em, in font units: 100 a pixel at 16 px, so the grid is whole numbers.
UPM = 1600
UNIT = UPM / 16

# The A's share of the dark stroke: the stroke is 4-6 master pixels wide
# round the A, so 6 takes all of it; clipping to the silhouette stops it
# growing outward.
STROKE = 6.0

# name: (gap in pixels at 16 px, snap horizontal edges to the 16 px grid,
#        letters with their share of the dark stroke or without it)
VARIANTS = {
    "a-gap": (1.0, False, True),
    "b-thin-snapped": (1.0, True, False),
    "c-gap-snapped": (1.0, True, True),
}
SHIP = "c-gap-snapped"

# The tab's two fills, per theme: embarch-ui's --text-secondary and --brand
# (assets/style.css), as hex because a standalone SVG has no cascade to read
# a custom property from (embarch-ui decision 25).
#   dark:  oklch(72% 0.008 250), oklch(63% 0.194 29) -- the mark's own #e74c3c
#   light: oklch(42% 0.01 250),  oklch(56% 0.19 29)
TAB = {"dark": ("#a1a5a9", "#e74c3c"), "light": ("#494e52", "#cc3529")}


def mark_paths():
    """The mark's three layers -- silhouette, E, A -- as lists of polygons."""
    svg = open(os.path.join(HERE, "embarch-mark.svg")).read()
    out = []
    for d in re.findall(r'd="([^"]+)"', svg):
        loops = []
        for sub in re.findall(r"M([^MZ]+)Z", d):
            nums = [float(v) for v in re.findall(r"-?[\d.]+", sub)]
            loops.append(list(zip(nums[0::2], nums[1::2])))
        out.append(loops)
    return out


def path_of(loops):
    p = pathops.Path(fillType=pathops.FillType.EVEN_ODD)
    for lp in loops:
        p.moveTo(*lp[0])
        for pt in lp[1:]:
            p.lineTo(*pt)
        p.close()
    return pathops.simplify(p)


def grow(p, r):
    """`p` dilated by `r`, mitred, so the A's straight edges stay straight."""
    s = pathops.Path(p)
    s.stroke(2 * r, pathops.LineCap.BUTT_CAP, pathops.LineJoin.MITER_JOIN, 4)
    return pathops.op(p, s, pathops.PathOp.UNION)


def letters(fat=True):
    """The E and the A, each with its share of the dark stroke, in master pixels."""
    sil, e, a = (path_of(l) for l in mark_paths())
    if not fat:
        return e, a
    a_fat = pathops.op(grow(a, STROKE), sil, pathops.PathOp.INTERSECTION)
    e_fat = pathops.op(sil, a_fat, pathops.PathOp.DIFFERENCE)
    return e_fat, a_fat


def polygons(p):
    """A path's contours as point lists (it is all straight lines)."""
    out = []
    for c in p.contours:
        pts = []
        for verb, seg in c.segments:
            if verb in ("moveTo", "lineTo"):
                pts.append(seg[0])
        if len(pts) > 1 and pts[-1] == pts[0]:
            pts.pop()
        if len(pts) >= 3:
            out.append(pts)
    return out


def to_px(polys):
    """Master pixels -> pixels of the 16 px em, y still down."""
    k = 1 / MASTER_PER_PX
    return [[(PX0 + (x - INK0) * k, PX0 + (y - INK0) * k) for x, y in lp] for lp in polys]


def snap(polys):
    """Horizontal edges onto whole pixels; every other vertex stays put.

    One y moves the same way wherever it occurs, so two edges that shared a
    height still do.
    """
    ys = {}
    for lp in polys:
        for i in range(len(lp)):
            (x1, y1), (x2, y2) = lp[i], lp[(i + 1) % len(lp)]
            if abs(y1 - y2) < 1e-6 and abs(x1 - x2) > 1e-6:
                ys[round(y1, 6)] = round(y1)
    return [[(x, ys.get(round(y, 6), y)) for x, y in lp] for lp in polys]


def glyph(gap, snapped, fat):
    """The one-colour glyph, in pixels of the 16 px em (y down)."""
    e_fat, a_fat = letters(fat)
    e_cut = pathops.op(e_fat, grow(a_fat, gap * MASTER_PER_PX), pathops.PathOp.DIFFERENCE)
    one = pathops.op(e_cut, a_fat, pathops.PathOp.UNION)
    polys = to_px(polygons(one))
    return snap(polys) if snapped else polys


def area(lp):
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(lp, lp[1:] + lp[:1])) / 2


def d_attr(polys, nd=3):
    return "".join("M" + " ".join("%g,%g" % (round(x, nd), round(y, nd)) for x, y in lp) + "Z" for lp in polys)


def write_svg(path, polys, fill="currentColor"):
    open(path, "w").write(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
        '<path d="%s" fill="%s"/></svg>\n' % (d_attr(polys), fill)
    )


def write_woff(path, polys):
    """One glyph at U+E000 in an em of 16 pixels, with codicon.ttf's metrics:
    ascent the whole em, no descent, so a 16 px line box is the em."""
    pen = TTGlyphPen(None)
    for lp in polys:
        # TrueType wants outer contours clockwise with y up. Flipping y turns
        # each contour round, so a y-down counter-clockwise one comes out right.
        pts = [(round(x * UNIT), round((16 - y) * UNIT)) for x, y in lp]
        if area(lp) > 0:
            pts.reverse()
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    notdef = TTGlyphPen(None).glyph()
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder([".notdef", "embarch"])
    fb.setupCharacterMap({0xE000: "embarch"})
    fb.setupGlyf({".notdef": notdef, "embarch": pen.glyph()})
    fb.setupHorizontalMetrics({".notdef": (UPM, 0), "embarch": (UPM, 0)})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({"familyName": "embarch-glyph", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0, usWinAscent=UPM, usWinDescent=0)
    fb.setupPost()
    # A fixed date, so the same art makes the same bytes and a rerun is no diff.
    when = timestampFromString("Fri Oct 23 00:00:00 2026")
    fb.updateHead(created=when, modified=when)
    fb.font.recalcTimestamp = False
    fb.font.flavor = "woff"
    fb.save(path)


def write_tab(path, theme):
    """The tab's mark: the silhouette in the E's colour, the A over it, both
    snapped together so an edge they share stays shared."""
    e, a = TAB[theme]
    sil = to_px(polygons(path_of(mark_paths()[0])))
    a_fat = to_px(polygons(letters()[1]))
    both = snap(sil + a_fat)
    paths = "".join(
        '<path d="%s" fill="%s"/>' % (d_attr(p), fill) for p, fill in ((both[: len(sil)], e), (both[len(sil) :], a))
    )
    open(path, "w").write(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">%s</svg>\n' % paths
    )


if __name__ == "__main__":
    if sys.argv[1:2] == ["--all"]:
        out = sys.argv[2]
        os.makedirs(out, exist_ok=True)
        for name, spec in VARIANTS.items():
            polys = glyph(*spec)
            write_woff(os.path.join(out, "glyph-%s.woff" % name), polys)
            write_svg(os.path.join(out, "glyph-%s.svg" % name), polys)
            print("wrote", name, len(polys), "contours", sum(len(l) for l in polys), "points")
    else:
        polys = glyph(*VARIANTS[SHIP])
        write_woff(os.path.join(MEDIA, "embarch-glyph.woff"), polys)
        write_svg(os.path.join(MEDIA, "embarch-glyph.svg"), polys)
        for theme in TAB:
            write_tab(os.path.join(MEDIA, "embarch-tab-%s.svg" % theme), theme)
        print("wrote media/embarch-glyph.{woff,svg}, media/embarch-tab-{dark,light}.svg from", SHIP)
