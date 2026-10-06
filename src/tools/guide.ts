import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { text } from "../util/mcp.js";

// Board-authoring guidance served to the agent, modelled on Miro's canvas composer
// skill (design reflection, default style, rulebook, edit protocol) but written for
// AFFiNE's edgeless canvas and this server's tools.

const ROUTER = `# Canvas guide

Pick the step that matches the task, then call get_canvas_guide again with it:
- step="design": CREATING a new board or a new section (art direction, default style, layout and style rules).
- step="edit": CHANGING, moving or deleting what is already on a board.
- step="diagram": a flowchart, process, org chart, mind map or any node-and-arrow diagram (add it on top of "design").

Reuse a step's instructions for the rest of the conversation instead of fetching it again.`;

const DESIGN = `# Designing an AFFiNE board

## Workflow
1. Create the doc as a whiteboard: create_doc with mode="edgeless" (or reuse an existing doc).
2. Build the composition with ONE compose_canvas call per section (nodes, edges, frames together).
3. Call render_canvas and LOOK at the image. Fix overlaps, clipped text, misalignment or crowding with compose_canvas edit mode (see step="edit"). Do not report the board as done before a clean render.
4. Report the board URL (https://<host>/workspace/<workspaceId>/<docId>?mode=edgeless).

## Reflect before composing
Answer briefly for yourself:
- What is the board for, and who reads it? Workspace (people will add content: workshop, retro, brainstorm) or synthesis (the content is the deliverable: summary, process map, decision record)?
- What single visual idea makes the purpose visible (a left-to-right flow, a 2x2 matrix, columns per stage, a hub and spokes)?
- Which style: the user's explicit request first, then any brand the user named, otherwise the default below. Simple is fine: a plain, sober board is a valid choice when the user wants it.

## Default style: Clean Paper (apply only when the user asked for nothing else)
Flat colored paper on a white desk. No shadows, no gradients, no decoration.
- Color comes in two volumes: SOLID (a header shape, a key node) and FAINT (a large zone or lane surface). Never muddy in-between tones.
- One structure = one color family (a set of columns or lanes all in blue, for example). Meaning colors (green = positive, red = negative/risk, yellow = attention) are the only ones that pop against it.
- Max 3 color families per board. Same element type = same style everywhere.
- Titles are big ink text on the paper (kind="text"), not text inside a dark filled box.
- Siblings match: cards in a row, steps in a flow share size, fill and font. Encode a category with one small colored marker, not a different color per card.

### Palette (AFFiNE tokens adapt to light and dark mode; prefer them to hex)
- Shape fills (fillColor): --affine-palette-shape-{yellow, orange, tangerine, red, magenta, purple, navy, blue, teal, green, grey, white, black}
- Lines and borders (strokeColor, edge stroke): --affine-palette-line-{same names}
- Note backgrounds (background): --affine-note-background-{yellow, orange, red, magenta, purple, blue, teal, green, grey, white, black}
- Pair a fill with the line token of the SAME family for its border (blue fill -> blue line). Use grey/white fills with the grey line for neutral elements.
- Leave text color unset unless you need contrast on a dark fill.

### Typography (px)
| Role | Size | Weight |
| --- | --- | --- |
| Board title | 48 | 700 |
| Section title | 32 | 700 |
| Node label | 18-20 | 600 |
| Body / note text | 16 | 400 |
| Small label | 14 | 400 |
Max 3 sizes per section. No underline. Emphasis = weight or size, pick one.

### Spacing scale
Only these values: 10, 20 (between text lines/labels), 40, 60 (inside frames, between nodes of a group), 120, 240 (between sections). Sections flow left to right; chapters stack top to bottom. compose_canvas gapX/gapY default to 80/60.

## Rulebook (defaults, the user's explicit wishes win)
Layout
- Frame structured content (one activity, one section, one process) with compose_canvas frames; leave free ideation space unframed with just a title.
- One frame = one task or topic. Do not nest frames. No frame around the whole board.
- Nothing touches or overlaps unless that is the intent. Nothing floats alone far from its group.
- Align siblings on a common edge; use at most 2 frame sizes and one card size per board.
- Never shrink text to make it fit: enlarge the shape or split the content. compose_canvas sizes shapes from their labels when you omit width/height.
Workspace boards
- Seed, don't fill: 2-4 example items per activity, generated content covers at most a third of a frame. Size frames for what people will add.
- Never invent participant content to make an activity look complete.
Content
- Short text: titles on one line, shape labels 2-4 short lines, notes 4-8 lines. Split rather than cram.
- Use notes (kind="note", markdown) for anything longer than a label: explanations, lists, figures.
- Keep the user's wording when they supplied it. No emojis or decorative symbols unless asked.
- Images: kind="image" with imageUrl or filePath; the real aspect ratio is kept, set only width (or height).
Accessibility and legibility override every style rule.`;

const EDIT = `# Editing an existing board

1. Find before reading: search_canvas with no query gives an overview (frames, headings, counts, bounds). Then search_canvas with query and/or scope to get the ids you need. Avoid get_edgeless_canvas on big boards unless you need everything.
2. Change with compose_canvas EDIT MODE, starting from the ids you just got (or from the last compose_canvas result):
   - Update: { id, ...only the fields that change } in nodes or edges. Omitted fields keep their value.
   - Move: { id, x, y }. Resize: { id, width, height }.
   - Add: items without id (nodes need a key), in the same call.
   - Delete: { id, deleted: true }. Connectors attached to a deleted item are removed too. Deletion is destructive: confirm the exact items with the user first.
   - Omitting an element never deletes it; updates are additive.
   - Shape/text/connector fields can all be patched. Notes, images and frames accept x/y/width/height and background; a frame's text is its title. To rewrite a note's content, delete it and add a new one.
3. Never invent ids: only reuse ids returned by compose_canvas, search_canvas or get_edgeless_canvas.
4. New content added in edit mode is placed below the existing board unless you pass origin or x/y; give an origin next to the area you are extending.
5. render_canvas after the change and fix what looks wrong.`;

const DIAGRAM = `# Diagrams (flowcharts, processes, org charts, mind maps)

- Mind maps: prefer the native mindmap tools (create_mindmap, add_mindmap_node, set_mindmap_style) over hand-made shapes.
- Everything else: compose_canvas with edges. Leave nodes without x/y and use layout="flow" (direction "right" for processes, "down" for hierarchies and org charts).
- Shapes by role:
  - start / end: shapeType "ellipse" (or rect with radius 0.5)
  - step / plain node: "rect" with radius 0.1
  - decision: "diamond" (make it wider than tall, about 200x120, labels short like "Approved?")
  - input / output or data: "rect" with a different fill family
- One size per role; sibling nodes share width.
- Color by group or branch: every node of one branch shares a family (fill + matching line token for the border). Edges of a branch can use that branch's line token.
- Connectors: mode 1 (orthogonal) by default for trees and processes, mode 0 (straight) for short direct links, mode 2 (curved) only when the user wants an organic look. Be consistent within a diagram.
- Label branches on the edge (label "Yes" / "No"), not with extra text boxes.
- One flow direction per diagram. If the layout tangles, reorder nodes in the input (rank order follows input order) or split the diagram into frames.`;

const STEPS: Record<string, string> = { design: DESIGN, edit: EDIT, diagram: DIAGRAM };

export function registerGuideTools(server: McpServer) {
  server.registerTool(
    "get_canvas_guide",
    {
      title: "Get Canvas Guide",
      description: "Board-authoring guidance for AFFiNE edgeless canvases: workflow, default style (palette tokens, typography, spacing), layout rules, edit protocol and diagram conventions. Call it before building or editing a board with compose_canvas; call without step first, then with the step it names.",
      inputSchema: {
        step: z.enum(["design", "edit", "diagram"]).optional().describe("Omit on the first call."),
      },
    },
    (async ({ step }: { step?: string }) => text({ step: step ?? null, guide: step ? STEPS[step] : ROUTER })) as any,
  );
}
