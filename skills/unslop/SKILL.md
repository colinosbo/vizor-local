---
name: "unslop"
description: "Turns vibecoded, AI-looking UI into a designed interface with its own character. Use to unslop, polish or redesign a screen, dashboard or app UI, or plan such a redesign."
---

# Unslop

unslop was created by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), who started the Unslopping series on X. It is licensed under CC BY 4.0, so keep this credit in any copy or adaptation. Source: https://github.com/heydamir/unslop (this copy inlines the Tokens and Signs references; the visuals, refs, effects and rtl references and the snapshot/story scripts are in the repo under skills/unslop/).

Vibecoded UI fails in the same predictable ways. Every surface glows, every label has an emoji, spacing is whatever the model typed that day, and the copy shouts. Unslopping fixes the craft and keeps the product. The features, content and order of sections stay. What changes is that every size, color, word and image becomes deliberate.

Removing slop is only half the job. A screen that is clean but could belong to any product is the next template. Every run ends with a screen that only this product could have.

The difference between slop and craft is where the richness goes. Slop spreads color and effects over the chrome, the backgrounds, buttons, borders and labels. Craft keeps the chrome quiet and puts the richness into one or two moments of content that people remember, like a rendered object, a beautiful chart or an image from the product's world.

Work like a designer doing a redline pass, one layer at a time, across the whole screen.

## What good looks like

- **One bright element.** Each screen has one polished thing that carries the color and the craft, a rendered object, a painted scene or a rich chart. Everything around it is quiet, so it reads instantly.
- **Quiet chrome.** Navigation, buttons and text use the tinted neutrals and one accent. Nothing glows, nothing competes with the bright element.
- **A clear idea.** You can say in one sentence what the visual shows and why it belongs to this product.
- **Text on calm space.** The headline sits on a part of the image or layout that was left empty for it, short and specific, with one primary and one secondary action and nothing stacked under them.
- **Real product, real material.** Previews look like the real app with plausible data, and objects look like real things with weight, light and shadow.

Which visual styles work and which fail, finished examples, code treatments and right-to-left rules are in the repo's references (visuals.md, refs.md, effects.md, rtl.md).

## Run it

1. **Look at the screen.** Find the files that render it. If you can run the app or open the file in a browser and take a screenshot, do it, so you judge what people see and not only the code. Only a screenshot? Rebuild the screen as one static HTML file first, matching it closely, and treat that as the original.
2. **Audit.** Go through the Signs list below and list every sign you find, one line each with where it lives. For Arabic, Persian, Urdu or Hebrew screens read the repo's rtl.md first; its rules win.
3. **Decide how much to change.** Read the audit honestly before planning anything.
   - **Heavy slop**, many signs across color, type, icons and copy. Run the full process below.
   - **Light slop**, a screen that is mostly designed with a few signs left. Polish mode. Fix only what the audit found, take the direction from the existing brand, and keep the palette, type, layout and visual. Bigger ideas go into the report as suggestions.
   - **No slop.** Say so plainly and suggest two or three small refinements at most, with exact values. Apply them only if the user agrees.
4. **Set the direction and stop.** Write the five lines described below. Show the audit and the direction to the user and wait for their answer before editing. Skip the wait only when the user already said to just do it.
5. **Fix in nine passes, in order.** Finish a pass across the whole screen before starting the next. Spacing comes first, copy before type and layout, visuals and motion last.
6. **Check.** Run the checklist at the end, render again and compare with the audit list.
7. **Report** the direction, a few lines per pass about what changed, and any image prompt you wrote.

Keep a run quick. Render the screen to check it at most three times. Exact values for every pass are in Tokens below.

## Direction

Before touching anything, write five short lines, derived from what the product does and who it is for. Never from what is trending.

- **Product.** What it does and for whom, in one plain sentence.
- **Character.** Two or three concrete words, like `calm, exact, a little warm`. Words like clean, modern, sleek, minimal and premium are not allowed.
- **World.** The place or material the product naturally belongs to. A monitoring tool lives near instruments and night shifts. This world sets the tint of the neutrals, the accent and the visual.
- **Moments.** One or two places where the screen gets rich color, material and detail, chosen from what the product shows.
- **Signature.** One small detail only this product would have, used consistently. One detail, not five.

If the product already has a real brand that is not slop, keep it and build the direction around it. A violet to blue gradient, sparkles and glow are slop even in a logo.

## 1. Spacing

- Everything sits on a 4px grid. A 2px step is fine for nudges inside small controls.
- Same thing, same size. All rows in a list share one height and one gap, all cards in a row share one padding.
- Space shows grouping. Space inside a group is smaller than space between groups.
- Things line up. Icons in one column, labels on one line, numbers right-aligned in one column.
- Padding follows density. Compact panels and sidebars around 16, cards 20 to 24, page edges 24 to 32.
- Navigation rows are 32 to 36 tall with 2 to 4 between them. A section label sits 24 above and 8 below.
- Remove one-off values that break the rhythm.

## 2. Color

- Build from one neutral ramp, tinted toward the world. Background, raised surfaces, borders and text all come from it.
- In apps and dashboards surfaces stay neutral (graphite or as grey). The content carries the color.
- Three text roles, primary, secondary and muted.
- In the chrome, one accent, used rarely: the primary action, the selection or the one number that matters.
- The moments are the exception: color can be rich there if each color means something.
- Accent with text on it reaches 4.5 to 1 contrast.
- On dark themes the primary button can be an off white with dark text.
- Semantic colors only carry meaning and are toned down.
- Remove hue gradients on surfaces, gradient text, colored glows and shadows, color washes and blobs, neon borders.
- Borders are hairlines, the text color at 6 to 10% opacity.
- Dark themes get depth from surface steps and hairlines, not shadows. Light themes use neutral, soft, small shadows.
- A gradient is allowed only as a small tone shift inside one neutral.

## 3. Icons

- Every emoji used as an icon becomes a line icon from one set (the project's, otherwise lucide).
- One size and stroke everywhere, 16 or 18px, 1.5 stroke, colored by their text role.
- Same icon box width in every row, fixed 8 or 10 gap to the label.
- Drop icons that add nothing. Categories that need color get a small status dot.

## 4. Copy

- Headlines say what the product does for whom, using facts already on the page.
- No exclamation marks, no greeting headlines; the title names the context.
- Short labels. `Search`, not `Search anything...`.
- A change says what it compares to, like `+12% vs last month`.
- Headlines, labels, buttons and captions end without a period.
- No hype words and no `AI-powered` on everything.
- Unverifiable claims are confirmed with the user or removed.
- Mock data looks real, never `[X]` or `123,456`.
- Badges like `PRO` or `New` go away unless really needed, then quiet text.

## 5. Type

- Choose type for the character, from the families in Tokens. Keep a real brand font. One interface family plus at most one partner (a mono for figures, or a display face for large headlines).
- A few sizes and two weights, 400 and 500, 600 at most. No 700 to 900 headings.
- Hierarchy from size and color, not weight.
- Sentence case everywhere; no uppercase tracked labels.
- No negative letter spacing on small text.
- Numbers use tabular-nums and one format.
- No italic for emphasis.

## 6. Layout

- Keep the sections and their order.
- Apps and dashboards keep real app proportions: full viewport shell, sidebar 240 to 280, fluid content capped around 1440 to 1600. Never shrink an app into a narrow centered column.
- Landing heroes: a full-bleed scene with text on its calm part, or an asymmetric split. Long headlines align left.
- One primary action and at most one secondary.
- Navigation stays quiet.
- Compose the first screen as a whole, no dead empty band.
- On small screens everything stacks in reading order; dense previews simplify, no text below 11px.

## 7. Details

- Nested radius: inner = outer minus padding, never below 4. Controls 8 to 10, cards 12 to 16, panels 14 to 20.
- Counts and meta become quiet text, often mono and muted.
- Keyboard shortcuts become small keycaps.
- Charts sit on a muted grid with muted mono labels. One main chart is clearly the biggest; other data blocks are smaller and different in kind.
- One accent per chart; several hues only when series must be told apart.
- Stat cards are numbers: label, figure, change with comparison. No sparklines or decoration.
- Vary the sizes; equal identical cards read as a template.
- Pick the chart type for the data.
- Active state is a small surface step with a hairline highlight.
- Hover and focus states exist, with a visible focus ring.
- The logo is the product name plus a simple mark, never a gradient.
- The signature detail appears where it belongs and nowhere else.

## 8. Visuals

- Decorative filler goes: blobs, orbs, nebulas, glowing grids, robots.
- Dashboards and app screens almost never need generated images. Their moments come from the product: a carefully drawn chart, figures set beautifully, a status that feels alive.
- Generate images for an app only for empty states, onboarding and marketing, or when asked.
- When there is no image tool, build what you can in code, write prompts for the rest and leave correctly sized empty slots.

## 9. Motion

- Remove looping motion on things that are not live, shimmer, breathing glows, floating, parallax.
- Remove transition-all, bouncy springs and hover scaling on cards.
- Keep motion that explains something; transition color, background, border, opacity and transform only.
- One easing curve and a few durations.
- At most one entrance on load, a short fade and rise.

## Do not

- Do not rename the product. Redraw a slop logo flat.
- Do not change what the product is; keep features, content and section order.
- Do not replace removed decoration with new decoration or a new trend.
- Do not invent features, claims or data.
- Do not fall back to the same look for every product.

## Checklist

- [ ] The direction is written and every pass follows it
- [ ] Every spacing value is on the 4px scale and equal things have equal sizes
- [ ] Icons, labels and numbers each sit in one aligned column
- [ ] One tinted neutral ramp, three text roles, one accent with enough contrast
- [ ] No hue gradients, gradient text, glows, colored shadows or color blobs
- [ ] No emoji left in the interface
- [ ] One icon set at one size and stroke
- [ ] Weights 400 to 600, no uppercase tracked labels, no italic, no negative tracking on small text
- [ ] No exclamation marks, no trailing periods on short strings, no greeting headline, no unverified claims
- [ ] Numbers in one format with tabular figures
- [ ] Nested radii add up
- [ ] Table row states read apart: header, value, selection and keyboard focus
- [ ] Buttons share the control radius
- [ ] The first screen is composed as a whole with no dead empty band
- [ ] No looping or bouncy motion, one easing curve, no animated layout properties
- [ ] Template check: if you swapped the product name, would the screen still fit? If yes, push the direction harder

## Tokens

Starting values; keep a project's good system and let the direction move them.

**Spacing scale:** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128. Inside a control 4 to 12; related items 2 to 8; between groups 12 to 24; between sections 32 to 64 (landing 80 to 128). Rows 32 compact, 36 default, 40 to 44 touch.

**App layout:** sidebar 240 to 280, page padding 24 to 32, content capped 1440 to 1600. Header 56 to 64. Stat cards 3 or 4 per row, one height. Main chart at least two thirds wide, 280 to 360 tall; a neighbour block is a list or table.

**Dark ramps (graphite / warm / ink):** deepest #0f0f10 / #12110f / #07080d; page #141415 / #161513 / #0b0d14; card #19191b / #1c1a18 / #11141c; raised #232325 / #262421 / #1a1e28; hairline = primary text at 8%; primary #ededed / #efe9de / #eef0f5; secondary #a1a1a6 / #aaa398 / #a3a9b8; muted #85858b / #8a847a / #7a8296.

**Light ramps (graphite / warm / ink):** page #fafafa / #f7f4ee / #f5f7fa; card #ffffff / #fdfbf7 / #ffffff; raised #f4f4f5 / #efe9df / #eceff4; primary #171717 / #1f1b16 / #111827; secondary #525252 / #5e554a / #4b5565; muted #737373 / #7b7266 / #6b7487. Muted is for meta only.

**Semantic:** positive #4cc38a dark, #16a34a light; negative #e5484d dark, #dc2626 light.

**Accent:** keep a real brand color; otherwise take it from the world (warm: amber, coral, ember; cool: cobalt, teal, sky; natural: moss, sage). Avoid purple to blue unless the brand is purple. Text on accent at 4.5:1. Covers a few percent of the screen.

**Buttons:** hero 44 to 48 tall, nav 32 to 36, side padding 16 to 20. Secondary = raised surface + hairline. Dark buttons may use `inset 0 1px 0 rgba(255,255,255,0.12)`.

**Type families:** precise/technical/calm: Geist, Inter, IBM Plex Sans + Geist Mono, IBM Plex Mono or JetBrains Mono. Warm/human: Instrument Sans, DM Sans, Figtree + Instrument Serif or Newsreader for hero only. Editorial: Inter or Instrument Sans + Newsreader, Instrument Serif or Fraunces for headlines. Playful: Space Grotesk, Bricolage Grotesque + a mono.

**Type scale (size/line/weight):** meta 12/16/400 (mono welcome); captions 13-14/20/400; body and nav 14-15/20-22/400-500; wordmark 16-18/1/500-600; hero subhead 18-20/28-30/400; card figures 28-32/1/500 tabular; page title 28-36/1.15/400-500; hero headline 56-72 desktop, 36-44 mobile. Letter spacing 0 under 16px; -0.02em from 40px; -0.03em from 56px.

**Radius:** keycap/tag 4 to 6; row/input/button 8 to 10; card 12 to 16; panel 14 to 20.

**Icons:** lucide, 16 or 18px, stroke 1.5, muted or secondary color, 8 to 10 gap.

**Depth:** dark = surface steps + hairline; light = `0 1px 2px rgba(0,0,0,0.05)` small, `0 8px 24px rgba(0,0,0,0.06)` floating.

**Motion:** easing `cubic-bezier(0.22, 1, 0.36, 1)`. Hover/press 120 to 180ms; menus 160 to 220ms; entrances 300 to 500ms; stagger 40 to 60ms, at most six items. Rise 6 to 12px; press scale 0.97 to 0.98.

## Signs of slop

Note each sign with where it lives.

- **Surfaces and color:** hue gradients on backgrounds/cards/buttons/active nav; gradient text; colored glows; radial washes or blobs; neon borders; many near-identical tints for text; everything highlighted; glass cards with colored shadows.
- **Type:** 800-900 headings; uppercase tracked labels; too many sizes/weights; mixed number formats; negative tracking on small text; italic for emphasis.
- **Icons:** emoji as icons or decoration; emoji in pills and counts; icons in many sizes/colors; icons off the column; sparkles for anything AI.
- **Spacing:** arbitrary values; uneven row heights/gaps; groups closer to neighbours than their own items; uneven card padding; unbalanced section gaps.
- **Copy:** greeting headlines; exclamation marks; changes without a reference; wordy placeholders; hype words; trailing periods on labels; fake-looking data.
- **Components:** glowing pills; PRO/New/Beta badges everywhere; everything a pill; rainbow or glowing charts; everything in accent shades; sparklines on every stat card; identical equal cards; gradient-tile logos or glossy orb marks.
- **Landing heroes:** pill badge above the headline; generic headline; gradient headline; floating blobs; everything stacked and centered; three or more buttons; unsourced social proof; parallax; emoji feature cards.
- **Visuals:** glossy 3D blobs, nebulas; robots, brains, holograms; text baked into images; images with hard edges; a visual on every section.
- **Motion:** pulse/ping on non-live things; transition-all and hover scale; bouncy springs; everything flying in; parallax; animating layout properties.
- **Template look (after the passes):** pure grey page + Inter + old brand color on one button; a headline that fits another product; an empty-box hero; every product getting the same look.

---

Part of unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0. Keep this credit in copies and adaptations.